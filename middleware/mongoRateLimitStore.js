const { connectDatabase, collections } = require('../config/database');

// express-rate-limit store backed by MongoDB (support_rate_limits), so every
// serverless instance counts against the SAME limits - the default memory
// store gave each Vercel instance its own counters, reset on every cold start.
//
// Fixed windows, the same model as express-rate-limit's memory store: one
// counter document per (limiter prefix, client key, window start), created on
// the first hit of a window and removed by the collection's TTL index once the
// window has ended (config/database.js). Counting is a single atomic upsert,
// so concurrent requests on different instances never lose a hit.
//
// Errors are NOT swallowed here: the caller decides what an unavailable store
// means (for AI support: refuse the request - see supportRateLimit.js).
class MongoRateLimitStore {
    constructor({ prefix, collectionProvider } = {}) {
        if (typeof prefix !== 'string' || !prefix) throw new Error('MongoRateLimitStore needs a prefix');
        this.prefix = prefix;
        this.localKeys = false;
        this.collectionProvider = collectionProvider || (async () => {
            await connectDatabase();
            return collections.supportRateLimits;
        });
    }

    init(options) {
        this.windowMs = options.windowMs;
    }

    windowFor(now = Date.now()) {
        const start = Math.floor(now / this.windowMs) * this.windowMs;
        return { start, resetTime: new Date(start + this.windowMs) };
    }

    documentId(key, start) {
        return `${this.prefix}:${key}:${start}`;
    }

    async increment(key) {
        const collection = await this.collectionProvider();
        const { start, resetTime } = this.windowFor();
        const _id = this.documentId(key, start);
        const update = { $inc: { hits: 1 }, $setOnInsert: { expiresAt: resetTime } };
        let doc;
        try {
            doc = await collection.findOneAndUpdate({ _id }, update, { upsert: true, returnDocument: 'after' });
        } catch (error) {
            // Two first hits racing to create the same window document: one
            // upsert wins, the other gets a duplicate key - retry once as a
            // plain increment of the now-existing document.
            if (error && error.code === 11000) {
                doc = await collection.findOneAndUpdate({ _id }, update, { upsert: true, returnDocument: 'after' });
            } else {
                throw error;
            }
        }
        return { totalHits: doc.hits, resetTime };
    }

    async get(key) {
        const collection = await this.collectionProvider();
        const { start, resetTime } = this.windowFor();
        const doc = await collection.findOne({ _id: this.documentId(key, start) });
        return doc ? { totalHits: doc.hits, resetTime } : undefined;
    }

    async decrement(key) {
        const collection = await this.collectionProvider();
        const { start } = this.windowFor();
        await collection.updateOne({ _id: this.documentId(key, start), hits: { $gt: 0 } }, { $inc: { hits: -1 } });
    }

    async resetKey(key) {
        const collection = await this.collectionProvider();
        const { start } = this.windowFor();
        await collection.deleteOne({ _id: this.documentId(key, start) });
    }
}

module.exports = { MongoRateLimitStore };
