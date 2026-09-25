// Inspection fee (job-portal phase C). The customer pays the chosen
// technician's inspection fee to book the visit; if they then accept the final
// quote, the fee counts toward it, so the repair payment is the quote total
// minus the fee already paid.
//
// The fee is recorded in its own `inspectionPayment` field - never in the
// fields that mean "the repair is paid" (paymentStatus, payment.status,
// deliveryStatus payment_completed; see utils/paymentState.js) - so paying it
// never blocks the later repair payment.
const INSPECTION_FEE_PURPOSE = 'inspection_fee';
const REPAIR_PURPOSE = 'repair';

// Whole taka already paid as an inspection fee on this request (0 if none,
// or if it was refunded).
function inspectionCredit(request) {
    const payment = request && request.inspectionPayment;
    if (!payment || payment.status !== 'paid') return 0;
    const amount = Number(payment.amount);
    return Number.isInteger(amount) && amount > 0 ? amount : 0;
}

// What is left to pay on the approved quote: its total minus the inspection
// fee already paid, never below zero.
function amountDueForQuote(request) {
    const total = request && request.quote ? Number(request.quote.totalAmount) : NaN;
    if (!Number.isFinite(total)) return NaN;
    return Math.max(total - inspectionCredit(request), 0);
}

module.exports = { INSPECTION_FEE_PURPOSE, REPAIR_PURPOSE, inspectionCredit, amountDueForQuote };
