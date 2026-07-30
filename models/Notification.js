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
}

module.exports = NotificationModel;
