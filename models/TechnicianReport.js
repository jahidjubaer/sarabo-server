const { ObjectId } = require('mongodb');

class TechnicianReport {
    constructor(collection) { this.collection = collection; }
    findById(id, options = {}) { return this.collection.findOne({ _id: new ObjectId(id) }, options); }
    findForRepair(repairRequestId, customerId) { return this.collection.find({ repairRequestId, customerId }).toArray(); }
    insert(document, options = {}) { return this.collection.insertOne(document, options); }
    async list(filter, { page, limit }) {
        const [items, total] = await Promise.all([
            this.collection.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
            this.collection.countDocuments(filter),
        ]);
        return { items, total, page, limit };
    }
    changeStatus(document, expectedVersion, status, adminId, explanation, now) {
        const terminal = ['resolved', 'dismissed'].includes(status);
        return this.collection.findOneAndUpdate({ _id: document._id, version: expectedVersion, status: document.status }, {
            $set: { status, updatedAt: now, ...(terminal ? { closedAt: now, closedBy: adminId } : {}) },
            $inc: { version: 1 },
            $push: { statusHistory: { from: document.status, to: status, adminId, createdAt: now }, ...(explanation ? { adminNotes: { text: explanation, adminId, createdAt: now } } : {}) },
        }, { returnDocument: 'after' });
    }
    appendNote(id, expectedVersion, note) {
        return this.collection.findOneAndUpdate({ _id: new ObjectId(id), version: expectedVersion }, {
            $push: { adminNotes: note }, $set: { updatedAt: note.createdAt }, $inc: { version: 1 },
        }, { returnDocument: 'after' });
    }
}

module.exports = TechnicianReport;
