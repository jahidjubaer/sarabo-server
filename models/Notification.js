const { ObjectId } = require('mongodb');

// Fields ever allowed to leave MongoDB via findForRecipient - excludes
// recipientEmail/recipientRole/actorEmail/actorRole/deduplicationKey, the
// same allow-list the controller's serializer also applies. Enforcing it at
// the query level (not just in the controller) means a raw document never
// even leaves the database with those fields attached.
const SAFE_PROJECTION = {
    _id: 1, type: 1, title: 1, message: 1, entityType: 1, entityId: 1,
    actionUrl: 1, priority: 1, isRead: 1, readAt: 1, createdAt: 1,
    metadata: 1, schemaVersion: 1
};

class NotificationModel {
    constructor(collection) {
        this.collection = collection;
    }

    async insertOne(document, options = {}) {
        return await this.collection.insertOne(document, options);
    }

    // Debugging/test convenience only - not part of any public read API.
    async findByDeduplicationKey(deduplicationKey) {
        return await this.collection.findOne({ deduplicationKey });
    }

    // Test-fixture cleanup only. Deliberately narrow (recipient-scoped), not
    // a general-purpose delete API - this unit adds no broad read/update
    // methods on this model.
    async deleteManyByRecipientEmail(recipientEmail) {
        return await this.collection.deleteMany({ recipientEmail });
    }

    // Ownership is baked into the query itself (recipientEmail is part of
    // the filter, never a fetch-then-compare-in-memory check). Newest first.
    async findForRecipient({ recipientEmail, page, limit, unreadOnly }) {
        const query = { recipientEmail };
        if (unreadOnly) {
            query.isRead = false;
        }
        const skip = (page - 1) * limit;
        return await this.collection
            .find(query, { projection: SAFE_PROJECTION })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .toArray();
    }

    async countForRecipient({ recipientEmail, unreadOnly }) {
        const query = { recipientEmail };
        if (unreadOnly) {
            query.isRead = false;
        }
        return await this.collection.countDocuments(query);
    }

    async countUnreadForRecipient(recipientEmail) {
        return await this.collection.countDocuments({ recipientEmail, isRead: false });
    }

    // Owned-only lookup (recipientEmail is part of the filter) - returns null
    // identically whether the document doesn't exist at all or belongs to a
    // different recipient, so callers can never distinguish "absent" from
    // "foreign" by inspecting the result.
    async findOwnedById({ id, recipientEmail }) {
        return await this.collection.findOne({ _id: new ObjectId(id), recipientEmail });
    }

    // Guarded update is the primary race-resolver (mirrors the "query
    // condition itself is the race-resolver" pattern already used throughout
    // parcelController.js/riderController.js) - a single atomic update
    // resolves both ownership and "was it actually unread" together. Only
    // when nothing was modified does it fall back to one additional owned
    // lookup, purely to distinguish "already read" from "not found/foreign"
    // for the response - that lookup is itself ownership-scoped, so it can
    // never reveal a foreign document's existence.
    async markOneRead({ id, recipientEmail, readAt }) {
        const objectId = new ObjectId(id);
        const result = await this.collection.updateOne(
            { _id: objectId, recipientEmail, isRead: false },
            { $set: { isRead: true, readAt } }
        );
        if (result.modifiedCount === 1) {
            return { modified: true, alreadyRead: false, found: true };
        }
        const owned = await this.findOwnedById({ id, recipientEmail });
        if (!owned) {
            return { modified: false, alreadyRead: false, found: false };
        }
        return { modified: false, alreadyRead: true, found: true };
    }

    async markAllRead({ recipientEmail, readAt }) {
        return await this.collection.updateMany(
            { recipientEmail, isRead: false },
            { $set: { isRead: true, readAt } }
        );
    }
}

module.exports = NotificationModel;
