// Inspection fee floor (2026-10-14): every service charges at least 100 BDT
// (estimate up to 1,000 BDT) or 200 BDT (bigger repairs); offers can't go
// below it; admins can't price below it; the migration raises old services.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runInspectionFeeFloorTests({ logTest }) {
    const { minimumInspectionFee, withMinimumInspectionFee } = require('../utils/inspectionFee');
    const { maxInspectionFee, minInspectionFee, validateApplicationInput } = require('../utils/jobPortal');
    const { getPricingEstimate } = require('../services/pricingService');
    const { ALL_SERVICE_DEFINITION_SEED } = require('../data/serviceDefinitionSeedExtra');
    const { runMigration } = require('../scripts/migrate-inspection-fee-floor');

    // ---- pure rules ----
    logTest('Fee floor: 100 BDT up to a 1,000 BDT estimate, 200 BDT above, 200 BDT when unknown',
        minimumInspectionFee(500) === 100 && minimumInspectionFee(1000) === 100 && minimumInspectionFee(1001) === 200
        && minimumInspectionFee(18000) === 200 && minimumInspectionFee(undefined) === 200 && minimumInspectionFee(0) === 200);
    logTest('Fee floor: a stored fee is raised to the floor, a higher fee is kept',
        withMinimumInspectionFee(0, 800) === 100 && withMinimumInspectionFee(0, 6000) === 200
        && withMinimumInspectionFee(500, 6000) === 500 && withMinimumInspectionFee(undefined, 6000) === 200);
    logTest('Fee floor: every seeded service has at least the floor',
        ALL_SERVICE_DEFINITION_SEED.length > 0
        && ALL_SERVICE_DEFINITION_SEED.every((d) => d.pricingRule.inspectionFee >= minimumInspectionFee(d.pricingRule.baseMax)));
    logTest('Fee floor: a new request snapshots at least the floor',
        getPricingEstimate({ pricingRule: { currency: 'BDT', baseMin: 1500, baseMax: 6000, inspectionFee: 0, version: 2 } }).inspectionFee === 200);

    const oldRequest = { pricing: { estimateMin: 300, estimateMax: 500, inspectionFee: 0 } };
    const bigRequest = { pricing: { estimateMin: 2500, estimateMax: 6000, inspectionFee: 500 } };
    logTest('Fee floor: requests made before the floor get it too (min and max)',
        minInspectionFee(oldRequest) === 100 && maxInspectionFee(oldRequest) === 100
        && minInspectionFee(bigRequest) === 200 && maxInspectionFee(bigRequest) === 500);
    const offer = (inspectionFee) => validateApplicationInput({ estimateMin: 300, estimateMax: 500, inspectionFee }, { maxFee: 500, minFee: 200 });
    const free = offer(0);
    const low = offer(150);
    logTest('Fee floor: an offer below the floor is refused, one within the range is accepted',
        !free.valid && free.code === 'INSPECTION_FEE_TOO_LOW' && !low.valid && low.code === 'INSPECTION_FEE_TOO_LOW'
        && offer(200).valid && offer(500).valid && offer(501).code === 'INSPECTION_FEE_TOO_HIGH');

    // ---- database: admin editor + migration ----
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const AdminController = require('../controllers/adminServiceDefinitionController');
    if (process.env.NODE_ENV !== 'test' || !c.serviceDefinitions.dbName.includes('test') || c.serviceDefinitions.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const admin = new AdminController(initializeModels(c), c);
    const ADMIN = 'fee-floor-admin@example.test';
    const call = async (method, req) => { const res = fakeRes(); await admin[method]({ decoded_email: ADMIN, params: {}, query: {}, body: {}, ...req }, res); return res; };
    const createdIds = [];

    try {
        const listed = await call('list', {});
        const pair = listed.body.availablePairs[0];
        const body = {
            productCategorySlug: pair.productCategorySlug, repairCategorySlug: pair.repairCategorySlug,
            label: 'Fee floor test service', description: 'Created by the fee floor tests.',
            isActive: true, requiredExpertiseLevel: 'intermediate', estimatedDurationMinutes: 60,
            inspectionRequired: false, imageRequirements: { min: 0, max: 3, recommended: true },
            pricingRule: { baseMin: 1500, baseMax: 5000, inspectionFee: 0 },
        };
        const tooLow = await call('create', { body });
        logTest('Fee floor: admin cannot create a service below the floor',
            tooLow.statusCode === 400 && tooLow.body.code === 'INSPECTION_FEE_TOO_LOW' && tooLow.body.minimumInspectionFee === 200);
        const created = await call('create', { body: { ...body, pricingRule: { baseMin: 1500, baseMax: 5000, inspectionFee: 200 } } });
        if (created.body && created.body.id) createdIds.push(new ObjectId(created.body.id));
        logTest('Fee floor: admin can create at the floor, and the editor is told the floor',
            created.statusCode === 201 && created.body.minimumInspectionFee === 200);

        // A pre-floor service (written directly, as old data would be).
        const _id = new ObjectId(created.body.id);
        await c.serviceDefinitions.updateOne({ _id }, { $set: { 'pricingRule.inspectionFee': 0 } });
        let current = await c.serviceDefinitions.findOne({ _id });
        const rename = await call('update', { params: { id: created.body.id }, body: { expectedUpdatedAt: current.updatedAt, changes: { label: 'Renamed fee floor service' } } });
        current = await c.serviceDefinitions.findOne({ _id });
        const lowEdit = await call('update', { params: { id: created.body.id }, body: { expectedUpdatedAt: current.updatedAt, changes: { pricingRule: { inspectionFee: 150 } } } });
        logTest('Fee floor: an old service below the floor can still be renamed, but not re-priced below it',
            rename.statusCode === 200 && lowEdit.statusCode === 400 && lowEdit.body.code === 'INSPECTION_FEE_TOO_LOW');

        // Migration, scoped to this one row through a filtered collection view.
        const scoped = {
            find: (query, options) => c.serviceDefinitions.find({ ...query, _id }, options),
            updateOne: (filter, update) => c.serviceDefinitions.updateOne({ ...filter, _id }, update),
        };
        const before = await c.serviceDefinitions.findOne({ _id });
        const dry = await runMigration({ collection: scoped, dryRun: true });
        const untouched = await c.serviceDefinitions.findOne({ _id });
        logTest('Fee floor migration: dry run reports the raise and writes nothing',
            dry.raised === 1 && dry.details[0].to === 200 && untouched.pricingRule.inspectionFee === 0);
        const real = await runMigration({ collection: scoped, dryRun: false });
        const after = await c.serviceDefinitions.findOne({ _id });
        const again = await runMigration({ collection: scoped, dryRun: false });
        logTest('Fee floor migration: raises the fee, bumps the pricing version, and is idempotent',
            real.raised === 1 && after.pricingRule.inspectionFee === 200 && after.pricingRule.version === before.pricingRule.version + 1
            && again.raised === 0 && again.unchanged === 1);
    } finally {
        if (createdIds.length) await c.serviceDefinitions.deleteMany({ _id: { $in: createdIds } });
    }
}

module.exports = { runInspectionFeeFloorTests };
