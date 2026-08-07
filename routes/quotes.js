const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

// Repair-quote routes (Phase 6.4 Unit 5). Route-level auth is only
// verifyFBToken + ensureDatabaseReady; the assigned-technician / owner / admin
// authorization and the atomic assignment+lifecycle+role revalidation all
// happen inside the controller transaction. Three-/four-segment paths so
// Express never structurally confuses them with GET/PATCH /parcels/:id.
function quoteRoutes(app, controllers) {
    const quoteController = controllers.quote;

    app.post('/parcels/:id/quote', verifyFBToken, ensureDatabaseReady, (req, res) => quoteController.submitQuote(req, res));
    app.post('/parcels/:id/quote/decision', verifyFBToken, ensureDatabaseReady, (req, res) => quoteController.decideQuote(req, res));
    app.get('/parcels/:id/quote', verifyFBToken, ensureDatabaseReady, (req, res) => quoteController.getQuote(req, res));
}

module.exports = quoteRoutes;
