const rateLimit = require('express-rate-limit');
const { ensureDatabaseReady } = require('../middleware/database');

// In-memory store - fine for a single local/MVP instance; a multi-instance
// deployment would need a shared store (e.g. Redis) for this limit to be
// enforced consistently across processes.
const publicTrackingLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many tracking requests. Please try again shortly.' }
});

// Deliberately its own route file, independent of the authenticated
// /trackings/:trackingId/logs endpoint in routes/trackings.js - no Firebase
// auth, no ownership check. A tracking code is a bearer-style lookup secret
// by design (see utils/trackingId.js), so possession of a valid code is the
// only access control here. Exact-match lookup only - no listing, search,
// pagination, or partial-code matching exists on this route.
function publicTrackingRoutes(app, controllers) {
    const trackingController = controllers.tracking;
    app.get(
        '/public/trackings/:trackingCode',
        publicTrackingLimiter,
        ensureDatabaseReady,
        (req, res) => trackingController.getPublicTracking(req, res)
    );
}

module.exports = publicTrackingRoutes;
