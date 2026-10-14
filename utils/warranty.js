// Repair warranty and returns. Pure - no database access.
//
// THE POLICY (agreed with the project owner, 2026-10-14):
//   - 30 days, counted from the moment the customer confirms they received the
//     repaired device (customerReceiptConfirmation.confirmedAt).
//   - Covers the repaired fault coming back, or a part the technician fitted
//     failing. Not new damage, water damage or a drop.
//   - The same technician re-inspects for free and decides covered / not covered.
//   - Covered: the technician repairs it again for free. If they cannot, an
//     admin refunds the repair amount (the quote total) and the technician's
//     share of that repair is taken back from their wallet.
//   - Not covered: the customer may ask an admin to review the decision within
//     7 days; the admin upholds it or overturns it (then it is covered).
//
// Claim lifecycle (status):
//   submitted -> inspection_scheduled -> covered | not_covered
//   not_covered -> review_requested -> rejected (upheld) | covered (overturned)
//   covered -> fixed_pending_confirmation -> resolved (customer: fixed)
//                                         -> refund_pending (customer: still broken)
//   covered -> refund_pending (technician: cannot fix)
//   refund_pending -> refunded (admin)
// A not_covered claim with no review asked for in 7 days is simply closed.

const { MAX_IMAGE_SIZE_BYTES, ALLOWED_IMAGE_MIME_TYPES } = require('./repairRequestV2');
const { deriveSafeExtension } = require('./damageUpload');

const DAY_MS = 24 * 60 * 60 * 1000;
const WARRANTY_DAYS = 30;
const REVIEW_WINDOW_DAYS = 7;
const MAX_CLAIMS_PER_REPAIR = 2;
const MAX_CLAIM_PHOTOS = 4;
const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 1000;
const NOTE_MAX = 500;
// A re-inspection visit must be booked within this many days.
const MAX_VISIT_AHEAD_DAYS = 14;

const CLAIM_KINDS = Object.freeze(['same_fault', 'part_failed']);
const NOT_COVERED_REASONS = Object.freeze(['new_damage', 'water_damage', 'drop_damage', 'other']);

const STATUS = Object.freeze({
    SUBMITTED: 'submitted',
    INSPECTION_SCHEDULED: 'inspection_scheduled',
    COVERED: 'covered',
    NOT_COVERED: 'not_covered',
    REVIEW_REQUESTED: 'review_requested',
    REJECTED: 'rejected',
    FIXED_PENDING_CONFIRMATION: 'fixed_pending_confirmation',
    RESOLVED: 'resolved',
    REFUND_PENDING: 'refund_pending',
    REFUNDED: 'refunded',
});
const CLAIM_STATUSES = Object.freeze(Object.values(STATUS));
const FINAL_STATUSES = Object.freeze([STATUS.REJECTED, STATUS.RESOLVED, STATUS.REFUNDED]);

function validDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
}

// { startsAt, endsAt } once the customer has confirmed receipt of a finished
// repair, otherwise null (no warranty has started).
function warrantyWindow(request) {
    const confirmation = request && request.customerReceiptConfirmation;
    if (!request || request.schemaVersion !== 2 || !request.repair || request.repair.status !== 'completed') return null;
    if (!confirmation || confirmation.status !== 'confirmed') return null;
    const startsAt = validDate(confirmation.confirmedAt);
    if (!startsAt) return null;
    return { startsAt, endsAt: new Date(startsAt.getTime() + WARRANTY_DAYS * DAY_MS) };
}

// Until when a not-covered decision can be sent to an admin, or null.
function reviewDeadline(claim) {
    const decidedAt = claim && claim.decision && validDate(claim.decision.decidedAt);
    return decidedAt ? new Date(decidedAt.getTime() + REVIEW_WINDOW_DAYS * DAY_MS) : null;
}

// Still needs someone to act: not final, and a not-covered decision only while
// its review window is open.
function isClaimOpen(claim, now) {
    if (!claim || FINAL_STATUSES.includes(claim.status)) return false;
    if (claim.status === STATUS.NOT_COVERED) {
        const deadline = reviewDeadline(claim);
        return !!deadline && now <= deadline;
    }
    return true;
}

// Can the customer open a claim on this repair now? { ok, code?, window }.
function claimEligibility(request, claims, now) {
    const window = warrantyWindow(request);
    if (!window) return { ok: false, code: 'WARRANTY_NOT_STARTED', window: null };
    if (now > window.endsAt) return { ok: false, code: 'WARRANTY_EXPIRED', window };
    if ((claims || []).some((c) => isClaimOpen(c, now))) return { ok: false, code: 'CLAIM_ALREADY_OPEN', window };
    if ((claims || []).length >= MAX_CLAIMS_PER_REPAIR) return { ok: false, code: 'CLAIM_LIMIT_REACHED', window };
    return { ok: true, window };
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNote(value, field = 'note') {
    if (value === undefined || value === null) return { valid: true, value: '' };
    if (typeof value !== 'string' || value.trim().length > NOTE_MAX) {
        return { valid: false, code: 'INVALID_NOTE', message: `${field} must be at most ${NOTE_MAX} characters` };
    }
    return { valid: true, value: value.trim() };
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Customer: { kind, description, photoIds? }.
function validateClaimInput(body) {
    if (!isPlainObject(body)) return { valid: false, code: 'INVALID_CLAIM', message: 'the claim must be an object' };
    if (!CLAIM_KINDS.includes(body.kind)) {
        return { valid: false, code: 'INVALID_CLAIM_KIND', message: `kind must be one of ${CLAIM_KINDS.join(', ')}` };
    }
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
        return { valid: false, code: 'INVALID_DESCRIPTION', message: `describe the problem in ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters` };
    }
    const photoIds = body.photoIds === undefined ? [] : body.photoIds;
    if (!Array.isArray(photoIds) || photoIds.length > MAX_CLAIM_PHOTOS || !photoIds.every((id) => typeof id === 'string' && UUID_V4_PATTERN.test(id))
        || new Set(photoIds).size !== photoIds.length) {
        return { valid: false, code: 'INVALID_PHOTOS', message: `attach at most ${MAX_CLAIM_PHOTOS} photos` };
    }
    return { valid: true, normalized: { kind: body.kind, description, photoIds } };
}

// Technician: { visitAt, note? } - a visit from now up to 14 days ahead.
function validateScheduleInput(body, now) {
    if (!isPlainObject(body)) return { valid: false, code: 'INVALID_SCHEDULE', message: 'the schedule must be an object' };
    const visitAt = validDate(body.visitAt);
    if (!visitAt || visitAt.getTime() < now.getTime() - 60 * 60 * 1000 || visitAt.getTime() > now.getTime() + MAX_VISIT_AHEAD_DAYS * DAY_MS) {
        return { valid: false, code: 'INVALID_VISIT_TIME', message: `choose a visit time within the next ${MAX_VISIT_AHEAD_DAYS} days` };
    }
    const note = optionalNote(body.note);
    if (!note.valid) return note;
    return { valid: true, normalized: { visitAt, note: note.value } };
}

// Technician after re-inspecting: { covered: true, note? } or
// { covered: false, reason, note } (a note is required to explain a refusal).
function validateDecisionInput(body) {
    if (!isPlainObject(body) || typeof body.covered !== 'boolean') {
        return { valid: false, code: 'INVALID_DECISION', message: 'say whether the claim is covered' };
    }
    const note = optionalNote(body.note);
    if (!note.valid) return note;
    if (body.covered) return { valid: true, normalized: { covered: true, reason: null, note: note.value } };
    if (!NOT_COVERED_REASONS.includes(body.reason)) {
        return { valid: false, code: 'INVALID_REASON', message: `reason must be one of ${NOT_COVERED_REASONS.join(', ')}` };
    }
    if (note.value.length < 10) return { valid: false, code: 'NOTE_REQUIRED', message: 'explain to the customer why it is not covered (at least 10 characters)' };
    return { valid: true, normalized: { covered: false, reason: body.reason, note: note.value } };
}

// Technician after the free re-repair: { outcome: 'fixed' | 'cannot_fix', note? }.
function validateRerepairInput(body) {
    if (!isPlainObject(body) || !['fixed', 'cannot_fix'].includes(body.outcome)) {
        return { valid: false, code: 'INVALID_OUTCOME', message: 'outcome must be fixed or cannot_fix' };
    }
    const note = optionalNote(body.note);
    if (!note.valid) return note;
    return { valid: true, normalized: { outcome: body.outcome, note: note.value } };
}

// Customer after a re-repair: { fixed: boolean, note? }.
function validateConfirmInput(body) {
    if (!isPlainObject(body) || typeof body.fixed !== 'boolean') {
        return { valid: false, code: 'INVALID_CONFIRMATION', message: 'say whether the device is fixed' };
    }
    const note = optionalNote(body.note);
    if (!note.valid) return note;
    return { valid: true, normalized: { fixed: body.fixed, note: note.value } };
}

// Admin review of a not-covered decision: { decision: 'uphold' | 'overturn', note }.
function validateReviewDecision(body) {
    if (!isPlainObject(body) || !['uphold', 'overturn'].includes(body.decision)) {
        return { valid: false, code: 'INVALID_REVIEW_DECISION', message: 'decision must be uphold or overturn' };
    }
    const note = optionalNote(body.note);
    if (!note.valid) return note;
    if (note.value.length < 10) return { valid: false, code: 'NOTE_REQUIRED', message: 'explain the decision (at least 10 characters)' };
    return { valid: true, normalized: { decision: body.decision, note: note.value } };
}

// What a refund gives back: the whole quote total, as the repair payment plus
// the inspection fee that was credited toward it. Each part names the Stripe
// payment it comes from. Amounts are whole taka.
function refundPlan(request) {
    const parts = [];
    const payment = request && request.payment;
    if (payment && payment.status === 'completed' && Number.isInteger(payment.amount) && payment.amount > 0 && payment.paymentIntentId) {
        parts.push({ purpose: 'repair', amount: payment.amount, paymentIntentId: payment.paymentIntentId });
    }
    const credit = payment && Number.isInteger(payment.inspectionCredit) ? payment.inspectionCredit : 0;
    const fee = request && request.inspectionPayment;
    if (credit > 0 && fee && fee.status === 'paid' && fee.sessionId) {
        parts.push({ purpose: 'inspection_fee', amount: credit, sessionId: fee.sessionId });
    }
    const total = parts.reduce((sum, p) => sum + p.amount, 0);
    return { parts, total, currency: (payment && payment.currency) || 'BDT' };
}

// Server-owned storage key for a claim photo, under its own warranty namespace.
function generateClaimPhotoStorageKey(requestId, mimeType, uploadId) {
    const extension = deriveSafeExtension(mimeType);
    return extension ? `repair-requests/${requestId}/warranty/${uploadId}.${extension}` : null;
}

module.exports = {
    WARRANTY_DAYS, REVIEW_WINDOW_DAYS, MAX_CLAIMS_PER_REPAIR, MAX_CLAIM_PHOTOS, DESCRIPTION_MIN, DESCRIPTION_MAX, NOTE_MAX,
    MAX_VISIT_AHEAD_DAYS, CLAIM_KINDS, NOT_COVERED_REASONS, STATUS, CLAIM_STATUSES, FINAL_STATUSES,
    ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_SIZE_BYTES,
    warrantyWindow, reviewDeadline, isClaimOpen, claimEligibility,
    validateClaimInput, validateScheduleInput, validateDecisionInput, validateRerepairInput, validateConfirmInput, validateReviewDecision,
    refundPlan, generateClaimPhotoStorageKey,
};
