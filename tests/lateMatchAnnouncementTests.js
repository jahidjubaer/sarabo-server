// A technician who starts matching later (expertise added, or just approved)
// is told about the open jobs they can now take - once per job, never the
// ones they already offered on, assigned ones or ones in another region
// (services/jobAnnouncements.js announceOpenJobsToTechnician).
function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runLateMatchAnnouncementTests({ logTest }) {
    const { ObjectId } = require('mongodb');
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const TechnicianController = require('../controllers/technicianController');
    const { createNotificationService } = require('../services/notificationService');
    const { announceOpenJobsToTechnician } = require('../services/jobAnnouncements');
    if (process.env.NODE_ENV !== 'test' || !c.users.dbName.includes('test')) throw new Error('Isolated test database required');
    await connectDatabase();
    const models = initializeModels(c);
    const notifications = createNotificationService(models);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const REGION = `LateRegion-${runId}`;
    const TECH = `late-tech-${runId}@test.local`;
    const PENDING = `late-pending-${runId}@test.local`;
    const CUSTOMER = `late-customer-${runId}@test.local`;

    const definition = await c.serviceDefinitions.findOne({ isActive: true, repairCategorySlug: { $ne: 'diagnosis' } });
    const product = definition.productCategorySlug;
    const requestIds = [];
    const insertRequest = async (overrides = {}) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `LATE-${runId}-${requestIds.length}`,
            product: { categorySlug: product }, service: { definitionId: definition._id.toString(), repairCategorySlug: definition.repairCategorySlug },
            damage: { description: 'Late match test problem.', images: [] },
            serviceLocation: { region: REGION, district: 'Near' }, deliveryStatus: 'pending-pickup', createdAt: new Date(), ...overrides,
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };
    const jobNotices = (email) => c.notifications.find({ recipientEmail: email, type: 'job_posted', entityId: { $in: requestIds.map(String) } }).toArray();
    const expertise = (repairs) => [{ productCategorySlug: product, repairCategorySlugs: repairs, level: 'expert', experienceYears: 9 }];

    let techId = null;
    let pendingId = null;
    try {
        await c.users.insertMany([
            { email: TECH, role: 'rider', createdAt: new Date() }, { email: PENDING, role: 'user', createdAt: new Date() }, { email: CUSTOMER, role: 'user', createdAt: new Date() },
        ]);
        // Starts with diagnosis only, so the open job does not match yet.
        ({ insertedId: techId } = await c.technicians.insertOne({
            name: `Late ${runId}`, email: TECH, region: REGION, district: 'Near', status: 'approved', workStatus: 'available', createdAt: new Date(), expertise: expertise(['diagnosis']),
        }));
        ({ insertedId: pendingId } = await c.technicians.insertOne({
            name: `Pending ${runId}`, email: PENDING, region: REGION, district: 'Near', status: 'pending', createdAt: new Date(), expertise: expertise([definition.repairCategorySlug]),
        }));
        const open = await insertRequest();
        await insertRequest({ serviceLocation: { region: `Elsewhere-${runId}`, district: 'Far' } });
        // Assigned to someone else (an assignment of their own would block
        // the expertise change).
        await insertRequest({ technicianId: new ObjectId().toString(), deliveryStatus: 'driver_assigned' });
        const offered = await insertRequest();
        await c.jobApplications.insertOne({ requestId: offered, technicianId: techId.toString(), technicianEmail: TECH, status: 'declined', estimateMin: 1, estimateMax: 2, inspectionFee: 0, createdAt: new Date() });

        const controller = new TechnicianController(models, c);
        const update = async (repairs) => {
            const res = fakeRes();
            await controller.updateTechnicianExpertise({ decoded_email: TECH, params: { id: techId.toString() }, body: { expertise: expertise(repairs) } }, res);
            return res;
        };
        const first = await update(['diagnosis', definition.repairCategorySlug]);
        const afterFirst = await jobNotices(TECH);
        logTest('Late match: adding a repair to expertise announces the open job it now matches',
            first.statusCode === 200 && afterFirst.length === 1 && afterFirst[0].entityId === open && afterFirst[0].actionUrl === '/jobs');
        logTest('Late match: never a job in another region, an assigned job or one they already offered on',
            afterFirst.every((n) => n.entityId === open));
        await update(['diagnosis', definition.repairCategorySlug, 'other'].filter((s, i, a) => a.indexOf(s) === i));
        logTest('Late match: changing expertise again does not repeat the announcement', (await jobNotices(TECH)).length === 1);

        logTest('Late match: a technician who is not approved hears nothing',
            (await announceOpenJobsToTechnician({ collections: c, notifications, technicianId: pendingId })) === 0 && (await jobNotices(PENDING)).length === 0);
        await c.technicians.updateOne({ _id: pendingId }, { $set: { status: 'approved' } });
        const told = await announceOpenJobsToTechnician({ collections: c, notifications, technicianId: pendingId });
        const pendingNotices = await jobNotices(PENDING);
        logTest('Late match: once approved, a technician hears about the open jobs they can take',
            told === 2 && pendingNotices.length === 2 && pendingNotices.every((n) => [open, offered].includes(n.entityId)));
        logTest('Late match: a bad technician id announces nothing and does not throw',
            (await announceOpenJobsToTechnician({ collections: c, notifications, technicianId: 'nope' })) === 0);
    } finally {
        await c.notifications.deleteMany({ entityId: { $in: requestIds.map(String) } });
        await c.jobApplications.deleteMany({ requestId: { $in: requestIds.map(String) } });
        await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        await c.technicians.deleteMany({ email: { $in: [TECH, PENDING] } });
        await c.users.deleteMany({ email: { $in: [TECH, PENDING, CUSTOMER] } });
    }
}

module.exports = { runLateMatchAnnouncementTests };
