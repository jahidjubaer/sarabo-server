const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyAdmin } = require('../middleware/auth');

// Admin reports (reports phase). Read-only, admins only.
function adminReportRoutes(app, controllers) {
    app.get('/admin/reports', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => controllers.adminReport.getReport(req, res));
}

module.exports = adminReportRoutes;
