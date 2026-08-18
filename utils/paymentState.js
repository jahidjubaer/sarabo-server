const { PAYMENT_COMPLETED } = require('./repairRequestStatus');

// Canonical repair-request payment truth. V2 requests persist payment
// completion in payment.status; legacy requests use the top-level
// paymentStatus. PAYMENT_COMPLETED remains a trusted V2 transition marker for
// older records written before the payment sub-document was consistently
// projected. Every server read/filter must use this rule rather than choosing
// one storage generation independently.
function isRepairRequestPaid(repairRequest) {
    if (!repairRequest || typeof repairRequest !== 'object') return false;
    return repairRequest.paymentStatus === 'paid'
        || repairRequest.payment?.status === 'completed'
        || repairRequest.deliveryStatus === PAYMENT_COMPLETED;
}

// Mongo equivalent of isRepairRequestPaid. Keeping the persisted markers here
// makes Admin paid/unpaid filtering and the normalized response boolean agree
// by construction.
function buildPaymentStateMatch(paid) {
    const paidMarkers = [
        { paymentStatus: 'paid' },
        { 'payment.status': 'completed' },
        { deliveryStatus: PAYMENT_COMPLETED },
    ];
    return paid ? { $or: paidMarkers } : { $nor: paidMarkers };
}

module.exports = { isRepairRequestPaid, buildPaymentStateMatch };
