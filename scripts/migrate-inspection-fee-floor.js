// Raises every service's inspection fee to the floor (utils/inspectionFee.js:
// 100 BDT for an estimate up to 1,000 BDT, 200 BDT above). Only services below
// the floor change; a fee already at or above it is left alone. A changed
// price bumps pricingRule.version, the same as an admin price edit, so new
// requests snapshot the new fee. Existing requests are not touched - the job
// portal already applies the floor to them (utils/jobPortal.js).
//
// Usage:
//   node scripts/migrate-inspection-fee-floor.js             (dry-run, writes nothing)
//   node scripts/migrate-inspection-fee-floor.js --confirm   (writes)
// Production: refused unless ALLOW_PROD_FEE_FLOOR_MIGRATION=true AND
// --expect-db=<exact database name> both match (scripts/lib/productionGuard.js).
//
// runMigration() has no console/process side effects, so the test suite runs
// the same logic.
const { minimumInspectionFee } = require('../utils/inspectionFee');

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
        if (dryRun) console.log('Dry run only - re-run with --confirm to apply.');
    })()
        .catch((error) => { console.error('Migration failed:', error.message); process.exitCode = 1; })
        .finally(() => client.close().catch(() => {}));
}

module.exports = { runMigration, PRODUCTION_OVERRIDE_VAR };
