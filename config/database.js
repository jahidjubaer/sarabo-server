const { MongoClient, ServerApiVersion } = require("mongodb");
const { resolveDatabaseName } = require('./databaseName');

const uri = process.env.MONGO_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    },
});

// Fails fast at module load if MONGO_DB_NAME is missing/invalid in
// production, or lacks an explicit test marker under NODE_ENV=test - see
// config/databaseName.js for the exact rules. Development falls back to the
// Sarabo development database name (sarabo-db).
const DB_NAME = resolveDatabaseName();

// Collection handles are synchronous and side-effect-free - creating them
// does not require an active connection, only a MongoClient instance. This
// lets routes/models/controllers be built and registered immediately at
// module load, before the connection itself resolves. Actual queries against
// these collections require connectDatabase() to have resolved first, which
// is enforced per-request by middleware/database.js.
const db = client.db(DB_NAME);
// Phase 8.7B: the Mongo COLLECTION names are the canonical Sarabo domain names
// in snake_case (technicians / repair_requests / service_definitions /
// tracking_events / ...). The JS handle keys below (e.g. `riders`, `parcels`)
// are internal code vocabulary whose rename to `technicians`/`repairRequests`
// is deferred to a follow-up phase - the on-disk collection contract migrates
// here now, so nothing is ever created under the old `riders`/`parcels` names.
const collections = {
    users: db.collection("users"),
    parcels: db.collection("repair_requests"),
    payments: db.collection("payments"),
    riders: db.collection("technicians"),
    trackings: db.collection("tracking_events"),
    checkoutSessions: db.collection("checkout_sessions"),
    notifications: db.collection("notifications"),
    serviceDefinitions: db.collection("service_definitions"),
    damageUploadSessions: db.collection("damage_upload_sessions"),
    repairEvidenceSessions: db.collection("repair_evidence_sessions"),
    deletionCleanups: db.collection("deletion_cleanups"),
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
                // Enforces uniqueness of trackingId at the database level -
                // this is also the public tracking lookup key (see
                // controllers/trackingController.js's getPublicTracking), so
                // two repair requests must never be able to collide onto the
                // same code.
                await collections.parcels.createIndex({ trackingId: 1 }, { unique: true });
                // Notification foundation (Phase 5.2 Unit 1) - no business
                // workflow creates notifications yet, but the collection and
                // its indexes are established up front. No TTL index: unread
                // notifications must never silently expire, and notification
                // deletion is a separate concern from repair-record retention.
                //
                // Primary inbox read path - "this recipient's notifications,
                // newest first".
                await collections.notifications.createIndex(
                    { recipientEmail: 1, createdAt: -1 },
                    { name: 'notifications_recipient_createdAt' }
                );
                // Unread-count / unread-filtered list for the same recipient.
                await collections.notifications.createIndex(
                    { recipientEmail: 1, isRead: 1, createdAt: -1 },
                    { name: 'notifications_recipient_isRead_createdAt' }
                );
                // Enforces deterministic deduplication at the database level -
                // a duplicate-key error here is the expected, intentional
                // signal that this exact logical event already produced a
                // notification (see services/notificationService.js's
                // createNotification), the same pattern already used for
                // payments.sessionId and parcels.trackingId above.
                await collections.notifications.createIndex(
                    { deduplicationKey: 1 },
                    { unique: true, name: 'notifications_deduplicationKey_unique' }
                );
                // Entity-audit lookup - "every notification tied to this
                // repair request/technician application".
                await collections.notifications.createIndex(
                    { entityType: 1, entityId: 1, createdAt: -1 },
                    { name: 'notifications_entity_createdAt' }
                );
                // Service-definition taxonomy foundation (Phase 6.3 Unit 2).
                // Enforces uniqueness of the product/repair category pair at
                // the database level - the same "guard the invariant in the
                // database, not just in application code" pattern already
                // used above for payments.sessionId, checkoutSessions.parcelId,
                // and parcels.trackingId.
                await collections.serviceDefinitions.createIndex(
                    { productCategorySlug: 1, repairCategorySlug: 1 },
                    { unique: true, name: 'serviceDefinitions_product_repair_unique' }
                );
                // Default public read path - "active definitions only".
                await collections.serviceDefinitions.createIndex(
                    { isActive: 1 },
                    { name: 'serviceDefinitions_isActive' }
                );
                // A standalone productCategorySlug index would be redundant:
                // the compound unique index above already serves as an
                // efficient prefix index for productCategorySlug-only
                // queries. repairCategorySlug alone is NOT a prefix of that
                // compound index, so it gets its own index here.
                await collections.serviceDefinitions.createIndex(
                    { repairCategorySlug: 1 },
                    { name: 'serviceDefinitions_repairCategorySlug' }
                );
                // Eligible-technician evaluation (Phase 6.3 Unit 5). The
                // candidate-fetch query filters on status+workStatus
                // together, so one compound index serves it. expertise's two
                // fields are each their own array (multikey) path -
                // MongoDB does not allow a single compound index across two
                // separate multikey (array) fields in one document, so each
                // gets its own standalone index rather than being combined.
                await collections.riders.createIndex(
                    { status: 1, workStatus: 1 },
                    { name: 'riders_status_workStatus' }
                );
                await collections.riders.createIndex(
                    { 'expertise.productCategorySlug': 1 },
                    { name: 'riders_expertise_productCategorySlug' }
                );
                await collections.riders.createIndex(
                    { 'expertise.repairCategorySlugs': 1 },
                    { name: 'riders_expertise_repairCategorySlugs' }
                );
                // Serves both the active-assignment set lookup (filtered to
                // ACTIVE_STATUSES) and the completed-repair-count aggregation
                // (filtered to 'parcel_delivered') - both query riderId
                // together with deliveryStatus, so one compound index serves
                // either regardless of which deliveryStatus values are
                // actually matched.
                await collections.parcels.createIndex(
                    { riderId: 1, deliveryStatus: 1 },
                    { name: 'parcels_riderId_deliveryStatus' }
                );
                // Damage-upload session foundation (Phase 6.4 Unit 1).
                // Enforces at the database level that a storage key can back
                // at most one upload session, independent of any
                // application-level guard - the same "guard the invariant in
                // the database, not just in application code" pattern used
                // above. Deliberately no TTL index here: an expired session
                // document does not imply its Firebase Storage object is
                // safe to garbage-collect on its own (see
                // scripts/audit-damage-uploads.js) - expiry is enforced at
                // read/finalize time via the plain expiresAt index below,
                // and any eventual destructive cleanup is a separate,
                // explicitly-run process, never an automatic TTL delete.
                await collections.damageUploadSessions.createIndex(
                    { storageKey: 1 },
                    { unique: true, name: 'damageUploadSessions_storageKey_unique' }
                );
                // Primary lookup path - "sessions for this request in this
                // status" (e.g. counting pending sessions, or scoping a
                // finalize/removal guard).
                await collections.damageUploadSessions.createIndex(
                    { requestId: 1, status: 1 },
                    { name: 'damageUploadSessions_requestId_status' }
                );
                // Non-TTL expiry index for the audit/cleanup script's
                // "expired, still non-finalized" scan.
                await collections.damageUploadSessions.createIndex(
                    { expiresAt: 1 },
                    { name: 'damageUploadSessions_expiresAt' }
                );
                // Repair completion evidence sessions (Phase 6.4 Unit 7) -
                // same design as damageUploadSessions above: a server-owned,
                // per-request-scoped storage key is unique at the database
                // level, sessions are looked up by request+status, and expiry
                // is a plain (non-TTL) index enforced at read/finalize time.
                await collections.repairEvidenceSessions.createIndex(
                    { storageKey: 1 },
                    { unique: true, name: 'repairEvidenceSessions_storageKey_unique' }
                );
                await collections.repairEvidenceSessions.createIndex(
                    { requestId: 1, status: 1 },
                    { name: 'repairEvidenceSessions_requestId_status' }
                );
                await collections.repairEvidenceSessions.createIndex(
                    { expiresAt: 1 },
                    { name: 'repairEvidenceSessions_expiresAt' }
                );
                // Durable deletion-cleanup records (Phase 6.5 Unit 8, Fix 2).
                // The record's _id IS the requestId, so uniqueness-by-request
                // is enforced by the primary key itself - no extra unique index
                // is needed, and two concurrent deletes can never create two
                // records for the same request. This plain index serves the
                // retry script's "all still-pending cleanups" scan
                // (scripts/retry-deletion-cleanup.js). No TTL: an unresolved
                // cleanup must never silently vanish while its Storage objects
                // are still orphaned - it is only ever removed once every key
                // is resolved.
                await collections.deletionCleanups.createIndex(
                    { status: 1 },
                    { name: 'deletionCleanups_status' }
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
