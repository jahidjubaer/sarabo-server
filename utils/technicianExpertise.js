// Canonical technician-expertise domain module (Phase 6.3 Unit 3). Pure
// validation/comparison logic only - no MongoDB dependency, no database
// access, so it can be unit-tested and reused by both the rider-application
// path (createRider) and the dedicated expertise-update endpoint without
// either one owning the rules.
//
// Locked shape (per the unit's architecture decision):
//   [{ productCategorySlug, repairCategorySlugs: [...], level, experienceYears }]
const { isValidProductCategorySlug, isActiveProductCategory } = require('./productCategory');
const { validateProductRepairPair } = require('./serviceTaxonomy');

const EXPERTISE_LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced', 'expert']);

const EXPERTISE_LEVEL_RANK = Object.freeze({
    beginner: 0,
    intermediate: 1,
    advanced: 2,
    expert: 3
});

// Locked, non-overlapping experience bands (Phase D) - the recommended
// interpretation, chosen for its determinism: every integer year from 0-50
// falls into exactly one band, with no gap and no double-coverage at a
// boundary value.
//   beginner:     0 <= years < 1
//   intermediate: 1 <= years < 3
//   advanced:     3 <= years < 7
//   expert:       7 <= years <= 50
const EXPERIENCE_BANDS = Object.freeze({
    beginner: Object.freeze({ min: 0, max: 1, maxInclusive: false }),
    intermediate: Object.freeze({ min: 1, max: 3, maxInclusive: false }),
    advanced: Object.freeze({ min: 3, max: 7, maxInclusive: false }),
    expert: Object.freeze({ min: 7, max: 50, maxInclusive: true })
});

const MIN_EXPERIENCE_YEARS = 0;
const MAX_EXPERIENCE_YEARS = 50;
const MAX_REPAIR_CATEGORIES_PER_ENTRY = 10; // generous ceiling - no taxonomy product currently allows more than 8 (7 explicit + universal diagnosis)
const MAX_EXPERTISE_ENTRIES = 8;

const EXPERTISE_ENTRY_FIELDS = ['productCategorySlug', 'repairCategorySlugs', 'level', 'experienceYears'];

function isValidExpertiseLevel(level) {
    return EXPERTISE_LEVELS.includes(level);
}

// Returns rank(a) - rank(b), or null if either level is invalid - never
// throws, matching this module's non-throwing validation philosophy.
function compareExpertiseLevels(levelA, levelB) {
    if (!isValidExpertiseLevel(levelA) || !isValidExpertiseLevel(levelB)) return null;
    return EXPERTISE_LEVEL_RANK[levelA] - EXPERTISE_LEVEL_RANK[levelB];
}

// True when actualLevel meets or exceeds requiredLevel (e.g. an 'advanced'
// technician satisfies a service definition requiring 'intermediate'). False
// (never throws) for any invalid level. Not wired into assignment logic in
// this unit - a pure helper for a future eligibility-matching unit.
function satisfiesRequiredExpertiseLevel(actualLevel, requiredLevel) {
    const comparison = compareExpertiseLevels(actualLevel, requiredLevel);
    return comparison !== null && comparison >= 0;
}

function isExperienceConsistentWithLevel(level, experienceYears) {
    const band = EXPERIENCE_BANDS[level];
    if (!band) return false;
    if (experienceYears < band.min) return false;
    return band.maxInclusive ? experienceYears <= band.max : experienceYears < band.max;
}

function isTrimmedString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

// Validates one expertise entry. Returns { valid: true } or
// { valid: false, code, message }. Checked in a fixed precedence order so
// the same invalid entry always reports the same code.
function validateExpertiseEntry(entry) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { valid: false, code: 'INVALID_EXPERTISE', message: 'each expertise entry must be an object' };
    }

    const unexpectedField = Object.keys(entry).find((key) => !EXPERTISE_ENTRY_FIELDS.includes(key));
    if (unexpectedField !== undefined) {
        return { valid: false, code: 'INVALID_EXPERTISE', message: `expertise entry contains an unexpected field: ${unexpectedField}` };
    }

    if (!isTrimmedString(entry.productCategorySlug) || !isValidProductCategorySlug(entry.productCategorySlug)) {
        return { valid: false, code: 'INVALID_PRODUCT_CATEGORY', message: 'unrecognized product category' };
    }
    if (!isActiveProductCategory(entry.productCategorySlug)) {
        return { valid: false, code: 'INACTIVE_PRODUCT_CATEGORY', message: 'product category is not active' };
    }

    if (!Array.isArray(entry.repairCategorySlugs) || entry.repairCategorySlugs.length === 0 || entry.repairCategorySlugs.length > MAX_REPAIR_CATEGORIES_PER_ENTRY) {
        return { valid: false, code: 'INVALID_EXPERTISE', message: `repairCategorySlugs must be an array of 1 to ${MAX_REPAIR_CATEGORIES_PER_ENTRY} entries` };
    }
    if (!entry.repairCategorySlugs.every((slug) => isTrimmedString(slug))) {
        return { valid: false, code: 'INVALID_REPAIR_CATEGORY', message: 'every repairCategorySlugs entry must be a non-empty string' };
    }

    const seenRepairSlugs = new Set();
    for (const repairSlug of entry.repairCategorySlugs) {
        if (seenRepairSlugs.has(repairSlug)) {
            return { valid: false, code: 'DUPLICATE_REPAIR_EXPERTISE', message: `duplicate repair category within one expertise entry: ${repairSlug}` };
        }
        seenRepairSlugs.add(repairSlug);

        const pairResult = validateProductRepairPair(entry.productCategorySlug, repairSlug);
        if (!pairResult.valid) {
            return pairResult;
        }
    }

    if (!isValidExpertiseLevel(entry.level)) {
        return { valid: false, code: 'INVALID_EXPERTISE_LEVEL', message: `level must be one of: ${EXPERTISE_LEVELS.join(', ')}` };
    }

    if (!Number.isInteger(entry.experienceYears) || entry.experienceYears < MIN_EXPERIENCE_YEARS || entry.experienceYears > MAX_EXPERIENCE_YEARS) {
        return { valid: false, code: 'INVALID_EXPERIENCE_YEARS', message: `experienceYears must be an integer between ${MIN_EXPERIENCE_YEARS} and ${MAX_EXPERIENCE_YEARS}` };
    }

    if (!isExperienceConsistentWithLevel(entry.level, entry.experienceYears)) {
        return { valid: false, code: 'EXPERTISE_LEVEL_EXPERIENCE_MISMATCH', message: `${entry.experienceYears} years of experience is not consistent with level "${entry.level}"` };
    }

    return { valid: true };
}

// Validates the full expertise array - structured, non-throwing, fixed
// precedence: array shape -> entry count -> each entry individually (in
// order) -> cross-entry duplicate product check last, since detecting a
// duplicate slug is only meaningful once every entry is individually known
// to have a valid productCategorySlug.
function validateTechnicianExpertise(expertise) {
    if (!Array.isArray(expertise)) {
        return { valid: false, code: 'INVALID_EXPERTISE', message: 'expertise must be an array' };
    }
    if (expertise.length > MAX_EXPERTISE_ENTRIES) {
        return { valid: false, code: 'TOO_MANY_EXPERTISE_ENTRIES', message: `expertise may contain at most ${MAX_EXPERTISE_ENTRIES} entries` };
    }

    for (const entry of expertise) {
        const entryResult = validateExpertiseEntry(entry);
        if (!entryResult.valid) {
            return entryResult;
        }
    }

    const seenProducts = new Set();
    for (const entry of expertise) {
        if (seenProducts.has(entry.productCategorySlug)) {
            return { valid: false, code: 'DUPLICATE_PRODUCT_EXPERTISE', message: `duplicate product category in expertise: ${entry.productCategorySlug}` };
        }
        seenProducts.add(entry.productCategorySlug);
    }

    return { valid: true };
}

// Builds a fresh, canonical, write-ready copy from an already-validated
// expertise array - trims string fields and whitelists exactly the known
// entry fields, so a caller that validated a raw array can never persist an
// unexpected field even if validateTechnicianExpertise is ever loosened
// later. Callers must validate first; this does not re-validate. Never
// mutates the input array/objects.
function normalizeTechnicianExpertise(expertise) {
    return expertise.map((entry) => ({
        productCategorySlug: entry.productCategorySlug.trim(),
        repairCategorySlugs: entry.repairCategorySlugs.map((slug) => slug.trim()),
        level: entry.level,
        experienceYears: entry.experienceYears
    }));
}

// Fresh-copy lookup helpers over an already-valid expertise array - never
// return the caller's own array/object references. Intended for a future
// eligibility-matching unit; not wired into assignment logic here.
function getExpertiseForProduct(expertise, productCategorySlug) {
    if (!Array.isArray(expertise)) return null;
    const entry = expertise.find((e) => e.productCategorySlug === productCategorySlug);
    if (!entry) return null;
    return { productCategorySlug: entry.productCategorySlug, repairCategorySlugs: [...entry.repairCategorySlugs], level: entry.level, experienceYears: entry.experienceYears };
}

function hasProductExpertise(expertise, productCategorySlug) {
    return getExpertiseForProduct(expertise, productCategorySlug) !== null;
}

function hasRepairExpertise(expertise, productCategorySlug, repairCategorySlug) {
    const entry = getExpertiseForProduct(expertise, productCategorySlug);
    return !!entry && entry.repairCategorySlugs.includes(repairCategorySlug);
}

module.exports = {
    EXPERTISE_LEVELS,
    EXPERTISE_LEVEL_RANK,
    EXPERIENCE_BANDS,
    MIN_EXPERIENCE_YEARS,
    MAX_EXPERIENCE_YEARS,
    MAX_REPAIR_CATEGORIES_PER_ENTRY,
    MAX_EXPERTISE_ENTRIES,
    EXPERTISE_ENTRY_FIELDS,
    isValidExpertiseLevel,
    compareExpertiseLevels,
    satisfiesRequiredExpertiseLevel,
    isExperienceConsistentWithLevel,
    validateExpertiseEntry,
    validateTechnicianExpertise,
    normalizeTechnicianExpertise,
    getExpertiseForProduct,
    hasProductExpertise,
    hasRepairExpertise
};
