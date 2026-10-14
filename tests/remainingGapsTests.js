// Remaining workflow gaps (2026-10-14), after tests/workflowFixesTests.js:
//   A. a repair payment that arrives after the request was cancelled is
//      recorded and refunded, never lost
//   B. a device collected and then cancelled must go back: mark returned,
//      customer confirms / disputes, auto-confirm after 3 days, admin settles
//   C. stalled work after pickup is listed for admins and alerted once
//   D. the device's condition is recorded at pickup; the customer can dispute
//      it and an admin reviews it
//   E. the technician can report the customer was not home: the booking
//      stays and the customer is asked for a new time
// Stripe is faked; nothing external is called.
const { ObjectId } = require('mongodb');

const DAY = 24 * 60 * 60 * 1000;

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
        set(name, value) { this.headers[name] = value; return this; },
    };
}

async function runRemainingGapsTests({ logTest }) {
    const { connectDatabase, collections: c, client } = require('../config/database');
    const { initializeModels } = require('../models');
    const WorkflowController = require('../controllers/workflowController');
    const RepairRequestController = require('../controllers/repairRequestController');
    const AdminAttentionController = require('../controllers/adminAttentionController');
    const { createPaymentProcessor } = require('../services/paymentProcessor');
    const { createNotificationService } = require('../services/notificationService');
    const { closeUnpaidRequest } = require('../services/requestClosure');
    const { findStalledWork } = require('../services/stalledWork');
    const routes = require('../routes/workflow');
    const { verifyFBToken, verifyAdmin, verifyTechnician } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const notifications = createNotificationService(models);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const CUSTOMER = `gap-customer-${runId}@example.test`;
    const STRANGER = `gap-stranger-${runId}@example.test`;
    const TECH = `gap-tech-${runId}@example.test`;
    const ADMIN = `gap-admin-${runId}@example.test`;
    const emails = [CUSTOMER, STRANGER, TECH, ADMIN];
    const requestIds = [];
    let techId = null;

    const refunds = [];
    const refundPayment = async ({ paymentIntentId, idempotencyKey }) => { refunds.push({ paymentIntentId, idempotencyKey }); return `re_${paymentIntentId}`; };
    const workflow = new WorkflowController(models, c, { refundPayment, expireCheckout: async () => {}, mongoClient: client });
    const repairRequests = new RepairRequestController(models, c);
    const call = async (target, method, email, req = {}) => {
        const res = fakeRes();
        await target[method]({ decoded_email: email, params: {}, query: {}, body: {}, headers: {}, ...req }, res);
        return res;
    };
    const wf = (method, email, req) => call(workflow, method, email, req);
    const notified = (recipientEmail, type, step) => c.notifications.countDocuments({ recipientEmail, type, ...(step ? { 'metadata.step': step } : {}) });
    const load = (id) => c.repairRequests.findOne({ _id: new ObjectId(id) });
    const ago = (days) => new Date(Date.now() - days * DAY);
    const insertRequest = async (overrides = {}) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `GAP-${runId}-${requestIds.length}`,
            product: { categorySlug: 'smartphone' }, service: { repairCategorySlug: 'display-screen' },
            serviceLocation: { region: 'Sylhet', district: 'Sylhet' }, technicianId: techId, technicianEmail: TECH,
            damage: { description: 'Remaining gaps test.', images: [] }, createdAt: new Date(), ...overrides,
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };

    try {
        await c.users.insertMany([
            { email: CUSTOMER, role: 'user', createdAt: new Date() },
            { email: STRANGER, role: 'user', createdAt: new Date() },
            { email: TECH, role: 'rider', createdAt: new Date() },
            { email: ADMIN, role: 'admin', createdAt: new Date() },
        ]);
        techId = (await c.technicians.insertOne({ name: `Gap Tech ${runId}`, email: TECH, region: 'Sylhet', district: 'Sylhet', status: 'approved', workStatus: 'available', createdAt: new Date() })).insertedId.toString();

        // ---- A. Payment after cancellation ----
        const late = await insertRequest({ deliveryStatus: 'cancelled', cancellationReason: 'payment_not_made', quote: { status: 'approved', totalAmount: 2500, currency: 'BDT', version: 1 } });
        const processPayment = createPaymentProcessor(models, c, notifications, { refundPayment });
        const session = {
            id: `cs_late_${runId}`, mode: 'payment', payment_status: 'paid', payment_intent: `pi_late_${runId}`, amount_total: 250000, currency: 'bdt',
            customer_email: CUSTOMER, metadata: { requestId: late },
        };
        const result = await processPayment({ session, source: 'webhook' });
        const row = await c.payments.findOne({ sessionId: session.id });
        logTest('Gap A: a payment for a cancelled request is refused but recorded - 2,500 taka, refund reason request_cancelled',
            result.code === 'REQUEST_CANCELLED' && row && row.amount === 2500 && row.purpose === 'repair' && row.refundReason === 'request_cancelled');
        logTest('Gap A: it is refunded at once, and the request never becomes paid',
            row.refundStatus === 'refunded' && refunds.some((r) => r.paymentIntentId === `pi_late_${runId}`) && (await load(late)).deliveryStatus === 'cancelled');
        const again = await processPayment({ session, source: 'browser', callerEmail: CUSTOMER });
        logTest('Gap A: the browser landing after the webhook also says cancelled, with no second refund',
            again.code === 'REQUEST_CANCELLED' && refunds.filter((r) => r.paymentIntentId === `pi_late_${runId}`).length === 1);

        // ---- B. Device return after a cancellation ----
        const closing = await insertRequest({ deliveryStatus: 'inspection_completed', inspection: { repairability: { decision: 'not_repairable', reason: 'Board is corroded.' } } });
        await closeUnpaidRequest({ collections: c, notifications, User: models.User, mongoClient: client, request: await load(closing), reason: 'not_repairable', closedBy: 'technician', actorEmail: TECH });
        logTest('Gap B: cancelling after pickup records that the device must go back',
            (await load(closing)).deviceReturn?.required === true);
        const activeIds = async () => (await call(repairRequests, 'getTechnicianRepairRequests', TECH, { query: {} })).body.map((r) => String(r._id));
        logTest('Gap B: the technician still sees the cancelled job in their active jobs until the device is back',
            (await activeIds()).includes(closing));
        logTest('Gap B: someone else cannot confirm the return',
            (await wf('confirmReturn', STRANGER, { params: { id: closing } })).statusCode === 404);
        const markedCancelled = await wf('markReturned', TECH, { params: { id: closing } });
        logTest('Gap B: the technician marks the device returned; the customer is told',
            markedCancelled.statusCode === 200 && (await notified(CUSTOMER, 'repair_update', 'device_returned')) >= 1);
        const confirmed = await wf('confirmReturn', CUSTOMER, { params: { id: closing } });
        logTest('Gap B: the customer confirms they got it back; the technician is told',
            confirmed.statusCode === 200 && !!(await load(closing)).deviceReturn.confirmedAt && (await notified(TECH, 'repair_update_technician', 'return_confirmed')) >= 1);
        logTest('Gap B: once the return is confirmed the job leaves the active list of the technician',
            !(await activeIds()).includes(closing));
        logTest('Gap B: a confirmed return cannot be confirmed or disputed again',
            (await wf('confirmReturn', CUSTOMER, { params: { id: closing } })).body.code === 'NOT_RETURNABLE'
            && (await wf('disputeReceipt', CUSTOMER, { params: { id: closing } })).body.code === 'NOT_DISPUTABLE');

        const quiet = await insertRequest({ deliveryStatus: 'cancelled', deviceReturn: { required: true, since: ago(5), markedAt: ago(4) } });
        const disputedReturn = await insertRequest({ deliveryStatus: 'cancelled', deviceReturn: { required: true, since: ago(5), markedAt: ago(4) } });
        await wf('disputeReceipt', CUSTOMER, { params: { id: disputedReturn }, body: { note: 'Not returned yet.' } });
        const auto = await workflow.autoConfirmReceipts();
        logTest('Gap B: 3 days after "returned" with no reply, the return is confirmed automatically',
            auto.returnsConfirmed >= 1 && (await load(quiet)).deviceReturn.method === 'auto' && (await notified(CUSTOMER, 'repair_update', 'return_auto_confirmed')) >= 1);
        logTest('Gap B: a disputed return is never confirmed automatically, and admins see the dispute',
            !(await load(disputedReturn)).deviceReturn.confirmedAt
            && (await new AdminAttentionController(models, c).buildAttention()).receiptDisputes.some((r) => r.id === disputedReturn));
        const adminSettled = await wf('adminConfirmReceipt', ADMIN, { params: { id: disputedReturn }, body: { note: 'Technician showed a signed handover slip.' } });
        logTest('Gap B: an admin settles it - return confirmed, dispute closed, both sides told',
            adminSettled.statusCode === 200 && !!(await load(disputedReturn)).deviceReturn.resolvedAt
            && !(await new AdminAttentionController(models, c).buildAttention()).receiptDisputes.some((r) => r.id === disputedReturn)
            && (await notified(CUSTOMER, 'repair_update', 'return_confirmed_by_admin')) >= 1);

        // ---- C. Stalled work ----
        const stalledRows = {
            not_inspected: await insertRequest({ deliveryStatus: 'parcel_picked_up', pickedUpAt: ago(4) }),
            no_quote: await insertRequest({ deliveryStatus: 'inspection_completed', inspection: { submittedAt: ago(4) } }),
            quote_unanswered: await insertRequest({ deliveryStatus: 'quote_submitted', quote: { submittedAt: ago(4) } }),
            repair_not_started: await insertRequest({ deliveryStatus: 'payment_completed', payment: { completedAt: ago(4) } }),
            repair_slow: await insertRequest({ deliveryStatus: 'repair_in_progress', repair: { startedAt: ago(15) } }),
            not_returned: await insertRequest({ deliveryStatus: 'repair_completed', repair: { completion: { completedAt: ago(4) } }, customerReceiptConfirmation: { status: 'pending' } }),
            cancelled_not_returned: await insertRequest({ deliveryStatus: 'cancelled', deviceReturn: { required: true, since: ago(4) } }),
            reschedule_unanswered: await insertRequest({ deliveryStatus: 'driver_assigned', pickupRescheduleRequestedAt: ago(4) }),
        };
        const freshRow = await insertRequest({ deliveryStatus: 'parcel_picked_up', pickedUpAt: ago(1) });
        const blockedRow = await insertRequest({ deliveryStatus: 'repair_in_progress', repair: { startedAt: ago(20) }, repairBlocked: { reason: 'No parts', reportedAt: ago(2) } });
        const stalled = await findStalledWork(c);
        const stageOf = (id) => stalled.find((item) => item.request._id.toString() === id)?.stage;
        logTest('Gap C: each kind of stalled work is found with its stage',
            Object.entries(stalledRows).every(([stage, id]) => stageOf(id) === stage));
        logTest('Gap C: on-time work and a repair already reported "cannot finish" are not listed as stalled',
            !stageOf(freshRow) && !stageOf(blockedRow));
        const attention = await new AdminAttentionController(models, c).buildAttention();
        logTest('Gap C: admins see stalled work in their attention list',
            attention.counts.stalled >= 8 && attention.stalled.some((s) => s.id === stalledRows.repair_slow && s.stage === 'repair_slow'));
        await workflow.alertStalled();
        await workflow.alertStalled();
        logTest('Gap C: admins are alerted once per request and stage, however often the job runs',
            (await c.notifications.countDocuments({ recipientEmail: ADMIN, type: 'repair_needs_admin', 'metadata.step': 'stalled', entityId: stalledRows.no_quote })) === 1);

        // ---- D. Pickup condition ----
        const pickup = await insertRequest({ deliveryStatus: 'rider_arriving' });
        const missingNote = await call(repairRequests, 'updateRepairRequestStatus', TECH, { params: { id: pickup }, body: { deliveryStatus: 'parcel_picked_up', pickupCondition: { note: 'ok' } } });
        logTest('Gap D: a pickup condition note that is too short is refused (and the device stays uncollected)',
            missingNote.statusCode === 400 && (await load(pickup)).deliveryStatus === 'rider_arriving');
        const picked = await call(repairRequests, 'updateRepairRequestStatus', TECH, {
            params: { id: pickup }, body: { deliveryStatus: 'parcel_picked_up', pickupCondition: { note: 'Small scratch on the back, screen cracked top left.', accessories: 'Charger, case' } },
        });
        const pickedRow = await load(pickup);
        logTest('Gap D: collecting the device records the time and the condition',
            picked.statusCode === 200 && pickedRow.pickedUpAt && pickedRow.pickupCondition.accessories === 'Charger, case');
        const noConditionPickup = await insertRequest({ deliveryStatus: 'rider_arriving' });
        logTest('Gap D: older apps that send no condition still work (time recorded)',
            (await call(repairRequests, 'updateRepairRequestStatus', TECH, { params: { id: noConditionPickup }, body: { deliveryStatus: 'parcel_picked_up' } })).statusCode === 200
            && !!(await load(noConditionPickup)).pickedUpAt);
        logTest('Gap D: only the owner can dispute, with an explanation',
            (await wf('disputePickupCondition', STRANGER, { params: { id: pickup }, body: { note: 'Not my device anyway.' } })).statusCode === 404
            && (await wf('disputePickupCondition', CUSTOMER, { params: { id: pickup }, body: { note: 'no' } })).statusCode === 400);
        const conditionDispute = await wf('disputePickupCondition', CUSTOMER, { params: { id: pickup }, body: { note: 'There was no crack on the screen when I gave it.' } });
        logTest('Gap D: the customer disputes the recorded condition; the technician and admins are told and admins see it',
            conditionDispute.statusCode === 200 && (await notified(TECH, 'repair_update_technician', 'condition_disputed')) === 1
            && (await new AdminAttentionController(models, c).buildAttention()).conditionDisputes.some((r) => r.id === pickup));
        const reviewed = await wf('adminReviewPickupCondition', ADMIN, { params: { id: pickup }, body: { note: 'Checked the pickup photos with both sides.' } });
        logTest('Gap D: an admin reviews it - off the list, customer told',
            reviewed.statusCode === 200 && !(await new AdminAttentionController(models, c).buildAttention()).conditionDisputes.some((r) => r.id === pickup)
            && (await notified(CUSTOMER, 'repair_update', 'condition_reviewed')) === 1);
        const customerView = await call(repairRequests, 'getRepairRequestById', CUSTOMER, { params: { id: pickup } });
        logTest('Gap D: the customer sees the condition and the review, but not which admin reviewed it',
            customerView.body.pickupCondition?.reviewNote && !('reviewedBy' in customerView.body.pickupCondition));

        // ---- E. Customer not home ----
        // Its pickup window has already ended, so without the report it would count as missed.
        const notHome = await insertRequest({ deliveryStatus: 'rider_arriving', pickupSlot: { date: '2026-10-13', slotId: 'morning', startsAt: ago(1.2), endsAt: ago(1) } });
        logTest('Gap E: before the report, a passed pickup window is on the missed-pickup list',
            (await new AdminAttentionController(models, c).buildAttention()).missedPickups.some((r) => r.id === notHome));
        logTest('Gap E: reporting the customer was not home needs an explanation',
            (await wf('customerNotAvailable', TECH, { params: { id: notHome }, body: { note: 'no' } })).statusCode === 400);
        const reportedNotHome = await wf('customerNotAvailable', TECH, { params: { id: notHome }, body: { note: 'Rang the bell and called twice, no answer.' } });
        const notHomeRow = await load(notHome);
        logTest('Gap E: the booking stays and the customer is asked for a new time (no refund, not a technician no-show)',
            reportedNotHome.statusCode === 200 && notHomeRow.deliveryStatus === 'rider_arriving' && notHomeRow.technicianEmail === TECH
            && !!notHomeRow.pickupRescheduleRequestedAt && notHomeRow.pickupAttempt.reportedBy === 'technician'
            && (await notified(CUSTOMER, 'repair_update', 'customer_not_home')) === 1);
        logTest('Gap E: it can only be reported once, and only while on the way to collect',
            (await wf('customerNotAvailable', TECH, { params: { id: notHome }, body: { note: 'Tried again, still nobody.' } })).body.code === 'NOT_REPORTABLE'
            && (await wf('customerNotAvailable', TECH, { params: { id: pickup }, body: { note: 'Already collected this one.' } })).body.code === 'NOT_REPORTABLE');
        logTest('Gap E: while waiting for the customer it is not on the missed-pickup list',
            !(await new AdminAttentionController(models, c).buildAttention()).missedPickups.some((r) => r.id === notHome));

        // ---- Routes ----
        const registered = [];
        routes({ post: (path, ...handlers) => registered.push({ path, handlers }) }, { workflow });
        const handlersOf = (path) => registered.find((r) => r.path === path).handlers;
        logTest('Gap routes: sign-in everywhere; "customer not home" needs a technician; condition review needs an admin',
            registered.every((r) => r.handlers[0] === verifyFBToken)
            && handlersOf('/repair-requests/:id/customer-not-available').includes(verifyTechnician)
            && handlersOf('/admin/repair-requests/:id/pickup-condition/reviewed').includes(verifyAdmin));
    } finally {
        const ids = requestIds.map(String);
        await c.payments.deleteMany({ requestId: { $in: ids } });
        await c.trackingEvents.deleteMany({ trackingId: { $regex: `^GAP-${runId}` } });
        await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        await c.notifications.deleteMany({ recipientEmail: { $in: emails } });
        if (techId) await c.technicians.deleteOne({ _id: new ObjectId(techId) });
        await c.users.deleteMany({ email: { $in: emails } });
    }
}

module.exports = { runRemainingGapsTests };
