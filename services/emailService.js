// Transactional email (email-updates phase). Three emails: request received
// (and pickup changed), pickup reminder the day before, and a new job offer
// to the technician.
//
// Rules:
// - Never throws. An email is a courtesy on top of an action that already
//   succeeded, so every failure is recorded and logged, never raised.
// - Each email has a key and is recorded in `email_log` BEFORE it is sent;
//   the unique _id means a retried request or a second cron run can never
//   send the same email twice. Records expire after 90 days (TTL index).
// - Disabled (a no-op) unless EMAIL_ENABLED=true and the Gmail credentials
//   are set - see config/email.js.
const templates = require('../utils/emailTemplates');

const LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('email send timed out'), { code: 'EMAIL_TIMEOUT' })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A short, secret-free reason for the log (never the SMTP transcript).
function describeError(error) {
    if (!error) return 'unknown error';
    return String(error.code || error.responseCode || error.message || 'unknown error').slice(0, 200);
}

function createEmailService({ config, collections, transportFactory, now = () => new Date(), logger = console }) {
    let transport = null;
    let warned = false;

    const getTransport = () => {
        if (!transport) {
            const factory = transportFactory || (() => require('nodemailer').createTransport({
                service: 'gmail',
                auth: { user: config.user, pass: config.appPassword },
            }));
            transport = factory(config);
        }
        return transport;
    };

    const requestUrl = (requestId) => (config.siteOrigin ? `${config.siteOrigin}/dashboard/my-requests/${requestId}` : null);
    const jobsUrl = () => (config.siteOrigin ? `${config.siteOrigin}/dashboard/assigned-jobs` : null);

    // Returns { status: 'sent' | 'failed' | 'duplicate' | 'disabled' | 'skipped' }.
    async function send({ key, to, message, kind }) {
        if (!config.enabled) {
            if (config.requestedButIncomplete && !warned) {
                warned = true;
                logger.error(`Email is enabled but not configured (missing ${config.missing.join(', ')}); no emails will be sent.`);
            }
            return { status: 'disabled' };
        }
        if (typeof to !== 'string' || !to.includes('@')) return { status: 'skipped' };

        const log = collections.emailLog;
        const createdAt = now();
        try {
            await log.insertOne({
                _id: key, kind, to, subject: message.subject, status: 'sending',
                createdAt, expiresAt: new Date(createdAt.getTime() + LOG_RETENTION_MS),
            });
        } catch (error) {
            if (error && error.code === 11000) return { status: 'duplicate' };
            logger.error(`Email log write failed (email not sent): ${describeError(error)}`);
            return { status: 'failed' };
        }

        try {
            await withTimeout(getTransport().sendMail({
                from: { name: config.fromName, address: config.user },
                to,
                subject: message.subject,
                text: message.text,
                html: message.html,
            }), config.sendTimeoutMs);
            await log.updateOne({ _id: key }, { $set: { status: 'sent', sentAt: now() } }).catch(() => {});
            return { status: 'sent' };
        } catch (error) {
            const reason = describeError(error);
            logger.error(`Email "${kind}" failed (non-fatal): ${reason}`);
            await log.updateOne({ _id: key }, { $set: { status: 'failed', error: reason } }).catch(() => {});
            return { status: 'failed' };
        }
    }

    return {
        get enabled() { return config.enabled; },

        sendRequestReceived(request, requestId) {
            return send({
                kind: 'request_received',
                key: `request_received:${requestId}`,
                to: request.senderEmail,
                message: templates.requestReceived({ request, requestUrl: requestUrl(requestId) }),
            });
        },

        // One email per change: the key includes when it changed.
        sendPickupChanged(request, requestId, changedAt) {
            return send({
                kind: 'pickup_changed',
                key: `pickup_changed:${requestId}:${changedAt.getTime()}`,
                to: request.senderEmail,
                message: templates.pickupChanged({ request, requestUrl: requestUrl(requestId) }),
            });
        },

        // One reminder per pickup slot: moving the pickup earns a new reminder,
        // running the daily job twice does not.
        sendPickupReminder(request, requestId) {
            return send({
                kind: 'pickup_reminder',
                key: `pickup_reminder:${requestId}:${request.pickupSlot.date}|${request.pickupSlot.slotId}`,
                to: request.senderEmail,
                message: templates.pickupReminder({ request, requestUrl: requestUrl(requestId) }),
            });
        },

        // A request can be offered again after a decline, so the key includes
        // the technician and when the offer was made.
        sendJobOffer(request, requestId, technician, offeredAt) {
            return send({
                kind: 'job_offer',
                key: `job_offer:${requestId}:${String(technician.email).toLowerCase()}:${offeredAt.getTime()}`,
                to: technician.email,
                message: templates.jobOffer({ request, technicianName: technician.name, jobsUrl: jobsUrl() }),
            });
        },
    };
}

// Used when no email service is passed in (e.g. a controller built directly
// in a test): every send is a no-op.
function createDisabledEmailService() {
    return createEmailService({ config: { enabled: false }, collections: null });
}

module.exports = { createEmailService, createDisabledEmailService };
