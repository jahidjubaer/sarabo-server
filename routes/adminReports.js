const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyAdmin } = require('../middleware/auth');

// Admin reports (reports phase) and the "needs attention" list
// (overdue-alerts phase). Read-only, admins only.
function adminReportRoutes(app, controllers) {
    app.get('/admin/reports', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => controllers.adminReport.getReport(req, res));
    if (controllers.adminAttention) {
        app.get('/admin/attention', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => controllers.adminAttention.getAttention(req, res));
    }
}

module.exports = adminReportRoutes;
