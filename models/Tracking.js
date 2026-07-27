class TrackingModel {
    constructor(collection) {
        this.collection = collection;
    }

    async findAllByTrackingId(trackingId) {
        const query = { trackingId };
        return await this.collection.find(query).toArray();
    }

    // Explicit allow-list projection for the unauthenticated public tracking
    // endpoint - only status/timestamp ever leave MongoDB for that path. See
    // controllers/trackingController.js's getPublicTracking.
    async findPublicLogsByTrackingId(trackingId) {
        const query = { trackingId };
        // MongoDB includes _id by default even in an inclusion projection -
        // exclude it explicitly, since these are never returned publicly.
        const projection = { _id: 0, status: 1, createdAt: 1 };
        return await this.collection.find(query, { projection }).toArray();
    }

    async create(logData) {
        logData.createdAt = new Date();
        const result = await this.collection.insertOne(logData);
        return result;
    }
}

module.exports = TrackingModel;

