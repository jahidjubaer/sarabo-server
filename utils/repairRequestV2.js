// Repair-request v2 validation/build module (Phase 6.3 Unit 4). Pure where
// practical - product/damage/location validation never touches MongoDB
// (product-category metadata comes from Unit 1's frozen taxonomy, not a
// database read). Service-definition lookup genuinely requires a database
// read (it is a persisted, mutable catalog row), so that step is
// orchestrated by the caller (controllers/repairRequestController.js) using
// models/ServiceDefinition.js directly - this module only validates the
// already-fetched definition's shape/match, never fetches it itself.

const { getProductCategoryBySlug, isValidProductCategorySlug, isActiveProductCategory } = require('./productCategory');

const BRAND_MODEL_MAX_LENGTH = 100;
const SERIAL_NUMBER_MAX_LENGTH = 100;
const DAMAGE_DESCRIPTION_MIN_LENGTH = 10;
const DAMAGE_DESCRIPTION_MAX_LENGTH = 1000;
const LOCATION_FIELD_MAX_LENGTH = 150;

// Locked damage-image policy (Phase L). MIN_DAMAGE_IMAGES is the eventual,
// permanent minimum once a Firebase Storage upload unit exists; creation
// callers pass an explicit, named override (see the `minImages` option
// below) until then - see STAGED_MIN_DAMAGE_IMAGES.
const MIN_DAMAGE_IMAGES = 1;
const MAX_DAMAGE_IMAGES = 3;
// Temporary compatibility floor: Firebase Storage upload is not implemented
// in this unit, so a v2 request cannot yet realistically carry any real
// image metadata. Creation deliberately permits 0 images for now by passing
// { minImages: STAGED_MIN_DAMAGE_IMAGES } explicitly at the call site (see
// controllers/repairRequestController.js) - the moment an upload unit exists, that
// call site changes to MIN_DAMAGE_IMAGES without touching this module's
// validation logic itself. The canonical metadata shape/bounds below are
// never weakened by this flag - only the minimum-count floor moves.
const STAGED_MIN_DAMAGE_IMAGES = 0;

const ALLOWED_IMAGE_MIME_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_IMAGE_DIMENSION_PX = 20000; // sane ceiling, not a real camera limit
const DAMAGE_IMAGE_FIELDS = ['url', 'storageKey', 'mimeType', 'size', 'width', 'height', 'uploadedAt', 'uploadedByRole'];
const ALLOWED_UPLOADED_BY_ROLE = 'user';

// Fields that would give a client authority over persisted pricing - a v2
// request body containing any of these (top-level, or nested under
// `pricing`) is rejected outright with CLIENT_PRICING_NOT_ALLOWED, never
// silently stripped, so client tampering is always an obvious, loud error
// rather than a quiet no-op.
const CLIENT_PRICING_FORBIDDEN_FIELDS = [
    'cost', 'pricing', 'estimateMin', 'estimateMax', 'inspectionFee',
    'quotedAmount', 'finalAmount', 'calculationVersion', 'currency',
    'amount', 'unitAmount', 'stripeAmount', 'cents'
];

function isTrimmedString(value, maxLength) {
    return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function isPositiveInteger(value, max) {
    return Number.isInteger(value) && value > 0 && (max === undefined || value <= max);
}

// ---- Product ----

function validateProductInput(product) {
    if (typeof product !== 'object' || product === null || Array.isArray(product)) {
        return { valid: false, code: 'INVALID_PRODUCT_CATEGORY', message: 'product must be an object' };
    }
    if (!isValidProductCategorySlug(product.categorySlug)) {
        return { valid: false, code: 'INVALID_PRODUCT_CATEGORY', message: 'unrecognized product category' };
    }
    if (!isActiveProductCategory(product.categorySlug)) {
        return { valid: false, code: 'INVALID_PRODUCT_CATEGORY', message: 'product category is not active' };
    }

    const category = getProductCategoryBySlug(product.categorySlug);
    if (category.brandModelRequired) {
        if (!isTrimmedString(product.brand, BRAND_MODEL_MAX_LENGTH)) {
            return { valid: false, code: 'PRODUCT_BRAND_REQUIRED', message: 'brand is required for this product category' };
        }
        if (!isTrimmedString(product.model, BRAND_MODEL_MAX_LENGTH)) {
            return { valid: false, code: 'PRODUCT_MODEL_REQUIRED', message: 'model is required for this product category' };
        }
    } else {
        if (product.brand !== undefined && !isTrimmedString(product.brand, BRAND_MODEL_MAX_LENGTH)) {
            return { valid: false, code: 'INVALID_PRODUCT_BRAND', message: 'brand must be a non-empty string when provided' };
        }
        if (product.model !== undefined && !isTrimmedString(product.model, BRAND_MODEL_MAX_LENGTH)) {
            return { valid: false, code: 'INVALID_PRODUCT_MODEL', message: 'model must be a non-empty string when provided' };
        }
    }

    if (product.serialNumber !== undefined && !isTrimmedString(product.serialNumber, SERIAL_NUMBER_MAX_LENGTH)) {
        return { valid: false, code: 'INVALID_SERIAL_NUMBER', message: 'serialNumber must be a non-empty string when provided' };
    }

    return { valid: true };
}

function buildProductSnapshot(product) {
    const snapshot = { categorySlug: product.categorySlug.trim() };
    if (product.brand !== undefined) snapshot.brand = product.brand.trim();
    if (product.model !== undefined) snapshot.model = product.model.trim();
    if (product.serialNumber !== undefined) snapshot.serialNumber = product.serialNumber.trim();
    return snapshot;
}

// ---- Service definition match (definition itself is fetched by the caller) ----

// `definition` is an already-fetched, already-safe-projected service
// definition document (see models/ServiceDefinition.js#findById) - this
// function only validates it, never fetches it. Never trusts a
// client-supplied repairCategorySlug over the definition's own value.
function validateServiceDefinitionMatch(definition, productCategorySlug) {
    if (!definition) {
        return { valid: false, code: 'SERVICE_DEFINITION_NOT_FOUND', message: 'service definition not found' };
    }
    if (definition.isActive !== true) {
        return { valid: false, code: 'SERVICE_NOT_ACTIVE', message: 'service definition is not active' };
    }
    if (definition.productCategorySlug !== productCategorySlug) {
        return { valid: false, code: 'SERVICE_PRODUCT_MISMATCH', message: 'service definition does not belong to the selected product category' };
    }
    return { valid: true };
}

// ---- Damage description ----

function validateDamageDescription(description) {
    if (description === undefined || description === null) {
        return { valid: false, code: 'DAMAGE_DESCRIPTION_REQUIRED', message: 'damage description is required' };
    }
    if (typeof description !== 'string') {
        return { valid: false, code: 'INVALID_DAMAGE_DESCRIPTION', message: 'damage description must be a string' };
    }
    const trimmed = description.trim();
    if (trimmed.length < DAMAGE_DESCRIPTION_MIN_LENGTH || trimmed.length > DAMAGE_DESCRIPTION_MAX_LENGTH) {
        return {
            valid: false, code: 'INVALID_DAMAGE_DESCRIPTION',
            message: `damage description must be between ${DAMAGE_DESCRIPTION_MIN_LENGTH} and ${DAMAGE_DESCRIPTION_MAX_LENGTH} characters`
        };
    }
    // Stored as plain text only - never interpreted as HTML/markup by the
    // server. Rendering safety for arbitrary characters (<, >, &, etc.)
    // remains a client responsibility; this only bounds type/length.
    return { valid: true };
}

// ---- Damage images ----

function validateDamageImageEntry(image) {
    if (typeof image !== 'object' || image === null || Array.isArray(image)) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: 'each damage image must be an object' };
    }
    const unexpectedField = Object.keys(image).find((key) => !DAMAGE_IMAGE_FIELDS.includes(key));
    if (unexpectedField !== undefined) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: `damage image contains an unexpected field: ${unexpectedField}` };
    }

    if (typeof image.url !== 'string' || !image.url.startsWith('https://')) {
        // Also the natural rejection path for a data: URI / inline base64
        // payload - such a value can never start with "https://".
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: 'image url must be an https:// URL, not inline/base64 data' };
    }
    if (!isTrimmedString(image.storageKey, 200)) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: 'image storageKey must be a non-empty string' };
    }
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(image.mimeType)) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: `image mimeType must be one of: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}` };
    }
    if (!isPositiveInteger(image.size, MAX_IMAGE_SIZE_BYTES)) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: `image size must be a positive integer of at most ${MAX_IMAGE_SIZE_BYTES} bytes` };
    }
    // Nullable as of Phase 6.4 Unit 1: neither the upload-session nor the
    // finalize request contract provides a channel for real dimension input
    // (no client-side image parsing exists yet, and installing a
    // server-side image-parsing library was explicitly out of scope for
    // that unit) - so width/height are display-only when present, and
    // absent is equally valid. Never treated as a security authority either
    // way. Real dimension verification is deferred to a future
    // image-processing unit.
    if (image.width !== undefined && image.width !== null && !isPositiveInteger(image.width, MAX_IMAGE_DIMENSION_PX)) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: 'image width must be a positive, bounded integer when provided' };
    }
    if (image.height !== undefined && image.height !== null && !isPositiveInteger(image.height, MAX_IMAGE_DIMENSION_PX)) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: 'image height must be a positive, bounded integer when provided' };
    }
    const uploadedAt = image.uploadedAt instanceof Date ? image.uploadedAt : new Date(image.uploadedAt);
    if (Number.isNaN(uploadedAt.getTime())) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: 'image uploadedAt must be a valid date' };
    }
    if (image.uploadedByRole !== ALLOWED_UPLOADED_BY_ROLE) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGE', message: `image uploadedByRole must be "${ALLOWED_UPLOADED_BY_ROLE}"` };
    }

    return { valid: true };
}

// `minImages` is always passed explicitly by the caller (see
// STAGED_MIN_DAMAGE_IMAGES / MIN_DAMAGE_IMAGES above) - never defaulted
// silently inside this function, so the staged-compatibility decision stays
// visible at the call site rather than hidden in this module.
function validateDamageImages(images, { minImages }) {
    if (!Array.isArray(images)) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGES', message: 'damage images must be an array' };
    }
    if (images.length < minImages) {
        return { valid: false, code: 'INVALID_DAMAGE_IMAGES', message: `at least ${minImages} damage image(s) required` };
    }
    if (images.length > MAX_DAMAGE_IMAGES) {
        return { valid: false, code: 'TOO_MANY_DAMAGE_IMAGES', message: `at most ${MAX_DAMAGE_IMAGES} damage images allowed` };
    }

    for (const image of images) {
        const result = validateDamageImageEntry(image);
        if (!result.valid) return result;
    }

    const seenStorageKeys = new Set();
    for (const image of images) {
        if (seenStorageKeys.has(image.storageKey)) {
            return { valid: false, code: 'DUPLICATE_DAMAGE_IMAGE', message: `duplicate storageKey: ${image.storageKey}` };
        }
        seenStorageKeys.add(image.storageKey);
    }

    return { valid: true };
}

function buildDamageSnapshot(damage) {
    return {
        description: damage.description.trim(),
        images: damage.images.map((image) => ({
            url: image.url,
            storageKey: image.storageKey.trim(),
            mimeType: image.mimeType,
            size: image.size,
            width: image.width === undefined ? null : image.width,
            height: image.height === undefined ? null : image.height,
            uploadedAt: image.uploadedAt instanceof Date ? image.uploadedAt : new Date(image.uploadedAt),
            uploadedByRole: image.uploadedByRole
        }))
    };
}

// ---- Service location ----

function validateServiceLocation(serviceLocation) {
    if (typeof serviceLocation !== 'object' || serviceLocation === null || Array.isArray(serviceLocation)) {
        return { valid: false, code: 'INVALID_SERVICE_LOCATION', message: 'serviceLocation must be an object' };
    }
    if (!isTrimmedString(serviceLocation.region, LOCATION_FIELD_MAX_LENGTH)) {
        return { valid: false, code: 'INVALID_SERVICE_LOCATION', message: 'serviceLocation.region is required' };
    }
    if (!isTrimmedString(serviceLocation.district, LOCATION_FIELD_MAX_LENGTH)) {
        return { valid: false, code: 'INVALID_SERVICE_LOCATION', message: 'serviceLocation.district is required' };
    }
    if (!isTrimmedString(serviceLocation.address, LOCATION_FIELD_MAX_LENGTH)) {
        return { valid: false, code: 'INVALID_SERVICE_LOCATION', message: 'serviceLocation.address is required' };
    }
    return { valid: true };
}

function buildServiceLocationSnapshot(serviceLocation) {
    return {
        region: serviceLocation.region.trim(),
        district: serviceLocation.district.trim(),
        address: serviceLocation.address.trim()
    };
}

// ---- Client pricing rejection ----

// Checked against the raw request body (top-level keys, plus the nested
// `pricing`/`service` objects if present) - a v2 request carrying any
// client-supplied pricing-authority field is rejected outright, never
// silently stripped, so tampering is always a loud, obvious error.
function findClientPricingField(body) {
    if (typeof body !== 'object' || body === null) return null;
    return CLIENT_PRICING_FORBIDDEN_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(body, field)) || null;
}

function validateClientPricingAbsence(body) {
    const forbiddenField = findClientPricingField(body);
    if (forbiddenField) {
        return { valid: false, code: 'CLIENT_PRICING_NOT_ALLOWED', message: `client-supplied field "${forbiddenField}" is not allowed on a v2 repair request` };
    }
    return { valid: true };
}

module.exports = {
    BRAND_MODEL_MAX_LENGTH,
    SERIAL_NUMBER_MAX_LENGTH,
    DAMAGE_DESCRIPTION_MIN_LENGTH,
    DAMAGE_DESCRIPTION_MAX_LENGTH,
    LOCATION_FIELD_MAX_LENGTH,
    MIN_DAMAGE_IMAGES,
    MAX_DAMAGE_IMAGES,
    STAGED_MIN_DAMAGE_IMAGES,
    ALLOWED_IMAGE_MIME_TYPES,
    MAX_IMAGE_SIZE_BYTES,
    MAX_IMAGE_DIMENSION_PX,
    CLIENT_PRICING_FORBIDDEN_FIELDS,
    validateProductInput,
    buildProductSnapshot,
    validateServiceDefinitionMatch,
    validateDamageDescription,
    validateDamageImageEntry,
    validateDamageImages,
    buildDamageSnapshot,
    validateServiceLocation,
    buildServiceLocationSnapshot,
    validateClientPricingAbsence
};
