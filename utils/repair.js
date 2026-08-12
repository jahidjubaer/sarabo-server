// Repair workflow validation, document building, and safe read projection
// (Phase 6.4 Unit 7). Pure - no MongoDB, no HTTP, no storage I/O. Structured,
// non-throwing { valid, code, message } results, the same convention as
// utils/inspection.js / utils/quote.js.
//
// Locked rules: the technician owns progress updates and the completion
// summary/evidence; every server-generated field (ids, timestamps, rider
// identity) is built here, never accepted from a client. This module never
// touches payment, quote, or pricing state.

const crypto = require('crypto');
const { MIN_EVIDENCE_IMAGES, MAX_EVIDENCE_IMAGES, isValidEvidenceId } = require('./repairEvidence');

const REPAIR_VERSION = 1;

const PROGRESS_MESSAGE_MIN = 5;
const PROGRESS_MESSAGE_MAX = 500;
const MAX_PROGRESS_UPDATES = 50;

const COMPLETION_SUMMARY_MIN = 10;
const COMPLETION_SUMMARY_MAX = 2000;

// Fields a client must never supply. Their presence is a loud rejection (never
// a silent strip), so any attempt to forge an id/timestamp/identity/status is
// an obvious error rather than quietly ignored.
const FORBIDDEN_PROGRESS_FIELDS = ['id', 'createdAt', 'createdByRiderId', 'technicianId', 'status', 'version'];
const FORBIDDEN_COMPLETE_FIELDS = ['status', 'completedAt', 'completedByRiderId', 'evidenceImages', 'evidence', 'startedAt', 'progressUpdates', 'version'];

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmedLength(str) {
    return typeof str === 'string' ? str.trim().length : -1;
}

// The empty repair sub-document a v2 request carries once repair work starts.
function buildInitialRepair(now) {
    return {
        status: 'in_progress',
        startedAt: now,
        progressUpdates: [],
        completion: null,
        version: REPAIR_VERSION,
    };
}

function validateProgressInput(body) {
    if (!isPlainObject(body)) {
        return { valid: false, code: 'INVALID_PROGRESS', message: 'progress payload must be an object' };
    }
    const forbidden = FORBIDDEN_PROGRESS_FIELDS.find((f) => Object.prototype.hasOwnProperty.call(body, f));
    if (forbidden) {
        return { valid: false, code: 'INVALID_PROGRESS', message: `client-supplied field "${forbidden}" is not allowed on a progress update` };
    }
    const len = trimmedLength(body.message);
    if (typeof body.message !== 'string' || len < PROGRESS_MESSAGE_MIN || len > PROGRESS_MESSAGE_MAX) {
        return { valid: false, code: 'INVALID_PROGRESS_MESSAGE', message: `message must be ${PROGRESS_MESSAGE_MIN}-${PROGRESS_MESSAGE_MAX} characters` };
    }
    return { valid: true, normalized: { message: body.message.trim() } };
}

// Builds a single progress update from an already-validated message. The id and
// timestamp are always server-generated; the rider identity is passed in from
// the trusted parcel.technicianId, never from the client.
function buildProgressUpdate(normalized, { createdByRiderId, now }) {
    return {
        id: crypto.randomUUID(),
        message: normalized.message,
        createdAt: now,
        createdByRiderId,
    };
}

function validateCompletionInput(body) {
    if (!isPlainObject(body)) {
        return { valid: false, code: 'INVALID_COMPLETION', message: 'completion payload must be an object' };
    }
    const forbidden = FORBIDDEN_COMPLETE_FIELDS.find((f) => Object.prototype.hasOwnProperty.call(body, f));
    if (forbidden) {
        return { valid: false, code: 'INVALID_COMPLETION', message: `client-supplied field "${forbidden}" is not allowed on completion` };
    }
    const len = trimmedLength(body.summary);
    if (typeof body.summary !== 'string' || len < COMPLETION_SUMMARY_MIN || len > COMPLETION_SUMMARY_MAX) {
        return { valid: false, code: 'INVALID_COMPLETION_SUMMARY', message: `summary must be ${COMPLETION_SUMMARY_MIN}-${COMPLETION_SUMMARY_MAX} characters` };
    }

    const ids = body.evidenceImageIds;
    if (!Array.isArray(ids) || ids.length < MIN_EVIDENCE_IMAGES || ids.length > MAX_EVIDENCE_IMAGES) {
        return { valid: false, code: 'INVALID_COMPLETION_EVIDENCE', message: `evidenceImageIds must contain ${MIN_EVIDENCE_IMAGES}-${MAX_EVIDENCE_IMAGES} image ids` };
    }
    if (!ids.every(isValidEvidenceId)) {
        return { valid: false, code: 'INVALID_COMPLETION_EVIDENCE', message: 'evidenceImageIds must all be valid image ids' };
    }
    if (new Set(ids).size !== ids.length) {
        return { valid: false, code: 'INVALID_COMPLETION_EVIDENCE', message: 'evidenceImageIds must be unique' };
    }

    return { valid: true, normalized: { summary: body.summary.trim(), evidenceImageIds: [...ids] } };
}

// Customer/technician/admin-safe read view. Never exposes any rider identity
// (createdByRiderId on updates, completion's internal ids), storageKey, or
// upload-session id. The completion's evidence images are returned WITHOUT
// urls here - the controller adds short-lived signed read urls, since those
// require async storage access.
function buildRepairView(repair) {
    if (!repair || !repair.status) {
        return { status: 'not_started', startedAt: null, progressUpdates: [], completion: null, version: REPAIR_VERSION };
    }
    const progressUpdates = Array.isArray(repair.progressUpdates)
        ? repair.progressUpdates.map((u) => ({ id: u.id, message: u.message, createdAt: u.createdAt }))
        : [];
    let completion = null;
    if (repair.completion) {
        completion = {
            summary: repair.completion.summary,
            completedAt: repair.completion.completedAt,
            evidenceImages: Array.isArray(repair.completion.evidenceImages)
                ? repair.completion.evidenceImages.map((e) => ({ imageId: e.imageId, mimeType: e.mimeType, size: e.size }))
                : [],
        };
    }
    return {
        status: repair.status,
        startedAt: repair.startedAt || null,
        progressUpdates,
        completion,
        version: repair.version || REPAIR_VERSION,
    };
}

module.exports = {
    REPAIR_VERSION,
    PROGRESS_MESSAGE_MIN,
    PROGRESS_MESSAGE_MAX,
    MAX_PROGRESS_UPDATES,
    COMPLETION_SUMMARY_MIN,
    COMPLETION_SUMMARY_MAX,
    MIN_EVIDENCE_IMAGES,
    MAX_EVIDENCE_IMAGES,
    FORBIDDEN_PROGRESS_FIELDS,
    FORBIDDEN_COMPLETE_FIELDS,
    buildInitialRepair,
    validateProgressInput,
    buildProgressUpdate,
    validateCompletionInput,
    buildRepairView,
};
