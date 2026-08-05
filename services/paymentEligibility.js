const { VALID_STATUSES } = require('../utils/parcelStatus');
const { isValidStoredCost } = require('../config/paymentConfig');
const { isV2RepairRequest } = require('../utils/repairRequestSchema');

// Every status the current repair lifecycle can ever produce, including the
// implicit default before a technician is assigned (a parcel with no
// deliveryStatus field is treated as 'pending-pickup' everywhere else in
// this codebase - see the `request.deliveryStatus || 'pending-pickup'`
// pattern in MyRequests/RequestDetails/CustomerDashboardHome). Payment is
// permitted at every one of these stages: nothing in the current product
// (no invoice/diagnosis step, no cancellation status) ties cost
// finalization or payment eligibility to a specific stage, and the existing
// UI already allows paying at any of them. A status outside this list
// (corrupted data, a future/typo'd value) is deliberately treated as
// ineligible rather than guessed at.
const ELIGIBLE_STATUSES = ['pending-pickup', ...VALID_STATUSES];

// Centralizes every parcel-state-only payment eligibility rule (rules that
// depend only on the parcel document itself, not on the caller's identity or
// any in-flight checkout session - those remain the caller's responsibility,
// see controllers/paymentController.js). Used only to gate NEW checkout-
// session creation - never call this from webhook/browser-success payment
// completion, which must remain able to finalize a session that was validly
// created earlier even if the repair lifecycle has since moved on.
function getPaymentEligibility(parcel) {
    // Repair Request v2 foundation (Phase 6.3 Unit 4): a v2 request has no
    // authoritative legacy `cost` field and no quote/final-amount workflow
    // exists yet (that is a future unit) - checked first, before the
    // paymentStatus/status/cost checks below, so a v2 request is always
    // rejected with this specific, honest reason rather than incidentally
    // falling through to INVALID_PAYMENT_AMOUNT (which would read as if the
    // request's data were corrupted, when it is actually just not quoted
    // yet). No checkout session or Stripe call is ever reached for a v2
    // request as a result - see controllers/paymentController.js, which
    // checks this before claiming a checkout-session slot or calling Stripe.
    if (isV2RepairRequest(parcel)) {
        return { eligible: false, code: 'PAYMENT_NOT_AVAILABLE', reason: 'payment is not yet available for this repair request - a quote is required first' };
    }

    if (parcel.paymentStatus === 'paid') {
        return { eligible: false, code: 'ALREADY_PAID', reason: 'this request has already been paid for' };
    }

    const status = parcel.deliveryStatus || 'pending-pickup';
    if (!ELIGIBLE_STATUSES.includes(status)) {
        return { eligible: false, code: 'PAYMENT_NOT_AVAILABLE', reason: "payment is not available for this request's current status" };
    }

    const cost = Number(parcel.cost);
    if (!isValidStoredCost(cost)) {
        return { eligible: false, code: 'INVALID_PAYMENT_AMOUNT', reason: 'invalid stored amount for this request' };
    }

    return { eligible: true, cost };
}

module.exports = { getPaymentEligibility, ELIGIBLE_STATUSES };
