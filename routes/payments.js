const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function paymentRoutes(app, controllers) {
    const paymentController = controllers.payment;

    // Create checkout session (Stripe only, no database access)
    app.post('/payment-checkout-session', (req, res) => paymentController.createCheckoutSession(req, res));

    // Handle payment success
    app.patch('/payment-success', ensureDatabaseReady, (req, res) => paymentController.handlePaymentSuccess(req, res));

    // Get payments
    app.get('/payments', verifyFBToken, ensureDatabaseReady, (req, res) => paymentController.getAllPayments(req, res));
}

module.exports = paymentRoutes;
