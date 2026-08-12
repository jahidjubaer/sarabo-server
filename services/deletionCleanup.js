// Durable Storage cleanup for deleted repair requests (Phase 6.5 Unit 8, Fix
// 2). Shared by controllers/repairRequestController.js#deleteRepairRequest (the immediate
// post-commit pass) and scripts/retry-deletion-cleanup.js (the retry path), so
// both behave identically and idempotently.
//
// Deletes ONLY the exact storage keys recorded in the durable cleanup record
// (which itself only ever holds keys collected from trusted server-side
// records). Never derives, expands, prefix-matches, or regex-matches keys - an
// object is removed if and only if its full key was durably captured at
// deletion time. A not-found object counts as success (deleteObject resolves,
// never throws, for a missing object), which is exactly what makes retries
// idempotent: an object deleted by an earlier pass simply reports resolved on
// the next one.
async function runStorageCleanup({ storage, cleanupModel, requestId, storageKeys }) {
    const keys = Array.isArray(storageKeys) ? storageKeys : [];
    const remaining = [];
    let lastErrorCode = null;

    for (const storageKey of keys) {
        try {
            // deleteObject resolves (not throws) for an already-missing object,
            // so not-found is treated as resolved here.
            await storage.deleteObject({ storageKey });
        } catch (error) {
            remaining.push(storageKey);
            lastErrorCode = error && error.code ? error.code : 'STORAGE_UNAVAILABLE';
        }
    }

    if (remaining.length === 0) {
        // Every object resolved (deleted or already gone) - the cleanup record
        // is no longer needed and is removed. This is the only place the record
        // is deleted, so a record only ever disappears once all its keys are
        // resolved.
        await cleanupModel.remove(requestId);
        return { resolved: true, remaining: [] };
    }

    // Some objects still could not be removed - keep the record (narrowed to
    // the still-failing keys) so a later retry can finish the job.
    await cleanupModel.retainRemaining(requestId, { storageKeys: remaining, lastErrorCode });
    return { resolved: false, remaining, lastErrorCode };
}

module.exports = { runStorageCleanup };
