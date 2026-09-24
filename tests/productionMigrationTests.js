// Production-preparation tooling tests (release-prep phase): the legacy
// schema migration, the guarded service-definition seed, and the guarded,
// customisation-safe BDT migration.
//
// Runs against its OWN throwaway database (MIGRATION_TEST_DB) on the test
// cluster connection - never sarabo-db, never production. The database is
// dropped before and after, and the suite refuses to drop anything whose name
// does not contain "test".

const { ObjectId } = require('mongodb');
const { client, connectDatabase } = require('../config/database');
const { evaluateProductionGuard, readExpectedDbArg } = require('../scripts/lib/productionGuard');
const legacy = require('../scripts/migrate-legacy-schema');
const { runSeed, isSafeToSeed } = require('../scripts/seed-service-definitions');
const { runMigration: runBdtMigration, normaliseLegacyRow } = require('../scripts/migrate-service-definitions-to-bdt');
const { ServiceDefinitionModel, buildDocumentFromInput, WRITABLE_TOP_LEVEL_FIELDS } = require('../models/ServiceDefinition');
const { SERVICE_DEFINITION_SEED } = require('../data/serviceDefinitionSeed');
const { LEGACY_USD_SERVICE_DEFINITION_SEED } = require('../data/serviceDefinitionSeedLegacyUsd');

const MIGRATION_TEST_DB = 'sarabo-test-db-migrations';

async function dropTestDatabase() {
    if (!MIGRATION_TEST_DB.includes('test')) throw new Error('refusing to drop a non-test database');
    await client.db(MIGRATION_TEST_DB).dropDatabase();
}

// A small but complete pre-rename dataset: two technicians, three requests
// (one assigned + paid, one unassigned, one whose admin-deleted sibling left an
// orphan tracking event), their tracking history, checkout sessions, payments
// and notifications - exactly the shapes origin/main wrote.
function buildLegacyFixture() {
    const t1 = new ObjectId();
    const t2 = new ObjectId();
    const r1 = new ObjectId();
    const r2 = new ObjectId();
    const r3 = new ObjectId();
    const created = new Date('2026-07-01T10:00:00Z');
    return {
        ids: { t1, t2, r1, r2, r3 },
        created,
        riders: [
            { _id: t1, name: 'Tech One', email: 'tech1@example.test', region: 'Dhaka', district: 'Dhaka', status: 'approved', workStatus: 'in_delivery', createdAt: created },
            { _id: t2, name: 'Tech Two', email: 'tech2@example.test', region: 'Dhaka', district: 'Gazipur', status: 'pending', createdAt: created },
        ],
        parcels: [
            { _id: r1, parcelName: 'Laptop', parcelType: 'non-document', parcelWeight: '2', senderName: 'Cust', senderEmail: 'cust1@example.test', senderDistrict: 'Dhaka', cost: 110, trackingId: 'TRK-LEGACY-1', deliveryStatus: 'driver_assigned', paymentStatus: 'paid', riderId: t1.toHexString(), riderName: 'Tech One', riderEmail: 'tech1@example.test', createdAt: created },
            { _id: r2, parcelName: 'Phone', parcelType: 'document', senderName: 'Cust 2', senderEmail: 'cust2@example.test', cost: 60, trackingId: 'TRK-LEGACY-2', deliveryStatus: 'pending-pickup', createdAt: created },
            { _id: r3, parcelName: 'TV', senderName: 'Cust 3', senderEmail: 'cust3@example.test', cost: 150, trackingId: 'TRK-LEGACY-3', deliveryStatus: 'cancelled', createdAt: created },
        ],
        trackings: [
            { _id: new ObjectId(), trackingId: 'TRK-LEGACY-1', status: 'parcel_created', details: 'parcel created', createdAt: created },
            { _id: new ObjectId(), trackingId: 'TRK-LEGACY-1', status: 'driver_assigned', details: 'driver assigned', createdAt: new Date(created.getTime() + 1000) },
            { _id: new ObjectId(), trackingId: 'TRK-LEGACY-1', status: 'parcel_paid', details: 'custom note kept', createdAt: new Date(created.getTime() + 2000) },
            { _id: new ObjectId(), trackingId: 'TRK-LEGACY-2', status: 'parcel_created', details: 'parcel created', createdAt: created },
            // Orphan: its request was deleted by the pre-rename admin delete.
            { _id: new ObjectId(), trackingId: 'TRK-DELETED', status: 'parcel_created', details: 'parcel created', createdAt: created },
        ],
        checkoutSessions: [
            { _id: new ObjectId(), parcelId: r1.toHexString(), ownerEmail: 'cust1@example.test', amount: 110, currency: 'usd', status: 'completed', active: false, sessionId: 'cs_test_1', expiresAt: null, createdAt: created, updatedAt: created },
            { _id: new ObjectId(), parcelId: r2.toHexString(), ownerEmail: 'cust2@example.test', amount: 60, currency: 'usd', status: 'open', active: true, sessionId: 'cs_test_2', expiresAt: null, createdAt: created, updatedAt: created },
        ],
        payments: [
            { _id: new ObjectId(), sessionId: 'cs_test_1', transactionId: 'pi_test_1', parcelId: r1.toHexString(), trackingId: 'TRK-LEGACY-1', customerEmail: 'cust1@example.test', amount: 110, currency: 'usd', paymentStatus: 'paid', source: 'webhook', paidAt: created },
        ],
        notifications: [
            { _id: new ObjectId(), recipientEmail: 'cust1@example.test', type: 'technician_assigned', entityType: 'parcel', entityId: r1.toHexString(), title: 't', message: 'm', actionUrl: `/dashboard/my-requests/${r1.toHexString()}`, isRead: false, createdAt: created, metadata: { trackingId: 'TRK-LEGACY-1' }, deduplicationKey: `repair:${r1.toHexString()}:technician_assigned:customer` },
        ],
    };
}

async function insertFixture(db, fixture) {
    for (const name of ['riders', 'parcels', 'trackings', 'checkoutSessions', 'payments', 'notifications']) {
        if (fixture[name].length) await db.collection(name).insertMany(fixture[name].map((doc) => ({ ...doc })));
    }
}

async function snapshot(db, name) {
    return (await db.collection(name).find({}).sort({ _id: 1 }).toArray());
}

async function runProductionMigrationTests({ logTest }) {
    await connectDatabase();
    const db = client.db(MIGRATION_TEST_DB);
    await dropTestDatabase();
    try {
        // ================= Production guard =================
        const guardBase = { overrideVarName: 'ALLOW_PROD_SCHEMA_MIGRATION', requireExpectedDb: true };
        logTest('Guard: --expect-db is required for the schema migration',
            evaluateProductionGuard({ ...guardBase, isProduction: false, resolvedDbName: 'sarabo-db', expectedDbName: null }).safe === false);
        logTest('Guard: wrong database name is rejected',
            evaluateProductionGuard({ ...guardBase, isProduction: false, resolvedDbName: 'sarabo-db', expectedDbName: 'sarabo-db-other' }).safe === false);
        logTest('Guard: production target without the override is rejected',
            evaluateProductionGuard({ ...guardBase, isProduction: true, resolvedDbName: 'sarabo_production', expectedDbName: 'sarabo_production' }).safe === false);
        logTest('Guard: production override must be exactly "true"',
            evaluateProductionGuard({ ...guardBase, isProduction: true, resolvedDbName: 'sarabo_production', expectedDbName: 'sarabo_production', overrideValue: 'yes' }).safe === false);
        logTest('Guard: a "production"-named database needs the override even outside a production environment',
            evaluateProductionGuard({ ...guardBase, isProduction: false, resolvedDbName: 'sarabo_production', expectedDbName: 'sarabo_production' }).safe === false);
        logTest('Guard: override + exact database name is accepted',
            evaluateProductionGuard({ ...guardBase, isProduction: true, resolvedDbName: 'sarabo_production', expectedDbName: 'sarabo_production', overrideValue: 'true' }).safe === true);
        logTest('Guard: override does not bypass a database-name mismatch',
            evaluateProductionGuard({ ...guardBase, isProduction: true, resolvedDbName: 'sarabo_production', expectedDbName: 'sarabo-db', overrideValue: 'true' }).safe === false);
        logTest('Guard: --expect-db parsing', readExpectedDbArg(['--confirm', '--expect-db=sarabo_production']) === 'sarabo_production' && readExpectedDbArg(['--expect-db=']) === null && readExpectedDbArg([]) === null);
        logTest('Mode: dry run by default, --confirm required to write, --dry-run wins',
            legacy.resolveRunMode([]).dryRun === true && legacy.resolveRunMode(['--confirm']).dryRun === false && legacy.resolveRunMode(['--confirm', '--dry-run']).dryRun === true);

        // ================= Empty source =================
        const emptyPlan = await legacy.planMigration(db);
        logTest('Empty source: plan is ok with nothing to write', emptyPlan.ok === true && emptyPlan.writeCount === 0);
        const emptyRun = await legacy.executeMigration({ db, client, plan: emptyPlan });
        const collectionsAfterEmpty = (await db.listCollections().toArray()).length;
        logTest('Empty source: a confirmed run writes and creates nothing', emptyRun.inserted === 0 && collectionsAfterEmpty === 0);

        // ================= Clean migration =================
        const fixture = buildLegacyFixture();
        await insertFixture(db, fixture);
        const sourcesBefore = {};
        for (const name of ['riders', 'parcels', 'trackings', 'checkoutSessions', 'payments', 'notifications']) sourcesBefore[name] = await snapshot(db, name);

        const dryPlan = await legacy.planMigration(db);
        logTest('Dry run: plan is ok and counts every document to copy',
            dryPlan.ok === true && dryPlan.writeCount === 3 + 2 + 5 + 2 + 1, `writeCount=${dryPlan.writeCount} blocking=${dryPlan.blocking.map((b) => b.code)}`);
        const namesAfterDry = new Set((await db.listCollections().toArray()).map((c) => c.name));
        logTest('Dry run: performs no writes (no target collections, payments untouched)',
            !namesAfterDry.has('repair_requests') && !namesAfterDry.has('technicians') && !namesAfterDry.has('tracking_events')
            && (await db.collection('payments').countDocuments({ requestId: { $exists: true } })) === 0);
        logTest('Dry run: an orphan tracking event is a warning, not blocking',
            dryPlan.warnings.some((w) => w.code === 'orphan-tracking-event') && dryPlan.blocking.length === 0);
        logTest('Plan output never contains an email address', !/@/.test(legacy.formatPlan(dryPlan)));

        const countsBefore = await legacy.sourceCounts(db);
        const run = await legacy.executeMigration({ db, client, plan: dryPlan });
        logTest('Confirmed run: copies every document and links the payment', run.inserted === 12 && run.paymentsLinked === 1, JSON.stringify(run));

        const r1 = await db.collection('repair_requests').findOne({ _id: fixture.ids.r1 });
        logTest('IDs preserved: repair request keeps its _id', !!r1);
        logTest('Field renames: technicianId/technicianEmail/technicianName/deviceName set',
            r1.technicianId === fixture.ids.t1.toHexString() && r1.technicianEmail === 'tech1@example.test' && r1.technicianName === 'Tech One' && r1.deviceName === 'Laptop');
        logTest('Field renames: old names absent on the target copy',
            !('riderId' in r1) && !('riderEmail' in r1) && !('riderName' in r1) && !('parcelName' in r1));
        logTest('Unrelated fields and timestamps preserved',
            r1.parcelType === 'non-document' && r1.cost === 110 && r1.paymentStatus === 'paid' && r1.createdAt.getTime() === fixture.created.getTime());

        const tech = await db.collection('technicians').findOne({ _id: fixture.ids.t1 });
        logTest('Technician assignment preserved: technicianId resolves to the copied technician',
            !!tech && tech.email === r1.technicianEmail && tech.workStatus === 'in_delivery');

        const events = await db.collection('tracking_events').find({ trackingId: 'TRK-LEGACY-1' }).sort({ createdAt: 1 }).toArray();
        logTest('Tracking history preserved (all events, same order)', events.length === 3);
        logTest('Tracking status renamed with its derived details',
            events[0].status === 'repair_request_created' && events[0].details === 'repair request created');
        logTest('Tracking custom details kept while the status is renamed',
            events[2].status === 'repair_request_paid' && events[2].details === 'custom note kept');
        logTest('Orphan tracking event copied unchanged apart from the rename',
            (await db.collection('tracking_events').countDocuments({ trackingId: 'TRK-DELETED' })) === 1);

        const checkout = await db.collection('checkout_sessions').findOne({ sessionId: 'cs_test_2' });
        logTest('Checkout reference renamed parcelId -> requestId', checkout.requestId === fixture.ids.r2.toHexString() && !('parcelId' in checkout));

        const payment = await db.collection('payments').findOne({ sessionId: 'cs_test_1' });
        logTest('Payment gains requestId and keeps parcelId (additive)',
            payment.requestId === fixture.ids.r1.toHexString() && payment.parcelId === fixture.ids.r1.toHexString());
        logTest('Payment -> repair relationship resolves in the new collection',
            !!(await db.collection('repair_requests').findOne({ _id: new ObjectId(payment.requestId) })));
        const notification = await db.collection('notifications').findOne({});
        logTest('Notification reference still resolves to the migrated request',
            !!(await db.collection('repair_requests').findOne({ _id: new ObjectId(notification.entityId) })));

        let sourcesUnchanged = true;
        for (const name of ['riders', 'parcels', 'trackings', 'checkoutSessions', 'notifications']) {
            const after = await snapshot(db, name);
            if (!legacy.bsonEqual(after, sourcesBefore[name])) sourcesUnchanged = false;
        }
        logTest('No source deletion or modification (every source collection byte-for-byte unchanged)', sourcesUnchanged);

        const verification = await legacy.verifyMigration({ db, expectedSourceCounts: countsBefore });
        logTest('Post-migration verification passes', verification.ok === true, verification.checks.filter((c) => !c.ok).map((c) => c.name).join('; '));
        const repairIndexes = await db.collection('repair_requests').indexes();
        logTest('Required unique indexes exist on the targets',
            repairIndexes.some((i) => i.key.trackingId === 1 && i.unique)
            && (await db.collection('checkout_sessions').indexes()).some((i) => i.key.requestId === 1 && i.unique && i.partialFilterExpression));

        // ================= Idempotency =================
        const rerunPlan = await legacy.planMigration(db);
        const rerun = await legacy.executeMigration({ db, client, plan: rerunPlan });
        logTest('Rerun is idempotent: nothing left to write, every document identical',
            rerunPlan.ok === true && rerunPlan.writeCount === 0 && rerun.inserted === 0
            && rerunPlan.collections.find((c) => c.target === 'repair_requests').identical === 3);
        logTest('Rerun did not duplicate anything', (await db.collection('repair_requests').countDocuments({})) === 3 && (await db.collection('tracking_events').countDocuments({})) === 5);

        // ================= Conflicts abort =================
        await db.collection('repair_requests').updateOne({ _id: fixture.ids.r2 }, { $set: { cost: 999 } });
        const extraId = new ObjectId();
        await db.collection('parcels').insertOne({ _id: extraId, parcelName: 'New', senderEmail: 'x@example.test', trackingId: 'TRK-LEGACY-NEW', deliveryStatus: 'pending-pickup', createdAt: new Date() });
        const conflictPlan = await legacy.planMigration(db);
        const conflictRun = await legacy.executeMigration({ db, client, plan: conflictPlan });
        logTest('Conflicting target record blocks the run', conflictPlan.ok === false && conflictPlan.blocking.some((b) => b.code === 'target-conflict'));
        logTest('Conflict: nothing written, not even the unrelated new document',
            conflictRun.executed === false && !(await db.collection('repair_requests').findOne({ _id: extraId })));
        logTest('Conflict: the differing target is never overwritten', (await db.collection('repair_requests').findOne({ _id: fixture.ids.r2 })).cost === 999);
        await db.collection('repair_requests').updateOne({ _id: fixture.ids.r2 }, { $set: { cost: 60 } });

        // Duplicate unique key: a target-only request already uses the new
        // document's trackingId.
        await db.collection('repair_requests').insertOne({ _id: new ObjectId(), senderEmail: 'y@example.test', trackingId: 'TRK-LEGACY-NEW', deliveryStatus: 'pending-pickup', createdAt: new Date() });
        const duplicatePlan = await legacy.planMigration(db);
        logTest('Duplicate target unique key (trackingId) blocks the run', duplicatePlan.ok === false && duplicatePlan.blocking.some((b) => b.code === 'duplicate-tracking-id'));
        await db.collection('repair_requests').deleteOne({ trackingId: 'TRK-LEGACY-NEW' });

        // Field conflict: both old and new name with different values.
        await db.collection('parcels').updateOne({ _id: extraId }, { $set: { riderId: fixture.ids.t1.toHexString(), technicianId: fixture.ids.t2.toHexString() } });
        const fieldPlan = await legacy.planMigration(db);
        logTest('Old and new field with different values blocks the run', fieldPlan.blocking.some((b) => b.code === 'field-conflict'));

        // Dangling technician.
        await db.collection('parcels').updateOne({ _id: extraId }, { $unset: { technicianId: '' }, $set: { riderId: new ObjectId().toHexString() } });
        const danglingPlan = await legacy.planMigration(db);
        logTest('Dangling technician reference blocks the run', danglingPlan.blocking.some((b) => b.code === 'dangling-technician-reference'));
        await db.collection('parcels').updateOne({ _id: extraId }, { $unset: { riderId: '' } });

        // Two active checkouts for one request.
        await db.collection('checkoutSessions').insertOne({ _id: new ObjectId(), parcelId: extraId.toHexString(), active: true, status: 'open', createdAt: new Date() });
        await db.collection('checkoutSessions').insertOne({ _id: new ObjectId(), parcelId: extraId.toHexString(), active: true, status: 'creating', createdAt: new Date() });
        const checkoutPlan = await legacy.planMigration(db);
        logTest('Two active checkout sessions for one request block the run', checkoutPlan.blocking.some((b) => b.code === 'duplicate-active-checkout'));
        await db.collection('checkoutSessions').deleteMany({ parcelId: extraId.toHexString() });

        // Two paid payments for one request.
        const dupPaymentId = new ObjectId();
        await db.collection('payments').insertOne({ _id: dupPaymentId, sessionId: 'cs_test_dup', parcelId: fixture.ids.r1.toHexString(), paymentStatus: 'paid', amount: 110 });
        const paymentPlan = await legacy.planMigration(db);
        logTest('Two paid payments for one request block the run', paymentPlan.blocking.some((b) => b.code === 'duplicate-payment'));
        await db.collection('payments').deleteOne({ _id: dupPaymentId });

        // ================= Rollback: no partial write =================
        const pendingPlan = await legacy.planMigration(db);
        const unlinkedId = new ObjectId();
        await db.collection('payments').insertOne({ _id: unlinkedId, sessionId: 'cs_test_rollback', parcelId: extraId.toHexString(), paymentStatus: 'paid', amount: 10 });
        const rollbackPlan = await legacy.planMigration(db);
        let rollbackError = null;
        try {
            await legacy.executeMigration({ db, client, plan: rollbackPlan, hooks: { failAfterInserts: 1 } });
        } catch (error) {
            rollbackError = error;
        }
        logTest('Rollback: a failure inside the transaction surfaces as an error', !!rollbackError && pendingPlan.ok === true && rollbackPlan.writeCount === 2);
        logTest('Rollback: no document from the failed run was written',
            !(await db.collection('repair_requests').findOne({ _id: extraId }))
            && !(await db.collection('payments').findOne({ _id: unlinkedId, requestId: { $exists: true } })));
        const retry = await legacy.executeMigration({ db, client, plan: await legacy.planMigration(db) });
        logTest('Rollback: the same run succeeds afterwards', retry.inserted === 1 && retry.paymentsLinked === 1);

        // ================= Service seed (production guard + behaviour) =================
        logTest('Seed: production environment blocked by default', isSafeToSeed({ isProduction: true, resolvedDbName: 'sarabo_production' }).safe === false);
        logTest('Seed: production-named database blocked by default', isSafeToSeed({ isProduction: false, resolvedDbName: 'sarabo_production' }).safe === false);
        logTest('Seed: override without --expect-db is blocked', isSafeToSeed({ isProduction: true, resolvedDbName: 'sarabo_production', productionOverride: 'true' }).safe === false);
        logTest('Seed: override with the wrong database name is blocked', isSafeToSeed({ isProduction: true, resolvedDbName: 'sarabo_production', expectedDbName: 'sarabo-db', productionOverride: 'true' }).safe === false);
        logTest('Seed: exact database + override is allowed', isSafeToSeed({ isProduction: true, resolvedDbName: 'sarabo_production', expectedDbName: 'sarabo_production', productionOverride: 'true' }).safe === true);
        logTest('Seed: development unchanged (still allowed without flags)', isSafeToSeed({ isProduction: false, resolvedDbName: 'sarabo-db' }).safe === true);

        const seedCollection = db.collection('seed_test_service_definitions');
        const seedModel = new ServiceDefinitionModel(seedCollection);
        const seedDry = await runSeed({ model: seedModel, seedRows: SERVICE_DEFINITION_SEED, dryRun: true });
        logTest('Seed: dry run writes nothing', seedDry.created === 16 && (await seedCollection.countDocuments({})) === 0);
        // A deliberate production customisation that must survive.
        const custom = { ...SERVICE_DEFINITION_SEED[1], pricingRule: { ...SERVICE_DEFINITION_SEED[1].pricingRule, baseMin: 1700 } };
        await seedCollection.insertOne(buildDocumentFromInput(custom, new Date()));
        const seedFirst = await runSeed({ model: seedModel, seedRows: SERVICE_DEFINITION_SEED, dryRun: false });
        logTest('Seed: missing standard rows inserted, conflicting custom row reported', seedFirst.created === 15 && seedFirst.conflicted === 1);
        const customAfter = await seedCollection.findOne({ productCategorySlug: custom.productCategorySlug, repairCategorySlug: custom.repairCategorySlug });
        logTest('Seed: conflicting custom row not overwritten', customAfter.pricingRule.baseMin === 1700);
        const seedSecond = await runSeed({ model: seedModel, seedRows: SERVICE_DEFINITION_SEED, dryRun: false });
        logTest('Seed: rerun idempotent (identical rows skipped, nothing created)', seedSecond.created === 0 && seedSecond.skippedIdentical === 15 && (await seedCollection.countDocuments({})) === 16);

        // ================= BDT migration =================
        const bdtCollection = db.collection('bdt_test_service_definitions');
        const insertLegacyRows = async () => {
            const now = new Date('2026-08-05T00:00:00Z');
            await bdtCollection.insertMany(LEGACY_USD_SERVICE_DEFINITION_SEED.map((row) => ({ ...normaliseLegacyRow(row), createdAt: now, updatedAt: now })));
        };
        await insertLegacyRows();
        const bdtDry = await runBdtMigration({ collection: bdtCollection, seedRows: SERVICE_DEFINITION_SEED, dryRun: true, expectedCount: 16 });
        logTest('BDT: dry run plans 16 original USD rows and writes nothing',
            bdtDry.ok === true && bdtDry.modified === 16 && bdtDry.wrote === 0 && (await bdtCollection.countDocuments({ 'pricingRule.currency': 'usd' })) === 16);
        const bdtIds = (await bdtCollection.find({}).toArray()).map((d) => d._id.toHexString()).sort();
        const bdtApply = await runBdtMigration({ collection: bdtCollection, seedRows: SERVICE_DEFINITION_SEED, dryRun: false, expectedCount: 16 });
        const bdtAfter = await bdtCollection.find({}).toArray();
        logTest('BDT: original USD standard rows are upgraded', bdtApply.ok === true && bdtApply.wrote === 16 && bdtAfter.every((d) => d.pricingRule.currency === 'BDT'));
        logTest('BDT: upgraded rows match the BDT standard and keep _id/createdAt',
            JSON.stringify(bdtAfter.map((d) => d._id.toHexString()).sort()) === JSON.stringify(bdtIds)
            && bdtAfter.every((d) => d.createdAt.getTime() === new Date('2026-08-05T00:00:00Z').getTime())
            && SERVICE_DEFINITION_SEED.every((row) => {
                const doc = bdtAfter.find((d) => d.productCategorySlug === row.productCategorySlug && d.repairCategorySlug === row.repairCategorySlug);
                const built = buildDocumentFromInput(row, new Date());
                return WRITABLE_TOP_LEVEL_FIELDS.every((field) => JSON.stringify(doc[field]) === JSON.stringify(built[field]));
            }));
        const bdtRerun = await runBdtMigration({ collection: bdtCollection, seedRows: SERVICE_DEFINITION_SEED, dryRun: false, expectedCount: 16 });
        logTest('BDT: already-current rows skipped on rerun', bdtRerun.ok === true && bdtRerun.unchanged === 16 && bdtRerun.wrote === 0);

        await bdtCollection.deleteMany({});
        await insertLegacyRows();
        await bdtCollection.updateOne({ productCategorySlug: 'smartphone', repairCategorySlug: 'display-screen' }, { $set: { 'pricingRule.baseMin': 45 } });
        const bdtCustom = await runBdtMigration({ collection: bdtCollection, seedRows: SERVICE_DEFINITION_SEED, dryRun: false, expectedCount: 16 });
        logTest('BDT: a customised row aborts the whole run', bdtCustom.ok === false && bdtCustom.custom === 1 && bdtCustom.wrote === 0);
        logTest('BDT: abort leaves every row untouched (no partial upgrade)',
            (await bdtCollection.countDocuments({ 'pricingRule.currency': 'usd' })) === 16
            && (await bdtCollection.findOne({ productCategorySlug: 'smartphone', repairCategorySlug: 'display-screen' })).pricingRule.baseMin === 45);

        await bdtCollection.deleteMany({});
        await insertLegacyRows();
        await bdtCollection.deleteOne({ productCategorySlug: 'television', repairCategorySlug: 'diagnosis' });
        const bdtMissing = await runBdtMigration({ collection: bdtCollection, seedRows: SERVICE_DEFINITION_SEED, dryRun: false, expectedCount: 16 });
        logTest('BDT: wrong row count aborts with nothing written',
            bdtMissing.ok === false && bdtMissing.missing === 1 && bdtMissing.wrote === 0 && (await bdtCollection.countDocuments({ 'pricingRule.currency': 'usd' })) === 15);

        const bdtGuard = { overrideVarName: 'ALLOW_PROD_BDT_MIGRATION' };
        logTest('BDT: production guard blocks by default and allows only override + exact database',
            evaluateProductionGuard({ ...bdtGuard, isProduction: true, resolvedDbName: 'sarabo_production' }).safe === false
            && evaluateProductionGuard({ ...bdtGuard, isProduction: true, resolvedDbName: 'sarabo_production', expectedDbName: 'sarabo_production', overrideValue: 'true' }).safe === true
            && evaluateProductionGuard({ ...bdtGuard, isProduction: false, resolvedDbName: 'sarabo-db' }).safe === true);
    } finally {
        await dropTestDatabase();
    }
}

module.exports = { runProductionMigrationTests, MIGRATION_TEST_DB };
