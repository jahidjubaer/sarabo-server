const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function paymentRoutes(app, controllers) {
    const paymentController = controllers.payment;

    // Create checkout session - requires auth and looks up the parcel to
    // verify ownership, payment eligibility, and the trusted stored amount
    app.post('/payment-checkout-session', verifyFBToken, ensureDatabaseReady, (req, res) => paymentController.createCheckoutSession(req, res));

    // Repair Request v2 approved-quote payments (Phase 6.4 Unit 6). Both are
    // parcel-scoped and owner-only; the server derives amount + currency
    // entirely from the persisted approved quote (BDT). The POST body is
    // ignored - the client never supplies an amount, currency, or status.
    app.get('/parcels/:id/payment-eligibility', verifyFBToken, ensureDatabaseReady, (req, res) => paymentController.checkV2PaymentEligibility(req, res));
    app.post('/parcels/:id/checkout-session', verifyFBToken, ensureDatabaseReady, (req, res) => paymentController.createV2CheckoutSession(req, res));

    // Handle payment success - requires auth; the caller's sessionId is
    // verified server-side against Stripe and MongoDB, never trusted alone
    app.patch('/payment-success', verifyFBToken, ensureDatabaseReady, (req, res) => paymentController.handlePaymentSuccess(req, res));

    // Get payments
    app.get('/payments', verifyFBToken, ensureDatabaseReady, (req, res) => paymentController.getAllPayments(req, res));
}

module.exports = paymentRoutes;
