const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

// Damage-evidence upload routes (Phase 6.4 Unit 1). Deliberately a separate
// route module from routes/parcels.js (mounted independently below, not
// touching that file) even though every path nests under /parcels/:id.
// No verifyAdmin/verifyRider here - ownership is enforced inside
// controllers/damageUploadController.js, exactly like the existing
// /parcels/:id/cancel route already does for the same reason.
function damageUploadRoutes(app, controllers) {
    const damageUploadController = controllers.damageUpload;

    // Authorized read access (Phase 6.4 Unit 2) - admits owner, admin, and
    // the currently-assigned technician; every role is resolved live inside
    // the controller/service (see services/damageImageAccessService.js),
    // never via a single-role route gate like verifyAdmin/verifyRider,
    // since this one route must serve three different roles.
    app.get(
        '/parcels/:id/damage-images',
        verifyFBToken, ensureDatabaseReady,
        (req, res) => damageUploadController.listImages(req, res)
    );

    app.post(
        '/parcels/:id/damage-images/upload-session',
        verifyFBToken, ensureDatabaseReady,
        (req, res) => damageUploadController.createUploadSession(req, res)
    );

    app.post(
        '/parcels/:id/damage-images/finalize',
        verifyFBToken, ensureDatabaseReady,
        (req, res) => damageUploadController.finalizeUpload(req, res)
    );

    app.delete(
        '/parcels/:id/damage-images/:imageId',
        verifyFBToken, ensureDatabaseReady,
        (req, res) => damageUploadController.removeImage(req, res)
    );
}

module.exports = damageUploadRoutes;
