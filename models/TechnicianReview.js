const { ObjectId } = require('mongodb');

class TechnicianReview {
    constructor(collection) { this.collection = collection; }
    findById(id, options = {}) { return this.collection.findOne({ _id: new ObjectId(id) }, options); }
    findForRepair(repairRequestId, options = {}) { return this.collection.findOne({ repairRequestId }, options); }
    insert(document, options = {}) { return this.collection.insertOne(document, options); }
    async list(filter, { page, limit }) {
        const [items, total] = await Promise.all([
            this.collection.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
            this.collection.countDocuments(filter),
        ]);
        return { items, total, page, limit };
    }
    async aggregate(technicianId) {
        const [summary] = await this.collection.aggregate([
            { $match: { technicianId, visibility: 'visible' } },
            { $group: { _id: null, averageRating: { $avg: '$rating' }, reviewCount: { $sum: 1 } } },
            { $project: { _id: 0, averageRating: 1, reviewCount: 1 } },
        ]).toArray();
        return summary || { averageRating: null, reviewCount: 0 };
    }
    moderate(id, expectedVersion, visibility, entry) {
        return this.collection.findOneAndUpdate({ _id: new ObjectId(id), version: expectedVersion, visibility: { $ne: visibility } }, {
            $set: { visibility, updatedAt: entry.createdAt }, $inc: { version: 1 }, $push: { moderationHistory: entry },
        }, { returnDocument: 'after' });
    }
}

module.exports = TechnicianReview;
