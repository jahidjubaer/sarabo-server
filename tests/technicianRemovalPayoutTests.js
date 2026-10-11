// Removing a technician pays out their wallet: the whole available balance is
// raised as a withdrawal to their bKash number in the same transaction as the
// removal (services/technicianRemovalPayout.js).
function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

function runRemovalPlanTests({ logTest }) {
    const { planRemovalPayout } = require('../services/technicianRemovalPayout');
    const wallet = (availableBalance) => ({ availableBalance, pendingBalance: 0 });
    const bkash = (accountNumber, accountName = null) => ({ method: 'bkash', accountNumber, accountName });

    logTest('Removal payout: nothing available means nothing is raised',
        planRemovalPayout({ wallet: wallet(0), withdrawals: [], technicianPhone: '01712345678' }).action === 'none');

    const fromPhone = planRemovalPayout({ wallet: wallet(2500), withdrawals: [], technicianPhone: '+880 1712-345678' });
    logTest('Removal payout: with no withdrawal history the application phone is used as the bKash number',
        fromPhone.action === 'create' && fromPhone.amount === 2500 && fromPhone.payout.accountNumber === '01712345678');

    const fromLast = planRemovalPayout({
        wallet: wallet(800), technicianPhone: '01999999999',
        withdrawals: [{ status: 'paid', amount: 100, payout: bkash('01812345678', 'Rahim') }],
    });
    logTest('Removal payout: the bKash number from the last withdrawal wins over the phone',
        fromLast.action === 'create' && fromLast.payout.accountNumber === '01812345678' && fromLast.payout.accountName === 'Rahim');

    const fromAdmin = planRemovalPayout({
        wallet: wallet(800), technicianPhone: '01999999999', adminBkashNumber: '01512345678',
        withdrawals: [{ status: 'paid', amount: 100, payout: bkash('01812345678') }],
    });
    logTest('Removal payout: a number typed by the admin wins over everything', fromAdmin.payout.accountNumber === '01512345678');

    const topUp = planRemovalPayout({
        wallet: wallet(700), technicianPhone: null,
        withdrawals: [{ status: 'requested', amount: 300, payout: bkash('01812345678') }],
    });
    logTest('Removal payout: an open request is topped up to the full balance on its own number',
        topUp.action === 'top_up' && topUp.amount === 1000 && topUp.payout.accountNumber === '01812345678');

    logTest('Removal payout: money but no usable number is refused with BKASH_NUMBER_REQUIRED',
        planRemovalPayout({ wallet: wallet(500), withdrawals: [], technicianPhone: '12345' }).error?.code === 'BKASH_NUMBER_REQUIRED');
    logTest('Removal payout: an invalid admin-typed number is refused',
        planRemovalPayout({ wallet: wallet(500), withdrawals: [], technicianPhone: '01712345678', adminBkashNumber: '999' }).error?.code === 'INVALID_BKASH_NUMBER');
}

async function runTechnicianRemovalPayoutTests({ logTest }) {
    runRemovalPlanTests({ logTest });

    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const TechnicianController = require('../controllers/technicianController');
    const WalletController = require('../controllers/walletController');
    if (process.env.NODE_ENV !== 'test' || !c.users.dbName.includes('test')) throw new Error('Isolated test database required');
    await connectDatabase();
    const models = initializeModels(c);
    const technicians = new TechnicianController(models, c);
    const wallet = new WalletController(models, c);

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ADMIN = `removal-admin-${runId}@test.local`;
    const emails = [];
    const technicianIds = [];
    const requestIds = [];

    const makeTechnician = async (tag, { balance = 0, pending = 0, phone = null } = {}) => {
        const email = `removal-${tag}-${runId}@test.local`;
        emails.push(email);
        await c.users.insertOne({ email, role: 'rider', createdAt: new Date() });
        const { insertedId } = await c.technicians.insertOne({
            name: `Removal ${tag}`, email, phone, region: 'Test Region', district: 'Test District',
            status: 'approved', workStatus: 'available', createdAt: new Date(),
        });
        technicianIds.push(insertedId);
        for (const [amount, status] of [[balance, 'available'], [pending, 'pending']]) {
            if (!amount) continue;
            const r = await c.repairRequests.insertOne({
                schemaVersion: 2, trackingId: `RMV-${tag}-${status}-${runId}`, technicianEmail: email, createdAt: new Date(),
                technicianSettlement: { status, technicianReceivable: amount, currency: 'BDT', technicianEmail: email },
            });
            requestIds.push(r.insertedId);
        }
        return { id: insertedId.toString(), email };
    };
    const remove = async (id, extra = {}) => {
        const res = fakeRes();
        await technicians.updateTechnicianStatus({ decoded_email: ADMIN, params: { id }, body: { status: 'rejected', ...extra } }, res);
        return res;
    };
    const preview = async (id) => {
        const res = fakeRes();
        await technicians.getFinalPayoutPreview({ decoded_email: ADMIN, params: { id } }, res);
        return res;
    };

    try {
        await c.users.insertOne({ email: ADMIN, role: 'admin', createdAt: new Date() });

        // 1. Balance + valid phone: removed, and the whole balance is queued for bKash.
        const a = await makeTechnician('a', { balance: 3000, pending: 400, phone: '01712345678' });
        const aPreview = await preview(a.id);
        logTest('Removal flow: the preview shows the available balance, pending money and suggested number',
            aPreview.statusCode === 200 && aPreview.body.payoutAmount === 3000 && aPreview.body.pendingBalance === 400
            && aPreview.body.suggestedPayout?.accountNumber === '01712345678' && aPreview.body.suggestedPayout.source === 'application_phone');
        const aRes = await remove(a.id);
        const aRow = await c.technicianWithdrawals.findOne({ technicianEmail: a.email });
        const aUser = await c.users.findOne({ email: a.email });
        logTest('Removal flow: removing a technician queues their whole available balance to their bKash',
            aRes.statusCode === 200 && aRes.body.finalPayout?.action === 'create' && aRes.body.finalPayout.amount === 3000
            && aRow?.status === 'requested' && aRow.amount === 3000 && aRow.payout.accountNumber === '01712345678'
            && aRow.reason === 'technician_removed' && aRow.createdBy === ADMIN && aUser.role === 'user',
            JSON.stringify(aRes.body));
        const aNote = await c.notifications.findOne({ recipientEmail: a.email, type: 'technician_removed_final_payout' });
        logTest('Removal flow: the removed technician is told the amount and bKash number',
            !!aNote && aNote.recipientRole === 'user' && aNote.message.includes('3000') && aNote.message.includes('01712345678'));

        // The admin then pays it like any other withdrawal; the notice reaches a 'user'.
        const paid = fakeRes();
        await wallet.markWithdrawalPaid({ decoded_email: ADMIN, params: { id: aRow._id.toString() }, body: { bkashTrxId: `R${runId.replace(/[^a-z0-9]/gi, '').slice(-9)}`.toUpperCase() } }, paid);
        const paidNote = await c.notifications.findOne({ recipientEmail: a.email, type: 'withdrawal_paid' });
        logTest('Removal flow: the final payout is paid through the normal queue and the user is notified',
            paid.statusCode === 200 && paid.body.withdrawal.reason === 'technician_removed'
            && !!paidNote && paidNote.recipientRole === 'user' && paidNote.actionUrl === '/dashboard/notifications');

        // 2. Balance but no usable number: refused, nothing changes.
        const b = await makeTechnician('b', { balance: 900, phone: 'not-a-phone' });
        const bRes = await remove(b.id);
        const bTech = await c.technicians.findOne({ email: b.email });
        const bUser = await c.users.findOne({ email: b.email });
        logTest('Removal flow: with money owed and no bKash number the removal is refused and nothing changes',
            bRes.statusCode === 409 && bRes.body.code === 'BKASH_NUMBER_REQUIRED' && bRes.body.availableBalance === 900
            && bTech.status === 'approved' && bUser.role === 'rider'
            && (await c.technicianWithdrawals.countDocuments({ technicianEmail: b.email })) === 0);
        const bBad = await remove(b.id, { bkashNumber: '123' });
        logTest('Removal flow: an invalid admin-entered number is refused', bBad.statusCode === 409 && bBad.body.code === 'INVALID_BKASH_NUMBER');
        const bOk = await remove(b.id, { bkashNumber: '01912345678' });
        const bRow = await c.technicianWithdrawals.findOne({ technicianEmail: b.email });
        logTest('Removal flow: with a number entered by the admin the removal goes through',
            bOk.statusCode === 200 && bRow?.amount === 900 && bRow.payout.accountNumber === '01912345678');

        // 3. Open request: topped up, never a second open row.
        const d = await makeTechnician('d', { balance: 2000, phone: null });
        await c.technicianWithdrawals.insertOne({
            technicianId: null, technicianEmail: d.email, amount: 500, currency: 'BDT', status: 'requested',
            payout: { method: 'bkash', accountNumber: '01612345678', accountName: 'D' }, payoutReference: null,
            requestedAt: new Date(), processedAt: null, processedBy: null, note: null,
        });
        const dRes = await remove(d.id);
        const dRows = await c.technicianWithdrawals.find({ technicianEmail: d.email }).toArray();
        logTest('Removal flow: an open request is topped up to the full balance instead of adding a second one',
            dRes.statusCode === 200 && dRes.body.finalPayout?.action === 'top_up'
            && dRows.length === 1 && dRows[0].amount === 2000 && dRows[0].reason === 'technician_removed' && dRows[0].payout.accountNumber === '01612345678');

        // 4. No balance: removal works exactly as before.
        const e = await makeTechnician('e', { phone: null });
        const eRes = await remove(e.id);
        logTest('Removal flow: a technician with no balance is removed with no payout raised',
            eRes.statusCode === 200 && eRes.body.finalPayout?.action === 'none'
            && (await c.technicianWithdrawals.countDocuments({ technicianEmail: e.email })) === 0);
    } finally {
        await c.notifications.deleteMany({ recipientEmail: { $in: emails } });
        await c.technicianWithdrawals.deleteMany({ technicianEmail: { $in: emails } });
        await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        await c.technicians.deleteMany({ _id: { $in: technicianIds } });
        await c.users.deleteMany({ email: { $in: [...emails, ADMIN] } });
    }
}

module.exports = { runTechnicianRemovalPayoutTests };
