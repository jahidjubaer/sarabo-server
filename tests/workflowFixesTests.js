// Workflow review fixes (2026-10-14): states where a repair used to get stuck.
//   1. approved quote never paid      -> closed after 3 days; customer can cancel before paying
//   2. inspection: not repairable     -> technician or customer closes it
//   3. paid repair cannot be finished -> technician reports, admin cancels and refunds
//   4. receipt never confirmed        -> technician marks returned, auto-confirm after
//                                        3 days, customer dispute, admin confirmation
//   +  warranty deadlines             -> overdue steps alert admins, who can take over;
//                                        a technician with open claims cannot be removed
// Stripe is faked; nothing external is called.
const { ObjectId } = require('mongodb');
const warranty = require('../utils/warranty');

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

function runWarrantyDeadlineUnitTests({ logTest }) {
    const now = new Date('2026-10-14T10:00:00Z');
    const ago = (days) => new Date(now.getTime() - days * DAY);
    logTest('Warranty deadline: a claim not booked within 3 days is overdue',
        warranty.overdueStep({ status: 'submitted', createdAt: ago(4) }, now)?.reason === 'not_booked'
        && warranty.overdueStep({ status: 'submitted', createdAt: ago(2) }, now) === null);
    logTest('Warranty deadline: no decision 3 days after the booked visit is overdue',
        warranty.overdueStep({ status: 'inspection_scheduled', inspection: { visitAt: ago(4) } }, now)?.reason === 'not_decided'
        && warranty.overdueStep({ status: 'inspection_scheduled', inspection: { visitAt: ago(1) } }, now) === null);
    logTest('Warranty deadline: not repaired 7 days after becoming covered is overdue (counted from the latest "covered")',
        warranty.overdueStep({ status: 'covered', history: [{ status: 'covered', at: ago(20) }, { status: 'review_requested', at: ago(10) }, { status: 'covered', at: ago(8) }] }, now)?.reason === 'not_repaired'
        && warranty.overdueStep({ status: 'covered', history: [{ status: 'covered', at: ago(5) }] }, now) === null);
    logTest('Warranty deadline: waiting on the customer or an admin is never "technician overdue"',
        ['not_covered', 'review_requested', 'fixed_pending_confirmation', 'refund_pending', 'resolved'].every((status) => warranty.overdueStep({ status, createdAt: ago(60) }, now) === null));
}

async function runWorkflowFixesTests({ logTest }) {
    runWarrantyDeadlineUnitTests({ logTest });

    const { connectDatabase, collections: c, client } = require('../config/database');
    const { initializeModels } = require('../models');
    const WorkflowController = require('../controllers/workflowController');
    const WarrantyController = require('../controllers/warrantyController');
    const TechnicianController = require('../controllers/technicianController');
    const AdminAttentionController = require('../controllers/adminAttentionController');
    const PickupReminderController = require('../controllers/pickupReminderController');
    const { closeUnpaidApprovedQuotes } = require('../services/requestClosure');
    const { createNotificationService } = require('../services/notificationService');
    const routes = require('../routes/workflow');
    const warrantyRoutes = require('../routes/warranty');
    const { verifyFBToken, verifyAdmin, verifyTechnician } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const CUSTOMER = `wf-customer-${runId}@example.test`;
    const STRANGER = `wf-stranger-${runId}@example.test`;
    const TECH = `wf-tech-${runId}@example.test`;
    const ADMIN = `wf-admin-${runId}@example.test`;
    const emails = [CUSTOMER, STRANGER, TECH, ADMIN];
    const requestIds = [];
    let techId = null;

    const refunds = [];
    let failRefunds = false;
    const refundPayment = async ({ paymentIntentId, idempotencyKey }) => {
        refunds.push({ paymentIntentId, idempotencyKey });
        if (failRefunds) throw new Error('Stripe is down (test)');
        return `re_${paymentIntentId}`;
    };
    const expired = [];
    const expireCheckout = async (sessionId) => { expired.push(sessionId); };
    const workflow = new WorkflowController(models, c, { refundPayment, expireCheckout, mongoClient: client });
    const call = async (target, method, email, req = {}) => {
        const res = fakeRes();
        await target[method]({ decoded_email: email, params: {}, query: {}, body: {}, ...req }, res);
        return res;
    };
    const wf = (method, email, req) => call(workflow, method, email, req);
    const notified = (recipientEmail, type, step) => c.notifications.countDocuments({ recipientEmail, type, ...(step ? { 'metadata.step': step } : {}) });
    const load = (id) => c.repairRequests.findOne({ _id: new ObjectId(id) });
    const techStatus = async (id = techId) => (await c.technicians.findOne({ _id: new ObjectId(id) })).workStatus;
    const setBusy = () => c.technicians.updateOne({ _id: new ObjectId(techId) }, { $set: { workStatus: 'in_delivery' } });
    // A busy technician with no other work, to check closing frees them.
    const extraTechIds = [];
    const soloTech = async (label) => {
        const email = `wf-${label}-${runId}@example.test`;
        emails.push(email);
        await c.users.insertOne({ email, role: 'rider', createdAt: new Date() });
        const { insertedId } = await c.technicians.insertOne({ name: `WF ${label} ${runId}`, email, region: 'Sylhet', district: 'Sylhet', status: 'approved', workStatus: 'in_delivery', createdAt: new Date() });
        extraTechIds.push(insertedId);
        return { technicianId: insertedId.toString(), technicianEmail: email };
    };

    const insertRequest = async (overrides = {}) => {
        const n = requestIds.length;
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `WF-${runId}-${n}`,
            product: { categorySlug: 'smartphone' }, service: { repairCategorySlug: 'display-screen' },
            serviceLocation: { region: 'Sylhet', district: 'Sylhet' }, technicianId: techId, technicianEmail: TECH,
            inspectionPayment: { status: 'paid', amount: 300, sessionId: `cs_${runId}_${n}`, technicianId: techId },
            createdAt: new Date(), ...overrides,
        });
        requestIds.push(insertedId);
        await c.payments.insertOne({ sessionId: `cs_${runId}_${n}`, transactionId: `pi_fee_${runId}_${n}`, requestId: insertedId.toString(), purpose: 'inspection_fee', amount: 300 });
        return insertedId.toString();
    };
    const approvedQuote = (daysAgo) => ({ deliveryStatus: 'quote_approved', quote: { status: 'approved', totalAmount: 2500, currency: 'BDT', decidedAt: new Date(Date.now() - daysAgo * DAY) } });
    const paidRepair = (status = 'repair_in_progress') => ({
        deliveryStatus: status, paymentStatus: 'paid', quote: { status: 'approved', totalAmount: 2500, currency: 'BDT' },
        technicianSettlement: { status: 'pending', technicianReceivable: 2250, platformCommission: 250, repairSubtotal: 2500 },
    });

    try {
        await c.users.insertMany([
            { email: CUSTOMER, role: 'user', createdAt: new Date() },
            { email: STRANGER, role: 'user', createdAt: new Date() },
            { email: TECH, role: 'rider', createdAt: new Date() },
            { email: ADMIN, role: 'admin', createdAt: new Date() },
        ]);
        const tech = await c.technicians.insertOne({ name: `WF Tech ${runId}`, email: TECH, region: 'Sylhet', district: 'Sylhet', status: 'approved', workStatus: 'in_delivery', createdAt: new Date() });
        techId = tech.insertedId.toString();

        // ---- 1. Approved quote never paid ----
        const staleTech = await soloTech('stale');
        const stale = await insertRequest({ ...approvedQuote(4), ...staleTech });
        const freshTech = await soloTech('fresh');
        const fresh = await insertRequest({ ...approvedQuote(2), ...freshTech });
        const paying = await insertRequest(approvedQuote(5));
        await c.checkoutSessions.insertOne({ requestId: paying, active: true, status: 'open', sessionId: `cs_open_${runId}`, expiresAt: new Date(Date.now() + DAY), createdAt: new Date() });
        const counts = await closeUnpaidApprovedQuotes({ collections: c, notifications: createNotificationService(models), User: models.User, mongoClient: client, expireCheckout });
        const staleRow = await load(stale);
        logTest('Fix 1: an approved quote unpaid for 3 days is closed - fee kept 90/10, technician freed',
            counts.closed >= 1 && staleRow.deliveryStatus === 'cancelled' && staleRow.cancellationReason === 'payment_not_made'
            && staleRow.inspectionPayment.status === 'kept' && staleRow.inspectionFeeSettlement.technicianReceivable === 270
            && (await techStatus(staleTech.technicianId)) === 'available');
        logTest('Fix 1: both sides are told; the technician is asked to return the device',
            (await notified(CUSTOMER, 'repair_update', 'payment_not_made')) === 1 && (await notified(staleTech.technicianEmail, 'repair_update_technician', 'payment_not_made')) === 1);
        logTest('Fix 1: a quote approved 2 days ago is left alone',
            (await load(fresh)).deliveryStatus === 'quote_approved');
        logTest('Fix 1: a request with a payment page open right now is skipped (tried again tomorrow)',
            (await load(paying)).deliveryStatus === 'quote_approved' && counts.skipped >= 1);

        logTest('Fix 1: another customer cannot cancel the request',
            (await wf('cancelUnpaid', STRANGER, { params: { id: fresh } })).statusCode === 404);
        logTest('Fix 1: the customer cannot cancel while their payment page is open',
            (await wf('cancelUnpaid', CUSTOMER, { params: { id: paying } })).body.code === 'PAYMENT_IN_PROGRESS');
        const cancelled = await wf('cancelUnpaid', CUSTOMER, { params: { id: fresh } });
        logTest('Fix 1: the customer cancels an approved quote before paying - closed, technician told and freed',
            cancelled.statusCode === 200 && (await load(fresh)).cancellationReason === 'customer_cancelled_unpaid'
            && (await notified(freshTech.technicianEmail, 'repair_update_technician', 'customer_cancelled_unpaid')) === 1 && (await techStatus(freshTech.technicianId)) === 'available');
        logTest('Fix 1: a request that is not an approved quote cannot be cancelled this way',
            (await wf('cancelUnpaid', CUSTOMER, { params: { id: fresh } })).body.code === 'NOT_CLOSABLE');

        // ---- 2. Not repairable ----
        const inspected = (decision) => ({ deliveryStatus: 'inspection_completed', inspection: { repairability: { decision, reason: 'Board is corroded beyond repair.' } } });
        const brokenTech = await soloTech('broken');
        const broken = await insertRequest({ ...inspected('not_repairable'), ...brokenTech });
        const fixable = await insertRequest(inspected('repairable'));
        const notWorth = await insertRequest(inspected('not_economical'));
        logTest('Fix 2: a repairable device cannot be closed as not repairable',
            (await wf('closeNotRepairable', TECH, { params: { id: fixable } })).body.code === 'NOT_CLOSABLE');
        logTest('Fix 2: someone unrelated (even another technician) cannot close it',
            (await wf('closeNotRepairable', STRANGER, { params: { id: broken } })).statusCode === 404
            && (await wf('closeNotRepairable', TECH, { params: { id: broken } })).statusCode === 404);
        const closedByTech = await wf('closeNotRepairable', brokenTech.technicianEmail, { params: { id: broken } });
        logTest('Fix 2: the technician closes a "not repairable" request - fee kept, technician freed, customer told',
            closedByTech.statusCode === 200 && closedByTech.body.inspectionFee === 'kept' && (await load(broken)).cancellationReason === 'not_repairable'
            && (await techStatus(brokenTech.technicianId)) === 'available' && (await notified(CUSTOMER, 'repair_update', 'not_repairable')) === 1);
        await setBusy();
        await wf('closeNotRepairable', CUSTOMER, { params: { id: notWorth } });
        logTest('Fix 2: a technician who still has other active work stays busy after one job closes',
            (await load(notWorth)).deliveryStatus === 'cancelled' && (await techStatus()) === 'in_delivery');
        logTest('Fix 2: the customer can close a "not worth repairing" request too',
            (await load(notWorth)).cancellationReason === 'not_repairable' && (await load(notWorth)).closedBy === 'customer');

        // ---- 3. Paid repair that cannot be finished ----
        const stuckTech = await soloTech('stuck');
        const stuck = await insertRequest({
            ...paidRepair(), ...stuckTech, payment: { status: 'completed', amount: 2200, inspectionCredit: 300, paymentIntentId: `pi_${runId}_stuck`, currency: 'BDT' },
        });
        await c.payments.insertOne({ transactionId: `pi_${runId}_stuck`, requestId: stuck, purpose: 'repair', amount: 2200, sessionId: `cs_repair_${runId}` });
        logTest('Fix 3: reporting "cannot complete" needs an explanation',
            (await wf('reportCannotComplete', stuckTech.technicianEmail, { params: { id: stuck }, body: { note: 'no' } })).statusCode === 400);
        const reported = await wf('reportCannotComplete', stuckTech.technicianEmail, { params: { id: stuck }, body: { note: 'The replacement board is out of stock everywhere.' } });
        logTest('Fix 3: the technician reports it; admins are alerted and see it in their list',
            reported.statusCode === 200 && (await notified(ADMIN, 'repair_needs_admin', 'cannot_complete')) === 1
            && (await new AdminAttentionController(models, c).buildAttention()).blockedRepairs.some((r) => r.id === stuck));
        logTest('Fix 3: reporting twice is refused',
            (await wf('reportCannotComplete', stuckTech.technicianEmail, { params: { id: stuck }, body: { note: 'Still out of stock, sorry.' } })).body.code === 'ALREADY_REPORTED');

        failRefunds = true;
        const failed = await wf('adminCancelPaidRepair', ADMIN, { params: { id: stuck }, body: { note: 'Parts unavailable; refunding the customer.' } });
        const afterFail = await load(stuck);
        logTest('Fix 3: if Stripe fails, the repair is still cancelled, the settlement reversed and the technician freed',
            failed.statusCode === 502 && afterFail.deliveryStatus === 'cancelled' && afterFail.technicianSettlement.status === 'reversed'
            && (await techStatus(stuckTech.technicianId)) === 'available' && (await notified(CUSTOMER, 'repair_update', 'paid_repair_cancelled')) === 1);
        failRefunds = false;
        const before = refunds.length;
        const retried = await wf('adminCancelPaidRepair', ADMIN, { params: { id: stuck } });
        const retryCalls = refunds.slice(before);
        logTest('Fix 3: the retry refunds the repair payment and the credited fee (2,500 taka) with stable keys',
            retried.statusCode === 200 && retried.body.refund.total === 2500 && retried.body.refund.refunded === true
            && retryCalls.length === 2 && retryCalls.every((r) => r.idempotencyKey.startsWith(`paid-cancel-refund-${stuck}-`)));
        const paymentRows = await c.payments.find({ requestId: stuck }).toArray();
        logTest('Fix 3: payment history shows both payments refunded',
            paymentRows.length === 2 && paymentRows.every((p) => p.refundStatus === 'refunded'));
        logTest('Fix 3: cancelling again is refused (never refunded twice); customers are told only once',
            (await wf('adminCancelPaidRepair', ADMIN, { params: { id: stuck } })).body.code === 'ALREADY_REFUNDED'
            && (await notified(CUSTOMER, 'repair_update', 'paid_repair_cancelled')) === 1);
        logTest('Fix 3: an unpaid request cannot be cancelled this way, and a note is required',
            (await wf('adminCancelPaidRepair', ADMIN, { params: { id: fixable }, body: { note: 'Trying an unpaid one.' } })).body.code === 'NOT_A_PAID_REPAIR'
            && (await wf('adminCancelPaidRepair', ADMIN, { params: { id: fixable } })).statusCode === 400);

        // ---- 4. Receipt never confirmed ----
        const finished = () => ({
            deliveryStatus: 'repair_completed', repair: { status: 'completed', completion: { completedAt: new Date() } },
            customerReceiptConfirmation: { status: 'pending', confirmedAt: null, confirmedBy: null },
            technicianSettlement: { status: 'pending', technicianReceivable: 1800, platformCommission: 200, repairSubtotal: 2000 },
        });
        const returned = await insertRequest(finished());
        logTest('Fix 4: only the repair\'s technician can mark it returned',
            (await wf('markReturned', STRANGER, { params: { id: returned } })).statusCode === 404);
        const marked = await wf('markReturned', TECH, { params: { id: returned } });
        logTest('Fix 4: the technician marks the device returned; the customer is asked to confirm within 3 days',
            marked.statusCode === 200 && new Date(marked.body.deviceReturn.autoConfirmAt) - new Date(marked.body.deviceReturn.markedAt) === 3 * DAY
            && (await notified(CUSTOMER, 'repair_update', 'device_returned')) === 1);
        logTest('Fix 4: marking it returned twice is refused', (await wf('markReturned', TECH, { params: { id: returned } })).body.code === 'NOT_RETURNABLE');

        const disputed = await insertRequest(finished());
        await wf('markReturned', TECH, { params: { id: disputed } });
        const dispute = await wf('disputeReceipt', CUSTOMER, { params: { id: disputed }, body: { note: 'Nobody came to return it.' } });
        logTest('Fix 4: the customer says "not received" - the technician and admins are told, and admins see it listed',
            dispute.statusCode === 200 && (await notified(TECH, 'repair_update_technician', 'receipt_disputed')) === 1
            && (await notified(ADMIN, 'repair_needs_admin', 'receipt_disputed')) === 1
            && (await new AdminAttentionController(models, c).buildAttention()).receiptDisputes.some((r) => r.id === disputed));

        // Move both return marks 4 days back, then run the daily confirmation.
        await c.repairRequests.updateMany({ _id: { $in: [new ObjectId(returned), new ObjectId(disputed)] } }, { $set: { 'deviceReturn.markedAt': new Date(Date.now() - 4 * DAY) } });
        const autoRun = await workflow.autoConfirmReceipts();
        const autoRow = await load(returned);
        logTest('Fix 4: 3 days after "returned", receipt is confirmed automatically - money released, warranty started',
            autoRun.confirmed >= 1 && autoRow.deliveryStatus === 'parcel_delivered' && autoRow.customerReceiptConfirmation.method === 'auto'
            && autoRow.customerReceiptConfirmation.confirmedBy === CUSTOMER && autoRow.technicianSettlement.status === 'available'
            && warranty.warrantyWindow(autoRow) !== null && (await notified(CUSTOMER, 'repair_update', 'receipt_auto_confirmed')) === 1);
        logTest('Fix 4: a disputed receipt is never confirmed automatically',
            (await load(disputed)).deliveryStatus === 'repair_completed');
        logTest('Fix 4: an admin settles the dispute only with an explanation',
            (await wf('adminConfirmReceipt', ADMIN, { params: { id: disputed }, body: { note: 'ok' } })).statusCode === 400);
        const settled = await wf('adminConfirmReceipt', ADMIN, { params: { id: disputed }, body: { note: 'Courier receipt shows it was delivered.' } });
        const settledRow = await load(disputed);
        logTest('Fix 4: the admin confirms receipt - money released, dispute marked resolved, both sides told',
            settled.statusCode === 200 && settledRow.customerReceiptConfirmation.method === 'admin' && settledRow.technicianSettlement.status === 'available'
            && !!settledRow.deviceReturn.resolvedAt && (await notified(TECH, 'repair_update_technician', 'receipt_confirmed_by_admin')) === 1);
        logTest('Fix 4: a confirmed repair cannot be disputed or confirmed again',
            (await wf('disputeReceipt', CUSTOMER, { params: { id: returned } })).body.code === 'NOT_DISPUTABLE'
            && (await wf('adminConfirmReceipt', ADMIN, { params: { id: returned }, body: { note: 'Confirming again for the test.' } })).body.code === 'NOT_CONFIRMABLE');

        // ---- Warranty deadlines ----
        const warrantyController = new WarrantyController(models, c, { mongoClient: client, storage: { createReadUrl: async () => null } });
        const claimRequest = await insertRequest({ deliveryStatus: 'parcel_delivered' });
        const insertClaim = async (overrides) => (await c.warrantyClaims.insertOne({
            requestId: claimRequest, trackingId: `WF-${runId}-claim`, customerEmail: CUSTOMER, technicianId: techId, technicianEmail: TECH,
            kind: 'same_fault', description: 'The screen flickers again like before.', photos: [], createdAt: new Date(), updatedAt: new Date(), history: [], ...overrides,
        })).insertedId.toString();
        const lateClaim = await insertClaim({ status: 'submitted', createdAt: new Date(Date.now() - 4 * DAY) });
        const onTimeClaim = await insertClaim({ status: 'submitted' });
        const queue = await call(warrantyController, 'listForAdmin', ADMIN, { query: {} });
        const ids = queue.body.claims.map((cl) => cl.id);
        logTest('Warranty deadline: the admin queue shows a claim not booked in 3 days (marked overdue), not an on-time one',
            ids.includes(lateClaim) && !ids.includes(onTimeClaim) && queue.body.claims.find((cl) => cl.id === lateClaim).overdue.reason === 'not_booked');
        await warrantyController.alertOverdueClaims();
        await warrantyController.alertOverdueClaims();
        logTest('Warranty deadline: admins are alerted once per late step, however often the job runs',
            (await notified(ADMIN, 'repair_needs_admin', 'warranty_overdue')) === 1);

        const technicianController = new TechnicianController(models, c);
        logTest('Warranty deadline: a technician with an open claim cannot be removed',
            (await technicianController.hasOpenWarrantyClaim({ _id: new ObjectId(techId) })) === true);
        const takeOver = await call(warrantyController, 'adminDecide', ADMIN, { params: { claimId: lateClaim }, body: { covered: true, note: 'Same fault, clearly covered.' } });
        logTest('Warranty deadline: an admin takes over the decision - covered; customer and technician told',
            takeOver.statusCode === 200 && takeOver.body.claim.status === 'covered' && (await notified(CUSTOMER, 'warranty_update', 'covered')) === 1);
        const toRefund = await call(warrantyController, 'adminCannotFix', ADMIN, { params: { claimId: lateClaim }, body: { note: 'Technician unreachable.' } });
        logTest('Warranty deadline: an admin moves a covered claim nobody repaired to a refund',
            toRefund.body.claim.status === 'refund_pending' && toRefund.body.claim.rerepair.outcome === 'cannot_fix');
        await c.warrantyClaims.updateMany({ requestId: claimRequest }, { $set: { status: 'resolved' } });
        logTest('Warranty deadline: with no open claims the technician can be removed again',
            (await technicianController.hasOpenWarrantyClaim({ _id: new ObjectId(techId) })) === false);

        // ---- The daily job runs all three ----
        const dailyStale = await insertRequest(approvedQuote(6));
        const reminders = new PickupReminderController(models, c, { emailService: { enabled: false }, mongoClient: client, workflow, warranty: warrantyController, expireCheckout });
        const daily = await reminders.runWorkflowJobs();
        logTest('Daily job: closes unpaid quotes, confirms receipts and checks warranty deadlines in one run',
            daily.unpaidClosed.closed >= 1 && (await load(dailyStale)).deliveryStatus === 'cancelled'
            && typeof daily.receiptsConfirmed.found === 'number' && typeof daily.warrantyOverdue.found === 'number');

        // ---- Routes ----
        const registered = [];
        const app = { get: (path, ...handlers) => registered.push({ path, handlers }), post: (path, ...handlers) => registered.push({ path, handlers }) };
        routes(app, { workflow });
        warrantyRoutes(app, { warranty: warrantyController });
        const handlersOf = (path) => registered.find((r) => r.path === path).handlers;
        logTest('Routes: all need sign-in; technician actions need the technician role; admin actions need admin',
            registered.every((r) => r.handlers[0] === verifyFBToken)
            && ['/repair-requests/:id/repair/cannot-complete', '/repair-requests/:id/mark-returned'].every((p) => handlersOf(p).includes(verifyTechnician))
            && ['/admin/repair-requests/:id/cancel-paid-repair', '/admin/repair-requests/:id/confirm-receipt', '/admin/warranty-claims/:claimId/decision', '/admin/warranty-claims/:claimId/cannot-fix']
                .every((p) => handlersOf(p).includes(verifyAdmin)));
    } finally {
        const ids = requestIds.map(String);
        await c.warrantyClaims.deleteMany({ requestId: { $in: ids } });
        await c.checkoutSessions.deleteMany({ requestId: { $in: ids } });
        await c.payments.deleteMany({ requestId: { $in: ids } });
        await c.trackingEvents.deleteMany({ trackingId: { $regex: `^WF-${runId}` } });
        await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        await c.notifications.deleteMany({ recipientEmail: { $in: emails } });
        if (techId) await c.technicians.deleteOne({ _id: new ObjectId(techId) });
        await c.technicians.deleteMany({ _id: { $in: extraTechIds } });
        await c.users.deleteMany({ email: { $in: emails } });
    }
}

module.exports = { runWorkflowFixesTests, runWarrantyDeadlineUnitTests };
