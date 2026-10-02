const { AiHelperError } = require('../services/aiHelperCall');
const { buildSummaryFacts } = require('../services/aiReportSummaryService');
const { ALLOWED_DAYS } = require('./adminReportController');
const { logSafeError, getSafeLogPath, ERROR_CATEGORIES } = require('../utils/safeLogger');

const DEFAULT_DAYS = 7;

function readDays(value) {
    const days = value === undefined || value === null || value === '' ? DEFAULT_DAYS : Number(value);
    return ALLOWED_DAYS.includes(days) ? days : null;
}

// AI summary on the admin Reports page. The last summary per period is kept
// (ai_report_summaries, _id "days-<n>"), so opening the page costs no AI call;
// writing a new one replaces it.
class AdminReportSummaryController {
    constructor({ collections, reportController, attentionController, aiReportSummaryService, now = () => new Date() }) {
        this.collections = collections;
        this.reports = reportController;
        this.attention = attentionController;
        this.service = aiReportSummaryService;
        this.now = now;
    }

    // GET /admin/reports/ai-summary?days=7|30|90
    async getSaved(req, res) {
        const days = readDays(req.query && req.query.days);
        if (!days) return res.status(400).send({ message: `days must be one of ${ALLOWED_DAYS.join(', ')}`, code: 'INVALID_REPORT_RANGE' });
        try {
            const row = await this.collections.aiReportSummaries.findOne({ _id: `days-${days}` });
            res.send({ summary: row ? row.summary : null });
        } catch (error) {
            res.status(500).send({ message: 'Error loading the summary', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /admin/reports/ai-summary  { days }
    async write(req, res) {
        const startedAt = Date.now();
        const days = readDays(req.body && req.body.days);
        if (!days) return res.status(400).send({ message: `days must be one of ${ALLOWED_DAYS.join(', ')}`, code: 'INVALID_REPORT_RANGE' });
        try {
            const [report, attention] = await Promise.all([this.reports.buildReport(days), this.attention.buildAttention()]);
            const facts = buildSummaryFacts(report, attention.counts);
            const written = await this.service.writeSummary({ facts, requestId: req.requestId });
            const summary = { ...written, days, generatedAt: this.now() };
            await this.collections.aiReportSummaries.replaceOne(
                { _id: `days-${days}` },
                { summary, facts, createdBy: String(req.decoded_email || '').toLowerCase(), updatedAt: summary.generatedAt },
                { upsert: true }
            );
            res.send({ summary });
        } catch (error) {
            const status = error instanceof AiHelperError ? error.status : 500;
            logSafeError({ requestId: req.requestId, method: req.method, path: getSafeLogPath(req), status, category: ERROR_CATEGORIES.INTERNAL_ERROR, durationMs: Date.now() - startedAt });
            if (error instanceof AiHelperError) return res.status(error.status).send({ message: error.message, code: error.code });
            res.status(500).send({ message: 'The AI summary failed. Please try again.', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = AdminReportSummaryController;
