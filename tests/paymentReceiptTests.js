// PDF payment receipts (services/paymentReceipt.js, GET
// /payments/:transactionId/receipt.pdf): the payer or an admin gets a PDF built
// from the stored payment; anyone else gets "not found".
async function runPaymentReceiptTests({ logTest }) {
    const { ObjectId } = require('mongodb');
    const { connectDatabase, collections: c } = require('../config/database');
    const { buildReceipt, renderReceiptPdf } = require('../services/paymentReceipt');
    const PaymentController = require('../controllers/paymentController');
    const { initializeModels } = require('../models');
    const routes = require('../routes/payments');
    const { verifyFBToken } = require('../middleware/auth');
    if (process.env.NODE_ENV !== 'test' || !c.users.dbName.includes('test')) throw new Error('Isolated test database required');
    await connectDatabase();

    // ---- pure ----
    const repairRequest = { product: { categorySlug: 'smartphone', brand: 'Samsung', model: 'A52' }, service: { repairCategorySlug: 'screen-replacement' } };
    const fee = buildReceipt({
        payment: { transactionId: 'pi_fee', amount: 300, currency: 'BDT', purpose: 'inspection_fee', trackingId: 'SRB-1', customerEmail: 'a@x.test', paidAt: new Date('2026-10-01T06:00:00Z') },
        repairRequest, technicianName: 'Rafi',
    });
    logTest('Receipt: an inspection fee shows the device, repair, technician, Dhaka time and amount in BDT',
        fee.purpose === 'Inspection fee' && fee.device === 'Samsung A52' && fee.repair === 'Screen Replacement' && fee.technicianName === 'Rafi'
        && fee.total === 'BDT 300.00' && fee.paidAt.includes('Dhaka') && fee.status === 'Paid');
    const repair = buildReceipt({
        payment: { transactionId: 'pi_rep', amount: 2200, currency: 'BDT', purpose: 'repair', quoteTotal: 2500, inspectionCredit: 300, paidAt: new Date() },
        repairRequest,
    });
    logTest('Receipt: a repair payment lists the repair total minus the inspection fee already paid',
        repair.lines.length === 2 && repair.lines[0].value === 'BDT 2,500.00' && repair.lines[1].value === '- BDT 300.00' && repair.total === 'BDT 2,200.00');
    logTest('Receipt: a refunded or refunding payment says so',
        buildReceipt({ payment: { amount: 1, refundStatus: 'pending' } }).status === 'Paid - refund in progress'
        && buildReceipt({ payment: { amount: 1, refundStatus: 'refunded' } }).status === 'Refunded');
    const pdf = await renderReceiptPdf(fee);
    logTest('Receipt: renders a real PDF', Buffer.isBuffer(pdf) && pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 1000);

    // ---- endpoint ----
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const OWNER = `receipt-owner-${runId}@test.local`;
    const OTHER = `receipt-other-${runId}@test.local`;
    const ADMIN = `receipt-admin-${runId}@test.local`;
    const transactionId = `pi_receipt_${runId.replace(/[^a-z0-9]/gi, '')}`;
    const controller = new PaymentController(initializeModels(c), c);
    const fakeRes = () => {
        const res = { statusCode: 200, headers: {}, body: null };
        res.status = (code) => { res.statusCode = code; return res; };
        res.set = (headers) => { Object.assign(res.headers, headers); return res; };
        res.send = (body) => { res.body = body; return res; };
        return res;
    };
    const call = async (email, id = transactionId) => {
        const res = fakeRes();
        await controller.getReceipt({ decoded_email: email, params: { transactionId: id } }, res);
        return res;
    };
    const { insertedId: requestId } = await c.repairRequests.insertOne({ schemaVersion: 2, trackingId: `RCPT-${runId}`, product: repairRequest.product, service: repairRequest.service, createdAt: new Date() });
    try {
        await c.users.insertMany([
            { email: OWNER, role: 'user', createdAt: new Date() }, { email: OTHER, role: 'user', createdAt: new Date() }, { email: ADMIN, role: 'admin', createdAt: new Date() },
        ]);
        await c.payments.insertOne({
            sessionId: `cs_receipt_${runId}`, transactionId, requestId: requestId.toString(), trackingId: `RCPT-${runId}`, customerEmail: OWNER,
            amount: 1800, currency: 'BDT', paymentStatus: 'paid', purpose: 'repair', paidAt: new Date(),
        });
        const own = await call(OWNER.toUpperCase());
        logTest('Receipt: the payer downloads a PDF named after the tracking id',
            own.statusCode === 200 && own.headers['Content-Type'] === 'application/pdf'
            && own.headers['Content-Disposition'].includes(`sarabo-receipt-RCPT-${runId}.pdf`) && own.body.subarray(0, 5).toString() === '%PDF-');
        logTest('Receipt: an admin may download it too', (await call(ADMIN)).statusCode === 200);
        logTest('Receipt: another customer gets "not found", a bad id is refused',
            (await call(OTHER)).body.code === 'RECEIPT_NOT_FOUND' && (await call(OWNER, 'pi_does_not_exist')).statusCode === 404
            && (await call(OWNER, 'bad id/../x')).body.code === 'INVALID_TRANSACTION_ID');

        const captured = [];
        const capture = (method) => (path, ...handlers) => captured.push({ method, path, handlers });
        routes({ get: capture('GET'), post: capture('POST'), patch: capture('PATCH') }, { payment: controller });
        const route = captured.find((r) => r.method === 'GET' && r.path === '/payments/:transactionId/receipt.pdf');
        logTest('Receipt: the route needs sign-in', !!route && route.handlers.includes(verifyFBToken));
    } finally {
        await c.payments.deleteMany({ transactionId });
        await c.repairRequests.deleteOne({ _id: new ObjectId(requestId) });
        await c.users.deleteMany({ email: { $in: [OWNER, OTHER, ADMIN] } });
    }
}

module.exports = { runPaymentReceiptTests };
