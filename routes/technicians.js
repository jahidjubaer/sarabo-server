const { verifyFBToken, verifyAdmin, verifyTechnician } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function technicianRoutes(app, controllers) {
    const riderController = controllers.technician;

    // Get all technicians (admin only - includes full application detail
    // such as NID/address, needed for the technician-approval review view)
    app.get('/technicians', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => riderController.getTechnicians(req, res));

    // Get job stats per day (technician only)
    app.get('/technicians/delivery-per-day', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => riderController.getDeliveryPerDay(req, res));

    // Create new technician application
    app.post('/technicians', ensureDatabaseReady, (req, res) => riderController.createTechnicianApplication(req, res));

    // Update technician status (admin only)
    app.patch('/technicians/:id', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => riderController.updateTechnicianStatus(req, res));

    // Replace a technician's expertise (self or admin only - see
    // controllers/technicianController.js#updateTechnicianExpertise for the
    // authorization/existence-privacy rules). Deliberately not gated by
    // verifyAdmin/verifyTechnician at the route level, since a technician must be
    // able to update their own record - the controller enforces self-or-admin
    // itself. A distinct 3-segment path so Express can never structurally
    // confuse this with the 2-segment /technicians/:id route above, matching the
    // same convention already used for /notifications/:id/read.
    app.patch('/technicians/:id/expertise', verifyFBToken, ensureDatabaseReady, (req, res) => riderController.updateTechnicianExpertise(req, res));
}

module.exports = technicianRoutes;
