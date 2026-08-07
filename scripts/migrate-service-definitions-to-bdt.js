// Idempotent BDT pricing migration for the serviceDefinitions collection
// (Phase 6.4 Unit 3C / Phase F).
//
// Purpose: the development database already contains the 16 canonical service
// definitions with their previous USD pricing. This script updates ONLY those
// exact canonical rows (matched by their productCategorySlug/repairCategorySlug
// key) in-place to the approved BDT pricing now defined in
// data/serviceDefinitionSeed.js. It never inserts (that is
// scripts/seed-service-definitions.js's job on a fresh database), never
// touches any non-canonical/custom service definition, and never touches any
// other collection (parcels, payments, quotes, users, riders, notifications) -
// so every historical request pricing snapshot is left exactly as it was.
//
// Usage:
//   node scripts/migrate-service-definitions-to-bdt.js               (dry-run - default, writes nothing)
//   node scripts/migrate-service-definitions-to-bdt.js --dry-run      (dry-run, explicit)
//   node scripts/migrate-service-definitions-to-bdt.js --confirm      (writes the BDT update)
//
// If both flags are passed together, --dry-run wins - the safer mode always
// takes precedence over the writing one.
//
// This file is both a CLI entrypoint and a requirable module: runMigration()
// is a pure(-ish) function with no console/process side effects, exported so
// test-all.js can exercise the exact same logic against synthetic fixtures.
// The CLI behavior below only runs when this file is executed directly.
//
// Safety design mirrors scripts/seed-service-definitions.js exactly: it reuses
// that script's isSafeToSeed()/comparison helpers, refuses to run when
// isProductionEnvironment() is true, and independently refuses if the resolved
// database name contains "production". Never prints MONGO_URI or any secret -
// only the resolved database name and computed counts/field names.

const { ObjectId } = require('mongodb');
const {
    validateServiceDefinitionInput,
    buildDocumentFromInput,
    WRITABLE_TOP_LEVEL_FIELDS
} = require('../models/ServiceDefinition');
const { deepEqualPlain, isSafeToSeed } = require('./seed-service-definitions');

// Which of the canonical writable fields actually differ between the stored
// document and the desired seed row - used both to decide "modified vs
// unchanged" and to report exactly what a real run would change, never a
// blanket "updated everything".
function changedWritableFields(existingDoc, builtDoc) {
    return WRITABLE_TOP_LEVEL_FIELDS.filter((field) => !deepEqualPlain(existingDoc[field], builtDoc[field]));
}

// Processes `seedRows` (the canonical BDT matrix) against `collection` (the
// raw serviceDefinitions collection). No console output, no process.exit -
// purely returns a summary + per-row detail array. `dryRun: true` performs
// every lookup/validation/comparison but never writes.
//
// `ok` is false (and the caller must refuse to treat the run as successful)
// if any canonical row is invalid, missing, or duplicated, or if the number
// of matched canonical rows is not exactly `expectedCount`.
async function runMigration({ collection, seedRows, dryRun, expectedCount = 16 }) {
    let matched = 0;
    let modified = 0;
    let unchanged = 0;
    let missing = 0;
    let duplicated = 0;
    let invalid = 0;
    const details = [];
    const now = new Date();

    for (const row of seedRows) {
        const key = `${row.productCategorySlug} / ${row.repairCategorySlug}`;

        // Validate the desired BDT row first - a bad canonical seed value must
        // never be written, and is a fatal configuration error, not a silent skip.
        const validation = validateServiceDefinitionInput(row);
        if (!validation.valid) {
            invalid += 1;
            details.push({ key, action: 'invalid', code: validation.code });
            continue;
        }

        // Match ONLY by the exact canonical compound key - never a broad
        // currency-based query that could sweep in unknown documents.
        const existingDocs = await collection
            .find({ productCategorySlug: row.productCategorySlug, repairCategorySlug: row.repairCategorySlug })
            .toArray();

        if (existingDocs.length === 0) {
            missing += 1;
            details.push({ key, action: 'missing' });
            continue;
        }
        if (existingDocs.length > 1) {
            duplicated += 1;
            details.push({ key, action: 'duplicate', count: existingDocs.length });
            continue;
        }

        matched += 1;
        const existing = existingDocs[0];
        const built = buildDocumentFromInput(row, now);
        const changed = changedWritableFields(existing, built);

        if (changed.length === 0) {
            unchanged += 1;
            details.push({ key, action: 'unchanged', existingId: existing._id });
            continue;
        }

        modified += 1;
        details.push({ key, action: dryRun ? 'would-modify' : 'modified', existingId: existing._id, changedFields: changed });

        if (!dryRun) {
            // Update only the canonical writable fields, addressed by this one
            // document's _id (never updateMany), and refresh updatedAt. createdAt
            // is deliberately never overwritten.
            const setFields = { updatedAt: now };
            for (const field of WRITABLE_TOP_LEVEL_FIELDS) {
                setFields[field] = built[field];
            }
            await collection.updateOne(
                { _id: existing._id instanceof ObjectId ? existing._id : new ObjectId(existing._id) },
                { $set: setFields }
            );
        }
    }

    const ok = invalid === 0 && missing === 0 && duplicated === 0 && matched === expectedCount;
    return { ok, expectedCount, matched, modified, unchanged, missing, duplicated, invalid, details };
}

if (require.main === module) {
    require('dotenv').config();
    const { isProductionEnvironment } = require('../config/siteOrigin');
    const { resolveDatabaseName } = require('../config/databaseName');

    const resolvedDbName = resolveDatabaseName();
    const safety = isSafeToSeed({ isProduction: isProductionEnvironment(), resolvedDbName });
    if (!safety.safe) {
        console.error(`Refusing to run: ${safety.reason}.`);
        process.exit(1);
    }

    const { connectDatabase, collections, client } = require('../config/database');
    const { SERVICE_DEFINITION_SEED } = require('../data/serviceDefinitionSeed');

    const args = process.argv.slice(2);
    const confirm = args.includes('--confirm');
    const explicitDryRun = args.includes('--dry-run');
    const isDryRun = explicitDryRun || !confirm;

    (async () => {
        console.log(`BDT service-definition migration - database: "${resolvedDbName}", mode: ${isDryRun ? 'DRY RUN (no writes)' : 'WRITE (--confirm)'}`);
        console.log('');

        await connectDatabase();
        const result = await runMigration({
            collection: collections.serviceDefinitions,
            seedRows: SERVICE_DEFINITION_SEED,
            dryRun: isDryRun,
            expectedCount: SERVICE_DEFINITION_SEED.length
        });

        for (const detail of result.details) {
            if (detail.action === 'would-modify') console.log(`~ WOULD MODIFY  ${detail.key}  [fields: ${detail.changedFields.join(', ')}]`);
            else if (detail.action === 'modified') console.log(`~ MODIFIED  ${detail.key}  [fields: ${detail.changedFields.join(', ')}]`);
            else if (detail.action === 'unchanged') console.log(`= UNCHANGED (already BDT)  ${detail.key}`);
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
        if (result.missing > 0) console.log(`  Missing:             ${result.missing}`);
        if (result.duplicated > 0) console.log(`  Duplicated:          ${result.duplicated}`);
        if (result.invalid > 0) console.log(`  Invalid:             ${result.invalid}`);

        if (!result.ok) {
            console.error('');
            console.error('Migration NOT OK - refusing to treat this run as successful (missing/duplicate/invalid canonical rows, or matched count != expected). No further action taken.');
            process.exitCode = 1;
        } else if (isDryRun) {
            console.log('');
            console.log('Dry run only - no documents were written. Re-run with --confirm to apply.');
        } else {
            console.log('');
            console.log('Migration applied successfully.');
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

module.exports = { runMigration, changedWritableFields };
