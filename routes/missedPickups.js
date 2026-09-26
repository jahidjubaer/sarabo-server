const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyAdmin } = require('../middleware/auth');

// Admin actions on a missed pickup (missed-pickup phase). Admins only.
function missedPickupRoutes(app, controllers) {
    const controller = controllers.missedPickup;
    app.post('/admin/repair-requests/:id/missed-pickup/withdraw', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => controller.withdraw(req, res));
    app.post('/admin/repair-requests/:id/missed-pickup/ask-new-time', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => controller.askNewTime(req, res));
}

module.exports = missedPickupRoutes;
