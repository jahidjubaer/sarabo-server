const { verifyFBToken, verifyEmailVerified, verifyAdmin, verifyTechnician } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function feedbackRoutes(app, controllers) {
    const controller = controllers.feedback;
    const base = [verifyFBToken, ensureDatabaseReady];
    app.get('/repair-requests/:id/feedback', ...base, (req, res) => controller.summary(req, res));
    app.post('/repair-requests/:id/review', ...base, verifyEmailVerified, (req, res) => controller.createReview(req, res));
    app.post('/repair-requests/:id/technician-reports', ...base, (req, res) => controller.createReport(req, res));
    app.get('/technicians/me/reviews', ...base, verifyTechnician, (req, res) => controller.technicianReviews(req, res));
    app.get('/admin/technician-reviews', ...base, verifyAdmin, (req, res) => controller.listReviews(req, res));
    app.patch('/admin/technician-reviews/:id/visibility', ...base, verifyAdmin, (req, res) => controller.visibility(req, res));
    app.get('/admin/technician-reports', ...base, verifyAdmin, (req, res) => controller.listReports(req, res));
    app.get('/admin/technician-reports/:id', ...base, verifyAdmin, (req, res) => controller.reportDetail(req, res));
    app.patch('/admin/technician-reports/:id/status', ...base, verifyAdmin, (req, res) => controller.status(req, res));
    app.post('/admin/technician-reports/:id/notes', ...base, verifyAdmin, (req, res) => controller.note(req, res));
}

module.exports = feedbackRoutes;
