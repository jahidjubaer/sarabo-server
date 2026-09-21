const { ObjectId } = require('mongodb');
const { CURRENT_REPAIR_REQUEST_SCHEMA_VERSION } = require('./repairRequestSchema');

const REPORT_REASONS = Object.freeze(['unprofessional_behavior', 'suspected_fraud', 'device_damage', 'missing_item', 'harassment', 'safety_concern', 'payment_issue', 'repair_dispute', 'other']);
const REPORT_TRANSITIONS = Object.freeze({ open: ['under_review', 'dismissed'], under_review: ['resolved', 'dismissed'], resolved: [], dismissed: [] });
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const validDate = value => value instanceof Date && Number.isFinite(value.getTime());

class FeedbackError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

function fail(message = 'Invalid feedback input.') {
    throw new FeedbackError('FEEDBACK_VALIDATION_ERROR', message);
}

function fields(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail();
}

function text(value, minimum, maximum) {
    if (typeof value !== 'string') fail();
    const result = value.trim();
    if (result.length < minimum || result.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result) || /<\/?[a-z!][^>]*>/i.test(result)) fail('Text must be plain text within the permitted length.');
    return result;
}

function version(value) {
    if (!Number.isSafeInteger(value) || value < 1) fail('A valid expectedVersion is required.');
    return value;
}

function validateReview(body) {
    fields(body, ['rating', 'comment']);
    if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) fail('Rating must be an integer from 1 to 5.');
    return { rating: body.rating, comment: body.comment === undefined ? null : text(body.comment, 0, 1000) || null };
}

function validateReport(body) {
    fields(body, ['reason', 'description', 'assignmentId']);
    if (!REPORT_REASONS.includes(body.reason)) fail('Select a valid report reason.');
    if (body.assignmentId !== undefined && !validId(body.assignmentId)) fail('Invalid assignment reference.');
    return { reason: body.reason, description: text(body.description, 20, 2000), assignmentId: body.assignmentId };
}

function validateVisibility(body) {
    fields(body, ['visibility', 'reason', 'expectedVersion']);
    if (!['visible', 'hidden'].includes(body.visibility)) fail();
    return { visibility: body.visibility, reason: text(body.reason, 1, 1000), expectedVersion: version(body.expectedVersion) };
}

function validateStatus(body) {
    fields(body, ['status', 'expectedVersion', 'explanation']);
    if (!Object.hasOwn(REPORT_TRANSITIONS, body.status)) fail();
    const terminal = ['resolved', 'dismissed'].includes(body.status);
    return { status: body.status, expectedVersion: version(body.expectedVersion), explanation: terminal ? text(body.explanation, 1, 1000) : body.explanation === undefined ? null : text(body.explanation, 1, 1000) };
}

function validateNote(body) {
    fields(body, ['text', 'expectedVersion']);
    return { text: text(body.text, 1, 1000), expectedVersion: version(body.expectedVersion) };
}

function validateList(query, kind) {
    const filterKey = kind === 'review' ? 'visibility' : kind === 'report' ? 'status' : null;
    fields(query, ['page', 'limit', ...(filterKey ? [filterKey, 'technicianId'] : [])]);
    const parse = (value, fallback, maximum) => {
        if (value === undefined) return fallback;
        if (typeof value !== 'string' || !/^[1-9]\d{0,5}$/.test(value) || Number(value) > maximum) fail('Invalid pagination.');
        return Number(value);
    };
    const page = parse(query.page, 1, 100000);
    const limit = parse(query.limit, 20, 50);
    const filter = {};
    if (query.technicianId !== undefined) {
        if (!validId(query.technicianId)) fail('Invalid technician filter.');
        filter.technicianId = query.technicianId;
    }
    if (filterKey && query[filterKey] !== undefined) {
        const allowed = kind === 'review' ? ['visible', 'hidden'] : Object.keys(REPORT_TRANSITIONS);
        if (!allowed.includes(query[filterKey])) fail('Invalid filter.');
        filter[filterKey] = query[filterKey];
    }
    return { page, limit, filter };
}

function assignmentTargets(repair) {
    const history = repair.assignmentHistory;
    if (history !== undefined && !Array.isArray(history)) return [];
    if (history?.length) {
        return history.filter(entry => entry && validId(entry.assignmentId) && validId(entry.technicianId) && validDate(entry.assignedAt) && ['pending', 'accepted', 'rejected'].includes(entry.decision))
            .map(entry => ({ assignmentId: entry.assignmentId, technicianId: entry.technicianId, email: normalizeEmail(entry.technicianEmail), name: typeof entry.technicianName === 'string' ? entry.technicianName : 'Assigned technician', decision: entry.decision }));
    }
    return validId(repair.technicianId) && normalizeEmail(repair.technicianEmail)
        ? [{ assignmentId: null, technicianId: repair.technicianId, email: normalizeEmail(repair.technicianEmail), name: typeof repair.technicianName === 'string' ? repair.technicianName : 'Assigned technician', decision: null }]
        : [];
}

function reviewTarget(repair) {
    if (repair.schemaVersion !== CURRENT_REPAIR_REQUEST_SCHEMA_VERSION || repair.deliveryStatus !== 'parcel_delivered' || repair.repair?.status !== 'completed' || !validDate(repair.repair?.completion?.completedAt) || repair.customerReceiptConfirmation?.status !== 'confirmed' || !validDate(repair.customerReceiptConfirmation?.confirmedAt) || normalizeEmail(repair.customerReceiptConfirmation.confirmedBy) !== normalizeEmail(repair.senderEmail)) return null;
    // Modern reviews require the final recorded offer to be accepted. Never
    // fall back to an earlier accepted offer or a legacy current-ID snapshot.
    const lastEntry = Array.isArray(repair.assignmentHistory) ? repair.assignmentHistory.at(-1) : null;
    if (!lastEntry || lastEntry.decision !== 'accepted' || !validDate(lastEntry.decidedAt)) return null;
    const targets = assignmentTargets(repair);
    const final = targets.at(-1);
    if (!final || final.assignmentId !== lastEntry.assignmentId || final.technicianId !== repair.technicianId || final.email !== normalizeEmail(repair.technicianEmail)) return null;
    return final;
}

function projectReview(document, audience = 'customer') {
    if (!document) return null;
    const result = { _id: document._id.toString(), rating: document.rating, comment: document.comment, createdAt: document.createdAt, verifiedRepair: true };
    if (audience === 'technician') return { ...result, reviewerLabel: 'Verified customer' };
    return { ...result, visibility: document.visibility, updatedAt: document.updatedAt, ...(audience === 'admin' ? {
        repairRequestId: document.repairRequestId, customerId: document.customerId, technicianId: document.technicianId, version: document.version,
        moderationHistory: (document.moderationHistory || []).map(entry => ({ visibility: entry.visibility, reason: entry.reason, adminId: entry.adminId, createdAt: entry.createdAt })),
    } : {}) };
}

function projectReport(document, admin = false) {
    const result = { _id: document._id.toString(), reason: document.reason, status: document.status, createdAt: document.createdAt, updatedAt: document.updatedAt, closedAt: document.closedAt };
    return admin ? { ...result, repairRequestId: document.repairRequestId, customerId: document.customerId, technicianId: document.technicianId, assignmentId: document.assignmentId, description: document.description, version: document.version, closedBy: document.closedBy,
        adminNotes: (document.adminNotes || []).map(note => ({ text: note.text, adminId: note.adminId, createdAt: note.createdAt })),
        statusHistory: (document.statusHistory || []).map(entry => ({ from: entry.from, to: entry.to, adminId: entry.adminId, createdAt: entry.createdAt })),
    } : result;
}

function objectId(value) {
    if (!validId(value)) fail('Invalid reference.');
    return new ObjectId(value);
}

module.exports = { FeedbackError, REPORT_REASONS, REPORT_TRANSITIONS, normalizeEmail, validId, objectId, validateReview, validateReport, validateVisibility, validateStatus, validateNote, validateList, assignmentTargets, reviewTarget, projectReview, projectReport };
