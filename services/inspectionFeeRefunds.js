const { ObjectId } = require('mongodb');
const { logTrackingSafely } = require('../middleware/logging');

// Inspection-fee refunds (job-portal phases C and D). A refund is two steps:
//
// 1. markFeeForRefund - inside the caller's transaction, next to the state
//    change that causes it (a no-show withdrawal, an early cancellation): the
//    request's fee and its payments row become refund-pending. Nothing is sent
//    to Stripe yet, so a failed transaction refunds nothing.
// 2. sendFeeRefund - after commit: asks Stripe to refund and records the
//    result. The payments row is the source of truth (one per Stripe session);
//    a failure leaves it pending, and an admin can retry it
//    (POST /admin/repair-requests/:id/inspection-fee/retry-refund). The Stripe
//    idempotency key is per session, so a retry can never refund twice.

// Stripe test mode: refunds a payment and resolves to the refund id.
function createStripeRefunder(stripe) {
    return async ({ paymentIntentId, idempotencyKey }) => {
        const refund = await stripe.refunds.create({ payment_intent: paymentIntentId }, { idempotencyKey });
        return refund.id;
    };
}

// Step 1. Returns the Stripe session id marked, or null when the request has
// no paid fee (nothing to refund).
async function markFeeForRefund({ collections, request, reason, now, session }) {
    const payment = request && request.inspectionPayment;
    if (!payment || payment.status !== 'paid' || !payment.sessionId) return null;
    const result = await collections.repairRequests.updateOne(
        { _id: request._id, 'inspectionPayment.status': 'paid', 'inspectionPayment.sessionId': payment.sessionId },
        { $set: { 'inspectionPayment.status': 'refund_pending', 'inspectionPayment.refundReason': reason, 'inspectionPayment.refundRequestedAt': now } },
        { session }
    );
    if (result.matchedCount === 0) return null;
    await collections.payments.updateOne(
        { sessionId: payment.sessionId, refundStatus: { $ne: 'refunded' } },
        { $set: { refundStatus: 'pending', refundReason: reason } },
        { session }
    );
    return payment.sessionId;
}

// Step 2. { refunded, refundId?, code? } - never throws for a Stripe failure.
async function sendFeeRefund({ collections, refundPayment, sessionId, now = new Date() }) {
    const row = await collections.payments.findOne({ sessionId });
    if (!row) return { refunded: false, code: 'PAYMENT_NOT_FOUND' };
    if (row.refundStatus === 'refunded') return { refunded: true, refundId: row.refundId, alreadyRefunded: true };
    if (row.refundStatus !== 'pending') return { refunded: false, code: 'NO_REFUND_PENDING' };
    if (!refundPayment || !row.transactionId) return { refunded: false, code: 'REFUND_UNAVAILABLE' };

    let refundId;
    try {
        refundId = await refundPayment({ paymentIntentId: row.transactionId, idempotencyKey: `inspection-refund-${sessionId}` });
    } catch (error) {
        console.error('Inspection fee refund failed (stays pending):', error.message);
        await collections.payments.updateOne({ sessionId }, { $set: { lastRefundError: String(error.message || 'refund failed').slice(0, 200), lastRefundAttemptAt: now } });
        return { refunded: false, code: 'REFUND_FAILED' };
    }
    await collections.payments.updateOne({ sessionId }, { $set: { refundStatus: 'refunded', refundId, refundedAt: now }, $unset: { lastRefundError: '' } });
    if (ObjectId.isValid(row.requestId)) {
        await collections.repairRequests.updateOne(
            { _id: new ObjectId(row.requestId), 'inspectionPayment.sessionId': sessionId },
            { $set: { 'inspectionPayment.status': 'refunded', 'inspectionPayment.refundId': refundId, 'inspectionPayment.refundedAt': now } }
        );
    }
    return { refunded: true, refundId };
}

// Tells the customer their fee is coming back (never throws).
async function notifyFeeRefunded({ collections, notifications, User, request, reason, sessionId }) {
    await logTrackingSafely(collections.trackingEvents, request.trackingId, 'inspection_fee_refunded');
    try {
        const ownerRole = await User.findRoleByEmail(request.senderEmail);
        if (!ownerRole) return;
        await notifications.createNotification({
            recipientEmail: request.senderEmail,
            recipientRole: ownerRole,
            type: 'inspection_fee_refunded',
            entityType: 'repair_request',
            entityId: request._id.toString(),
            metadata: { trackingId: request.trackingId, occurrence: sessionId, reason },
        });
    } catch (error) {
        console.error('Inspection fee refund notification failed (non-fatal):', error.message);
    }
}

module.exports = { createStripeRefunder, markFeeForRefund, sendFeeRefund, notifyFeeRefunded };
