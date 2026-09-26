// Declined-quote follow-through: after the customer declines the final price,
// the request ends - by the technician (existing), by the customer, or
// automatically when nobody acts for 3 days (the daily job). Every way keeps
// a paid inspection fee 90/10; a quote being revised is never closed.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runDeclinedQuoteCloseTests({ logTest }) {
    const { connectDatabase, client, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const QuoteController = require('../controllers/quoteController');
    const PickupReminderController = require('../controllers/pickupReminderController');
    const { createNotificationService } = require('../services/notificationService');
    const { closeStaleDeclinedRequests, DECLINED_AUTO_CLOSE_MS } = require('../services/declinedQuoteClose');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const CUSTOMER = `declined-customer-${runId}@example.test`;
    const emails = [CUSTOMER];
    const requestIds = [];
    const technicianIds = [];
    const DAY = 24 * 60 * 60 * 1000;
    const FEE = 300;
    const quotes = new QuoteController(models, c);
    const call = async (method, email, req = {}) => {
        const res = fakeRes();
        await quotes[method]({ decoded_email: email, decoded_email_verified: true, params: {}, query: {}, body: {}, ...req }, res);
        return res;
    };

    const insertTech = async (name) => {
        const email = `declined-${name}-${runId}@example.test`;
        emails.push(email);
        await c.users.insertOne({ email, role: 'rider', createdAt: new Date() });
        const { insertedId } = await c.technicians.insertOne({ name, email, region: 'R', status: 'approved', workStatus: 'available', createdAt: new Date() });
        technicianIds.push(insertedId);
        return { id: insertedId.toString(), email };
    };
    // A request whose quote the customer declined `ago` ms before now.
    const insertDeclined = async (tech, { ago = 0, fee = FEE, deliveryStatus = 'quote_rejected' } = {}) => {
        const n = requestIds.length;
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `DEC-${runId}-${n}`, deliveryStatus,
            technicianId: tech.id, technicianEmail: tech.email, technicianName: 'T',
            quote: { status: 'rejected', partsAmount: 1000, laborAmount: 500, additionalCharges: 0, totalAmount: 1500, decidedAt: new Date(Date.now() - ago) },
            ...(fee ? { inspectionPayment: { status: 'paid', amount: fee, currency: 'BDT', sessionId: `cs_dec_${runId}_${n}`, technicianId: tech.id, paidAt: new Date() } } : {}),
            createdAt: new Date(),
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };
    const load = (id) => c.repairRequests.findOne({ _id: new ObjectId(id) });
    const note = (email, type, id) => c.notifications.findOne({ recipientEmail: email, type, entityId: id });

    try {
        await c.users.insertOne({ email: CUSTOMER, role: 'user', createdAt: new Date() });

        // ---- the customer ends it ----
        const tech = await insertTech('customer-close');
        const id = await insertDeclined(tech);
        const stranger = await call('closeDeclinedByCustomer', `nobody-${runId}@example.test`, { params: { id } });
        const byTech = await call('closeDeclinedByCustomer', tech.email, { params: { id } });
        logTest('Declined quote: only the customer can end it this way (others see not found)',
            stranger.statusCode === 404 && byTech.statusCode === 404 && (await load(id)).deliveryStatus === 'quote_rejected');
        const closed = await call('closeDeclinedByCustomer', CUSTOMER, { params: { id } });
        const after = await load(id);
        logTest('Declined quote: the customer ends it - cancelled, and the inspection fee is kept 90/10',
            closed.statusCode === 200 && closed.body.inspectionFee === 'kept'
            && after.deliveryStatus === 'cancelled' && after.cancellationReason === 'quote_declined' && after.closedBy === 'customer'
            && after.cancelledBy === CUSTOMER && after.inspectionPayment.status === 'kept'
            && after.inspectionFeeSettlement.technicianReceivable === 270 && after.inspectionFeeSettlement.platformCommission === 30);
        const techNote = await note(tech.email, 'declined_request_closed', id);
        logTest('Declined quote: the technician is told, and that their share is in the wallet',
            techNote && techNote.metadata.closedBy === 'customer' && techNote.metadata.feeOutcome === 'kept' && techNote.message.includes('wallet'));
        const again = await call('closeDeclinedByCustomer', CUSTOMER, { params: { id } });
        logTest('Declined quote: ending it twice changes nothing',
            again.statusCode === 409 && again.body.code === 'QUOTE_NOT_REJECTED'
            && (await load(id)).inspectionFeeSettlement.settledAt.getTime() === after.inspectionFeeSettlement.settledAt.getTime());
        const waiting = await insertDeclined(tech, { deliveryStatus: 'quote_submitted' });
        const notDeclined = await call('closeDeclinedByCustomer', CUSTOMER, { params: { id: waiting } });
        logTest('Declined quote: a quote not declined cannot be ended this way',
            notDeclined.statusCode === 409 && notDeclined.body.code === 'QUOTE_NOT_REJECTED');
        const noFee = await insertDeclined(tech, { fee: 0 });
        const noFeeClosed = await call('closeDeclinedByCustomer', CUSTOMER, { params: { id: noFee } });
        logTest('Declined quote: without a paid fee there is nothing to keep',
            noFeeClosed.statusCode === 200 && noFeeClosed.body.inspectionFee === 'none' && !(await load(noFee)).inspectionFeeSettlement);

        // ---- the technician's close still works through the shared path ----
        const techCloseId = await insertDeclined(tech);
        const techClose = await call('cancelAfterQuoteRejection', tech.email, { params: { id: techCloseId } });
        logTest('Declined quote: the technician closing it gives the same outcome',
            techClose.statusCode === 200 && (await load(techCloseId)).closedBy === 'technician'
            && (await load(techCloseId)).inspectionPayment.status === 'kept'
            && Boolean(await note(CUSTOMER, 'repair_cancelled_by_technician', techCloseId)));

        // ---- nobody acts for 3 days: the daily job closes it ----
        const autoTech = await insertTech('auto');
        const stale = await insertDeclined(autoTech, { ago: DECLINED_AUTO_CLOSE_MS + DAY });
        const fresh = await insertDeclined(autoTech, { ago: DECLINED_AUTO_CLOSE_MS - DAY });
        const counts = await closeStaleDeclinedRequests({ collections: c, notifications: createNotificationService(models), User: models.User, mongoClient: client, now: new Date() });
        const staleAfter = await load(stale);
        logTest('Declined quote: after 3 days with nobody acting, the daily job closes it and keeps the fee',
            counts.closed >= 1 && counts.failed === 0
            && staleAfter.deliveryStatus === 'cancelled' && staleAfter.closedBy === 'auto' && staleAfter.cancelledBy === 'system'
            && staleAfter.inspectionFeeSettlement.technicianReceivable === 270);
        logTest('Declined quote: one declined less than 3 days ago is left alone',
            (await load(fresh)).deliveryStatus === 'quote_rejected');
        logTest('Declined quote: both sides are told about an automatic close',
            (await note(CUSTOMER, 'declined_request_auto_closed', stale)) !== null
            && (await note(autoTech.email, 'declined_request_closed', stale)).metadata.closedBy === 'auto');

        // ---- the daily cron runs it ----
        const cronStale = await insertDeclined(autoTech, { ago: DECLINED_AUTO_CLOSE_MS + DAY });
        const cron = new PickupReminderController(models, c, { emailService: { enabled: false }, env: { CRON_SECRET: `secret-${runId}` } });
        const cronRes = fakeRes();
        await cron.sendReminders({ headers: { authorization: `Bearer secret-${runId}` } }, cronRes);
        logTest('Declined quote: the daily pickup-reminder run also closes stale declined quotes',
            cronRes.statusCode === 200 && cronRes.body.declinedClosed && cronRes.body.declinedClosed.closed >= 1
            && (await load(cronStale)).deliveryStatus === 'cancelled');
    } finally {
        const ids = requestIds.map(String);
        await c.notifications.deleteMany({ entityId: { $in: ids } });
        if (requestIds.length) {
            const tracking = (await c.repairRequests.find({ _id: { $in: requestIds } }, { projection: { trackingId: 1 } }).toArray()).map((row) => row.trackingId);
            await c.trackingEvents.deleteMany({ trackingId: { $in: tracking } });
            await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        }
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds } });
        await c.users.deleteMany({ email: { $in: emails } });
    }
}

module.exports = { runDeclinedQuoteCloseTests };
