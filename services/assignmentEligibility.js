// Mirrors the actual guarded condition assignTechnicianToRepairRequest uses to claim a
// request (see controllers/repairRequestController.js) - a request is only
// eligible for a fresh technician assignment while it is still in its
// initial, unassigned state. This is a display-only convenience flag for
// the admin request-list view; assignTechnicianToRepairRequest remains the sole
// authority on whether an assignment is actually allowed to commit.
function canAssignRequest(parcel) {
    const status = parcel.deliveryStatus || 'pending-pickup';
    if (status !== 'pending-pickup') return false;
    if (parcel.riderEmail) return false;
    return true;
}

module.exports = { canAssignRequest };
