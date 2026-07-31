const { ObjectId } = require('mongodb');
const { normalize } = require('../services/paymentProcessor');

class UserModel {
    // Every role the users collection is ever expected to hold - mirrors the
    // enum-ownership pattern already used by utils/riderStatus.js's
    // RECOGNIZED_STATUSES and ParcelModel's own static projection constants.
    static VALID_ROLES = ['user', 'rider', 'admin'];

    constructor(collection) {
        this.collection = collection;
    }

    async findAll(searchText = null, limit = 5) {
        const query = {};
        if (searchText) {
            query.$or = [
                { displayName: { $regex: searchText, $options: 'i' } },
                { email: { $regex: searchText, $options: 'i' } },
            ];
        }
        const cursor = this.collection.find(query).sort({ createdAt: -1 }).limit(limit);
        return await cursor.toArray();
    }

    async findById(id) {
        const query = { _id: new ObjectId(id) };
        return await this.collection.findOne(query);
    }

    async findByEmail(email) {
        const query = { email };
        return await this.collection.findOne(query);
    }

    async create(userData) {
        // Role is always forced to 'user' here, regardless of anything the
        // caller supplies - privileged roles are only ever granted through
        // the dedicated admin-authorized role-update workflow
        // (updateRole/updateRoleByEmail), never at creation time.
        userData.role = 'user';
        userData.createdAt = new Date();
        const result = await this.collection.insertOne(userData);
        return result;
    }

    async updateRole(id, role) {
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
            $set: { role }
        };
        return await this.collection.updateOne(query, updatedDoc);
    }

    async updateRoleByEmail(email, role) {
        const query = { email };
        const updatedDoc = {
            $set: { role }
        };
        return await this.collection.updateOne(query, updatedDoc);
    }

    async exists(email) {
        const user = await this.collection.findOne({ email });
        return !!user;
    }

    // Admin fan-out lookup - projects email only, normalized, deduplicated,
    // and with empty values filtered out. Never returns a full user
    // document; exists solely to support notification/broadcast-style
    // recipient lookups.
    async findEmailsByRole(role, options = {}) {
        if (!UserModel.VALID_ROLES.includes(role)) {
            throw Object.assign(new Error(`Invalid role: ${role}`), { code: 'INVALID_ROLE' });
        }
        const findOptions = { projection: { email: 1, _id: 0 } };
        if (options.session) {
            findOptions.session = options.session;
        }
        const docs = await this.collection.find({ role }, findOptions).toArray();
        const emails = new Set();
        for (const doc of docs) {
            const normalizedEmail = normalize(doc.email);
            if (normalizedEmail) {
                emails.add(normalizedEmail);
            }
        }
        return Array.from(emails);
    }

    // Exact current role lookup - projects role only, never the full user
    // document. Returns null (never a default) whenever the account doesn't
    // exist or its stored role isn't one of the recognized system roles, so
    // a caller can never mistake "unknown" for a legitimate role.
    async findRoleByEmail(email, options = {}) {
        const normalizedEmail = normalize(email);
        if (!normalizedEmail) {
            return null;
        }
        const findOptions = { projection: { role: 1, _id: 0 } };
        if (options.session) {
            findOptions.session = options.session;
        }
        const user = await this.collection.findOne({ email: normalizedEmail }, findOptions);
        if (!user || !UserModel.VALID_ROLES.includes(user.role)) {
            return null;
        }
        return user.role;
    }
}

module.exports = UserModel;

