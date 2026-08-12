// Durable deletion-cleanup record (Phase 6.5 Unit 8, Fix 2). One record per
// deleted repair request, holding the exact Firebase Storage object keys that
// still need to be purged AFTER the request's DB records are gone. It is
// created inside the same transaction that deletes the request, so the trusted
// storage keys are captured durably BEFORE the source metadata (repair request damage
// images, upload/evidence sessions) disappears - a crashed or failed Storage
// pass can then always be retried from this record instead of orphaning
// objects forever.
//
// `_id` IS the requestId (the deleted repair request's ObjectId string). Using it as
// the primary key makes the record uniquely keyed by requestId for free - two
// concurrent deletes of the same request can never create two cleanup records,
// and a retry is naturally idempotent. Storage keys are ALWAYS collected from
// trusted server-side records only, never from any client input.
class DeletionCleanupModel {
    constructor(collection) {
        this.collection = collection;
    }

    async create({ requestId, storageKeys }, { session } = {}) {
        const doc = {
            _id: requestId,
            requestId,
            storageKeys,
            status: 'pending',
            createdAt: new Date(),
            lastErrorCode: null,
        };
        await this.collection.insertOne(doc, session ? { session } : {});
        return doc;
    }

    async findById(requestId) {
        return await this.collection.findOne({ _id: requestId });
    }

    async findAllPending() {
        return await this.collection.find({ status: 'pending' }).toArray();
    }

    async remove(requestId) {
        return await this.collection.deleteOne({ _id: requestId });
    }

    // Keeps the record for a later retry, narrowed to only the keys that still
    // failed to delete (already-deleted/not-found keys are dropped so a retry
    // never re-attempts resolved objects), and records the last failure code
    // for observability. Never widens the key set.
    async retainRemaining(requestId, { storageKeys, lastErrorCode }) {
        return await this.collection.updateOne(
            { _id: requestId },
            { $set: { storageKeys, lastErrorCode, status: 'pending', updatedAt: new Date() } }
        );
    }
}

module.exports = DeletionCleanupModel;
