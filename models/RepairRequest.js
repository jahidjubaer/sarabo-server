const { ObjectId } = require('mongodb');
const { MAX_DAMAGE_IMAGES } = require('../utils/repairRequestV2');

class RepairRequestModel {
    constructor(collection) {
        this.collection = collection;
    }

    async findAll(filters = {}, sort = { createdAt: -1 }) {
        const options = { sort };
        const cursor = this.collection.find(filters, options);
        return await cursor.toArray();
    }

    // Explicit inclusion projection for the admin request-management list -
    // only these fields are ever allowed to leave MongoDB for that view,
    // independent of whatever else is later added to a repair-request
    // document. Never includes Stripe/session internals, technician
    // application fields (NID etc. live on the riders collection, never
    // here), or unrelated address/notes detail - those remain available only
    // through the existing single-request detail endpoint.
    static ADMIN_LIST_PROJECTION = {
        _id: 1,
        trackingId: 1,
        senderName: 1,
        senderEmail: 1,
        parcelName: 1,
        deliveryStatus: 1,
        paymentStatus: 1,
        cost: 1,
        riderName: 1,
        riderEmail: 1,
        createdAt: 1
    };

    // Paginated, projected, count-consistent list for the admin request
    // management view. `query` must already be a safe, server-built filter
    // (see controllers/repairRequestController.js's getAdminRepairRequests) - this method
    // never interprets or trusts raw client input itself.
    async findPaginated(query, { page, limit, sort = { createdAt: -1 } }) {
        const skip = (page - 1) * limit;
        const [data, totalItems] = await Promise.all([
            this.collection
                .find(query, { projection: RepairRequestModel.ADMIN_LIST_PROJECTION })
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .toArray(),
            this.collection.countDocuments(query)
        ]);
        return { data, totalItems };
    }

    async findById(id) {
        const query = { _id: new ObjectId(id) };
        return await this.collection.findOne(query);
    }

    async findByTrackingId(trackingId) {
        const query = { trackingId };
        return await this.collection.findOne(query);
    }

    // Explicit allow-list projection for the unauthenticated public tracking
    // endpoint - only these fields are ever allowed to leave MongoDB for
    // that path, independent of whatever the response-building code does
    // with them. See controllers/trackingController.js's getPublicTracking.
    async findPublicProjectionByTrackingId(trackingId) {
        const query = { trackingId };
        // MongoDB includes _id by default even in an inclusion projection -
        // exclude it explicitly, since the public contract must never
        // expose the real MongoDB ObjectId.
        const projection = { _id: 0, trackingId: 1, deliveryStatus: 1, createdAt: 1 };
        return await this.collection.findOne(query, { projection });
    }

    async create(parcelData) {
        parcelData.createdAt = new Date();
        const result = await this.collection.insertOne(parcelData);
        return result;
    }

    async updateStatus(id, deliveryStatus) {
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
            $set: { deliveryStatus }
        };
        return await this.collection.updateOne(query, updatedDoc);
    }

    async update(id, updateData) {
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
            $set: updateData
        };
        return await this.collection.updateOne(query, updatedDoc);
    }

    async delete(id) {
        const query = { _id: new ObjectId(id) };
        return await this.collection.deleteOne(query);
    }

    // Guarded hard delete (Phase 6.5 Unit 8) - the filter condition itself is
    // the race-resolver against a concurrent assignment, payment, inspection,
    // quote, or repair landing between the caller's eligibility read and this
    // write (mirrors the guarded-update pattern used throughout Phase 6.3/6.4:
    // the condition, not a prior read, is what MongoDB serializes). The ONLY
    // document this ever removes is a schemaVersion-2 request that is still
    // pending-pickup, unassigned, unpaid, and carries no inspection/quote/
    // repair subdocument. A deletedCount of 0 means the request changed
    // underneath us and must NOT be deleted - the caller aborts the whole
    // transaction so nothing partial is left behind.
    async deleteGuarded({ id, session }) {
        const filter = {
            _id: new ObjectId(id),
            schemaVersion: 2,
            $or: [
                { deliveryStatus: { $exists: false } },
                { deliveryStatus: 'pending-pickup' }
            ],
            riderEmail: { $exists: false },
            riderId: { $exists: false },
            inspection: { $exists: false },
            quote: { $exists: false },
            repair: { $exists: false },
            paymentStatus: { $ne: 'paid' }
        };
        return await this.collection.deleteOne(filter, { session });
    }

    // Set-based active-assignment lookup for eligible-technician evaluation
    // (Phase 6.3 Unit 5) - one query for every candidate rider, never one
    // query per rider. Deliberately generic (accepts the status list as a
    // parameter rather than importing utils/parcelStatus.js's ACTIVE_STATUSES
    // itself) so this model stays a thin query primitive and the caller
    // (services/technicianEligibilityService.js) owns which statuses count
    // as "active" for this purpose.
    async findRiderIdsWithDeliveryStatuses(riderIds, statuses) {
        if (riderIds.length === 0) return new Set();
        const docs = await this.collection.find(
            { riderId: { $in: riderIds }, deliveryStatus: { $in: statuses } },
            { projection: { riderId: 1 } }
        ).toArray();
        return new Set(docs.map((doc) => doc.riderId));
    }

    // Set-based completed-repair count for eligible-technician ranking
    // (Phase 6.3 Unit 5) - one aggregation for every candidate rider, never
    // one query per rider. `completedStatus` is passed in by the caller
    // rather than hardcoded here, for the same reason as
    // findRiderIdsWithDeliveryStatuses above.
    async aggregateCompletedCountsByRider(riderIds, completedStatus) {
        if (riderIds.length === 0) return new Map();
        const pipeline = [
            { $match: { riderId: { $in: riderIds }, deliveryStatus: completedStatus } },
            { $group: { _id: '$riderId', count: { $sum: 1 } } }
        ];
        const rows = await this.collection.aggregate(pipeline).toArray();
        return new Map(rows.map((row) => [row._id, row.count]));
    }

    // ---- Damage evidence (Phase 6.4 Unit 1) ----

    // Single-document guarded push - the filter condition itself is the
    // race-resolver for the 3-image cap (mirrors the guarded-update pattern
    // established in Phase 6.3: the condition, not a prior read, is what
    // MongoDB serializes). A concurrent finalize that would push a 4th image
    // simply fails to match once a sibling transaction's push has already
    // landed. Also guards against the exact same storageKey being attached
    // twice (idempotency/replay safety) - never a broad parcel replacement,
    // never touches pricing/service/assignment fields.
    async attachDamageImage({ requestId, storageKey, image, session }) {
        const filter = {
            _id: new ObjectId(requestId),
            schemaVersion: 2,
            'damage.images.storageKey': { $ne: storageKey },
            $expr: { $lt: [{ $size: { $ifNull: ['$damage.images', []] } }, MAX_DAMAGE_IMAGES] }
        };
        return await this.collection.updateOne(
            filter,
            { $push: { 'damage.images': image } },
            { session }
        );
    }

    async removeDamageImage({ requestId, storageKey, session }) {
        const filter = { _id: new ObjectId(requestId), schemaVersion: 2 };
        return await this.collection.updateOne(
            filter,
            { $pull: { 'damage.images': { storageKey } } },
            { session }
        );
    }

    findDamageImage(parcel, storageKey) {
        if (!parcel || !parcel.damage || !Array.isArray(parcel.damage.images)) return null;
        return parcel.damage.images.find((image) => image.storageKey === storageKey) || null;
    }

    countDamageImages(parcel) {
        if (!parcel || !parcel.damage || !Array.isArray(parcel.damage.images)) return 0;
        return parcel.damage.images.length;
    }

    async getDeliveryStatusStats() {
        const pipeline = [
            {
                $group: {
                    _id: '$deliveryStatus',
                    count: { $sum: 1 }
                }
            },
            {
                $project: {
                    status: '$_id',
                    count: 1,
                }
            }
        ];
        return await this.collection.aggregate(pipeline).toArray();
    }
}

module.exports = RepairRequestModel;

