// Inspection fee (job-portal phase C). The customer pays the chosen
// technician's inspection fee to book the visit; if they then accept the final
// quote, the fee counts toward it, so the repair payment is the quote total
// minus the fee already paid.
//
// The fee is recorded in its own `inspectionPayment` field - never in the
// fields that mean "the repair is paid" (paymentStatus, payment.status,
// deliveryStatus payment_completed; see utils/paymentState.js) - so paying it
// never blocks the later repair payment.
const { commissionFor, PLATFORM_COMMISSION_RATE } = require('./settlement');

const INSPECTION_FEE_PURPOSE = 'inspection_fee';

// Every repair has an inspection fee (policy set 2026-10-14): at least 100 BDT
// for a small job (estimate up to 1,000 BDT), at least 200 BDT for anything
// bigger. A service's own fee is the most a technician may ask; it can never
// sit below this floor, and an offer can never go below it.
const SMALL_JOB_MAX_ESTIMATE_BDT = 1000;
const MIN_INSPECTION_FEE_SMALL_BDT = 100;
const MIN_INSPECTION_FEE_BDT = 200;

// The floor for a job whose estimate tops out at `estimateMax`. An unknown
// estimate gets the standard floor.
function minimumInspectionFee(estimateMax) {
    const max = Number(estimateMax);
    return Number.isFinite(max) && max > 0 && max <= SMALL_JOB_MAX_ESTIMATE_BDT
        ? MIN_INSPECTION_FEE_SMALL_BDT
        : MIN_INSPECTION_FEE_BDT;
}

// A stored fee raised to the floor if it is below it.
function withMinimumInspectionFee(fee, estimateMax) {
    const amount = Number(fee);
    const floor = minimumInspectionFee(estimateMax);
    return Number.isFinite(amount) && amount > floor ? amount : floor;
}
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

// ---- Money outcomes (job-portal phase D) ---------------------------------
// When the repair does not go ahead, the fee either goes back to the customer
// or is kept - and a kept fee is split like a repair: the technician gets 90%
// (into their wallet), Sarabo keeps 10%.
//
//   technician no-show                         -> full refund
//   customer cancels >= 2 hours before the visit -> full refund
//   customer cancels later                     -> kept, 90/10
//   customer declines the final price          -> kept, 90/10
const LATE_CANCEL_WINDOW_MS = 2 * 60 * 60 * 1000;
// The last three close an unpaid request after the device was collected and
// inspected (services/requestClosure.js).
const FEE_KEPT_REASONS = Object.freeze(['quote_declined', 'late_cancellation', 'payment_not_made', 'customer_cancelled_unpaid', 'not_repairable']);
const FEE_REFUND_REASONS = Object.freeze(['booking_failed', 'technician_no_show', 'customer_cancelled']);

// What cancelling a booked visit now would do with the fee: 'refund', 'kept',
// or 'none' (no fee paid). No pickup time on record counts as early.
function bookingCancellationOutcome(request, now) {
    if (inspectionCredit(request) === 0) return { outcome: 'none', refundCutoffAt: null };
    const startsAt = request.pickupSlot && request.pickupSlot.startsAt ? new Date(request.pickupSlot.startsAt) : null;
    if (!startsAt || Number.isNaN(startsAt.getTime())) return { outcome: 'refund', refundCutoffAt: null };
    const refundCutoffAt = new Date(startsAt.getTime() - LATE_CANCEL_WINDOW_MS);
    return { outcome: now.getTime() <= refundCutoffAt.getTime() ? 'refund' : 'kept', refundCutoffAt };
}

// The technician's share of a kept fee, same integer rule as a repair
// (utils/settlement.js): commission rounded, receivable by subtraction.
function inspectionFeeSplit(feeAmount) {
    const platformCommission = commissionFor(feeAmount);
    return { feeAmount, commissionRate: PLATFORM_COMMISSION_RATE, platformCommission, technicianReceivable: feeAmount - platformCommission };
}

// The settlement written when a paid fee is kept. Available to withdraw at
// once - there is no repair left to confirm.
function buildInspectionFeeSettlement(request, { reason, now }) {
    const payment = request.inspectionPayment;
    return {
        status: 'available',
        reason,
        technicianId: payment.technicianId || request.technicianId || null,
        technicianEmail: request.technicianEmail || null,
        ...inspectionFeeSplit(inspectionCredit(request)),
        currency: 'BDT',
        sessionId: payment.sessionId || null,
        settledAt: now,
        availableAt: now,
    };
}

// What a customer, technician or admin screen may see of the fee - never the
// Stripe ids.
function inspectionPaymentView(request) {
    const payment = request && request.inspectionPayment;
    if (!payment) return null;
    return {
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency || 'BDT',
        paidAt: payment.paidAt || null,
        refundReason: payment.refundReason || null,
        refundedAt: payment.refundedAt || null,
        keptReason: payment.keptReason || null,
    };
}

// A kept fee as a wallet line (technician and admin only).
function inspectionFeeSettlementView(request) {
    const settlement = request && request.inspectionFeeSettlement;
    if (!settlement) return null;
    return {
        kind: 'inspection_fee',
        repairRequestId: request._id ? request._id.toString() : null,
        trackingId: request.trackingId ?? null,
        status: settlement.status,
        reason: settlement.reason,
        repairSubtotal: settlement.feeAmount,
        commissionRate: settlement.commissionRate,
        platformCommission: settlement.platformCommission,
        technicianReceivable: settlement.technicianReceivable,
        currency: settlement.currency,
        settledAt: settlement.settledAt ?? null,
        availableAt: settlement.availableAt ?? null,
    };
}

module.exports = {
    SMALL_JOB_MAX_ESTIMATE_BDT, MIN_INSPECTION_FEE_SMALL_BDT, MIN_INSPECTION_FEE_BDT,
    minimumInspectionFee, withMinimumInspectionFee,
    INSPECTION_FEE_PURPOSE, REPAIR_PURPOSE, inspectionCredit, amountDueForQuote,
    LATE_CANCEL_WINDOW_MS, FEE_KEPT_REASONS, FEE_REFUND_REASONS,
    bookingCancellationOutcome, inspectionFeeSplit, buildInspectionFeeSettlement,
    inspectionPaymentView, inspectionFeeSettlementView,
};
