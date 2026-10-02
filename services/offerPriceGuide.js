// Price guide for a technician's offer (no AI): what other technicians offered
// for the same service lately, so a technician can see when their numbers are
// far from the usual. With too few offers to go on, the catalogue's own range
// is used instead. Offers the customer rejected or the technician withdrew
// are left out - they are not prices anyone agreed to.
const GUIDE_WINDOW_DAYS = 180;
const MIN_SAMPLE = 3;
const MAX_ROWS = 2000;
const COUNTED_STATUSES = Object.freeze(['pending', 'accepted', 'not_chosen']);

// Linear-interpolated percentile of a sorted list, rounded to whole taka.
function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    const index = (sorted.length - 1) * p;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (index - low));
}

const ascending = (values) => values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);

// Pure: turns offers into a guide. `catalogue` is { min, max, currency, maxInspectionFee }.
function summarizeOffers(offers, catalogue) {
    const base = {
        currency: catalogue.currency || 'BDT',
        catalogueEstimate: { min: catalogue.min, max: catalogue.max },
        maxInspectionFee: catalogue.maxInspectionFee,
    };
    if (offers.length < MIN_SAMPLE) {
        return {
            ...base,
            basis: 'catalogue',
            sampleSize: offers.length,
            estimate: { low: catalogue.min, high: catalogue.max },
            inspectionFee: null,
        };
    }
    const mins = ascending(offers.map((o) => o.estimateMin));
    const maxes = ascending(offers.map((o) => o.estimateMax));
    const fees = ascending(offers.map((o) => o.inspectionFee));
    return {
        ...base,
        basis: 'offers',
        sampleSize: offers.length,
        // The middle half of what technicians asked: from the usual "from"
        // to the usual "to".
        estimate: { low: percentile(mins, 0.25), high: percentile(maxes, 0.75) },
        inspectionFee: { low: percentile(fees, 0.25), high: percentile(fees, 0.75) },
    };
}

async function buildPriceGuide({ collections, request, maxInspectionFee, now = new Date() }) {
    const pricing = request.pricing || {};
    const catalogue = { min: pricing.estimateMin, max: pricing.estimateMax, currency: pricing.currency, maxInspectionFee };
    const definitionId = request.service && request.service.definitionId;
    if (!definitionId) return summarizeOffers([], catalogue);

    const since = new Date(now.getTime() - GUIDE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const sameService = await collections.repairRequests.find(
        { schemaVersion: 2, 'service.definitionId': definitionId, createdAt: { $gte: since } },
        { projection: { _id: 1 } }
    ).sort({ createdAt: -1 }).limit(MAX_ROWS).toArray();
    if (sameService.length === 0) return summarizeOffers([], catalogue);

    const offers = await collections.jobApplications.find(
        { requestId: { $in: sameService.map((r) => r._id.toString()) }, status: { $in: COUNTED_STATUSES } },
        { projection: { estimateMin: 1, estimateMax: 1, inspectionFee: 1 } }
    ).limit(MAX_ROWS).toArray();
    return summarizeOffers(offers, catalogue);
}

module.exports = { GUIDE_WINDOW_DAYS, MIN_SAMPLE, percentile, summarizeOffers, buildPriceGuide };
