// Single source of truth for the repair-request delivery-status lifecycle.
// assignRiderToParcel sets the first status (driver_assigned) unconditionally
// and isn't covered here - only updateParcelStatus accepts a client-supplied
// status value, which is what needed validating.
const VALID_STATUSES = ['driver_assigned', 'rider_arriving', 'parcel_picked_up', 'parcel_delivered'];

// Technician inspection completion (Phase 6.4 Unit 4). Deliberately NOT part
// of VALID_STATUSES: that list is the set of client-settable transition
// targets updateParcelStatus accepts, and inspection_completed must never be
// reachable through the generic PATCH /parcels/:id/status path - it is set
// only by the dedicated, atomic inspection-submission endpoint (see
// controllers/inspectionController.js). It is, however, an ACTIVE status
// below: a technician who has completed an inspection is still holding the
// request (the repair itself has not happened yet), so they must remain
// occupied and un-recommendable/un-assignable for any other request.
const INSPECTION_COMPLETED = 'inspection_completed';

// Quote workflow (Phase 6.4 Unit 5). Same design as INSPECTION_COMPLETED:
// deliberately NOT part of VALID_STATUSES (so the generic PATCH
// /parcels/:id/status can neither reach nor leave them - they are written
// only by the dedicated, atomic quote endpoints, see
// controllers/quoteController.js), but all three ARE active below: a repair
// request with a submitted/approved/rejected quote is still held by its
// technician (payment/repair have not happened), so the technician stays
// occupied and un-assignable to any other request. Payment remains blocked
// even at quote_approved in this unit.
const QUOTE_SUBMITTED = 'quote_submitted';
const QUOTE_APPROVED = 'quote_approved';
const QUOTE_REJECTED = 'quote_rejected';

// Approved-quote payment completed (Phase 6.4 Unit 6). Same design as the
// statuses above: deliberately NOT in VALID_STATUSES (the generic PATCH
// /parcels/:id/status can never reach or leave it), reached only through the
// trusted Stripe payment-completion pipeline (services/paymentProcessor.js),
// but IS active below - a paid-but-not-yet-repaired request still occupies its
// technician, who stays busy until the repair workflow runs.
const PAYMENT_COMPLETED = 'payment_completed';

// Repair progress + completion (Phase 6.4 Unit 7). Both are set ONLY by the
// dedicated repair endpoints (controllers/repairController.js), never through
// the generic PATCH /parcels/:id/status path (neither is in VALID_STATUSES).
// repair_in_progress IS active - the technician is actively repairing and
// stays busy. repair_completed is the TERMINAL state for an active assignment:
// the repair is done and the technician has been released, so it is
// deliberately NOT active (it must not keep the technician occupied, and the
// generic PATCH must not be able to leave it).
const REPAIR_IN_PROGRESS = 'repair_in_progress';
const REPAIR_COMPLETED = 'repair_completed';

// The subset of statuses that represent a technician actively holding a
// repair request - i.e. every status between assignment and completion,
// including inspection_completed, the quote states, payment_completed, and
// repair_in_progress. repair_completed is intentionally excluded (terminal).
// Used by assignRiderToParcel (Phase 6.2 Unit 2) and technicianEligibilityService
// to find any request still occupying a technician's single active-assignment slot.
const ACTIVE_STATUSES = [
    ...VALID_STATUSES.filter((status) => status !== 'parcel_delivered'),
    INSPECTION_COMPLETED, QUOTE_SUBMITTED, QUOTE_APPROVED, QUOTE_REJECTED, PAYMENT_COMPLETED, REPAIR_IN_PROGRESS
];

// Maps a parcel's current deliveryStatus to the statuses it may move to next.
const ALLOWED_TRANSITIONS = {
    driver_assigned: ['rider_arriving'],
    rider_arriving: ['parcel_picked_up'],
    parcel_picked_up: ['parcel_delivered'],
    parcel_delivered: []
};

function isValidTransition(currentStatus, nextStatus) {
    const allowedNext = ALLOWED_TRANSITIONS[currentStatus];
    return Array.isArray(allowedNext) && allowedNext.includes(nextStatus);
}

module.exports = { VALID_STATUSES, ACTIVE_STATUSES, INSPECTION_COMPLETED, QUOTE_SUBMITTED, QUOTE_APPROVED, QUOTE_REJECTED, PAYMENT_COMPLETED, REPAIR_IN_PROGRESS, REPAIR_COMPLETED, isValidTransition };
