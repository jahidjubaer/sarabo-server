const { verifyFBToken, verifyEmailVerified } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

// Damage-evidence upload routes (Phase 6.4 Unit 1). Deliberately a separate
// route module from routes/repairRequests.js (mounted independently below, not
// touching that file) even though every path nests under /repair-requests/:id.
// No verifyAdmin/verifyTechnician here - ownership is enforced inside
// controllers/damageUploadController.js, exactly like the existing
// /repair-requests/:id/cancel route already does for the same reason.
function damageUploadRoutes(app, controllers) {
    const damageUploadController = controllers.damageUpload;

    // Authorized read access (Phase 6.4 Unit 2) - admits owner, admin, and
    // the currently-assigned technician; every role is resolved live inside
    // the controller/service (see services/damageImageAccessService.js),
    // never via a single-role route gate like verifyAdmin/verifyTechnician,
    // since this one route must serve three different roles.
    app.get(
        '/repair-requests/:id/damage-images',
        verifyFBToken, ensureDatabaseReady,
        (req, res) => damageUploadController.listImages(req, res)
    );

    // Damage-image upload/finalize/remove are owner-only customer mutations
    // (ownership enforced inside the controller). Gated by verifyEmailVerified
    // (Phase 8.1) so an unverified email/password user cannot upload, finalize,
    // or delete evidence. The read (GET listImages) above serves owner/admin/
    // assigned-technician and is intentionally NOT gated.
    app.post(
        '/repair-requests/:id/damage-images/upload-session',
        verifyFBToken, ensureDatabaseReady, verifyEmailVerified,
        (req, res) => damageUploadController.createUploadSession(req, res)
    );

    app.post(
        '/repair-requests/:id/damage-images/finalize',
        verifyFBToken, ensureDatabaseReady, verifyEmailVerified,
        (req, res) => damageUploadController.finalizeUpload(req, res)
    );

    app.delete(
        '/repair-requests/:id/damage-images/:imageId',
        verifyFBToken, ensureDatabaseReady, verifyEmailVerified,
        (req, res) => damageUploadController.removeImage(req, res)
    );
}

module.exports = damageUploadRoutes;
