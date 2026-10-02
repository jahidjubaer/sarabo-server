// Technician withdrawals paid by hand with bKash "Send Money": the technician
// gives a personal bKash number with the request, the admin records the bKash
// TrxID when marking it paid, and one TrxID can only ever settle one withdrawal.
function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

function runBkashValidatorTests({ logTest }) {
    const { normalizeBkashNumber, validateWithdrawalRequest, validatePayoutReference } = require('../utils/settlement');
    const ok = { availableBalance: 5000, hasOpenWithdrawal: false };

    logTest('bKash: local, +880 and 880 forms with spaces or dashes all become 01XXXXXXXXX',
        ['01712345678', '+8801712345678', '8801712345678', '017-1234 5678'].every((n) => normalizeBkashNumber(n) === '01712345678'));
    logTest('bKash: short, non-mobile and non-string numbers are refused',
        ['0171234567', '01212345678', '02712345678', 'abc', '', null, 1712345678].every((n) => normalizeBkashNumber(n) === null));

    const missing = validateWithdrawalRequest({ amount: 100 }, ok);
    const bad = validateWithdrawalRequest({ amount: 100, bkashNumber: '12345' }, ok);
    const nagad = validateWithdrawalRequest({ amount: 100, bkashNumber: '01712345678', payoutMethod: 'nagad' }, ok);
    logTest('bKash: a withdrawal without a valid bKash number is refused',
        missing.code === 'INVALID_BKASH_NUMBER' && bad.code === 'INVALID_BKASH_NUMBER' && nagad.code === 'INVALID_PAYOUT_METHOD');

    const good = validateWithdrawalRequest({ amount: 100, bkashNumber: '+880 1812-345678', bkashAccountName: '  Rahim  ' }, ok);
    logTest('bKash: a valid request stores the normalised number and trimmed name',
        good.valid && good.normalized.payout.method === 'bkash'
        && good.normalized.payout.accountNumber === '01812345678' && good.normalized.payout.accountName === 'Rahim');
    const longName = validateWithdrawalRequest({ amount: 100, bkashNumber: '01712345678', bkashAccountName: 'x'.repeat(61) }, ok);
    logTest('bKash: an over-long account name is refused', longName.code === 'INVALID_BKASH_ACCOUNT_NAME');
    const forged = validateWithdrawalRequest({ amount: 100, bkashNumber: '01712345678', payoutReference: 'ABCDEFGH12' }, ok);
    logTest('bKash: a technician cannot supply the payout reference', forged.code === 'INVALID_WITHDRAWAL');

    const bkashRow = { payout: { method: 'bkash', accountNumber: '01712345678' } };
    logTest('bKash: marking a bKash withdrawal paid needs a TrxID',
        validatePayoutReference({}, bkashRow).code === 'BKASH_TRX_ID_REQUIRED'
        && validatePayoutReference({ bkashTrxId: '  ' }, bkashRow).code === 'BKASH_TRX_ID_REQUIRED');
    logTest('bKash: a malformed TrxID is refused',
        ['ABC', 'ABCD-EFGH-12', 'X'.repeat(13)].every((t) => validatePayoutReference({ bkashTrxId: t }, bkashRow).code === 'INVALID_BKASH_TRX_ID'));
    const trx = validatePayoutReference({ bkashTrxId: ' 9a7b6c5d4e ' }, bkashRow);
    logTest('bKash: a TrxID is trimmed and upper-cased', trx.valid && trx.normalized.payoutReference === '9A7B6C5D4E');
    logTest('bKash: an older withdrawal without bKash details can still be marked paid without a TrxID',
        validatePayoutReference({}, { amount: 100 }).valid === true);
}

async function runBkashWithdrawalTests({ logTest }) {
    runBkashValidatorTests({ logTest });

    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const WalletController = require('../controllers/walletController');
    if (process.env.NODE_ENV !== 'test' || !c.users.dbName.includes('test')) throw new Error('Isolated test database required');
    await connectDatabase();
    const models = initializeModels(c);
    const wallet = new WalletController(models, c);

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const TECH = `bkash-tech-${runId}@test.local`;
    const ADMIN = `bkash-admin-${runId}@test.local`;
    const TRX = `B${runId.replace(/[^a-z0-9]/gi, '').slice(-9)}`.toUpperCase();
    const requestIds = [];

    const request = async (body) => {
        const res = fakeRes();
        await wallet.requestWithdrawal({ decoded_email: TECH, body }, res);
        return res;
    };
    const process_ = async (action, id, body) => {
        const res = fakeRes();
        const handler = action === 'paid' ? 'markWithdrawalPaid' : 'rejectWithdrawal';
        await wallet[handler]({ decoded_email: ADMIN, params: { id }, body }, res);
        return res;
    };
    const getWallet = async () => {
        const res = fakeRes();
        await wallet.getWallet({ decoded_email: TECH }, res);
        return res.body;
    };

    try {
        await c.users.insertMany([
            { email: TECH, role: 'rider', createdAt: new Date() },
            { email: ADMIN, role: 'admin', createdAt: new Date() },
        ]);
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, trackingId: `BKASH-${runId}`, technicianEmail: TECH, createdAt: new Date(),
            technicianSettlement: { status: 'available', technicianReceivable: 3000, currency: 'BDT', technicianEmail: TECH },
        });
        requestIds.push(insertedId);

        const noNumber = await request({ amount: 500 });
        logTest('bKash flow: a request without a bKash number is refused (400)', noNumber.statusCode === 400 && noNumber.body.code === 'INVALID_BKASH_NUMBER');

        const first = await request({ amount: 1000, bkashNumber: '+8801712345678', bkashAccountName: 'Test Tech' });
        logTest('bKash flow: a request with a bKash number is created and shows the number',
            first.statusCode === 201 && first.body.withdrawal.payout.accountNumber === '01712345678' && first.body.withdrawal.payoutReference === null);
        const firstId = first.body.withdrawal.id;

        const noTrx = await process_('paid', firstId, {});
        logTest('bKash flow: admin cannot mark it paid without the TrxID', noTrx.statusCode === 400 && noTrx.body.code === 'BKASH_TRX_ID_REQUIRED');

        const paid = await process_('paid', firstId, { bkashTrxId: TRX.toLowerCase(), note: 'sent' });
        logTest('bKash flow: marking paid with a TrxID records it', paid.statusCode === 200 && paid.body.withdrawal.payoutReference === TRX);

        const notification = await c.notifications.findOne({ recipientEmail: TECH, type: 'withdrawal_paid', entityId: firstId });
        logTest('bKash flow: the technician is notified with the bKash number and TrxID',
            !!notification && notification.message.includes('01712345678') && notification.message.includes(TRX),
            notification ? notification.message : 'no notification');

        const walletAfter = await getWallet();
        logTest('bKash flow: the wallet remembers the last bKash number for the next request',
            walletAfter.lastPayout?.accountNumber === '01712345678' && walletAfter.lastPayout?.accountName === 'Test Tech'
            && walletAfter.availableBalance === 2000 && walletAfter.withdrawals[0].payoutReference === TRX);

        const second = await request({ amount: 500, bkashNumber: '01812345678' });
        const reused = await process_('paid', second.body.withdrawal.id, { bkashTrxId: TRX });
        logTest('bKash flow: the same TrxID cannot settle a second withdrawal (409)',
            reused.statusCode === 409 && reused.body.code === 'BKASH_TRX_ID_ALREADY_USED');

        const rejected = await process_('rejected', second.body.withdrawal.id, { note: 'wrong number' });
        const rejectNote = await c.notifications.findOne({ recipientEmail: TECH, type: 'withdrawal_rejected' });
        logTest('bKash flow: rejecting needs no TrxID and the technician is notified',
            rejected.statusCode === 200 && rejected.body.withdrawal.payoutReference === null && !!rejectNote);
    } finally {
        const withdrawals = await c.technicianWithdrawals.find({ technicianEmail: TECH }, { projection: { _id: 1 } }).toArray();
        await c.notifications.deleteMany({ recipientEmail: TECH });
        await c.technicianWithdrawals.deleteMany({ _id: { $in: withdrawals.map((w) => w._id) } });
        await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        await c.users.deleteMany({ email: { $in: [TECH, ADMIN] } });
    }
}

module.exports = { runBkashWithdrawalTests };
