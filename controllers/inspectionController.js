const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { logTracking } = require('../middleware/logging');
const { createNotificationService } = require('../services/notificationService');
const { isV2RepairRequest } = require('../utils/repairRequestSchema');
const { INSPECTION_COMPLETED } = require('../utils/parcelStatus');
const {
    validateInspectionInput,
    buildInspectionDocument,
    buildInspectionView
} = require('../utils/inspection');

// Technician inspection workflow (Phase 6.4 Unit 4).
//
// Security-critical properties:
//  - Only the currently-assigned technician (verified role 'rider' AND the
//    request's own technicianEmail/technicianId) may submit; role, technicianId and lifecycle
//    are all re-validated atomically inside the write transaction, so a
//    reassignment, status change, role removal, or a competing submission
//    between the initial read and the write always loses (matchedCount 0).
//  - Existence-oracle safe: any caller who is neither the owner, an admin, nor
//    the assigned technician (and every request that does not exist) gets an
//    identical REQUEST_NOT_FOUND, so an unrelated technician can never probe
//    whether some other customer's request exists.
//  - The inspection never creates a quote/payment/Stripe state and never
//    overwrites the request's own server-owned pricing snapshot; its estimate
//    is a technician finding only, always in server-owned BDT.
class InspectionController {
    constructor(models, collections) {
        this.RepairRequest = models.RepairRequest;
        this.User = models.User;
        this.collections = collections;
        this.notifications = createNotificationService(models);
    }

    // Resolves the caller's relationship to a (possibly null) parcel. Role is
    // the DB-authoritative role, never a client claim.
    async resolveAccess(parcel, email) {
        const currentUser = await this.User.findByEmail(email);
        const role = currentUser ? currentUser.role : 'user';
        return {
            role,
            isOwner: !!parcel && parcel.senderEmail === email,
            isAdmin: role === 'admin',
            isAssignedByEmail: !!parcel && parcel.technicianEmail === email
        };
    }

    async submitInspection(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }

            const email = req.decoded_email;
            const parcel = await this.RepairRequest.findById(id);
            const access = await this.resolveAccess(parcel, email);
            const canSee = parcel && (access.isOwner || access.isAdmin || access.isAssignedByEmail);

            // Existence-oracle boundary: nonexistent, or a caller with no
            // relationship to the request, both look identical.
            if (!parcel || !canSee) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            // The caller can see the request (owner/admin/ex-technician) but is
            // not its currently-role-valid assigned technician.
            if (!(access.role === 'rider' && access.isAssignedByEmail)) {
                return res.status(403).send({ message: 'only the assigned technician can submit an inspection', code: 'TECHNICIAN_ROLE_REQUIRED' });
            }

            if (!isV2RepairRequest(parcel)) {
                return res.status(400).send({ message: 'inspection is only available for newer (v2) repair requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            }

            if (parcel.inspection && parcel.inspection.status === 'submitted') {
                return res.status(409).send({ message: 'an inspection has already been submitted for this request', code: 'INSPECTION_ALREADY_SUBMITTED' });
            }

            if (parcel.deliveryStatus !== 'parcel_picked_up') {
                return res.status(409).send({ message: 'inspection can only be submitted after the technician has picked up the device', code: 'INSPECTION_NOT_ALLOWED' });
            }

            const validation = validateInspectionInput(req.body);
            if (!validation.valid) {
                return res.status(400).send({ message: validation.message, code: validation.code });
            }

            // The owner's real role at notification time (never hardcoded).
            const ownerRole = (await this.User.findRoleByEmail(parcel.senderEmail)) || 'user';

            const mongoSession = client.startSession();
            let conflictCode = null;
            let inspectionDoc = null;
            try {
                await mongoSession.withTransaction(async () => {
                    // Reset per attempt - withTransaction may retry on a
                    // transient error, and stale state from a prior attempt
                    // must never leak into the response.
                    conflictCode = null;
                    inspectionDoc = null;

                    // Role-removal race: re-read the technician's live role
                    // inside the transaction, not just at the top.
                    const liveRole = await this.User.findRoleByEmail(email, { session: mongoSession });
                    if (liveRole !== 'rider') {
                        conflictCode = 'TECHNICIAN_ROLE_REQUIRED';
                        throw new Error('technician role changed during submission');
                    }

                    const now = new Date();
                    inspectionDoc = buildInspectionDocument(validation.normalized, {
                        submittedByRiderId: parcel.technicianId ? new ObjectId(parcel.technicianId) : null,
                        submittedByEmail: email,
                        now
                    });

                    // The filter itself is the concurrency guarantee: still v2,
                    // still picked-up, still assigned to THIS caller (email and
                    // technicianId), and no inspection yet. Any concurrent
                    // reassignment / status change / first-submission-winner
                    // makes this match zero documents.
                    const updateResult = await this.collections.repairRequests.updateOne(
                        {
                            _id: parcel._id,
                            schemaVersion: 2,
                            deliveryStatus: 'parcel_picked_up',
                            technicianEmail: email,
                            technicianId: parcel.technicianId,
                            $or: [
                                { 'inspection.status': { $exists: false } },
                                { 'inspection.status': { $ne: 'submitted' } }
                            ]
                        },
                        { $set: { inspection: inspectionDoc, deliveryStatus: INSPECTION_COMPLETED, updatedAt: now } },
                        { session: mongoSession }
                    );

                    if (updateResult.matchedCount === 0) {
                        // Derive the most precise, still-safe reason from a
                        // fresh in-transaction read.
                        const fresh = await this.collections.repairRequests.findOne({ _id: parcel._id }, { session: mongoSession });
                        if (!fresh) conflictCode = 'REQUEST_NOT_FOUND';
                        else if (fresh.inspection && fresh.inspection.status === 'submitted') conflictCode = 'INSPECTION_ALREADY_SUBMITTED';
                        else if (fresh.technicianEmail !== email || fresh.technicianId !== parcel.technicianId) conflictCode = 'REQUEST_NOT_ASSIGNED_TO_TECHNICIAN';
                        else conflictCode = 'INSPECTION_NOT_ALLOWED';
                        throw new Error('inspection submission guard failed');
                    }

                    // Exactly one tracking event, transactionally coupled -
                    // rolled back with everything else on any failure, and its
                    // free-text detail is only the status words, never
                    // diagnosis/notes/estimate data.
                    await logTracking(this.collections.trackingEvents, parcel.trackingId, INSPECTION_COMPLETED, mongoSession);

                    // Customer notification, transactionally coupled and
                    // deduplicated by the unique deduplicationKey index. Its
                    // copy carries no internal notes, technician identity, or
                    // estimate amounts (see utils/notificationEvents.js).
                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: parcel.senderEmail,
                        recipientRole: ownerRole,
                        type: 'inspection_completed',
                        entityType: 'parcel',
                        entityId: parcel._id.toString(),
                        metadata: { trackingId: parcel.trackingId },
                        // Deliberately null - the inspection notification must
                        // carry no technician identity at all (Phase N), and
                        // this event's copy/dedup/actionUrl never use an actor.
                        actorEmail: null
                    });
                });
            } catch (txError) {
                // A guard-derived conflict is an expected, controlled outcome;
                // anything else is a genuine error and must surface as 500.
                if (!conflictCode) throw txError;
            } finally {
                await mongoSession.endSession();
            }

            if (conflictCode) {
                const statusByCode = {
                    REQUEST_NOT_FOUND: 404,
                    TECHNICIAN_ROLE_REQUIRED: 403,
                    INSPECTION_ALREADY_SUBMITTED: 409,
                    REQUEST_NOT_ASSIGNED_TO_TECHNICIAN: 409,
                    INSPECTION_NOT_ALLOWED: 409
                };
                const messageByCode = {
                    REQUEST_NOT_FOUND: 'repair request not found',
                    TECHNICIAN_ROLE_REQUIRED: 'only the assigned technician can submit an inspection',
                    INSPECTION_ALREADY_SUBMITTED: 'an inspection has already been submitted for this request',
                    REQUEST_NOT_ASSIGNED_TO_TECHNICIAN: 'this request is no longer assigned to you',
                    INSPECTION_NOT_ALLOWED: 'inspection can only be submitted after the technician has picked up the device'
                };
                return res.status(statusByCode[conflictCode] || 409).send({ message: messageByCode[conflictCode], code: conflictCode });
            }

            // Success - the assigned technician gets their own full view back,
            // including the internal notes they just wrote.
            return res.status(201).send({
                message: 'inspection submitted',
                deliveryStatus: INSPECTION_COMPLETED,
                inspection: buildInspectionView(inspectionDoc, { includeInternalNotes: true })
            });
        } catch (error) {
            return res.status(500).send({ message: 'Error submitting inspection', code: 'INTERNAL_ERROR' });
        }
    }

    async getInspection(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }

            const email = req.decoded_email;
            const parcel = await this.RepairRequest.findById(id);
            const access = await this.resolveAccess(parcel, email);
            const canRead = parcel && (access.isOwner || access.isAdmin || access.isAssignedByEmail);

            // Existence-oracle boundary, identical to submit.
            if (!parcel || !canRead) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            if (!isV2RepairRequest(parcel)) {
                return res.status(400).send({ message: 'inspection is only available for newer (v2) repair requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            }

            // internalNotes are visible only to admins and the assigned
            // technician - never to the customer/owner.
            const includeInternalNotes = access.isAdmin || (access.role === 'rider' && access.isAssignedByEmail);
            const view = buildInspectionView(parcel.inspection, { includeInternalNotes });
            return res.send({ inspection: view });
        } catch (error) {
            return res.status(500).send({ message: 'Error fetching inspection', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = InspectionController;
