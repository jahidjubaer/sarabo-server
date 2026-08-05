// Canonical, code-owned repair-category catalog (Phase 6.3 Unit 1) - the
// global, reusable set of repair/problem categories referenced by service
// definitions, technician expertise, and repair requests. These are
// deliberately product-agnostic; utils/serviceTaxonomy.js owns which of
// these are allowed for which product category, so that relationship is
// defined in exactly one place rather than duplicated into each entry here.
// Locked to exactly these 13 categories per the owner's decision register.
//
// remoteDiagnosisMode is restricted to this narrow, exhaustive set - it is
// never a free-form string.
const REMOTE_DIAGNOSIS_MODES = Object.freeze(['yes', 'partial', 'no']);

const REPAIR_CATEGORIES = Object.freeze([
    Object.freeze({
        slug: 'diagnosis',
        label: 'General Diagnosis',
        description: 'Initial diagnosis when the exact problem is not yet known.',
        remoteDiagnosisMode: 'yes',
        imageEvidenceUseful: true,
        inspectionNormallyRequired: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'display-screen',
        label: 'Display / Screen',
        description: 'Cracked, damaged, or malfunctioning displays and screens.',
        remoteDiagnosisMode: 'no',
        imageEvidenceUseful: true,
        inspectionNormallyRequired: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'battery-power',
        label: 'Battery / Power',
        description: 'Battery health, charging retention, and power-on issues.',
        remoteDiagnosisMode: 'partial',
        imageEvidenceUseful: true,
        inspectionNormallyRequired: true,
        isActive: true
    }),
    Object.freeze({
        slug: 'charging-port',
        label: 'Charging Port',
        description: 'Damaged or unresponsive charging ports/connectors.',
        remoteDiagnosisMode: 'no',
        imageEvidenceUseful: true,
        inspectionNormallyRequired: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'motherboard',
        label: 'Motherboard / Internal',
        description: 'Internal board-level and component-level faults.',
        remoteDiagnosisMode: 'no',
        imageEvidenceUseful: false,
        inspectionNormallyRequired: true,
        isActive: true
    }),
    Object.freeze({
        slug: 'software-os',
        label: 'Software / OS',
        description: 'Operating system, firmware, and software troubleshooting.',
        remoteDiagnosisMode: 'yes',
        imageEvidenceUseful: false,
        inspectionNormallyRequired: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'camera-audio',
        label: 'Camera / Audio',
        description: 'Camera, microphone, and speaker faults.',
        remoteDiagnosisMode: 'partial',
        imageEvidenceUseful: true,
        inspectionNormallyRequired: false,
        isActive: true
    }),
    Object.freeze({
        slug: 'cooling-overheating',
        label: 'Cooling / Overheating',
        description: 'Overheating and cooling-system performance issues.',
        remoteDiagnosisMode: 'partial',
        imageEvidenceUseful: false,
        inspectionNormallyRequired: true,
        isActive: true
    }),
    Object.freeze({
        slug: 'compressor-cooling',
        label: 'Compressor / Refrigerant',
        description: 'Compressor, refrigerant, and cooling-cycle faults.',
        remoteDiagnosisMode: 'no',
        imageEvidenceUseful: false,
        inspectionNormallyRequired: true,
        isActive: true
    }),
    Object.freeze({
        slug: 'mechanical-parts',
        label: 'Mechanical Parts',
        description: 'Drums, motors, drainage, and other mechanical components.',
        remoteDiagnosisMode: 'no',
        imageEvidenceUseful: true,
        inspectionNormallyRequired: true,
        isActive: true
    }),
    Object.freeze({
        slug: 'electrical-power',
        label: 'Electrical / Power Supply',
        description: 'Electrical faults and power-supply issues.',
        remoteDiagnosisMode: 'no',
        imageEvidenceUseful: true,
        inspectionNormallyRequired: true,
        isActive: true
    }),
    Object.freeze({
        slug: 'installation-maintenance',
        label: 'Installation / Maintenance',
        description: 'New installation and routine maintenance service.',
        remoteDiagnosisMode: 'no',
        imageEvidenceUseful: false,
        inspectionNormallyRequired: true,
        isActive: true
    }),
    Object.freeze({
        slug: 'other',
        label: 'Other',
        description: 'Any other repair or problem category not listed above.',
        remoteDiagnosisMode: 'no',
        imageEvidenceUseful: true,
        inspectionNormallyRequired: true,
        isActive: true
    })
]);

const REPAIR_CATEGORY_SLUGS = Object.freeze(REPAIR_CATEGORIES.map((category) => category.slug));

const REPAIR_CATEGORY_BY_SLUG = new Map(REPAIR_CATEGORIES.map((category) => [category.slug, category]));

// Accepts canonical slugs only after trimming - never guesses a slug from an
// arbitrary label, never lowercases, never maps aliases. A non-string input
// always normalizes to null.
function normalizeSlugInput(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isValidRepairCategorySlug(slug) {
    const normalized = normalizeSlugInput(slug);
    return normalized !== null && REPAIR_CATEGORY_BY_SLUG.has(normalized);
}

function getRepairCategoryBySlug(slug) {
    const normalized = normalizeSlugInput(slug);
    if (normalized === null || !REPAIR_CATEGORY_BY_SLUG.has(normalized)) return null;
    return { ...REPAIR_CATEGORY_BY_SLUG.get(normalized) };
}

function isActiveRepairCategory(slug) {
    const normalized = normalizeSlugInput(slug);
    if (normalized === null) return false;
    const category = REPAIR_CATEGORY_BY_SLUG.get(normalized);
    return !!category && category.isActive === true;
}

module.exports = {
    REMOTE_DIAGNOSIS_MODES,
    REPAIR_CATEGORIES,
    REPAIR_CATEGORY_SLUGS,
    isValidRepairCategorySlug,
    getRepairCategoryBySlug,
    isActiveRepairCategory
};
