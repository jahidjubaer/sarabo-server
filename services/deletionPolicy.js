const { VALID_STATUSES } = require('../utils/parcelStatus');

const CANCELLED_STATUS = 'cancelled';

// Every status the current repair lifecycle can actually produce, including
// the terminal 'cancelled' state and the implicit pending-pickup default. A
// status outside this set is corrupted/unknown data and is never guessed at.
const KNOWN_STATUSES = ['pending-pickup', ...VALID_STATUSES, CANCELLED_STATUS];

// The single controlled rejection code every state-based deletion refusal
// collapses to (Phase 6.5 Unit 8). A caller only ever needs to distinguish
// "not allowed" (409) from "not found" (404) and "not authorized" - the
// specific human-readable `reason` explains which rule fired without
// multiplying machine codes the client would have to branch on.
const REQUEST_DELETE_NOT_ALLOWED = 'REQUEST_DELETE_NOT_ALLOWED';

// Centralizes every parcel-state-only *deletion* eligibility rule (rules that
// depend only on the parcel/payment/checkout records, not on the caller's
// identity - ownership/role is checked separately by the caller, see
// controllers/repairRequestController.js's deleteRepairRequest).
//
// Deletion is far more destructive than cancellation: it removes the request
// document, its upload/evidence sessions, its checkout rows, and its Storage
// objects permanently. It is therefore only ever permitted at the very first
// lifecycle stage, before ANY downstream artifact exists - a technician
// assignment, an inspection, a quote, a payment, an active checkout, or any
// repair work each independently makes the request undeletable. Cancellation
// (services/cancellationPolicy.js) is the softer, always-available exit for a
// request that has been paid/assigned; deletion is not.
//
// `hasAnyPayment` and `hasActiveCheckout` must be independently confirmed by
// the caller (real collection lookups) - a financial record is authoritative
// even if parcel.paymentStatus is somehow inconsistent with it, and is never
// silently destroyed.
function getDeletionEligibility(parcel, { hasAnyPayment, hasActiveCheckout }) {
    const status = parcel.deliveryStatus || 'pending-pickup';

    if (!KNOWN_STATUSES.includes(status)) {
        return { eligible: false, code: REQUEST_DELETE_NOT_ALLOWED, reason: 'this request is in an unrecognized state and cannot be deleted' };
    }

    if (status !== 'pending-pickup') {
        return { eligible: false, code: REQUEST_DELETE_NOT_ALLOWED, reason: 'this request has progressed beyond the stage where it can be deleted' };
    }

    if (parcel.technicianEmail || parcel.technicianId) {
        // Defensive: a technician reference should never exist while status is
        // still pending-pickup, but never trust deliveryStatus alone.
        return { eligible: false, code: REQUEST_DELETE_NOT_ALLOWED, reason: 'a technician has already been assigned to this request' };
    }

    if (parcel.inspection) {
        return { eligible: false, code: REQUEST_DELETE_NOT_ALLOWED, reason: 'this request already has an inspection on record and cannot be deleted' };
    }

    if (parcel.quote) {
        return { eligible: false, code: REQUEST_DELETE_NOT_ALLOWED, reason: 'this request already has a quote on record and cannot be deleted' };
    }

    if (parcel.repair) {
        return { eligible: false, code: REQUEST_DELETE_NOT_ALLOWED, reason: 'this request already has repair activity on record and cannot be deleted' };
    }

    if (parcel.paymentStatus === 'paid' || hasAnyPayment) {
        return { eligible: false, code: REQUEST_DELETE_NOT_ALLOWED, reason: 'this request has a payment on record and cannot be deleted' };
    }

    if (hasActiveCheckout) {
        return { eligible: false, code: REQUEST_DELETE_NOT_ALLOWED, reason: 'this request has a checkout in progress and cannot be deleted' };
    }

    return { eligible: true };
}

module.exports = { getDeletionEligibility, REQUEST_DELETE_NOT_ALLOWED, KNOWN_STATUSES };
