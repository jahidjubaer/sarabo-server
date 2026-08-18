const { ObjectId } = require('mongodb');
const { WITHDRAWAL_REQUESTED, WITHDRAWAL_PAID, WITHDRAWAL_REJECTED } = require('../utils/settlement');

// Technician withdrawal requests - the single active payout mechanism.
//
// This is manual payout accounting only. Nothing in this model, or anywhere it
// is called from, moves real money: an admin marking a withdrawal paid records
// that they have settled it out of band. There is no bKash/Nagad/bank/Stripe
// Connect integration behind any of it.
//
// The "one open withdrawal per technician" rule is enforced at the DATABASE
// level by a unique partial index on technicianEmail filtered to
// status: 'requested' (see config/database.js), not only by the read-then-write
// check in the controller. Two concurrent requests therefore cannot both open a
// withdrawal - the loser gets a duplicate-key error, which createRequested()
// below translates into the same controlled conflict the non-racing path
// returns. Same pattern as payments.sessionId and notifications.deduplicationKey.
class TechnicianWithdrawalModel {
    constructor(collection) {
        this.collection = collection;
    }

    // The caller's own withdrawals, newest first. Bounded - a wallet page shows
    // a history, never an unbounded scan.
    async findByTechnicianEmail(email, { limit = 50 } = {}) {
        return await this.collection
            .find({ technicianEmail: email })
            .sort({ requestedAt: -1 })
            .limit(limit)
            .toArray();
    }

    async findOpenByTechnicianEmail(email, options = {}) {
        const findOptions = {};
        if (options.session) findOptions.session = options.session;
        return await this.collection.findOne({ technicianEmail: email, status: WITHDRAWAL_REQUESTED }, findOptions);
    }

    async findById(id) {
        if (!ObjectId.isValid(id)) return null;
        return await this.collection.findOne({ _id: new ObjectId(id) });
    }

    // Returns { created: false, code: 'WITHDRAWAL_ALREADY_OPEN' } instead of
    // throwing when the unique partial index rejects a second open request, so
    // the racing path and the checked path produce the same controlled result.
    async createRequested(document) {
        try {
            const result = await this.collection.insertOne(document);
            return { created: true, withdrawal: { ...document, _id: result.insertedId } };
        } catch (error) {
            if (error.code === 11000) {
                return { created: false, code: 'WITHDRAWAL_ALREADY_OPEN' };
            }
            throw error;
        }
    }

    // Admin list with the same skip/limit + total shape the other admin list
    // endpoints use. `status` is validated by the caller before it reaches here.
    async findAllPaged({ status = null, skip = 0, limit = 20 } = {}) {
        const filter = status ? { status } : {};
        const [items, total] = await Promise.all([
            this.collection.find(filter).sort({ requestedAt: -1 }).skip(skip).limit(limit).toArray(),
            this.collection.countDocuments(filter),
        ]);
        return { items, total };
    }

    // Single-winner terminal transition. The filter pins status to 'requested',
    // so a withdrawal can only ever leave the open state once: a second
    // mark-paid (or a mark-paid racing a reject) matches zero documents and is
    // reported as a conflict rather than overwriting processedAt/processedBy.
    // This is what makes double-payment impossible, not the read above it.
    async processFromRequested({ id, status, processedBy, processedAt, note }) {
        if (status !== WITHDRAWAL_PAID && status !== WITHDRAWAL_REJECTED) {
            throw Object.assign(new Error(`invalid terminal withdrawal status: ${status}`), { code: 'INVALID_WITHDRAWAL_STATUS' });
        }
        return await this.collection.updateOne(
            { _id: new ObjectId(id), status: WITHDRAWAL_REQUESTED },
            { $set: { status, processedBy, processedAt, note } }
        );
    }
}

module.exports = TechnicianWithdrawalModel;
