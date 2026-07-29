const { verifyFBToken, verifyAdmin, verifyRider } = require('../middleware/auth');
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

    // Admin request-management list - paginated/searchable/filterable,
    // deliberately separate from GET /parcels above (whose flat-array
    // response shape is already relied on by MyRequests and
    // AssignTechnicians and is not changed by this route).
    app.get('/admin/parcels', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => parcelController.getAdminParcels(req, res));

    // Create new repair request
    app.post('/parcels', verifyFBToken, ensureDatabaseReady, (req, res) => parcelController.createParcel(req, res));

    // Update repair request status
    app.patch('/parcels/:id/status', verifyFBToken, ensureDatabaseReady, (req, res) => parcelController.updateParcelStatus(req, res));

    // Customer-initiated soft cancellation - ownership is enforced inside
    // the controller (never delegated to route middleware alone), so any
    // authenticated caller may reach this route but only the request's own
    // owner can actually cancel it.
    app.patch('/parcels/:id/cancel', verifyFBToken, ensureDatabaseReady, (req, res) => parcelController.cancelParcel(req, res));

    // Assign technician to repair request (admin only)
    app.patch('/parcels/:id', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => parcelController.assignRiderToParcel(req, res));

    // Delete repair request (admin only)
    app.delete('/parcels/:id', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => parcelController.deleteParcel(req, res));
}

module.exports = parcelRoutes;
