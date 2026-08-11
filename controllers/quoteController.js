const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { logTracking } = require('../middleware/logging');
const { createNotificationService } = require('../services/notificationService');
const { isV2RepairRequest } = require('../utils/repairRequestSchema');
const { INSPECTION_COMPLETED, QUOTE_SUBMITTED, QUOTE_APPROVED, QUOTE_REJECTED } = require('../utils/parcelStatus');
const {
    validateQuoteSubmission, buildQuoteDocument, validateQuoteDecision, buildQuoteView,
} = require('../utils/quote');

// Repair-quote workflow (Phase 6.4 Unit 5): technician submits a quote after
// inspection; the request owner approves or rejects it. Same security spine as
// the inspection workflow - DB-authoritative identity, assignment/lifecycle/
// role revalidated atomically inside the write transaction, existence-oracle-
// safe responses, and no Stripe/payment state ever created (payment remains
// blocked even at quote_approved). Line-item amounts come from the technician;
// the total is always computed server-side and currency is server-owned BDT.
class QuoteController {
    constructor(models, collections) {
        this.Parcel = models.Parcel;
        this.User = models.User;
        this.collections = collections;
        this.notifications = createNotificationService(models);
    }

    async resolveAccess(parcel, email) {
        const currentUser = await this.User.findByEmail(email);
        const role = currentUser ? currentUser.role : 'user';
        return {
            role,
            isOwner: !!parcel && parcel.senderEmail === email,
            isAdmin: role === 'admin',
            isAssignedByEmail: !!parcel && parcel.riderEmail === email,
        };
    }

    async submitQuote(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }
            const email = req.decoded_email;
            const parcel = await this.Parcel.findById(id);
            const access = await this.resolveAccess(parcel, email);
            const canSee = parcel && (access.isOwner || access.isAdmin || access.isAssignedByEmail);

            if (!parcel || !canSee) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }
            if (!(access.role === 'rider' && access.isAssignedByEmail)) {
                return res.status(403).send({ message: 'only the assigned technician can submit a quote', code: 'TECHNICIAN_ROLE_REQUIRED' });
            }
            if (!isV2RepairRequest(parcel)) {
                return res.status(400).send({ message: 'quotes are only available for newer (v2) repair requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            }
            if (parcel.quote && parcel.quote.status) {
                return res.status(409).send({ message: 'a quote has already been submitted for this request', code: 'QUOTE_ALREADY_SUBMITTED' });
            }
            if (parcel.deliveryStatus !== INSPECTION_COMPLETED) {
                return res.status(409).send({ message: 'a quote can only be submitted after the inspection is completed', code: 'QUOTE_NOT_ALLOWED' });
            }

            const validation = validateQuoteSubmission(req.body);
            if (!validation.valid) {
                return res.status(400).send({ message: validation.message, code: validation.code });
            }

            const ownerRole = (await this.User.findRoleByEmail(parcel.senderEmail)) || 'user';

            const mongoSession = client.startSession();
            let conflictCode = null;
            let quoteDoc = null;
            try {
                await mongoSession.withTransaction(async () => {
                    conflictCode = null;
                    quoteDoc = null;

                    const liveRole = await this.User.findRoleByEmail(email, { session: mongoSession });
                    if (liveRole !== 'rider') {
                        conflictCode = 'TECHNICIAN_ROLE_REQUIRED';
                        throw new Error('technician role changed during quote submission');
                    }

                    const now = new Date();
                    quoteDoc = buildQuoteDocument(validation.normalized, {
                        submittedByRiderId: parcel.riderId ? new ObjectId(parcel.riderId) : null,
                        now,
                    });

                    const updateResult = await this.collections.repairRequests.updateOne(
                        {
                            _id: parcel._id,
                            schemaVersion: 2,
                            deliveryStatus: INSPECTION_COMPLETED,
                            riderEmail: email,
                            riderId: parcel.riderId,
                            'quote.status': { $exists: false },
                        },
                        { $set: { quote: quoteDoc, deliveryStatus: QUOTE_SUBMITTED, updatedAt: now } },
                        { session: mongoSession }
                    );

                    if (updateResult.matchedCount === 0) {
                        const fresh = await this.collections.repairRequests.findOne({ _id: parcel._id }, { session: mongoSession });
                        if (!fresh) conflictCode = 'REQUEST_NOT_FOUND';
                        else if (fresh.quote && fresh.quote.status) conflictCode = 'QUOTE_ALREADY_SUBMITTED';
                        else if (fresh.riderEmail !== email || fresh.riderId !== parcel.riderId) conflictCode = 'REQUEST_NOT_ASSIGNED_TO_TECHNICIAN';
                        else conflictCode = 'QUOTE_NOT_ALLOWED';
                        throw new Error('quote submission guard failed');
                    }

                    await logTracking(this.collections.trackingEvents, parcel.trackingId, QUOTE_SUBMITTED, mongoSession);
                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: parcel.senderEmail,
                        recipientRole: ownerRole,
                        type: 'quote_submitted',
                        entityType: 'parcel',
                        entityId: parcel._id.toString(),
                        metadata: { trackingId: parcel.trackingId },
                        actorEmail: null,
                    });
                });
            } catch (txError) {
                if (!conflictCode) throw txError;
            } finally {
                await mongoSession.endSession();
            }

            if (conflictCode) {
                return res.status(this.statusForCode(conflictCode)).send({ message: this.messageForCode(conflictCode), code: conflictCode });
            }
            return res.status(201).send({ message: 'quote submitted', deliveryStatus: QUOTE_SUBMITTED, quote: buildQuoteView(quoteDoc) });
        } catch (error) {
            return res.status(500).send({ message: 'Error submitting quote', code: 'INTERNAL_ERROR' });
        }
    }

    async decideQuote(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }
            const email = req.decoded_email;
            const parcel = await this.Parcel.findById(id);
            const access = await this.resolveAccess(parcel, email);
            const canSee = parcel && (access.isOwner || access.isAdmin || access.isAssignedByEmail);

            if (!parcel || !canSee) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }
            // Only the request owner (customer) decides - never an admin
            // impersonating the customer, never the assigned technician.
            if (!access.isOwner) {
                return res.status(403).send({ message: 'only the request owner can decide on a quote', code: 'NOT_REQUEST_OWNER' });
            }
            if (!isV2RepairRequest(parcel)) {
                return res.status(400).send({ message: 'quotes are only available for newer (v2) repair requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            }

            const validation = validateQuoteDecision(req.body);
            if (!validation.valid) {
                return res.status(400).send({ message: validation.message, code: validation.code });
            }

            if (!parcel.quote || parcel.quote.status !== 'submitted' || parcel.deliveryStatus !== QUOTE_SUBMITTED) {
                // An already-approved/rejected quote gets its own precise code;
                // anything else (no quote yet, wrong stage) is not-decidable.
                const alreadyDecided = parcel.quote && (parcel.quote.status === 'approved' || parcel.quote.status === 'rejected');
                const code = alreadyDecided ? 'QUOTE_ALREADY_DECIDED' : 'QUOTE_NOT_DECIDABLE';
                return res.status(409).send({ message: this.messageForCode(code), code });
            }

            const approve = validation.normalized.decision === 'approve';
            const newQuoteStatus = approve ? 'approved' : 'rejected';
            const newDeliveryStatus = approve ? QUOTE_APPROVED : QUOTE_REJECTED;
            const notifyType = approve ? 'quote_approved' : 'quote_rejected';

            const mongoSession = client.startSession();
            let conflictCode = null;
            let decidedAt = null;
            try {
                await mongoSession.withTransaction(async () => {
                    conflictCode = null;
                    const now = new Date();
                    decidedAt = now;

                    const updateResult = await this.collections.repairRequests.updateOne(
                        {
                            _id: parcel._id,
                            schemaVersion: 2,
                            senderEmail: email,
                            deliveryStatus: QUOTE_SUBMITTED,
                            'quote.status': 'submitted',
                        },
                        {
                            $set: {
                                'quote.status': newQuoteStatus,
                                'quote.decidedAt': now,
                                'quote.decisionReason': validation.normalized.reason,
                                deliveryStatus: newDeliveryStatus,
                                updatedAt: now,
                            },
                        },
                        { session: mongoSession }
                    );

                    if (updateResult.matchedCount === 0) {
                        const fresh = await this.collections.repairRequests.findOne({ _id: parcel._id }, { session: mongoSession });
                        if (!fresh) conflictCode = 'REQUEST_NOT_FOUND';
                        else if (fresh.quote && (fresh.quote.status === 'approved' || fresh.quote.status === 'rejected')) conflictCode = 'QUOTE_ALREADY_DECIDED';
                        else conflictCode = 'QUOTE_NOT_DECIDABLE';
                        throw new Error('quote decision guard failed');
                    }

                    await logTracking(this.collections.trackingEvents, parcel.trackingId, newDeliveryStatus, mongoSession);
                    // Notify the assigned technician of the customer's decision.
                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: parcel.riderEmail,
                        recipientRole: 'rider',
                        type: notifyType,
                        entityType: 'parcel',
                        entityId: parcel._id.toString(),
                        metadata: { trackingId: parcel.trackingId },
                        actorEmail: null,
                    });
                });
            } catch (txError) {
                if (!conflictCode) throw txError;
            } finally {
                await mongoSession.endSession();
            }

            if (conflictCode) {
                return res.status(this.statusForCode(conflictCode)).send({ message: this.messageForCode(conflictCode), code: conflictCode });
            }

            const decidedQuote = buildQuoteView({
                ...parcel.quote,
                status: newQuoteStatus,
                decidedAt,
                decisionReason: validation.normalized.reason,
            });
            return res.status(200).send({ message: `quote ${newQuoteStatus}`, deliveryStatus: newDeliveryStatus, quote: decidedQuote });
        } catch (error) {
            return res.status(500).send({ message: 'Error deciding quote', code: 'INTERNAL_ERROR' });
        }
    }

    async getQuote(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }
            const email = req.decoded_email;
            const parcel = await this.Parcel.findById(id);
            const access = await this.resolveAccess(parcel, email);
            const canRead = parcel && (access.isOwner || access.isAdmin || access.isAssignedByEmail);

            if (!parcel || !canRead) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }
            if (!isV2RepairRequest(parcel)) {
                return res.status(400).send({ message: 'quotes are only available for newer (v2) repair requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            }
            return res.send({ quote: buildQuoteView(parcel.quote) });
        } catch (error) {
            return res.status(500).send({ message: 'Error fetching quote', code: 'INTERNAL_ERROR' });
        }
    }

    statusForCode(code) {
        return {
            REQUEST_NOT_FOUND: 404,
            TECHNICIAN_ROLE_REQUIRED: 403,
            NOT_REQUEST_OWNER: 403,
            QUOTE_ALREADY_SUBMITTED: 409,
            QUOTE_NOT_ALLOWED: 409,
            QUOTE_ALREADY_DECIDED: 409,
            QUOTE_NOT_DECIDABLE: 409,
            REQUEST_NOT_ASSIGNED_TO_TECHNICIAN: 409,
        }[code] || 409;
    }

    messageForCode(code) {
        return {
            REQUEST_NOT_FOUND: 'repair request not found',
            TECHNICIAN_ROLE_REQUIRED: 'only the assigned technician can submit a quote',
            NOT_REQUEST_OWNER: 'only the request owner can decide on a quote',
            QUOTE_ALREADY_SUBMITTED: 'a quote has already been submitted for this request',
            QUOTE_NOT_ALLOWED: 'a quote can only be submitted after the inspection is completed',
            QUOTE_ALREADY_DECIDED: 'this quote has already been decided',
            QUOTE_NOT_DECIDABLE: 'this quote is not awaiting a decision',
            REQUEST_NOT_ASSIGNED_TO_TECHNICIAN: 'this request is no longer assigned to you',
        }[code] || 'quote request could not be completed';
    }
}

module.exports = QuoteController;
