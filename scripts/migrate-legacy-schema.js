// One-time, production-safe migration of pre-rename ("zap_shift"-era) data to
// the canonical Sarabo schema (release-prep phase).
//
// The current server reads only the canonical names (docs/data-model-glossary.md).
// A database last written by the pre-rename server (origin/main 73d6604 and
// earlier) still holds its data under the old names, which the current server
// would silently treat as empty. This script brings that data across.
//
// STRATEGY: copy-and-rename, never move.
//   Renamed collections are COPIED into the canonical collection, one document
//   at a time with the SAME _id, applying the field/value renames below. The
//   source collection is never modified or dropped - it stays as the rollback
//   copy and can be removed in a later, separate release.
//     parcels            -> repair_requests     riderId/riderEmail/riderName -> technicianId/technicianEmail/technicianName,
//                                                parcelName -> deviceName
//     riders             -> technicians         (no field changes)
//     trackings          -> tracking_events     status parcel_created -> repair_request_created,
//                                                parcel_paid -> repair_request_paid (+ the derived `details` text)
//     checkoutSessions   -> checkout_sessions   parcelId -> requestId
//     serviceDefinitions -> service_definitions (no field changes; normally absent)
//   Collections whose NAME did not change are updated additively in place:
//     payments           parcelId kept, requestId ADDED with the same value
//   Nothing else needs to change: users, notifications (types, action URLs,
//   entity ids and the trackingId metadata are all still valid; legacy
//   entityType values 'parcel'/'rider' are never read by the server or client
//   and are reported, not rewritten), and every status/workStatus value is a
//   frozen contract value the current server still uses.
//
// SAFETY
//   - Dry run by default. Writes need --confirm (--dry-run always wins).
//   - Always needs --expect-db=<exact resolved database name>.
//   - A production target (production environment, or a database whose name
//     contains "production") additionally needs ALLOW_PROD_SCHEMA_MIGRATION=true
//     (scripts/lib/productionGuard.js). No global safety switch exists.
//   - Validates everything first (below). Any blocking problem -> no writes.
//   - An existing target document with the same _id must be IDENTICAL to what
//     this script would write, or the run stops: nothing is ever overwritten.
//   - All document writes happen in ONE transaction: either every copy and
//     payment update lands, or none does. (Target collections and their
//     required unique indexes are created just before it - empty collections
//     and indexes the server would create on startup anyway.)
//   - Idempotent: a rerun finds every document already identical and writes
//     nothing.
//   - Prints counts and at most a few ObjectIds per issue - never emails,
//     names, amounts or any other document content, and never MONGO_URI.
//
// VALIDATION (blocking unless noted)
//   - a document holding both an old and a new field name with different values
//   - a target document with the same _id that differs (conflict)
//   - repair requests: missing/non-string trackingId, duplicate trackingId
//     (unique index), malformed technicianId, a technicianId with no technician,
//     or whose technician's email differs from technicianEmail
//   - tracking events: non-string trackingId
//   - checkout sessions: missing requestId, more than one ACTIVE session per
//     request (partial unique index)
//   - payments: both parcelId and requestId with different values, duplicate
//     sessionId, more than one paid payment for the same request
//   - service definitions: duplicate product/repair key
//   - an existing target index with the same key but different options
//   - more than MAX_DOCUMENTS_PER_RUN documents to write (one transaction)
//   Warnings only (copied/kept unchanged): tracking events, payments, checkout
//   sessions and notifications that point at a repair request that no longer
//   exists (the pre-rename server's admin delete removed only the request),
//   exact-duplicate tracking events, duplicate technician emails.
//
// Usage (see docs/production-data-migration.md):
//   node scripts/migrate-legacy-schema.js --expect-db=<name>              dry run
//   node scripts/migrate-legacy-schema.js --expect-db=<name> --confirm    write + verify
//   Production: prefix ALLOW_PROD_SCHEMA_MIGRATION=true

const { ObjectId, BSON } = require('mongodb');

const PRODUCTION_OVERRIDE_VAR = 'ALLOW_PROD_SCHEMA_MIGRATION';
const MAX_DOCUMENTS_PER_RUN = 10000;
const SAMPLE_LIMIT = 3;

const REPAIR_REQUEST_FIELD_RENAMES = Object.freeze({
    riderId: 'technicianId',
    riderEmail: 'technicianEmail',
    riderName: 'technicianName',
    parcelName: 'deviceName',
});
const CHECKOUT_SESSION_FIELD_RENAMES = Object.freeze({ parcelId: 'requestId' });
const TRACKING_STATUS_RENAMES = Object.freeze({
    parcel_created: 'repair_request_created',
    parcel_paid: 'repair_request_paid',
});

const COLLECTION_MIGRATIONS = Object.freeze([
    { source: 'parcels', target: 'repair_requests', kind: 'repairRequest' },
    { source: 'riders', target: 'technicians', kind: 'technician' },
    { source: 'trackings', target: 'tracking_events', kind: 'trackingEvent' },
    { source: 'checkoutSessions', target: 'checkout_sessions', kind: 'checkoutSession' },
    { source: 'serviceDefinitions', target: 'service_definitions', kind: 'serviceDefinition' },
]);

// The unique indexes the current server creates on these targets at startup
// (config/database.js) - created here, before the copy, so the database itself
// enforces them inside the migration transaction.
const REQUIRED_TARGET_INDEXES = Object.freeze([
    { collection: 'repair_requests', key: { trackingId: 1 }, options: { unique: true } },
    { collection: 'checkout_sessions', key: { requestId: 1 }, options: { unique: true, partialFilterExpression: { active: true } } },
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Structural equality that understands BSON values (ObjectId, Date, Decimal128,
// Binary, ...) and ignores key order.
function bsonEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    if (a instanceof Date || b instanceof Date) {
        return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    if (a._bsontype || b._bsontype) {
        return a._bsontype === b._bsontype
            && BSON.EJSON.stringify(a, { relaxed: false }) === BSON.EJSON.stringify(b, { relaxed: false });
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => bsonEqual(value, b[i]));
    }
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && bsonEqual(a[key], b[key]));
}

// Renames top-level fields, keeping key order. A document that already holds
// the NEW name with a DIFFERENT value is a conflict (reported, never guessed).
function renameFields(doc, renames) {
    const newNames = new Set(Object.values(renames));
    const oldForNew = Object.fromEntries(Object.entries(renames).map(([oldName, newName]) => [newName, oldName]));
    const out = {};
    const conflicts = [];
    for (const key of Object.keys(doc)) {
        if (Object.prototype.hasOwnProperty.call(renames, key)) {
            const newKey = renames[key];
            if (Object.prototype.hasOwnProperty.call(doc, newKey) && !bsonEqual(doc[newKey], doc[key])) {
                conflicts.push(`${key}/${newKey}`);
            }
            out[newKey] = doc[key];
        } else if (newNames.has(key) && Object.prototype.hasOwnProperty.call(doc, oldForNew[key])) {
            // Written from its old name above (equal, or a reported conflict).
            continue;
        } else {
            out[key] = doc[key];
        }
    }
    return { doc: out, conflicts };
}

function transformTrackingEvent(doc) {
    const out = { ...doc };
    const renamed = TRACKING_STATUS_RENAMES[doc.status];
    if (renamed) {
        out.status = renamed;
        // `details` is derived from the status when logged; only a still-derived
        // value follows the rename, anything else is kept as written.
        if (doc.details === doc.status.split('_').join(' ')) {
            out.details = renamed.split('_').join(' ');
        }
    }
    return { doc: out, conflicts: [] };
}

function transformDocument(kind, doc) {
    if (kind === 'repairRequest') return renameFields(doc, REPAIR_REQUEST_FIELD_RENAMES);
    if (kind === 'checkoutSession') return renameFields(doc, CHECKOUT_SESSION_FIELD_RENAMES);
    if (kind === 'trackingEvent') return transformTrackingEvent(doc);
    return { doc: { ...doc }, conflicts: [] };
}

function idKey(value) {
    return value && typeof value.toHexString === 'function' ? value.toHexString() : String(value);
}

function resolveRunMode(argv) {
    const args = argv || [];
    const confirm = args.includes('--confirm');
    const explicitDryRun = args.includes('--dry-run');
    return { dryRun: explicitDryRun || !confirm };
}

// Small issue collector: counts + a few sample ids, never document contents.
function createIssues() {
    const blocking = new Map();
    const warnings = new Map();
    function add(map, code, message, sample) {
        if (!map.has(code)) map.set(code, { code, message, count: 0, samples: [] });
        const entry = map.get(code);
        entry.count += 1;
        if (sample !== undefined && entry.samples.length < SAMPLE_LIMIT) entry.samples.push(idKey(sample));
    }
    return {
        block: (code, message, sample) => add(blocking, code, message, sample),
        warn: (code, message, sample) => add(warnings, code, message, sample),
        result: () => ({ blocking: [...blocking.values()], warnings: [...warnings.values()] }),
    };
}

function groupCount(values) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
}

// ---------------------------------------------------------------------------
// Plan (read-only)
// ---------------------------------------------------------------------------

async function listCollectionNames(db) {
    return new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
}

async function planMigration(db) {
    const issues = createIssues();
    const existing = await listCollectionNames(db);
    const collections = [];
    const finalDocs = {}; // target name -> documents as they will stand after the run
    let writeCount = 0;

    for (const migration of COLLECTION_MIGRATIONS) {
        const sourceExists = existing.has(migration.source);
        const targetExists = existing.has(migration.target);
        const sourceDocs = sourceExists ? await db.collection(migration.source).find({}).toArray() : [];
        const targetDocs = targetExists ? await db.collection(migration.target).find({}).toArray() : [];
        const targetById = new Map(targetDocs.map((doc) => [idKey(doc._id), doc]));
        const sourceIds = new Set();
        const toInsert = [];
        let identical = 0;
        let conflicts = 0;

        for (const sourceDoc of sourceDocs) {
            sourceIds.add(idKey(sourceDoc._id));
            const { doc, conflicts: fieldConflicts } = transformDocument(migration.kind, sourceDoc);
            if (fieldConflicts.length > 0) {
                issues.block('field-conflict', `${migration.source}: a document holds both an old and a new field name with different values`, sourceDoc._id);
                conflicts += 1;
                continue;
            }
            const current = targetById.get(idKey(sourceDoc._id));
            if (current) {
                if (bsonEqual(current, doc)) {
                    identical += 1;
                } else {
                    issues.block('target-conflict', `${migration.target}: a document with the same _id already exists and differs (never overwritten)`, sourceDoc._id);
                    conflicts += 1;
                }
            } else {
                toInsert.push(doc);
            }
        }

        const targetOnly = targetDocs.filter((doc) => !sourceIds.has(idKey(doc._id)));
        finalDocs[migration.target] = [
            ...targetOnly,
            ...targetDocs.filter((doc) => sourceIds.has(idKey(doc._id))),
            ...toInsert,
        ];
        writeCount += toInsert.length;
        collections.push({
            source: migration.source,
            target: migration.target,
            sourceExists,
            sourceCount: sourceDocs.length,
            targetCount: targetDocs.length,
            toInsert,
            identical,
            conflicts,
            targetOnly: targetOnly.length,
        });
    }

    // ---- Relationship / uniqueness validation over the final state ----
    const repairs = finalDocs.repair_requests;
    const technicians = finalDocs.technicians;
    const repairIds = new Set(repairs.map((doc) => idKey(doc._id)));
    const repairTrackingIds = new Set(repairs.filter((doc) => typeof doc.trackingId === 'string').map((doc) => doc.trackingId));
    const technicianById = new Map(technicians.map((doc) => [idKey(doc._id), doc]));

    for (const doc of repairs) {
        if (typeof doc.trackingId !== 'string' || !doc.trackingId) {
            issues.block('repair-missing-tracking-id', 'repair_requests: document without a string trackingId (the unique index needs one)', doc._id);
        }
        if (doc.technicianId !== undefined && doc.technicianId !== null) {
            const technicianId = idKey(doc.technicianId);
            if (!ObjectId.isValid(technicianId) || technicianId.length !== 24) {
                issues.block('invalid-technician-reference', 'repair_requests: technicianId is not a valid id', doc._id);
            } else if (!technicianById.has(technicianId)) {
                issues.block('dangling-technician-reference', 'repair_requests: technicianId points to no technician', doc._id);
            } else {
                const technician = technicianById.get(technicianId);
                if (typeof doc.technicianEmail === 'string' && typeof technician.email === 'string'
                    && doc.technicianEmail.toLowerCase() !== technician.email.toLowerCase()) {
                    issues.block('technician-email-mismatch', 'repair_requests: technicianEmail differs from the referenced technician', doc._id);
                }
            }
        }
    }
    for (const [trackingId, count] of groupCount(repairs.filter((d) => typeof d.trackingId === 'string').map((d) => d.trackingId))) {
        if (count > 1) issues.block('duplicate-tracking-id', `repair_requests: trackingId shared by ${count} documents (unique index)`, trackingId);
    }

    for (const count of groupCount(technicians.filter((d) => typeof d.email === 'string').map((d) => d.email.toLowerCase())).values()) {
        if (count > 1) issues.warn('duplicate-technician-email', `technicians: ${count} records share one email`, undefined);
    }

    const events = finalDocs.tracking_events;
    for (const doc of events) {
        if (typeof doc.trackingId !== 'string') {
            issues.block('tracking-event-shape', 'tracking_events: event without a string trackingId', doc._id);
        } else if (!repairTrackingIds.has(doc.trackingId)) {
            issues.warn('orphan-tracking-event', 'tracking_events: event for a repair request that no longer exists (kept as-is)', doc._id);
        }
    }
    const eventKeys = events.map((d) => `${d.trackingId}|${d.status}|${d.createdAt instanceof Date ? d.createdAt.getTime() : d.createdAt}`);
    for (const count of groupCount(eventKeys).values()) {
        if (count > 1) issues.warn('duplicate-tracking-event', 'tracking_events: identical events (same request, status and time) - kept as-is', undefined);
    }

    const checkouts = finalDocs.checkout_sessions;
    for (const doc of checkouts) {
        if (doc.requestId === undefined || doc.requestId === null || doc.requestId === '') {
            issues.block('checkout-missing-request', 'checkout_sessions: session without a requestId', doc._id);
        } else if (!repairIds.has(idKey(doc.requestId))) {
            issues.warn('orphan-checkout-session', 'checkout_sessions: session for a repair request that no longer exists (kept as-is)', doc._id);
        }
    }
    for (const [requestId, count] of groupCount(checkouts.filter((d) => d.active === true && d.requestId).map((d) => idKey(d.requestId)))) {
        if (count > 1) issues.block('duplicate-active-checkout', `checkout_sessions: ${count} active sessions for one request (partial unique index)`, requestId);
    }

    for (const [key, count] of groupCount(finalDocs.service_definitions.map((d) => `${d.productCategorySlug}/${d.repairCategorySlug}`))) {
        if (count > 1) issues.block('duplicate-service-definition', `service_definitions: ${count} rows share one product/repair key`, key);
    }

    // ---- payments: additive in-place requestId ----
    const payments = existing.has('payments') ? await db.collection('payments').find({}).toArray() : [];
    const paymentUpdates = [];
    let paymentsAlreadyLinked = 0;
    let paymentsWithoutReference = 0;
    for (const doc of payments) {
        const hasParcel = doc.parcelId !== undefined && doc.parcelId !== null;
        const hasRequest = doc.requestId !== undefined && doc.requestId !== null;
        if (hasParcel && hasRequest) {
            if (bsonEqual(doc.parcelId, doc.requestId)) paymentsAlreadyLinked += 1;
            else issues.block('payment-reference-conflict', 'payments: parcelId and requestId differ', doc._id);
        } else if (hasParcel) {
            paymentUpdates.push({ _id: doc._id, value: doc.parcelId });
        } else if (hasRequest) {
            paymentsAlreadyLinked += 1;
        } else {
            paymentsWithoutReference += 1;
            issues.warn('payment-without-reference', 'payments: payment without any repair-request reference (kept as-is)', doc._id);
        }
        const reference = hasRequest ? doc.requestId : doc.parcelId;
        if (reference !== undefined && reference !== null && !repairIds.has(idKey(reference))) {
            issues.warn('orphan-payment', 'payments: payment for a repair request that no longer exists (kept as-is)', doc._id);
        }
    }
    for (const count of groupCount(payments.filter((d) => d.sessionId).map((d) => String(d.sessionId))).values()) {
        if (count > 1) issues.block('duplicate-payment-session', `payments: ${count} payments share one sessionId`, undefined);
    }
    const paidPerRequest = groupCount(payments
        .filter((d) => d.paymentStatus === 'paid')
        .map((d) => idKey(d.requestId !== undefined && d.requestId !== null ? d.requestId : d.parcelId))
        .filter((value) => value && value !== 'undefined' && value !== 'null'));
    for (const [requestId, count] of paidPerRequest) {
        if (count > 1) issues.block('duplicate-payment', `payments: ${count} paid payments for one request`, requestId);
    }
    writeCount += paymentUpdates.length;

    // ---- notifications: report only ----
    const notifications = existing.has('notifications') ? await db.collection('notifications').find({}, { projection: { entityType: 1, entityId: 1 } }).toArray() : [];
    const legacyEntityTypes = notifications.filter((d) => d.entityType === 'parcel' || d.entityType === 'rider').length;
    for (const doc of notifications) {
        if ((doc.entityType === 'parcel' || doc.entityType === 'repair_request') && doc.entityId && !repairIds.has(idKey(doc.entityId))) {
            issues.warn('orphan-notification', 'notifications: notification about a repair request that no longer exists (kept as-is)', doc._id);
        }
    }

    // ---- index compatibility ----
    for (const required of REQUIRED_TARGET_INDEXES) {
        if (!existing.has(required.collection)) continue;
        const indexes = await db.collection(required.collection).indexes();
        const sameKey = indexes.find((index) => bsonEqual(index.key, required.key));
        if (sameKey) {
            const uniqueMatches = !!sameKey.unique === !!required.options.unique;
            const partialMatches = bsonEqual(sameKey.partialFilterExpression || null, required.options.partialFilterExpression || null);
            if (!uniqueMatches || !partialMatches) {
                issues.block('index-conflict', `${required.collection}: an index on ${JSON.stringify(required.key)} exists with different options`, undefined);
            }
        }
    }

    if (writeCount > MAX_DOCUMENTS_PER_RUN) {
        issues.block('too-large-for-one-transaction', `more than ${MAX_DOCUMENTS_PER_RUN} documents to write - this script is sized for one transaction`, undefined);
    }

    const { blocking, warnings } = issues.result();
    return {
        ok: blocking.length === 0,
        collections,
        payments: { total: payments.length, toLink: paymentUpdates.length, alreadyLinked: paymentsAlreadyLinked, withoutReference: paymentsWithoutReference, updates: paymentUpdates },
        notifications: { total: notifications.length, legacyEntityTypes },
        writeCount,
        blocking,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Execute (writes) + verify
// ---------------------------------------------------------------------------

async function sourceCounts(db) {
    const existing = await listCollectionNames(db);
    const counts = {};
    for (const name of [...COLLECTION_MIGRATIONS.map((m) => m.source), 'payments', 'notifications', 'users']) {
        counts[name] = existing.has(name) ? await db.collection(name).countDocuments({}) : 0;
    }
    return counts;
}

// Runs the plan. Refuses when the plan has blocking issues. `hooks.failAfterInserts`
// (tests only) throws inside the transaction after that many inserted batches,
// to prove nothing partial survives.
async function executeMigration({ db, client, plan, hooks = {} }) {
    if (!plan.ok) {
        return { executed: false, reason: 'plan has blocking issues', inserted: 0, paymentsLinked: 0 };
    }
    if (plan.writeCount === 0) {
        return { executed: true, inserted: 0, paymentsLinked: 0 };
    }

    // Collections + required unique indexes first (outside the transaction:
    // index builds cannot run inside one). Only for targets that receive data.
    const existing = await listCollectionNames(db);
    for (const entry of plan.collections) {
        if (entry.toInsert.length > 0 && !existing.has(entry.target)) {
            await db.createCollection(entry.target);
        }
    }
    for (const required of REQUIRED_TARGET_INDEXES) {
        const entry = plan.collections.find((c) => c.target === required.collection);
        if (entry && (entry.toInsert.length > 0 || entry.targetCount > 0)) {
            await db.collection(required.collection).createIndex(required.key, required.options);
        }
    }

    const session = client.startSession();
    let inserted = 0;
    let paymentsLinked = 0;
    try {
        await session.withTransaction(async () => {
            inserted = 0;
            paymentsLinked = 0;
            let batches = 0;
            for (const entry of plan.collections) {
                if (entry.toInsert.length === 0) continue;
                const result = await db.collection(entry.target).insertMany(entry.toInsert, { session, ordered: true });
                inserted += result.insertedCount;
                batches += 1;
                if (hooks.failAfterInserts !== undefined && batches >= hooks.failAfterInserts) {
                    throw new Error('simulated failure inside the migration transaction');
                }
            }
            for (const update of plan.payments.updates) {
                // Guarded: only while the payment still has exactly this
                // parcelId and no requestId, so a concurrent change aborts the
                // whole transaction instead of being overwritten.
                const result = await db.collection('payments').updateOne(
                    { _id: update._id, parcelId: update.value, requestId: { $exists: false } },
                    { $set: { requestId: update.value } },
                    { session }
                );
                if (result.matchedCount !== 1) {
                    throw new Error('a payment changed while the migration ran - aborted, nothing written');
                }
                paymentsLinked += 1;
            }
        });
    } finally {
        await session.endSession();
    }
    return { executed: true, inserted, paymentsLinked };
}

async function verifyMigration({ db, expectedSourceCounts }) {
    const checks = [];
    const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

    const plan = await planMigration(db);
    const pendingInserts = plan.collections.reduce((sum, c) => sum + c.toInsert.length, 0);
    check('every source document is present, unchanged, in its target (same _id)', pendingInserts === 0 && plan.blocking.every((b) => b.code !== 'target-conflict'), `${pendingInserts} still pending`);
    check('every payment carries requestId', plan.payments.toLink === 0, `${plan.payments.toLink} still unlinked`);
    check('no blocking issue in the migrated data', plan.ok, plan.blocking.map((b) => b.code).join(', ') || 'none');

    const after = await sourceCounts(db);
    const unchanged = Object.keys(expectedSourceCounts).every((name) => after[name] === expectedSourceCounts[name]);
    check('source collections still exist with unchanged counts (nothing deleted)', unchanged, JSON.stringify(after));

    const existing = await listCollectionNames(db);
    for (const entry of plan.collections) {
        if (!existing.has(entry.target)) continue;
        const readable = await db.collection(entry.target).findOne({}, { projection: { _id: 1 } });
        check(`${entry.target} is readable`, readable !== undefined, entry.target);
    }
    for (const required of REQUIRED_TARGET_INDEXES) {
        if (!existing.has(required.collection)) continue;
        const indexes = await db.collection(required.collection).indexes();
        check(`${required.collection} has its unique index on ${Object.keys(required.key).join(',')}`, indexes.some((index) => bsonEqual(index.key, required.key) && !!index.unique), required.collection);
    }

    return { ok: checks.every((c) => c.ok), checks, plan };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatPlan(plan) {
    const lines = [];
    lines.push('Collections (copy, same _id; source never modified):');
    for (const c of plan.collections) {
        lines.push(`  ${c.source.padEnd(19)} -> ${c.target.padEnd(20)} source ${String(c.sourceCount).padStart(5)}${c.sourceExists ? '' : ' (absent)'} | target now ${String(c.targetCount).padStart(5)} | to copy ${String(c.toInsert.length).padStart(5)} | already identical ${String(c.identical).padStart(5)} | conflicts ${c.conflicts} | target-only ${c.targetOnly}`);
    }
    lines.push(`payments (in place, additive requestId): total ${plan.payments.total} | to link ${plan.payments.toLink} | already linked ${plan.payments.alreadyLinked} | no reference ${plan.payments.withoutReference}`);
    lines.push(`notifications: total ${plan.notifications.total} | legacy entityType values (left as-is, unused) ${plan.notifications.legacyEntityTypes}`);
    lines.push(`Documents to write: ${plan.writeCount}`);
    if (plan.blocking.length) {
        lines.push('BLOCKING (nothing will be written):');
        for (const b of plan.blocking) lines.push(`  ! ${b.code} x${b.count} - ${b.message}${b.samples.length ? ` [e.g. ${b.samples.join(', ')}]` : ''}`);
    }
    if (plan.warnings.length) {
        lines.push('Warnings (not blocking):');
        for (const w of plan.warnings) lines.push(`  ~ ${w.code} x${w.count} - ${w.message}${w.samples.length ? ` [e.g. ${w.samples.join(', ')}]` : ''}`);
    }
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
    require('dotenv').config();
    const { isProductionEnvironment } = require('../config/siteOrigin');
    const { resolveDatabaseName } = require('../config/databaseName');
    const { evaluateProductionGuard, readExpectedDbArg } = require('./lib/productionGuard');

    const args = process.argv.slice(2);
    const resolvedDbName = resolveDatabaseName();
    const guard = evaluateProductionGuard({
        isProduction: isProductionEnvironment(),
        resolvedDbName,
        expectedDbName: readExpectedDbArg(args),
        overrideVarName: PRODUCTION_OVERRIDE_VAR,
        overrideValue: process.env[PRODUCTION_OVERRIDE_VAR],
        requireExpectedDb: true,
    });
    if (!guard.safe) {
        console.error(`Refusing to run: ${guard.reason}.`);
        process.exit(1);
    }
    const { dryRun } = resolveRunMode(args);
    const { client } = require('../config/database');

    (async () => {
        console.log(`Legacy schema migration - database: "${resolvedDbName}"${guard.productionTarget ? ' (PRODUCTION)' : ''}, mode: ${dryRun ? 'DRY RUN (no writes)' : 'WRITE (--confirm)'}`);
        console.log('');
        await client.connect();
        const db = client.db(resolvedDbName);
        const plan = await planMigration(db);
        console.log(formatPlan(plan));
        console.log('');

        if (!plan.ok) {
            console.error('Migration NOT OK - blocking issues found. Nothing was written.');
            process.exitCode = 1;
            return;
        }
        if (dryRun) {
            console.log(plan.writeCount === 0
                ? 'Dry run: nothing to migrate - every document is already in place.'
                : 'Dry run only - nothing was written. Re-run with --confirm to apply.');
            return;
        }

        const before = await sourceCounts(db);
        const result = await executeMigration({ db, client, plan });
        console.log(`Written: ${result.inserted} document(s) copied, ${result.paymentsLinked} payment(s) linked.`);
        const verification = await verifyMigration({ db, expectedSourceCounts: before });
        console.log('');
        console.log('Verification:');
        for (const c of verification.checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}`);
        if (!verification.ok) {
            console.error('Verification FAILED - investigate before deploying. Source collections were not modified.');
            process.exitCode = 1;
        } else {
            console.log('Migration verified. Source collections are untouched and remain as the rollback copy.');
        }
    })()
        .catch((error) => {
            console.error('Migration execution error:', error.message);
            process.exitCode = 1;
        })
        .finally(async () => {
            await client.close();
        });
}

module.exports = {
    PRODUCTION_OVERRIDE_VAR,
    MAX_DOCUMENTS_PER_RUN,
    REPAIR_REQUEST_FIELD_RENAMES,
    CHECKOUT_SESSION_FIELD_RENAMES,
    TRACKING_STATUS_RENAMES,
    COLLECTION_MIGRATIONS,
    REQUIRED_TARGET_INDEXES,
    bsonEqual,
    renameFields,
    transformDocument,
    resolveRunMode,
    planMigration,
    executeMigration,
    verifyMigration,
    sourceCounts,
    formatPlan,
};
