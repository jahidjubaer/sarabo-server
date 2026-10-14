// Smarter matching: the scoring rules (services/offerRanking.js) and the
// ranking the customer gets on GET /repair-requests/:id/applications.
const {
    ratingScore, reliabilityScore, distanceScore, responseScore, priceScores, medianResponseMinutes, rankOffers, NEUTRAL,
} = require('../services/offerRanking');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

const MINUTE = 60 * 1000;

function runOfferRankingUnitTests({ logTest }) {
    logTest('Ranking: no reviews, no jobs, no reply history and no district all score neutral',
        ratingScore(null, 0) === NEUTRAL && reliabilityScore(0, 0) === NEUTRAL && responseScore(null) === NEUTRAL && distanceScore(null, 'Sylhet') === NEUTRAL);
    logTest('Ranking: forty 4.8-star reviews beat a single 5-star review', ratingScore(4.8, 40) > ratingScore(5, 1));
    logTest('Ranking: a missed pickup lowers reliability', reliabilityScore(10, 1) < reliabilityScore(10, 0) && reliabilityScore(0, 2) < NEUTRAL);
    logTest('Ranking: same district (any case) beats another district',
        distanceScore('sylhet', 'Sylhet ') === 1 && distanceScore('Moulvibazar', 'Sylhet') < NEUTRAL);
    logTest('Ranking: replies within 30 minutes score 1, a day or slower 0, in between in order',
        responseScore(10) === 1 && responseScore(24 * 60) === 0 && responseScore(3000) === 0 && responseScore(60) > responseScore(600));
    const prices = priceScores([{ estimateMin: 1000, estimateMax: 2000, inspectionFee: 0 }, { estimateMin: 2000, estimateMax: 3000, inspectionFee: 0 }]);
    logTest('Ranking: the cheaper offer scores 1, the dearer 0; a single offer is neutral',
        prices[0] === 1 && prices[1] === 0 && priceScores([{ estimateMin: 1, estimateMax: 2, inspectionFee: 0 }])[0] === NEUTRAL);
    const tieFee = priceScores([{ estimateMin: 1000, estimateMax: 1000, inspectionFee: 300 }, { estimateMin: 1000, estimateMax: 1000, inspectionFee: 100 }]);
    logTest('Ranking: with the same estimate, the lower inspection fee wins', tieFee[1] > tieFee[0]);

    const t0 = new Date('2026-10-01T10:00:00Z');
    const at = (m) => new Date(t0.getTime() + m * MINUTE);
    logTest('Ranking: response time needs at least three past offers',
        medianResponseMinutes([{ postedAt: t0, appliedAt: at(5) }, { postedAt: t0, appliedAt: at(9) }]) === null);
    logTest('Ranking: response time is the median and ignores impossible (negative) samples',
        medianResponseMinutes([
            { postedAt: t0, appliedAt: at(10) }, { postedAt: t0, appliedAt: at(20) }, { postedAt: t0, appliedAt: at(600) }, { postedAt: at(50), appliedAt: t0 },
        ]) === 20);

    const tech = (overrides) => ({ district: 'Sylhet', averageRating: null, reviewCount: 0, completedRepairs: 0, noShows: 0, medianResponseMinutes: null, ...overrides });
    const offer = (id, overrides = {}, technician = {}) => ({
        id, estimateMin: 1500, estimateMax: 2500, inspectionFee: 200, createdAt: at(Number(id.slice(1))), ...overrides, technician: tech(technician),
    });
    const ranked = rankOffers([
        offer('o1', {}, { averageRating: 3.2, reviewCount: 12, completedRepairs: 8, noShows: 3, district: 'Moulvibazar' }),
        offer('o2', {}, { averageRating: 4.9, reviewCount: 25, completedRepairs: 30, medianResponseMinutes: 20 }),
        offer('o3', { estimateMin: 1200, estimateMax: 2000 }, {}),
    ], { customerDistrict: 'Sylhet' });
    const best = ranked.get('o2');
    logTest('Ranking: a well-rated, reliable, nearby, quick technician is ranked first and recommended',
        best.rank === 1 && best.recommended === true && ranked.get('o1').rank === 3 && ranked.get('o1').recommended === false);
    const codes = (id) => ranked.get(id).reasons.map((r) => r.code);
    logTest('Ranking: reasons state only real facts (rating, completed jobs, district, reply time)',
        ['top_rated', 'reliable', 'same_district', 'fast_reply'].every((c) => codes('o2').includes(c))
        && best.reasons.find((r) => r.code === 'top_rated').value === 4.9 && best.reasons.find((r) => r.code === 'reliable').value === 30);
    logTest('Ranking: the cheapest offer says so, and a newcomer gets no rating or reliability reason',
        codes('o3').includes('lowest_price') && !codes('o3').includes('top_rated') && !codes('o3').includes('reliable') && !codes('o1').includes('reliable'));
    logTest('Ranking: scores are whole numbers from 0 to 100', [...ranked.values()].every((m) => Number.isInteger(m.score) && m.score >= 0 && m.score <= 100));

    const single = rankOffers([offer('o1')], { customerDistrict: 'Sylhet' });
    logTest('Ranking: a single offer is ranked but never "recommended"', single.get('o1').rank === 1 && single.get('o1').recommended === false);
    const twins = rankOffers([offer('o7'), offer('o3')], { customerDistrict: 'Sylhet' });
    logTest('Ranking: equal offers go to the one sent first, and neither is "lowest price"',
        twins.get('o3').rank === 1 && twins.get('o3').reasons.every((r) => r.code !== 'lowest_price'));
    logTest('Ranking: no offers gives an empty ranking', rankOffers([]).size === 0);
}

async function runOfferRankingTests({ logTest }) {
    runOfferRankingUnitTests({ logTest });

    const { ObjectId } = require('mongodb');
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const JobPortalController = require('../controllers/jobPortalController');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const CUSTOMER = `rank-customer-${runId}@example.test`;
    const requestIds = [];
    const technicianIds = [];
    const portal = new JobPortalController(models, c);
    const now = Date.now();
    const ago = (minutes) => new Date(now - minutes * MINUTE);

    const insertTech = async (name, district) => {
        const { insertedId } = await c.technicians.insertOne({
            name: `${name} ${runId}`, email: `rank-${name}-${runId}@example.test`, region: 'Sylhet', district, status: 'approved', workStatus: 'available', createdAt: new Date(),
        });
        technicianIds.push(insertedId);
        return insertedId.toString();
    };
    const insertRequest = async (overrides = {}) => {
        const { insertedId } = await c.repairRequests.insertOne({
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `RANK-${runId}-${requestIds.length}`,
            product: { categorySlug: 'smartphone' }, service: { repairCategorySlug: 'display-screen' },
            damage: { description: 'Ranking test.', images: [] }, pricing: { estimateMin: 1000, estimateMax: 3000, currency: 'BDT', inspectionFee: 300 },
            serviceLocation: { region: 'Sylhet', district: 'Sylhet' }, deliveryStatus: 'pending-pickup', createdAt: ago(60), ...overrides,
        });
        requestIds.push(insertedId);
        return insertedId.toString();
    };

    try {
        await c.users.insertOne({ email: CUSTOMER, role: 'user', createdAt: new Date() });
        const quick = await insertTech('quick', 'Sylhet');
        const slow = await insertTech('slow', 'Habiganj');

        // History: "quick" replied within 10 minutes on three past jobs and
        // finished them; "slow" took about 20 hours and missed one pickup.
        for (let i = 0; i < 3; i += 1) {
            const pastQuick = await insertRequest({ createdAt: ago(5000 + i), technicianId: quick, deliveryStatus: 'parcel_delivered' });
            await c.jobApplications.insertOne({ requestId: pastQuick, technicianId: quick, status: 'accepted', createdAt: ago(4990 + i) });
            const pastSlow = await insertRequest({ createdAt: ago(5000 + i), deliveryStatus: 'pending-pickup', technicianId: 'someone-else' });
            await c.jobApplications.insertOne({ requestId: pastSlow, technicianId: slow, status: i === 0 ? 'no_show' : 'not_chosen', createdAt: ago(5000 + i - 1200) });
        }
        // A reposted job: the offer counts from the repost, not from publishing.
        const reposted = await insertRequest({ createdAt: ago(9000), repostedAt: ago(3000), deliveryStatus: 'pending-pickup', technicianId: 'someone-else' });
        await c.jobApplications.insertOne({ requestId: reposted, technicianId: quick, status: 'not_chosen', createdAt: ago(2995) });

        const open = await insertRequest();
        // "slow" offers the lower price, so price alone would pick them.
        await c.jobApplications.insertMany([
            { requestId: open, technicianId: slow, technicianName: 'slow', status: 'pending', estimateMin: 1000, estimateMax: 1800, inspectionFee: 200, createdAt: ago(30) },
            { requestId: open, technicianId: quick, technicianName: 'quick', status: 'pending', estimateMin: 1500, estimateMax: 2500, inspectionFee: 200, createdAt: ago(20) },
            { requestId: open, technicianId: 'gone', technicianName: 'gone', status: 'declined', estimateMin: 900, estimateMax: 1000, inspectionFee: 0, createdAt: ago(40) },
        ]);

        const res = fakeRes();
        await portal.listForRequest({ decoded_email: CUSTOMER, params: { id: open }, query: {}, body: {} }, res);
        const byTech = (id) => res.body.applications.find((a) => a.technician.name.startsWith(id));
        const q = byTech('quick');
        const s = byTech('slow');
        logTest('Ranking (API): every waiting offer carries a match score and rank', res.statusCode === 200 && q.match && s.match && q.match.rank !== s.match.rank);
        logTest('Ranking (API): the nearby, quick, reliable technician is recommended over a cheaper one with a missed pickup',
            q.match.rank === 1 && q.match.recommended === true && s.match.recommended === false);
        const reason = (a, code) => a.match.reasons.find((r) => r.code === code);
        logTest('Ranking (API): reply time is measured from posting or repost (median about 10 minutes)',
            reason(q, 'fast_reply') && reason(q, 'fast_reply').value === 10);
        logTest('Ranking (API): the cheaper offer is marked lowest price; the slow technician gets no reply-time reason',
            !!reason(s, 'lowest_price') && !reason(s, 'fast_reply') && !!reason(q, 'same_district') && !reason(s, 'same_district'));
        logTest('Ranking (API): a rejected offer is not ranked', !('match' in res.body.applications.find((a) => a.status === 'declined')));
        logTest('Ranking (API): the response still shows no technician email or private details',
            !JSON.stringify(res.body).includes('@example.test'));
    } finally {
        await c.jobApplications.deleteMany({ requestId: { $in: requestIds.map(String) } });
        await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        await c.technicians.deleteMany({ _id: { $in: technicianIds.map((id) => new ObjectId(id)) } });
        await c.users.deleteMany({ email: CUSTOMER });
    }
}

module.exports = { runOfferRankingTests, runOfferRankingUnitTests };
