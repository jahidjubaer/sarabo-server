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
            license: 1, nid: 1, bike: 1, status: 1, workStatus: 1, createdAt: 1,
            expertise: 1
        };
        const cursor = this.collection.find(filters, { projection });
        return await cursor.toArray();
    }

    async findById(id) {
        const query = { _id: new ObjectId(id) };
        return await this.collection.findOne(query);
    }

    // Resolves "which rider record belongs to this caller" from a verified
    // token email (Phase 6.4 Unit 2) - never trusts a client-supplied rider
    // id. Session-aware for callers evaluating access inside a transaction.
    async findByEmail(email, options = {}) {
        const findOptions = {};
        if (options.session) findOptions.session = options.session;
        return await this.collection.findOne({ email }, findOptions);
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

    // Guarded full-replacement update (Phase 6.3 Unit 3) - the filter always
    // includes the exact expertise state the caller read moments earlier
    // (either the prior array value, or "the field does not exist yet" for
    // a legacy rider), so a concurrent expertise update or an active
    // assignment forming between the read and this write is detected via
    // matchedCount === 0 rather than silently overwritten. Mirrors the
    // "guard on every field read, not just the one being changed" pattern
    // already used throughout riderController.js/parcelController.js.
    async replaceExpertise({ id, hasExpertiseField, expectedExpertise, newExpertise, session }) {
        const filter = { _id: new ObjectId(id) };
        filter.expertise = hasExpertiseField ? expectedExpertise : { $exists: false };
        return await this.collection.updateOne(
            filter,
            { $set: { expertise: newExpertise } },
            { session }
        );
    }

    // Bounded candidate fetch for eligible-technician evaluation (Phase 6.3
    // Unit 5). Explicit inclusion projection - never a bare find() - so a
    // future field added to this collection is never accidentally pulled
    // into eligibility evaluation/response building. `approvedOnly: false`
    // (diagnostic mode only) additionally fetches non-approved riders solely
    // so the diagnostic response can report TECHNICIAN_NOT_APPROVED for
    // them; the default (non-diagnostic) path never needs to see them at
    // all, since they could never be eligible regardless.
    async findEligibilityCandidates({ approvedOnly }) {
        const filter = approvedOnly ? { status: 'approved' } : {};
        const projection = {
            name: 1, email: 1, region: 1, district: 1, avatar: 1,
            status: 1, workStatus: 1, expertise: 1
        };
        return await this.collection.find(filter, { projection }).toArray();
    }
}

module.exports = RiderModel;

