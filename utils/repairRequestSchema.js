// Canonical repair-request schema-version contract (Phase 6.3 Unit 4). Pure,
// no MongoDB dependency, no HTTP coupling - the single source of truth for
// distinguishing a legacy repair request from a v2 one.
//
// Absence of schemaVersion always means legacy, for backward compatibility -
// every repair request created before this unit has no schemaVersion field
// at all, and must never be reclassified or migrated by reading this module.
// schemaVersion is only ever compared as a genuine integer, never coerced
// from a string ("2" is not 2) and never inferred from the presence/absence
// of any nested field (a legacy document that happens to contain a
// coincidentally-named field is still legacy).
const LEGACY_REPAIR_REQUEST_SCHEMA_VERSION = 1;
const CURRENT_REPAIR_REQUEST_SCHEMA_VERSION = 2;

function getRepairRequestSchemaVersion(request) {
    if (!request || typeof request !== 'object') return LEGACY_REPAIR_REQUEST_SCHEMA_VERSION;
    const raw = request.schemaVersion;
    if (raw === undefined || raw === null) return LEGACY_REPAIR_REQUEST_SCHEMA_VERSION;
    return raw;
}

function isLegacyRepairRequest(request) {
    const version = getRepairRequestSchemaVersion(request);
    return version === undefined || version === null || version === LEGACY_REPAIR_REQUEST_SCHEMA_VERSION;
}

function isV2RepairRequest(request) {
    return getRepairRequestSchemaVersion(request) === CURRENT_REPAIR_REQUEST_SCHEMA_VERSION;
}

// Validates a raw, caller-supplied schemaVersion value (e.g. from a request
// body) - distinct from getRepairRequestSchemaVersion above, which reads a
// value already known to be a persisted document's field. Structured,
// non-throwing result, matching the { valid, code, message } shape already
// established by utils/serviceTaxonomy.js and models/ServiceDefinition.js.
function validateRepairRequestSchemaVersion(rawSchemaVersion) {
    if (rawSchemaVersion === undefined || rawSchemaVersion === null) {
        return { valid: true, version: LEGACY_REPAIR_REQUEST_SCHEMA_VERSION };
    }
    if (!Number.isInteger(rawSchemaVersion)) {
        return { valid: false, code: 'UNSUPPORTED_REPAIR_REQUEST_SCHEMA_VERSION', message: 'schemaVersion must be an integer' };
    }
    if (rawSchemaVersion !== LEGACY_REPAIR_REQUEST_SCHEMA_VERSION && rawSchemaVersion !== CURRENT_REPAIR_REQUEST_SCHEMA_VERSION) {
        return { valid: false, code: 'UNSUPPORTED_REPAIR_REQUEST_SCHEMA_VERSION', message: `schemaVersion ${rawSchemaVersion} is not supported` };
    }
    return { valid: true, version: rawSchemaVersion };
}

module.exports = {
    LEGACY_REPAIR_REQUEST_SCHEMA_VERSION,
    CURRENT_REPAIR_REQUEST_SCHEMA_VERSION,
    getRepairRequestSchemaVersion,
    isLegacyRepairRequest,
    isV2RepairRequest,
    validateRepairRequestSchemaVersion
};
