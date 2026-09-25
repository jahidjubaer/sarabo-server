// Request-creation technician gate (job-portal phase A): a request can only
// be created when an approved technician in its region can take it; refused
// attempts are counted as turned-away demand for the reports.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runMatchGateTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const RepairRequestController = require('../controllers/repairRequestController');
    const ServiceAvailabilityController = require('../controllers/serviceAvailabilityController');
    const AdminReportController = require('../controllers/adminReportController');
    const { isMatchGateSkipped, hashCustomer } = require('../services/technicianMatchGate');
    const pickupRoutes = require('../routes/pickupSlots');
    const { verifyFBToken } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const REGION = `GateRegion-${runId}`;
    const CUSTOMER = `gate-customer-${runId}@example.test`;
    const requestIds = [];
    const technicianIds = [];

    // ---- the switch ----
    logTest('Match gate: it can only be switched off on a local, non-production machine',
        isMatchGateSkipped({ SKIP_TECHNICIAN_MATCH_CHECK: 'true' }) === true
        && isMatchGateSkipped({ SKIP_TECHNICIAN_MATCH_CHECK: 'true', NODE_ENV: 'production' }) === false
        && isMatchGateSkipped({ SKIP_TECHNICIAN_MATCH_CHECK: 'true', VERCEL: '1' }) === false
        && isMatchGateSkipped({}) === false);

    const definition = await c.serviceDefinitions.findOne({ isActive: true });
    // Gate forced ON for these tests.
    const repairController = new RepairRequestController(models, c, undefined, { skipMatchGate: false });
    const availability = new ServiceAvailabilityController(models, c, { skipMatchGate: false });
    const create = async () => {
        const res = fakeRes();
        await repairController.createRepairRequest({
            decoded_email: CUSTOMER,
            body: {
                schemaVersion: 2,
                product: { categorySlug: definition.productCategorySlug, brand: 'GateBrand', model: 'G1' },
                service: { definitionId: definition._id.toString() },
                damage: { description: 'Match gate test device problem.' },
                serviceLocation: { region: REGION, district: 'D', address: '1 Gate Road' },
            },
        }, res);
        if (res.body && res.body.insertedId) requestIds.push(res.body.insertedId);
        return res;
    };
    const check = async (query) => { const res = fakeRes(); await availability.check({ query }, res); return res; };
    const insertTech = async (overrides) => {
        const { insertedId } = await c.technicians.insertOne({
            name: `Gate Tech ${runId}`, email: `gate-tech-${technicianIds.length}-${runId}@example.test`, region: REGION, district: 'D',
            status: 'approved', workStatus: 'available', createdAt: new Date(),
            expertise: [{ productCategorySlug: definition.productCategorySlug, repairCategorySlugs: [definition.repairCategorySlug], level: 'expert', experienceYears: 9 }],
            ...overrides,
        });
        technicianIds.push(insertedId);
    };

    try {
        // ---- nobody in the region ----
        const q = { region: REGION, serviceDefinitionId: definition._id.toString() };
        logTest('Match gate: availability says no when nobody in the region offers the repair', (await check(q)).body.available === false);
        const refused = await create();
        const again = await create();
        logTest('Match gate: creating the request is refused with a clear code',
            refused.statusCode === 409 && refused.body.code === 'NO_TECHNICIAN_AVAILABLE' && again.statusCode === 409 && requestIds.length === 0);
        const turnedAway = await c.turnedAwayRequests.find({ region: REGION }).toArray();
        logTest('Match gate: a refusal is counted once per customer, service and day - with no email stored',
            turnedAway.length === 1 && turnedAway[0].customerHash === hashCustomer(CUSTOMER)
            && !JSON.stringify(turnedAway[0]).includes(CUSTOMER) && turnedAway[0].definitionId === definition._id.toString());

        const reportRes = fakeRes();
        await new AdminReportController(models, c).getReport({ query: { days: '7' } }, reportRes);
        const regionRow = reportRes.body.regions.find((r) => r.region === REGION);
        logTest('Match gate: reports show turned-away demand in the overview and per region',
            reportRes.body.overview.turnedAway >= 1 && regionRow && regionRow.turnedAway === 1);

        // ---- technicians who do not count ----
        await insertTech({ status: 'pending' });
        await insertTech({ region: `Elsewhere-${runId}` });
        await insertTech({ expertise: [{ productCategorySlug: definition.productCategorySlug, repairCategorySlugs: ['some-other-repair'], level: 'expert', experienceYears: 9 }] });
        logTest('Match gate: unapproved, other-region or other-repair technicians do not open the gate',
            (await check(q)).body.available === false && (await create()).statusCode === 409);

        // ---- a busy but qualified local technician does ----
        await insertTech({ workStatus: 'in_delivery' });
        logTest('Match gate: a qualified local technician opens it, even while busy on another job',
            (await check(q)).body.available === true && (await check({ ...q, region: `  ${REGION.toLowerCase()} ` })).body.available === true);
        const allowed = await create();
        logTest('Match gate: the request is then created', allowed.statusCode === 200 && requestIds.length === 1);

        logTest('Match gate: availability rejects bad input',
            (await check({ region: '', serviceDefinitionId: definition._id.toString() })).statusCode === 400
            && (await check({ region: REGION, serviceDefinitionId: 'x' })).statusCode === 400
            && (await check({ region: REGION, serviceDefinitionId: new ObjectId().toString() })).statusCode === 404);

        const routes = [];
        pickupRoutes({ get: (path, ...handlers) => routes.push({ path, handlers }), patch: () => {} }, { pickupSlot: {}, serviceAvailability: availability });
        const route = routes.find((r) => r.path === '/service-availability');
        logTest('Match gate: the availability check needs sign-in', !!route && route.handlers.includes(verifyFBToken));

        const indexes = await c.turnedAwayRequests.indexes();
        logTest('Match gate: turned-away records expire (TTL index)', indexes.some((i) => i.key && i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
    } finally {
        if (requestIds.length) {
            const ids = requestIds.map((id) => new ObjectId(id));
            const tracking = (await c.repairRequests.find({ _id: { $in: ids } }, { projection: { trackingId: 1 } }).toArray()).map((r) => r.trackingId);
            await c.trackingEvents.deleteMany({ trackingId: { $in: tracking } });
            await c.notifications.deleteMany({ entityId: { $in: requestIds.map(String) } });
            await c.repairRequests.deleteMany({ _id: { $in: ids } });
        }
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds } });
        await c.turnedAwayRequests.deleteMany({ region: REGION });
    }
}

module.exports = { runMatchGateTests };
