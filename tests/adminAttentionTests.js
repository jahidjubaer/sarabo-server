// "Needs attention" list (overdue-alerts phase) and the shared
// canTechnicianEverTakeRequest rule. Runs with a clock in 2099 and its own
// region so only this file's requests can be overdue.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runAdminAttentionTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const AdminAttentionController = require('../controllers/adminAttentionController');
    const reportRoutes = require('../routes/adminReports');
    const { canTechnicianEverTakeRequest } = require('../services/technicianEligibilityService');
    const { verifyFBToken, verifyAdmin } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const REGION = `AttentionRegion-${runId}`;
    const now = new Date('2099-06-30T12:00:00Z');
    const hours = (n) => new Date(now.getTime() + n * 3600000);
    const slot = (startHours) => ({ date: '2099-06-30', slotId: '10-12', startsAt: hours(startHours), endsAt: hours(startHours + 2) });
    const requestIds = [];
    const technicianIds = [];

    // ---- the shared rule ----
    const tech = {
        status: 'approved', region: 'Dhaka',
        expertise: [{ productCategorySlug: 'smartphone', repairCategorySlugs: ['display-screen'], level: 'advanced', experienceYears: 4 }],
    };
    const needs = { region: 'Dhaka', productCategorySlug: 'smartphone', repairCategorySlug: 'display-screen', requiredExpertiseLevel: 'intermediate' };
    logTest('Attention: a local, qualified technician can take a request (region case and spaces ignored)',
        canTechnicianEverTakeRequest(tech, needs) && canTechnicianEverTakeRequest(tech, { ...needs, region: ' dhaka ' }));
    logTest('Attention: another region, device, repair, a higher level or an unapproved technician cannot',
        !canTechnicianEverTakeRequest(tech, { ...needs, region: 'Sylhet' })
        && !canTechnicianEverTakeRequest(tech, { ...needs, productCategorySlug: 'laptop-computer' })
        && !canTechnicianEverTakeRequest(tech, { ...needs, repairCategorySlug: 'battery-power' })
        && !canTechnicianEverTakeRequest(tech, { ...needs, requiredExpertiseLevel: 'expert' })
        && !canTechnicianEverTakeRequest({ ...tech, status: 'pending' }, needs)
        && !canTechnicianEverTakeRequest(tech, { ...needs, region: '' }));

    const definition = await c.serviceDefinitions.findOne({ isActive: true });
    const insertRequest = async (overrides) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: `attention-customer-${runId}@example.test`, senderName: 'Should Not Leak',
            trackingId: `ATT-${runId}-${requestIds.length}`,
            product: { categorySlug: definition.productCategorySlug, brand: 'B', model: 'M' },
            service: { definitionId: definition._id.toString(), repairCategorySlug: definition.repairCategorySlug },
            serviceLocation: { region: REGION, district: 'D', address: 'Private address' },
            deliveryStatus: 'pending-pickup', createdAt: hours(-48),
            ...overrides,
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };

    try {
        const controller = new AdminAttentionController(models, c, { now: () => now });
        const load = async () => { const res = fakeRes(); await controller.getAttention({}, res); return res; };

        // Waiting, pickup started 1 hour ago, and nobody local exists yet.
        const overdue = await insertRequest({ pickupSlot: slot(-1) });
        // Waiting, pickup tomorrow.
        const upcoming = await insertRequest({ pickupSlot: slot(24) });
        // Accepted, window ended 3 hours ago, not collected.
        const missed = await insertRequest({ deliveryStatus: 'driver_assigned', technicianName: 'Late Tech', pickupSlot: slot(-5) });
        // Accepted, window still open.
        const inWindow = await insertRequest({ deliveryStatus: 'driver_assigned', pickupSlot: slot(-1) });
        // Already collected long after its slot - not missed.
        const collected = await insertRequest({ deliveryStatus: 'parcel_picked_up', pickupSlot: slot(-30) });

        const first = await load();
        const ids = (list) => list.map((r) => r.id);
        logTest('Attention: a waiting request whose pickup time has started is overdue; an upcoming one is not',
            first.statusCode === 200 && ids(first.body.overdueWaiting).includes(overdue) && !ids(first.body.overdueWaiting).includes(upcoming));
        logTest('Attention: an assigned pickup whose window ended uncollected is missed; an open window or a collected device is not',
            ids(first.body.missedPickups).includes(missed) && !ids(first.body.missedPickups).includes(inWindow) && !ids(first.body.missedPickups).includes(collected));
        logTest('Attention: waiting requests with no local technician are flagged',
            ids(first.body.unmatchable).includes(overdue) && ids(first.body.unmatchable).includes(upcoming));
        const entry = first.body.overdueWaiting.find((r) => r.id === overdue);
        logTest('Attention: entries carry what the screen needs, never the customer contact or address',
            entry && entry.region === REGION && entry.pickupSlot && entry.senderEmail === undefined && entry.senderName === undefined
            && JSON.stringify(first.body).indexOf('Private address') === -1 && first.body.missedPickups.find((r) => r.id === missed).technicianName === 'Late Tech');

        // A qualified technician joins the region: nothing is unmatchable any more.
        const { insertedId: techId } = await c.technicians.insertOne({
            name: `Attention Tech ${runId}`, email: `attention-tech-${runId}@example.test`, region: REGION, district: 'D',
            status: 'approved', workStatus: 'available', createdAt: now,
            expertise: [{ productCategorySlug: definition.productCategorySlug, repairCategorySlugs: [definition.repairCategorySlug], level: 'expert', experienceYears: 9 }],
        });
        technicianIds.push(techId);
        const second = await load();
        logTest('Attention: once a local technician can take them, requests are no longer unmatchable',
            !ids(second.body.unmatchable).includes(overdue) && !ids(second.body.unmatchable).includes(upcoming) && ids(second.body.overdueWaiting).includes(overdue));
        logTest('Attention: counts are reported alongside the lists',
            second.body.counts.overdueWaiting >= 1 && second.body.counts.missedPickups >= 1 && typeof second.body.counts.unmatchable === 'number');

        const routes = [];
        reportRoutes({ get: (path, ...handlers) => routes.push({ path, handlers }) }, { adminReport: {}, adminAttention: controller });
        const attentionRoute = routes.find((r) => r.path === '/admin/attention');
        logTest('Attention: the route is admin-only', !!attentionRoute && attentionRoute.handlers.includes(verifyFBToken) && attentionRoute.handlers.includes(verifyAdmin));
    } finally {
        if (requestIds.length) await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds.map((id) => new ObjectId(id)) } });
    }
}

module.exports = { runAdminAttentionTests };
