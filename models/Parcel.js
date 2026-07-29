const { ObjectId } = require('mongodb');

class ParcelModel {
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
    // (see controllers/parcelController.js's getAdminParcels) - this method
    // never interprets or trusts raw client input itself.
    async findPaginated(query, { page, limit, sort = { createdAt: -1 } }) {
        const skip = (page - 1) * limit;
        const [data, totalItems] = await Promise.all([
            this.collection
                .find(query, { projection: ParcelModel.ADMIN_LIST_PROJECTION })
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

module.exports = ParcelModel;

