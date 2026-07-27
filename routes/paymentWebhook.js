const express = require('express');

// Stripe signature verification requires the exact raw request bytes, so this
// route must be registered before the app's global express.json() middleware
// in index.js - once JSON body-parsing has consumed the request stream, the
// original bytes are gone and no signature could ever be recomputed. This
// route never uses Firebase auth: Stripe proves authenticity via the signed
// payload itself, not a bearer token.
function registerPaymentWebhookRoute(app, controllers) {
    const paymentController = controllers.payment;
    app.post(
        '/stripe-webhook',
        express.raw({ type: 'application/json' }),
        (req, res) => paymentController.handleStripeWebhook(req, res)
    );
}

module.exports = { registerPaymentWebhookRoute };
