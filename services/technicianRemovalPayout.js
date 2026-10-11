const {
    WITHDRAWAL_REQUESTED, WITHDRAWAL_REASON_TECHNICIAN_REMOVED, PAYOUT_METHOD_BKASH,
    calculateWallet, normalizeBkashNumber, buildWithdrawalDocument, buildWithdrawalView,
} = require('../utils/settlement');
const { normalize } = require('./paymentProcessor');

// Final payout when an admin removes a technician.
//
// When an approved technician is removed (status -> rejected), whatever is in
// their wallet's AVAILABLE balance is owed to them. Instead of leaving that
// money stranded in a wallet they can no longer open, the removal raises a
// withdrawal for the whole amount to their bKash number, in the same
// transaction as the removal itself - either both happen or neither does.
//
// Like every other withdrawal this is payout ACCOUNTING, not a money transfer:
// the request lands in the admin Withdrawal Requests queue, tagged as a final
// payout, and an admin sends it with bKash "Send Money" and records the TrxID
// exactly as for any other withdrawal. There is no bKash API behind it.
//
// Balances are computed with the same calculateWallet() the wallet page uses,
// so the payout is exactly the figure the technician last saw as available.
// Money still PENDING (repairs not yet confirmed) is not available yet and is
// not paid here.
//
// Which bKash number, in order:
//   1. a number the admin typed in the removal dialog,
//   2. the number on an already-open withdrawal (that request is topped up),
//   3. the number the technician used on their last withdrawal,
//   4. the technician's application phone, if it is a valid bKash number.
// With money to pay and none of these, removal is refused with
// BKASH_NUMBER_REQUIRED so the admin can enter one - never paid to a guess.

async function loadRemovalWallet(collections, technicianEmail, session) {
    const options = session ? { session } : {};
    const [repairRequests, withdrawals] = await Promise.all([
        collections.repairRequests
            .find(
                {
                    $or: [
                        { technicianEmail, technicianSettlement: { $exists: true } },
                        { 'inspectionFeeSettlement.technicianEmail': technicianEmail },
                    ],
                },
                { ...options, projection: { technicianSettlement: 1, inspectionFeeSettlement: 1, technicianEarning: 1 } }
            )
            .toArray(),
        // Unbounded on purpose: a final payout must count every withdrawal ever
        // made, not the most recent page of them.
        collections.technicianWithdrawals
            .find({ technicianEmail }, options)
            .sort({ requestedAt: -1 })
            .toArray(),
    ]);
    return { withdrawals, wallet: calculateWallet({ repairRequests, withdrawals }) };
}

// Pure decision: what the removal should do with this wallet. Returns
//   { action: 'none' }                       nothing available to pay
//   { action: 'create', amount, payout }     raise a new final withdrawal
//   { action: 'top_up', amount, payout, open } raise the open request to the full amount
//   { error: { code, message } }             cannot pay without a valid number
function planRemovalPayout({ wallet, withdrawals, technicianPhone, adminBkashNumber }) {
    const open = withdrawals.find((w) => w.status === WITHDRAWAL_REQUESTED) || null;
    const available = wallet.availableBalance;

    let adminNumber = null;
    if (adminBkashNumber !== undefined && adminBkashNumber !== null && String(adminBkashNumber).trim() !== '') {
        adminNumber = normalizeBkashNumber(String(adminBkashNumber));
        if (!adminNumber) {
            return { error: { code: 'INVALID_BKASH_NUMBER', message: 'enter a valid bKash number, like 01XXXXXXXXX' } };
        }
    }

    if (available <= 0) {
        // An open request, if any, already holds everything that is available.
        return { action: 'none', open };
    }

    const last = withdrawals.find((w) => w.payout && w.payout.accountNumber) || null;
    let payout = null;
    if (adminNumber) {
        const keepName = [open, last].find((w) => w?.payout?.accountNumber === adminNumber)?.payout.accountName ?? null;
        payout = { method: PAYOUT_METHOD_BKASH, accountNumber: adminNumber, accountName: keepName };
    } else if (open?.payout?.accountNumber) {
        payout = open.payout;
    } else if (last) {
        payout = { method: PAYOUT_METHOD_BKASH, accountNumber: last.payout.accountNumber, accountName: last.payout.accountName ?? null };
    } else {
        const phone = normalizeBkashNumber(typeof technicianPhone === 'string' ? technicianPhone : '');
        if (phone) payout = { method: PAYOUT_METHOD_BKASH, accountNumber: phone, accountName: null };
    }

    if (!payout) {
        return {
            error: {
                code: 'BKASH_NUMBER_REQUIRED',
                message: 'this technician has money to be paid but no bKash number on record - enter one to remove them',
            },
        };
    }

    return open
        ? { action: 'top_up', amount: open.amount + available, payout, open }
        : { action: 'create', amount: available, payout };
}

// Read-only preview for the admin removal dialog (GET /technicians/:id/final-payout).
async function previewRemovalPayout(collections, technician) {
    const email = normalize(technician.email);
    const { withdrawals, wallet } = await loadRemovalWallet(collections, email);
    const plan = planRemovalPayout({ wallet, withdrawals, technicianPhone: technician.phone });
    const last = withdrawals.find((w) => w.payout && w.payout.accountNumber) || null;
    const open = withdrawals.find((w) => w.status === WITHDRAWAL_REQUESTED) || null;

    let source = null;
    if (plan.payout) {
        if (open?.payout?.accountNumber === plan.payout.accountNumber) source = 'open_withdrawal';
        else if (last?.payout?.accountNumber === plan.payout.accountNumber) source = 'last_withdrawal';
        else source = 'application_phone';
    }

    return {
        availableBalance: wallet.availableBalance,
        pendingBalance: wallet.pendingBalance,
        reservedBalance: wallet.reservedBalance,
        currency: wallet.currency,
        payoutAmount: plan.action === 'create' || plan.action === 'top_up' ? plan.amount : 0,
        openWithdrawal: buildWithdrawalView(open),
        bkashNumberRequired: plan.error?.code === 'BKASH_NUMBER_REQUIRED',
        suggestedPayout: plan.payout ? { ...plan.payout, source } : null,
    };
}

// Applied inside the removal transaction. Throws an Error with `code` and
// `httpStatus` when the payout cannot be made, which aborts the removal too.
async function applyRemovalPayout(collections, technician, { session, adminEmail, adminBkashNumber, now = new Date() }) {
    const email = normalize(technician.email);
    const { withdrawals, wallet } = await loadRemovalWallet(collections, email, session);
    const plan = planRemovalPayout({ wallet, withdrawals, technicianPhone: technician.phone, adminBkashNumber });

    if (plan.error) {
        throw Object.assign(new Error(plan.error.message), { code: plan.error.code, httpStatus: 409, availableBalance: wallet.availableBalance });
    }
    if (plan.action === 'none') {
        return { action: 'none', amount: 0, pendingBalance: wallet.pendingBalance };
    }

    if (plan.action === 'top_up') {
        // Guarded on the amount read above, so a concurrent admin decision on
        // the open request aborts the removal instead of being overwritten.
        const result = await collections.technicianWithdrawals.updateOne(
            { _id: plan.open._id, status: WITHDRAWAL_REQUESTED, amount: plan.open.amount },
            { $set: { amount: plan.amount, payout: plan.payout, reason: WITHDRAWAL_REASON_TECHNICIAN_REMOVED, createdBy: adminEmail } },
            { session }
        );
        if (result.matchedCount === 0) {
            throw Object.assign(new Error('the technician\'s open withdrawal changed while removing them - try again'), { code: 'FINAL_PAYOUT_CONFLICT', httpStatus: 409 });
        }
        return {
            action: 'top_up', amount: plan.amount, withdrawalId: plan.open._id.toString(),
            bkashNumber: plan.payout.accountNumber, pendingBalance: wallet.pendingBalance,
        };
    }

    const document = buildWithdrawalDocument({
        technicianId: technician._id.toString(),
        technicianEmail: email,
        amount: plan.amount,
        payout: plan.payout,
        now,
        reason: WITHDRAWAL_REASON_TECHNICIAN_REMOVED,
        createdBy: adminEmail,
    });
    try {
        const { insertedId } = await collections.technicianWithdrawals.insertOne(document, { session });
        return {
            action: 'create', amount: plan.amount, withdrawalId: insertedId.toString(),
            bkashNumber: plan.payout.accountNumber, pendingBalance: wallet.pendingBalance,
        };
    } catch (error) {
        // The technician opened a request of their own at the same moment -
        // the one-open-withdrawal index lets only one through.
        if (error.code === 11000) {
            throw Object.assign(new Error('the technician requested a withdrawal while being removed - try again'), { code: 'FINAL_PAYOUT_CONFLICT', httpStatus: 409 });
        }
        throw error;
    }
}

module.exports = { planRemovalPayout, previewRemovalPayout, applyRemovalPayout, loadRemovalWallet };
