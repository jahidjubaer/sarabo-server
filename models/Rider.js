const { ObjectId } = require('mongodb');

class RiderModel {
    constructor(collection) {
        this.collection = collection;
    }

    async findAll(filters = {}) {
        // Explicit field allow-list rather than a bare find() - this route is
        // admin-only (routes/riders.js), and every field listed here is
        // actually rendered by an existing admin consumer: ApproveTechnicians'
        // review modal needs the full application (including address/nid) to
        // vet a technician; AssignTechnicians/AdminDashboardHome only need a
        // subset. Listing them explicitly keeps the contract intentional
        // instead of silently exposing any future field added to this
        // collection.
        const projection = {
            name: 1, email: 1, region: 1, district: 1, address: 1,
            license: 1, nid: 1, bike: 1, status: 1, workStatus: 1, createdAt: 1
        };
        const cursor = this.collection.find(filters, { projection });
        return await cursor.toArray();
    }

    async findById(id) {
        const query = { _id: new ObjectId(id) };
        return await this.collection.findOne(query);
    }

    async create(riderData) {
        riderData.status = 'pending';
        riderData.createdAt = new Date();
        const result = await this.collection.insertOne(riderData);
        return result;
    }

    async updateStatus(id, status, workStatus = 'available') {
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
            $set: {
                status,
                workStatus
            }
        };
        return await this.collection.updateOne(query, updatedDoc);
    }

    async updateWorkStatus(id, workStatus) {
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
            $set: { workStatus }
        };
        return await this.collection.updateOne(query, updatedDoc);
    }
}

module.exports = RiderModel;

