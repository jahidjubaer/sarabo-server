const { ObjectId } = require('mongodb');
const { validateProductRepairPair } = require('../utils/serviceTaxonomy');
// Reused read-only for validation-time consistency with the existing Stripe
// charge boundary (see controllers/paymentController.js) - this module never
// modifies config/paymentConfig.js or the legacy checkout flow. Money
// representation decision (Phase 6.3 Unit 2 / Phase D): every price field on
// a service definition (baseMin, baseMax, inspectionFee) is stored as a plain
// numeric amount in the canonical currency (BDT as of Phase 6.4 Unit 3C -
// whole-taka integers, no poisha), not integer cents. Service-definition BDT
// amounts are never charged through Stripe (v2 requests are not payable), so
// toSmallestUnit() is reused here purely as the shared, already-trusted
// at-most-2-decimal-places guard. Conversion to Stripe's integer smallest-
// unit only happens at the eventual legacy USD charge boundary via the
// one canonical conversion function the rest of the codebase already trusts,
// rather than introducing a second, parallel cents representation. To avoid
// the floating-point ambiguity that boundary conversion could otherwise
// introduce (e.g. 19.005 rounding unpredictably), every price value stored
// here is additionally required to already be expressed to at most 2 decimal
// places (isValidPriceAmount below) - so toSmallestUnit()'s Math.round() at
// charge time is always resolving genuine floating-point noise, never a
// meaningfully ambiguous input value.
const { toSmallestUnit } = require('../config/paymentConfig');

// Canonical estimate currency for service definitions (Phase 6.4 Unit 3C):
// Bangladesh Taka, stored and validated uppercase ("BDT"). This is the
// currency of the *service-definition catalogue and every new request's
// pricing snapshot* - it is deliberately distinct from the Stripe payment
// currency in config/paymentConfig.js (still USD), which this module never
// touches. Only 'BDT' is accepted here; any other value (including 'usd' or
// lowercase 'bdt') is rejected, so no new canonical definition can drift back
// to USD. Historical parcel pricing snapshots are read directly from their
// own documents and never pass through this validator, so pre-existing USD
// snapshots are unaffected by this change.
const CANONICAL_CURRENCY = 'BDT';

const EXPERTISE_LEVELS = Object.freeze(['beginner', 'intermediate', 'advanced', 'expert']);

const LABEL_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;

// Every key pricingRule may ever contain. Checked for exact membership (not
// just per-field validity) in validateServiceDefinitionInput, so a nested
// field like a would-be clientSuppliedFinalAmount/finalAmount/quotedAmount
// can never silently ride along into a persisted document even though every
// individually-checked field is itself valid.
const PRICING_RULE_FIELDS = ['currency', 'baseMin', 'baseMax', 'inspectionFee', 'version'];

// Sanity ceilings, not business pricing decisions - large enough to never
// constrain a real repair-service price, small enough to catch an obvious
// typo/overflow (e.g. a stray extra digit) before it reaches the database.
// The _USD suffixes are historical; these are currency-neutral upper bounds
// and every canonical BDT amount (Phase 6.4 Unit 3C) sits comfortably within
// them (highest base 18000, highest inspection fee 800).
const MAX_BASE_PRICE_USD = 100000;
const MAX_INSPECTION_FEE_USD = 1000;
// A single repair estimate is expected to resolve within a few days; longer
// jobs belong to the future quote workflow (explicitly out of scope for this
// unit), not a fixed estimatedDurationMinutes value.
const MAX_DURATION_MINUTES = 4320; // 3 days
const MAX_IMAGE_COUNT = 3;

// Every field a persisted service definition document may ever contain -
// buildDocumentFromInput() below whitelists strictly against this shape, so
// no caller-supplied extra field can ever reach the database, regardless of
// what else is present on the input object.
const WRITABLE_TOP_LEVEL_FIELDS = [
    'productCategorySlug', 'repairCategorySlug', 'label', 'description', 'isActive',
    'pricingRule', 'requiredExpertiseLevel', 'estimatedDurationMinutes',
    'inspectionRequired', 'imageRequirements'
];

// Fields ever allowed to leave MongoDB via a read path - excludes nothing
// sensitive today (this collection holds no PII), but is still enforced at
// the query level as defense-in-depth, matching the same pattern already
// used by models/Notification.js.
const SAFE_PROJECTION = {
    _id: 1, productCategorySlug: 1, repairCategorySlug: 1, label: 1, description: 1,
    isActive: 1, pricingRule: 1, requiredExpertiseLevel: 1, estimatedDurationMinutes: 1,
    inspectionRequired: 1, imageRequirements: 1, createdAt: 1, updatedAt: 1
};

function isTrimmedNonEmptyString(value, maxLength) {
    return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

// Finite, within [0, max] or (0, max] depending on allowZero, and already
// expressed to at most 2 decimal places - see the money-representation
// comment above for why the 2-decimal-place requirement exists.
function isValidPriceAmount(value, { max, allowZero }) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (allowZero ? value < 0 : value <= 0) return false;
    if (value > max) return false;
    const cents = toSmallestUnit(value);
    return Math.abs(cents - value * 100) < 1e-9;
}

function isPositiveInteger(value, max) {
    return Number.isInteger(value) && value > 0 && (max === undefined || value <= max);
}

// Structured, non-throwing validation - never a raw TypeError for malformed
// input, mirrors the { valid: false, code, message } / { valid: true } shape
// established by utils/serviceTaxonomy.js's validateProductRepairPair, and
// reuses that exact function (rather than re-deriving taxonomy rules here)
// for every taxonomy-pair check, so the relationship stays defined in
// exactly one place.
function validateServiceDefinitionInput(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { valid: false, code: 'INVALID_INPUT', message: 'service definition input must be an object' };
    }

    const pairResult = validateProductRepairPair(input.productCategorySlug, input.repairCategorySlug);
    if (!pairResult.valid) {
        return pairResult;
    }

    if (!isTrimmedNonEmptyString(input.label, LABEL_MAX_LENGTH)) {
        return { valid: false, code: 'INVALID_LABEL', message: `label must be a non-empty string of at most ${LABEL_MAX_LENGTH} characters` };
    }

    if (!isTrimmedNonEmptyString(input.description, DESCRIPTION_MAX_LENGTH)) {
        return { valid: false, code: 'INVALID_DESCRIPTION', message: `description must be a non-empty string of at most ${DESCRIPTION_MAX_LENGTH} characters` };
    }

    if (typeof input.isActive !== 'boolean') {
        return { valid: false, code: 'INVALID_IS_ACTIVE', message: 'isActive must be a boolean' };
    }

    const pricingRule = input.pricingRule;
    if (typeof pricingRule !== 'object' || pricingRule === null || Array.isArray(pricingRule)) {
        return { valid: false, code: 'INVALID_PRICING_RULE', message: 'pricingRule must be an object' };
    }

    const unexpectedPricingRuleField = Object.keys(pricingRule).find((key) => !PRICING_RULE_FIELDS.includes(key));
    if (unexpectedPricingRuleField !== undefined) {
        return { valid: false, code: 'UNEXPECTED_PRICING_RULE_FIELD', message: `pricingRule contains an unexpected field: ${unexpectedPricingRuleField}` };
    }

    if (pricingRule.currency !== CANONICAL_CURRENCY) {
        return { valid: false, code: 'INVALID_CURRENCY', message: `pricingRule.currency must be exactly "${CANONICAL_CURRENCY}"` };
    }

    if (!isValidPriceAmount(pricingRule.baseMin, { max: MAX_BASE_PRICE_USD, allowZero: false })) {
        return { valid: false, code: 'INVALID_BASE_MIN', message: 'pricingRule.baseMin must be a positive amount (at most 2 decimal places) within a sane bound' };
    }

    if (!isValidPriceAmount(pricingRule.baseMax, { max: MAX_BASE_PRICE_USD, allowZero: false })) {
        return { valid: false, code: 'INVALID_BASE_MAX', message: 'pricingRule.baseMax must be a positive amount (at most 2 decimal places) within a sane bound' };
    }

    if (pricingRule.baseMin > pricingRule.baseMax) {
        return { valid: false, code: 'BASE_MIN_EXCEEDS_BASE_MAX', message: 'pricingRule.baseMin must not exceed pricingRule.baseMax' };
    }

    if (!isValidPriceAmount(pricingRule.inspectionFee, { max: MAX_INSPECTION_FEE_USD, allowZero: true })) {
        return { valid: false, code: 'INVALID_INSPECTION_FEE', message: 'pricingRule.inspectionFee must be a non-negative amount (at most 2 decimal places) within a sane bound' };
    }

    if (!isPositiveInteger(pricingRule.version)) {
        return { valid: false, code: 'INVALID_PRICING_VERSION', message: 'pricingRule.version must be a positive integer' };
    }

    if (!EXPERTISE_LEVELS.includes(input.requiredExpertiseLevel)) {
        return { valid: false, code: 'INVALID_EXPERTISE_LEVEL', message: `requiredExpertiseLevel must be one of: ${EXPERTISE_LEVELS.join(', ')}` };
    }

    if (!isPositiveInteger(input.estimatedDurationMinutes, MAX_DURATION_MINUTES)) {
        return { valid: false, code: 'INVALID_DURATION', message: `estimatedDurationMinutes must be a positive integer of at most ${MAX_DURATION_MINUTES}` };
    }

    if (typeof input.inspectionRequired !== 'boolean') {
        return { valid: false, code: 'INVALID_INSPECTION_REQUIRED', message: 'inspectionRequired must be a boolean' };
    }

    const imageRequirements = input.imageRequirements;
    if (
        typeof imageRequirements !== 'object' || imageRequirements === null || Array.isArray(imageRequirements) ||
        !Number.isInteger(imageRequirements.min) || imageRequirements.min < 0 || imageRequirements.min > MAX_IMAGE_COUNT ||
        !Number.isInteger(imageRequirements.max) || imageRequirements.max < 0 || imageRequirements.max > MAX_IMAGE_COUNT ||
        imageRequirements.min > imageRequirements.max ||
        typeof imageRequirements.recommended !== 'boolean'
    ) {
        return {
            valid: false,
            code: 'INVALID_IMAGE_REQUIREMENTS',
            message: `imageRequirements must have integer min/max in [0, ${MAX_IMAGE_COUNT}] with min <= max, and a boolean recommended`
        };
    }

    return { valid: true };
}

// Whitelists strictly against WRITABLE_TOP_LEVEL_FIELDS - any other field
// present on `input` (e.g. an unexpected _id, or an unrelated stray field) is
// silently dropped, never persisted. Callers must call
// validateServiceDefinitionInput(input) first; this function does not
// re-validate.
function buildDocumentFromInput(input, now) {
    const doc = {};
    for (const field of WRITABLE_TOP_LEVEL_FIELDS) {
        doc[field] = input[field];
    }
    doc.label = doc.label.trim();
    doc.description = doc.description.trim();
    // Rebuilt from the exact known keys rather than copying input.pricingRule
    // wholesale - defense-in-depth against any nested unexpected field, on
    // top of validateServiceDefinitionInput's own rejection of the same.
    const pricingRule = {};
    for (const field of PRICING_RULE_FIELDS) {
        pricingRule[field] = input.pricingRule[field];
    }
    doc.pricingRule = pricingRule;
    doc.createdAt = now;
    doc.updatedAt = now;
    return doc;
}

class ServiceDefinitionModel {
    constructor(collection) {
        this.collection = collection;
    }

    // Seed/admin-path lookup only - used to decide create/skip/conflict
    // before any write, never exposed on a public read route.
    async findByKey(productCategorySlug, repairCategorySlug) {
        return await this.collection.findOne({ productCategorySlug, repairCategorySlug });
    }

    async insertOne(document) {
        return await this.collection.insertOne(document);
    }

    async findMany(query) {
        return await this.collection.find(query, { projection: SAFE_PROJECTION }).toArray();
    }

    async findById(id, options = {}) {
        if (!ObjectId.isValid(id)) return null;
        const findOptions = { projection: SAFE_PROJECTION };
        if (options.session) {
            findOptions.session = options.session;
        }
        return await this.collection.findOne({ _id: new ObjectId(id) }, findOptions);
    }
}

module.exports = {
    ServiceDefinitionModel,
    validateServiceDefinitionInput,
    buildDocumentFromInput,
    CANONICAL_CURRENCY,
    EXPERTISE_LEVELS,
    LABEL_MAX_LENGTH,
    DESCRIPTION_MAX_LENGTH,
    MAX_BASE_PRICE_USD,
    MAX_INSPECTION_FEE_USD,
    MAX_DURATION_MINUTES,
    MAX_IMAGE_COUNT,
    WRITABLE_TOP_LEVEL_FIELDS,
    PRICING_RULE_FIELDS
};
