const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyAdmin } = require('../middleware/auth');
const { createSupportRateLimit } = require('../middleware/supportRateLimit');
const { loadAiReportSummaryConfig } = require('../config/aiRequestHelper');

// The shared AI rate limiter keys signed-in callers by req.supportAuth.uid.
function markSignedIn(req, res, next) {
    req.supportAuth = Object.freeze({ authenticated: true, uid: String(req.decoded_email || '').toLowerCase() });
    next();
}
let summaryRateLimit;
function summaryLimit(req, res, next) {
    if (!summaryRateLimit) summaryRateLimit = createSupportRateLimit(loadAiReportSummaryConfig(), { keyPrefix: 'report-summary', label: 'AI summary' });
    return summaryRateLimit(req, res, next);
}

// Admin reports (reports phase) and the "needs attention" list
// (overdue-alerts phase). Read-only, admins only.
function adminReportRoutes(app, controllers) {
    app.get('/admin/reports', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => controllers.adminReport.getReport(req, res));
    if (controllers.adminReportSummary) {
        const s = controllers.adminReportSummary;
        app.get('/admin/reports/ai-summary', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => s.getSaved(req, res));
        app.post('/admin/reports/ai-summary', verifyFBToken, ensureDatabaseReady, verifyAdmin, markSignedIn, summaryLimit, (req, res) => s.write(req, res));
    }
    if (controllers.adminAttention) {
        app.get('/admin/attention', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => controllers.adminAttention.getAttention(req, res));
    }
}

module.exports = adminReportRoutes;
