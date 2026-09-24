// Admin service catalogue editor (quick-wins phase): list with request
// counts, validated create, optimistic-concurrency edits, automatic pricing
// version bumps, and the switch-off acknowledgement for waiting requests.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runAdminServiceDefinitionTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const AdminController = require('../controllers/adminServiceDefinitionController');
    const ServiceDefinitionController = require('../controllers/serviceDefinitionController');
    const serviceDefinitionRoutes = require('../routes/serviceDefinitions');
    const { verifyFBToken, verifyAdmin } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.serviceDefinitions.dbName.includes('test') || c.serviceDefinitions.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const admin = new AdminController(models, c);
    const publicController = new ServiceDefinitionController(models);
    const ADMIN = 'catalogue-admin@example.test';
    const createdDefinitionIds = [];
    const createdRequestIds = [];
    const call = async (method, req) => { const res = fakeRes(); await admin[method]({ decoded_email: ADMIN, params: {}, query: {}, body: {}, ...req }, res); return res; };

    try {
        // ---- list ----
        const listed = await call('list', {});
        const pair = listed.body?.availablePairs?.[0];
        logTest('Catalogue: admin list returns services with counts and the pairs still available',
            listed.statusCode === 200 && Array.isArray(listed.body.serviceDefinitions)
            && listed.body.serviceDefinitions.every((d) => typeof d.waitingRequests === 'number' && typeof d.openRequests === 'number' && d.pricingRule)
            && !!pair && !listed.body.serviceDefinitions.some((d) => d.productCategorySlug === pair.productCategorySlug && d.repairCategorySlug === pair.repairCategorySlug));

        // ---- create ----
        const baseBody = {
            productCategorySlug: pair.productCategorySlug, repairCategorySlug: pair.repairCategorySlug,
            label: 'Catalogue test service', description: 'Created by the admin catalogue tests.',
            isActive: true, requiredExpertiseLevel: 'intermediate', estimatedDurationMinutes: 60,
            inspectionRequired: true, imageRequirements: { min: 0, max: 3, recommended: true },
            pricingRule: { currency: 'USD', baseMin: 700, baseMax: 1500, inspectionFee: 200, version: 99 },
        };
        const invalid = await call('create', { body: { ...baseBody, pricingRule: { baseMin: 2000, baseMax: 1000, inspectionFee: 0 } } });
        logTest('Catalogue: create rejects an invalid price range', invalid.statusCode === 400 && invalid.body.code === 'BASE_MIN_EXCEEDS_BASE_MAX');
        const created = await call('create', { body: baseBody });
        if (created.body?.id) createdDefinitionIds.push(new ObjectId(created.body.id));
        logTest('Catalogue: create stores a new service with BDT and version 1 (client currency/version ignored)',
            created.statusCode === 201 && created.body.pricingRule.currency === 'BDT' && created.body.pricingRule.version === 1
            && created.body.pricingRule.baseMin === 700 && created.body.updatedBy === ADMIN);
        const duplicate = await call('create', { body: baseBody });
        logTest('Catalogue: a second service for the same pair is refused (409)', duplicate.statusCode === 409 && duplicate.body.code === 'SERVICE_DEFINITION_EXISTS');
        const id = created.body.id;

        // ---- edit ----
        const stale = await call('update', { params: { id }, body: { expectedUpdatedAt: new Date(0).toISOString(), changes: { label: 'Stale edit' } } });
        logTest('Catalogue: an edit based on an old version is refused (409)', stale.statusCode === 409 && stale.body.code === 'SERVICE_DEFINITION_CHANGED');
        const identity = await call('update', { params: { id }, body: { expectedUpdatedAt: created.body.updatedAt, changes: { productCategorySlug: 'smartphone' } } });
        const currency = await call('update', { params: { id }, body: { expectedUpdatedAt: created.body.updatedAt, changes: { pricingRule: { currency: 'USD' } } } });
        logTest('Catalogue: the product/repair pair and the currency cannot be edited',
            identity.statusCode === 400 && identity.body.code === 'FIELD_NOT_EDITABLE' && currency.statusCode === 400 && currency.body.code === 'FIELD_NOT_EDITABLE');
        const relabel = await call('update', { params: { id }, body: { expectedUpdatedAt: created.body.updatedAt, changes: { label: 'Catalogue test service (renamed)' } } });
        logTest('Catalogue: a non-price edit keeps the pricing version', relabel.statusCode === 200 && relabel.body.label.endsWith('(renamed)') && relabel.body.pricingRule.version === 1);
        const reprice = await call('update', { params: { id }, body: { expectedUpdatedAt: relabel.body.updatedAt, changes: { pricingRule: { baseMin: 800, baseMax: 1600 } } } });
        logTest('Catalogue: a price change increments the pricing version', reprice.statusCode === 200 && reprice.body.pricingRule.baseMin === 800 && reprice.body.pricingRule.version === 2);
        const publicList = fakeRes();
        await publicController.listServiceDefinitions({ query: {} }, publicList);
        const publicRow = publicList.body.serviceDefinitions.find((d) => d.id === id);
        logTest('Catalogue: the public list shows the new price', publicRow && publicRow.pricingEstimate.min === 800 && publicRow.pricingEstimate.currency === 'BDT');

        // ---- switch off with a waiting request ----
        const requestSnapshot = { currency: 'BDT', estimateMin: 700, estimateMax: 1500, calculationVersion: 1 };
        const { insertedId: waitingId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: 'catalogue-customer@example.test', trackingId: `CAT-${Date.now()}`,
            deliveryStatus: 'pending-pickup', service: { definitionId: id, repairCategorySlug: pair.repairCategorySlug },
            pricing: requestSnapshot, createdAt: new Date(),
        });
        createdRequestIds.push(waitingId);
        const withCounts = (await call('list', {})).body.serviceDefinitions.find((d) => d.id === id);
        logTest('Catalogue: the list counts requests waiting for a technician', withCounts.waitingRequests === 1 && withCounts.openRequests === 1);
        const offRefused = await call('update', { params: { id }, body: { expectedUpdatedAt: reprice.body.updatedAt, changes: { isActive: false } } });
        logTest('Catalogue: switching off with waiting requests needs acknowledgement (409 with the count)',
            offRefused.statusCode === 409 && offRefused.body.code === 'SERVICE_HAS_WAITING_REQUESTS' && offRefused.body.waitingRequests === 1);
        const off = await call('update', { params: { id }, body: { expectedUpdatedAt: reprice.body.updatedAt, changes: { isActive: false }, acknowledgeWaitingRequests: true } });
        logTest('Catalogue: switching off succeeds once acknowledged', off.statusCode === 200 && off.body.isActive === false);
        const publicAfterOff = fakeRes();
        await publicController.listServiceDefinitions({ query: {} }, publicAfterOff);
        logTest('Catalogue: a switched-off service disappears from the public list', !publicAfterOff.body.serviceDefinitions.some((d) => d.id === id));
        const waitingAfter = await c.repairRequests.findOne({ _id: waitingId });
        logTest('Catalogue: existing requests keep their price snapshot', JSON.stringify(waitingAfter.pricing) === JSON.stringify(requestSnapshot));
        const on = await call('update', { params: { id }, body: { expectedUpdatedAt: off.body.updatedAt, changes: { isActive: true } } });
        logTest('Catalogue: a service can be switched back on', on.statusCode === 200 && on.body.isActive === true);

        // ---- routes ----
        const routes = [];
        const capture = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
        serviceDefinitionRoutes({ get: capture('GET'), post: capture('POST'), patch: capture('PATCH') }, { serviceDefinition: publicController, adminServiceDefinition: admin });
        const adminRoutes = routes.filter((route) => route.path.startsWith('/admin/service-definitions'));
        logTest('Catalogue: the admin routes (list/create/edit) require a verified admin',
            adminRoutes.length === 3 && adminRoutes.every((route) => route.handlers.includes(verifyFBToken) && route.handlers.includes(verifyAdmin)));
        logTest('Catalogue: there is no delete route', !routes.some((route) => route.method === 'DELETE'));
    } finally {
        if (createdRequestIds.length) await c.repairRequests.deleteMany({ _id: { $in: createdRequestIds } });
        if (createdDefinitionIds.length) await c.serviceDefinitions.deleteMany({ _id: { $in: createdDefinitionIds } });
    }
}

module.exports = { runAdminServiceDefinitionTests };
