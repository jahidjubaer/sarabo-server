// Read-only audit for the damageUploadSessions collection (Phase 6.4
// Unit 1, Phase R). Never deletes or modifies anything - no MongoDB
// document, no Firebase Storage object. Reports counts only.
//
// Full destructive cleanup (removing expired sessions together with their
// orphaned Firebase Storage objects) is deliberately deferred to a future
// unit: it requires cross-referencing MongoDB session state against actual
// Storage bucket contents, which is more than this foundation unit's scope
// warrants, and risky to build without its own dedicated safety review
// (dry-run default, explicit confirmation, production guard, exact
// repair-requests/ prefix scoping, never touching finalized images or
// unknown objects - see the Unit 1 report's Phase R decision). This script
// only ever reads MongoDB; it never contacts Firebase Storage at all, so it
// carries none of those risks.
//
// Usage:
//   node scripts/audit-damage-uploads.js

const KNOWN_STATUSES = ['pending', 'uploaded', 'finalized', 'expired', 'cancelled', 'failed'];

async function auditDamageUploads(collection, { now = new Date() } = {}) {
    const [statusRows, expiredNonFinalizedCount, oldestPendingRows] = await Promise.all([
        collection.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]).toArray(),
        collection.countDocuments({ status: { $in: ['pending', 'uploaded'] }, expiresAt: { $lte: now } }),
        collection.find({ status: { $in: ['pending', 'uploaded'] } }).sort({ createdAt: 1 }).limit(1).toArray()
    ]);

    return {
        statusCounts: Object.fromEntries(statusRows.map((row) => [row._id, row.count])),
        expiredNonFinalizedCount,
        oldestPendingCreatedAt: oldestPendingRows[0] ? oldestPendingRows[0].createdAt : null
    };
}

if (require.main === module) {
    require('dotenv').config();
    const { connectDatabase, collections, client } = require('../config/database');
    const { resolveDatabaseName } = require('../config/databaseName');

    (async () => {
        console.log(`Damage-upload session audit - database: "${resolveDatabaseName()}" (read-only, no writes/deletes)`);
        console.log('');

        await connectDatabase();
        const result = await auditDamageUploads(collections.damageUploadSessions);

        console.log('Sessions by status:');
        for (const status of KNOWN_STATUSES) {
            console.log(`  ${status.padEnd(10)} ${result.statusCounts[status] || 0}`);
        }
        console.log('');
        console.log(`Expired, still non-finalized sessions: ${result.expiredNonFinalizedCount}`);
        console.log(`Oldest still-pending session created:  ${result.oldestPendingCreatedAt || 'n/a'}`);
        console.log('');
        console.log('This script is read-only: no MongoDB documents and no Firebase Storage');
        console.log('objects were modified or deleted. Destructive cleanup is deferred to a');
        console.log('future unit - see the comment at the top of this file.');
    })()
        .catch((error) => {
            console.error('Audit execution error:', error.message);
            process.exitCode = 1;
        })
        .finally(async () => {
            await client.close();
        });
}

module.exports = { auditDamageUploads };
