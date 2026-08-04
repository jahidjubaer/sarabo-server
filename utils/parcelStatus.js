// Single source of truth for the repair-request delivery-status lifecycle.
// assignRiderToParcel sets the first status (driver_assigned) unconditionally
// and isn't covered here - only updateParcelStatus accepts a client-supplied
// status value, which is what needed validating.
const VALID_STATUSES = ['driver_assigned', 'rider_arriving', 'parcel_picked_up', 'parcel_delivered'];

// The subset of VALID_STATUSES that represent a technician actively holding a
// repair request - i.e. every status between assignment and completion.
// Used by assignRiderToParcel (Phase 6.2 Unit 2) to find any other request
// still occupying a technician's single active-assignment slot.
const ACTIVE_STATUSES = VALID_STATUSES.filter((status) => status !== 'parcel_delivered');

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

module.exports = { VALID_STATUSES, ACTIVE_STATUSES, isValidTransition };
