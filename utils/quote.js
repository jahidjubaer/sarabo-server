// Repair-quote validation, document building, decision validation, and safe
// read projection (Phase 6.4 Unit 5). Pure - no MongoDB access, no HTTP
// coupling. Structured, non-throwing { valid, code, message } results, the
// same convention as utils/inspection.js / utils/repairRequestV2.js.
//
// Business rules (locked): the quote total is ALWAYS computed server-side from
// the line items (never accepted from a client); currency is server-owned BDT;
// the customer can never alter line items; approval/rejection is a separate,
// owner-only decision; and a quote never creates any Stripe/payment state -
// payment stays blocked in this unit even after approval.

const QUOTE_CURRENCY = 'BDT';
const QUOTE_VERSION = 1;

const MAX_LINE_AMOUNT_BDT = 500000;
const NOTES_MAX = 1000;
const DECISION_REASON_MIN = 5;
const DECISION_REASON_MAX = 1000;

const DECISIONS = Object.freeze(['approve', 'reject']);

// Fields a client must never supply on quote submission - server-owned totals,
// currency, identity, status, and decision/payment state. Presence of any is a
// loud rejection (never a silent strip), so tampering is always an obvious error.
const FORBIDDEN_SUBMIT_FIELDS = [
    'totalAmount', 'total', 'currency', 'status', 'version',
    'technicianId', 'submittedByTechnicianId', 'submittedByEmail', 'submittedAt',
    'customerEmail', 'senderEmail', 'decision', 'decidedAt', 'decisionReason',
    'paymentStatus', 'stripeAmount', 'amount', 'cents',
];

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Whole-taka integer within [0, max]. Rejects NaN, Infinity, decimals,
// negatives, and any non-number (numeric string, operator object, etc.).
function isValidLineAmount(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LINE_AMOUNT_BDT;
}

function validateQuoteSubmission(body) {
    if (!isPlainObject(body)) {
        return { valid: false, code: 'INVALID_QUOTE', message: 'quote payload must be an object' };
    }

    const forbidden = FORBIDDEN_SUBMIT_FIELDS.find((f) => Object.prototype.hasOwnProperty.call(body, f));
    if (forbidden) {
        return { valid: false, code: 'INVALID_QUOTE', message: `client-supplied field "${forbidden}" is not allowed on a quote` };
    }

    if (!isValidLineAmount(body.laborAmount)) {
        return { valid: false, code: 'INVALID_QUOTE_AMOUNT', message: `laborAmount must be a whole-taka integer between 0 and ${MAX_LINE_AMOUNT_BDT}` };
    }
    if (!isValidLineAmount(body.partsAmount)) {
        return { valid: false, code: 'INVALID_QUOTE_AMOUNT', message: `partsAmount must be a whole-taka integer between 0 and ${MAX_LINE_AMOUNT_BDT}` };
    }
    // additionalCharges is optional; absent/null means 0.
    let additional = body.additionalCharges;
    if (additional === undefined || additional === null) {
        additional = 0;
    } else if (!isValidLineAmount(additional)) {
        return { valid: false, code: 'INVALID_QUOTE_AMOUNT', message: `additionalCharges must be a whole-taka integer between 0 and ${MAX_LINE_AMOUNT_BDT}` };
    }

    if (body.notes !== undefined && body.notes !== null) {
        if (typeof body.notes !== 'string' || body.notes.trim().length > NOTES_MAX) {
            return { valid: false, code: 'INVALID_QUOTE', message: `notes must be a string of at most ${NOTES_MAX} characters` };
        }
    }

    return {
        valid: true,
        normalized: {
            laborAmount: body.laborAmount,
            partsAmount: body.partsAmount,
            additionalCharges: additional,
            notes: (body.notes === undefined || body.notes === null || body.notes.trim().length === 0) ? null : body.notes.trim(),
        },
    };
}

// Builds the persisted quote sub-document from ALREADY-validated line items.
// totalAmount is computed here with integer arithmetic - never read from a
// client. currency/status/version/submittedAt/submittedByTechnicianId are all
// server-owned.
function buildQuoteDocument(normalized, { submittedByTechnicianId, now }) {
    const totalAmount = normalized.laborAmount + normalized.partsAmount + normalized.additionalCharges;
    return {
        status: 'submitted',
        laborAmount: normalized.laborAmount,
        partsAmount: normalized.partsAmount,
        additionalCharges: normalized.additionalCharges,
        totalAmount,
        currency: QUOTE_CURRENCY,
        notes: normalized.notes,
        submittedAt: now,
        submittedByTechnicianId,
        decidedAt: null,
        decisionReason: null,
        version: QUOTE_VERSION,
    };
}

// Validates a customer decision. `reason` is required (and length-bounded) for
// a rejection, optional for an approval.
function validateQuoteDecision(body) {
    if (!isPlainObject(body)) {
        return { valid: false, code: 'INVALID_QUOTE_DECISION', message: 'decision payload must be an object' };
    }
    if (!DECISIONS.includes(body.decision)) {
        return { valid: false, code: 'INVALID_QUOTE_DECISION', message: `decision must be one of: ${DECISIONS.join(', ')}` };
    }
    const hasReason = body.reason !== undefined && body.reason !== null;
    if (body.decision === 'reject') {
        if (!hasReason || typeof body.reason !== 'string' || body.reason.trim().length < DECISION_REASON_MIN || body.reason.trim().length > DECISION_REASON_MAX) {
            return { valid: false, code: 'QUOTE_REJECTION_REASON_REQUIRED', message: `a rejection reason of ${DECISION_REASON_MIN}-${DECISION_REASON_MAX} characters is required` };
        }
    } else if (hasReason) {
        if (typeof body.reason !== 'string' || body.reason.trim().length > DECISION_REASON_MAX) {
            return { valid: false, code: 'INVALID_QUOTE_DECISION', message: `reason must be a string of at most ${DECISION_REASON_MAX} characters` };
        }
    }
    return {
        valid: true,
        normalized: {
            decision: body.decision,
            reason: hasReason && body.reason.trim().length > 0 ? body.reason.trim() : null,
        },
    };
}

// Customer/admin/technician-safe read view - includes every business field but
// never the internal submitter identity (submittedByTechnicianId).
function buildQuoteView(quote) {
    if (!quote || !quote.status) {
        return { status: 'not_submitted' };
    }
    return {
        status: quote.status,
        laborAmount: quote.laborAmount,
        partsAmount: quote.partsAmount,
        additionalCharges: quote.additionalCharges,
        totalAmount: quote.totalAmount,
        currency: quote.currency,
        notes: quote.notes ?? null,
        submittedAt: quote.submittedAt,
        decidedAt: quote.decidedAt ?? null,
        decisionReason: quote.decisionReason ?? null,
        version: quote.version,
    };
}

module.exports = {
    QUOTE_CURRENCY,
    QUOTE_VERSION,
    MAX_LINE_AMOUNT_BDT,
    NOTES_MAX,
    DECISION_REASON_MIN,
    DECISION_REASON_MAX,
    DECISIONS,
    FORBIDDEN_SUBMIT_FIELDS,
    validateQuoteSubmission,
    buildQuoteDocument,
    validateQuoteDecision,
    buildQuoteView,
};
