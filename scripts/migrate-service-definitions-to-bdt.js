// Idempotent BDT pricing migration for the service_definitions collection
// (Phase 6.4 Unit 3C / Phase F; production-safe since the release-prep phase).
//
// Purpose: databases seeded before the BDT switch hold the 16 canonical
// service definitions with their original USD pricing. This script upgrades
// ONLY rows that are still, field for field, the untouched original USD
// standard row (data/serviceDefinitionSeedLegacyUsd.js - a frozen copy of the
// seed as it was before the switch) to the approved BDT row in
// data/serviceDefinitionSeed.js. It never inserts (that is
// scripts/seed-service-definitions.js's job), never touches a non-canonical
// row, and never touches another collection, so every request's own pricing
// snapshot stays exactly as it was.
//
// Every canonical row is classified before anything is written:
//   unchanged  already identical to the BDT standard row      -> left alone
//   modify     identical to the ORIGINAL USD standard row     -> upgraded
//   custom     differs from both (a deliberate customisation) -> NOT touched
//   missing / duplicate / invalid                              -> reported
// The run writes only when every row is unchanged or modify - one custom,
// missing, duplicate or invalid row aborts the whole run with no writes, so a
// deliberately customised production price can never be overwritten.
//
// Usage:
//   node scripts/migrate-service-definitions-to-bdt.js               (dry-run - default, writes nothing)
//   node scripts/migrate-service-definitions-to-bdt.js --dry-run      (dry-run, explicit)
//   node scripts/migrate-service-definitions-to-bdt.js --confirm      (writes the BDT update)
// If both flags are passed together, --dry-run wins.
//
// Production: refused unless ALLOW_PROD_BDT_MIGRATION=true AND
// --expect-db=<exact database name> both match (scripts/lib/productionGuard.js).
// Never prints MONGO_URI or any secret - only the resolved database name and
// computed counts/field names.
//
// This file is both a CLI entrypoint and a requirable module: runMigration()
// has no console/process side effects, so test-all.js exercises the exact
// same logic against synthetic fixtures.

const { ObjectId } = require('mongodb');
const {
    validateServiceDefinitionInput,
    buildDocumentFromInput,
    WRITABLE_TOP_LEVEL_FIELDS
} = require('../models/ServiceDefinition');
const { deepEqualPlain } = require('./seed-service-definitions');
const { LEGACY_USD_SERVICE_DEFINITION_SEED } = require('../data/serviceDefinitionSeedLegacyUsd');

const PRODUCTION_OVERRIDE_VAR = 'ALLOW_PROD_BDT_MIGRATION';

function rowKey(row) {
    return `${row.productCategorySlug}/${row.repairCategorySlug}`;
}

// Which canonical writable fields differ between the stored document and a
// desired row - used to decide unchanged vs not, and to report exactly what a
// real run would change.
function changedWritableFields(existingDoc, builtDoc) {
    return WRITABLE_TOP_LEVEL_FIELDS.filter((field) => !deepEqualPlain(existingDoc[field], builtDoc[field]));
}

// The original seed only ever trimmed label/description and rebuilt
// pricingRule from its known keys before inserting, so a stored, untouched
// USD row equals the frozen legacy seed row with the same normalisation.
function normaliseLegacyRow(row) {
    const doc = {};
    for (const field of WRITABLE_TOP_LEVEL_FIELDS) doc[field] = row[field];
    if (typeof doc.label === 'string') doc.label = doc.label.trim();
    if (typeof doc.description === 'string') doc.description = doc.description.trim();
    return doc;
}

// Plans every canonical row, then - only when the whole plan is clean and
// dryRun is false - applies it. Returns a summary + per-row detail array.
// `ok` is false (and nothing is written) if any row is custom, invalid,
// missing or duplicated, or if the matched count is not `expectedCount`.
async function runMigration({
    collection,
    seedRows,
    dryRun,
    expectedCount = 16,
    legacyRows = LEGACY_USD_SERVICE_DEFINITION_SEED,
}) {
    const legacyByKey = new Map(legacyRows.map((row) => [rowKey(row), normaliseLegacyRow(row)]));
    const now = new Date();
    const counts = { matched: 0, modified: 0, unchanged: 0, custom: 0, missing: 0, duplicated: 0, invalid: 0 };
    const details = [];
    const writes = [];

    for (const row of seedRows) {
        const key = `${row.productCategorySlug} / ${row.repairCategorySlug}`;
        // A bad canonical seed value must never be written - a fatal
        // configuration error, not a silent skip.
        const validation = validateServiceDefinitionInput(row);
        if (!validation.valid) {
            counts.invalid += 1;
            details.push({ key, action: 'invalid', code: validation.code });
            continue;
        }

        // Match ONLY by the exact canonical compound key.
        const existingDocs = await collection
            .find({ productCategorySlug: row.productCategorySlug, repairCategorySlug: row.repairCategorySlug })
            .toArray();
        if (existingDocs.length === 0) {
            counts.missing += 1;
            details.push({ key, action: 'missing' });
            continue;
        }
        if (existingDocs.length > 1) {
            counts.duplicated += 1;
            details.push({ key, action: 'duplicate', count: existingDocs.length });
            continue;
        }

        counts.matched += 1;
        const existing = existingDocs[0];
        const built = buildDocumentFromInput(row, now);
        const changed = changedWritableFields(existing, built);
        if (changed.length === 0) {
            counts.unchanged += 1;
            details.push({ key, action: 'unchanged', existingId: existing._id });
            continue;
        }

        const legacy = legacyByKey.get(rowKey(row));
        const isUntouchedLegacyRow = !!legacy
            && WRITABLE_TOP_LEVEL_FIELDS.every((field) => deepEqualPlain(existing[field], legacy[field]));
        if (!isUntouchedLegacyRow) {
            counts.custom += 1;
            details.push({ key, action: 'custom', existingId: existing._id, changedFields: changed });
            continue;
        }

        counts.modified += 1;
        details.push({ key, action: dryRun ? 'would-modify' : 'modified', existingId: existing._id, changedFields: changed });
        writes.push({ existing, built });
    }

    const ok = counts.invalid === 0 && counts.missing === 0 && counts.duplicated === 0
        && counts.custom === 0 && counts.matched === expectedCount;

    let wrote = 0;
    let changedSincePlan = 0;
    if (ok && !dryRun) {
        for (const { existing, built } of writes) {
            // Only the canonical writable fields, addressed by this one
            // document's _id AND its current legacy pricing (so a row changed
            // between plan and write is not overwritten). createdAt is never
            // touched.
            const setFields = { updatedAt: now };
            for (const field of WRITABLE_TOP_LEVEL_FIELDS) setFields[field] = built[field];
            const result = await collection.updateOne(
                {
                    _id: existing._id instanceof ObjectId ? existing._id : new ObjectId(existing._id),
                    pricingRule: existing.pricingRule,
                },
                { $set: setFields }
            );
            if (result.modifiedCount === 1) wrote += 1;
            else changedSincePlan += 1;
        }
    }

    // `wrote` counts rows the database actually changed; a row edited between
    // the plan and its write is left alone and counted in changedSincePlan.
    return { ok, expectedCount, ...counts, wrote, changedSincePlan, details };
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
    const { SERVICE_DEFINITION_SEED } = require('../data/serviceDefinitionSeed');

    const confirm = args.includes('--confirm');
    const explicitDryRun = args.includes('--dry-run');
    const isDryRun = explicitDryRun || !confirm;

    (async () => {
        console.log(`BDT service-definition migration - database: "${resolvedDbName}"${guard.productionTarget ? ' (PRODUCTION)' : ''}, mode: ${isDryRun ? 'DRY RUN (no writes)' : 'WRITE (--confirm)'}`);
        console.log('');

        // A plain connect, not connectDatabase(): that one also builds the
        // server's indexes on first use, and a dry run must write nothing.
        await client.connect();
        const result = await runMigration({
            collection: collections.serviceDefinitions,
            seedRows: SERVICE_DEFINITION_SEED,
            dryRun: isDryRun,
            expectedCount: SERVICE_DEFINITION_SEED.length
        });

        for (const detail of result.details) {
            if (detail.action === 'would-modify') console.log(`~ WOULD MODIFY (original USD row)  ${detail.key}  [fields: ${detail.changedFields.join(', ')}]`);
            else if (detail.action === 'modified') console.log(`~ MODIFIED (original USD row)  ${detail.key}  [fields: ${detail.changedFields.join(', ')}]`);
            else if (detail.action === 'unchanged') console.log(`= UNCHANGED (already BDT)  ${detail.key}`);
            else if (detail.action === 'custom') console.log(`! CUSTOM (differs from both the original USD and the BDT row - never overwritten)  ${detail.key}  [fields: ${detail.changedFields.join(', ')}]`);
            else if (detail.action === 'missing') console.log(`! MISSING (expected canonical row not found - not created here)  ${detail.key}`);
            else if (detail.action === 'duplicate') console.log(`! DUPLICATE (${detail.count} rows share this canonical key)  ${detail.key}`);
            else if (detail.action === 'invalid') console.log(`✗ INVALID  ${detail.key} - ${detail.code}`);
        }

        console.log('');
        console.log('Summary:');
        console.log(`  Canonical expected:  ${result.expectedCount}`);
        console.log(`  Matched:             ${result.matched}`);
        console.log(`  Modified:            ${result.modified}${isDryRun ? ' (would modify)' : ''}`);
        console.log(`  Unchanged:           ${result.unchanged}`);
        if (result.custom > 0) console.log(`  Custom (untouched):  ${result.custom}`);
        if (result.missing > 0) console.log(`  Missing:             ${result.missing}`);
        if (result.duplicated > 0) console.log(`  Duplicated:          ${result.duplicated}`);
        if (result.invalid > 0) console.log(`  Invalid:             ${result.invalid}`);

        if (!result.ok) {
            console.error('');
            console.error('Migration NOT OK - nothing was written (custom/missing/duplicate/invalid canonical rows, or matched count != expected).');
            if (result.missing === result.expectedCount) {
                console.error('No canonical rows exist at all: this database needs the seed (scripts/seed-service-definitions.js), not this migration.');
            }
            process.exitCode = 1;
        } else if (isDryRun) {
            console.log('');
            console.log('Dry run only - no documents were written. Re-run with --confirm to apply.');
        } else {
            console.log('');
            console.log(`Migration applied successfully (${result.wrote} row(s) upgraded).`);
            if (result.changedSincePlan > 0) {
                console.error(`${result.changedSincePlan} row(s) changed after planning and were left alone - rerun the dry run to review them.`);
                process.exitCode = 1;
            }
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

module.exports = { runMigration, changedWritableFields, normaliseLegacyRow, PRODUCTION_OVERRIDE_VAR };
