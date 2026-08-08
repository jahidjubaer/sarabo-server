const { verifyFBToken, verifyAdmin, verifyRider, verifyEmailVerified } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function parcelRoutes(app, controllers) {
    const parcelController = controllers.parcel;

    // Get all repair requests
    app.get('/parcels', verifyFBToken, ensureDatabaseReady, (req, res) => parcelController.getAllParcels(req, res));

    // Get repair requests for technician
    app.get('/parcels/rider', verifyFBToken, ensureDatabaseReady, verifyRider, (req, res) => parcelController.getRiderParcels(req, res));

    // Get repair request by ID
    app.get('/parcels/:id', verifyFBToken, ensureDatabaseReady, (req, res) => parcelController.getParcelById(req, res));

    // Get repair status stats (admin only)
    app.get('/parcels/delivery-status/stats', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => parcelController.getDeliveryStatusStats(req, res));

    // Admin-only, read-only eligible-technician recommendations (Phase 6.3
    // Unit 5) - v2 requests only, no mutation. A distinct 3-segment path so
    // Express can never structurally confuse this with the 2-segment
    // /parcels/:id route below, matching the same convention already used
    // for /notifications/:id/read and /riders/:id/expertise.
    app.get('/parcels/:id/eligible-technicians', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => parcelController.getEligibleTechnicians(req, res));

    // Admin request-management list - paginated/searchable/filterable,
    // deliberately separate from GET /parcels above (whose flat-array
    // response shape is already relied on by MyRequests and
    // AssignTechnicians and is not changed by this route).
    app.get('/admin/parcels', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => parcelController.getAdminParcels(req, res));

    // Create new repair request. Customer-exclusive business mutation - gated
    // by verifyEmailVerified (Phase 8.1) so an unverified email/password user
    // cannot create a request; server token is authoritative (client guard is
    // UX only). verifyEmailVerified runs after verifyFBToken and before the
    // controller.
    app.post('/parcels', verifyFBToken, ensureDatabaseReady, verifyEmailVerified, (req, res) => parcelController.createParcel(req, res));

    // Update repair request status
    app.patch('/parcels/:id/status', verifyFBToken, ensureDatabaseReady, (req, res) => parcelController.updateParcelStatus(req, res));

    // Customer-initiated soft cancellation - ownership is enforced inside
    // the controller (never delegated to route middleware alone), so any
    // authenticated caller may reach this route but only the request's own
    // owner can actually cancel it.
    app.patch('/parcels/:id/cancel', verifyFBToken, ensureDatabaseReady, (req, res) => parcelController.cancelParcel(req, res));

    // Assign technician to repair request (admin only)
    app.patch('/parcels/:id', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => parcelController.assignRiderToParcel(req, res));

    // Safe deletion of a repair request (Phase 6.5 Unit 8). Ownership/role is
    // enforced inside the controller - the request's own owner OR an admin may
    // delete, but only while the request is still at its first lifecycle stage
    // (pending-pickup, unassigned, uninspected, unquoted, unpaid, no repair).
    // Deliberately NOT gated by verifyAdmin at the route level (unlike before):
    // a customer must be able to delete their own not-yet-started request, and
    // the controller is the single authority that decides who and when, the
    // same convention already used for cancelParcel above.
    app.delete('/parcels/:id', verifyFBToken, ensureDatabaseReady, (req, res) => parcelController.deleteParcel(req, res));
}

module.exports = parcelRoutes;
