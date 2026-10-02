// What the customer sees before deciding: the request list says how many
// technician offers are waiting (pendingOfferCount), and the quote says what is
// left to pay after the inspection fee (inspectionCredit, amountDue).
function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runCustomerMoneyViewTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const RepairRequestController = require('../controllers/repairRequestController');
    const QuoteController = require('../controllers/quoteController');
    if (process.env.NODE_ENV !== 'test' || !c.users.dbName.includes('test')) throw new Error('Isolated test database required');
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const CUSTOMER = `money-customer-${runId}@test.local`;
    const requestIds = [];
    const insertRequest = async (overrides = {}) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `MONEY-${runId}-${requestIds.length}`,
            product: { categorySlug: 'smartphone' }, service: { repairCategorySlug: 'display-screen' },
            damage: { description: 'Money view test.', images: [] },
            serviceLocation: { region: 'Sylhet', district: 'Sylhet' }, deliveryStatus: 'pending-pickup', createdAt: new Date(), ...overrides,
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };

    try {
        await c.users.insertOne({ email: CUSTOMER, role: 'user', createdAt: new Date() });
        const withOffers = await insertRequest();
        const noOffers = await insertRequest();
        const assigned = await insertRequest({ technicianId: 'someone', deliveryStatus: 'driver_assigned' });
        await c.jobApplications.insertMany([
            { requestId: withOffers, technicianId: 't1', status: 'pending', createdAt: new Date() },
            { requestId: withOffers, technicianId: 't2', status: 'pending', createdAt: new Date() },
            { requestId: withOffers, technicianId: 't3', status: 'declined', createdAt: new Date() },
            { requestId: assigned, technicianId: 't4', status: 'pending', createdAt: new Date() },
        ]);
        const list = fakeRes();
        await new RepairRequestController(models, c).getAllRepairRequests({ decoded_email: CUSTOMER, query: {} }, list);
        const row = (id) => list.body.find((r) => String(r._id) === id);
        logTest('Customer list: an open request says how many offers are waiting (pending only)',
            list.statusCode === 200 && row(withOffers).pendingOfferCount === 2 && row(noOffers).pendingOfferCount === 0);
        logTest('Customer list: a request with a technician carries no offer count', !('pendingOfferCount' in row(assigned)));

        const quote = { status: 'submitted', laborAmount: 2000, partsAmount: 500, additionalCharges: 0, totalAmount: 2500, currency: 'BDT', submittedAt: new Date(), version: 1 };
        const paidFee = await insertRequest({
            technicianId: 'tech', technicianEmail: 'tech@test.local', deliveryStatus: 'quote_submitted', quote,
            inspectionPayment: { status: 'paid', amount: 300, currency: 'BDT' },
        });
        const noFee = await insertRequest({ technicianId: 'tech', technicianEmail: 'tech@test.local', deliveryStatus: 'quote_submitted', quote });
        const covered = await insertRequest({
            technicianId: 'tech', technicianEmail: 'tech@test.local', deliveryStatus: 'quote_submitted', quote: { ...quote, totalAmount: 200 },
            inspectionPayment: { status: 'paid', amount: 300, currency: 'BDT' },
        });
        const quotes = new QuoteController(models, c);
        const getQuote = async (id) => {
            const res = fakeRes();
            await quotes.getQuote({ decoded_email: CUSTOMER, params: { id } }, res);
            return res.body.quote;
        };
        const a = await getQuote(paidFee);
        logTest('Quote: shows the inspection fee already paid and what is left to pay',
            a.totalAmount === 2500 && a.inspectionCredit === 300 && a.amountDue === 2200);
        const b = await getQuote(noFee);
        logTest('Quote: without an inspection fee the whole price is left to pay', b.inspectionCredit === 0 && b.amountDue === 2500);
        logTest('Quote: a fee bigger than the price leaves nothing to pay, never below zero', (await getQuote(covered)).amountDue === 0);
        const none = await getQuote(withOffers);
        logTest('Quote: no amounts before a quote exists', none.status === 'not_submitted' && !('amountDue' in none));
    } finally {
        await c.jobApplications.deleteMany({ requestId: { $in: requestIds.map(String) } });
        await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        await c.users.deleteMany({ email: CUSTOMER });
    }
}

module.exports = { runCustomerMoneyViewTests };
