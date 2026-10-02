const { helperErrors, runAiCall } = require('./aiHelperCall');
const { getProductCategoryBySlug } = require('../utils/productCategory');
const { getRepairCategoryBySlug } = require('../utils/repairCategory');

// Admin Reports: "what happened and what to do", written by AI from the
// report's own numbers. The AI may only restate numbers it was given: any
// sentence with a number that isn't in the facts (or a simple change between
// a period and the one before) is dropped before an admin sees it.
const HEADLINE_MAX = 220;
const ITEM_MAX = 260;
const MAX_HIGHLIGHTS = 4;
const MAX_ACTIONS = 3;
const TOP_REGIONS = 6;
const TOP_ITEMS = 5;
// Small counts ("two regions", "3 technicians") are fine without a source,
// and so are the fixed numbers in the facts' own names ("no offer chosen in
// 24 hours") and the report periods.
const FREE_NUMBER_MAX = 10;
const CONTEXT_NUMBERS = Object.freeze([24, 30, 90]);

const errors = helperErrors({
    unavailable: 'The AI summary is not available right now.',
    timeout: 'The AI summary took too long. Please try again.',
    invalid: 'The AI summary could not be written. Please try again.',
});

const label = (lookup, slug) => {
    const found = typeof slug === 'string' ? lookup(slug) : null;
    return found && found.label ? found.label : slug || 'Unknown';
};

// The report (controllers/adminReportController.js) and the attention counts,
// as compact named facts. No names, emails or ids - counts and places only.
function buildSummaryFacts(report, attentionCounts = {}) {
    const o = report.overview;
    const p = o.previous || {};
    const fees = report.inspectionFees || {};
    return {
        periodDays: report.range.days,
        requestsMade: { thisPeriod: o.created, previousPeriod: p.created },
        repairsFinished: { thisPeriod: o.completed, previousPeriod: p.completed },
        cancelled: { thisPeriod: o.cancelled, previousPeriod: p.cancelled },
        successRatePercent: { thisPeriod: o.successRate, previousPeriod: p.successRate },
        averageDaysToFinish: { thisPeriod: o.avgDaysToComplete, previousPeriod: p.avgDaysToComplete },
        turnedAwayNoLocalTechnician: { thisPeriod: o.turnedAway, previousPeriod: p.turnedAway },
        regions: (report.regions || []).slice(0, TOP_REGIONS).map((r) => ({
            region: r.region,
            requestsMade: r.requests,
            waitingNow: r.waiting,
            waitingWithNoTechnicianWhoCanTakeIt: r.unmatchedWaiting,
            turnedAway: r.turnedAway,
            approvedTechnicians: r.approvedTechnicians,
            availableTechnicians: r.availableTechnicians,
        })),
        topDevices: (report.devices || []).slice(0, TOP_ITEMS).map((d) => ({ device: label(getProductCategoryBySlug, d.productCategorySlug), requests: d.requests })),
        topRepairs: (report.repairs || []).slice(0, TOP_ITEMS).map((r) => ({ repair: label(getRepairCategoryBySlug, r.repairCategorySlug), requests: r.requests })),
        technicians: report.workload ? {
            approved: report.workload.approved,
            busyNow: report.workload.busy,
            freeNow: report.workload.free,
            neverGivenAJob: report.workload.neverAssigned,
        } : null,
        inspectionFeesBDT: {
            paid: fees.paid || null,
            refunded: fees.refunded || null,
            keptAfterNoRepair: fees.kept ? { count: fees.kept.count, amount: fees.kept.amount } : null,
            refundsWaitingNow: fees.refundPending || null,
        },
        needsAttentionNow: {
            waitingPastPickupTime: attentionCounts.overdueWaiting || 0,
            missedPickups: attentionCounts.missedPickups || 0,
            noTechnicianCanTake: attentionCounts.unmatchable || 0,
            noOfferChosenIn24Hours: attentionCounts.unchosen || 0,
            refundsWaiting: attentionCounts.feeRefunds || 0,
        },
    };
}

// Every number the summary may mention: those in the facts, plus the change
// (difference and rounded percent) between each period and the one before.
function allowedNumbers(facts) {
    const allowed = new Set(CONTEXT_NUMBERS);
    const add = (n) => { if (Number.isFinite(n)) { allowed.add(Math.abs(Math.round(n * 10) / 10)); allowed.add(Math.abs(Math.round(n))); } };
    const walk = (value) => {
        if (typeof value === 'number') add(value);
        else if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') {
            if (Number.isFinite(value.thisPeriod) && Number.isFinite(value.previousPeriod)) {
                add(value.thisPeriod - value.previousPeriod);
                if (value.previousPeriod !== 0) add(((value.thisPeriod - value.previousPeriod) / value.previousPeriod) * 100);
            }
            Object.values(value).forEach(walk);
        }
    };
    walk(facts);
    return allowed;
}

function numbersIn(text) {
    return (text.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => Number(n.replace(/,/g, '')));
}

function onlyKnownNumbers(text, allowed) {
    return numbersIn(text).every((n) => n <= FREE_NUMBER_MAX || allowed.has(n) || allowed.has(Math.round(n)));
}

function cleanItems(value, allowed, max) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= ITEM_MAX && onlyKnownNumbers(item, allowed))
        .slice(0, max);
}

function validateSummary(raw, facts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw errors.unusable();
    const allowed = allowedNumbers(facts);
    const highlights = cleanItems(raw.highlights, allowed, MAX_HIGHLIGHTS);
    const actions = cleanItems(raw.actions, allowed, MAX_ACTIONS);
    if (highlights.length === 0 && actions.length === 0) throw errors.unusable();
    const headline = typeof raw.headline === 'string' ? raw.headline.trim() : '';
    return {
        headline: headline.length > 0 && headline.length <= HEADLINE_MAX && onlyKnownNumbers(headline, allowed)
            ? headline
            : `Here is how the last ${facts.periodDays} days went.`,
        highlights,
        actions,
    };
}

function createAiReportSummaryService({ provider = null, config }) {
    const isAvailable = () => Boolean(config && config.enabled && provider && typeof provider.generateSummary === 'function');

    async function writeSummary({ facts, requestId }) {
        if (!isAvailable()) throw errors.unavailable();
        const raw = await runAiCall({
            timeoutMs: config.timeoutMs,
            errors,
            call: (signal) => provider.generateSummary({ facts, signal, requestId }),
        });
        return validateSummary(raw, facts);
    }

    return { isAvailable, writeSummary };
}

module.exports = { buildSummaryFacts, allowedNumbers, onlyKnownNumbers, validateSummary, createAiReportSummaryService };
