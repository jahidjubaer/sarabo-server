const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyEmailVerified } = require('../middleware/auth');

// Pickup scheduling (pickup-scheduling phase). Availability is for signed-in
// users choosing a slot; rescheduling is owner-only, checked in the controller,
// and needs a verified email like request creation does. The reminder job is
// protected by CRON_SECRET (email-updates phase).
function pickupSlotRoutes(app, controllers) {
    const controller = controllers.pickupSlot;
    app.get('/pickup-slots', verifyFBToken, ensureDatabaseReady, (req, res) => controller.listAvailability(req, res));
    app.patch('/repair-requests/:id/pickup-slot', verifyFBToken, ensureDatabaseReady, verifyEmailVerified, (req, res) => controller.reschedule(req, res));

    // Day-before reminders, called once a day by Vercel Cron (vercel.json).
    // No user token: the controller checks the CRON_SECRET bearer instead.
    if (controllers.pickupReminder) {
        app.get('/cron/pickup-reminders', ensureDatabaseReady, (req, res) => controllers.pickupReminder.sendReminders(req, res));
    }
}

module.exports = pickupSlotRoutes;
