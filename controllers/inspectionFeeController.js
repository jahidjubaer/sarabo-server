const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { logTracking } = require('../middleware/logging');
const { createNotificationService } = require('../services/notificationService');
const { createStripeRefunder, markFeeForRefund, sendFeeRefund, notifyFeeRefunded } = require('../services/inspectionFeeRefunds');
const { inspectionCredit, bookingCancellationOutcome, buildInspectionFeeSettlement, INSPECTION_FEE_PURPOSE } = require('../utils/inspectionFee');
const { ACTIVE_STATUSES } = require('../utils/repairRequestStatus');
const { ASSIGNED_NOT_COLLECTED } = require('./missedPickupController');

// Inspection-fee money outcomes that need their own endpoints (job-portal
// phase D).
//
// - The customer cancels a visit they paid the inspection fee for. Until the
//   device is collected they can cancel; 2 hours or more before the pickup
//   time starts the fee is refunded in full, later it is kept (90% to the
//   technician's wallet, 10% to Sarabo).
// - An admin retries an inspection-fee refund that Stripe did not complete.
//
// The other outcomes live where they happen: a declined final price in
// quoteController.cancelAfterQuoteRejection, a technician no-show in
// missedPickupController.withdraw.
function normalize(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

class InspectionFeeController {
    constructor(models, collections, { now = () => new Date(), mongoClient = client, refundPayment = null } = {}) {
        this.collections = collections;
        this.User = models.User;
        this.notifications = createNotificationService(models);
        this.now = now;
        this.mongoClient = mongoClient;
        this.refundPayment = refundPayment || ((args) => createStripeRefunder(require('stripe')(process.env.STRIPE_SECRET))(args));
    }

    // The caller's own request, or an { status, code, message } refusal. A
    // request someone else owns is reported as not found.
    async loadOwned(req) {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) return { refusal: { status: 400, code: 'INVALID_REQUEST_ID', message: 'invalid repair request id' } };
        const request = await this.collections.repairRequests.findOne({ _id: new ObjectId(id) });
        if (!request || normalize(request.senderEmail) !== normalize(req.decoded_email)) {
            return { refusal: { status: 404, code: 'REQUEST_NOT_FOUND', message: 'repair request not found' } };
        }
        return { request };
    }

    static isCancellableBooking(request) {
        return ASSIGNED_NOT_COLLECTED.includes(request.deliveryStatus) && Boolean(request.technicianEmail) && inspectionCredit(request) > 0;
    }

    // GET /repair-requests/:id/booking-cancellation - what cancelling now does.
    async preview(req, res) {
        try {
            const { request, refusal } = await this.loadOwned(req);
            if (refusal) return res.status(refusal.status).send({ message: refusal.message, code: refusal.code });
            if (!InspectionFeeController.isCancellableBooking(request)) {
                return res.send({ cancellable: false });
            }
            const { outcome, refundCutoffAt } = bookingCancellationOutcome(request, this.now());
            res.send({ cancellable: true, outcome, fee: inspectionCredit(request), currency: 'BDT', refundCutoffAt });
        } catch (error) {
            res.status(500).send({ message: 'Error checking the cancellation', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/cancel-booking
    async cancelBooking(req, res) {
        try {
            const { request, refusal } = await this.loadOwned(req);
            if (refusal) return res.status(refusal.status).send({ message: refusal.message, code: refusal.code });
            if (request.deliveryStatus === 'cancelled') {
                return res.status(409).send({ message: 'this request has already been cancelled', code: 'ALREADY_CANCELLED' });
            }
            if (!InspectionFeeController.isCancellableBooking(request)) {
                return res.status(409).send({ message: 'this visit can no longer be cancelled here', code: 'BOOKING_NOT_CANCELLABLE' });
            }

            const now = this.now();
            const { outcome } = bookingCancellationOutcome(request, now);
            const kept = outcome === 'kept';
            const customerEmail = normalize(req.decoded_email);
            const session = this.mongoClient.startSession();
            let changed = false;
            let refundSessionId = null;
            try {
                await session.withTransaction(async () => {
                    changed = false;
                    refundSessionId = null;
                    // Guarded on the exact state just read: a pickup landing
                    // at the same moment wins, and the fee is still unpaid-out.
                    const result = await this.collections.repairRequests.updateOne(
                        {
                            _id: request._id,
                            deliveryStatus: request.deliveryStatus,
                            technicianEmail: request.technicianEmail,
                            'inspectionPayment.status': 'paid',
                            'inspectionPayment.sessionId': request.inspectionPayment.sessionId,
                        },
                        {
                            $set: {
                                deliveryStatus: 'cancelled',
                                cancelledAt: now,
                                cancelledBy: customerEmail,
                                cancellationReason: 'customer_cancelled_booking',
                                updatedAt: now,
                                ...(kept ? {
                                    'inspectionPayment.status': 'kept',
                                    'inspectionPayment.keptReason': 'late_cancellation',
                                    inspectionFeeSettlement: buildInspectionFeeSettlement(request, { reason: 'late_cancellation', now }),
                                } : {}),
                            },
                            $unset: { pickupRescheduleRequestedAt: '', feeCheckout: '' },
                        },
                        { session }
                    );
                    if (result.matchedCount === 0) return;
                    changed = true;
                    if (!kept) {
                        refundSessionId = await markFeeForRefund({ collections: this.collections, request, reason: 'customer_cancelled', now, session });
                    }
                    // Free the technician unless another job keeps them busy.
                    if (request.technicianId && ObjectId.isValid(request.technicianId)) {
                        const otherActive = await this.collections.repairRequests.findOne(
                            { technicianId: request.technicianId, deliveryStatus: { $in: ACTIVE_STATUSES }, _id: { $ne: request._id } },
                            { session, projection: { _id: 1 } }
                        );
                        if (!otherActive) {
                            await this.collections.technicians.updateOne(
                                { _id: new ObjectId(request.technicianId), workStatus: 'in_delivery' },
                                { $set: { workStatus: 'available' } },
                                { session }
                            );
                        }
                    }
                    await logTracking(this.collections.trackingEvents, request.trackingId, 'cancelled', session);
                    await this.notifications.createNotification({
                        session,
                        recipientEmail: request.technicianEmail,
                        recipientRole: 'rider',
                        type: 'booking_cancelled_by_customer',
                        entityType: 'repair_request',
                        entityId: request._id.toString(),
                        actorEmail: customerEmail,
                        metadata: { trackingId: request.trackingId, feeOutcome: kept ? 'kept' : 'refunded' },
                    });
                });
            } finally {
                await session.endSession();
            }
            if (!changed) {
                return res.status(409).send({ message: 'this request changed meanwhile - reload it', code: 'REQUEST_CHANGED' });
            }

            let inspectionFee = kept ? 'kept' : 'none';
            if (refundSessionId) {
                const refund = await sendFeeRefund({ collections: this.collections, refundPayment: this.refundPayment, sessionId: refundSessionId, now });
                await notifyFeeRefunded({ collections: this.collections, notifications: this.notifications, User: this.User, request, reason: 'customer_cancelled', sessionId: refundSessionId });
                inspectionFee = refund.refunded ? 'refunded' : 'refund_pending';
            }
            res.send({ success: true, deliveryStatus: 'cancelled', inspectionFee });
        } catch (error) {
            res.status(500).send({ message: 'Error cancelling the visit', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /admin/repair-requests/:id/inspection-fee/retry-refund - sends every
    // inspection-fee refund on this request that is still pending.
    async retryRefund(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            const pending = await this.collections.payments
                .find({ requestId: id, purpose: INSPECTION_FEE_PURPOSE, refundStatus: 'pending' }, { projection: { sessionId: 1 } })
                .toArray();
            if (pending.length === 0) {
                return res.status(409).send({ message: 'there is no inspection-fee refund waiting on this request', code: 'NO_REFUND_PENDING' });
            }
            let refunded = 0;
            for (const row of pending) {
                const result = await sendFeeRefund({ collections: this.collections, refundPayment: this.refundPayment, sessionId: row.sessionId, now: this.now() });
                if (result.refunded) refunded += 1;
            }
            const stillPending = pending.length - refunded;
            if (stillPending > 0) {
                return res.status(502).send({ message: 'Stripe did not complete the refund - try again later', code: 'REFUND_FAILED', refunded, stillPending });
            }
            res.send({ success: true, refunded, stillPending: 0 });
        } catch (error) {
            res.status(500).send({ message: 'Error retrying the refund', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = InspectionFeeController;
