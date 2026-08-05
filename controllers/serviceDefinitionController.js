const { ObjectId } = require('mongodb');
const { isValidProductCategorySlug, isActiveProductCategory } = require('../utils/productCategory');
const { isValidRepairCategorySlug, isActiveRepairCategory } = require('../utils/repairCategory');
const { validateProductRepairPair } = require('../utils/serviceTaxonomy');

// Public read-only response shape only - deliberately excludes internal
// pricing-mutation metadata (pricingRule.version), createdAt/updatedAt, and
// any database implementation field. pricingEstimate uses its own min/max
// naming here, distinct from services/pricingService.js's internal
// estimateMin/estimateMax/pricingVersion shape (that helper is for the
// future repair-request v2 creation path, not this public API).
function serializeServiceDefinition(doc) {
    return {
        id: doc._id.toString(),
        productCategorySlug: doc.productCategorySlug,
        repairCategorySlug: doc.repairCategorySlug,
        label: doc.label,
        description: doc.description,
        pricingEstimate: {
            currency: doc.pricingRule.currency,
            min: doc.pricingRule.baseMin,
            max: doc.pricingRule.baseMax,
            inspectionFee: doc.pricingRule.inspectionFee
        },
        requiredExpertiseLevel: doc.requiredExpertiseLevel,
        estimatedDurationMinutes: doc.estimatedDurationMinutes,
        inspectionRequired: doc.inspectionRequired,
        imageRequirements: doc.imageRequirements
    };
}

// Validates the optional productCategorySlug/repairCategorySlug query
// filters using the exact same canonical taxonomy helpers the rest of the
// codebase already trusts (Phase 6.3 Unit 1) - never a raw regex/operator
// object reaches MongoDB, since only these two known, whitelisted keys are
// ever read off req.query and only after passing validation here.
function validateListFilters(query) {
    const hasProduct = typeof query.productCategorySlug === 'string' && query.productCategorySlug.length > 0;
    const hasRepair = typeof query.repairCategorySlug === 'string' && query.repairCategorySlug.length > 0;

    if (hasProduct && hasRepair) {
        return validateProductRepairPair(query.productCategorySlug, query.repairCategorySlug);
    }
    if (hasProduct) {
        if (!isValidProductCategorySlug(query.productCategorySlug)) {
            return { valid: false, code: 'INVALID_PRODUCT_CATEGORY', message: 'unrecognized product category' };
        }
        if (!isActiveProductCategory(query.productCategorySlug)) {
            return { valid: false, code: 'INACTIVE_PRODUCT_CATEGORY', message: 'product category is not active' };
        }
        return { valid: true };
    }
    if (hasRepair) {
        if (!isValidRepairCategorySlug(query.repairCategorySlug)) {
            return { valid: false, code: 'INVALID_REPAIR_CATEGORY', message: 'unrecognized repair category' };
        }
        if (!isActiveRepairCategory(query.repairCategorySlug)) {
            return { valid: false, code: 'INACTIVE_REPAIR_CATEGORY', message: 'repair category is not active' };
        }
        return { valid: true };
    }
    return { valid: true };
}

class ServiceDefinitionController {
    constructor(models) {
        this.ServiceDefinition = models.ServiceDefinition;
    }

    // Public, unauthenticated - always active-only, unconditionally (there is
    // no way to request inactive rows through this route in this unit; that
    // is deliberately deferred to a future admin-CRUD unit, see Phase H's
    // "should inactive definitions be admin-only" decision in the unit
    // report). The small seed-catalog size makes pagination unnecessary here.
    async listServiceDefinitions(req, res) {
        try {
            const filterResult = validateListFilters(req.query);
            if (!filterResult.valid) {
                return res.status(400).send({ message: filterResult.message, code: filterResult.code });
            }

            const query = { isActive: true };
            if (typeof req.query.productCategorySlug === 'string' && req.query.productCategorySlug.length > 0) {
                query.productCategorySlug = req.query.productCategorySlug;
            }
            if (typeof req.query.repairCategorySlug === 'string' && req.query.repairCategorySlug.length > 0) {
                query.repairCategorySlug = req.query.repairCategorySlug;
            }

            const docs = await this.ServiceDefinition.findMany(query);
            res.send({ serviceDefinitions: docs.map(serializeServiceDefinition) });
        } catch (error) {
            res.status(500).send({ message: 'Error fetching service definitions', code: 'INTERNAL_ERROR' });
        }
    }

    // Public, unauthenticated - a well-formed id belonging to an inactive (or
    // nonexistent) definition returns the same 404, so this route can never
    // be used to distinguish "inactive" from "does not exist".
    async getServiceDefinitionById(req, res) {
        try {
            const { id } = req.params;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid service definition id', code: 'INVALID_SERVICE_DEFINITION_ID' });
            }

            const doc = await this.ServiceDefinition.findById(id);
            if (!doc || doc.isActive !== true) {
                return res.status(404).send({ message: 'service definition not found', code: 'SERVICE_DEFINITION_NOT_FOUND' });
            }

            res.send(serializeServiceDefinition(doc));
        } catch (error) {
            res.status(500).send({ message: 'Error fetching service definition', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = ServiceDefinitionController;
