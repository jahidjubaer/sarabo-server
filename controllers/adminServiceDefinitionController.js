const { ObjectId } = require('mongodb');
const { validateServiceDefinitionInput, buildDocumentFromInput, WRITABLE_TOP_LEVEL_FIELDS } = require('../models/ServiceDefinition');
const { PRODUCT_CATEGORY_SLUGS } = require('../utils/productCategory');
const { getAllowedRepairCategories, validateProductRepairPair } = require('../utils/serviceTaxonomy');
const { ACTIVE_STATUSES, ASSIGNMENT_PENDING } = require('../utils/repairRequestStatus');
const { minimumInspectionFee } = require('../utils/inspectionFee');

// A refusal when the inspection fee is below the floor for this price range
// (utils/inspectionFee.js), or null.
function inspectionFeeFloorRefusal(pricingRule) {
    const floor = minimumInspectionFee(pricingRule.baseMax);
    if (Number(pricingRule.inspectionFee) >= floor) return null;
    return { message: `the inspection fee must be at least ${floor} BDT for this price range`, code: 'INSPECTION_FEE_TOO_LOW', minimumInspectionFee: floor };
}

// Requests that still need a technician. While a service is switched off
// these cannot be assigned (matching and assignment require an active service
// - see services/technicianEligibilityService.js#validateCurrentServiceDefinition),
// so switching one off with waiting requests needs an explicit acknowledgement.
const AWAITING_ASSIGNMENT_STATUSES = ['pending-pickup', ASSIGNMENT_PENDING];

// Fields an admin may change on an existing service. The product/repair pair
// is its identity (requests and the unique index rely on it) and never changes.
const EDITABLE_FIELDS = ['label', 'description', 'isActive', 'requiredExpertiseLevel', 'estimatedDurationMinutes', 'inspectionRequired', 'imageRequirements'];
const EDITABLE_PRICE_FIELDS = ['baseMin', 'baseMax', 'inspectionFee'];

function normalizeEmail(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function serializeAdminDefinition(doc, counts) {
    return {
        id: doc._id.toString(),
        productCategorySlug: doc.productCategorySlug,
        repairCategorySlug: doc.repairCategorySlug,
        label: doc.label,
        description: doc.description,
        isActive: doc.isActive,
        pricingRule: doc.pricingRule,
        minimumInspectionFee: minimumInspectionFee(doc.pricingRule && doc.pricingRule.baseMax),
        requiredExpertiseLevel: doc.requiredExpertiseLevel,
        estimatedDurationMinutes: doc.estimatedDurationMinutes,
        inspectionRequired: doc.inspectionRequired,
        imageRequirements: doc.imageRequirements,
        createdAt: doc.createdAt ?? null,
        updatedAt: doc.updatedAt ?? null,
        updatedBy: doc.updatedBy ?? null,
        waitingRequests: counts?.waiting ?? 0,
        openRequests: counts?.open ?? 0,
    };
}

// Admin-only service catalogue management (quick-wins phase). Every write is
// validated by the same validateServiceDefinitionInput the seed uses, and the
// server - never the client - decides the pricing version. Existing requests
// keep the price snapshot they were created with, so an edit only affects new
// requests.
class AdminServiceDefinitionController {
    constructor(models, collections) {
        this.collections = collections;
    }

    async requestCounts(definitionIds) {
        const rows = await this.collections.repairRequests.aggregate([
            { $match: { 'service.definitionId': { $in: definitionIds }, deliveryStatus: { $in: [...new Set([...ACTIVE_STATUSES, ...AWAITING_ASSIGNMENT_STATUSES])] } } },
            { $group: {
                _id: '$service.definitionId',
                open: { $sum: 1 },
                waiting: { $sum: { $cond: [{ $in: ['$deliveryStatus', AWAITING_ASSIGNMENT_STATUSES] }, 1, 0] } },
            } },
        ]).toArray();
        return new Map(rows.map((row) => [row._id, { open: row.open, waiting: row.waiting }]));
    }

    // GET /admin/service-definitions - every service, active or not, with how
    // many open/waiting requests use it, plus the allowed product/repair pairs
    // that have no service yet (what "Add service" can offer).
    async list(req, res) {
        try {
            const docs = await this.collections.serviceDefinitions.find({}).sort({ productCategorySlug: 1, repairCategorySlug: 1 }).toArray();
            const counts = await this.requestCounts(docs.map((doc) => doc._id.toString()));
            const existing = new Set(docs.map((doc) => `${doc.productCategorySlug}/${doc.repairCategorySlug}`));
            const availablePairs = [];
            for (const productCategorySlug of PRODUCT_CATEGORY_SLUGS) {
                for (const repairCategorySlug of getAllowedRepairCategories(productCategorySlug) || []) {
                    if (existing.has(`${productCategorySlug}/${repairCategorySlug}`)) continue;
                    if (validateProductRepairPair(productCategorySlug, repairCategorySlug).valid) availablePairs.push({ productCategorySlug, repairCategorySlug });
                }
            }
            res.send({
                serviceDefinitions: docs.map((doc) => serializeAdminDefinition(doc, counts.get(doc._id.toString()))),
                availablePairs,
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading the service catalogue', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /admin/service-definitions - a new service for an allowed pair.
    // The pricing version always starts at 1 and the currency is always BDT.
    async create(req, res) {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const input = {};
            for (const field of WRITABLE_TOP_LEVEL_FIELDS) input[field] = body[field];
            const pricing = body.pricingRule && typeof body.pricingRule === 'object' ? body.pricingRule : {};
            input.pricingRule = { currency: 'BDT', baseMin: pricing.baseMin, baseMax: pricing.baseMax, inspectionFee: pricing.inspectionFee, version: 1 };
            const validation = validateServiceDefinitionInput(input);
            if (!validation.valid) {
                return res.status(400).send({ message: validation.message, code: validation.code });
            }
            const feeRefusal = inspectionFeeFloorRefusal(input.pricingRule);
            if (feeRefusal) return res.status(400).send(feeRefusal);
            const now = new Date();
            const doc = { ...buildDocumentFromInput(input, now), createdBy: normalizeEmail(req.decoded_email), updatedBy: normalizeEmail(req.decoded_email) };
            try {
                const result = await this.collections.serviceDefinitions.insertOne(doc);
                return res.status(201).send(serializeAdminDefinition({ ...doc, _id: result.insertedId }, null));
            } catch (error) {
                if (error && error.code === 11000) {
                    return res.status(409).send({ message: 'a service for this product and repair already exists', code: 'SERVICE_DEFINITION_EXISTS' });
                }
                throw error;
            }
        } catch (error) {
            res.status(500).send({ message: 'Error creating the service', code: 'INTERNAL_ERROR' });
        }
    }

    // PATCH /admin/service-definitions/:id
    // Body: { expectedUpdatedAt, changes: { label?, description?, isActive?,
    //         pricingRule?: { baseMin?, baseMax?, inspectionFee? }, ... },
    //         acknowledgeWaitingRequests? }
    // - expectedUpdatedAt must match the stored value: two admins can never
    //   silently overwrite each other.
    // - a price change increments pricingRule.version (new requests snapshot it).
    // - switching a service off while requests wait for a technician needs
    //   acknowledgeWaitingRequests: true (the answer carries the count).
    async update(req, res) {
        try {
            if (!ObjectId.isValid(req.params.id)) {
                return res.status(400).send({ message: 'invalid service definition id', code: 'INVALID_SERVICE_DEFINITION_ID' });
            }
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            const changes = body.changes && typeof body.changes === 'object' && !Array.isArray(body.changes) ? body.changes : null;
            if (!changes || Object.keys(changes).length === 0) {
                return res.status(400).send({ message: 'no changes supplied', code: 'NO_CHANGES' });
            }
            const unknown = Object.keys(changes).find((key) => key !== 'pricingRule' && !EDITABLE_FIELDS.includes(key));
            if (unknown) {
                return res.status(400).send({ message: `field cannot be changed: ${unknown}`, code: 'FIELD_NOT_EDITABLE' });
            }
            if (changes.pricingRule !== undefined) {
                const bad = typeof changes.pricingRule !== 'object' || changes.pricingRule === null || Array.isArray(changes.pricingRule)
                    || Object.keys(changes.pricingRule).some((key) => !EDITABLE_PRICE_FIELDS.includes(key));
                if (bad) return res.status(400).send({ message: 'only baseMin, baseMax and inspectionFee can be changed', code: 'FIELD_NOT_EDITABLE' });
            }

            const _id = new ObjectId(req.params.id);
            const current = await this.collections.serviceDefinitions.findOne({ _id });
            if (!current) {
                return res.status(404).send({ message: 'service definition not found', code: 'SERVICE_DEFINITION_NOT_FOUND' });
            }
            const expected = body.expectedUpdatedAt ? new Date(body.expectedUpdatedAt) : null;
            if (!expected || Number.isNaN(expected.getTime()) || !current.updatedAt || expected.getTime() !== new Date(current.updatedAt).getTime()) {
                return res.status(409).send({ message: 'this service was changed by someone else - reload it and try again', code: 'SERVICE_DEFINITION_CHANGED' });
            }

            const candidate = {};
            for (const field of WRITABLE_TOP_LEVEL_FIELDS) candidate[field] = current[field];
            for (const field of EDITABLE_FIELDS) if (changes[field] !== undefined) candidate[field] = changes[field];
            const priceChanges = changes.pricingRule || {};
            const priceChanged = EDITABLE_PRICE_FIELDS.some((field) => priceChanges[field] !== undefined && priceChanges[field] !== current.pricingRule[field]);
            candidate.pricingRule = {
                ...current.pricingRule,
                ...priceChanges,
                version: priceChanged ? current.pricingRule.version + 1 : current.pricingRule.version,
            };
            const validation = validateServiceDefinitionInput(candidate);
            if (!validation.valid) {
                return res.status(400).send({ message: validation.message, code: validation.code });
            }
            // Checked only when prices change, so an old service below the
            // floor can still be renamed or switched off.
            const feeRefusal = priceChanged ? inspectionFeeFloorRefusal(candidate.pricingRule) : null;
            if (feeRefusal) return res.status(400).send(feeRefusal);

            if (current.isActive === true && candidate.isActive === false) {
                const counts = (await this.requestCounts([current._id.toString()])).get(current._id.toString());
                const waiting = counts?.waiting ?? 0;
                if (waiting > 0 && body.acknowledgeWaitingRequests !== true) {
                    return res.status(409).send({
                        message: `${waiting} request(s) are waiting for a technician and cannot be assigned while this service is off`,
                        code: 'SERVICE_HAS_WAITING_REQUESTS',
                        waitingRequests: waiting,
                    });
                }
            }

            const built = buildDocumentFromInput(candidate, new Date());
            const set = { updatedAt: built.updatedAt, updatedBy: normalizeEmail(req.decoded_email) };
            for (const field of WRITABLE_TOP_LEVEL_FIELDS) set[field] = built[field];
            const result = await this.collections.serviceDefinitions.updateOne({ _id, updatedAt: current.updatedAt }, { $set: set });
            if (result.matchedCount === 0) {
                return res.status(409).send({ message: 'this service was changed by someone else - reload it and try again', code: 'SERVICE_DEFINITION_CHANGED' });
            }
            const updated = await this.collections.serviceDefinitions.findOne({ _id });
            const counts = (await this.requestCounts([updated._id.toString()])).get(updated._id.toString());
            return res.send(serializeAdminDefinition(updated, counts));
        } catch (error) {
            res.status(500).send({ message: 'Error updating the service', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = AdminServiceDefinitionController;
module.exports.AWAITING_ASSIGNMENT_STATUSES = AWAITING_ASSIGNMENT_STATUSES;
