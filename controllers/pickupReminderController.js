const crypto = require('crypto');
const { SLOT_HOLDING_STATUSES, dhakaDateString } = require('../utils/pickupSlots');
const { formatPickupForEmail } = require('../utils/emailTemplates');
const { createNotificationService } = require('../services/notificationService');
const { closeStaleDeclinedRequests } = require('../services/declinedQuoteClose');
const { closeUnpaidApprovedQuotes } = require('../services/requestClosure');
const { client } = require('../config/database');

const DAY_MS = 24 * 60 * 60 * 1000;
// Gmail's free limit is about 500 a day; one run never sends more than this.
const MAX_REMINDERS_PER_RUN = 200;

// Constant-time comparison, so the secret cannot be guessed by timing.
function secretMatches(provided, expected) {
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Day-before pickup reminders. Always posts an in-app notification to the
// customer and the assigned technician (in-app-reminders phase); also emails
// the customer when email is enabled (email-updates phase). Vercel Cron calls
// GET /cron/pickup-reminders once a day (vercel.json, 12:00 UTC = 18:00 in
// Dhaka) with "Authorization: Bearer <CRON_SECRET>". Without CRON_SECRET set,
// the route refuses every call. Safe to run more than once: the email log
// allows one reminder per request per pickup slot.
class PickupReminderController {
    constructor(models, collections, { emailService, now = () => new Date(), env = process.env, mongoClient = client, workflow = null, warranty = null, expireCheckout = null } = {}) {
        this.models = models;
        this.collections = collections;
        // The workflow and warranty jobs below (created on first use; tests inject them).
        this.workflow = workflow;
        this.warranty = warranty;
        this.expireCheckout = expireCheckout;
        this.mongoClient = mongoClient;
        this.emailService = emailService;
        this.notifications = createNotificationService(models);
        this.User = models.User;
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
            const tomorrow = dhakaDateString(new Date(this.now().getTime() + DAY_MS));
            const requests = await this.collections.repairRequests.find(
                { 'pickupSlot.date': tomorrow, deliveryStatus: { $in: SLOT_HOLDING_STATUSES } },
                { projection: { senderEmail: 1, trackingId: 1, product: 1, serviceLocation: 1, pickupSlot: 1, technicianEmail: 1 } }
            ).sort({ 'pickupSlot.startsAt': 1 }).limit(MAX_REMINDERS_PER_RUN).toArray();

            const inApp = await this.remindInApp(requests);
            const email = { sent: 0, skipped: 0, failed: 0 };
            if (this.emailService.enabled) {
                // One at a time: gentle on Gmail's rate limits.
                for (const request of requests) {
                    const { status } = await this.emailService.sendPickupReminder(request, request._id.toString());
                    if (status === 'sent') email.sent += 1;
                    else if (status === 'failed') email.failed += 1;
                    else email.skipped += 1;
                }
            }
            // Same daily run (Vercel's free plan allows daily cron jobs):
            // declined quotes nobody acted on for 3 days are closed.
            let declinedClosed;
            try {
                declinedClosed = await closeStaleDeclinedRequests({
                    collections: this.collections, notifications: this.notifications, User: this.User, mongoClient: this.mongoClient, now: this.now(),
                });
            } catch (error) {
                console.error('Closing stale declined quotes failed:', error.message);
                declinedClosed = { error: true };
            }
            const { unpaidClosed, receiptsConfirmed, warrantyOverdue, stalled } = await this.runWorkflowJobs();
            res.send({ date: tomorrow, found: requests.length, inApp, ...email, emailEnabled: this.emailService.enabled, declinedClosed, unpaidClosed, receiptsConfirmed, warrantyOverdue, stalled });
        } catch (error) {
            res.status(500).send({ message: 'Error sending reminders', code: 'INTERNAL_ERROR' });
        }
    }

    // Workflow review fixes, in the same daily run: approved quotes unpaid for
    // 3 days are closed, receipts the technician marked returned 3 days ago
    // are confirmed, and admins hear about late warranty steps. Each job is
    // independent - one failing never stops the others.
    async runWorkflowJobs() {
        if (!this.workflow) this.workflow = new (require('./workflowController'))(this.models, this.collections, { now: this.now, mongoClient: this.mongoClient });
        if (!this.warranty) this.warranty = new (require('./warrantyController'))(this.models, this.collections, { now: this.now, mongoClient: this.mongoClient });
        const expireCheckout = this.expireCheckout || ((sessionId) => require('stripe')(this.env.STRIPE_SECRET).checkout.sessions.expire(sessionId));
        const attempt = async (label, job) => {
            try {
                return await job();
            } catch (error) {
                console.error(`${label} failed (will retry tomorrow):`, error.message);
                return { error: true };
            }
        };
        return {
            unpaidClosed: await attempt('Closing unpaid approved quotes', () => closeUnpaidApprovedQuotes({
                collections: this.collections, notifications: this.notifications, User: this.User, mongoClient: this.mongoClient, now: this.now(), expireCheckout,
            })),
            receiptsConfirmed: await attempt('Auto-confirming receipts', () => this.workflow.autoConfirmReceipts()),
            warrantyOverdue: await attempt('Warranty overdue alerts', () => this.warranty.alertOverdueClaims()),
            stalled: await attempt('Stalled work alerts', () => this.workflow.alertStalled()),
        };
    }

    // In-app reminders for the customer and, when one is assigned, the technician.
    // Duplicates (same request and slot) are skipped by the notification layer, so
    // running the job twice is harmless. A failure for one request never stops
    // the others.
    async remindInApp(requests) {
        const counts = { sent: 0, skipped: 0, failed: 0 };
        const tally = (result) => {
            if (result && result.created) counts.sent += 1;
            else counts.skipped += 1;
        };
        for (const request of requests) {
            const id = request._id.toString();
            const metadata = {
                trackingId: request.trackingId,
                pickupWindow: formatPickupForEmail(request.pickupSlot),
                occurrence: `${request.pickupSlot.date}|${request.pickupSlot.slotId}`,
            };
            try {
                const ownerRole = await this.User.findRoleByEmail(request.senderEmail);
                if (ownerRole) {
                    tally(await this.notifications.createNotification({
                        recipientEmail: request.senderEmail, recipientRole: ownerRole, type: 'pickup_reminder',
                        entityType: 'repair_request', entityId: id, metadata,
                    }));
                } else {
                    counts.skipped += 1;
                }
                if (request.technicianEmail) {
                    tally(await this.notifications.createNotification({
                        recipientEmail: request.technicianEmail, recipientRole: 'rider', type: 'pickup_reminder_technician',
                        entityType: 'repair_request', entityId: id, metadata,
                    }));
                }
            } catch (error) {
                counts.failed += 1;
                console.error('In-app pickup reminder failed (non-fatal):', error.message);
            }
        }
        return counts;
    }
}

module.exports = PickupReminderController;
module.exports.MAX_REMINDERS_PER_RUN = MAX_REMINDERS_PER_RUN;
