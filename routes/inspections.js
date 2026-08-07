const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

// Technician inspection routes (Phase 6.4 Unit 4). Deliberately only
// verifyFBToken + ensureDatabaseReady at the route level - the assigned-
// technician / owner / admin authorization and (for submit) the atomic
// assignment+lifecycle+role revalidation all happen inside the controller,
// inside the write transaction, never delegated to generic role middleware
// that cannot re-check assignment at commit time. Three-segment paths so
// Express never structurally confuses them with GET/PATCH /parcels/:id.
function inspectionRoutes(app, controllers) {
    const inspectionController = controllers.inspection;

    app.post('/parcels/:id/inspection', verifyFBToken, ensureDatabaseReady, (req, res) => inspectionController.submitInspection(req, res));
    app.get('/parcels/:id/inspection', verifyFBToken, ensureDatabaseReady, (req, res) => inspectionController.getInspection(req, res));
}

module.exports = inspectionRoutes;
