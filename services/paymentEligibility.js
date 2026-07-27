const { VALID_STATUSES } = require('../utils/parcelStatus');
const { isValidStoredCost } = require('../config/paymentConfig');

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
