const { ObjectId } = require('mongodb');
const { normalize } = require('../services/paymentProcessor');

const LIST_DEFAULT_LIMIT = 10;
const LIST_MAX_LIMIT = 50;

// Missing page -> default to 1. Present but not a positive integer -> reject,
// never silently coerce (this is a new endpoint, not bound to
// getAdminParcels's older silent-normalize convention).
function parsePage(rawPage) {
    if (rawPage === undefined) return 1;
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return null;
    return page;
}

// Missing limit -> default. Present but not a positive integer -> reject.
// Present, valid, and over the max -> clamp (per Phase C: "limit must be
// clamped to a maximum of 50" - clamping is the explicitly requested policy
// for the upper bound specifically, distinct from rejecting genuinely
// invalid values).
function parseLimit(rawLimit) {
    if (rawLimit === undefined) return LIST_DEFAULT_LIMIT;
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1) return null;
    return Math.min(limit, LIST_MAX_LIMIT);
}

// Only the exact strings 'true'/'false' are accepted - ambiguous values like
// 1, "yes", "unread" are rejected outright rather than guessed at.
function parseUnreadOnly(rawUnreadOnly) {
    if (rawUnreadOnly === undefined) return { value: false, valid: true };
    if (rawUnreadOnly === 'true') return { value: true, valid: true };
    if (rawUnreadOnly === 'false') return { value: false, valid: true };
    return { value: null, valid: false };
}

// Safe response projection - deliberately excludes recipientEmail,
// recipientRole, actorEmail, actorRole, and deduplicationKey. The stored
// document itself is never mutated; this only shapes the HTTP response.
const SAFE_FIELDS = ['_id', 'type', 'title', 'message', 'entityType', 'entityId', 'actionUrl', 'priority', 'isRead', 'readAt', 'createdAt', 'metadata', 'schemaVersion'];

function serializeNotification(doc) {
    const safe = {};
    for (const field of SAFE_FIELDS) {
        if (field in doc) safe[field] = doc[field];
    }
    return safe;
}

class NotificationController {
    constructor(models) {
        this.Notification = models.Notification;
    }

    // Recipient identity always comes from the verified token
    // (req.decoded_email) - no query/body-supplied email or role is ever
    // read by this controller.
    async listNotifications(req, res) {
        try {
            const recipientEmail = normalize(req.decoded_email);

            const page = parsePage(req.query.page);
            if (page === null) {
                return res.status(400).send({ message: 'invalid page parameter', code: 'INVALID_PAGE' });
            }

            const limit = parseLimit(req.query.limit);
            if (limit === null) {
                return res.status(400).send({ message: 'invalid limit parameter', code: 'INVALID_LIMIT' });
            }

            const unreadOnly = parseUnreadOnly(req.query.unreadOnly);
            if (!unreadOnly.valid) {
                return res.status(400).send({ message: 'invalid unreadOnly parameter', code: 'INVALID_UNREAD_ONLY' });
            }

            const [docs, totalItems] = await Promise.all([
                this.Notification.findForRecipient({ recipientEmail, page, limit, unreadOnly: unreadOnly.value }),
                this.Notification.countForRecipient({ recipientEmail, unreadOnly: unreadOnly.value })
            ]);

            const totalPages = Math.max(Math.ceil(totalItems / limit), 1);

            res.send({
                data: docs.map(serializeNotification),
                pagination: {
                    page,
                    limit,
                    totalItems,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1
                }
            });
        } catch (error) {
            res.status(500).send({ message: 'Error fetching notifications', code: 'INTERNAL_ERROR' });
        }
    }

    async getUnreadCount(req, res) {
        try {
            const recipientEmail = normalize(req.decoded_email);
            const count = await this.Notification.countUnreadForRecipient(recipientEmail);
            res.send({ count });
        } catch (error) {
            res.status(500).send({ message: 'Error fetching unread notification count', code: 'INTERNAL_ERROR' });
        }
    }

    // Ownership is enforced inside the database query itself (see
    // NotificationModel.markOneRead) - never a fetch-then-compare-in-memory
    // check. A foreign notification and a genuinely absent one produce the
    // exact same 404 response, so existence is never leaked across accounts.
    async markOneRead(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid notification id', code: 'INVALID_NOTIFICATION_ID' });
            }

            const recipientEmail = normalize(req.decoded_email);
            const result = await this.Notification.markOneRead({ id, recipientEmail, readAt: new Date() });

            if (!result.found) {
                return res.status(404).send({ message: 'notification not found', code: 'NOTIFICATION_NOT_FOUND' });
            }
            if (result.alreadyRead) {
                return res.send({ message: 'Notification is already read.', modified: false, alreadyRead: true });
            }
            res.send({ message: 'Notification marked as read.', modified: true, alreadyRead: false });
        } catch (error) {
            res.status(500).send({ message: 'Error marking notification as read', code: 'INTERNAL_ERROR' });
        }
    }

    async markAllRead(req, res) {
        try {
            const recipientEmail = normalize(req.decoded_email);
            const result = await this.Notification.markAllRead({ recipientEmail, readAt: new Date() });
            res.send({ message: 'Notifications marked as read.', modifiedCount: result.modifiedCount });
        } catch (error) {
            res.status(500).send({ message: 'Error marking notifications as read', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = NotificationController;
