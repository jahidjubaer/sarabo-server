const { getProductCategoryBySlug } = require('../utils/productCategory');
const {
    BRAND_MODEL_MAX_LENGTH,
    DAMAGE_DESCRIPTION_MIN_LENGTH,
    DAMAGE_DESCRIPTION_MAX_LENGTH,
} = require('../utils/repairRequestV2');

const FOLLOW_UP_MAX_LENGTH = 200;
const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

class RequestDraftError extends Error {
    constructor(code, status, message) {
        super(message);
        this.name = 'RequestDraftError';
        this.code = code;
        this.status = status;
    }
}

const unavailable = () => new RequestDraftError('AI_HELPER_UNAVAILABLE', 503, 'The AI helper is not available right now. Please fill in the form yourself.');
const timedOut = () => new RequestDraftError('AI_HELPER_TIMEOUT', 504, 'The AI helper took too long. Please try again or fill in the form yourself.');
const unusable = () => new RequestDraftError('AI_HELPER_INVALID_RESPONSE', 502, 'The AI helper could not understand that. Please try again or fill in the form yourself.');

// Active services whose device category is also active - the same set the
// create-request form offers.
function buildCatalogue(documents) {
    const categories = new Map();
    const services = [];
    for (const doc of documents || []) {
        if (!doc || doc.isActive !== true || typeof doc.label !== 'string') continue;
        const category = getProductCategoryBySlug(doc.productCategorySlug);
        if (!category || category.isActive !== true) continue;
        categories.set(category.slug, { slug: category.slug, label: category.label });
        services.push({
            id: doc._id.toString(),
            categorySlug: category.slug,
            label: doc.label.trim(),
            description: typeof doc.description === 'string' ? doc.description.trim().slice(0, 200) : '',
        });
    }
    return { categories: [...categories.values()], services };
}

function cleanOptionalText(value, maxLength) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > maxLength) return null;
    if (/^(unknown|n\/a|none|null)$/i.test(trimmed)) return null;
    return trimmed;
}

// Never trust the model's ids: a service must be in the catalogue sent, and
// its device category wins over whatever category the model named. Anything
// out of bounds becomes null, so the customer simply fills that field in.
function validateDraft(raw, catalogue) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw unusable();

    const service = typeof raw.serviceId === 'string'
        ? catalogue.services.find((s) => s.id === raw.serviceId) || null
        : null;
    let productCategorySlug = null;
    if (service) {
        productCategorySlug = service.categorySlug;
    } else if (typeof raw.deviceCategory === 'string' && catalogue.categories.some((c) => c.slug === raw.deviceCategory)) {
        productCategorySlug = raw.deviceCategory;
    }
    // A service from another device than the one the model named means it was
    // confused: keep neither guess about the repair.
    const serviceMatchesCategory = !service || typeof raw.deviceCategory !== 'string' || raw.deviceCategory === service.categorySlug;

    let damageDescription = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (damageDescription.length < DAMAGE_DESCRIPTION_MIN_LENGTH || damageDescription.length > DAMAGE_DESCRIPTION_MAX_LENGTH) {
        damageDescription = null;
    }

    return {
        productCategorySlug,
        serviceDefinitionId: service && serviceMatchesCategory ? service.id : null,
        productBrand: cleanOptionalText(raw.brand, BRAND_MODEL_MAX_LENGTH),
        productModel: cleanOptionalText(raw.model, BRAND_MODEL_MAX_LENGTH),
        damageDescription,
        confidence: CONFIDENCE_LEVELS.includes(raw.confidence) && service && serviceMatchesCategory ? raw.confidence : 'low',
        followUpQuestion: cleanOptionalText(raw.followUpQuestion, FOLLOW_UP_MAX_LENGTH),
    };
}

function createAiRequestDraftService({ provider = null, config, serviceDefinitionModel }) {
    const isAvailable = () => Boolean(config && config.enabled && provider && typeof provider.generateDraft === 'function');

    async function draftRequest({ text, requestId }) {
        if (!isAvailable()) throw unavailable();
        const catalogue = buildCatalogue(await serviceDefinitionModel.findMany({ isActive: true }));
        if (catalogue.services.length === 0) throw unavailable();

        const abortController = new AbortController();
        let timeoutId;
        const timeout = new Promise((resolve, reject) => {
            timeoutId = setTimeout(() => {
                reject(timedOut());
                abortController.abort();
            }, config.timeoutMs);
        });

        let raw;
        try {
            raw = await Promise.race([
                Promise.resolve().then(() => provider.generateDraft({ text, catalogue, signal: abortController.signal, requestId })),
                timeout,
            ]);
        } catch (error) {
            if (error instanceof RequestDraftError) throw error;
            if (error && error.code === 'PROVIDER_INVALID_RESPONSE') throw unusable();
            if (error && error.code === 'PROVIDER_TIMEOUT') throw timedOut();
            throw unavailable();
        } finally {
            clearTimeout(timeoutId);
        }
        return validateDraft(raw, catalogue);
    }

    return { isAvailable, draftRequest };
}

module.exports = {
    RequestDraftError,
    buildCatalogue,
    validateDraft,
    createAiRequestDraftService,
};
