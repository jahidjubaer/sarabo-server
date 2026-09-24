const crypto = require('crypto');
const { SLOT_HOLDING_STATUSES, dhakaDateString } = require('../utils/pickupSlots');

const DAY_MS = 24 * 60 * 60 * 1000;
// Gmail's free limit is about 500 a day; one run never sends more than this.
const MAX_REMINDERS_PER_RUN = 200;

// Constant-time comparison, so the secret cannot be guessed by timing.
function secretMatches(provided, expected) {
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Day-before pickup reminders (email-updates phase). Vercel Cron calls
// GET /cron/pickup-reminders once a day (vercel.json, 12:00 UTC = 18:00 in
// Dhaka) with "Authorization: Bearer <CRON_SECRET>". Without CRON_SECRET set,
// the route refuses every call. Safe to run more than once: the email log
// allows one reminder per request per pickup slot.
class PickupReminderController {
    constructor(models, collections, { emailService, now = () => new Date(), env = process.env } = {}) {
        this.collections = collections;
        this.emailService = emailService;
        this.now = now;
        this.env = env;
    }

    async sendReminders(req, res) {
        const secret = this.env.CRON_SECRET;
        if (!secret) {
            return res.status(503).send({ message: 'reminders are not configured', code: 'CRON_NOT_CONFIGURED' });
        }
        const header = req.headers && req.headers.authorization;
        const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!secretMatches(provided, secret)) {
            return res.status(401).send({ message: 'unauthorized', code: 'UNAUTHORIZED' });
        }

        try {
            if (!this.emailService.enabled) {
                return res.send({ date: null, found: 0, sent: 0, skipped: 0, failed: 0, emailEnabled: false });
            }
            const tomorrow = dhakaDateString(new Date(this.now().getTime() + DAY_MS));
            const requests = await this.collections.repairRequests.find(
                { 'pickupSlot.date': tomorrow, deliveryStatus: { $in: SLOT_HOLDING_STATUSES } },
                { projection: { senderEmail: 1, trackingId: 1, product: 1, serviceLocation: 1, pickupSlot: 1 } }
            ).sort({ 'pickupSlot.startsAt': 1 }).limit(MAX_REMINDERS_PER_RUN).toArray();

            const counts = { sent: 0, skipped: 0, failed: 0 };
            // One at a time: gentle on Gmail's rate limits.
            for (const request of requests) {
                const { status } = await this.emailService.sendPickupReminder(request, request._id.toString());
                if (status === 'sent') counts.sent += 1;
                else if (status === 'failed') counts.failed += 1;
                else counts.skipped += 1;
            }
            res.send({ date: tomorrow, found: requests.length, ...counts, emailEnabled: true });
        } catch (error) {
            res.status(500).send({ message: 'Error sending reminders', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = PickupReminderController;
module.exports.MAX_REMINDERS_PER_RUN = MAX_REMINDERS_PER_RUN;
