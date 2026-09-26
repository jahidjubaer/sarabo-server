// In-app pickup reminders (in-app-reminders phase): the daily reminder job
// posts a notification to the customer and to the assigned technician for
// every pickup tomorrow - with or without email - and never twice for the
// same pickup slot.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runInAppReminderTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const PickupReminderController = require('../controllers/pickupReminderController');
    const { createDisabledEmailService } = require('../services/emailService');
    const { dhakaDateString } = require('../utils/pickupSlots');
    const { NOTIFICATION_EVENTS } = require('../utils/notificationEvents');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const CUSTOMER = `inapp-customer-${runId}@example.test`;
    const TECH = `inapp-tech-${runId}@example.test`;
    const tomorrow = dhakaDateString(new Date(Date.now() + 86400000));
    const requestIds = [];

    // Email is off: the in-app reminders must still go out.
    const cron = new PickupReminderController(models, c, { emailService: createDisabledEmailService(), env: { CRON_SECRET: 'inapp-secret' } });
    const run = async () => { const res = fakeRes(); await cron.sendReminders({ headers: { authorization: 'Bearer inapp-secret' } }, res); return res; };
    const insert = async (overrides) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `INAPP-${runId}-${requestIds.length}`,
            product: { categorySlug: 'smartphone', brand: 'Walton', model: 'X1' },
            serviceLocation: { region: 'Dhaka', district: 'Mirpur', address: '1 Road' },
            deliveryStatus: 'driver_assigned', technicianEmail: TECH, technicianName: 'In-App Tech',
            pickupSlot: { date: tomorrow, slotId: '10-12', startsAt: new Date(), endsAt: new Date() },
            createdAt: new Date(), ...overrides,
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };
    const notes = (email, type, id) => c.notifications.find({ recipientEmail: email, type, entityId: id }).toArray();

    try {
        await c.users.insertMany([{ email: CUSTOMER, role: 'user', createdAt: new Date() }, { email: TECH, role: 'rider', createdAt: new Date() }]);
        logTest('In-app reminders: both reminder notification types are defined',
            !!NOTIFICATION_EVENTS.pickup_reminder && !!NOTIFICATION_EVENTS.pickup_reminder_technician);

        const assigned = await insert({});
        const waiting = await insert({ deliveryStatus: 'pending-pickup', technicianEmail: undefined, technicianName: undefined });
        const cancelled = await insert({ deliveryStatus: 'cancelled' });

        const first = await run();
        const customerNote = (await notes(CUSTOMER, 'pickup_reminder', assigned))[0];
        logTest('In-app reminders: the job runs and reports in-app counts even with email off',
            first.statusCode === 200 && first.body.date === tomorrow && first.body.emailEnabled === false && first.body.inApp.sent >= 3);
        logTest('In-app reminders: the customer is reminded, with the pickup time written out and a link to the request',
            !!customerNote && customerNote.message.includes('10:00 AM – 12:00 PM') && customerNote.actionUrl === `/dashboard/my-requests/${assigned}`);
        logTest('In-app reminders: the assigned technician is reminded too; a waiting request has nobody to remind',
            (await notes(TECH, 'pickup_reminder_technician', assigned)).length === 1
            && (await notes(CUSTOMER, 'pickup_reminder', waiting)).length === 1
            && (await c.notifications.countDocuments({ type: 'pickup_reminder_technician', entityId: waiting })) === 0);
        logTest('In-app reminders: a cancelled request is not reminded', (await c.notifications.countDocuments({ entityId: cancelled })) === 0);

        await run();
        logTest('In-app reminders: running the job again sends nothing new',
            (await notes(CUSTOMER, 'pickup_reminder', assigned)).length === 1 && (await notes(TECH, 'pickup_reminder_technician', assigned)).length === 1);

        await c.repairRequests.updateOne({ _id: new ObjectId(assigned) }, { $set: { 'pickupSlot.slotId': '16-18' } });
        await run();
        logTest('In-app reminders: moving the pickup earns a fresh reminder', (await notes(CUSTOMER, 'pickup_reminder', assigned)).length === 2);
    } finally {
        await c.notifications.deleteMany({ entityId: { $in: requestIds.map((id) => id.toString()) } });
        if (requestIds.length) await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        await c.users.deleteMany({ email: { $in: [CUSTOMER, TECH] } });
    }
}

module.exports = { runInAppReminderTests };
