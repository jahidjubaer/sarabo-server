const { verifyFBToken, verifyEmailVerified } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

// Repair-quote routes (Phase 6.4 Unit 5). Route-level auth is only
// verifyFBToken + ensureDatabaseReady; the assigned-technician / owner / admin
// authorization and the atomic assignment+lifecycle+role revalidation all
// happen inside the controller transaction. Three-/four-segment paths so
// Express never structurally confuses them with GET/PATCH /repair-requests/:id.
function quoteRoutes(app, controllers) {
    const quoteController = controllers.quote;

    app.post('/repair-requests/:id/quote', verifyFBToken, ensureDatabaseReady, (req, res) => quoteController.submitQuote(req, res));
    // Customer-exclusive quote decision (approve/decline) - gated by
    // verifyEmailVerified (Phase 8.1). Quote submission above stays technician-
    // side and is intentionally NOT gated here. The controller still enforces
    // owner authority + quote/payment state.
    app.post('/repair-requests/:id/quote/decision', verifyFBToken, ensureDatabaseReady, verifyEmailVerified, (req, res) => quoteController.decideQuote(req, res));
    app.get('/repair-requests/:id/quote', verifyFBToken, ensureDatabaseReady, (req, res) => quoteController.getQuote(req, res));

    // Post-rejection technician actions (Phase 9.2). Both are technician-side,
    // so like quote submission above they are deliberately NOT gated by
    // verifyEmailVerified (that gate exists for customer-exclusive business
    // mutations). The controller enforces assigned-technician identity, v2,
    // not-already-paid, and quote_rejected state - route middleware never
    // carries that authority here, matching this file's existing convention.
    app.post('/repair-requests/:id/quote/revise', verifyFBToken, ensureDatabaseReady, (req, res) => quoteController.reviseQuote(req, res));
    app.post('/repair-requests/:id/quote/cancel-request', verifyFBToken, ensureDatabaseReady, (req, res) => quoteController.cancelAfterQuoteRejection(req, res));
}

module.exports = quoteRoutes;
