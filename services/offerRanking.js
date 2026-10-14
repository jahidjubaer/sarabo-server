// Smarter matching: ranks the offers waiting on a repair request so the
// customer can see which one fits best, and why. Pure: no database access.
//
// Five factors, each scored 0..1, from data Sarabo already stores:
//   rating      - visible reviews, smoothed toward a neutral 3 stars so one
//                 5-star review does not outrank forty 4.8-star ones
//   reliability - repairs completed against pickups missed (no-shows)
//   price       - this offer's estimate against the other waiting offers
//   distance    - same district as the customer, or only the same region
//                 (there are no map coordinates, so nothing finer)
//   response    - the technician's usual time to send an offer after a job
//                 is posted (median of their recent offers)
// A technician with no history gets the neutral 0.5 for that factor - never
// a penalty and never a bonus.

const WEIGHTS = Object.freeze({ rating: 0.3, reliability: 0.25, price: 0.2, distance: 0.15, response: 0.1 });
const NEUTRAL = 0.5;

const RATING_PRIOR_MEAN = 3;
const RATING_PRIOR_WEIGHT = 2;
const OTHER_DISTRICT_SCORE = 0.4;
const FAST_REPLY_MINUTES = 30;
const SLOW_REPLY_MINUTES = 24 * 60;
const MIN_RESPONSE_SAMPLES = 3;
const RESPONSE_SAMPLE_LIMIT = 20;

// Reason thresholds: only facts strong enough to be worth saying.
const TOP_RATED_MIN = 4.5;
const TOP_RATED_MIN_REVIEWS = 3;
const FAST_REPLY_REASON_MINUTES = 60;
const RELIABLE_MIN_COMPLETED = 5;

function clamp01(value) {
    return Math.min(Math.max(value, 0), 1);
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sameText(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.trim() !== '' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function ratingScore(averageRating, reviewCount) {
    if (!reviewCount || typeof averageRating !== 'number' || !Number.isFinite(averageRating)) return NEUTRAL;
    const smoothed = (averageRating * reviewCount + RATING_PRIOR_MEAN * RATING_PRIOR_WEIGHT) / (reviewCount + RATING_PRIOR_WEIGHT);
    return clamp01((smoothed - 1) / 4);
}

// Laplace-smoothed share of booked jobs that were not missed: 0.5 with no history.
function reliabilityScore(completed, noShows) {
    return (completed + 1) / (completed + noShows + 2);
}

function distanceScore(technicianDistrict, customerDistrict) {
    if (!technicianDistrict || !customerDistrict) return NEUTRAL;
    return sameText(technicianDistrict, customerDistrict) ? 1 : OTHER_DISTRICT_SCORE;
}

// 30 minutes or faster scores 1, a day or slower scores 0, on a log scale.
function responseScore(medianMinutes) {
    if (medianMinutes === null) return NEUTRAL;
    const minutes = Math.max(medianMinutes, FAST_REPLY_MINUTES);
    return clamp01(1 - Math.log(minutes / FAST_REPLY_MINUTES) / Math.log(SLOW_REPLY_MINUTES / FAST_REPLY_MINUTES));
}

function midpoint(offer) {
    return (offer.estimateMin + offer.estimateMax) / 2;
}

// The cheapest waiting offer scores 1 and the dearest 0; the inspection fee
// breaks ties. One offer, or all the same, scores the neutral 0.5.
function priceScores(offers) {
    const totals = offers.map((o) => midpoint(o) + (Number(o.inspectionFee) || 0) / 1000);
    const low = Math.min(...totals);
    const high = Math.max(...totals);
    return totals.map((t) => (high === low ? NEUTRAL : (high - t) / (high - low)));
}

// The median minutes from a job being posted to this technician's offer, over
// their most recent offers, or null with too few to go on.
// samples: [{ appliedAt, postedAt }]
function medianResponseMinutes(samples) {
    const minutes = (samples || [])
        .slice(0, RESPONSE_SAMPLE_LIMIT)
        .map((s) => (new Date(s.appliedAt).getTime() - new Date(s.postedAt).getTime()) / 60000)
        .filter((m) => Number.isFinite(m) && m >= 0);
    return minutes.length >= MIN_RESPONSE_SAMPLES ? median(minutes) : null;
}

// offers: [{ id, estimateMin, estimateMax, inspectionFee, createdAt,
//   technician: { district, averageRating, reviewCount, completedRepairs, noShows, medianResponseMinutes } }]
// Returns Map id -> { score (0-100), rank (1 = best), recommended, reasons: [{ code, value? }] }.
// Only a field of two or more offers gets a "recommended" one.
function rankOffers(offers, { customerDistrict = null } = {}) {
    if (!Array.isArray(offers) || offers.length === 0) return new Map();
    const prices = priceScores(offers);
    const lowestMid = Math.min(...offers.map(midpoint));
    const lowestCount = offers.filter((o) => midpoint(o) === lowestMid).length;

    const scored = offers.map((offer, i) => {
        const t = offer.technician || {};
        const completed = t.completedRepairs || 0;
        const noShows = t.noShows || 0;
        const responseMinutes = typeof t.medianResponseMinutes === 'number' ? t.medianResponseMinutes : null;
        const factors = {
            rating: ratingScore(t.averageRating, t.reviewCount),
            reliability: reliabilityScore(completed, noShows),
            price: prices[i],
            distance: distanceScore(t.district, customerDistrict),
            response: responseScore(responseMinutes),
        };
        const total = Object.keys(WEIGHTS).reduce((sum, key) => sum + WEIGHTS[key] * factors[key], 0);

        const reasons = [];
        if (t.reviewCount >= TOP_RATED_MIN_REVIEWS && t.averageRating >= TOP_RATED_MIN) reasons.push({ code: 'top_rated', value: Math.round(t.averageRating * 10) / 10 });
        if (completed >= RELIABLE_MIN_COMPLETED && noShows === 0) reasons.push({ code: 'reliable', value: completed });
        if (offers.length > 1 && midpoint(offer) === lowestMid && lowestCount === 1) reasons.push({ code: 'lowest_price' });
        if (factors.distance === 1) reasons.push({ code: 'same_district' });
        if (responseMinutes !== null && responseMinutes <= FAST_REPLY_REASON_MINUTES) reasons.push({ code: 'fast_reply', value: Math.round(responseMinutes) });

        return { id: offer.id, total, createdAt: new Date(offer.createdAt || 0).getTime(), reasons };
    });

    // Best score first; an equal score goes to the earlier offer.
    const ordered = [...scored].sort((a, b) => (b.total - a.total) || (a.createdAt - b.createdAt));
    return new Map(ordered.map((s, index) => [s.id, {
        score: Math.round(s.total * 100),
        rank: index + 1,
        recommended: offers.length > 1 && index === 0,
        reasons: s.reasons,
    }]));
}

module.exports = {
    WEIGHTS, NEUTRAL, RESPONSE_SAMPLE_LIMIT,
    ratingScore, reliabilityScore, distanceScore, responseScore, priceScores, medianResponseMinutes, rankOffers,
};
