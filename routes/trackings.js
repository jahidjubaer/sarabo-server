const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function trackingRoutes(app, controllers) {
    const trackingController = controllers.tracking;

    // Get tracking logs by tracking ID
    app.get('/trackings/:trackingId/logs', verifyFBToken, ensureDatabaseReady, (req, res) => trackingController.getTrackingLogs(req, res));
}

module.exports = trackingRoutes;
