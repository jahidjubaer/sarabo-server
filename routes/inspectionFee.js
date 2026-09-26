const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyAdmin, verifyEmailVerified } = require('../middleware/auth');

// Inspection-fee money outcomes (job-portal phase D). The customer routes
// check ownership in the controller; cancelling needs a verified email like
// choosing the technician did.
function inspectionFeeRoutes(app, controllers) {
    const c = controllers.inspectionFee;
    app.get('/repair-requests/:id/booking-cancellation', verifyFBToken, ensureDatabaseReady, (req, res) => c.preview(req, res));
    app.post('/repair-requests/:id/cancel-booking', verifyFBToken, ensureDatabaseReady, verifyEmailVerified, (req, res) => c.cancelBooking(req, res));
    app.post('/admin/repair-requests/:id/inspection-fee/retry-refund', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => c.retryRefund(req, res));
}

module.exports = inspectionFeeRoutes;
