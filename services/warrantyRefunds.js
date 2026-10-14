// Warranty refunds. When a covered fault cannot be repaired again, an admin
// refunds the repair amount (utils/warranty.js refundPlan: the repair payment
// plus the inspection fee credited toward it). Same two-step shape as
// services/inspectionFeeRefunds.js:
//
// 1. The controller, in one transaction, moves the claim to refund_pending,
//    writes the plan on it, and reverses the technician's settlement for the
//    repair (utils/settlement.js SETTLEMENT_REVERSED).
// 2. sendWarrantyRefund, after commit, asks Stripe (test mode) to refund each
//    part (services/refundParts.js). The idempotency key is per claim and
//    part, so a retry can never refund twice. A failed part stays pending and
//    the admin can retry.
const { refundParts, markPaymentRowsRefunded } = require('./refundParts');

// { refunded, parts, code? } - never throws for a Stripe failure.
async function sendWarrantyRefund({ collections, refundPayment, claim, now = new Date() }) {
    const refund = claim && claim.refund;
    if (!refund || !Array.isArray(refund.parts)) return { refunded: false, code: 'NO_REFUND_PENDING' };
    if (!refundPayment) return { refunded: false, code: 'REFUND_UNAVAILABLE' };

    const { parts, refunded } = await refundParts({ collections, refundPayment, parts: refund.parts, keyPrefix: `warranty-refund-${claim._id}`, now });
    await markPaymentRowsRefunded({ collections, parts, reason: 'warranty_refund', now });
    await collections.warrantyClaims.updateOne(
        { _id: claim._id, status: 'refund_pending' },
        {
            $set: {
                'refund.parts': parts,
                'refund.lastAttemptAt': now,
                ...(refunded ? { status: 'refunded', 'refund.refundedAt': now, updatedAt: now } : {}),
            },
            ...(refunded ? { $push: { history: { status: 'refunded', at: now, by: 'admin' } } } : {}),
        }
    );
    return { refunded, parts, ...(refunded ? {} : { code: 'REFUND_FAILED' }) };
}

module.exports = { sendWarrantyRefund };
