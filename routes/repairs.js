const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

// V2 repair progress + completion (Phase 6.4 Unit 7). Every route requires
// authentication and re-derives identity/role from the DB. The four write
// endpoints are technician-only (enforced in the controller); the read endpoint
// additionally admits the owner and admins. The generic PATCH /parcels/:id/status
// can never reach repair_in_progress / repair_completed - only these endpoints
// own those transitions.
function repairRoutes(app, controllers) {
    const repairController = controllers.repair;

    app.post('/parcels/:id/repair/start', verifyFBToken, ensureDatabaseReady, (req, res) => repairController.startRepair(req, res));
    app.post('/parcels/:id/repair/progress', verifyFBToken, ensureDatabaseReady, (req, res) => repairController.addProgress(req, res));
    app.post('/parcels/:id/repair/evidence', verifyFBToken, ensureDatabaseReady, (req, res) => repairController.createEvidenceUploadSession(req, res));
    app.post('/parcels/:id/repair/complete', verifyFBToken, ensureDatabaseReady, (req, res) => repairController.completeRepair(req, res));
    app.get('/parcels/:id/repair', verifyFBToken, ensureDatabaseReady, (req, res) => repairController.getRepair(req, res));
}

module.exports = repairRoutes;
