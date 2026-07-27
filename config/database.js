const { MongoClient, ServerApiVersion } = require("mongodb");

const uri = process.env.MONGO_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

// Collection handles are synchronous and side-effect-free - creating them
// does not require an active connection, only a MongoClient instance. This
// lets routes/models/controllers be built and registered immediately at
// module load, before the connection itself resolves. Actual queries against
// these collections require connectDatabase() to have resolved first, which
// is enforced per-request by middleware/database.js.
const db = client.db("zap_shift_db");
const collections = {
    users: db.collection("users"),
    parcels: db.collection("parcels"),
    payments: db.collection("payments"),
    riders: db.collection("riders"),
    trackings: db.collection("trackings"),
    checkoutSessions: db.collection("checkoutSessions"),
};

let connectionPromise = null;

// Cached and concurrency-safe: every caller within the same warm instance
// shares the same in-flight/resolved promise, so only one real connection
// attempt is ever made, even if many requests call this at once. On failure
// the cache is cleared so a later invocation (e.g. the next request) can
// retry instead of staying stuck on a dead attempt.
async function connectDatabase() {
    if (!connectionPromise) {
        connectionPromise = client.connect()
            .then(async () => {
                console.log("✅ MongoDB Connected");
                // Enforces at the database level that a single Stripe Checkout
                // Session can only ever back one payment record, independent of
                // any application-level race in handlePaymentSuccess.
                await collections.payments.createIndex({ sessionId: 1 }, { unique: true });
                // Enforces at the database level that a parcel can have at most
                // one active (still-occupying-the-slot) checkout session row at
                // a time - see services/checkoutSessionManager.js. Partial index
                // filters support only simple equality, so `active` is a plain
                // boolean rather than an enum of in-progress statuses.
                await collections.checkoutSessions.createIndex(
                    { parcelId: 1 },
                    { unique: true, partialFilterExpression: { active: true } }
                );
                return { db, collections };
            })
            .catch((error) => {
                console.error("❌ Database connection error:", error.message);
                connectionPromise = null;
                throw error;
            });
    }
    return connectionPromise;
}

module.exports = {
    connectDatabase,
    collections,
    client,
};
