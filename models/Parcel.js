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

