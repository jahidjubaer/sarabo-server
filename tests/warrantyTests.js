// Repair warranty and returns: the policy rules (utils/warranty.js), the wallet
// effect of a warranty refund (utils/settlement.js), and the whole claim flow
// through controllers/warrantyController.js with fake photo storage and a fake
// Stripe refunder - nothing external is called.
const { ObjectId } = require('mongodb');
const warranty = require('../utils/warranty');
const { calculateWallet, SETTLEMENT_AVAILABLE, SETTLEMENT_REVERSED } = require('../utils/settlement');

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

function finishedRepair(confirmedAt, overrides = {}) {
    return {
        schemaVersion: 2,
        repair: { status: 'completed', completion: { completedAt: confirmedAt } },
        customerReceiptConfirmation: { status: 'confirmed', confirmedAt, confirmedBy: 'c@x.test' },
        ...overrides,
    };
}

function runWarrantyUnitTests({ logTest }) {
    const now = new Date('2026-10-14T10:00:00Z');
    const confirmed = new Date(now.getTime() - 10 * DAY);
    const win = warranty.warrantyWindow(finishedRepair(confirmed));
    logTest('Warranty: 30 days counted from the customer confirming receipt',
        win && win.startsAt.getTime() === confirmed.getTime() && win.endsAt.getTime() === confirmed.getTime() + 30 * DAY);
    logTest('Warranty: no warranty before receipt is confirmed, or on an old (v1) request',
        warranty.warrantyWindow(finishedRepair(confirmed, { customerReceiptConfirmation: { status: 'pending' } })) === null
        && warranty.warrantyWindow(finishedRepair(confirmed, { schemaVersion: 1 })) === null);

    const elig = (request, claims = []) => warranty.claimEligibility(request, claims, now).code || 'ok';
    logTest('Warranty: eligibility - open, expired, not started',
        elig(finishedRepair(confirmed)) === 'ok'
        && elig(finishedRepair(new Date(now.getTime() - 31 * DAY))) === 'WARRANTY_EXPIRED'
        && elig(finishedRepair(confirmed, { customerReceiptConfirmation: null })) === 'WARRANTY_NOT_STARTED');
    const notCoveredRecent = { status: 'not_covered', decision: { decidedAt: new Date(now.getTime() - 2 * DAY) } };
    const notCoveredOld = { status: 'not_covered', decision: { decidedAt: new Date(now.getTime() - 8 * DAY) } };
    logTest('Warranty: one open claim at a time; "not covered" stays open only for its 7-day review window',
        elig(finishedRepair(confirmed), [{ status: 'submitted' }]) === 'CLAIM_ALREADY_OPEN'
        && elig(finishedRepair(confirmed), [notCoveredRecent]) === 'CLAIM_ALREADY_OPEN'
        && elig(finishedRepair(confirmed), [notCoveredOld]) === 'ok');
    logTest('Warranty: at most two claims per repair',
        elig(finishedRepair(confirmed), [{ status: 'resolved' }, { status: 'rejected' }]) === 'CLAIM_LIMIT_REACHED');

    const claim = (body) => warranty.validateClaimInput(body);
    logTest('Warranty: a claim needs a covered kind and a 20-1000 character description',
        claim({ kind: 'same_fault', description: 'The screen flickers again like before.' }).valid
        && claim({ kind: 'water_damage', description: 'The screen flickers again like before.' }).code === 'INVALID_CLAIM_KIND'
        && claim({ kind: 'part_failed', description: 'broken' }).code === 'INVALID_DESCRIPTION');
    logTest('Warranty: at most 4 photo ids, each a real upload id, no repeats',
        claim({ kind: 'same_fault', description: 'x'.repeat(30), photoIds: ['../../etc/passwd'] }).code === 'INVALID_PHOTOS'
        && claim({ kind: 'same_fault', description: 'x'.repeat(30), photoIds: Array(5).fill(0).map(() => require('crypto').randomUUID()) }).code === 'INVALID_PHOTOS');
    logTest('Warranty: a re-inspection visit must be within the next 14 days',
        warranty.validateScheduleInput({ visitAt: new Date(now.getTime() + DAY).toISOString() }, now).valid
        && !warranty.validateScheduleInput({ visitAt: new Date(now.getTime() + 15 * DAY).toISOString() }, now).valid
        && !warranty.validateScheduleInput({ visitAt: 'tomorrow' }, now).valid);
    logTest('Warranty: "not covered" needs a reason from the list and an explanation',
        warranty.validateDecisionInput({ covered: true }).valid
        && warranty.validateDecisionInput({ covered: false, reason: 'drop_damage', note: 'short' }).code === 'NOTE_REQUIRED'
        && warranty.validateDecisionInput({ covered: false, reason: 'lazy', note: 'Long enough explanation' }).code === 'INVALID_REASON'
        && warranty.validateDecisionInput({ covered: false, reason: 'water_damage', note: 'Corrosion inside the charging port.' }).valid);

    const plan = warranty.refundPlan({
        payment: { status: 'completed', amount: 2200, inspectionCredit: 300, paymentIntentId: 'pi_repair', currency: 'BDT' },
        inspectionPayment: { status: 'paid', amount: 300, sessionId: 'cs_fee' },
    });
    logTest('Warranty: the refund is the whole quote total - repair payment plus the credited inspection fee',
        plan.total === 2500 && plan.parts.length === 2 && plan.parts[0].paymentIntentId === 'pi_repair' && plan.parts[1].sessionId === 'cs_fee');
    logTest('Warranty: no inspection fee part when no fee was credited',
        warranty.refundPlan({ payment: { status: 'completed', amount: 1800, inspectionCredit: 0, paymentIntentId: 'pi' } }).parts.length === 1);
    logTest('Warranty: claim photos get a server-made key in their own warranty folder',
        warranty.generateClaimPhotoStorageKey('abc', 'image/png', 'u1') === 'repair-requests/abc/warranty/u1.png'
        && warranty.generateClaimPhotoStorageKey('abc', 'image/gif', 'u1') === null);

    const settlement = (status, amount) => ({ technicianSettlement: { status, technicianReceivable: amount } });
    const wallet = calculateWallet({
        repairRequests: [settlement(SETTLEMENT_AVAILABLE, 1000), settlement(SETTLEMENT_REVERSED, 2250)],
        withdrawals: [{ status: 'paid', amount: 3250 }],
    });
    logTest('Wallet: a reversed (refunded) settlement no longer counts, and what was already paid out shows as owed',
        wallet.grossAvailableBalance === 1000 && wallet.availableBalance === 0 && wallet.owedBalance === 2250 && wallet.lifetimeReceivable === 1000);
    logTest('Wallet: nothing is owed in the normal case',
        calculateWallet({ repairRequests: [settlement(SETTLEMENT_AVAILABLE, 900)], withdrawals: [{ status: 'paid', amount: 400 }] }).owedBalance === 0);
}

async function runWarrantyTests({ logTest }) {
    runWarrantyUnitTests({ logTest });

    const { connectDatabase, collections: c, client } = require('../config/database');
    const { initializeModels } = require('../models');
    const WarrantyController = require('../controllers/warrantyController');
    const routes = require('../routes/warranty');
    const { verifyFBToken, verifyAdmin, verifyTechnician, verifyEmailVerified } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const CUSTOMER = `warranty-customer-${runId}@example.test`;
    const STRANGER = `warranty-stranger-${runId}@example.test`;
    const TECH = `warranty-tech-${runId}@example.test`;
    const OTHER_TECH = `warranty-other-${runId}@example.test`;
    const ADMIN = `warranty-admin-${runId}@example.test`;
    const emails = [CUSTOMER, STRANGER, TECH, OTHER_TECH, ADMIN];
    const requestIds = [];
    let techId = null;

    const storageCalls = [];
    const storage = {
        createUploadTarget: async ({ storageKey }) => { storageCalls.push(storageKey); return { method: 'PUT', uploadUrl: `https://storage.invalid/${storageKey}` }; },
        verifyObject: async () => ({ exists: true, mimeType: 'image/jpeg', size: 2048 }),
        createReadUrl: async ({ storageKey }) => `https://storage.invalid/read/${storageKey}`,
    };
    const refunds = [];
    let failRefunds = true;
    const refundPayment = async ({ paymentIntentId, idempotencyKey }) => {
        refunds.push({ paymentIntentId, idempotencyKey });
        if (failRefunds) throw new Error('Stripe is down (test)');
        return `re_${paymentIntentId}`;
    };
    const controller = new WarrantyController(models, c, { storage, refundPayment, mongoClient: client });
    const call = async (method, email, req = {}) => {
        const res = fakeRes();
        await controller[method]({ decoded_email: email, params: {}, query: {}, body: {}, ...req }, res);
        return res;
    };
    const notified = (recipientEmail, type, step) => c.notifications.countDocuments({ recipientEmail, type, ...(step ? { 'metadata.step': step } : {}) });

    const insertRequest = async (confirmedDaysAgo, overrides = {}) => {
        const confirmedAt = confirmedDaysAgo === null ? null : new Date(Date.now() - confirmedDaysAgo * DAY);
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `WAR-${runId}-${requestIds.length}`,
            product: { categorySlug: 'smartphone' }, service: { repairCategorySlug: 'display-screen' },
            serviceLocation: { region: 'Sylhet', district: 'Sylhet' },
            technicianId: techId, technicianEmail: TECH,
            deliveryStatus: confirmedAt ? 'parcel_delivered' : 'repair_completed',
            repair: { status: 'completed', completion: { completedAt: new Date() } },
            customerReceiptConfirmation: confirmedAt ? { status: 'confirmed', confirmedAt, confirmedBy: CUSTOMER } : { status: 'pending' },
            quote: { status: 'approved', totalAmount: 2500, currency: 'BDT' },
            payment: { status: 'completed', amount: 2200, inspectionCredit: 300, paymentIntentId: `pi_${runId}_${requestIds.length}`, currency: 'BDT' },
            inspectionPayment: { status: 'paid', amount: 300, sessionId: `cs_${runId}_${requestIds.length}` },
            technicianSettlement: { status: SETTLEMENT_AVAILABLE, technicianReceivable: 2250, platformCommission: 250, repairSubtotal: 2500 },
            createdAt: new Date(),
            ...overrides,
        });
        requestIds.push(insertedId);
        await c.payments.insertOne({ sessionId: `cs_${runId}_${requestIds.length - 1}`, transactionId: `pi_fee_${runId}_${requestIds.length - 1}`, requestId: insertedId.toString(), purpose: 'inspection_fee', amount: 300 });
        return insertedId.toString();
    };
    const description = 'The screen started flickering again, same as before the repair.';

    try {
        await c.users.insertMany([
            { email: CUSTOMER, role: 'user', createdAt: new Date() },
            { email: STRANGER, role: 'user', createdAt: new Date() },
            { email: TECH, role: 'rider', createdAt: new Date() },
            { email: OTHER_TECH, role: 'rider', createdAt: new Date() },
            { email: ADMIN, role: 'admin', createdAt: new Date() },
        ]);
        const tech = await c.technicians.insertOne({ name: `Warranty Tech ${runId}`, email: TECH, region: 'Sylhet', district: 'Sylhet', status: 'approved', createdAt: new Date() });
        techId = tech.insertedId.toString();

        // ---- Before the warranty starts / after it ends ----
        const unconfirmed = await insertRequest(null);
        const early = await call('getForRequest', CUSTOMER, { params: { id: unconfirmed } });
        logTest('Warranty (API): no claim before the customer confirms receipt',
            early.statusCode === 200 && early.body.canClaim === false && early.body.cannotClaimReason === 'WARRANTY_NOT_STARTED' && early.body.warranty === null
            && (await call('openClaim', CUSTOMER, { params: { id: unconfirmed }, body: { kind: 'same_fault', description } })).body.code === 'WARRANTY_NOT_STARTED');
        const expired = await insertRequest(31);
        logTest('Warranty (API): no claim after 30 days',
            (await call('openClaim', CUSTOMER, { params: { id: expired }, body: { kind: 'same_fault', description } })).body.code === 'WARRANTY_EXPIRED');

        // ---- Opening a claim with a photo ----
        const repair = await insertRequest(10);
        const view = await call('getForRequest', CUSTOMER, { params: { id: repair } });
        logTest('Warranty (API): the customer sees 30 days of cover and can claim',
            view.body.canClaim === true && view.body.warranty.days === 30 && view.headers['Cache-Control'] === 'private, no-store');
        logTest('Warranty (API): another customer cannot see or claim on the repair',
            (await call('getForRequest', STRANGER, { params: { id: repair } })).statusCode === 404
            && (await call('openClaim', STRANGER, { params: { id: repair }, body: { kind: 'same_fault', description } })).statusCode === 404);

        const upload = await call('createPhotoUpload', CUSTOMER, { params: { id: repair }, body: { fileName: 'screen.jpg', mimeType: 'image/jpeg', size: 2048 } });
        logTest('Warranty (API): a photo upload link is made in the warranty folder',
            upload.statusCode === 201 && storageCalls.some((k) => k.startsWith(`repair-requests/${repair}/warranty/`)));
        const opened = await call('openClaim', CUSTOMER, { params: { id: repair }, body: { kind: 'same_fault', description, photoIds: [upload.body.photoId] } });
        const claimId = opened.body.claim && opened.body.claim.id;
        logTest('Warranty (API): the customer opens a claim with the photo; the technician is told',
            opened.statusCode === 201 && opened.body.claim.status === 'submitted' && opened.body.claim.photos.length === 1
            && opened.body.claim.photos[0].url.startsWith('https://storage.invalid/read/') && (await notified(TECH, 'warranty_update_technician', 'opened')) === 1);
        logTest('Warranty (API): the customer view shows no storage key, emails or history',
            !JSON.stringify(opened.body).includes('storageKey') && !('customerEmail' in opened.body.claim) && !('history' in opened.body.claim));
        logTest('Warranty (API): a second claim while one is open is refused',
            (await call('openClaim', CUSTOMER, { params: { id: repair }, body: { kind: 'part_failed', description } })).body.code === 'CLAIM_ALREADY_OPEN');
        const reused = await call('openClaim', CUSTOMER, { params: { id: await insertRequest(5) }, body: { kind: 'same_fault', description, photoIds: [upload.body.photoId] } });
        logTest('Warranty (API): a photo from another repair cannot be attached', reused.body.code === 'PHOTO_NOT_FOUND');

        // ---- Technician: re-inspection and decision ----
        logTest('Warranty (API): only the repair\'s own technician can act on the claim',
            (await call('schedule', OTHER_TECH, { params: { claimId }, body: { visitAt: new Date(Date.now() + DAY).toISOString() } })).statusCode === 404);
        logTest('Warranty (API): no decision before the re-inspection is booked',
            (await call('decide', TECH, { params: { claimId }, body: { covered: true } })).body.code === 'INSPECTION_NOT_BOOKED');
        const scheduled = await call('schedule', TECH, { params: { claimId }, body: { visitAt: new Date(Date.now() + DAY).toISOString(), note: 'I will come in the morning.' } });
        logTest('Warranty (API): the technician books the free re-inspection and the customer is told',
            scheduled.body.claim.status === 'inspection_scheduled' && (await notified(CUSTOMER, 'warranty_update', 'inspection_scheduled')) === 1);
        await call('schedule', TECH, { params: { claimId }, body: { visitAt: new Date(Date.now() + 2 * DAY).toISOString() } });
        logTest('Warranty (API): rebooking the visit tells the customer again', (await notified(CUSTOMER, 'warranty_update', 'inspection_scheduled')) === 2);

        const notCovered = await call('decide', TECH, { params: { claimId }, body: { covered: false, reason: 'drop_damage', note: 'The frame is bent from a fall; that is new damage.' } });
        logTest('Warranty (API): "not covered" is saved and the customer may ask for a review',
            notCovered.body.claim.status === 'not_covered' && (await notified(CUSTOMER, 'warranty_update', 'not_covered')) === 1
            && (await call('getForRequest', CUSTOMER, { params: { id: repair } })).body.claims[0].canRequestReview === true);
        logTest('Warranty (API): a decided claim cannot be decided again',
            (await call('decide', TECH, { params: { claimId }, body: { covered: true } })).body.code === 'CLAIM_ALREADY_DECIDED');

        // ---- Admin review: overturned ----
        const review = await call('requestReview', CUSTOMER, { params: { claimId }, body: { note: 'I never dropped it.' } });
        logTest('Warranty (API): the customer asks for a review; admins and the technician are told',
            review.body.claim.status === 'review_requested' && (await notified(ADMIN, 'warranty_admin_action', 'review_requested')) === 1
            && (await notified(TECH, 'warranty_update_technician', 'review_requested')) === 1);
        const queue = await call('listForAdmin', ADMIN, { query: {} });
        logTest('Warranty (API): the admin queue lists claims waiting for an admin, with the people involved',
            queue.body.claims.some((cl) => cl.id === claimId && cl.customerEmail === CUSTOMER && cl.history.length >= 4));
        logTest('Warranty (API): a review decision needs an explanation',
            (await call('adminReview', ADMIN, { params: { claimId }, body: { decision: 'overturn' } })).body.code === 'NOTE_REQUIRED');
        const overturned = await call('adminReview', ADMIN, { params: { claimId }, body: { decision: 'overturn', note: 'Photos show the same flicker; no sign of a drop.' } });
        logTest('Warranty (API): the admin overturns it - covered - and both sides are told',
            overturned.body.claim.status === 'covered' && (await notified(CUSTOMER, 'warranty_update', 'review_overturned')) === 1
            && (await notified(TECH, 'warranty_update_technician', 'review_overturned')) === 1);

        // ---- Cannot fix -> refund ----
        const cannotFix = await call('reportRerepair', TECH, { params: { claimId }, body: { outcome: 'cannot_fix', note: 'The replacement panel is no longer made.' } });
        logTest('Warranty (API): the technician cannot fix it again - the claim waits for an admin refund',
            cannotFix.body.claim.status === 'refund_pending' && (await notified(ADMIN, 'warranty_admin_action', 'refund_needed')) === 1);
        const failed = await call('adminRefund', ADMIN, { params: { claimId } });
        const afterFail = await c.repairRequests.findOne({ _id: new ObjectId(repair) });
        logTest('Warranty (API): if Stripe fails, the claim stays pending but the technician\'s share is already reversed',
            failed.statusCode === 502 && failed.body.claim.status === 'refund_pending' && afterFail.technicianSettlement.status === SETTLEMENT_REVERSED
            && afterFail.technicianSettlement.reversalReason === 'warranty_refund');
        failRefunds = false;
        const before = refunds.length;
        const done = await call('adminRefund', ADMIN, { params: { claimId } });
        const keys = refunds.slice(before).map((r) => r.idempotencyKey);
        logTest('Warranty (API): the retry refunds the repair payment and the credited inspection fee (2,500 taka)',
            done.statusCode === 200 && done.body.claim.status === 'refunded' && done.body.claim.refund.total === 2500
            && refunds.slice(before).some((r) => r.paymentIntentId.startsWith('pi_fee_'))
            && keys.every((k) => k.startsWith(`warranty-refund-${claimId}-`)));
        logTest('Warranty (API): refunding again is refused (never twice), and both sides are told once',
            (await call('adminRefund', ADMIN, { params: { claimId } })).body.code === 'ALREADY_REFUNDED'
            && (await notified(CUSTOMER, 'warranty_update', 'refunded')) === 1 && (await notified(TECH, 'warranty_update_technician', 'refunded')) === 1);
        const techWallet = calculateWallet({ repairRequests: [afterFail] });
        logTest('Warranty (API): the refunded repair no longer counts in the technician\'s wallet', techWallet.grossAvailableBalance === 0 && techWallet.lifetimeReceivable === 0);

        // ---- Covered -> fixed -> confirmed ----
        const second = await insertRequest(3);
        const claim2 = (await call('openClaim', CUSTOMER, { params: { id: second }, body: { kind: 'part_failed', description } })).body.claim.id;
        await call('schedule', TECH, { params: { claimId: claim2 }, body: { visitAt: new Date(Date.now() + DAY).toISOString() } });
        await call('decide', TECH, { params: { claimId: claim2 }, body: { covered: true, note: 'The new battery is faulty.' } });
        const fixed = await call('reportRerepair', TECH, { params: { claimId: claim2 }, body: { outcome: 'fixed', note: 'Battery replaced again.' } });
        logTest('Warranty (API): covered and repaired again - the customer is asked to confirm',
            fixed.body.claim.status === 'fixed_pending_confirmation' && (await notified(CUSTOMER, 'warranty_update', 'fixed')) === 1);
        logTest('Warranty (API): only the customer can confirm their claim',
            (await call('confirmFix', STRANGER, { params: { claimId: claim2 }, body: { fixed: true } })).statusCode === 404);
        const resolved = await call('confirmFix', CUSTOMER, { params: { claimId: claim2 }, body: { fixed: true } });
        const secondRow = await c.repairRequests.findOne({ _id: new ObjectId(second) });
        logTest('Warranty (API): the customer confirms it works - resolved, with no refund and the wallet untouched',
            resolved.body.claim.status === 'resolved' && !resolved.body.claim.refund && secondRow.technicianSettlement.status === SETTLEMENT_AVAILABLE
            && (await notified(TECH, 'warranty_update_technician', 'confirmed_fixed')) === 1);
        const technicianList = await call('listForTechnician', TECH);
        logTest('Warranty (API): the technician lists their own claims only',
            technicianList.body.claims.length >= 2 && technicianList.body.claims.every((cl) => [claimId, claim2].includes(cl.id))
            && (await call('listForTechnician', OTHER_TECH)).body.claims.length === 0);

        // ---- Review window closes ----
        const third = await insertRequest(20);
        const claim3 = (await call('openClaim', CUSTOMER, { params: { id: third }, body: { kind: 'same_fault', description } })).body.claim.id;
        await call('schedule', TECH, { params: { claimId: claim3 }, body: { visitAt: new Date(Date.now() + DAY).toISOString() } });
        await call('decide', TECH, { params: { claimId: claim3 }, body: { covered: false, reason: 'water_damage', note: 'Corrosion around the charging port.' } });
        await c.warrantyClaims.updateOne({ _id: new ObjectId(claim3) }, { $set: { 'decision.decidedAt': new Date(Date.now() - 8 * DAY) } });
        logTest('Warranty (API): after 7 days a "not covered" decision can no longer be reviewed, and a new claim may be opened',
            (await call('requestReview', CUSTOMER, { params: { claimId: claim3 } })).body.code === 'REVIEW_WINDOW_CLOSED'
            && (await call('getForRequest', CUSTOMER, { params: { id: third } })).body.canClaim === true);
        logTest('Warranty (API): the admin list rejects an unknown filter',
            (await call('listForAdmin', ADMIN, { query: { status: 'whatever' } })).statusCode === 400);

        // ---- Routes ----
        const registered = [];
        const app = { get: (path, ...handlers) => registered.push({ method: 'GET', path, handlers }), post: (path, ...handlers) => registered.push({ method: 'POST', path, handlers }) };
        routes(app, { warranty: controller });
        const find = (method, path) => registered.find((r) => r.method === method && r.path === path);
        logTest('Warranty (routes): every route needs sign-in; technician and admin routes check the role; opening a claim needs a verified email',
            registered.every((r) => r.handlers[0] === verifyFBToken)
            && ['/warranty-claims/:claimId/schedule', '/warranty-claims/:claimId/decision', '/warranty-claims/:claimId/rerepair'].every((p) => find('POST', p).handlers.includes(verifyTechnician))
            && find('GET', '/technician/warranty-claims').handlers.includes(verifyTechnician)
            && ['/admin/warranty-claims/:claimId/review', '/admin/warranty-claims/:claimId/refund'].every((p) => find('POST', p).handlers.includes(verifyAdmin))
            && find('GET', '/admin/warranty-claims').handlers.includes(verifyAdmin)
            && find('POST', '/repair-requests/:id/warranty-claims').handlers.includes(verifyEmailVerified));
    } finally {
        const ids = requestIds.map(String);
        await c.warrantyClaims.deleteMany({ requestId: { $in: ids } });
        await c.warrantyPhotoUploads.deleteMany({ requestId: { $in: ids } });
        await c.payments.deleteMany({ requestId: { $in: ids } });
        await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        await c.notifications.deleteMany({ recipientEmail: { $in: emails } });
        if (techId) await c.technicians.deleteOne({ _id: new ObjectId(techId) });
        await c.users.deleteMany({ email: { $in: emails } });
    }
}

module.exports = { runWarrantyTests, runWarrantyUnitTests };
