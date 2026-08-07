// Technician inspection validation, document building, and safe read
// projection (Phase 6.4 Unit 4). Pure - no MongoDB access, no HTTP coupling.
// Mirrors the structured, non-throwing { valid, code, message } convention
// used by utils/repairRequestV2.js and models/ServiceDefinition.js.
//
// Business rule (locked): an inspection is a technician's assessment, NOT a
// quote and NOT a payment. It carries a preliminary labor/parts estimate in
// BDT but never a payable amount, never customer approval, and never touches
// the request's own server-owned pricing snapshot. The currency is always
// BDT and is server-owned - a client-supplied currency is never read.

const INSPECTION_CURRENCY = 'BDT';
const INSPECTION_VERSION = 1;

const DIAGNOSIS_SUMMARY_MIN = 10;
const DIAGNOSIS_SUMMARY_MAX = 2000;
const ISSUE_LABEL_MIN = 2;
const ISSUE_LABEL_MAX = 150;
const ISSUE_NOTES_MAX = 500;
const ISSUE_CODE_MAX = 60;
const MIN_DETECTED_ISSUES = 1;
const MAX_DETECTED_ISSUES = 10;
const REASON_MIN = 10;
const REASON_MAX = 1000;
const INTERNAL_NOTES_MAX = 2000;
const MAX_ESTIMATE_BDT = 500000;

const SEVERITIES = Object.freeze(['minor', 'moderate', 'major', 'critical']);
const REPAIRABILITY_DECISIONS = Object.freeze(['repairable', 'repairable_with_parts', 'not_economical', 'not_repairable']);

// Fields the persisted inspection document may ever contain, rebuilt
// field-by-field in buildInspectionDocument below - the raw request body is
// never spread, so no unexpected/injected key (a MongoDB operator smuggled in
// through a crafted field name, or a would-be authority field like
// approvedAmount/payableAmount/quoteStatus/status) can ever reach the
// database, regardless of what else the body contains.

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrimmedStringInRange(value, min, max) {
    if (typeof value !== 'string') return false;
    const len = value.trim().length;
    return len >= min && len <= max;
}

// Integer, finite, within [0, max]. Rejects NaN, Infinity, decimals,
// negatives, and any non-number (including a numeric string like "50" or an
// operator object) - technician estimates are whole taka only.
function isValidEstimateAmount(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ESTIMATE_BDT;
}

// Normalizes an optional issue `code` to a safe lowercase slug, or null.
// Never stores an arbitrary caller string verbatim, so it can never carry a
// MongoDB operator or unexpected structure downstream.
function normalizeIssueCode(code) {
    if (code === undefined || code === null) return { valid: true, value: null };
    if (typeof code !== 'string') return { valid: false };
    const trimmed = code.trim();
    if (trimmed.length === 0) return { valid: true, value: null };
    if (trimmed.length > ISSUE_CODE_MAX) return { valid: false };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed)) return { valid: false };
    return { valid: true, value: trimmed.toLowerCase() };
}

function validateDetectedIssue(issue) {
    if (!isPlainObject(issue)) {
        return { valid: false, code: 'INVALID_DETECTED_ISSUES', message: 'each detected issue must be an object' };
    }
    if (!isTrimmedStringInRange(issue.label, ISSUE_LABEL_MIN, ISSUE_LABEL_MAX)) {
        return { valid: false, code: 'INVALID_DETECTED_ISSUES', message: `each issue label must be ${ISSUE_LABEL_MIN}-${ISSUE_LABEL_MAX} characters` };
    }
    if (!SEVERITIES.includes(issue.severity)) {
        return { valid: false, code: 'INVALID_DETECTED_ISSUES', message: `each issue severity must be one of: ${SEVERITIES.join(', ')}` };
    }
    if (issue.notes !== undefined && issue.notes !== null) {
        if (typeof issue.notes !== 'string' || issue.notes.trim().length > ISSUE_NOTES_MAX) {
            return { valid: false, code: 'INVALID_DETECTED_ISSUES', message: `issue notes must be a string of at most ${ISSUE_NOTES_MAX} characters` };
        }
    }
    const codeResult = normalizeIssueCode(issue.code);
    if (!codeResult.valid) {
        return { valid: false, code: 'INVALID_DETECTED_ISSUES', message: 'issue code must be a safe slug (letters, numbers, - and _) or omitted' };
    }
    return { valid: true, normalizedCode: codeResult.value };
}

// Full inspection payload validation. Returns { valid: true, normalized }
// where `normalized` carries the cleaned/normalized issue codes, or
// { valid: false, code, message }. Never throws on malformed input.
function validateInspectionInput(body) {
    if (!isPlainObject(body)) {
        return { valid: false, code: 'INVALID_INSPECTION', message: 'inspection payload must be an object' };
    }

    // ---- diagnosis ----
    const diagnosis = body.diagnosis;
    if (!isPlainObject(diagnosis)) {
        return { valid: false, code: 'INVALID_DIAGNOSIS', message: 'diagnosis must be an object' };
    }
    if (!isTrimmedStringInRange(diagnosis.summary, DIAGNOSIS_SUMMARY_MIN, DIAGNOSIS_SUMMARY_MAX)) {
        return { valid: false, code: 'INVALID_DIAGNOSIS', message: `diagnosis summary must be ${DIAGNOSIS_SUMMARY_MIN}-${DIAGNOSIS_SUMMARY_MAX} characters` };
    }

    const issues = diagnosis.detectedIssues;
    if (!Array.isArray(issues)) {
        return { valid: false, code: 'INVALID_DETECTED_ISSUES', message: 'detectedIssues must be an array' };
    }
    if (issues.length < MIN_DETECTED_ISSUES) {
        return { valid: false, code: 'INVALID_DETECTED_ISSUES', message: `at least ${MIN_DETECTED_ISSUES} detected issue is required` };
    }
    if (issues.length > MAX_DETECTED_ISSUES) {
        return { valid: false, code: 'INVALID_DETECTED_ISSUES', message: `at most ${MAX_DETECTED_ISSUES} detected issues are allowed` };
    }
    const normalizedIssues = [];
    for (const issue of issues) {
        const result = validateDetectedIssue(issue);
        if (!result.valid) return result;
        normalizedIssues.push({
            code: result.normalizedCode,
            label: issue.label.trim(),
            severity: issue.severity,
            notes: (issue.notes === undefined || issue.notes === null || issue.notes.trim().length === 0) ? null : issue.notes.trim()
        });
    }

    // ---- repairability ----
    const repairability = body.repairability;
    if (!isPlainObject(repairability)) {
        return { valid: false, code: 'INVALID_REPAIRABILITY', message: 'repairability must be an object' };
    }
    if (!REPAIRABILITY_DECISIONS.includes(repairability.decision)) {
        return { valid: false, code: 'INVALID_REPAIRABILITY', message: `repairability decision must be one of: ${REPAIRABILITY_DECISIONS.join(', ')}` };
    }
    if (!isTrimmedStringInRange(repairability.reason, REASON_MIN, REASON_MAX)) {
        return { valid: false, code: 'INVALID_REPAIRABILITY', message: `repairability reason must be ${REASON_MIN}-${REASON_MAX} characters` };
    }

    // ---- estimate (technician finding only, never a quote) ----
    const estimate = body.estimate;
    if (!isPlainObject(estimate)) {
        return { valid: false, code: 'INVALID_INSPECTION_ESTIMATE', message: 'estimate must be an object' };
    }
    // currency is server-owned - a client-supplied currency other than BDT is
    // rejected outright rather than silently ignored, so tampering is loud.
    if (estimate.currency !== undefined && estimate.currency !== INSPECTION_CURRENCY) {
        return { valid: false, code: 'INVALID_INSPECTION_ESTIMATE', message: `estimate currency, if provided, must be "${INSPECTION_CURRENCY}"` };
    }
    const labor = estimate.laborEstimate;
    if (labor !== undefined && labor !== null && !isValidEstimateAmount(labor)) {
        return { valid: false, code: 'INVALID_INSPECTION_ESTIMATE', message: `laborEstimate must be a whole-taka integer between 0 and ${MAX_ESTIMATE_BDT}, or null` };
    }
    const parts = estimate.partsEstimate;
    if (parts !== undefined && parts !== null && !isValidEstimateAmount(parts)) {
        return { valid: false, code: 'INVALID_INSPECTION_ESTIMATE', message: `partsEstimate must be a whole-taka integer between 0 and ${MAX_ESTIMATE_BDT}, or null` };
    }

    // ---- internal notes (optional) ----
    const internalNotes = body.internalNotes;
    if (internalNotes !== undefined && internalNotes !== null) {
        if (typeof internalNotes !== 'string' || internalNotes.trim().length > INTERNAL_NOTES_MAX) {
            return { valid: false, code: 'INVALID_INSPECTION', message: `internalNotes must be a string of at most ${INTERNAL_NOTES_MAX} characters` };
        }
    }

    return {
        valid: true,
        normalized: {
            diagnosisSummary: diagnosis.summary.trim(),
            detectedIssues: normalizedIssues,
            repairabilityDecision: repairability.decision,
            repairabilityReason: repairability.reason.trim(),
            laborEstimate: (labor === undefined || labor === null) ? null : labor,
            partsEstimate: (parts === undefined || parts === null) ? null : parts,
            internalNotes: (internalNotes === undefined || internalNotes === null || internalNotes.trim().length === 0) ? null : internalNotes.trim()
        }
    };
}

// Builds the persisted inspection sub-document from ALREADY-validated,
// normalized input plus server-owned identity fields. Every authority field
// (status, submittedAt, submittedByRiderId, submittedByEmail, version,
// currency) is set here by the server, never copied from the client.
function buildInspectionDocument(normalized, { submittedByRiderId, submittedByEmail, now }) {
    return {
        status: 'submitted',
        diagnosis: {
            summary: normalized.diagnosisSummary,
            detectedIssues: normalized.detectedIssues.map((issue) => ({
                code: issue.code,
                label: issue.label,
                severity: issue.severity,
                notes: issue.notes
            }))
        },
        repairability: {
            decision: normalized.repairabilityDecision,
            reason: normalized.repairabilityReason
        },
        estimate: {
            laborEstimate: normalized.laborEstimate,
            partsEstimate: normalized.partsEstimate,
            currency: INSPECTION_CURRENCY
        },
        internalNotes: normalized.internalNotes,
        submittedAt: now,
        submittedByRiderId,
        submittedByEmail,
        version: INSPECTION_VERSION
    };
}

// The default "not started" shape returned for a v2 request that has no
// inspection yet - never exposes any internal identifier.
function emptyInspectionView() {
    return { status: 'not_started', diagnosis: null, repairability: null, estimate: null, submittedAt: null, version: null };
}

// Role-projected read view. Customer/owner and anyone else authorized to read
// gets the assessment but never internalNotes, submittedByEmail, or
// submittedByRiderId. Only admins and the assigned technician additionally
// receive internalNotes. No internal identifier (submittedByEmail/RiderId) is
// ever returned to anyone through this view.
function buildInspectionView(inspection, { includeInternalNotes }) {
    if (!inspection || inspection.status !== 'submitted') {
        return emptyInspectionView();
    }
    const view = {
        status: inspection.status,
        diagnosis: inspection.diagnosis,
        repairability: inspection.repairability,
        estimate: inspection.estimate,
        submittedAt: inspection.submittedAt,
        version: inspection.version
    };
    if (includeInternalNotes) {
        view.internalNotes = inspection.internalNotes ?? null;
    }
    return view;
}

module.exports = {
    INSPECTION_CURRENCY,
    INSPECTION_VERSION,
    DIAGNOSIS_SUMMARY_MIN,
    DIAGNOSIS_SUMMARY_MAX,
    ISSUE_LABEL_MIN,
    ISSUE_LABEL_MAX,
    ISSUE_NOTES_MAX,
    MIN_DETECTED_ISSUES,
    MAX_DETECTED_ISSUES,
    REASON_MIN,
    REASON_MAX,
    INTERNAL_NOTES_MAX,
    MAX_ESTIMATE_BDT,
    SEVERITIES,
    REPAIRABILITY_DECISIONS,
    validateInspectionInput,
    buildInspectionDocument,
    buildInspectionView,
    emptyInspectionView
};
