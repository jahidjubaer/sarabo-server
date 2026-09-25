// Job portal rules (job-portal phase B). Pure: no database access.
//
// A request is OPEN in the portal while it waits for a technician (v2,
// pending-pickup, nobody assigned) and has at least one photo - technicians
// estimate from the photos. Its first photo's upload time is when it was
// published; the admin is alerted if nobody has been chosen 24 hours later.
const { isV2RepairRequest } = require('./repairRequestSchema');

const CHOOSE_WITHIN_MS = 24 * 60 * 60 * 1000;
const MAX_ESTIMATE_BDT = 100000;
const NOTE_MAX_LENGTH = 500;

const APPLICATION_STATUSES = Object.freeze(['pending', 'accepted', 'not_chosen', 'withdrawn']);

function photosOf(request) {
    return request && request.damage && Array.isArray(request.damage.images) ? request.damage.images : [];
}

function isOpenForApplications(request) {
    return isV2RepairRequest(request)
        && (request.deliveryStatus || 'pending-pickup') === 'pending-pickup'
        && !request.technicianId
        && photosOf(request).length > 0;
}

// When the request was published: its earliest photo, or null without photos.
function publishedAt(request) {
    const times = photosOf(request)
        .map((image) => (image && image.uploadedAt ? new Date(image.uploadedAt).getTime() : NaN))
        .filter((t) => Number.isFinite(t));
    return times.length ? new Date(Math.min(...times)) : null;
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
    CHOOSE_WITHIN_MS,
    MAX_ESTIMATE_BDT,
    NOTE_MAX_LENGTH,
    APPLICATION_STATUSES,
    isOpenForApplications,
    publishedAt,
    maxInspectionFee,
    validateApplicationInput,
};
