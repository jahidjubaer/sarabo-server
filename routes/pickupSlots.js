const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyEmailVerified } = require('../middleware/auth');

// Pickup scheduling (pickup-scheduling phase). Availability is for signed-in
// users choosing a slot; rescheduling is owner-only, checked in the controller,
// and needs a verified email like request creation does.
function pickupSlotRoutes(app, controllers) {
    const controller = controllers.pickupSlot;
    app.get('/pickup-slots', verifyFBToken, ensureDatabaseReady, (req, res) => controller.listAvailability(req, res));
    app.patch('/repair-requests/:id/pickup-slot', verifyFBToken, ensureDatabaseReady, verifyEmailVerified, (req, res) => controller.reschedule(req, res));
}

module.exports = pickupSlotRoutes;
