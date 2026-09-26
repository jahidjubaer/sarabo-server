// Pickup scheduling (pickup-scheduling phase): the calendar rules, per-region
// slot capacity, booking a slot at request creation, and rescheduling by the
// owner until pickup.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runPickupSlotTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const slots = require('../utils/pickupSlots');
    const PickupSlotController = require('../controllers/pickupSlotController');
    const RepairRequestController = require('../controllers/repairRequestController');
    const pickupRoutes = require('../routes/pickupSlots');
    const { verifyFBToken, verifyEmailVerified } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const OWNER = `pickup-owner-${runId}@example.test`;
    const REGION = `TestRegion-${runId}`;
    const createdRequestIds = [];

    // ---- calendar rules (pure, fixed clock) ----
    // 00:30 Saturday 26 Sep 2026 in Dhaka.
    const now = new Date('2026-09-25T18:30:00Z');
    const v = (date, slotId, at = now) => slots.validatePickupSlotInput({ date, slotId }, at);
    const ok = v('2026-09-26', '10-12');
    logTest('Pickup: a slot is stored with its Dhaka date and exact UTC start/end',
        ok.valid && ok.pickupSlot.startsAt.toISOString() === '2026-09-26T04:00:00.000Z' && ok.pickupSlot.endsAt.toISOString() === '2026-09-26T06:00:00.000Z');
    logTest('Pickup: the Dhaka date is used, not the UTC date', slots.dhakaDateString(now) === '2026-09-26');
    logTest('Pickup: Friday is closed', v('2026-10-02', '10-12').code === 'PICKUP_DAY_CLOSED');
    logTest('Pickup: 7 days ahead is allowed, 8 is not', v('2026-10-03', '16-18').valid && v('2026-10-04', '10-12').code === 'PICKUP_SLOT_TOO_FAR');
    const nineThirty = new Date('2026-09-26T03:30:00Z');
    logTest('Pickup: a slot starting within the hour is refused, a later one is fine',
        v('2026-09-26', '10-12', nineThirty).code === 'PICKUP_SLOT_TOO_SOON' && v('2026-09-26', '12-14', nineThirty).valid);
    logTest('Pickup: past days are refused', v('2026-09-24', '10-12').code === 'PICKUP_SLOT_TOO_SOON');
    logTest('Pickup: impossible dates, unknown slots and bad shapes are refused',
        v('2026-02-30', '10-12').code === 'INVALID_PICKUP_SLOT' && v('2026-09-27', '9-11').code === 'INVALID_PICKUP_SLOT'
        && slots.validatePickupSlotInput(null, now).code === 'INVALID_PICKUP_SLOT' && slots.validatePickupSlotInput(['2026-09-27'], now).code === 'INVALID_PICKUP_SLOT');
    const calendar = slots.buildSlotCalendar(now, { bookedCounts: new Map([['2026-09-27|10-12', 3]]), capacity: 3 });
    const sunday = calendar.find((d) => d.date === '2026-09-27');
    logTest('Pickup: the calendar covers today plus 7 days, with Friday closed and full slots unavailable',
        calendar.length === 8 && calendar.find((d) => d.date === '2026-10-02').closed
        && sunday.slots[0].available === false && sunday.slots[0].remaining === 0 && sunday.slots[1].available === true);
    logTest('Pickup: capacity comes from PICKUP_SLOT_CAPACITY, falling back to 3 on bad values',
        slots.resolveSlotCapacity({ PICKUP_SLOT_CAPACITY: '5' }) === 5 && slots.resolveSlotCapacity({ PICKUP_SLOT_CAPACITY: 'x' }) === 3 && slots.resolveSlotCapacity({}) === 3);

    // ---- database: capacity, create, reschedule (real clock) ----
    const openSlots = slots.buildSlotCalendar(new Date()).flatMap((day) => day.slots.filter((s) => s.available).map((s) => ({ date: day.date, slotId: s.slotId })));
    const [slotA, slotB] = openSlots;
    const controller = new PickupSlotController(models, c, { env: { PICKUP_SLOT_CAPACITY: '1' } });
    const call = async (method, req) => { const res = fakeRes(); await controller[method]({ decoded_email: OWNER, params: {}, query: {}, body: {}, ...req }, res); return res; };
    const insertRequest = async (overrides = {}) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: OWNER, trackingId: `PICK-${runId}-${createdRequestIds.length}`,
            deliveryStatus: 'pending-pickup', serviceLocation: { region: REGION, district: 'D', address: 'A' },
            createdAt: new Date(), ...overrides,
        });
        createdRequestIds.push(insertedId);
        return insertedId;
    };

    try {
        const first = await insertRequest({ pickupSlot: slots.validatePickupSlotInput(slotA, new Date()).pickupSlot });
        const listed = await call('listAvailability', { query: { region: REGION.toLowerCase() } });
        const listedA = listed.body.days.find((d) => d.date === slotA.date).slots.find((s) => s.slotId === slotA.slotId);
        logTest('Pickup: availability counts bookings per region, ignoring letter case',
            listed.statusCode === 200 && listed.body.timezone === 'Asia/Dhaka' && listedA.remaining === 0 && listedA.available === false);
        const otherRegion = await call('listAvailability', { query: { region: `Other-${runId}` } });
        logTest('Pickup: another region is not affected',
            otherRegion.body.days.find((d) => d.date === slotA.date).slots.find((s) => s.slotId === slotA.slotId).remaining === 1);
        logTest('Pickup: availability needs a region', (await call('listAvailability', { query: {} })).statusCode === 400);

        const full = await controller.checkSlot(slotA, REGION);
        logTest('Pickup: a full slot is refused (409 PICKUP_SLOT_FULL)', !full.valid && full.status === 409 && full.code === 'PICKUP_SLOT_FULL');
        const ownExcluded = await controller.checkSlot(slotA, REGION, { excludeRequestId: first });
        logTest('Pickup: a request does not count against its own slot when rescheduling', ownExcluded.valid);
        await c.repairRequests.updateOne({ _id: first }, { $set: { deliveryStatus: 'cancelled' } });
        logTest('Pickup: a cancelled request frees its slot', (await controller.checkSlot(slotA, REGION)).valid);
        await c.repairRequests.updateOne({ _id: first }, { $set: { deliveryStatus: 'pending-pickup' } });

        // Reschedule.
        const moved = await call('reschedule', { params: { id: first.toString() }, body: { pickupSlot: slotB } });
        const stored = await c.repairRequests.findOne({ _id: first });
        logTest('Pickup: the owner can move the pickup to another open slot',
            moved.statusCode === 200 && stored.pickupSlot.date === slotB.date && stored.pickupSlot.slotId === slotB.slotId && stored.pickupSlot.startsAt instanceof Date);
        const stranger = await call('reschedule', { decoded_email: `stranger-${runId}@example.test`, params: { id: first.toString() }, body: { pickupSlot: slotA } });
        logTest('Pickup: someone else cannot reschedule (404, same as not found)', stranger.statusCode === 404 && stranger.body.code === 'REQUEST_NOT_FOUND');
        const blocker = await insertRequest({ pickupSlot: slots.validatePickupSlotInput(slotA, new Date()).pickupSlot });
        const intoFull = await call('reschedule', { params: { id: first.toString() }, body: { pickupSlot: slotA } });
        logTest('Pickup: rescheduling into a full slot is refused', intoFull.statusCode === 409 && intoFull.body.code === 'PICKUP_SLOT_FULL');
        await c.repairRequests.updateOne({ _id: blocker }, { $set: { deliveryStatus: 'cancelled' } });
        await c.repairRequests.updateOne({ _id: first }, { $set: { deliveryStatus: 'parcel_picked_up' } });
        const afterPickup = await call('reschedule', { params: { id: first.toString() }, body: { pickupSlot: slotA } });
        logTest('Pickup: the time cannot change after the device is picked up', afterPickup.statusCode === 409 && afterPickup.body.code === 'PICKUP_NOT_RESCHEDULABLE');
        const legacy = await insertRequest({ schemaVersion: undefined });
        const legacyRes = await call('reschedule', { params: { id: legacy.toString() }, body: { pickupSlot: slotA } });
        logTest('Pickup: older requests cannot be scheduled', legacyRes.statusCode === 409 && legacyRes.body.code === 'LEGACY_REQUEST_NOT_SUPPORTED');
        const pending = await insertRequest();
        const badInput = await call('reschedule', { params: { id: pending.toString() }, body: { pickupSlot: { date: 'soon', slotId: '10-12' } } });
        logTest('Pickup: invalid slot input is refused and nothing is written',
            badInput.statusCode === 400 && badInput.body.code === 'INVALID_PICKUP_SLOT' && (await c.repairRequests.findOne({ _id: pending })).pickupSlot === undefined);

        // Creation through the real v2 create path.
        const definition = await c.serviceDefinitions.findOne({ isActive: true });
        const repairController = new RepairRequestController(models, c);
        const create = async (extra) => {
            const res = fakeRes();
            await repairController.createRepairRequest({
                decoded_email: OWNER,
                body: {
                    schemaVersion: 2,
                    product: { categorySlug: definition.productCategorySlug, brand: 'PickupBrand', model: 'PickupModel' },
                    service: { definitionId: definition._id.toString() },
                    damage: { description: 'Pickup scheduling test device problem.' },
                    serviceLocation: { region: REGION, district: 'D', address: '1 Test Road' },
                    ...extra,
                },
            }, res);
            if (res.body && res.body.insertedId) createdRequestIds.push(res.body.insertedId);
            return res;
        };
        const created = await create({ pickupSlot: slotA });
        const createdDoc = created.body && created.body.insertedId ? await c.repairRequests.findOne({ _id: created.body.insertedId }) : null;
        logTest('Pickup: a new request stores the chosen slot',
            !!createdDoc && createdDoc.pickupSlot.date === slotA.date && createdDoc.pickupSlot.slotId === slotA.slotId);
        const tooSoon = await create({ pickupSlot: { date: '2020-01-01', slotId: '10-12' } });
        logTest('Pickup: a request with an invalid slot is not created', tooSoon.statusCode === 400 && tooSoon.body.code === 'PICKUP_SLOT_TOO_SOON');
        const withoutSlot = await create({});
        const withoutDoc = withoutSlot.body && withoutSlot.body.insertedId ? await c.repairRequests.findOne({ _id: withoutSlot.body.insertedId }) : null;
        logTest('Pickup: an older client can still create a request without a slot', !!withoutDoc && withoutDoc.pickupSlot === undefined);

        // Routes.
        const routes = [];
        const capture = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
        pickupRoutes({ get: capture('GET'), patch: capture('PATCH') }, { pickupSlot: controller });
        const reschedule = routes.find((r) => r.path === '/repair-requests/:id/pickup-slot');
        logTest('Pickup: routes require sign-in, and rescheduling a verified email',
            routes.length === 2 && routes.every((r) => r.handlers.includes(verifyFBToken)) && !!reschedule && reschedule.handlers.includes(verifyEmailVerified));
        const indexes = await c.repairRequests.indexes();
        logTest('Pickup: the capacity index exists with the case-insensitive collation',
            indexes.some((i) => i.name === 'repairRequests_region_pickupStartsAt' && i.collation && i.collation.strength === 2));
    } finally {
        if (createdRequestIds.length) {
            const ids = createdRequestIds.map((id) => new ObjectId(id));
            const trackingIds = (await c.repairRequests.find({ _id: { $in: ids } }, { projection: { trackingId: 1 } }).toArray()).map((r) => r.trackingId);
            await c.trackingEvents.deleteMany({ trackingId: { $in: trackingIds } });
            await c.notifications.deleteMany({ deduplicationKey: { $in: ids.map((id) => new RegExp(`^repair:${id}:`)) } });
            await c.repairRequests.deleteMany({ _id: { $in: ids } });
        }
    }
}

module.exports = { runPickupSlotTests };
