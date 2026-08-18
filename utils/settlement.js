// Technician settlement, wallet and withdrawal arithmetic. Pure - no MongoDB
// access, no HTTP coupling, no clock of its own. Structured, non-throwing
// { valid, code, message } results, the same convention as utils/quote.js /
// utils/inspection.js / utils/repairRequestV2.js.
//
// THE LOCKED COMMISSION RULE. Sarabo takes 10% of the customer-approved repair
// subtotal; the technician receives the other 90%. The commission base is the
// WHOLE repair subtotal, not a single line, so how a technician splits their
// quote between parts and labour can never change what either side receives:
//
//   parts 4000 + labour 2000 -> subtotal 6000 -> commission 600, receivable 5400
//   parts 5500 + labour  500 -> subtotal 6000 -> commission 600, receivable 5400
//
// This is what replaced the old labour-only earning model, under which those
// two quotes paid the technician 2000 and 500 respectively for identical work
// at an identical price to the customer.
//
// COMMISSION BASE = the three technician-controlled line items the approved
// quote actually carries (utils/quote.js): partsAmount + laborAmount +
// additionalCharges - which is exactly quote.totalAmount. The quote schema has
// no delivery, shipping, tax or payment-processing line, so none is excluded
// here by special case; if such a line is ever added to the quote it must be
// added to COMMISSION_BASE_FIELDS deliberately, or it will be silently
// commissioned.
//
// INTEGER BDT ONLY. Every amount in and out of this module is whole taka.
// The commission is computed as an integer ratio (numerator/denominator)
// rather than a float multiplication, and the receivable is derived by
// SUBTRACTION rather than by a second percentage, so the invariant
//
//   platformCommission + technicianReceivable === repairSubtotal
//
// holds by construction for every input, including subtotals that are not
// divisible by 10.

const PLATFORM_COMMISSION_RATE = 0.10;

// The rate again, as the exact integer ratio actually used for arithmetic.
// PLATFORM_COMMISSION_RATE above is the value reported to clients and stored on
// the snapshot; these two are asserted to agree by the test suite.
const COMMISSION_NUMERATOR = 10;
const COMMISSION_DENOMINATOR = 100;

// The approved-quote fields that make up the commission base, in the order they
// are presented. Named explicitly so the base can never drift silently.
const COMMISSION_BASE_FIELDS = Object.freeze(['partsAmount', 'laborAmount', 'additionalCharges']);

const SETTLEMENT_CURRENCY = 'BDT';
const SETTLEMENT_VERSION = 1;

// Per-settlement lifecycle. RESERVED and WITHDRAWN are deliberately NOT
// settlement states: they are properties of a withdrawal, applied across the
// wallet as a whole rather than pinned to individual repairs, so no settlement
// ever has to be re-written when a withdrawal is raised, paid or rejected.
const SETTLEMENT_PENDING = 'pending';
const SETTLEMENT_AVAILABLE = 'available';

// Withdrawal lifecycle. 'requested' is the only open state.
const WITHDRAWAL_REQUESTED = 'requested';
const WITHDRAWAL_PAID = 'paid';
const WITHDRAWAL_REJECTED = 'rejected';
const WITHDRAWAL_STATUSES = Object.freeze([WITHDRAWAL_REQUESTED, WITHDRAWAL_PAID, WITHDRAWAL_REJECTED]);

const WITHDRAWAL_NOTE_MAX = 500;

function isWholeTaka(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// Reads one commission-base line. An absent additionalCharges means 0 (the
// quote schema treats it as optional), but a PRESENT-but-invalid value is an
// error rather than a silent zero - a corrupt line must never quietly shrink
// the commission base.
function readLine(quote, field) {
    const raw = quote[field];
    if (raw === undefined || raw === null) {
        return field === 'additionalCharges' ? { valid: true, amount: 0 } : { valid: false };
    }
    return isWholeTaka(raw) ? { valid: true, amount: raw } : { valid: false };
}

// Commission for a subtotal, as an integer. Uses an integer ratio rather than
// `subtotal * 0.10`, which for some inputs lands on a value like 600.4999...
// and rounds the wrong way.
function commissionFor(repairSubtotal) {
    return Math.round((repairSubtotal * COMMISSION_NUMERATOR) / COMMISSION_DENOMINATOR);
}

// Derives the full settlement breakdown from an APPROVED quote sub-document.
// Never trusts a client-supplied subtotal, commission or receivable - the only
// inputs read are the three line items above.
//
// Returns { valid: false, code, message } rather than throwing, so a caller in
// the middle of a payment transaction can decide whether a non-derivable
// settlement should abort anything (it should not - see paymentProcessor.js).
function calculateSettlement(quote) {
    if (typeof quote !== 'object' || quote === null || Array.isArray(quote)) {
        return { valid: false, code: 'INVALID_QUOTE', message: 'a quote object is required to derive a settlement' };
    }

    const parts = readLine(quote, 'partsAmount');
    const labor = readLine(quote, 'laborAmount');
    const additional = readLine(quote, 'additionalCharges');
    if (!parts.valid || !labor.valid || !additional.valid) {
        return { valid: false, code: 'INVALID_QUOTE_AMOUNT', message: 'every quote line item must be a non-negative whole-taka integer' };
    }

    const repairSubtotal = parts.amount + labor.amount + additional.amount;

    // The subtotal is recomputed from the lines rather than read from
    // quote.totalAmount, so a persisted total that has drifted from its own
    // line items can never become the commission base. They are asserted equal
    // where a total is present, because that disagreement is a data fault worth
    // surfacing rather than quietly resolving in either direction.
    if (quote.totalAmount !== undefined && quote.totalAmount !== null && quote.totalAmount !== repairSubtotal) {
        return { valid: false, code: 'QUOTE_TOTAL_MISMATCH', message: 'the quote total does not equal the sum of its line items' };
    }

    const platformCommission = commissionFor(repairSubtotal);
    // Subtraction, never a second percentage - this is what makes the
    // invariant exact for subtotals that do not divide by 10.
    const technicianReceivable = repairSubtotal - platformCommission;

    return {
        valid: true,
        settlement: {
            partsAmount: parts.amount,
            laborAmount: labor.amount,
            additionalAmount: additional.amount,
            repairSubtotal,
            commissionRate: PLATFORM_COMMISSION_RATE,
            platformCommission,
            technicianReceivable,
            currency: SETTLEMENT_CURRENCY,
            version: SETTLEMENT_VERSION,
        },
    };
}

// Builds the persisted settlement snapshot from an ALREADY-derived breakdown.
// Frozen at payment confirmation: a later quote edit does not reach back into
// a settlement that has already been written, because nothing ever recomputes
// this document - it is written once and only its `status` moves afterwards.
function buildSettlementDocument(settlement, { technicianId, technicianEmail, now }) {
    return {
        status: SETTLEMENT_PENDING,
        technicianId,
        technicianEmail,
        partsAmount: settlement.partsAmount,
        laborAmount: settlement.laborAmount,
        additionalAmount: settlement.additionalAmount,
        repairSubtotal: settlement.repairSubtotal,
        commissionRate: settlement.commissionRate,
        platformCommission: settlement.platformCommission,
        technicianReceivable: settlement.technicianReceivable,
        currency: settlement.currency,
        version: settlement.version,
        settledAt: now,
        availableAt: null,
    };
}

// Whether a repair request's settlement may contribute to a wallet at all.
//
// A repair that was settled under the OLD labour-only model and already marked
// paid by an admin is excluded permanently: that money left the business
// through the retired per-repair payout, and letting it reappear as wallet
// balance would pay the technician twice for the same repair. This is the only
// reason a written settlement is ever ignored.
function isLegacyAlreadyPaid(repairRequest) {
    const legacy = repairRequest && repairRequest.technicianEarning;
    return !!legacy && legacy.status === 'paid';
}

// Reduces a technician's repair requests + withdrawals into the wallet the API
// reports. Every figure the client shows comes from here; the client never adds
// anything up itself.
//
//   pendingBalance   paid, but the customer has not confirmed receipt yet
//   grossAvailable   receipt-confirmed receivables
//   reservedBalance  sitting inside an open (requested) withdrawal
//   withdrawnBalance already paid out
//   availableBalance grossAvailable - reserved - withdrawn, floored at 0
//
// availableBalance is floored rather than allowed negative: a negative wallet
// would read as a debt the technician owes, which this model has no concept of.
// The floor is a display guarantee, not a substitute for the withdrawal
// validation below, which still refuses any amount above the real figure.
function calculateWallet({ repairRequests = [], withdrawals = [] } = {}) {
    let pendingBalance = 0;
    let grossAvailableBalance = 0;
    let lifetimeReceivable = 0;
    let settlementCount = 0;

    for (const repairRequest of repairRequests) {
        const settlement = repairRequest && repairRequest.technicianSettlement;
        if (!settlement) continue;
        if (isLegacyAlreadyPaid(repairRequest)) continue;
        if (!isWholeTaka(settlement.technicianReceivable)) continue;

        settlementCount += 1;
        lifetimeReceivable += settlement.technicianReceivable;
        if (settlement.status === SETTLEMENT_AVAILABLE) {
            grossAvailableBalance += settlement.technicianReceivable;
        } else {
            pendingBalance += settlement.technicianReceivable;
        }
    }

    let reservedBalance = 0;
    let withdrawnBalance = 0;
    for (const withdrawal of withdrawals) {
        if (!withdrawal || !isWholeTaka(withdrawal.amount)) continue;
        if (withdrawal.status === WITHDRAWAL_REQUESTED) reservedBalance += withdrawal.amount;
        else if (withdrawal.status === WITHDRAWAL_PAID) withdrawnBalance += withdrawal.amount;
        // 'rejected' contributes to neither, which is exactly what releases a
        // rejected withdrawal's reservation back into the available balance -
        // no compensating write is needed anywhere.
    }

    const availableBalance = Math.max(0, grossAvailableBalance - reservedBalance - withdrawnBalance);

    return {
        pendingBalance,
        grossAvailableBalance,
        availableBalance,
        reservedBalance,
        withdrawnBalance,
        lifetimeReceivable,
        settlementCount,
        commissionRate: PLATFORM_COMMISSION_RATE,
        currency: SETTLEMENT_CURRENCY,
    };
}

// Validates a withdrawal request body. The amount is the ONLY thing a client
// supplies; identity comes from the verified token and the ceiling comes from
// calculateWallet above.
function validateWithdrawalRequest(body, { availableBalance, hasOpenWithdrawal }) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { valid: false, code: 'INVALID_WITHDRAWAL', message: 'withdrawal payload must be an object' };
    }
    // Rejected loudly rather than stripped, the same stance utils/quote.js
    // takes on server-owned fields: a client trying to set its own receivable
    // or commission is an obvious error, never a silent no-op.
    for (const forbidden of ['technicianEmail', 'technicianId', 'status', 'commissionRate', 'technicianReceivable', 'processedAt', 'processedBy']) {
        if (Object.prototype.hasOwnProperty.call(body, forbidden)) {
            return { valid: false, code: 'INVALID_WITHDRAWAL', message: `client-supplied field "${forbidden}" is not allowed on a withdrawal request` };
        }
    }
    if (!isWholeTaka(body.amount)) {
        return { valid: false, code: 'INVALID_WITHDRAWAL_AMOUNT', message: 'amount must be a whole-taka integer' };
    }
    if (body.amount <= 0) {
        return { valid: false, code: 'INVALID_WITHDRAWAL_AMOUNT', message: 'amount must be greater than zero' };
    }
    if (hasOpenWithdrawal) {
        return { valid: false, code: 'WITHDRAWAL_ALREADY_OPEN', message: 'you already have a withdrawal request awaiting processing' };
    }
    if (body.amount > availableBalance) {
        return { valid: false, code: 'WITHDRAWAL_EXCEEDS_AVAILABLE', message: 'amount is greater than your available balance' };
    }
    return { valid: true, normalized: { amount: body.amount } };
}

function buildWithdrawalDocument({ technicianId, technicianEmail, amount, now }) {
    return {
        technicianId,
        technicianEmail,
        amount,
        currency: SETTLEMENT_CURRENCY,
        status: WITHDRAWAL_REQUESTED,
        requestedAt: now,
        processedAt: null,
        processedBy: null,
        note: null,
    };
}

// Admin-facing note / rejection reason. Optional in both cases - a rejection
// without a reason is allowed rather than blocked, because refusing to record
// the decision at all would be worse than recording it unexplained.
function validateProcessingNote(body) {
    if (body === undefined || body === null) return { valid: true, normalized: { note: null } };
    if (typeof body !== 'object' || Array.isArray(body)) {
        return { valid: false, code: 'INVALID_WITHDRAWAL_NOTE', message: 'payload must be an object' };
    }
    const raw = body.note;
    if (raw === undefined || raw === null) return { valid: true, normalized: { note: null } };
    if (typeof raw !== 'string' || raw.trim().length > WITHDRAWAL_NOTE_MAX) {
        return { valid: false, code: 'INVALID_WITHDRAWAL_NOTE', message: `note must be a string of at most ${WITHDRAWAL_NOTE_MAX} characters` };
    }
    const trimmed = raw.trim();
    return { valid: true, normalized: { note: trimmed.length === 0 ? null : trimmed } };
}

// Read views. The settlement view is safe for the owning technician and for
// admins; it carries no customer identity and no internal submitter id.
function buildSettlementView(repairRequest) {
    const settlement = repairRequest && repairRequest.technicianSettlement;
    if (!settlement) return null;
    return {
        repairRequestId: repairRequest._id ? repairRequest._id.toString() : null,
        trackingId: repairRequest.trackingId ?? null,
        status: settlement.status,
        partsAmount: settlement.partsAmount,
        laborAmount: settlement.laborAmount,
        additionalAmount: settlement.additionalAmount,
        repairSubtotal: settlement.repairSubtotal,
        commissionRate: settlement.commissionRate,
        platformCommission: settlement.platformCommission,
        technicianReceivable: settlement.technicianReceivable,
        currency: settlement.currency,
        settledAt: settlement.settledAt ?? null,
        availableAt: settlement.availableAt ?? null,
    };
}

function buildWithdrawalView(withdrawal) {
    if (!withdrawal) return null;
    return {
        id: withdrawal._id ? withdrawal._id.toString() : null,
        amount: withdrawal.amount,
        currency: withdrawal.currency || SETTLEMENT_CURRENCY,
        status: withdrawal.status,
        requestedAt: withdrawal.requestedAt ?? null,
        processedAt: withdrawal.processedAt ?? null,
        note: withdrawal.note ?? null,
    };
}

module.exports = {
    PLATFORM_COMMISSION_RATE,
    COMMISSION_NUMERATOR,
    COMMISSION_DENOMINATOR,
    COMMISSION_BASE_FIELDS,
    SETTLEMENT_CURRENCY,
    SETTLEMENT_VERSION,
    SETTLEMENT_PENDING,
    SETTLEMENT_AVAILABLE,
    WITHDRAWAL_REQUESTED,
    WITHDRAWAL_PAID,
    WITHDRAWAL_REJECTED,
    WITHDRAWAL_STATUSES,
    WITHDRAWAL_NOTE_MAX,
    calculateSettlement,
    buildSettlementDocument,
    isLegacyAlreadyPaid,
    calculateWallet,
    validateWithdrawalRequest,
    buildWithdrawalDocument,
    validateProcessingNote,
    buildSettlementView,
    buildWithdrawalView,
};
