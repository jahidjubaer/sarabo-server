const { getProductCategoryBySlug } = require('../utils/productCategory');
const { withMinimumInspectionFee } = require('../utils/inspectionFee');

const STATIC_SUPPORT_KNOWLEDGE = Object.freeze({
    identity: 'Sarabo is an electronics and appliance repair service-management platform.',
    lifecycle: Object.freeze([
        'A customer creates a repair request.',
        'An admin assigns a technician and the technician accepts the assignment.',
        'The technician inspects the device and submits an itemised quotation.',
        'The customer approves or rejects the quotation.',
        'Payment follows an approved quotation before repair work proceeds.',
        'The technician completes the repair and the customer confirms receipt.',
    ]),
    topics: Object.freeze([
        Object.freeze({
            id: 'repair-request',
            guidance: 'Customers create repair requests from their dashboard by selecting a device category, describing the fault, and providing the requested service and location details.',
        }),
        Object.freeze({
            id: 'inspection-and-quotation',
            guidance: 'Inspection determines the repair need. The technician then submits an itemised quotation for customer review; displayed catalogue estimates are indicative and final pricing is confirmed through the quotation.',
        }),
        Object.freeze({
            id: 'quote-decision',
            guidance: 'Customers may approve or reject a submitted quotation. Rejecting a quotation does not authorize repair work or payment.',
        }),
        Object.freeze({
            id: 'payment',
            guidance: 'Payment is only appropriate after a quotation has been approved. AI support cannot initiate, confirm, reverse, or mark a payment.',
        }),
        Object.freeze({
            id: 'tracking',
            guidance: 'Customers can use Sarabo tracking to view customer-facing repair progress. Tracking codes must be entered on the tracking page and must not be shared with AI support.',
        }),
        Object.freeze({
            id: 'damage-images',
            guidance: 'Damage images should clearly show the device and visible fault without exposing passwords, payment information, personal documents, or unrelated people.',
        }),
        Object.freeze({
            id: 'email-verification',
            guidance: 'Sarabo may require a verified Firebase email before sensitive customer actions. Verification status cannot be changed by AI support.',
        }),
        Object.freeze({
            id: 'receipt-confirmation',
            guidance: 'Receipt confirmation is completed by the customer after the repaired item is returned. AI support cannot confirm receipt on a customer\'s behalf.',
        }),
    ]),
    limitations: Object.freeze([
        'AI support provides guidance and navigation only and cannot change repair, payment, role, assignment, refund, or settlement state.',
        'No automatic human-support ticket or handoff exists in this version. Issues involving disputes, refunds, missing or damaged devices, technician complaints, unresolved account access, or security concerns require human review through a support channel published by Sarabo.',
        'When Sarabo data is unavailable, the assistant must say it cannot verify service availability, pricing, or account-specific state.',
    ]),
});

function safeEstimate(pricingRule) {
    if (!pricingRule || typeof pricingRule !== 'object') return null;
    const { currency, baseMin, baseMax, inspectionFee } = pricingRule;
    if (
        typeof currency !== 'string' || currency.length === 0 ||
        !Number.isFinite(baseMin) || !Number.isFinite(baseMax) || !Number.isFinite(inspectionFee)
    ) {
        return null;
    }
    // The fee customers are actually charged, never below the floor.
    return { currency, min: baseMin, max: baseMax, inspectionFee: withMinimumInspectionFee(inspectionFee, baseMax) };
}

function serializeLiveServiceDefinitions(documents) {
    const categories = new Map();
    for (const document of documents) {
        if (!document || document.isActive !== true || typeof document.label !== 'string') continue;
        const category = getProductCategoryBySlug(document.productCategorySlug);
        if (!category) continue;
        const estimate = safeEstimate(document.pricingRule);
        if (!estimate) continue;

        if (!categories.has(category.slug)) {
            categories.set(category.slug, {
                categorySlug: category.slug,
                categoryLabel: category.label,
                services: [],
            });
        }
        categories.get(category.slug).services.push({
            name: document.label.trim(),
            indicativeEstimate: estimate,
        });
    }

    return [...categories.values()]
        .map((category) => ({
            ...category,
            services: category.services.sort((left, right) => left.name.localeCompare(right.name)),
        }))
        .sort((left, right) => left.categoryLabel.localeCompare(right.categoryLabel));
}

function createSupportKnowledgeService({ serviceDefinitionModel, connectDatabase }) {
    async function getLiveCatalogue() {
        if (!serviceDefinitionModel || typeof connectDatabase !== 'function') {
            return { availability: 'unavailable', categories: [] };
        }
        try {
            await connectDatabase();
            const documents = await serviceDefinitionModel.findMany({ isActive: true });
            return {
                availability: 'available',
                categories: serializeLiveServiceDefinitions(documents),
            };
        } catch {
            return { availability: 'unavailable', categories: [] };
        }
    }

    async function buildKnowledge() {
        return {
            version: 1,
            staticGuidance: STATIC_SUPPORT_KNOWLEDGE,
            liveCatalogue: await getLiveCatalogue(),
        };
    }

    return { buildKnowledge, getLiveCatalogue };
}

module.exports = {
    STATIC_SUPPORT_KNOWLEDGE,
    serializeLiveServiceDefinitions,
    createSupportKnowledgeService,
};
