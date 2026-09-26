// Email updates (email-updates phase): wording and escaping, the no-op when
// disabled, send-once keys, failure handling, the day-before reminder job and
// its secret. A fake transport stands in for Gmail - nothing is really sent.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

function fakeTransport({ fail = false, hang = false } = {}) {
    const sent = [];
    return {
        sent,
        factory: () => ({
            sendMail: async (mail) => {
                if (hang) return new Promise(() => {});
                if (fail) throw Object.assign(new Error('Invalid login: 535 secret details'), { code: 'EAUTH' });
                sent.push(mail);
                return { messageId: `fake-${sent.length}` };
            },
        }),
    };
}

async function runEmailTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const { loadEmailConfig } = require('../config/email');
    const { createEmailService } = require('../services/emailService');
    const templates = require('../utils/emailTemplates');
    const PickupReminderController = require('../controllers/pickupReminderController');
    const { dhakaDateString } = require('../utils/pickupSlots');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const quiet = { error: () => {} };
    const createdRequestIds = [];
    const config = {
        ...loadEmailConfig({ EMAIL_ENABLED: 'true', GMAIL_USER: 'sender@example.test', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', SITE_DOMAIN: 'https://app.example.test/' }),
        sendTimeoutMs: 200,
    };

    // ---- config ----
    const off = loadEmailConfig({});
    const incomplete = loadEmailConfig({ EMAIL_ENABLED: 'true', GMAIL_USER: 'x@example.test' });
    logTest('Email: off unless EMAIL_ENABLED=true with both Gmail settings',
        off.enabled === false && incomplete.enabled === false && incomplete.requestedButIncomplete && incomplete.missing.includes('GMAIL_APP_PASSWORD'));
    logTest('Email: app-password spaces are removed and the site link has no trailing slash',
        config.enabled && config.appPassword === 'abcdefghijklmnop' && config.siteOrigin === 'https://app.example.test');

    // ---- templates ----
    const request = {
        trackingId: `TRK-${runId}`, senderEmail: `customer-${runId}@example.test`,
        product: { categorySlug: 'smartphone', brand: '<b>Evil</b>', model: 'A52' },
        service: { repairCategorySlug: 'screen-replacement' },
        serviceLocation: { region: 'Dhaka', district: 'Mirpur', address: '12 <script>Road</script>' },
        pickupSlot: { date: '2026-09-27', slotId: '10-12' },
    };
    const received = templates.requestReceived({ request, requestUrl: 'https://app.example.test/dashboard/my-requests/1' });
    logTest('Email: the pickup is written out in full, in Bangladesh time',
        templates.formatPickupForEmail(request.pickupSlot) === 'Sunday 27 September, 10:00 AM – 12:00 PM (Bangladesh time)');
    logTest('Email: user text is escaped in HTML (no injected tags)',
        !received.html.includes('<b>Evil</b>') && received.html.includes('&lt;b&gt;Evil&lt;/b&gt;'));
    const reminder = templates.pickupReminder({ request, requestUrl: null });
    logTest('Email: every email has a subject, plain text and HTML, and the reminder shows the address safely',
        [received, reminder, templates.pickupChanged({ request }), templates.jobOffer({ request, technicianName: 'Rafi' })]
            .every((m) => m.subject && m.text && m.html.startsWith('<!doctype html>'))
        && !reminder.html.includes('<script>') && reminder.text.includes('12 <script>Road</script>, Mirpur'));

    try {
        // ---- service ----
        const disabled = createEmailService({ config: off, collections: c, transportFactory: fakeTransport().factory, logger: quiet });
        logTest('Email: a disabled service sends nothing and records nothing',
            (await disabled.sendRequestReceived(request, `none-${runId}`)).status === 'disabled'
            && (await c.emailLog.countDocuments({ _id: `request_received:none-${runId}` })) === 0);

        const good = fakeTransport();
        const service = createEmailService({ config, collections: c, transportFactory: good.factory, logger: quiet });
        const requestId = new ObjectId().toString();
        const first = await service.sendRequestReceived(request, requestId);
        const second = await service.sendRequestReceived(request, requestId);
        const logged = await c.emailLog.findOne({ _id: `request_received:${requestId}` });
        logTest('Email: the same email is sent once, however often it is triggered',
            first.status === 'sent' && second.status === 'duplicate' && good.sent.length === 1 && logged.status === 'sent');
        logTest('Email: sent from the configured name and address, with a working link',
            good.sent[0].from.address === 'sender@example.test' && good.sent[0].from.name === 'Sarabo'
            && good.sent[0].to === request.senderEmail && good.sent[0].text.includes(`https://app.example.test/dashboard/my-requests/${requestId}`));
        logTest('Email: log records expire (TTL) after about 90 days',
            logged.expiresAt instanceof Date && Math.round((logged.expiresAt - logged.createdAt) / 86400000) === 90);

        const failing = createEmailService({ config, collections: c, transportFactory: fakeTransport({ fail: true }).factory, logger: quiet });
        const failedId = new ObjectId().toString();
        const failed = await failing.sendJobOffer(request, failedId, { email: `tech-${runId}@example.test`, name: 'Rafi' }, new Date());
        const failedLog = await c.emailLog.findOne({ kind: 'job_offer', _id: { $regex: `^job_offer:${failedId}:` } });
        logTest('Email: a failed send does not throw and records only a short reason',
            failed.status === 'failed' && failedLog.status === 'failed' && failedLog.error === 'EAUTH');

        const hanging = createEmailService({ config, collections: c, transportFactory: fakeTransport({ hang: true }).factory, logger: quiet });
        const started = Date.now();
        const timedOut = await hanging.sendPickupChanged(request, new ObjectId().toString(), new Date());
        logTest('Email: a stuck send gives up after the timeout', timedOut.status === 'failed' && Date.now() - started < 2000);
        logTest('Email: an invalid recipient is skipped', (await service.sendRequestReceived({ ...request, senderEmail: 'nobody' }, new ObjectId().toString())).status === 'skipped');

        // ---- reminder job ----
        const tomorrow = dhakaDateString(new Date(Date.now() + 86400000));
        const insert = async (overrides) => {
            const { insertedId } = await c.repairRequests.insertOne({
                schemaVersion: 2, senderEmail: `remind-${runId}@example.test`, trackingId: `REM-${runId}-${createdRequestIds.length}`,
                deliveryStatus: 'pending-pickup', product: { categorySlug: 'smartphone' },
                serviceLocation: { region: 'Dhaka', district: 'Mirpur', address: '1 Road' },
                pickupSlot: { date: tomorrow, slotId: '12-14', startsAt: new Date(), endsAt: new Date() },
                createdAt: new Date(), ...overrides,
            });
            createdRequestIds.push(insertedId);
            return insertedId;
        };
        const due = await insert({});
        await insert({ deliveryStatus: 'cancelled' });
        await insert({ deliveryStatus: 'parcel_picked_up' });
        await insert({ pickupSlot: { date: '2020-01-01', slotId: '12-14' } });

        const remindTransport = fakeTransport();
        const remindService = createEmailService({ config, collections: c, transportFactory: remindTransport.factory, logger: quiet });
        const cron = new PickupReminderController(models, c, { emailService: remindService, env: { CRON_SECRET: 'cron-secret-value' } });
        const callCron = async (authorization) => { const res = fakeRes(); await cron.sendReminders({ headers: authorization ? { authorization } : {} }, res); return res; };

        logTest('Email: the reminder job refuses a missing or wrong secret',
            (await callCron()).statusCode === 401 && (await callCron('Bearer wrong')).statusCode === 401);
        const unconfigured = new PickupReminderController(models, c, { emailService: remindService, env: {} });
        const unconfiguredRes = fakeRes();
        await unconfigured.sendReminders({ headers: { authorization: 'Bearer anything' } }, unconfiguredRes);
        logTest('Email: without CRON_SECRET the reminder job refuses every call', unconfiguredRes.statusCode === 503);

        const run1 = await callCron('Bearer cron-secret-value');
        const mine = remindTransport.sent.filter((m) => m.to === `remind-${runId}@example.test`);
        logTest('Email: reminders go only to requests picked up tomorrow that are still waiting for pickup',
            run1.statusCode === 200 && run1.body.date === tomorrow && mine.length === 1 && mine[0].subject.includes(`REM-${runId}-0`));
        const beforeSecondRun = remindTransport.sent.length;
        const run2 = await callCron('Bearer cron-secret-value');
        logTest('Email: running the reminder job twice sends nothing new', run2.statusCode === 200 && remindTransport.sent.length === beforeSecondRun);
        await c.repairRequests.updateOne({ _id: due }, { $set: { 'pickupSlot.slotId': '16-18' } });
        await callCron('Bearer cron-secret-value');
        logTest('Email: moving the pickup earns a fresh reminder', remindTransport.sent.filter((m) => m.to === `remind-${runId}@example.test`).length === 2);

        // ---- the three real trigger points ----
        const RepairRequestController = require('../controllers/repairRequestController');
        const PickupSlotController = require('../controllers/pickupSlotController');
        const slots = require('../utils/pickupSlots');
        const flowTransport = fakeTransport();
        const flowService = createEmailService({ config, collections: c, transportFactory: flowTransport.factory, logger: quiet });
        const repairController = new RepairRequestController(models, c, undefined, { emailService: flowService });
        const pickupController = new PickupSlotController(models, c, { emailService: flowService });
        const definition = await c.serviceDefinitions.findOne({ isActive: true });
        const customerEmail = `flow-customer-${runId}@example.test`;
        const techEmail = `flow-tech-${runId}@example.test`;
        await c.users.insertMany([
            { email: customerEmail, role: 'user', createdAt: new Date() },
            { email: techEmail, role: 'rider', createdAt: new Date() },
        ]);
        const { insertedId: techId } = await c.technicians.insertOne({
            name: `Flow Tech ${runId}`, email: techEmail, region: 'Dhaka', district: 'Mirpur',
            status: 'approved', workStatus: 'available', createdAt: new Date(),
            expertise: [{ productCategorySlug: definition.productCategorySlug, repairCategorySlugs: [definition.repairCategorySlug], level: 'expert', experienceYears: 8 }],
        });
        const [slotA, slotB] = slots.buildSlotCalendar(new Date()).flatMap((day) => day.slots.filter((x) => x.available).map((x) => ({ date: day.date, slotId: x.slotId })));
        const createRes = fakeRes();
        await repairController.createRepairRequest({
            decoded_email: customerEmail,
            body: {
                schemaVersion: 2,
                product: { categorySlug: definition.productCategorySlug, brand: 'FlowBrand', model: 'FlowModel' },
                service: { definitionId: definition._id.toString() },
                damage: { description: 'Email flow test device problem.' },
                serviceLocation: { region: 'Dhaka', district: 'Mirpur', address: '5 Flow Road' },
                pickupSlot: slotA,
            },
        }, createRes);
        const flowRequestId = createRes.body && createRes.body.insertedId && createRes.body.insertedId.toString();
        if (flowRequestId) createdRequestIds.push(new ObjectId(flowRequestId));
        try {
            const toCustomer = () => flowTransport.sent.filter((m) => m.to === customerEmail);
            logTest('Email: creating a request emails the customer a confirmation with the pickup time',
                !!flowRequestId && toCustomer().length === 1 && toCustomer()[0].subject.startsWith("We've received your repair request")
                && toCustomer()[0].text.includes('(Bangladesh time)'));

            const moveRes = fakeRes();
            await pickupController.reschedule({ decoded_email: customerEmail, params: { id: flowRequestId }, body: { pickupSlot: slotB } }, moveRes);
            logTest('Email: changing the pickup emails the customer the new time',
                moveRes.statusCode === 200 && toCustomer().length === 2 && toCustomer()[1].subject.startsWith('Your pickup time has changed'));

            const assignRes = fakeRes();
            await repairController.assignTechnicianToRepairRequest({
                params: { id: flowRequestId }, body: { technicianId: techId.toString() }, decoded_email: `flow-admin-${runId}@example.test`,
            }, assignRes);
            const toTech = flowTransport.sent.filter((m) => m.to === techEmail);
            logTest('Email: offering a job emails the technician',
                assignRes.statusCode === 200 && toTech.length === 1 && toTech[0].subject.startsWith('New repair job offered to you')
                && toTech[0].text.includes('https://app.example.test/dashboard/assigned-jobs'));
        } finally {
            if (flowRequestId) {
                const flowDoc = await c.repairRequests.findOne({ _id: new ObjectId(flowRequestId) }, { projection: { trackingId: 1 } });
                if (flowDoc) await c.trackingEvents.deleteMany({ trackingId: flowDoc.trackingId });
                await c.notifications.deleteMany({ entityId: flowRequestId });
            }
            await c.emailLog.deleteMany({ to: { $in: [customerEmail, techEmail] } });
            await c.technicians.deleteOne({ _id: techId });
            await c.users.deleteMany({ email: { $in: [customerEmail, techEmail] } });
        }

        const indexes = await c.emailLog.indexes();
        logTest('Email: the email log has a TTL index on expiresAt',
            indexes.some((i) => i.key && i.key.expiresAt === 1 && i.expireAfterSeconds === 0));
    } finally {
        await c.emailLog.deleteMany({ $or: [{ to: { $regex: runId } }, { _id: { $regex: runId } }, { _id: `request_received:none-${runId}` }] });
        await c.emailLog.deleteMany({ to: { $in: [`customer-${runId}@example.test`, `tech-${runId}@example.test`, `remind-${runId}@example.test`, 'nobody'] } });
        if (createdRequestIds.length) await c.repairRequests.deleteMany({ _id: { $in: createdRequestIds } });
    }
}

module.exports = { runEmailTests };
