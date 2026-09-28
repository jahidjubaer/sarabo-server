// Inspection fee (job-portal phase C): choosing a technician with a fee opens
// a Stripe checkout; the technician is booked only when the payment is
// confirmed; the fee counts toward the repair payment; if the technician can
// no longer be booked, the fee is refunded. A fake Stripe records every call.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

function createFakeStripe(runId) {
    const fixtures = new Map();
    const fake = {
        created: [],
        expired: [],
        checkout: {
            sessions: {
                create: async (params, options = {}) => {
                    const id = `cs_test_fee_${runId}_${fake.created.length}`;
                    fixtures.set(id, { status: 'open', url: `https://checkout.stripe.test/${id}`, params });
                    fake.created.push({ id, params, options });
                    return { id, url: `https://checkout.stripe.test/${id}`, status: 'open', expires_at: Math.floor(Date.now() / 1000) + 1800 };
                },
                retrieve: async (id) => ({ id, ...fixtures.get(id) }),
                expire: async (id) => { fake.expired.push(id); fixtures.set(id, { ...fixtures.get(id), status: 'expired' }); return { id }; },
            },
        },
        // What Stripe would send back once the customer pays `id`.
        paidSession(id, overrides = {}) {
            const { params } = fixtures.get(id);
            return {
                id, mode: 'payment', payment_status: 'paid', payment_intent: `pi_${id}`,
                amount_total: params.line_items[0].price_data.unit_amount, currency: params.line_items[0].price_data.currency,
                customer_email: params.customer_email, metadata: params.metadata, ...overrides,
            };
        },
    };
    return fake;
}

async function runInspectionFeeTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const JobPortalController = require('../controllers/jobPortalController');
    const { createPaymentProcessor } = require('../services/paymentProcessor');
    const { createNotificationService } = require('../services/notificationService');
    const { getV2PaymentEligibility } = require('../services/paymentEligibility');
    const { isRepairRequestPaid } = require('../utils/paymentState');
    const { amountDueForQuote, inspectionCredit } = require('../utils/inspectionFee');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const REGION = `FeeRegion-${runId}`;
    const CUSTOMER = `fee-customer-${runId}@example.test`;
    const emails = [CUSTOMER];
    const requestIds = [];
    const technicianIds = [];

    const stripe = createFakeStripe(runId);
    const refunds = [];
    const portal = new JobPortalController(models, c, { stripeClient: stripe, siteOrigin: 'https://app.example.test' });
    const processPayment = createPaymentProcessor(models, c, createNotificationService(models), {
        refundPayment: async ({ paymentIntentId, idempotencyKey }) => { refunds.push({ paymentIntentId, idempotencyKey }); return `re_${paymentIntentId}`; },
    });
    const call = async (method, email, req = {}) => {
        const res = fakeRes();
        await portal[method]({ decoded_email: email, params: {}, query: {}, body: {}, ...req }, res);
        return res;
    };
    const definition = await c.serviceDefinitions.findOne({ isActive: true, 'pricingRule.inspectionFee': { $gte: 100 } })
        || await c.serviceDefinitions.findOne({ isActive: true, 'pricingRule.inspectionFee': { $gt: 0 } });
    const cap = Math.floor(definition.pricingRule.inspectionFee);
    const insertTech = async (name) => {
        const email = `fee-${name}-${runId}@example.test`;
        emails.push(email);
        await c.users.insertOne({ email, role: 'rider', createdAt: new Date() });
        const { insertedId } = await c.technicians.insertOne({
            name: `${name} ${runId}`, email, region: REGION, district: 'D', status: 'approved', workStatus: 'available', createdAt: new Date(),
            expertise: [{ productCategorySlug: definition.productCategorySlug, repairCategorySlugs: [definition.repairCategorySlug], level: 'expert', experienceYears: 9 }],
        });
        technicianIds.push(insertedId);
        return { id: insertedId.toString(), email };
    };
    const insertRequest = async () => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `FEE-${runId}-${requestIds.length}`,
            product: { categorySlug: definition.productCategorySlug, brand: 'FeeBrand', model: 'F1' },
            service: { definitionId: definition._id.toString(), repairCategorySlug: definition.repairCategorySlug },
            damage: { description: 'Fee test problem description.', images: [{ storageKey: `k-${runId}`, uploadedAt: new Date() }] },
            serviceLocation: { region: REGION, district: 'D', address: 'A' },
            pricing: { currency: 'BDT', estimateMin: 1000, estimateMax: 3000, inspectionFee: cap },
            deliveryStatus: 'pending-pickup', createdAt: new Date(),
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };
    const apply = (tech, id, fee) => call('apply', tech.email, { params: { id }, body: { estimateMin: 1500, estimateMax: 3000, inspectionFee: fee, note: '' } });
    const appOf = (tech, id) => c.jobApplications.findOne({ requestId: id, technicianId: tech.id });
    const accept = async (tech, id) => call('accept', CUSTOMER, { params: { id, applicationId: (await appOf(tech, id))._id.toString() } });

    try {
        await c.users.insertOne({ email: CUSTOMER, role: 'user', createdAt: new Date() });

        // ---- pure rules ----
        logTest('Inspection fee: the fee counts toward the quote, never below zero, and only once paid',
            amountDueForQuote({ quote: { totalAmount: 3000 }, inspectionPayment: { status: 'paid', amount: 200 } }) === 2800
            && amountDueForQuote({ quote: { totalAmount: 150 }, inspectionPayment: { status: 'paid', amount: 200 } }) === 0
            && amountDueForQuote({ quote: { totalAmount: 3000 }, inspectionPayment: { status: 'refunded', amount: 200 } }) === 3000
            && inspectionCredit({}) === 0);

        const alpha = await insertTech('alpha');
        const beta = await insertTech('beta');
        const id = await insertRequest();
        const feeA = cap;
        const feeB = Math.max(1, cap - 50);
        await apply(alpha, id, feeA);
        await apply(beta, id, feeB);

        // ---- choosing opens a checkout, it does not book ----
        const chooseA = await call('accept', CUSTOMER, { params: { id, applicationId: (await appOf(alpha, id))._id.toString() } });
        const sessionA = stripe.created[0];
        const afterChoose = await c.repairRequests.findOne({ _id: new ObjectId(id) });
        logTest('Inspection fee: choosing a technician with a fee opens a checkout for exactly that fee - and books no one yet',
            chooseA.statusCode === 200 && chooseA.body.checkoutUrl === `https://checkout.stripe.test/${sessionA.id}`
            && sessionA.params.line_items[0].price_data.unit_amount === feeA * 100 && sessionA.params.line_items[0].price_data.currency === 'bdt'
            && sessionA.params.metadata.paymentType === 'inspection_fee' && sessionA.params.metadata.applicationId === (await appOf(alpha, id))._id.toString()
            && afterChoose.deliveryStatus === 'pending-pickup' && !afterChoose.technicianId && afterChoose.feeCheckout.amount === feeA);
        logTest('Inspection fee: the checkout returns to the request when cancelled and records its purpose',
            sessionA.params.cancel_url === `https://app.example.test/dashboard/my-requests/${id}`
            && (await c.checkoutSessions.findOne({ requestId: id, active: true })).purpose === 'inspection_fee');
        const chooseAAgain = await accept(alpha, id);
        logTest('Inspection fee: choosing the same technician again reuses the open checkout',
            chooseAAgain.body.reused === true && stripe.created.length === 1);
        const chooseB = await accept(beta, id);
        const sessionB = stripe.created[1];
        logTest('Inspection fee: choosing someone else closes the old checkout first',
            chooseB.statusCode === 200 && stripe.expired.includes(sessionA.id) && sessionB.params.line_items[0].price_data.unit_amount === feeB * 100);

        // ---- paying books the technician ----
        const wrong = await processPayment({ session: stripe.paidSession(sessionB.id, { amount_total: 1 }), source: 'webhook' });
        logTest('Inspection fee: a payment for the wrong amount is refused', wrong.code === 'AMOUNT_MISMATCH');
        const paid = await processPayment({ session: stripe.paidSession(sessionB.id), source: 'webhook' });
        const booked = await c.repairRequests.findOne({ _id: new ObjectId(id) });
        logTest('Inspection fee: once paid, the technician is booked and the fee recorded on the request',
            paid.code === 'OK' && paid.booked === true && paid.purpose === 'inspection_fee'
            && booked.deliveryStatus === 'driver_assigned' && booked.technicianId === beta.id
            && booked.inspectionPayment.status === 'paid' && booked.inspectionPayment.amount === feeB && !booked.feeCheckout);
        const paymentRow = await c.payments.findOne({ sessionId: sessionB.id });
        logTest('Inspection fee: the payment is recorded once, as an inspection fee, and the checkout is closed',
            paymentRow && paymentRow.purpose === 'inspection_fee' && paymentRow.amount === feeB
            && (await c.checkoutSessions.countDocuments({ requestId: id, active: true })) === 0);
        const again = await processPayment({ session: stripe.paidSession(sessionB.id), source: 'browser-verification', callerEmail: CUSTOMER });
        logTest('Inspection fee: confirming the same payment twice (webhook + browser) changes nothing',
            again.code === 'OK' && again.alreadyProcessed === true && again.purpose === 'inspection_fee'
            && (await c.payments.countDocuments({ sessionId: sessionB.id })) === 1);
        logTest('Inspection fee: the other applicant is told they were not chosen; the chosen one that they got the job',
            (await appOf(alpha, id)).status === 'not_chosen'
            && (await c.notifications.countDocuments({ recipientEmail: beta.email, type: 'application_accepted', entityId: id })) === 1);

        // ---- the fee does not block the repair payment, and counts toward it ----
        logTest('Inspection fee: paying it does not count as paying for the repair', !isRepairRequestPaid(booked));
        await c.repairRequests.updateOne({ _id: new ObjectId(id) }, {
            $set: { deliveryStatus: 'quote_approved', quote: { status: 'approved', totalAmount: 3000, currency: 'BDT', version: 1, laborAmount: 1000, partsAmount: 2000, additionalCharges: 0 } },
        });
        const approved = await c.repairRequests.findOne({ _id: new ObjectId(id) });
        const eligibility = getV2PaymentEligibility(approved);
        logTest('Inspection fee: the repair payment asks for the quote minus the fee already paid',
            eligibility.eligible && eligibility.amount === 3000 - feeB && eligibility.quoteTotal === 3000 && eligibility.inspectionCredit === feeB);
        const repairSessionId = `cs_test_repair_${runId}`;
        const repairPaid = await processPayment({
            session: {
                id: repairSessionId, mode: 'payment', payment_status: 'paid', payment_intent: `pi_repair_${runId}`,
                amount_total: (3000 - feeB) * 100, currency: 'bdt', customer_email: CUSTOMER,
                metadata: { requestId: id, trackingId: approved.trackingId, schemaVersion: '2', quoteVersion: '1' },
            },
            source: 'webhook',
        });
        const repaired = await c.repairRequests.findOne({ _id: new ObjectId(id) });
        logTest('Inspection fee: the repair payment of the rest completes, keeping the full quote for the technician',
            repairPaid.code === 'OK' && repaired.deliveryStatus === 'payment_completed' && repaired.payment.amount === 3000 - feeB
            && repaired.payment.quoteTotal === 3000 && repaired.payment.inspectionCredit === feeB
            && repaired.technicianSettlement && repaired.technicianSettlement.repairSubtotal === 3000);

        // ---- the technician can no longer be booked: refund ----
        const gamma = await insertTech('gamma');
        const id2 = await insertRequest();
        await apply(gamma, id2, feeA);
        await accept(gamma, id2);
        const sessionC = stripe.created[stripe.created.length - 1];
        await c.technicians.updateOne({ _id: new ObjectId(gamma.id) }, { $set: { workStatus: 'in_delivery' } });
        const refunded = await processPayment({ session: stripe.paidSession(sessionC.id), source: 'webhook' });
        const afterRefund = await c.repairRequests.findOne({ _id: new ObjectId(id2) });
        logTest('Inspection fee: if the technician got busy meanwhile, the fee is refunded and the request stays open',
            refunded.code === 'INSPECTION_FEE_REFUNDED' && refunded.refunded === true
            && refunds.length === 1 && refunds[0].paymentIntentId === `pi_${sessionC.id}` && refunds[0].idempotencyKey === `inspection-refund-${sessionC.id}`
            && afterRefund.deliveryStatus === 'pending-pickup' && !afterRefund.technicianId && afterRefund.inspectionPayment.status === 'refunded');
        logTest('Inspection fee: the refund is recorded and the customer is told to choose again',
            (await c.payments.findOne({ sessionId: sessionC.id })).refundStatus === 'refunded'
            && (await c.notifications.countDocuments({ recipientEmail: CUSTOMER, type: 'inspection_fee_refunded', entityId: id2 })) === 1
            && inspectionCredit(afterRefund) === 0);
        const refundedAgain = await processPayment({ session: stripe.paidSession(sessionC.id), source: 'browser-verification', callerEmail: CUSTOMER });
        logTest('Inspection fee: a refunded payment is never refunded twice',
            refundedAgain.code === 'INSPECTION_FEE_REFUNDED' && refundedAgain.alreadyProcessed === true && refunds.length === 1);

        // ---- the customer rejects an offer whose checkout is open ----
        const delta = await insertTech('delta');
        const id3 = await insertRequest();
        await apply(delta, id3, feeA);
        await accept(delta, id3);
        const sessionD = stripe.created[stripe.created.length - 1];
        const rejected = await call('decline', CUSTOMER, { params: { id: id3, applicationId: (await appOf(delta, id3))._id.toString() }, body: { reason: 'inspection_fee' } });
        const afterReject = await c.repairRequests.findOne({ _id: new ObjectId(id3) });
        logTest('Open jobs: rejecting an offer closes its open checkout and reposts the request',
            rejected.statusCode === 200 && stripe.expired.includes(sessionD.id) && !afterReject.feeCheckout && afterReject.repostCount === 1
            && (await c.checkoutSessions.countDocuments({ requestId: id3, active: true })) === 0);
        const late = await processPayment({ session: stripe.paidSession(sessionD.id), source: 'webhook' });
        const afterLate = await c.repairRequests.findOne({ _id: new ObjectId(id3) });
        logTest('Open jobs: a payment that still arrives for a rejected offer is refunded and books no one',
            late.code === 'INSPECTION_FEE_REFUNDED' && refunds.length === 2 && refunds[1].paymentIntentId === `pi_${sessionD.id}`
            && !afterLate.technicianId && afterLate.deliveryStatus === 'pending-pickup');
    } finally {
        const ids = requestIds.map(String);
        await c.payments.deleteMany({ requestId: { $in: ids } });
        await c.checkoutSessions.deleteMany({ requestId: { $in: ids } });
        await c.jobApplications.deleteMany({ requestId: { $in: ids } });
        await c.notifications.deleteMany({ entityId: { $in: ids } });
        if (requestIds.length) {
            const tracking = (await c.repairRequests.find({ _id: { $in: requestIds } }, { projection: { trackingId: 1 } }).toArray()).map((r) => r.trackingId);
            await c.trackingEvents.deleteMany({ trackingId: { $in: tracking } });
            await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        }
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds } });
        await c.users.deleteMany({ email: { $in: emails } });
    }
}

module.exports = { runInspectionFeeTests };
