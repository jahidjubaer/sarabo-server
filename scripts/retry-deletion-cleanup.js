// Idempotent retry for durable deletion Storage cleanup (Phase 6.5 Unit 8, Fix
// 2). When a repair request is safely deleted, its trusted Firebase Storage
// object keys are recorded in a durable `deletionCleanups` record BEFORE the
// source metadata is removed (see controllers/parcelController.js#deleteParcel
// and services/deletionCleanup.js). The immediate post-commit cleanup pass
// normally removes that record; if any Storage delete failed (outage, transient
// error, process crash) the record is retained. This script finishes those
// retained cleanups.
//
// Safety properties:
//   - Deletes ONLY the exact keys stored in each cleanup record - never a
//     prefix scan, never a regex/wildcard match, never a derived key.
//   - Keys were only ever collected from trusted server-side records; this
//     script never accepts keys from any external/client input.
//   - A not-found object counts as success (idempotent) - re-running is safe.
//   - A cleanup record is removed only once every one of its keys is resolved;
//     a still-failing key keeps the record for the next run.
//   - No background worker: this is a one-shot, explicitly-run script.
//   - Refuses to run against production unless explicitly overridden, so it can
//     never be pointed at a production bucket by accident.
//
// Usage (local/dev):
//   node scripts/retry-deletion-cleanup.js
// Production (deliberate, opt-in only):
//   NODE_ENV=production ALLOW_PROD_DELETION_CLEANUP=true node scripts/retry-deletion-cleanup.js

const { runStorageCleanup } = require('../services/deletionCleanup');

// Testable core: processes every pending cleanup record with the shared,
// idempotent routine. Injectable cleanupModel/storage so tests exercise it
// against a fake bucket and never touch a real one.
async function retryDeletionCleanups({ cleanupModel, storage }) {
    const pending = await cleanupModel.findAllPending();
    let resolved = 0;
    let retained = 0;
    for (const record of pending) {
        const result = await runStorageCleanup({
            storage,
            cleanupModel,
            requestId: record._id,
            storageKeys: record.storageKeys || [],
        });
        if (result.resolved) resolved++;
        else retained++;
    }
    return { scanned: pending.length, resolved, retained };
}

if (require.main === module) {
    require('dotenv').config();

    // Production guard: this script deletes real Storage objects, so it must
    // never run against a production bucket unless the operator explicitly
    // opts in. Development/test is the intended, default-safe environment.
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_DELETION_CLEANUP !== 'true') {
        console.error('Refusing to run deletion-cleanup retry under NODE_ENV=production.');
        console.error('Re-run with ALLOW_PROD_DELETION_CLEANUP=true only if this is a deliberate, reviewed production cleanup.');
        process.exit(1);
    }

    const { connectDatabase, collections, client } = require('../config/database');
    const { initializeModels } = require('../models');
    const { resolveDatabaseName } = require('../config/databaseName');
    const { damageStorageService } = require('../services/damageStorageService');

    (async () => {
        console.log(`Deletion-cleanup retry - database: "${resolveDatabaseName()}"`);
        await connectDatabase();
        const models = initializeModels(collections);
        const summary = await retryDeletionCleanups({ cleanupModel: models.DeletionCleanup, storage: damageStorageService });
        console.log(`Scanned ${summary.scanned} pending cleanup record(s): ${summary.resolved} resolved, ${summary.retained} retained for a future retry.`);
        await client.close();
    })().catch(async (error) => {
        console.error('Deletion-cleanup retry failed:', error.message);
        try {
            const { client } = require('../config/database');
            await client.close();
        } catch (_) { /* already closed / never opened */ }
        process.exit(1);
    });
}

module.exports = { retryDeletionCleanups };
