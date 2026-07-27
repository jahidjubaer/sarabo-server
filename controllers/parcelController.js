const { ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { client } = require('../config/database');
const { generateSecureTrackingId } = require('../utils/trackingId');
const { logTracking } = require('../middleware/logging');
const { VALID_STATUSES, isValidTransition } = require('../utils/parcelStatus');
const { normalize } = require('../services/paymentProcessor');
const { createCheckoutSessionManager } = require('../services/checkoutSessionManager');
const { getCancellationEligibility } = require('../services/cancellationPolicy');

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

    async updateParcelStatus(req, res) {
        try {
            const { deliveryStatus, riderId, trackingId } = req.body;
            const id = req.params.id;
            
            const parcel = await this.Parcel.findById(id);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found' });
            }
            
            const currentUser = await this.User.findByEmail(req.decoded_email);
            const isRider = currentUser && currentUser.role === 'rider';
            const isAdmin = currentUser && currentUser.role === 'admin';
            const isAssignedRider = parcel.riderEmail === req.decoded_email;
            
            // Only the assigned technician or admins can update the repair request status
            if (!isAdmin && !(isRider && isAssignedRider)) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            if (!VALID_STATUSES.includes(deliveryStatus)) {
                return res.status(400).send({ message: 'invalid repair status' });
            }

            if (deliveryStatus === parcel.deliveryStatus) {
                // Idempotent re-submission of the current status: nothing to
                // persist, and no tracking log should be duplicated for it.
                return res.send({ message: 'status unchanged', matchedCount: 1, modifiedCount: 0 });
            }

            if (!isValidTransition(parcel.deliveryStatus, deliveryStatus)) {
                return res.status(400).send({ message: 'invalid status transition' });
            }

            const result = await this.Parcel.updateStatus(id, deliveryStatus);

            if (deliveryStatus === 'parcel_delivered' && riderId) {
                await this.Rider.updateWorkStatus(riderId, 'available');
            }

            logTracking(this.collections.trackings, trackingId, deliveryStatus);

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error updating repair status', error: error.message });
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

