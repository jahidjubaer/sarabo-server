const { VALID_STATUSES, QUOTE_APPROVED } = require('../utils/repairRequestStatus');
const { isValidStoredCost, isValidQuoteTotal, isBdtQuoteCurrency, V2_PAYMENT_CURRENCY } = require('../config/paymentConfig');
const { isV2RepairRequest } = require('../utils/repairRequestSchema');
const { isRepairRequestPaid } = require('../utils/paymentState');

// Every status the current repair lifecycle can ever produce, including the
// implicit default before a technician is assigned (a repair request with no
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

// Centralizes every repair request-state-only payment eligibility rule (rules that
// depend only on the repair request document itself, not on the caller's identity or
// any in-flight checkout session - those remain the caller's responsibility,
// see controllers/paymentController.js). Used only to gate NEW checkout-
// session creation - never call this from webhook/browser-success payment
// completion, which must remain able to finalize a session that was validly
// created earlier even if the repair lifecycle has since moved on.
function getPaymentEligibility(repairRequest) {
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
    if (isV2RepairRequest(repairRequest)) {
        return { eligible: false, code: 'PAYMENT_NOT_AVAILABLE', reason: 'payment is not yet available for this repair request - a quote is required first' };
    }

    if (isRepairRequestPaid(repairRequest)) {
        return { eligible: false, code: 'ALREADY_PAID', reason: 'this request has already been paid for' };
    }

    const status = repairRequest.deliveryStatus || 'pending-pickup';
    if (!ELIGIBLE_STATUSES.includes(status)) {
        return { eligible: false, code: 'PAYMENT_NOT_AVAILABLE', reason: "payment is not available for this request's current status" };
    }

    const cost = Number(repairRequest.cost);
    if (!isValidStoredCost(cost)) {
        return { eligible: false, code: 'INVALID_PAYMENT_AMOUNT', reason: 'invalid stored amount for this request' };
    }

    return { eligible: true, cost };
}

// V2 approved-quote payment eligibility (Phase 6.4 Unit 6). RepairRequest-state-only,
// exactly like getPaymentEligibility above (caller identity is the controller's
// responsibility). Kept as a SEPARATE function so the legacy path above keeps
// rejecting every v2 request outright (PAYMENT_NOT_AVAILABLE) - legacy
// isolation: the legacy /payment-checkout-session endpoint can never
// accidentally price a v2 request, and this v2 function can never touch a
// legacy request. The authoritative amount and currency come ONLY from the
// persisted, immutable approved quote (quote.totalAmount / quote.currency),
// never from request.pricing, the inspection estimate, or any client input.
//
// Every rejection is a controlled code; only an approved quote on a
// quote_approved request, in BDT, with a valid positive integer total, and not
// already paid, is eligible.
function getV2PaymentEligibility(repairRequest) {
    if (!repairRequest || !isV2RepairRequest(repairRequest)) {
        return { eligible: false, code: 'NOT_V2_REQUEST', reason: 'this payment path is only available for newer (v2) repair requests' };
    }

    // Already paid takes precedence over any quote/state check - once a v2
    // request has a completed payment it is never eligible to be charged again,
    // regardless of its other fields.
    //
    // The canonical helper accepts both storage generations: legacy
    // paymentStatus and V2 payment.status. The latter survives every later
    // repair/handover transition, so a progressed paid repair cannot be
    // mistaken for a payable one.
    if (isRepairRequestPaid(repairRequest)) {
        return { eligible: false, code: 'ALREADY_PAID', reason: 'this request has already been paid for' };
    }

    const quote = repairRequest.quote;
    if (!quote || !quote.status) {
        return { eligible: false, code: 'NO_QUOTE', reason: 'no repair quote exists for this request yet' };
    }
    if (quote.status === 'rejected') {
        return { eligible: false, code: 'QUOTE_REJECTED', reason: 'the repair quote was declined and cannot be paid' };
    }
    if (quote.status !== 'approved') {
        // submitted / any other non-approved state.
        return { eligible: false, code: 'QUOTE_NOT_APPROVED', reason: 'the repair quote has not been approved yet' };
    }
    if (repairRequest.deliveryStatus !== QUOTE_APPROVED) {
        return { eligible: false, code: 'INVALID_PAYMENT_STATE', reason: 'this request is not in a payable state' };
    }
    if (!isBdtQuoteCurrency(quote.currency)) {
        return { eligible: false, code: 'INVALID_QUOTE_CURRENCY', reason: 'the repair quote currency is not payable' };
    }
    if (!isValidQuoteTotal(quote.totalAmount)) {
        return { eligible: false, code: 'INVALID_QUOTE_AMOUNT', reason: 'the repair quote amount is invalid' };
    }

    // amount is whole taka (display + Stripe-major-unit source); currency is the
    // uppercase code the quote stores. quoteVersion lets the client/Stripe
    // metadata pin exactly which immutable quote is being paid.
    return {
        eligible: true,
        amount: quote.totalAmount,
        currency: quote.currency,
        quoteVersion: quote.version,
    };
}

module.exports = { getPaymentEligibility, getV2PaymentEligibility, ELIGIBLE_STATUSES, V2_PAYMENT_CURRENCY };
