const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyAdmin, verifyTechnician } = require('../middleware/auth');

// Ways out of stuck repair states (controllers/workflowController.js). The
// controller checks the caller is the request's customer or technician.
function workflowRoutes(app, controllers) {
    const c = controllers.workflow;
    app.post('/repair-requests/:id/close-not-repairable', verifyFBToken, ensureDatabaseReady, (req, res) => c.closeNotRepairable(req, res));
    app.post('/repair-requests/:id/cancel-unpaid', verifyFBToken, ensureDatabaseReady, (req, res) => c.cancelUnpaid(req, res));
    app.post('/repair-requests/:id/receipt-dispute', verifyFBToken, ensureDatabaseReady, (req, res) => c.disputeReceipt(req, res));

    app.post('/repair-requests/:id/repair/cannot-complete', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => c.reportCannotComplete(req, res));
    app.post('/repair-requests/:id/mark-returned', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => c.markReturned(req, res));

    app.post('/admin/repair-requests/:id/cancel-paid-repair', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => c.adminCancelPaidRepair(req, res));
    app.post('/admin/repair-requests/:id/confirm-receipt', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => c.adminConfirmReceipt(req, res));
}

module.exports = workflowRoutes;
