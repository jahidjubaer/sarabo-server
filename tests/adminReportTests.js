// Admin reports (reports phase). The report counts across the whole database,
// so these tests run it with a clock in 2099: only this file's own requests
// fall inside the period, and a unique region keeps the region rows apart.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runAdminReportTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const AdminReportController = require('../controllers/adminReportController');
    const reportRoutes = require('../routes/adminReports');
    const { verifyFBToken, verifyAdmin } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const REGION = `ReportRegion-${runId}`;
    const now = new Date('2099-06-30T12:00:00Z');
    const days = (n) => new Date(now.getTime() - n * 86400000);
    const controller = new AdminReportController(models, c, { now: () => now });
    const report = async (query) => { const res = fakeRes(); await controller.getReport({ query }, res); return res; };
    const requestIds = [];
    const technicianIds = [];

    const definition = await c.serviceDefinitions.findOne({ isActive: true });
    const insertTech = async (overrides) => {
        const { insertedId } = await c.technicians.insertOne({
            name: `Report Tech ${runId}`, email: `report-tech-${technicianIds.length}-${runId}@example.test`, region: REGION, district: 'D',
            status: 'approved', workStatus: 'available', createdAt: days(100),
            expertise: [{ productCategorySlug: definition.productCategorySlug, repairCategorySlugs: [definition.repairCategorySlug], level: 'expert', experienceYears: 9 }],
            ...overrides,
        });
        technicianIds.push(insertedId);
        return insertedId.toString();
    };
    const insertRequest = async (overrides) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: `report-customer-${runId}@example.test`, trackingId: `RPT-${runId}-${requestIds.length}`,
            product: { categorySlug: definition.productCategorySlug },
            service: { definitionId: definition._id.toString(), repairCategorySlug: definition.repairCategorySlug },
            serviceLocation: { region: REGION, district: 'D', address: 'A' },
            deliveryStatus: 'pending-pickup', createdAt: days(3), updatedAt: days(3),
            ...overrides,
        });
        requestIds.push(insertedId);
        return insertedId;
    };

    try {
        const worker = await insertTech({});
        const idle = await insertTech({ name: `Idle Tech ${runId}` });
        // Current 30 days: 2 completed (4 and 2 days to finish), 1 cancelled,
        // 1 in repair (worker busy), 1 waiting that the worker could take.
        await insertRequest({ createdAt: days(10), deliveryStatus: 'repair_completed', technicianId: worker, repair: { status: 'completed', completion: { completedAt: days(6) } }, pickupSlot: { date: '2099-06-21', slotId: '10-12' } });
        await insertRequest({ createdAt: days(5), deliveryStatus: 'repair_completed', technicianId: worker, repair: { status: 'completed', completion: { completedAt: days(3) } }, pickupSlot: { date: '2099-06-21', slotId: '10-12' } });
        await insertRequest({ createdAt: days(8), deliveryStatus: 'cancelled', updatedAt: days(7) });
        await insertRequest({ createdAt: days(4), deliveryStatus: 'repair_in_progress', technicianId: worker });
        await insertRequest({ createdAt: days(2) });
        // Waiting, but nobody in the region does this device.
        await insertRequest({ createdAt: days(1), product: { categorySlug: 'no-such-device' }, service: { definitionId: definition._id.toString(), repairCategorySlug: 'no-such-repair' } });
        // Previous 30 days: 1 completed.
        await insertRequest({ createdAt: days(50), deliveryStatus: 'repair_completed', technicianId: worker, repair: { status: 'completed', completion: { completedAt: days(40) } } });

        const bad = await report({ days: '14' });
        logTest('Reports: only 7, 30 or 90 days are accepted', bad.statusCode === 400 && bad.body.code === 'INVALID_REPORT_RANGE');

        const res = await report({ days: '30' });
        const o = res.body.overview;
        logTest('Reports: overview counts requests made, repairs finished and cancellations in the period',
            res.statusCode === 200 && o.created === 6 && o.completed === 2 && o.cancelled === 1);
        logTest('Reports: success rate is completed / (completed + cancelled) and average days is made -> finished',
            o.successRate === 66.7 && o.avgDaysToComplete === 3);
        logTest('Reports: the previous period is reported for comparison',
            o.previous.completed === 1 && o.previous.created === 1 && o.previous.avgDaysToComplete === 10);
        const daily = res.body.daily;
        logTest('Reports: the daily series covers every day up to today and adds up',
            daily[daily.length - 1].date === '2099-06-30' && daily.reduce((s, d) => s + d.created, 0) === 6 && daily.reduce((s, d) => s + d.completed, 0) === 2);

        const region = res.body.regions.find((r) => r.region === REGION);
        logTest('Reports: a region shows its requests, waiting requests and technicians',
            region && region.requests === 6 && region.waiting === 2 && region.approvedTechnicians === 2 && region.availableTechnicians === 2);
        logTest('Reports: waiting requests no local technician can take are flagged', region && region.unmatchedWaiting === 1);

        const sundayMorning = res.body.pickupLoad.find((p) => p.weekday === 0 && p.slotId === '10-12');
        logTest('Reports: pickups are counted by weekday and slot (2099-06-21 is a Sunday)',
            res.body.pickupLoad.length === 28 && sundayMorning.count === 2 && res.body.slots.length === 4);
        logTest('Reports: top devices include the requested device',
            res.body.devices.some((d) => d.productCategorySlug === definition.productCategorySlug && d.requests === 5));

        const top = res.body.workload.top.find((t) => t.technicianId === worker);
        logTest('Reports: the most active technicians show finished and active jobs, without contact details',
            top && top.completed === 2 && top.active === 1 && top.email === undefined && Object.keys(top).sort().join(',') === 'active,completed,name,region,technicianId');
        logTest('Reports: approved technicians with no job ever are counted',
            typeof res.body.workload.neverAssigned === 'number' && res.body.workload.neverAssigned >= 1 && !res.body.workload.top.some((t) => t.technicianId === idle));

        const routes = [];
        reportRoutes({ get: (path, ...handlers) => routes.push({ path, handlers }) }, { adminReport: controller });
        logTest('Reports: the route is admin-only', routes.length === 1 && routes[0].handlers.includes(verifyFBToken) && routes[0].handlers.includes(verifyAdmin));
    } finally {
        if (requestIds.length) await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds.map((id) => new ObjectId(id)) } });
    }
}

module.exports = { runAdminReportTests };
