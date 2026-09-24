// Technician availability self-correction (quick-wins phase): a technician
// left marked "busy" (workStatus in_delivery) with no active repair is
// corrected when they open their profile or when an admin rechecks them; a
// genuinely busy technician is never touched.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runTechnicianAvailabilityTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const TechnicianController = require('../controllers/technicianController');
    const technicianRoutes = require('../routes/technicians');
    const { verifyAdmin } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.technicians.dbName.includes('test') || c.technicians.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const controller = new TechnicianController(initializeModels(c), c);
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = (name) => `avail-${name}-${run}@example.test`;
    const technicianIds = [];
    const requestIds = [];

    async function addTechnician(name, fields) {
        const doc = { name: `Avail ${name}`, email: email(name), region: 'Dhaka', district: 'Dhaka', createdAt: new Date(), ...fields };
        const { insertedId } = await c.technicians.insertOne(doc);
        technicianIds.push(insertedId);
        return { ...doc, _id: insertedId };
    }
    async function addActiveRepair(technician) {
        const { insertedId } = await c.repairRequests.insertOne({
            senderEmail: `avail-customer-${run}@example.test`,
            trackingId: `AVAIL-${run}-${requestIds.length}`,
            deliveryStatus: 'driver_assigned',
            technicianId: technician._id.toString(),
            technicianEmail: technician.email,
            createdAt: new Date(),
        });
        requestIds.push(insertedId);
    }
    const stored = async (technician) => (await c.technicians.findOne({ _id: technician._id })).workStatus;

    try {
        const stale = await addTechnician('stale', { status: 'approved', workStatus: 'in_delivery' });
        const busy = await addTechnician('busy', { status: 'approved', workStatus: 'in_delivery' });
        await addActiveRepair(busy);
        const pending = await addTechnician('pending', { status: 'pending', workStatus: 'in_delivery' });
        const drifted = await addTechnician('drifted', { status: 'approved', workStatus: 'available' });
        await addActiveRepair(drifted);

        const meStale = fakeRes();
        await controller.getMyTechnicianProfile({ decoded_email: stale.email }, meStale);
        logTest('Availability: opening the profile clears a stale busy status',
            meStale.statusCode === 200 && meStale.body.workStatus === 'available' && (await stored(stale)) === 'available');

        const meBusy = fakeRes();
        await controller.getMyTechnicianProfile({ decoded_email: busy.email }, meBusy);
        logTest('Availability: a technician with an active repair stays busy',
            meBusy.body.workStatus === 'in_delivery' && (await stored(busy)) === 'in_delivery');

        const mePending = fakeRes();
        await controller.getMyTechnicianProfile({ decoded_email: pending.email }, mePending);
        logTest('Availability: a technician who is not approved is never changed',
            (await stored(pending)) === 'in_delivery');

        const meDrifted = fakeRes();
        await controller.getMyTechnicianProfile({ decoded_email: drifted.email }, meDrifted);
        logTest('Availability: the opposite drift (available with an active job) is left for admin re-approval',
            (await stored(drifted)) === 'available');

        // Admin recheck endpoint.
        await c.technicians.updateOne({ _id: stale._id }, { $set: { workStatus: 'in_delivery' } });
        const recheck = fakeRes();
        await controller.recheckTechnicianAvailability({ params: { id: stale._id.toString() } }, recheck);
        logTest('Recheck: an admin recheck clears a stale busy status',
            recheck.statusCode === 200 && recheck.body.changed === true && recheck.body.workStatus === 'available'
            && recheck.body.hasActiveAssignment === false && (await stored(stale)) === 'available');
        const recheckBusy = fakeRes();
        await controller.recheckTechnicianAvailability({ params: { id: busy._id.toString() } }, recheckBusy);
        logTest('Recheck: a genuinely busy technician is reported, not changed',
            recheckBusy.body.changed === false && recheckBusy.body.workStatus === 'in_delivery' && recheckBusy.body.hasActiveAssignment === true);
        const invalid = fakeRes();
        await controller.recheckTechnicianAvailability({ params: { id: 'not-an-id' } }, invalid);
        const missing = fakeRes();
        await controller.recheckTechnicianAvailability({ params: { id: new ObjectId().toString() } }, missing);
        logTest('Recheck: invalid id 400, unknown technician 404',
            invalid.statusCode === 400 && missing.statusCode === 404 && missing.body.code === 'TECHNICIAN_NOT_FOUND');

        const routes = [];
        technicianRoutes({
            get: () => {}, patch: () => {}, put: () => {}, delete: () => {},
            post: (path, ...handlers) => routes.push({ path, handlers }),
        }, { technician: controller });
        const recheckRoute = routes.find((route) => route.path === '/technicians/:id/recheck-availability');
        logTest('Recheck: the route is admin-only', !!recheckRoute && recheckRoute.handlers.includes(verifyAdmin));

        // Admin list flag.
        const list = fakeRes();
        await controller.getTechnicians({ query: {} }, list);
        const row = (technician) => list.body.find((t) => t._id.toString() === technician._id.toString());
        logTest('Admin list: hasActiveAssignment flags who an active repair names',
            row(busy)?.hasActiveAssignment === true && row(drifted)?.hasActiveAssignment === true
            && row(stale)?.hasActiveAssignment === false && row(pending)?.hasActiveAssignment === false);
    } finally {
        if (requestIds.length) await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds } });
    }
}

module.exports = { runTechnicianAvailabilityTests };
