// Raises every service's inspection fee to the floor (utils/inspectionFee.js:
// 100 BDT for an estimate up to 1,000 BDT, 200 BDT above). Only services below
// the floor change; a fee already at or above it is left alone. A changed
// price bumps pricingRule.version, the same as an admin price edit, so new
// requests snapshot the new fee. Existing requests are not touched - the job
// portal already applies the floor to them (utils/jobPortal.js).
//
// Waiting offers (job applications still 'pending') sent before the floor are
// raised to their request's floor too, so stored offers match what the
// customer is shown and charged. Accepting one also raises it
// (jobPortalController.accept), so this is tidy-up, not the only guard.
//
// Usage:
//   node scripts/migrate-inspection-fee-floor.js             (dry-run, writes nothing)
//   node scripts/migrate-inspection-fee-floor.js --confirm   (writes)
// Production: refused unless ALLOW_PROD_FEE_FLOOR_MIGRATION=true AND
// --expect-db=<exact database name> both match (scripts/lib/productionGuard.js).
//
// runMigration() has no console/process side effects, so the test suite runs
// the same logic.
const { ObjectId } = require('mongodb');
const { minimumInspectionFee } = require('../utils/inspectionFee');
const { minInspectionFee } = require('../utils/jobPortal');

const PRODUCTION_OVERRIDE_VAR = 'ALLOW_PROD_FEE_FLOOR_MIGRATION';

async function runMigration({ collection, dryRun, now = new Date() }) {
    const docs = await collection.find({}, { projection: { productCategorySlug: 1, repairCategorySlug: 1, pricingRule: 1, updatedAt: 1 } }).toArray();
    const details = [];
    for (const doc of docs) {
        const key = `${doc.productCategorySlug}/${doc.repairCategorySlug}`;
        const pricing = doc.pricingRule || {};
        const floor = minimumInspectionFee(pricing.baseMax);
        const fee = Number(pricing.inspectionFee);
        if (Number.isFinite(fee) && fee >= floor) {
            details.push({ key, action: 'unchanged', fee });
            continue;
        }
        const detail = { key, action: dryRun ? 'would-raise' : 'raised', from: Number.isFinite(fee) ? fee : null, to: floor };
        if (!dryRun) {
            // Guarded on the values read, so a concurrent admin edit wins.
            const result = await collection.updateOne(
                { _id: doc._id, 'pricingRule.inspectionFee': pricing.inspectionFee, 'pricingRule.version': pricing.version },
                { $set: { 'pricingRule.inspectionFee': floor, 'pricingRule.version': (Number(pricing.version) || 0) + 1, updatedAt: now, updatedBy: 'migration:inspection-fee-floor' } }
            );
            if (result.modifiedCount === 0) detail.action = 'changed-since-read';
        }
        details.push(detail);
    }
    const count = (action) => details.filter((d) => d.action === action).length;
    return {
        total: docs.length,
        raised: count(dryRun ? 'would-raise' : 'raised'),
        unchanged: count('unchanged'),
        changedSinceRead: count('changed-since-read'),
        details,
    };
}

// Raises waiting offers below their request's floor. Closed offers (accepted,
// declined, withdrawn, not chosen) are history and stay as they were.
async function runOfferMigration({ applications, requests, dryRun, now = new Date() }) {
    const pending = await applications.find({ status: 'pending' }, { projection: { requestId: 1, inspectionFee: 1 } }).toArray();
    const requestIds = [...new Set(pending.map((a) => a.requestId).filter((id) => ObjectId.isValid(id)))];
    const docs = requestIds.length
        ? await requests.find({ _id: { $in: requestIds.map((id) => new ObjectId(id)) } }, { projection: { pricing: 1 } }).toArray()
        : [];
    const requestById = new Map(docs.map((r) => [r._id.toString(), r]));
    const details = [];
    for (const offer of pending) {
        const request = requestById.get(String(offer.requestId));
        if (!request) continue;
        const floor = minInspectionFee(request);
        const fee = Number(offer.inspectionFee) || 0;
        if (fee >= floor) continue;
        const detail = { id: offer._id.toString(), requestId: String(offer.requestId), action: dryRun ? 'would-raise' : 'raised', from: fee, to: floor };
        if (!dryRun) {
            const result = await applications.updateOne(
                { _id: offer._id, status: 'pending', inspectionFee: offer.inspectionFee },
                { $set: { inspectionFee: floor, inspectionFeeRaisedFrom: offer.inspectionFee, updatedAt: now } }
            );
            if (result.modifiedCount === 0) detail.action = 'changed-since-read';
        }
        details.push(detail);
    }
    return {
        pending: pending.length,
        raised: details.filter((d) => d.action === (dryRun ? 'would-raise' : 'raised')).length,
        changedSinceRead: details.filter((d) => d.action === 'changed-since-read').length,
        details,
    };
}

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
    });
    if (!guard.safe) {
        console.error(`Refusing to run: ${guard.reason}.`);
        process.exit(1);
    }

    const { collections, client } = require('../config/database');
    const dryRun = args.includes('--dry-run') || !args.includes('--confirm');

    (async () => {
        console.log(`Inspection fee floor - database: "${resolvedDbName}"${guard.productionTarget ? ' (PRODUCTION)' : ''}, mode: ${dryRun ? 'DRY RUN (no writes)' : 'WRITE (--confirm)'}`);
        await client.connect();
        const result = await runMigration({ collection: collections.serviceDefinitions, dryRun });
        for (const d of result.details) {
            if (d.action === 'unchanged') continue;
            console.log(`${d.action.padEnd(18)} ${d.key}  ${d.from ?? '-'} -> ${d.to} BDT`);
        }
        console.log(`\nServices: ${result.total}, ${dryRun ? 'would raise' : 'raised'}: ${result.raised}, already at or above the floor: ${result.unchanged}${result.changedSinceRead ? `, changed by someone else meanwhile (skipped): ${result.changedSinceRead}` : ''}`);
        const offers = await runOfferMigration({ applications: collections.jobApplications, requests: collections.repairRequests, dryRun });
        for (const d of offers.details) console.log(`${d.action.padEnd(18)} offer ${d.id} (request ${d.requestId})  ${d.from} -> ${d.to} BDT`);
        console.log(`Waiting offers: ${offers.pending}, ${dryRun ? 'would raise' : 'raised'}: ${offers.raised}${offers.changedSinceRead ? `, changed meanwhile (skipped): ${offers.changedSinceRead}` : ''}`);
        if (dryRun) console.log('Dry run only - re-run with --confirm to apply.');
    })()
        .catch((error) => { console.error('Migration failed:', error.message); process.exitCode = 1; })
        .finally(() => client.close().catch(() => {}));
}

module.exports = { runMigration, runOfferMigration, PRODUCTION_OVERRIDE_VAR };
