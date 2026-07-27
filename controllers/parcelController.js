const { ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
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

    async assignRiderToParcel(req, res) {
        try {
            const { riderId, riderName, riderEmail, trackingId } = req.body;
            const id = req.params.id;

            const updatedDoc = {
                deliveryStatus: 'driver_assigned',
                riderId: riderId,
                riderName: riderName,
                riderEmail: riderEmail
            };

            // Guarded atomically against a concurrent customer cancellation -
            // the query condition itself is the race-resolver, not a
            // read-then-write check. If cancellation already committed (or
            // wins the race), matchedCount is 0 and neither the technician's
            // work status nor a tracking log is touched.
            const result = await this.collections.parcels.updateOne(
                {
                    _id: new ObjectId(id),
                    $or: [
                        { deliveryStatus: { $exists: false } },
                        { deliveryStatus: 'pending-pickup' }
                    ]
                },
                { $set: updatedDoc }
            );

            if (result.matchedCount === 0) {
                return res.status(409).send({ message: 'this repair request can no longer be assigned', code: 'REQUEST_NOT_ASSIGNABLE' });
            }

            await this.Rider.updateWorkStatus(riderId, 'in_delivery');
            logTracking(this.collections.trackings, trackingId, 'driver_assigned');

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error assigning technician to repair request', error: error.message });
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

