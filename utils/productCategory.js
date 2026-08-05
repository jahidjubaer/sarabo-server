// Canonical, code-owned product-category catalog (Phase 6.3 Unit 1). This is
// the single source of truth every later unit (service definitions,
// technician expertise, repair-request v2, client forms) reads from - no
// other module should define its own product-category strings. Locked to
// exactly these 8 categories per the owner's decision register; do not add,
// remove, or reorder without a corresponding decision-register update.
//
// Every entry and the top-level array are frozen so the canonical catalog
// can never be mutated in place by a caller holding a reference to it -
// getProductCategoryBySlug additionally returns a fresh shallow copy on top
// of that, so even a caller that doesn't realize the source is frozen still
// can't affect canonical state.
const PRODUCT_CATEGORIES = Object.freeze([
    Object.freeze({
        slug: 'smartphone',
        label: 'Mobile Phone',
        description: 'Smartphones and mobile phones.',
        iconKey: 'mobile',
        brandModelRequired: true,
        serialNumberRelevant: true,
        isActive: true
    }),
    Object.freeze({
        slug: 'laptop-computer',
        label: 'Laptop / Computer',
        description: 'Laptops and desktop computers.',
        iconKey: 'laptop',
        brandModelRequired: true,
        serialNumberRelevant: true,
        isActive: true
    }),
    Object.freeze({
        slug: 'television',
        label: 'TV / Electronics',
        description: 'Televisions and general home electronics.',
        iconKey: 'tv',
        brandModelRequired: true,
        serialNumberRelevant: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'refrigerator',
        label: 'Refrigerator',
        description: 'Refrigerators and freezers.',
        iconKey: 'fridge',
        brandModelRequired: true,
        serialNumberRelevant: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'washing-machine',
        label: 'Washing Machine',
        description: 'Top-load and front-load washing machines.',
        iconKey: 'washer',
        brandModelRequired: true,
        serialNumberRelevant: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'air-conditioner',
        label: 'AC',
        description: 'Split and window air conditioners.',
        iconKey: 'ac',
        brandModelRequired: true,
        serialNumberRelevant: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'microwave-oven',
        label: 'Microwave',
        description: 'Microwave ovens.',
        iconKey: 'microwave',
        brandModelRequired: true,
        serialNumberRelevant: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'other-electronics',
        label: 'Other',
        description: 'Any other electronic device or appliance not listed above.',
        iconKey: 'tools',
        brandModelRequired: false,
        serialNumberRelevant: false,
        isActive: true
    })
]);

const PRODUCT_CATEGORY_SLUGS = Object.freeze(PRODUCT_CATEGORIES.map((category) => category.slug));

const PRODUCT_CATEGORY_BY_SLUG = new Map(PRODUCT_CATEGORIES.map((category) => [category.slug, category]));

// Accepts canonical slugs only after trimming - never guesses a slug from an
// arbitrary label, never lowercases, never maps aliases. A non-string input
// (including arrays, objects, numbers, booleans, null, undefined) always
// normalizes to null.
function normalizeSlugInput(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isValidProductCategorySlug(slug) {
    const normalized = normalizeSlugInput(slug);
    return normalized !== null && PRODUCT_CATEGORY_BY_SLUG.has(normalized);
}

function getProductCategoryBySlug(slug) {
    const normalized = normalizeSlugInput(slug);
    if (normalized === null || !PRODUCT_CATEGORY_BY_SLUG.has(normalized)) return null;
    // Shallow copy - this category has no nested objects/arrays, so a
    // shallow copy is already a complete defense against mutating the
    // canonical entry through the returned reference.
    return { ...PRODUCT_CATEGORY_BY_SLUG.get(normalized) };
}

function isActiveProductCategory(slug) {
    const normalized = normalizeSlugInput(slug);
    if (normalized === null) return false;
    const category = PRODUCT_CATEGORY_BY_SLUG.get(normalized);
    return !!category && category.isActive === true;
}

module.exports = {
    PRODUCT_CATEGORIES,
    PRODUCT_CATEGORY_SLUGS,
    isValidProductCategorySlug,
    getProductCategoryBySlug,
    isActiveProductCategory
};
