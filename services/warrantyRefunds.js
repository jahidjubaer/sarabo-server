// Warranty refunds. When a covered fault cannot be repaired again, an admin
// refunds the repair amount (utils/warranty.js refundPlan: the repair payment
// plus the inspection fee credited toward it). Same two-step shape as
// services/inspectionFeeRefunds.js:
//
// 1. The controller, in one transaction, moves the claim to refund_pending,
//    writes the plan on it, and reverses the technician's settlement for the
//    repair (utils/settlement.js SETTLEMENT_REVERSED).
// 2. sendWarrantyRefund, after commit, asks Stripe (test mode) to refund each
//    part. The idempotency key is per claim and part, so a retry can never
//    refund twice. A failed part stays pending and the admin can retry.

// { refunded, parts, code? } - never throws for a Stripe failure.
async function sendWarrantyRefund({ collections, refundPayment, claim, now = new Date() }) {
    const refund = claim && claim.refund;
    if (!refund || !Array.isArray(refund.parts)) return { refunded: false, code: 'NO_REFUND_PENDING' };
    if (!refundPayment) return { refunded: false, code: 'REFUND_UNAVAILABLE' };

    const parts = [];
    for (const part of refund.parts) {
        if (part.status === 'refunded') {
            parts.push(part);
            continue;
        }
        let paymentIntentId = part.paymentIntentId || null;
        if (!paymentIntentId && part.sessionId) {
            const row = await collections.payments.findOne({ sessionId: part.sessionId }, { projection: { transactionId: 1 } });
            paymentIntentId = row ? row.transactionId : null;
        }
        if (!paymentIntentId) {
            parts.push({ ...part, status: 'failed', lastError: 'payment not found' });
            continue;
        }
        try {
            const refundId = await refundPayment({ paymentIntentId, idempotencyKey: `warranty-refund-${claim._id}-${part.purpose}` });
            parts.push({ ...part, paymentIntentId, status: 'refunded', refundId, refundedAt: now, lastError: null });
        } catch (error) {
            console.error('Warranty refund failed (stays pending):', error.message);
            parts.push({ ...part, paymentIntentId, status: 'failed', lastError: String(error.message || 'refund failed').slice(0, 200) });
        }
    }

    const refunded = parts.every((p) => p.status === 'refunded');
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
