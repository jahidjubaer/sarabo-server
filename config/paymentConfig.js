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

// Stripe's smallest-unit multiplier for the canonical currency. Most
// currencies (including usd and bdt) use 2 decimal places; this does NOT
// generalize to zero-decimal currencies like jpy and must be reconsidered if
// PAYMENT_CURRENCY ever changes.
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

module.exports = { PAYMENT_CURRENCY, toSmallestUnit, isValidStoredCost };
