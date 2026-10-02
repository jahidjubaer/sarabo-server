// Admin Reports AI summary: facts come from the report, the AI may only
// restate numbers it was given, and the last summary per period is kept.
// Uses a fake AI provider - never calls Gemini.
function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

const SAMPLE_REPORT = {
    range: { days: 7 },
    overview: {
        created: 42, completed: 30, cancelled: 5, successRate: 85.7, avgDaysToComplete: 3.2, turnedAway: 6,
        previous: { created: 35, completed: 28, cancelled: 4, successRate: 87.5, avgDaysToComplete: 3.5, turnedAway: 2 },
    },
    regions: [{ region: 'Sylhet', requests: 12, waiting: 4, unmatchedWaiting: 3, turnedAway: 5, approvedTechnicians: 1, availableTechnicians: 0 }],
    devices: [{ productCategorySlug: 'smartphone', requests: 20 }],
    repairs: [{ repairCategorySlug: 'display-screen', requests: 15 }],
    workload: { approved: 9, busy: 6, free: 3, neverAssigned: 2, top: [{ name: 'Secret Tech', completed: 7 }] },
    inspectionFees: { currency: 'BDT', paid: { count: 10, amount: 3000 }, refunded: { count: 1, amount: 300 }, kept: { count: 2, amount: 600, technicianShare: 540, saraboShare: 60 }, refundPending: { count: 1, amount: 300 } },
};

async function runAiReportSummaryTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const AdminReportController = require('../controllers/adminReportController');
    const AdminAttentionController = require('../controllers/adminAttentionController');
    const AdminReportSummaryController = require('../controllers/adminReportSummaryController');
    const { buildSummaryFacts, onlyKnownNumbers, allowedNumbers, validateSummary, createAiReportSummaryService } = require('../services/aiReportSummaryService');
    const { loadAiReportSummaryConfig } = require('../config/aiRequestHelper');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }

    // ---- Facts and number check (pure) ---------------------------------------
    const facts = buildSummaryFacts(SAMPLE_REPORT, { overdueWaiting: 2, missedPickups: 1, unmatchable: 3, unchosen: 0, feeRefunds: 1 });
    logTest('AI summary facts: named counts with the period before, labels for devices and repairs, no technician names',
        facts.periodDays === 7 && facts.requestsMade.thisPeriod === 42 && facts.requestsMade.previousPeriod === 35
        && facts.regions[0].waitingWithNoTechnicianWhoCanTakeIt === 3 && facts.topDevices[0].device === 'Mobile Phone'
        && facts.technicians.neverGivenAJob === 2 && facts.needsAttentionNow.missedPickups === 1
        && !JSON.stringify(facts).includes('Secret Tech'));

    const allowed = allowedNumbers(facts);
    logTest('AI summary numbers: numbers from the facts and period-on-period changes are allowed',
        onlyKnownNumbers('42 requests, up 7 from 35 (20%), BDT 3,000 paid, success 85.7%', allowed));
    logTest('AI summary numbers: a made-up number is caught, small counts are fine',
        !onlyKnownNumbers('Revenue was BDT 99,999.', allowed) && onlyKnownNumbers('Two regions need 3 technicians.', allowed)
        && onlyKnownNumbers('3 requests had no offer chosen within 24 hours.', allowed));

    const checked = validateSummary({
        headline: 'Requests rose to 42 this week.',
        highlights: ['42 requests were made, up from 35.', 'Customers spent BDT 77,777 on repairs.', 'Sylhet turned away 5 customers.'],
        actions: ['Recruit a technician in Sylhet.', 'Hire 47 new staff.'],
    }, facts);
    logTest('AI summary: sentences with invented numbers are dropped, the rest kept',
        checked.headline === 'Requests rose to 42 this week.' && checked.highlights.length === 2 && !checked.highlights.join(' ').includes('77,777')
        && checked.actions.length === 1 && checked.actions[0].startsWith('Recruit'));
    const badHeadline = validateSummary({ headline: 'A record 5000 repairs!', highlights: ['42 requests were made.'], actions: [] }, facts);
    logTest('AI summary: an invented number in the headline gives a plain headline instead', badHeadline.headline === 'Here is how the last 7 days went.');
    let code = null;
    try { validateSummary({ headline: 'x', highlights: ['BDT 123,456 lost'], actions: [] }, facts); } catch (e) { code = e.code; }
    logTest('AI summary: nothing usable left -> AI_HELPER_INVALID_RESPONSE', code === 'AI_HELPER_INVALID_RESPONSE');

    // ---- Endpoints -----------------------------------------------------------
    await connectDatabase();
    const models = initializeModels(c);
    const config = { ...loadAiReportSummaryConfig({}), enabled: true, timeoutMs: 200 };
    let seenFacts = null;
    const service = createAiReportSummaryService({
        provider: { generateSummary: async ({ facts: f }) => { seenFacts = f; return { headline: 'A quiet week.', highlights: [`${f.requestsMade.thisPeriod} requests were made.`], actions: ['Keep watching new requests.'] }; } },
        config,
    });
    const make = (svc) => new AdminReportSummaryController({
        collections: c,
        reportController: new AdminReportController(models, c),
        attentionController: new AdminAttentionController(models, c),
        aiReportSummaryService: svc,
        now: () => new Date('2026-10-02T10:00:00Z'),
    });
    await c.aiReportSummaries.deleteMany({});
    try {
        let res = fakeRes();
        await make(service).getSaved({ query: { days: '7' } }, res);
        logTest('AI summary endpoint: nothing saved yet -> summary null', res.statusCode === 200 && res.body.summary === null);

        res = fakeRes();
        await make(service).write({ body: { days: '7' }, decoded_email: 'Admin@Test.local', requestId: 'r' }, res);
        logTest('AI summary endpoint: writes a summary from the live report and attention counts',
            res.statusCode === 200 && res.body.summary.headline === 'A quiet week.' && res.body.summary.days === 7
            && Number.isFinite(seenFacts.requestsMade.thisPeriod) && seenFacts.needsAttentionNow !== undefined);

        const saved = fakeRes();
        await make(service).getSaved({ query: { days: '7' } }, saved);
        const row = await c.aiReportSummaries.findOne({ _id: 'days-7' });
        logTest('AI summary endpoint: the summary is kept per period, with who wrote it',
            saved.body.summary.headline === 'A quiet week.' && row.createdBy === 'admin@test.local' && row.facts.periodDays === 7);
        const other = fakeRes();
        await make(service).getSaved({ query: { days: '30' } }, other);
        logTest('AI summary endpoint: another period has its own (empty) summary', other.body.summary === null);

        res = fakeRes();
        await make(service).write({ body: { days: 14 } }, res);
        const res2 = fakeRes();
        await make(service).getSaved({ query: { days: 'x' } }, res2);
        logTest('AI summary endpoint: an unsupported period is refused', res.statusCode === 400 && res2.statusCode === 400);

        res = fakeRes();
        await make(createAiReportSummaryService({ provider: null, config })).write({ body: { days: 30 } }, res);
        logTest('AI summary endpoint: AI off -> 503 and nothing saved',
            res.statusCode === 503 && res.body.code === 'AI_HELPER_UNAVAILABLE' && !(await c.aiReportSummaries.findOne({ _id: 'days-30' })));

        logTest('AI summary config: has its own switch and a small daily budget',
            loadAiReportSummaryConfig({ GEMINI_API_KEY: 'k', AI_REPORT_SUMMARY_ENABLED: 'true' }).enabled === true
            && loadAiReportSummaryConfig({ GEMINI_API_KEY: 'k', AI_OFFER_HELPER_ENABLED: 'true' }).enabled === false
            && loadAiReportSummaryConfig({}).globalDailyLimit === 50);
    } finally {
        await c.aiReportSummaries.deleteMany({});
    }
}

module.exports = { runAiReportSummaryTests };
