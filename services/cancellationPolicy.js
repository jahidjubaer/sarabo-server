const { VALID_STATUSES } = require('../utils/parcelStatus');

const CANCELLED_STATUS = 'cancelled';

// Every status the current repair lifecycle can actually produce, including
// the terminal 'cancelled' state and the implicit pending-pickup default. A
// status outside this set is corrupted/unknown data and is never guessed at.
const KNOWN_STATUSES = ['pending-pickup', ...VALID_STATUSES, CANCELLED_STATUS];

// Centralizes every parcel-state-only cancellation eligibility rule (rules
// that depend only on the parcel/payment records, not on the caller's
// identity - ownership is checked separately by the caller, see
// controllers/parcelController.js's cancelParcel). Cancellation is only ever
// possible from the very first stage of the repair lifecycle: once a
// technician is assigned, or the request has progressed/been paid, a
// customer can no longer back out through this endpoint.
//
// `hasCompletedPayment` must be independently confirmed by the caller
// (a real payments-collection lookup) - a request must be rejected if a
// completed payment record exists even if parcel.paymentStatus is somehow
// inconsistent with it.
function getCancellationEligibility(parcel, { hasCompletedPayment }) {
    const status = parcel.deliveryStatus || 'pending-pickup';

    if (status === CANCELLED_STATUS) {
        return { eligible: false, alreadyCancelled: true, code: 'ALREADY_CANCELLED', reason: 'this request has already been cancelled' };
    }

    if (!KNOWN_STATUSES.includes(status)) {
        return { eligible: false, code: 'INVALID_REQUEST_STATUS', reason: 'this request is in an unrecognized state and cannot be cancelled' };
    }

    if (status !== 'pending-pickup') {
        return { eligible: false, code: 'REQUEST_ALREADY_ASSIGNED', reason: 'a technician has already been assigned to this request' };
    }

    if (parcel.riderEmail) {
        // Defensive: a technician reference should never exist while status
        // is still pending-pickup, but never trust deliveryStatus alone.
        return { eligible: false, code: 'REQUEST_ALREADY_ASSIGNED', reason: 'a technician has already been assigned to this request' };
    }

    if (parcel.paymentStatus === 'paid' || hasCompletedPayment) {
        return { eligible: false, code: 'REQUEST_ALREADY_PAID', reason: 'this request has already been paid for and cannot be cancelled here' };
    }

    return { eligible: true };
}

module.exports = { getCancellationEligibility, CANCELLED_STATUS, KNOWN_STATUSES };
