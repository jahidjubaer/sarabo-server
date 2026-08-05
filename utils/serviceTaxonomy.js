// Canonical product-to-repair-category mapping (Phase 6.3 Unit 1) - the one
// place that defines which repair categories are valid for which product
// category. utils/productCategory.js and utils/repairCategory.js each own
// their own catalog only; neither embeds cross-references to the other, so
// this relationship is never duplicated in two places.
const { isValidProductCategorySlug, isActiveProductCategory } = require('./productCategory');
const { isValidRepairCategorySlug, isActiveRepairCategory } = require('./repairCategory');

// 'diagnosis' is implicitly valid for every product category - listed once
// here rather than duplicated into every array below. other-electronics
// still lists it explicitly too; getAllowedRepairCategories de-duplicates,
// so it is never returned twice for that product.
const UNIVERSAL_REPAIR_CATEGORY_SLUGS = Object.freeze(['diagnosis']);

const PRODUCT_REPAIR_CATEGORY_MAP = Object.freeze({
    smartphone: Object.freeze([
        'display-screen', 'battery-power', 'charging-port', 'motherboard', 'software-os', 'camera-audio', 'other'
    ]),
    'laptop-computer': Object.freeze([
        'display-screen', 'battery-power', 'charging-port', 'motherboard', 'software-os', 'cooling-overheating', 'other'
    ]),
    television: Object.freeze([
        'display-screen', 'electrical-power', 'motherboard', 'other'
    ]),
    refrigerator: Object.freeze([
        'compressor-cooling', 'electrical-power', 'mechanical-parts', 'installation-maintenance', 'other'
    ]),
    'washing-machine': Object.freeze([
        'mechanical-parts', 'electrical-power', 'motherboard', 'installation-maintenance', 'other'
    ]),
    'air-conditioner': Object.freeze([
        'compressor-cooling', 'electrical-power', 'cooling-overheating', 'installation-maintenance', 'other'
    ]),
    'microwave-oven': Object.freeze([
        'electrical-power', 'mechanical-parts', 'other'
    ]),
    'other-electronics': Object.freeze([
        'diagnosis', 'other'
    ])
});

function normalizeSlugInput(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

// Always returns a fresh array (never the frozen canonical arrays above, and
// never the same array instance twice) - a caller mutating the result can
// never affect canonical state or any other caller's result.
function getAllowedRepairCategories(productSlug) {
    const normalized = normalizeSlugInput(productSlug);
    if (normalized === null) return [];
    const explicit = PRODUCT_REPAIR_CATEGORY_MAP[normalized];
    if (!explicit) return [];
    return Array.from(new Set([...UNIVERSAL_REPAIR_CATEGORY_SLUGS, ...explicit]));
}

function isRepairCategoryAllowedForProduct(productSlug, repairSlug) {
    const normalizedRepair = normalizeSlugInput(repairSlug);
    if (normalizedRepair === null) return false;
    return getAllowedRepairCategories(productSlug).includes(normalizedRepair);
}

// Structured, non-throwing validation result - never a raw TypeError for
// ordinary invalid input. { valid: true } on success; on failure, a stable
// { valid: false, code, message } shape distinguishing exactly which
// precondition failed, checked in a fixed order so the same invalid pair
// always reports the same code.
function validateProductRepairPair(productSlug, repairSlug) {
    if (!isValidProductCategorySlug(productSlug)) {
        return { valid: false, code: 'INVALID_PRODUCT_CATEGORY', message: 'unrecognized product category' };
    }
    if (!isActiveProductCategory(productSlug)) {
        return { valid: false, code: 'INACTIVE_PRODUCT_CATEGORY', message: 'product category is not active' };
    }
    if (!isValidRepairCategorySlug(repairSlug)) {
        return { valid: false, code: 'INVALID_REPAIR_CATEGORY', message: 'unrecognized repair category' };
    }
    if (!isActiveRepairCategory(repairSlug)) {
        return { valid: false, code: 'INACTIVE_REPAIR_CATEGORY', message: 'repair category is not active' };
    }
    if (!isRepairCategoryAllowedForProduct(productSlug, repairSlug)) {
        return { valid: false, code: 'REPAIR_CATEGORY_NOT_SUPPORTED', message: 'this repair category is not supported for the given product category' };
    }
    return { valid: true };
}

module.exports = {
    PRODUCT_REPAIR_CATEGORY_MAP,
    getAllowedRepairCategories,
    isRepairCategoryAllowedForProduct,
    validateProductRepairPair
};
