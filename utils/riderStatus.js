// Single source of truth for the technician-application status lifecycle.
// Only 'approved' and 'rejected' are ever valid admin-requested targets -
// nothing in the current product resets an application back to 'pending'
// (there is no such workflow), so 'pending' only ever appears below as a
// starting state, never as a requested target.
const RECOGNIZED_STATUSES = ['pending', 'approved', 'rejected'];
const REQUESTABLE_STATUSES = ['approved', 'rejected'];

// Maps a technician application's current status to the statuses an admin
// may move it to next. Re-approval and re-rejection are both already
// supported by the existing admin UI (ApproveTechnicians.jsx shows an
// Approve action whenever status !== 'approved', and a Reject action
// whenever status !== 'rejected') - preserved here, not invented.
const ALLOWED_TRANSITIONS = {
    pending: ['approved', 'rejected'],
    approved: ['rejected'],
    rejected: ['approved']
};

// The users.role every technician-application status corresponds to.
const ROLE_FOR_STATUS = {
    pending: 'user',
    approved: 'rider',
    rejected: 'user'
};

function isValidRiderTransition(currentStatus, nextStatus) {
    const allowedNext = ALLOWED_TRANSITIONS[currentStatus];
    return Array.isArray(allowedNext) && allowedNext.includes(nextStatus);
}

module.exports = { RECOGNIZED_STATUSES, REQUESTABLE_STATUSES, ROLE_FOR_STATUS, isValidRiderTransition };
