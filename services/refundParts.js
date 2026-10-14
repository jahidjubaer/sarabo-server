// Refunds a list of payment parts through Stripe (test mode) - shared by the
// warranty refund (services/warrantyRefunds.js) and an admin cancelling a paid
// repair (controllers/workflowController.js). A part is
//   { purpose, amount, paymentIntentId? | sessionId?, status? }
// (utils/warranty.js refundPlan). Parts already refunded are left alone; the
// idempotency key is `${keyPrefix}-${purpose}`, so a retry can never refund
// twice. Never throws for a Stripe failure - the failed part says why.
async function refundParts({ collections, refundPayment, parts, keyPrefix, now = new Date() }) {
    const result = [];
    for (const part of parts || []) {
        if (part.status === 'refunded') {
            result.push(part);
            continue;
        }
        let paymentIntentId = part.paymentIntentId || null;
        if (!paymentIntentId && part.sessionId) {
            const row = await collections.payments.findOne({ sessionId: part.sessionId }, { projection: { transactionId: 1 } });
            paymentIntentId = row ? row.transactionId : null;
        }
        if (!paymentIntentId) {
            result.push({ ...part, status: 'failed', lastError: 'payment not found' });
            continue;
        }
        try {
            const refundId = await refundPayment({ paymentIntentId, idempotencyKey: `${keyPrefix}-${part.purpose}` });
            result.push({ ...part, paymentIntentId, status: 'refunded', refundId, refundedAt: now, lastError: null });
        } catch (error) {
            console.error('Refund failed (stays pending):', error.message);
            result.push({ ...part, paymentIntentId, status: 'failed', lastError: String(error.message || 'refund failed').slice(0, 200) });
        }
    }
    return { parts: result, refunded: result.every((p) => p.status === 'refunded') };
}

// Marks the payments rows of refunded parts, so payment history shows the
// refund. Never touches a row already marked refunded.
async function markPaymentRowsRefunded({ collections, parts, reason, now = new Date() }) {
    for (const part of parts || []) {
        if (part.status !== 'refunded') continue;
        const filter = part.purpose === 'inspection_fee' && part.sessionId
            ? { sessionId: part.sessionId }
            : { transactionId: part.paymentIntentId, purpose: part.purpose };
        await collections.payments.updateOne(
            { ...filter, refundStatus: { $ne: 'refunded' } },
            { $set: { refundStatus: 'refunded', refundId: part.refundId, refundedAt: part.refundedAt || now, refundReason: reason } }
        );
    }
}

module.exports = { refundParts, markPaymentRowsRefunded };
