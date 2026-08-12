// Pure helpers for the technician assignment-decision workflow (Phase 8.2).
// No DB access - validation + safe role projection only. The controller owns
// the transactional writes; this module keeps the rules testable in isolation.

const REJECTION_REASON_MIN = 5;
const REJECTION_REASON_MAX = 500;

// Validates a technician's rejection reason. Required, trimmed length bounded.
// Returns { valid, reason?, code?, message? }. Never trusts arbitrary decision
// fields - only the reason string is accepted.
function validateRejectionReason(raw) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        return { valid: false, code: 'INVALID_REJECTION_REASON', message: 'A rejection reason is required.' };
    }
    const reason = raw.trim();
    if (reason.length < REJECTION_REASON_MIN || reason.length > REJECTION_REASON_MAX) {
        return { valid: false, code: 'INVALID_REJECTION_REASON', message: `Rejection reason must be ${REJECTION_REASON_MIN}-${REJECTION_REASON_MAX} characters.` };
    }
    return { valid: true, reason };
}

// Builds the append-only pending history entry created when an admin offers an
// assignment. Identity is captured for the audit trail (admin-only projection);
// it is never surfaced to customers.
function buildPendingAssignmentEntry({ assignmentId, technicianId, technicianEmail, technicianName, assignedBy, assignedAt }) {
    return {
        assignmentId,
        technicianId,
        technicianEmail,
        technicianName,
        assignedBy,
        assignedAt,
        decision: 'pending',
        decidedAt: null,
        rejectionReason: null,
    };
}

// Role-aware projection of the assignment state for GET /repair-requests/:id/assignment.
// - admin: current assignment + full history (with rejection reasons + identity)
// - assigned technician: current assignment + their own decision state
// - customer/other: ONLY a neutral current-assignment view (display name if
//   present) - never rejection reasons, internal ids, or the history array.
function projectAssignmentForRole(repairRequest, role) {
    const history = Array.isArray(repairRequest?.assignmentHistory) ? repairRequest.assignmentHistory : [];
    const status = repairRequest?.deliveryStatus || 'pending-pickup';
    const current = {
        deliveryStatus: status,
        awaitingDecision: status === 'assignment_pending',
        technicianName: repairRequest?.technicianName || null,
    };

    if (role === 'admin') {
        return {
            ...current,
            technicianEmail: repairRequest?.technicianEmail || null,
            assignmentHistory: history.map((h) => ({
                assignmentId: h.assignmentId,
                technicianId: h.technicianId,
                technicianEmail: h.technicianEmail,
                technicianName: h.technicianName,
                assignedBy: h.assignedBy,
                assignedAt: h.assignedAt,
                decision: h.decision,
                decidedAt: h.decidedAt,
                rejectionReason: h.rejectionReason,
            })),
        };
    }

    if (role === 'assigned-technician') {
        // The technician sees the current offer's own state (their decision),
        // but not the admin identity or other technicians' history.
        const currentEntry = history.find((h) => h.decision === 'pending') || null;
        return {
            ...current,
            technicianEmail: repairRequest?.technicianEmail || null,
            decision: currentEntry ? currentEntry.decision : (status === 'assignment_pending' ? 'pending' : null),
        };
    }

    // customer / anyone else: neutral only.
    return current;
}

module.exports = {
    REJECTION_REASON_MIN,
    REJECTION_REASON_MAX,
    validateRejectionReason,
    buildPendingAssignmentEntry,
    projectAssignmentForRole,
};
