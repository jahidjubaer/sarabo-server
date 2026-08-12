// Repair completion evidence session model (Phase 6.4 Unit 7). Mirrors
// models/DamageUploadSession.js but is technician-owned (createdByTechnicianId /
// technicianEmail) rather than customer-owned, and lives in its own collection so
// repair evidence and customer damage photos never share storage bookkeeping.
// `_id` is the crypto-random UUID from utils/repairEvidence.js#generateUploadSessionId,
// which is also the public uploadSessionId and the unguessable segment of the
// storage key. No Firebase credentials, tokens, or signed URLs are ever stored.

class RepairEvidenceSessionModel {
    constructor(collection) {
        this.collection = collection;
    }

    async create({ id, requestId, createdByTechnicianId, technicianEmail, storageKey, mimeType, declaredSize, expiresAt }, options = {}) {
        const doc = {
            _id: id,
            requestId,
            createdByTechnicianId,
            technicianEmail,
            storageKey,
            mimeType,
            declaredSize,
            status: 'pending',
            expiresAt,
            createdAt: new Date(),
            finalizedAt: null,
        };
        const insertOptions = {};
        if (options.session) insertOptions.session = options.session;
        await this.collection.insertOne(doc, insertOptions);
        return doc;
    }

    async findById(id, options = {}) {
        const findOptions = {};
        if (options.session) findOptions.session = options.session;
        return await this.collection.findOne({ _id: id }, findOptions);
    }

    // Atomic guard: only a pending, non-expired session tied to the exact
    // request AND assigned technician it was created for can transition to
    // finalized. Every field the caller verified is re-asserted in the filter
    // itself, so a reassignment, a racing completion, or a mismatched
    // request/technician can never finalize a stale or foreign session.
    async markFinalized({ id, requestId, createdByTechnicianId, now, session }) {
        const filter = {
            _id: id,
            requestId,
            createdByTechnicianId,
            status: 'pending',
            expiresAt: { $gt: now },
        };
        return await this.collection.updateOne(
            filter,
            { $set: { status: 'finalized', finalizedAt: now } },
            { session }
        );
    }
}

module.exports = RepairEvidenceSessionModel;
