const { ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { client } = require('../config/database');
const { generateSecureTrackingId } = require('../utils/trackingId');
const { logTracking } = require('../middleware/logging');
const { VALID_STATUSES, isValidTransition } = require('../utils/parcelStatus');
const { normalize } = require('../services/paymentProcessor');
const { createNotificationService } = require('../services/notificationService');
const { createCheckoutSessionManager } = require('../services/checkoutSessionManager');
const { getCancellationEligibility } = require('../services/cancellationPolicy');
const { canAssignRequest } = require('../services/assignmentEligibility');
const { escapeRegex, sanitizeSearchText } = require('../utils/searchSanitize');

const ADMIN_LIST_DEFAULT_LIMIT = 10;
const ADMIN_LIST_MAX_LIMIT = 50;
const ADMIN_LIST_MAX_SEARCH_LENGTH = 100;
// Every status the admin request-management filter accepts - deliberately
// the same set utils/parcelStatus.js's VALID_STATUSES plus the two values
// that can never appear in that list (the implicit initial 'pending-pickup'
// and the terminal 'cancelled', neither of which is a client-settable
// transition target for updateParcelStatus, but both of which are real,
// filterable request states).
const ADMIN_LIST_VALID_STATUSES = ['pending-pickup', 'driver_assigned', 'rider_arriving', 'parcel_picked_up', 'parcel_delivered', 'cancelled'];

class ParcelController {
    constructor(models, collections) {
        this.Parcel = models.Parcel;
        this.Rider = models.Rider;
        this.User = models.User;
        this.collections = collections;
        // Guards against duplicate concurrent Stripe Checkout Sessions and
        // is reused here to release/expire an active session on cancellation
        // - see services/checkoutSessionManager.js.
        this.checkoutSessions = createCheckoutSessionManager(collections);
        this.notifications = createNotificationService(models);
    }

    async getAllParcels(req, res) {
        try {
            const query = {};
            const { email, deliveryStatus } = req.query;
            const currentUser = await this.User.findByEmail(req.decoded_email);

            // Non-admin users can only see their own repair requests
            if (!currentUser || currentUser.role !== 'admin') {
                query.senderEmail = req.decoded_email;
            } else if (email) {
                // Admins can filter by email
                query.senderEmail = email;
            }

            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus;
            }

            const result = await this.Parcel.findAll(query);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair requests', error: error.message });
        }
    }

    async getRiderParcels(req, res) {
        try {
            const { deliveryStatus } = req.query;
            const query = { riderEmail: req.decoded_email };

            if (deliveryStatus !== 'parcel_delivered') {
                query.deliveryStatus = { $nin: ['parcel_delivered'] };
            } else {
                query.deliveryStatus = deliveryStatus;
            }

            const result = await this.Parcel.findAll(query);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching technician repair requests', error: error.message });
        }
    }

    async getParcelById(req, res) {
        try {
            const id = req.params.id;
            const parcel = await this.Parcel.findById(id);
            
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found' });
            }
            
            const currentUser = await this.User.findByEmail(req.decoded_email);
            const isOwner = parcel.senderEmail === req.decoded_email;
            const isAssignedRider = parcel.riderEmail === req.decoded_email;
            const isAdmin = currentUser && currentUser.role === 'admin';
            
            if (!isOwner && !isAssignedRider && !isAdmin) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            
            res.send(parcel);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair request', error: error.message });
        }
    }

    async getDeliveryStatusStats(req, res) {
        try {
            const result = await this.Parcel.getDeliveryStatusStats();
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair status stats', error: error.message });
        }
    }

    // Admin-only complete request-management view: paginated, searchable,
    // filterable, and explicitly projected (see Parcel.findPaginated) so it
    // never depends on the generic GET /parcels contract that MyRequests and
    // AssignTechnicians already rely on. Every query parameter is validated
    // against a fixed allow-list before being used to build the MongoDB
    // filter - nothing from the client is ever passed through as a raw
    // Mongo operator or field selector.
    async getAdminParcels(req, res) {
        try {
            let { page, limit, search, status, paymentStatus, sort } = req.query;

            page = parseInt(page, 10);
            if (!Number.isInteger(page) || page < 1) {
                page = 1;
            }

            limit = parseInt(limit, 10);
            if (!Number.isInteger(limit) || limit < 1) {
                limit = ADMIN_LIST_DEFAULT_LIMIT;
            }
            if (limit > ADMIN_LIST_MAX_LIMIT) {
                limit = ADMIN_LIST_MAX_LIMIT;
            }

            const query = {};

            if (status && status !== 'all' && ADMIN_LIST_VALID_STATUSES.includes(status)) {
                query.deliveryStatus = status;
            }

            if (paymentStatus === 'paid') {
                query.paymentStatus = 'paid';
            } else if (paymentStatus === 'unpaid') {
                query.paymentStatus = { $ne: 'paid' };
            }

            const searchText = sanitizeSearchText(search, ADMIN_LIST_MAX_SEARCH_LENGTH);
            if (searchText) {
                const pattern = { $regex: escapeRegex(searchText), $options: 'i' };
                query.$or = [
                    { trackingId: pattern },
                    { senderEmail: pattern },
                    { senderName: pattern },
                    { parcelName: pattern }
                ];
            }

            const sortDirection = sort === 'oldest' ? 1 : -1;

            const { data, totalItems } = await this.Parcel.findPaginated(query, {
                page,
                limit,
                sort: { createdAt: sortDirection }
            });

            const enrichedData = data.map(parcel => ({
                ...parcel,
                canAssign: canAssignRequest(parcel)
            }));

            const totalPages = Math.max(Math.ceil(totalItems / limit), 1);

            res.send({
                data: enrichedData,
                pagination: {
                    page,
                    limit,
                    totalItems,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1
                }
            });
        } catch (error) {
            res.status(500).send({ message: 'Error fetching admin repair requests', error: error.message });
        }
    }

    async createParcel(req, res) {
        try {
            const parcel = req.body;
            parcel.createdAt = new Date();
            parcel.senderEmail = req.decoded_email;
            parcel.deliveryStatus = 'pending-pickup';

            // Collision retry: astronomically unlikely at 128 bits of
            // randomness, but the unique index on trackingId
            // (config/database.js) is the real guard - a duplicate-key
            // error here just means try again with a fresh code, the same
            // pattern already used for payments/checkoutSessions elsewhere
            // in this codebase.
            const MAX_TRACKING_ID_ATTEMPTS = 5;
            let result;
            for (let attempt = 1; attempt <= MAX_TRACKING_ID_ATTEMPTS; attempt++) {
                parcel.trackingId = generateSecureTrackingId();
                try {
                    result = await this.Parcel.create(parcel);
                    break;
                } catch (error) {
                    if (error.code === 11000 && attempt < MAX_TRACKING_ID_ATTEMPTS) continue;
                    throw error;
                }
            }

            logTracking(this.collections.trackings, parcel.trackingId, 'parcel_created');

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error creating repair request', error: error.message });
        }
    }

    // Non-completion status transitions (rider_arriving, parcel_picked_up)
    // only ever touch the repair request itself, so a single guarded update
    // is enough. The final parcel_delivered transition is different - it
    // must also atomically reset the assigned technician and write exactly
    // one completion tracking log, so it is handled separately by
    // completeParcel below, which is the actual deliverable of this unit.
    async updateParcelStatus(req, res) {
        try {
            const id = req.params.id;
            const requestedStatus = req.body.deliveryStatus;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }
            if (!VALID_STATUSES.includes(requestedStatus)) {
                return res.status(400).send({ message: 'invalid repair status', code: 'INVALID_REPAIR_STATUS' });
            }

            const parcel = await this.Parcel.findById(id);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            const currentUser = await this.User.findByEmail(req.decoded_email);
            const isRider = currentUser && currentUser.role === 'rider';
            const isAdmin = currentUser && currentUser.role === 'admin';
            const isAssignedRider = parcel.riderEmail === req.decoded_email;

            // Only the assigned technician or admins can update the repair request status
            if (!isAdmin && !(isRider && isAssignedRider)) {
                return res.status(403).send({ message: 'forbidden access', code: isRider ? 'NOT_ASSIGNED_TECHNICIAN' : 'FORBIDDEN' });
            }

            // The completion transition has its own transactional path - see
            // completeParcel. Everything below only ever applies to the
            // earlier, technician-only steps of the lifecycle.
            if (requestedStatus === 'parcel_delivered') {
                return this.completeParcel(res, parcel);
            }

            if (requestedStatus === parcel.deliveryStatus) {
                // Idempotent re-submission of the current status: nothing to
                // persist, and no tracking log should be duplicated for it.
                return res.send({ message: 'status unchanged', matchedCount: 1, modifiedCount: 0 });
            }

            if (!isValidTransition(parcel.deliveryStatus, requestedStatus)) {
                return res.status(409).send({ message: 'invalid status transition', code: 'STATUS_TRANSITION_NOT_ALLOWED' });
            }

            // Guarded atomically against a concurrent status change landing
            // between the read above and this write - the query condition
            // itself is the race-resolver, not the read-then-write check.
            const result = await this.collections.parcels.updateOne(
                { _id: parcel._id, deliveryStatus: parcel.deliveryStatus },
                { $set: { deliveryStatus: requestedStatus } }
            );

            if (result.matchedCount === 0) {
                return res.status(409).send({ message: 'this request was updated concurrently', code: 'STATUS_TRANSITION_NOT_ALLOWED' });
            }

            // The tracking log always uses the repair request's own
            // trackingId, never a client-supplied value - trusting the body
            // here would let a caller write a tracking event under an
            // arbitrary/unrelated trackingId.
            logTracking(this.collections.trackings, parcel.trackingId, requestedStatus);

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error updating repair status', error: error.message });
        }
    }

    // Final repair-completion transition. Atomically commits three things
    // together: the repair request's deliveryStatus -> parcel_delivered, the
    // assigned technician's workStatus -> available, and exactly one
    // completion tracking log entry. Previously these were three independent
    // writes (the last two using a client-supplied riderId/trackingId and
    // not even awaited); if the technician reset or tracking insert failed
    // after the request had already committed as delivered, the request was
    // left "completed" while the technician stayed in_delivery, with no way
    // for a retry to repair it. The assigned technician is always the one
    // recorded on the repair request itself (parcel.riderId) - a
    // client-supplied riderId is never trusted to select who gets reset.
    async completeParcel(res, parcel) {
        try {
            if (!parcel.riderId || !ObjectId.isValid(parcel.riderId)) {
                return res.status(409).send({ message: 'this request has no valid assigned technician', code: 'REQUEST_NOT_ASSIGNED' });
            }

            const mongoSession = client.startSession();
            // Set exactly once inside the transaction, mirroring the
            // assignment/approval transactions elsewhere in this file -
            // either a genuine conflict/not-found (no throw, nothing was
            // written) or a success/idempotent-success marker. A thrown
            // error is reserved for a write actually failing after another
            // write in the same transaction already succeeded, so the whole
            // thing rolls back.
            let outcome = null;
            try {
                await mongoSession.withTransaction(async () => {
                    const freshParcel = await this.collections.parcels.findOne(
                        { _id: parcel._id },
                        { session: mongoSession }
                    );
                    if (!freshParcel) {
                        outcome = { httpStatus: 404, code: 'REQUEST_NOT_FOUND', message: 'repair request not found' };
                        return;
                    }

                    const currentStatus = freshParcel.deliveryStatus;
                    const riderId = freshParcel.riderId;

                    if (!riderId || !ObjectId.isValid(riderId)) {
                        outcome = { httpStatus: 409, code: 'REQUEST_NOT_ASSIGNED', message: 'this request has no valid assigned technician' };
                        return;
                    }

                    if (currentStatus === 'parcel_delivered') {
                        // Same-status request - only a genuine no-op when the
                        // assigned technician is already available too.
                        // Otherwise this is a pre-existing inconsistency
                        // between the request and the technician, which must
                        // never be silently reported as success.
                        const technician = await this.collections.riders.findOne(
                            { _id: new ObjectId(riderId) },
                            { session: mongoSession }
                        );
                        if (technician && technician.workStatus === 'available') {
                            outcome = { idempotent: true };
                            return;
                        }
                        outcome = {
                            httpStatus: 409, code: 'COMPLETION_CONFLICT',
                            message: 'this request is already completed but the technician state is inconsistent'
                        };
                        return;
                    }

                    if (currentStatus !== 'parcel_picked_up') {
                        outcome = {
                            httpStatus: 409, code: 'STATUS_TRANSITION_NOT_ALLOWED',
                            message: currentStatus === 'cancelled' ? 'this request has been cancelled' : 'repair request is not ready to be completed'
                        };
                        return;
                    }

                    const technician = await this.collections.riders.findOne(
                        { _id: new ObjectId(riderId) },
                        { session: mongoSession }
                    );
                    if (!technician) {
                        outcome = { httpStatus: 404, code: 'TECHNICIAN_NOT_FOUND', message: 'assigned technician not found' };
                        return;
                    }

                    // Guarded atomically against a concurrent completion
                    // attempt on the same request - re-verifies the status is
                    // still what was just read, not just a read-then-write
                    // check.
                    const parcelUpdateResult = await this.collections.parcels.updateOne(
                        { _id: freshParcel._id, deliveryStatus: 'parcel_picked_up' },
                        { $set: { deliveryStatus: 'parcel_delivered' } },
                        { session: mongoSession }
                    );
                    if (parcelUpdateResult.matchedCount === 0) {
                        outcome = { httpStatus: 409, code: 'COMPLETION_CONFLICT', message: 'this request was updated concurrently' };
                        return;
                    }

                    const riderUpdateResult = await this.collections.riders.updateOne(
                        { _id: technician._id },
                        { $set: { workStatus: 'available' } },
                        { session: mongoSession }
                    );
                    if (riderUpdateResult.matchedCount === 0) {
                        // The technician document vanished between the read
                        // above and this write - abort the whole transaction
                        // (including the parcel update above) rather than
                        // leave the request completed with no matching
                        // technician reset.
                        throw Object.assign(new Error('technician reset failed during completion'), { code: 'COMPLETION_FAILED' });
                    }

                    const trackingResult = await this.collections.trackings.insertOne(
                        {
                            trackingId: freshParcel.trackingId,
                            status: 'parcel_delivered',
                            details: 'parcel delivered',
                            createdAt: new Date()
                        },
                        { session: mongoSession }
                    );
                    if (!trackingResult.insertedId) {
                        throw Object.assign(new Error('completion tracking log failed'), { code: 'COMPLETION_FAILED' });
                    }

                    outcome = { success: true };
                });
            } finally {
                await mongoSession.endSession();
            }

            if (outcome.idempotent) {
                return res.send({ message: 'repair already completed', deliveryStatus: 'parcel_delivered', alreadyCompleted: true });
            }
            if (outcome.success) {
                return res.send({ message: 'repair completed', deliveryStatus: 'parcel_delivered', matchedCount: 1, modifiedCount: 1, alreadyCompleted: false });
            }
            return res.status(outcome.httpStatus).send({ message: outcome.message, code: outcome.code });
        } catch (error) {
            console.error('Completion transaction aborted:', error.message);
            res.status(500).send({ message: 'Error completing repair request', code: 'COMPLETION_FAILED' });
        }
    }

    // Admin-only technician assignment. Request update, technician
    // workStatus update, and the assignment tracking log are one
    // transactionally consistent operation - all three commit together or
    // none do. Previously these were three independent writes; if
    // Rider.updateWorkStatus or the tracking insert failed after the parcel
    // update had already committed, the request ended up assigned with no
    // matching technician/tracking state and the caller saw a misleading
    // 500. Cheap validation (ObjectId shape, existence, approval) happens
    // before the transaction opens, purely to produce fast 400/404s - the
    // actual concurrency guarantee comes from the guarded updates inside the
    // transaction, never from these preliminary reads alone.
    async assignRiderToParcel(req, res) {
        try {
            const parcelId = req.params.id;
            const { riderId } = req.body;

            if (!ObjectId.isValid(parcelId)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }
            if (!riderId || !ObjectId.isValid(riderId)) {
                return res.status(400).send({ message: 'invalid technician id', code: 'INVALID_TECHNICIAN_ID' });
            }

            const parcel = await this.Parcel.findById(parcelId);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            const technician = await this.Rider.findById(riderId);
            if (!technician) {
                return res.status(404).send({ message: 'technician not found', code: 'TECHNICIAN_NOT_FOUND' });
            }
            if (technician.status !== 'approved') {
                return res.status(409).send({ message: 'technician is not approved', code: 'TECHNICIAN_NOT_APPROVED' });
            }

            const mongoSession = client.startSession();
            let conflict = false;
            try {
                await mongoSession.withTransaction(async () => {
                    // The repair request's owner is resolved from the real
                    // users collection state inside this same transaction -
                    // never trusted from the parcel document itself or any
                    // request body value, and never defaulted. Resolved
                    // before any guarded write below, so a missing/invalid
                    // owner account aborts before anything is committed: no
                    // assignment, no technician workload change, no tracking
                    // write, no notification.
                    const resolvedOwnerRole = await this.User.findRoleByEmail(parcel.senderEmail, { session: mongoSession });
                    if (!resolvedOwnerRole) {
                        throw Object.assign(
                            new Error('repair request owner role could not be resolved'),
                            { code: 'REPAIR_OWNER_ROLE_UNRESOLVED' }
                        );
                    }

                    // Guarded atomically against a concurrent customer
                    // cancellation or a competing assignment - the query
                    // condition itself is the race-resolver, not a
                    // read-then-write check. Technician identity is always
                    // the server-validated document above, never trusted
                    // client-supplied name/email fields.
                    const parcelUpdateResult = await this.collections.parcels.updateOne(
                        {
                            _id: parcel._id,
                            $or: [
                                { deliveryStatus: { $exists: false } },
                                { deliveryStatus: 'pending-pickup' }
                            ]
                        },
                        {
                            $set: {
                                deliveryStatus: 'driver_assigned',
                                riderId: technician._id.toString(),
                                riderName: technician.name,
                                riderEmail: technician.email
                            }
                        },
                        { session: mongoSession }
                    );

                    if (parcelUpdateResult.matchedCount === 0) {
                        conflict = true;
                        return;
                    }

                    // Re-guards the technician's approval status atomically
                    // at write time, not just at the preliminary read above.
                    const riderUpdateResult = await this.collections.riders.updateOne(
                        { _id: technician._id, status: 'approved' },
                        { $set: { workStatus: 'in_delivery' } },
                        { session: mongoSession }
                    );

                    if (riderUpdateResult.matchedCount === 0) {
                        // The technician stopped being approved between the
                        // preliminary check and this write - abort the whole
                        // transaction (including the parcel update above)
                        // rather than leave a request assigned to a
                        // technician whose own state update never happened.
                        throw Object.assign(new Error('technician update failed during assignment'), { code: 'TECHNICIAN_UPDATE_FAILED' });
                    }

                    await logTracking(this.collections.trackings, parcel.trackingId, 'driver_assigned', mongoSession);

                    // Both notifications join the same transaction - a
                    // failure creating either one aborts the parcel
                    // assignment, the technician workload update, and the
                    // tracking log above exactly like any other guarded
                    // write here. recipientRole for the customer copy is
                    // whatever the owner's real role actually is (user,
                    // rider, or admin), never hardcoded.
                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: parcel.senderEmail,
                        recipientRole: resolvedOwnerRole,
                        type: 'technician_assigned',
                        entityType: 'parcel',
                        entityId: parcelId,
                        actorEmail: req.decoded_email,
                        actorRole: 'admin',
                        metadata: { trackingId: parcel.trackingId }
                    });

                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: technician.email,
                        recipientRole: 'rider',
                        type: 'new_repair_assignment',
                        entityType: 'parcel',
                        entityId: parcelId,
                        actorEmail: req.decoded_email,
                        actorRole: 'admin',
                        metadata: { trackingId: parcel.trackingId }
                    });
                });
            } finally {
                await mongoSession.endSession();
            }

            if (conflict) {
                // Determine the transaction-bound current reason for an
                // accurate, controlled response.
                const latest = await this.Parcel.findById(parcelId);
                if (!latest) {
                    return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
                }
                if (latest.deliveryStatus === 'cancelled') {
                    return res.status(409).send({ message: 'this request has been cancelled', code: 'REQUEST_CANCELLED' });
                }
                if (latest.deliveryStatus && latest.deliveryStatus !== 'pending-pickup') {
                    return res.status(409).send({ message: 'this request has already been assigned', code: 'REQUEST_ALREADY_ASSIGNED' });
                }
                return res.status(409).send({ message: 'this request can no longer be assigned', code: 'ASSIGNMENT_NOT_ALLOWED' });
            }

            res.send({ acknowledged: true, matchedCount: 1, modifiedCount: 1, deliveryStatus: 'driver_assigned' });
        } catch (error) {
            if (error.code === 'REPAIR_OWNER_ROLE_UNRESOLVED') {
                console.error('Assignment transaction aborted: repair request owner role could not be resolved');
                return res.status(409).send({ message: 'repair request owner account could not be verified', code: 'REPAIR_OWNER_ROLE_UNRESOLVED' });
            }
            if (error.code === 'TECHNICIAN_UPDATE_FAILED') {
                console.error('Assignment transaction aborted: technician update failed');
                return res.status(500).send({ message: 'Error updating technician during assignment', code: 'TECHNICIAN_UPDATE_FAILED' });
            }
            console.error('Assignment transaction aborted:', error.message);
            res.status(500).send({ message: 'Error assigning technician to repair request', code: 'ASSIGNMENT_FAILED' });
        }
    }

    async deleteParcel(req, res) {
        try {
            const id = req.params.id;
            const result = await this.Parcel.delete(id);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error deleting repair request', error: error.message });
        }
    }

    // Customer-initiated soft cancellation - the only cancellation path in
    // this unit. Ownership is enforced here (never delegated to a route
    // guard alone); eligibility is centralized in
    // services/cancellationPolicy.js. Never deletes the document, never
    // touches payment records, never issues a refund.
    async cancelParcel(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }

            const parcel = await this.Parcel.findById(id);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            const ownerEmail = normalize(parcel.senderEmail);
            const callerEmail = normalize(req.decoded_email);
            if (ownerEmail !== callerEmail) {
                return res.status(403).send({ message: 'forbidden access', code: 'NOT_REQUEST_OWNER' });
            }

            // A completed payment record is authoritative even if
            // parcel.paymentStatus is somehow inconsistent with it.
            const existingPayment = await this.collections.payments.findOne({ parcelId: id });
            const eligibility = getCancellationEligibility(parcel, { hasCompletedPayment: !!existingPayment });

            if (!eligibility.eligible) {
                if (eligibility.alreadyCancelled) {
                    return res.send({ message: 'Repair request is already cancelled.', status: 'cancelled', alreadyCancelled: true });
                }
                const statusByCode = {
                    REQUEST_ALREADY_ASSIGNED: 409,
                    REQUEST_ALREADY_PAID: 409,
                    INVALID_REQUEST_STATUS: 400
                };
                return res.status(statusByCode[eligibility.code] || 409).send({ message: eligibility.reason, code: eligibility.code });
            }

            // Atomic guarded update - the query condition itself is the real
            // race-resolver against a concurrent assignment or payment
            // completion, not the read-then-write eligibility check above.
            const updateResult = await this.collections.parcels.updateOne(
                {
                    _id: parcel._id,
                    $or: [
                        { deliveryStatus: { $exists: false } },
                        { deliveryStatus: 'pending-pickup' }
                    ],
                    riderEmail: { $exists: false },
                    paymentStatus: { $ne: 'paid' }
                },
                { $set: { deliveryStatus: 'cancelled' } }
            );

            if (updateResult.matchedCount === 0) {
                // Lost a race (assignment or payment committed between the
                // eligibility check above and this atomic update) - re-fetch
                // to report an accurate, current conflict.
                const latest = await this.Parcel.findById(id);
                if (latest && latest.deliveryStatus === 'cancelled') {
                    return res.send({ message: 'Repair request is already cancelled.', status: 'cancelled', alreadyCancelled: true });
                }
                return res.status(409).send({ message: 'this request can no longer be cancelled', code: 'CANCELLATION_NOT_ALLOWED' });
            }

            logTracking(this.collections.trackings, parcel.trackingId, 'cancelled');

            // Release any active checkout session for this parcel so an old
            // checkout URL can never be reused to reach a valid paid state.
            const cancelledRow = await this.checkoutSessions.cancelByParcelId(parcel._id.toString());
            if (cancelledRow && cancelledRow.sessionId) {
                try {
                    await stripe.checkout.sessions.expire(cancelledRow.sessionId);
                } catch (stripeError) {
                    // Best-effort only - our own checkoutSessions row and the
                    // parcel's cancelled status are already authoritative
                    // regardless of whether Stripe's own expiry call
                    // succeeds (e.g. the session may already be
                    // expired/completed on Stripe's side, which throws here
                    // too).
                    console.error('Stripe session expire failed (non-fatal):', stripeError.message);
                }
            }

            res.send({ message: 'Repair request cancelled successfully.', status: 'cancelled', alreadyCancelled: false });
        } catch (error) {
            res.status(500).send({ message: 'Error cancelling repair request' });
        }
    }
}

module.exports = ParcelController;

