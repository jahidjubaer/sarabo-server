const { ObjectId } = require('mongodb');
const { normalize } = require('./paymentProcessor');
const { NOTIFICATION_EVENTS, ROLES } = require('../utils/notificationEvents');

// Reasonable bound on any single metadata string - mirrors the length-capping
// approach already used by utils/searchSanitize.js's sanitizeSearchText.
const MAX_METADATA_STRING_LENGTH = 200;

function invalidNotificationInput(message, code) {
    return Object.assign(new Error(message), { code });
}

// Internal helper only - no Express route in this repository invokes this.
// Business-workflow controllers (a later unit) will require and call this
// directly, the same way controllers already require services/paymentProcessor.js
// and services/checkoutSessionManager.js.
//
// The caller supplies only identity/entity/metadata fields - title, message,
// actionUrl, deduplicationKey and priority are always rendered from the fixed
// event registry (utils/notificationEvents.js) and can never be supplied by a
// caller, defensively or otherwise.
function createNotificationService(models) {
    const { Notification } = models;

    async function createNotification({
        session,
        recipientEmail,
        recipientRole,
        type,
        entityType,
        entityId,
        actorEmail = null,
        actorRole = null,
        metadata = {}
    }) {
        const eventDefinition = NOTIFICATION_EVENTS[type];
        if (!eventDefinition) {
            throw invalidNotificationInput(`Unknown notification event type: ${type}`, 'INVALID_NOTIFICATION_TYPE');
        }

        const normalizedRecipientEmail = normalize(recipientEmail);
        if (!normalizedRecipientEmail) {
            throw invalidNotificationInput('recipientEmail is required', 'INVALID_RECIPIENT_EMAIL');
        }

        if (!ROLES.includes(recipientRole)) {
            throw invalidNotificationInput(`Invalid recipientRole: ${recipientRole}`, 'INVALID_RECIPIENT_ROLE');
        }
        // Every event owns either a single fixed recipientRole or a fixed
        // recipientRoles allowlist - never both, never neither. That shape
        // is a static registry contract, not caller input, so a violation
        // here is a programming error in utils/notificationEvents.js itself.
        const hasSingleRole = Object.prototype.hasOwnProperty.call(eventDefinition, 'recipientRole');
        const hasRoleList = Object.prototype.hasOwnProperty.call(eventDefinition, 'recipientRoles');
        if (hasSingleRole === hasRoleList) {
            throw invalidNotificationInput(`Event "${type}" has an invalid recipient-role contract`, 'INVALID_EVENT_ROLE_CONTRACT');
        }
        if (hasSingleRole) {
            // Defensive consistency check - a caller passing a role that
            // disagrees with the event's single fixed role is a programming
            // error, never a legitimate variation.
            if (recipientRole !== eventDefinition.recipientRole) {
                throw invalidNotificationInput(
                    `recipientRole "${recipientRole}" does not match event "${type}" (expected "${eventDefinition.recipientRole}")`,
                    'RECIPIENT_ROLE_MISMATCH'
                );
            }
        } else if (!eventDefinition.recipientRoles.includes(recipientRole)) {
            throw invalidNotificationInput(
                `recipientRole "${recipientRole}" is not permitted for event "${type}" (expected one of: ${eventDefinition.recipientRoles.join(', ')})`,
                'RECIPIENT_ROLE_MISMATCH'
            );
        }

        if (entityType !== eventDefinition.entityType) {
            throw invalidNotificationInput(`entityType "${entityType}" does not match event "${type}"`, 'ENTITY_TYPE_MISMATCH');
        }

        if (typeof entityId !== 'string' || !ObjectId.isValid(entityId)) {
            throw invalidNotificationInput('entityId must be a valid ObjectId string', 'INVALID_ENTITY_ID');
        }

        const normalizedActorEmail = actorEmail === null ? null : normalize(actorEmail);
        if (actorEmail !== null && !normalizedActorEmail) {
            throw invalidNotificationInput('actorEmail, if provided, must be non-empty', 'INVALID_ACTOR_EMAIL');
        }

        if (actorRole !== null && !ROLES.includes(actorRole)) {
            throw invalidNotificationInput(`Invalid actorRole: ${actorRole}`, 'INVALID_ACTOR_ROLE');
        }

        if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
            throw invalidNotificationInput('metadata must be a plain object', 'INVALID_METADATA');
        }

        // Unexpected keys are rejected outright rather than silently dropped -
        // a caller passing an unlisted key (including anything named
        // title/message/actionUrl/deduplicationKey/priority) is a programming
        // error to surface immediately, not data to quietly discard.
        const allowedKeys = eventDefinition.allowedMetadataKeys || [];
        const unexpectedKeys = Object.keys(metadata).filter(key => !allowedKeys.includes(key));
        if (unexpectedKeys.length > 0) {
            throw invalidNotificationInput(`Unexpected metadata key(s): ${unexpectedKeys.join(', ')}`, 'UNEXPECTED_METADATA_KEY');
        }

        const safeMetadata = {};
        for (const key of allowedKeys) {
            if (!(key in metadata)) continue;
            const value = metadata[key];
            if (typeof value !== 'string' || value.length === 0 || value.length > MAX_METADATA_STRING_LENGTH) {
                throw invalidNotificationInput(`metadata.${key} must be a non-empty string of reasonable length`, 'INVALID_METADATA_VALUE');
            }
            safeMetadata[key] = value;
        }

        // Fail safely rather than ever rendering "undefined" into a title/message.
        const requiredKeys = eventDefinition.requiresMetadata || [];
        for (const key of requiredKeys) {
            if (!safeMetadata[key]) {
                throw invalidNotificationInput(`metadata.${key} is required for event "${type}"`, 'MISSING_REQUIRED_METADATA');
            }
        }

        // Trusted render context - recipientEmail/actorEmail here are already
        // normalized and validated above, never caller-controlled raw input.
        // Event templates may read these for server-generated copy/dedup
        // keys, but nothing here is ever spread into the stored document or
        // into metadata - the document below sets every field explicitly.
        const templateContext = {
            entityId,
            metadata: safeMetadata,
            recipientEmail: normalizedRecipientEmail,
            recipientRole,
            actorEmail: normalizedActorEmail,
            actorRole
        };
        const document = {
            recipientEmail: normalizedRecipientEmail,
            recipientRole,
            type,
            title: eventDefinition.title(templateContext),
            message: eventDefinition.message(templateContext),
            entityType,
            entityId,
            actionUrl: eventDefinition.actionUrl(templateContext),
            priority: eventDefinition.priority,
            isRead: false,
            readAt: null,
            createdAt: new Date(),
            actorEmail: normalizedActorEmail,
            actorRole,
            deduplicationKey: eventDefinition.deduplicationKey(templateContext),
            metadata: safeMetadata,
            schemaVersion: 1
        };

        const options = session ? { session } : {};
        try {
            const result = await Notification.insertOne(document, options);
            return { created: true, notificationId: result.insertedId.toString(), deduplicationKey: document.deduplicationKey };
        } catch (error) {
            if (error.code === 11000) {
                // Same logical event already produced a notification - an
                // intentional, expected idempotent skip, not a failure.
                return { created: false, duplicate: true, notificationId: null, deduplicationKey: document.deduplicationKey };
            }
            // A genuine, unexpected database error - never swallowed.
            throw error;
        }
    }

    return { createNotification };
}

module.exports = { createNotificationService };
