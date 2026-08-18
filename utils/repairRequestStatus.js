// Single source of truth for the repair-request delivery-status lifecycle.
// assignTechnicianToRepairRequest sets the first status (driver_assigned) unconditionally
// and isn't covered here - only updateRepairRequestStatus accepts a client-supplied
// status value, which is what needed validating.
const VALID_STATUSES = ['driver_assigned', 'rider_arriving', 'parcel_picked_up', 'parcel_delivered'];

// Technician inspection completion (Phase 6.4 Unit 4). Deliberately NOT part
// of VALID_STATUSES: that list is the set of client-settable transition
// targets updateRepairRequestStatus accepts, and inspection_completed must never be
// reachable through the generic PATCH /repair-requests/:id/status path - it is set
// only by the dedicated, atomic inspection-submission endpoint (see
// controllers/inspectionController.js). It is, however, an ACTIVE status
// below: a technician who has completed an inspection is still holding the
// request (the repair itself has not happened yet), so they must remain
// occupied and un-recommendable/un-assignable for any other request.
const INSPECTION_COMPLETED = 'inspection_completed';

// Quote workflow (Phase 6.4 Unit 5). Same design as INSPECTION_COMPLETED:
// deliberately NOT part of VALID_STATUSES (so the generic PATCH
// /repair-requests/:id/status can neither reach nor leave them - they are written
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
// /repair-requests/:id/status can never reach or leave it), reached only through the
// trusted Stripe payment-completion pipeline (services/paymentProcessor.js),
// but IS active below - a paid-but-not-yet-repaired request still occupies its
// technician, who stays busy until the repair workflow runs.
const PAYMENT_COMPLETED = 'payment_completed';

// Repair progress + completion (Phase 6.4 Unit 7). Both are set ONLY by the
// dedicated repair endpoints (controllers/repairController.js), never through
// the generic PATCH /repair-requests/:id/status path (neither is in VALID_STATUSES).
// repair_in_progress IS active - the technician is actively repairing and
// stays busy. repair_completed is the TERMINAL state for an active assignment:
// the repair is done and the technician has been released, so it is
// deliberately NOT active (it must not keep the technician occupied, and the
// generic PATCH must not be able to leave it).
const REPAIR_IN_PROGRESS = 'repair_in_progress';
const REPAIR_COMPLETED = 'repair_completed';

// Technician assignment decision (Phase 8.2). A V2 request an admin has
// offered to a technician who has NOT yet accepted. Deliberately NOT part of
// VALID_STATUSES: the generic PATCH /repair-requests/:id/status can neither set it nor
// leave it (assignment_pending has no ALLOWED_TRANSITIONS entry below, and
// driver_assigned has no inbound generic transition), so the ONLY authorities
// for the assignment_pending -> driver_assigned (accept) and assignment_pending
// -> pending-pickup (reject) transitions are the dedicated, atomic
// accept/reject endpoints. It IS active below: the offered technician is
// reserved (workStatus in_delivery) and must not be double-booked while the
// decision is pending.
const ASSIGNMENT_PENDING = 'assignment_pending';

// The subset of statuses that represent a technician actively holding a
// repair request - i.e. every status between assignment and completion,
// including inspection_completed, the quote states, payment_completed, and
// repair_in_progress. repair_completed is intentionally excluded (terminal).
// Used by assignTechnicianToRepairRequest (Phase 6.2 Unit 2) and technicianEligibilityService
// to find any request still occupying a technician's single active-assignment slot.
// quote_rejected is deliberately EXCLUDED (Phase 9.2). It used to be listed
// here, which is what stranded the technician: a declined quote is not work in
// progress, but the request still occupied the technician's single
// active-assignment slot, so they could be given nothing else while the
// customer had already walked away from this one. Excluding it frees the slot
// without unassigning anybody - technicianId/technicianEmail stay on the
// request, so the SAME technician can still revise the quote or cancel it (see
// controllers/quoteController.js's reopenForRevision / cancelAfterQuoteRejection).
//
// The trade-off is deliberate and worth naming: a technician holding a
// declined quote can now also be offered new work. That is correct - a rejected
// quote may sit indefinitely waiting on a customer who is never coming back,
// and blocking a technician on it indefinitely is the worse failure.
const ACTIVE_STATUSES = [
    ASSIGNMENT_PENDING,
    ...VALID_STATUSES.filter((status) => status !== 'parcel_delivered'),
    INSPECTION_COMPLETED, QUOTE_SUBMITTED, QUOTE_APPROVED, PAYMENT_COMPLETED, REPAIR_IN_PROGRESS
];

// Maps a repair request's current deliveryStatus to the statuses it may move to next
// via the GENERIC PATCH path. assignment_pending is present with an empty list
// so the generic path can never leave it (accept/reject endpoints own that);
// driver_assigned is never a generic target (no entry lists it as `next`), so
// the accept endpoint is the sole authority that produces it.
const ALLOWED_TRANSITIONS = {
    assignment_pending: [],
    driver_assigned: ['rider_arriving'],
    rider_arriving: ['parcel_picked_up'],
    parcel_picked_up: ['parcel_delivered'],
    parcel_delivered: []
};

function isValidTransition(currentStatus, nextStatus) {
    const allowedNext = ALLOWED_TRANSITIONS[currentStatus];
    return Array.isArray(allowedNext) && allowedNext.includes(nextStatus);
}

module.exports = { VALID_STATUSES, ACTIVE_STATUSES, ASSIGNMENT_PENDING, INSPECTION_COMPLETED, QUOTE_SUBMITTED, QUOTE_APPROVED, QUOTE_REJECTED, PAYMENT_COMPLETED, REPAIR_IN_PROGRESS, REPAIR_COMPLETED, isValidTransition };
