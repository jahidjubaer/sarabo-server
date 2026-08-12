// Technician eligibility evaluation and ranking (Phase 6.3 Unit 5). Pure
// business logic only - no MongoDB access, no HTTP coupling. All database
// orchestration (fetching the request, the service definition, candidate
// technicians, active-assignment set, linked-user roles, completed-repair
// counts) lives in controllers/repairRequestController.js#getEligibleTechnicians;
// this module only evaluates/ranks/shapes the data it is given. Reuses
// utils/technicianExpertise.js for every expertise rule rather than
// re-deriving them here.
//
// Result is advisory only - see evaluateTechnician/scoreTechnician below.
// The assignment transaction (a future unit) independently revalidates
// eligibility at commit time; nothing here ever mutates a record.
const {
    validateTechnicianExpertise, getExpertiseForProduct, satisfiesRequiredExpertiseLevel, EXPERTISE_LEVEL_RANK
} = require('../utils/technicianExpertise');
const { isV2RepairRequest } = require('../utils/repairRequestSchema');

// Changes only when eligibility rules or score semantics change - distinct
// from service-definition pricing version, repair-request schemaVersion, and
// technician expertise data itself.
const ELIGIBILITY_VERSION = 1;

const PAGINATION_DEFAULT_PAGE = 1;
const PAGINATION_DEFAULT_LIMIT = 20;
const PAGINATION_MAX_LIMIT = 50;
const DIAGNOSTIC_INELIGIBLE_CAP = 50;

const EXPERTISE_LEVEL_SCORE = Object.freeze({ beginner: 10, intermediate: 20, advanced: 30, expert: 40 });
const SERVICE_AREA_SCORE = Object.freeze({ 'exact-district': 20, 'same-region': 10, 'different-region': 0 });
const EXPERIENCE_SCORE_CAP = 10;
const COMPLETED_REPAIRS_SCORE_CAP = 20;

// Fixed, deterministic output order for diagnostic reason codes - a
// technician failing several independent checks reports all of them, always
// in this same order, regardless of internal evaluation order.
const REASON_CODE_ORDER = [
    'TECHNICIAN_NOT_APPROVED',
    'TECHNICIAN_UNAVAILABLE',
    'TECHNICIAN_ALREADY_ASSIGNED',
    'TECHNICIAN_ROLE_INCONSISTENT',
    'INCOMPLETE_TECHNICIAN_PROFILE',
    'PRODUCT_EXPERTISE_MISMATCH',
    'REPAIR_EXPERTISE_MISMATCH',
    'INSUFFICIENT_EXPERTISE_LEVEL'
];

function orderReasonCodes(codes) {
    return REASON_CODE_ORDER.filter((code) => codes.includes(code));
}

// ---- Query-parameter validation ----

function validateDiagnosticFlag(raw) {
    if (raw === undefined) return { valid: true, value: false };
    if (raw === 'true') return { valid: true, value: true };
    if (raw === 'false') return { valid: true, value: false };
    return { valid: false, code: 'INVALID_DIAGNOSTIC_MODE', message: 'diagnostic must be "true" or "false"' };
}

function isPositiveIntegerString(raw) {
    return typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw);
}

function validatePagination(rawPage, rawLimit) {
    let page = PAGINATION_DEFAULT_PAGE;
    let limit = PAGINATION_DEFAULT_LIMIT;

    if (rawPage !== undefined) {
        if (!isPositiveIntegerString(rawPage)) {
            return { valid: false, code: 'INVALID_PAGINATION', message: 'page must be a positive integer' };
        }
        page = Number(rawPage);
    }
    if (rawLimit !== undefined) {
        if (!isPositiveIntegerString(rawLimit)) {
            return { valid: false, code: 'INVALID_PAGINATION', message: 'limit must be a positive integer' };
        }
        limit = Math.min(Number(rawLimit), PAGINATION_MAX_LIMIT);
    }

    return { valid: true, page, limit };
}

// ---- Request taxonomy / current service-definition validation ----

// Reads the request's own persisted v2 snapshot - never guesses/derives
// taxonomy from legacy fields (deviceName, receiverRegion, license, bike).
function deriveRequestTaxonomy(repairRequest) {
    if (!isV2RepairRequest(repairRequest)) {
        return { valid: false, code: 'LEGACY_REQUEST_NOT_SUPPORTED', message: 'eligible-technician recommendations are only available for schemaVersion 2 requests' };
    }

    const productCategorySlug = repairRequest.product && repairRequest.product.categorySlug;
    const definitionId = repairRequest.service && repairRequest.service.definitionId;
    const repairCategorySlug = repairRequest.service && repairRequest.service.repairCategorySlug;
    const region = repairRequest.serviceLocation && repairRequest.serviceLocation.region;
    const district = repairRequest.serviceLocation && repairRequest.serviceLocation.district;

    if (
        typeof productCategorySlug !== 'string' || !productCategorySlug ||
        typeof definitionId !== 'string' || !definitionId ||
        typeof repairCategorySlug !== 'string' || !repairCategorySlug ||
        typeof region !== 'string' || !region ||
        typeof district !== 'string' || !district
    ) {
        return { valid: false, code: 'REQUEST_TAXONOMY_INCOMPLETE', message: 'request is missing required product/service/location taxonomy' };
    }

    return { valid: true, productCategorySlug, definitionId, repairCategorySlug, region, district };
}

// `definition` is an already-fetched, already-safe-projected service
// definition document (models/ServiceDefinition.js#findById) - current
// activity/match is a hard requirement independent of what the request's
// own historical snapshot says.
function validateCurrentServiceDefinition(definition, requestTaxonomy) {
    if (!definition) {
        return { valid: false, code: 'SERVICE_DEFINITION_NOT_FOUND', message: 'service definition not found' };
    }
    if (definition.isActive !== true) {
        return { valid: false, code: 'SERVICE_NOT_ACTIVE', message: 'service definition is not active' };
    }
    if (
        definition.productCategorySlug !== requestTaxonomy.productCategorySlug ||
        definition.repairCategorySlug !== requestTaxonomy.repairCategorySlug
    ) {
        return { valid: false, code: 'REQUEST_SERVICE_MISMATCH', message: 'current service definition no longer matches this request' };
    }
    return { valid: true };
}

// ---- Service-area ranking (never a hard eligibility gate) ----

function normalizeForAreaComparison(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function deriveServiceAreaMatch(requestTaxonomy, technician) {
    const regionMatch = normalizeForAreaComparison(requestTaxonomy.region) === normalizeForAreaComparison(technician.region);
    const districtMatch = regionMatch && normalizeForAreaComparison(requestTaxonomy.district) === normalizeForAreaComparison(technician.district);
    const matchLevel = districtMatch ? 'exact-district' : (regionMatch ? 'same-region' : 'different-region');
    return { regionMatch, districtMatch, matchLevel };
}

// ---- Hard eligibility ----

function hasCompleteProfile(technician) {
    return typeof technician.name === 'string' && technician.name.trim().length > 0 &&
        typeof technician.region === 'string' && technician.region.trim().length > 0 &&
        typeof technician.district === 'string' && technician.district.trim().length > 0;
}

// Evaluates one candidate against every hard-eligibility rule (Phase F-I).
// Never throws on malformed/corrupt technician data - an invalid expertise array
// is treated as an ineligible, incomplete profile, never as an exception and
// never as silently eligible. Returns every applicable reason code (not just
// the first), since diagnostic mode must be able to show a technician
// multiple simultaneous reasons.
function evaluateTechnician(technician, { requestTaxonomy, serviceDefinition, activeTechnicianIds, technicianRole }) {
    const reasonCodes = [];

    if (technician.status !== 'approved') {
        reasonCodes.push('TECHNICIAN_NOT_APPROVED');
    }
    if (technician.workStatus !== 'available') {
        reasonCodes.push('TECHNICIAN_UNAVAILABLE');
    }
    // Checked independently of workStatus - a technician can read as
    // 'available' while historical data drift still leaves them holding an
    // active assignment; that must never be silently trusted.
    if (activeTechnicianIds.has(technician._id.toString())) {
        reasonCodes.push('TECHNICIAN_ALREADY_ASSIGNED');
    }
    if (technicianRole !== 'rider') {
        reasonCodes.push('TECHNICIAN_ROLE_INCONSISTENT');
    }

    let matchedExpertiseEntry = null;
    const profileComplete = hasCompleteProfile(technician);
    const expertiseValidation = Array.isArray(technician.expertise) ? validateTechnicianExpertise(technician.expertise) : { valid: false };

    if (!profileComplete || !expertiseValidation.valid || technician.expertise.length === 0) {
        reasonCodes.push('INCOMPLETE_TECHNICIAN_PROFILE');
    } else {
        const entry = getExpertiseForProduct(technician.expertise, requestTaxonomy.productCategorySlug);
        if (!entry) {
            reasonCodes.push('PRODUCT_EXPERTISE_MISMATCH');
        } else if (!entry.repairCategorySlugs.includes(requestTaxonomy.repairCategorySlug)) {
            reasonCodes.push('REPAIR_EXPERTISE_MISMATCH');
        } else if (!satisfiesRequiredExpertiseLevel(entry.level, serviceDefinition.requiredExpertiseLevel)) {
            reasonCodes.push('INSUFFICIENT_EXPERTISE_LEVEL');
        } else {
            matchedExpertiseEntry = entry;
        }
    }

    return {
        eligible: reasonCodes.length === 0,
        reasonCodes: orderReasonCodes(reasonCodes),
        matchedExpertiseEntry
    };
}

// ---- Ranking ----

// Score can only ever affect ORDER among already-eligible technicians - it
// is computed here purely from already-derived, already-safe values
// (matched expertise level, service-area match, capped experience/completed
// counts) and is never itself consulted by evaluateTechnician above, so it
// can never make an ineligible technician eligible.
function scoreTechnician({ matchedExpertiseEntry, serviceAreaMatch, completedRepairCount }) {
    const cappedExperience = Math.min(matchedExpertiseEntry.experienceYears, EXPERIENCE_SCORE_CAP);
    const cappedCompleted = Math.min(completedRepairCount, COMPLETED_REPAIRS_SCORE_CAP);
    const expertiseLevelScore = EXPERTISE_LEVEL_SCORE[matchedExpertiseEntry.level];
    const serviceAreaScore = SERVICE_AREA_SCORE[serviceAreaMatch.matchLevel];

    const recommendationScore = expertiseLevelScore + serviceAreaScore + cappedExperience + cappedCompleted;

    const recommendationReasons = [];
    recommendationReasons.push(`expertise:${matchedExpertiseEntry.level}`);
    recommendationReasons.push(`serviceArea:${serviceAreaMatch.matchLevel}`);
    if (cappedExperience > 0) recommendationReasons.push(`experience:${cappedExperience}yrs`);
    if (cappedCompleted > 0) recommendationReasons.push(`completedRepairs:${cappedCompleted}`);

    return { recommendationScore, recommendationReasons };
}

// Deterministic - recommendationScore desc, expertise rank desc,
// experienceYears desc, completedRepairCount desc, displayName asc,
// technicianId asc. Never depends on Array.prototype.sort's stability
// alone; every dimension is explicit.
function compareTechnicians(a, b) {
    if (b.recommendationScore !== a.recommendationScore) return b.recommendationScore - a.recommendationScore;
    const rankDiff = EXPERTISE_LEVEL_RANK[b.expertiseLevel] - EXPERTISE_LEVEL_RANK[a.expertiseLevel];
    if (rankDiff !== 0) return rankDiff;
    if (b.experienceYears !== a.experienceYears) return b.experienceYears - a.experienceYears;
    if (b.completedRepairCount !== a.completedRepairCount) return b.completedRepairCount - a.completedRepairCount;
    const nameCompare = (a.displayName || '').localeCompare(b.displayName || '');
    if (nameCompare !== 0) return nameCompare;
    return a.technicianId < b.technicianId ? -1 : (a.technicianId > b.technicianId ? 1 : 0);
}

function sortTechnicians(technicians) {
    return [...technicians].sort(compareTechnicians);
}

// ---- Safe response shaping ----

// Only ever built from already-derived, already-safe values - never spreads
// the raw technician document, so no private field (email, phone, NID, address,
// license, bike, application documents) can ever reach this object even if
// one is added to the technician projection later.
function buildEligibleTechnicianEntry(technician, evaluationResult, scoreResult, serviceAreaMatch, completedRepairCount) {
    return {
        technicianId: technician._id.toString(),
        displayName: technician.name,
        avatar: technician.avatar,
        workStatus: technician.workStatus,
        expertiseMatch: true,
        expertiseLevel: evaluationResult.matchedExpertiseEntry.level,
        experienceYears: evaluationResult.matchedExpertiseEntry.experienceYears,
        completedRepairCount,
        serviceAreaMatch,
        recommendationScore: scoreResult.recommendationScore,
        recommendationReasons: scoreResult.recommendationReasons
    };
}

function buildIneligibleTechnicianEntry(technician, evaluationResult) {
    return {
        technicianId: technician._id.toString(),
        displayName: technician.name,
        reasonCodes: evaluationResult.reasonCodes
    };
}

function paginate(items, { page, limit }) {
    const totalItems = items.length;
    const totalPages = Math.max(Math.ceil(totalItems / limit), 1);
    const start = (page - 1) * limit;
    const pageItems = items.slice(start, start + limit);
    return {
        pageItems,
        pagination: {
            page, limit, totalItems, totalPages,
            hasNextPage: page < totalPages,
            hasPreviousPage: page > 1
        }
    };
}

module.exports = {
    ELIGIBILITY_VERSION,
    PAGINATION_DEFAULT_PAGE,
    PAGINATION_DEFAULT_LIMIT,
    PAGINATION_MAX_LIMIT,
    DIAGNOSTIC_INELIGIBLE_CAP,
    EXPERTISE_LEVEL_SCORE,
    SERVICE_AREA_SCORE,
    EXPERIENCE_SCORE_CAP,
    COMPLETED_REPAIRS_SCORE_CAP,
    REASON_CODE_ORDER,
    validateDiagnosticFlag,
    validatePagination,
    deriveRequestTaxonomy,
    validateCurrentServiceDefinition,
    deriveServiceAreaMatch,
    evaluateTechnician,
    scoreTechnician,
    sortTechnicians,
    compareTechnicians,
    buildEligibleTechnicianEntry,
    buildIneligibleTechnicianEntry,
    paginate
};
