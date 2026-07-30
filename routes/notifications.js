const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

// Every route here requires only verifyFBToken (any authenticated role) -
// never verifyAdmin/verifyRider. There is no public creation route, no
// DELETE, no PUT, and no GET /notifications/:id detail route in V1.
//
// Route-shape note: /notifications/read-all (2 path segments) and
// /notifications/:id/read (3 path segments) were deliberately given
// different segment counts, so Express cannot structurally match one
// pattern against the other's URL shape regardless of registration order -
// unlike the historical /parcels/rider vs /parcels/:id collision (both 2
// segments) that routes/parcels.js's own ordering comment guards against.
// Specific-path routes are still registered before the generic :id-shaped
// route below, matching that same defensive convention.
function notificationRoutes(app, controllers) {
    const notificationController = controllers.notification;

    // List the authenticated user's own notifications, paginated.
    app.get('/notifications', verifyFBToken, ensureDatabaseReady, (req, res) => notificationController.listNotifications(req, res));

    // Authenticated user's own unread count only.
    app.get('/notifications/unread-count', verifyFBToken, ensureDatabaseReady, (req, res) => notificationController.getUnreadCount(req, res));

    // Mark every unread notification owned by the authenticated user as read.
    app.patch('/notifications/read-all', verifyFBToken, ensureDatabaseReady, (req, res) => notificationController.markAllRead(req, res));

    // Mark one owned notification as read.
    app.patch('/notifications/:id/read', verifyFBToken, ensureDatabaseReady, (req, res) => notificationController.markOneRead(req, res));
}

module.exports = notificationRoutes;
