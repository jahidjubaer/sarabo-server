const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyAdmin, verifyTechnician, verifyEmailVerified } = require('../middleware/auth');

// Repair warranty and returns (controllers/warrantyController.js). Customer
// routes check ownership in the controller; opening a claim needs a verified
// email like creating a request does. Technician routes need the technician
// role and the claim's own technician.
function warrantyRoutes(app, controllers) {
    const c = controllers.warranty;
    app.get('/repair-requests/:id/warranty', verifyFBToken, ensureDatabaseReady, (req, res) => c.getForRequest(req, res));
    app.post('/repair-requests/:id/warranty/photos', verifyFBToken, ensureDatabaseReady, verifyEmailVerified, (req, res) => c.createPhotoUpload(req, res));
    app.post('/repair-requests/:id/warranty-claims', verifyFBToken, ensureDatabaseReady, verifyEmailVerified, (req, res) => c.openClaim(req, res));
    app.post('/warranty-claims/:claimId/confirm', verifyFBToken, ensureDatabaseReady, (req, res) => c.confirmFix(req, res));
    app.post('/warranty-claims/:claimId/review-request', verifyFBToken, ensureDatabaseReady, (req, res) => c.requestReview(req, res));

    app.get('/technician/warranty-claims', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => c.listForTechnician(req, res));
    app.post('/warranty-claims/:claimId/schedule', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => c.schedule(req, res));
    app.post('/warranty-claims/:claimId/decision', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => c.decide(req, res));
    app.post('/warranty-claims/:claimId/rerepair', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => c.reportRerepair(req, res));

    app.get('/admin/warranty-claims', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => c.listForAdmin(req, res));
    app.post('/admin/warranty-claims/:claimId/review', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => c.adminReview(req, res));
    app.post('/admin/warranty-claims/:claimId/refund', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => c.adminRefund(req, res));
}

module.exports = warrantyRoutes;
