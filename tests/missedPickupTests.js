// Missed-pickup actions (missed-pickup phase): taking the job back from the
// technician, asking the customer for a new time, and how both interact with
// the attention list and the customer's reschedule. Clock pinned to 2099.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runMissedPickupTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const MissedPickupController = require('../controllers/missedPickupController');
    const AdminAttentionController = require('../controllers/adminAttentionController');
    const PickupSlotController = require('../controllers/pickupSlotController');
    const routes = require('../routes/missedPickups');
    const { verifyFBToken, verifyAdmin } = require('../middleware/auth');
    const { NOTIFICATION_EVENTS } = require('../utils/notificationEvents');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date('2099-06-30T12:00:00Z');
    const hours = (n) => new Date(now.getTime() + n * 3600000);
    const ADMIN = `missed-admin-${runId}@example.test`;
    const CUSTOMER = `missed-customer-${runId}@example.test`;
    const requestIds = [];
    const technicianIds = [];
    const emails = [ADMIN, CUSTOMER];

    const controller = new MissedPickupController(models, c, { now: () => now });
    const attention = new AdminAttentionController(models, c, { now: () => now });
    const call = async (method, id) => { const res = fakeRes(); await controller[method]({ params: { id }, decoded_email: ADMIN, body: {} }, res); return res; };
    const missedIds = async () => { const res = fakeRes(); await attention.getAttention({}, res); return res.body.missedPickups.map((r) => r.id); };

    const insertTech = async () => {
        const email = `missed-tech-${technicianIds.length}-${runId}@example.test`;
        emails.push(email);
        await c.users.insertOne({ email, role: 'rider', createdAt: now });
        const { insertedId } = await c.technicians.insertOne({ name: `Missed Tech ${runId}`, email, region: 'R', district: 'D', status: 'approved', workStatus: 'in_delivery', createdAt: now });
        technicianIds.push(insertedId);
        return { id: insertedId.toString(), email };
    };
    const insertRequest = async (tech, overrides = {}) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `MISS-${runId}-${requestIds.length}`,
            product: { categorySlug: 'smartphone' }, serviceLocation: { region: 'R', district: 'D', address: 'A' },
            deliveryStatus: 'driver_assigned', technicianId: tech.id, technicianEmail: tech.email, technicianName: 'Missed Tech',
            assignmentHistory: [{ assignmentId: 'a1', technicianId: tech.id, technicianEmail: tech.email, decision: 'accepted', decidedAt: hours(-30) }],
            pickupSlot: { date: '2099-06-30', slotId: '10-12', startsAt: hours(-4), endsAt: hours(-2) },
            createdAt: hours(-48), ...overrides,
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };

    try {
        await c.users.insertOne({ email: CUSTOMER, role: 'user', createdAt: now });
        logTest('Missed pickup: both new notification types are defined',
            !!NOTIFICATION_EVENTS.assignment_withdrawn && !!NOTIFICATION_EVENTS.pickup_reschedule_requested);

        // ---- only missed pickups qualify ----
        const techA = await insertTech();
        const notYet = await insertRequest(techA, { pickupSlot: { date: '2099-06-30', slotId: '12-14', startsAt: hours(-1), endsAt: hours(1) } });
        const collected = await insertRequest(techA, { deliveryStatus: 'parcel_picked_up' });
        logTest('Missed pickup: a window still open or a device already collected is refused (409 PICKUP_NOT_MISSED)',
            (await call('withdraw', notYet)).body.code === 'PICKUP_NOT_MISSED' && (await call('askNewTime', collected)).body.code === 'PICKUP_NOT_MISSED');
        logTest('Missed pickup: bad and unknown ids are refused',
            (await call('withdraw', 'nope')).statusCode === 400 && (await call('withdraw', new ObjectId().toString())).statusCode === 404);

        // ---- take the job back ----
        const techB = await insertTech();
        const toWithdraw = await insertRequest(techB);
        logTest('Missed pickup: it shows on the attention list first', (await missedIds()).includes(toWithdraw));
        const withdrawn = await call('withdraw', toWithdraw);
        const afterWithdraw = await c.repairRequests.findOne({ _id: new ObjectId(toWithdraw) });
        const techBAfter = await c.technicians.findOne({ _id: new ObjectId(techB.id) });
        logTest('Missed pickup: withdrawing puts the request back to waiting, with no technician',
            withdrawn.statusCode === 200 && afterWithdraw.deliveryStatus === 'pending-pickup' && afterWithdraw.technicianEmail === undefined && afterWithdraw.technicianId === undefined);
        logTest('Missed pickup: the history records who withdrew it and why',
            afterWithdraw.assignmentHistory[0].decision === 'withdrawn' && afterWithdraw.assignmentHistory[0].withdrawnBy === ADMIN
            && afterWithdraw.assignmentHistory[0].withdrawalReason === 'missed_pickup' && afterWithdraw.assignmentHistory[0].withdrawnAt instanceof Date);
        logTest('Missed pickup: the technician is free again and is notified',
            techBAfter.workStatus === 'available'
            && (await c.notifications.countDocuments({ recipientEmail: techB.email, type: 'assignment_withdrawn', entityId: toWithdraw })) === 1);
        logTest('Missed pickup: withdrawn requests leave the missed list and a second withdraw is refused',
            !(await missedIds()).includes(toWithdraw) && (await call('withdraw', toWithdraw)).statusCode === 409);

        // ---- ask the customer for a new time ----
        const techC = await insertTech();
        const toAsk = await insertRequest(techC);
        const asked = await call('askNewTime', toAsk);
        const afterAsk = await c.repairRequests.findOne({ _id: new ObjectId(toAsk) });
        logTest('Missed pickup: asking for a new time keeps the technician and marks the request',
            asked.statusCode === 200 && afterAsk.deliveryStatus === 'driver_assigned' && afterAsk.technicianEmail === techC.email && afterAsk.pickupRescheduleRequestedAt instanceof Date);
        logTest('Missed pickup: the customer is notified, and the request leaves the missed list while they decide',
            (await c.notifications.countDocuments({ recipientEmail: CUSTOMER, type: 'pickup_reschedule_requested', entityId: toAsk })) === 1 && !(await missedIds()).includes(toAsk));
        logTest('Missed pickup: asking twice is refused', (await call('askNewTime', toAsk)).body.code === 'NEW_TIME_ALREADY_REQUESTED');

        // The customer picks a new time through the normal reschedule, with a
        // real clock (a slot this week).
        const pickup = new PickupSlotController(models, c, { env: { PICKUP_SLOT_CAPACITY: '50' } });
        const { buildSlotCalendar } = require('../utils/pickupSlots');
        const open = buildSlotCalendar(new Date()).flatMap((d) => d.slots.filter((s) => s.available).map((s) => ({ date: d.date, slotId: s.slotId })))[0];
        const rescheduleRes = fakeRes();
        await pickup.reschedule({ decoded_email: CUSTOMER, params: { id: toAsk }, body: { pickupSlot: open } }, rescheduleRes);
        const afterNewTime = await c.repairRequests.findOne({ _id: new ObjectId(toAsk) });
        logTest('Missed pickup: the customer choosing a new time clears the request for one',
            rescheduleRes.statusCode === 200 && afterNewTime.pickupRescheduleRequestedAt === undefined && afterNewTime.pickupSlot.date === open.date);

        const captured = [];
        routes({ post: (path, ...handlers) => captured.push({ path, handlers }) }, { missedPickup: controller });
        logTest('Missed pickup: both actions are admin-only',
            captured.length === 2 && captured.every((r) => r.handlers.includes(verifyFBToken) && r.handlers.includes(verifyAdmin)));
    } finally {
        const ids = requestIds.map((id) => id.toString());
        if (requestIds.length) {
            const tracking = (await c.repairRequests.find({ _id: { $in: requestIds } }, { projection: { trackingId: 1 } }).toArray()).map((r) => r.trackingId);
            await c.trackingEvents.deleteMany({ trackingId: { $in: tracking } });
            await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        }
        await c.notifications.deleteMany({ entityId: { $in: ids } });
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds } });
        await c.users.deleteMany({ email: { $in: emails } });
    }
}

module.exports = { runMissedPickupTests };
