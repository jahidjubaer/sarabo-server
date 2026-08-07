// Single source of truth for Sarabo's MVP payment currency and its Stripe
// smallest-unit conversion. Every server module that creates or verifies a
// Stripe Checkout Session imports from here rather than hardcoding a
// currency string, so there is exactly one place to change if this MVP
// decision is ever revisited.
//
// Why USD, not BDT: the UI's "$" display (in most places), the Stripe
// integration, and every real Stripe test-mode payment completed so far
// (Units 2-4) already use USD. Bangladeshi Taka (BDT) IS a Stripe-supported
// presentment currency for this account (verified directly against the
// test-mode API), but Stripe enforces a ~$0.50-equivalent minimum charge per
// Checkout Session - at the real BDT/USD rate, the lowest tier produced by
// the existing (courier-template-derived) cost formula (60, same-district
// on-site repair) converts to under that minimum and Stripe rejects it
// outright. Every currently-stored real request uses exactly that cost
// value. Switching to BDT would immediately break payment for all of them
// without also revising the cost formula, which is a separate, out-of-scope
// pricing change. USD remains canonical until that pricing model is
// deliberately revisited.
const PAYMENT_CURRENCY = 'usd';

// V2 approved-quote payments (Phase 6.4 Unit 6) are denominated in Bangladeshi
// Taka - the currency the quote itself is persisted in (utils/quote.js stores
// QUOTE_CURRENCY = 'BDT'). This is deliberately a SEPARATE constant from the
// legacy PAYMENT_CURRENCY above, never a global switch: legacy requests keep
// paying in USD from parcel.cost, V2 requests pay in BDT from
// quote.totalAmount, and the two paths never share a currency. BDT is a
// Stripe-supported presentment currency for this account and, unlike the
// lowest legacy cost tier, an approved repair quote is always well above
// Stripe's minimum-charge threshold. The Stripe API expects the lowercase
// ISO code; the quote stores the uppercase 'BDT' - see isBdtQuoteCurrency.
const V2_PAYMENT_CURRENCY = 'bdt';

// Stripe's smallest-unit multiplier for the currencies used here. Both usd and
// bdt are 2-decimal currencies, so a whole-taka quote total (e.g. 4500) becomes
// 450000 poisha - well clear of the smallest-charge floor. This does NOT
// generalize to zero-decimal currencies like jpy and must be reconsidered if
// either payment currency ever changes.
const SMALLEST_UNIT_MULTIPLIER = 100;

// Controlled rounding to Stripe's smallest currency unit - raw
// floating-point multiplication (e.g. 19.99 * 100) can produce values like
// 1998.9999999999998.
function toSmallestUnit(amount) {
    return Math.round(amount * SMALLEST_UNIT_MULTIPLIER);
}

function isValidStoredCost(cost) {
    return Number.isFinite(cost) && cost > 0;
}

// A payable V2 quote total: a strictly-positive whole-taka integer. Quotes are
// stored as integer taka (no poisha), so anything fractional, non-finite, zero,
// or negative is not a valid amount to charge.
function isValidQuoteTotal(amount) {
    return Number.isInteger(amount) && amount > 0;
}

// The quote sub-document stores its currency uppercase ('BDT'); Stripe uses the
// lowercase ISO code. This compares the stored quote currency against the
// canonical V2 currency case-insensitively, so a quote is only ever payable in
// the one currency the V2 path supports.
function isBdtQuoteCurrency(currency) {
    return typeof currency === 'string' && currency.trim().toLowerCase() === V2_PAYMENT_CURRENCY;
}

module.exports = {
    PAYMENT_CURRENCY,
    V2_PAYMENT_CURRENCY,
    toSmallestUnit,
    isValidStoredCost,
    isValidQuoteTotal,
    isBdtQuoteCurrency,
};
