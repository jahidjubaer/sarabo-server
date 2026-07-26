const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function paymentRoutes(app, controllers) {
    const paymentController = controllers.payment;

    // Create checkout session - requires auth and looks up the parcel to
    // verify ownership, payment eligibility, and the trusted stored amount
    app.post('/payment-checkout-session', verifyFBToken, ensureDatabaseReady, (req, res) => paymentController.createCheckoutSession(req, res));

    // Handle payment success
    app.patch('/payment-success', ensureDatabaseReady, (req, res) => paymentController.handlePaymentSuccess(req, res));

    // Get payments
    app.get('/payments', verifyFBToken, ensureDatabaseReady, (req, res) => paymentController.getAllPayments(req, res));
}

module.exports = paymentRoutes;
