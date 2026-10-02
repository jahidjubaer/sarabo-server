// Job portal rules (job-portal phase B). Pure: no database access.
//
// A request is OPEN in the portal while it waits for a technician (v2,
// pending-pickup, nobody assigned). Photos are optional when the customer
// creates a request, so a request is listed from the moment it is created;
// its creation time is when it was published. When the customer rejects an offer the request is reposted
// (repostedAt); the admin is alerted only if no technician has an offer
// waiting 24 hours after it was last posted.
const { isV2RepairRequest } = require('./repairRequestSchema');

const CHOOSE_WITHIN_MS = 24 * 60 * 60 * 1000;
const MAX_ESTIMATE_BDT = 100000;
const NOTE_MAX_LENGTH = 500;
const DECLINE_REASON_MAX_LENGTH = 300;
const DECLINE_REASONS = Object.freeze(['price', 'inspection_fee', 'other']);

const APPLICATION_STATUSES = Object.freeze(['pending', 'accepted', 'not_chosen', 'withdrawn', 'no_show', 'declined']);

function photosOf(request) {
    return request && request.damage && Array.isArray(request.damage.images) ? request.damage.images : [];
}

// The database form of isOpenForApplications (keep the two in step).
const OPEN_REQUEST_FILTER = Object.freeze({
    schemaVersion: 2, deliveryStatus: 'pending-pickup', technicianId: { $exists: false },
});

function isOpenForApplications(request) {
    return isV2RepairRequest(request)
        && (request.deliveryStatus || 'pending-pickup') === 'pending-pickup'
        && !request.technicianId;
}

// When the request was published: its creation time (older rows without one
// fall back to their earliest photo), or null.
function publishedAt(request) {
    const created = request && request.createdAt ? new Date(request.createdAt) : null;
    if (created && Number.isFinite(created.getTime())) return created;
    const times = photosOf(request)
        .map((image) => (image && image.uploadedAt ? new Date(image.uploadedAt).getTime() : NaN))
        .filter((t) => Number.isFinite(t));
    return times.length ? new Date(Math.min(...times)) : null;
}

// When the request was last put in front of technicians: its latest repost,
// or when it was published.
function lastPostedAt(request) {
    const published = publishedAt(request);
    const reposted = request && request.repostedAt ? new Date(request.repostedAt) : null;
    if (reposted && Number.isFinite(reposted.getTime()) && (!published || reposted > published)) return reposted;
    return published;
}

// A technician may send one revised offer after the customer rejects theirs.
function canReoffer(application) {
    return !!application && application.status === 'declined' && !application.revisedAfterDecline;
}

// { valid, normalized: { reason, note } } or { valid: false, code, message }.
function validateDeclineInput(body) {
    const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {};
    const reason = input.reason === undefined || input.reason === null ? 'price' : input.reason;
    if (!DECLINE_REASONS.includes(reason)) {
        return { valid: false, code: 'INVALID_DECLINE_REASON', message: `the reason must be one of ${DECLINE_REASONS.join(', ')}` };
    }
    const note = input.note === undefined || input.note === null ? '' : input.note;
    if (typeof note !== 'string' || note.trim().length > DECLINE_REASON_MAX_LENGTH) {
        return { valid: false, code: 'INVALID_NOTE', message: `the note must be at most ${DECLINE_REASON_MAX_LENGTH} characters` };
    }
    return { valid: true, normalized: { reason, note: note.trim() } };
}

// The most a technician may charge for the visit: the service's inspection fee
// as priced when the request was made (admins set it in Services & prices).
function maxInspectionFee(request) {
    const fee = request && request.pricing ? Number(request.pricing.inspectionFee) : 0;
    return Number.isFinite(fee) && fee > 0 ? Math.floor(fee) : 0;
}

function isWholeAmount(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
}

// { valid, normalized } or { valid: false, code, message }.
function validateApplicationInput(body, { maxFee }) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { valid: false, code: 'INVALID_APPLICATION', message: 'application must be an object' };
    }
    const { estimateMin, estimateMax, inspectionFee } = body;
    if (!isWholeAmount(estimateMin, 1, MAX_ESTIMATE_BDT) || !isWholeAmount(estimateMax, 1, MAX_ESTIMATE_BDT)) {
        return { valid: false, code: 'INVALID_ESTIMATE', message: `the estimate must be whole taka from 1 to ${MAX_ESTIMATE_BDT}` };
    }
    if (estimateMin > estimateMax) {
        return { valid: false, code: 'INVALID_ESTIMATE', message: 'the lowest estimate cannot be above the highest' };
    }
    if (!isWholeAmount(inspectionFee, 0, maxFee)) {
        return { valid: false, code: 'INSPECTION_FEE_TOO_HIGH', message: `the inspection fee must be whole taka from 0 to ${maxFee}` };
    }
    const note = body.note === undefined || body.note === null ? '' : body.note;
    if (typeof note !== 'string' || note.trim().length > NOTE_MAX_LENGTH) {
        return { valid: false, code: 'INVALID_NOTE', message: `the note must be at most ${NOTE_MAX_LENGTH} characters` };
    }
    return { valid: true, normalized: { estimateMin, estimateMax, inspectionFee, note: note.trim() } };
}

module.exports = {
    OPEN_REQUEST_FILTER,
    CHOOSE_WITHIN_MS,
    MAX_ESTIMATE_BDT,
    NOTE_MAX_LENGTH,
    DECLINE_REASONS,
    APPLICATION_STATUSES,
    isOpenForApplications,
    publishedAt,
    lastPostedAt,
    canReoffer,
    maxInspectionFee,
    validateApplicationInput,
    validateDeclineInput,
};
