const { verifyFBToken, verifyAdmin, verifyRider } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function riderRoutes(app, controllers) {
    const riderController = controllers.rider;

    // Get all technicians (admin only - includes full application detail
    // such as NID/address, needed for the technician-approval review view)
    app.get('/riders', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => riderController.getAllRiders(req, res));

    // Get job stats per day (technician only)
    app.get('/riders/delivery-per-day', verifyFBToken, ensureDatabaseReady, verifyRider, (req, res) => riderController.getDeliveryPerDay(req, res));

    // Create new technician application
    app.post('/riders', ensureDatabaseReady, (req, res) => riderController.createRider(req, res));

    // Update technician status (admin only)
    app.patch('/riders/:id', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => riderController.updateRiderStatus(req, res));

    // Replace a technician's expertise (self or admin only - see
    // controllers/riderController.js#updateTechnicianExpertise for the
    // authorization/existence-privacy rules). Deliberately not gated by
    // verifyAdmin/verifyRider at the route level, since a technician must be
    // able to update their own record - the controller enforces self-or-admin
    // itself. A distinct 3-segment path so Express can never structurally
    // confuse this with the 2-segment /riders/:id route above, matching the
    // same convention already used for /notifications/:id/read.
    app.patch('/riders/:id/expertise', verifyFBToken, ensureDatabaseReady, (req, res) => riderController.updateTechnicianExpertise(req, res));
}

module.exports = riderRoutes;
