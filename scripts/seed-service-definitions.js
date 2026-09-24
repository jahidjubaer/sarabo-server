// Idempotent, non-destructive seed script for the serviceDefinitions
// collection (Phase 6.3 Unit 2 / Phase F).
//
// Usage:
//   node scripts/seed-service-definitions.js               (dry-run - default, writes nothing)
//   node scripts/seed-service-definitions.js --dry-run      (dry-run, explicit)
//   node scripts/seed-service-definitions.js --confirm-seed (writes only genuinely new rows)
//
// If both flags are passed together, --dry-run wins - the safer mode always
// takes precedence over the writing one.
//
// This file is both a CLI entrypoint and a requirable module: runSeed() and
// isSafeToSeed() are pure(-ish) functions with no console/process side
// effects, exported so test-all.js can exercise the exact same seed logic
// in isolation against synthetic fixtures without ever touching the real
// SERVICE_DEFINITION_SEED matrix or the CLI's process.exit/connect flow. The
// CLI behavior below only runs when this file is executed directly (`node
// scripts/seed-service-definitions.js`), never when required as a module -
// the standard Node.js dual CLI/library pattern.
//
// Safety design (belt-and-suspenders, two independent checks, see
// isSafeToSeed): a production target - isProductionEnvironment() is true, OR
// the resolved database name contains "production" - is refused by default.
// It is allowed only through one narrow, explicit path: BOTH
// ALLOW_PROD_SERVICE_SEED=true AND --expect-db=<exact resolved database name>
// (scripts/lib/productionGuard.js). Writing still needs --confirm-seed, and
// the seed only ever inserts missing standard rows - an existing row that
// differs is reported as a conflict and never overwritten, so a production
// customisation is always preserved.
//
// Production usage (see docs/production-data-migration.md):
//   ALLOW_PROD_SERVICE_SEED=true node scripts/seed-service-definitions.js --expect-db=<name>                 (dry-run)
//   ALLOW_PROD_SERVICE_SEED=true node scripts/seed-service-definitions.js --expect-db=<name> --confirm-seed  (write)
//
// Never prints MONGO_URI or any other secret - only the resolved,
// already-validated database name and computed counts/labels ever reach
// stdout. Never touches users/repair-requests/technicians/payments/notifications - only
// the serviceDefinitions collection.

const { ServiceDefinitionModel, validateServiceDefinitionInput, buildDocumentFromInput, WRITABLE_TOP_LEVEL_FIELDS } = require('../models/ServiceDefinition');
const { evaluateProductionGuard, readExpectedDbArg } = require('./lib/productionGuard');

const PRODUCTION_OVERRIDE_VAR = 'ALLOW_PROD_SERVICE_SEED';

function deepEqualPlain(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqualPlain(a[key], b[key]));
}

// Compares only the fields this seed actually owns (WRITABLE_TOP_LEVEL_FIELDS
// - the same whitelist buildDocumentFromInput() uses), never internal fields
// like _id/createdAt/updatedAt.
function rowMatchesExisting(existingDoc, desiredRow) {
    return WRITABLE_TOP_LEVEL_FIELDS.every((field) => deepEqualPlain(existingDoc[field], desiredRow[field]));
}

// Pure decision function - takes explicit values rather than reading
// process.env itself, so it is directly unit-testable without mutating real
// environment state mid-process. Called with only { isProduction,
// resolvedDbName } (as before) a production target is always refused; the
// two extra values open the one explicit production path.
function isSafeToSeed({ isProduction, resolvedDbName, expectedDbName = null, productionOverride = undefined }) {
    const guard = evaluateProductionGuard({
        isProduction,
        resolvedDbName,
        expectedDbName,
        overrideVarName: PRODUCTION_OVERRIDE_VAR,
        overrideValue: productionOverride,
    });
    return { safe: guard.safe, reason: guard.reason, productionTarget: guard.productionTarget };
}

// Processes `seedRows` against `model` (a ServiceDefinitionModel instance).
// No console output, no process.exit - purely returns a summary + per-row
// detail array. `dryRun: true` performs every lookup/validation/comparison
// but never calls model.insertOne.
async function runSeed({ model, seedRows, dryRun }) {
    let created = 0;
    let skippedIdentical = 0;
    let conflicted = 0;
    let invalid = 0;
    const details = [];

    for (const row of seedRows) {
        const key = `${row.productCategorySlug} / ${row.repairCategorySlug}`;
        const validation = validateServiceDefinitionInput(row);
        if (!validation.valid) {
            invalid += 1;
            details.push({ key, action: 'invalid', code: validation.code });
            continue;
        }

        const existing = await model.findByKey(row.productCategorySlug, row.repairCategorySlug);

        if (!existing) {
            created += 1;
            if (dryRun) {
                details.push({ key, action: 'would-create' });
            } else {
                const now = new Date();
                const insertResult = await model.insertOne(buildDocumentFromInput(row, now));
                details.push({ key, action: 'created', insertedId: insertResult.insertedId });
            }
            continue;
        }

        if (rowMatchesExisting(existing, row)) {
            skippedIdentical += 1;
            details.push({ key, action: 'identical', existingId: existing._id });
        } else {
            conflicted += 1;
            details.push({ key, action: 'conflict', existingId: existing._id });
        }
    }

    return { created, skippedIdentical, conflicted, invalid, details };
}

if (require.main === module) {
    require('dotenv').config();
    const { isProductionEnvironment } = require('../config/siteOrigin');
    const { resolveDatabaseName } = require('../config/databaseName');

    const args = process.argv.slice(2);
    const resolvedDbName = resolveDatabaseName();
    const safety = isSafeToSeed({
        isProduction: isProductionEnvironment(),
        resolvedDbName,
        expectedDbName: readExpectedDbArg(args),
        productionOverride: process.env[PRODUCTION_OVERRIDE_VAR],
    });
    if (!safety.safe) {
        console.error(`Refusing to run: ${safety.reason}.`);
        process.exit(1);
    }

    const { collections, client } = require('../config/database');
    const { SERVICE_DEFINITION_SEED } = require('../data/serviceDefinitionSeed');

    const confirmSeed = args.includes('--confirm-seed');
    const explicitDryRun = args.includes('--dry-run');
    const isDryRun = explicitDryRun || !confirmSeed;

    (async () => {
        console.log(`Service-definition seed - database: "${resolvedDbName}"${safety.productionTarget ? ' (PRODUCTION)' : ''}, mode: ${isDryRun ? 'DRY RUN (no writes)' : 'WRITE (--confirm-seed)'}`);
        console.log('');

        // A plain connect, not connectDatabase(): that one also builds the
        // server's indexes on first use, and a dry run must write nothing.
        await client.connect();
        const model = new ServiceDefinitionModel(collections.serviceDefinitions);
        const result = await runSeed({ model, seedRows: SERVICE_DEFINITION_SEED, dryRun: isDryRun });

        for (const detail of result.details) {
            if (detail.action === 'would-create') console.log(`+ WOULD CREATE  ${detail.key}`);
            else if (detail.action === 'created') console.log(`+ CREATED  ${detail.key}`);
            else if (detail.action === 'identical') console.log(`= IDENTICAL (skipped)  ${detail.key}`);
            else if (detail.action === 'conflict') console.log(`! CONFLICT (not overwritten - existing row differs from seed)  ${detail.key}`);
            else if (detail.action === 'invalid') console.log(`✗ INVALID  ${detail.key} - ${detail.code}`);
        }

        console.log('');
        console.log('Summary:');
        console.log(`  Created:             ${result.created}${isDryRun ? ' (would create)' : ''}`);
        console.log(`  Skipped (identical): ${result.skippedIdentical}`);
        console.log(`  Conflicted:          ${result.conflicted}`);
        if (result.invalid > 0) {
            console.log(`  Invalid (skipped):   ${result.invalid}`);
        }
        if (isDryRun) {
            console.log('');
            console.log('Dry run only - no documents were written. Re-run with --confirm-seed to write.');
        }
    })()
        .catch((error) => {
            console.error('Seed execution error:', error.message);
            process.exitCode = 1;
        })
        .finally(async () => {
            await client.close();
        });
}

module.exports = { runSeed, isSafeToSeed, rowMatchesExisting, deepEqualPlain, PRODUCTION_OVERRIDE_VAR };
