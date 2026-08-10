// DEVELOPMENT-ONLY QA seed for manual v1.1 testing (Phase 8.5).
//
// Seeds a deterministic, clearly-namespaced set of repair-request (parcel)
// scenarios - one per lifecycle state - plus the matching QA identity role
// rows, so a human tester can walk the whole customer/technician/admin flow
// locally without hand-building documents. This never creates Firebase Auth
// accounts (see docs/local-v1.1-qa.md for the manual Firebase-side setup); it
// only seeds the Mongo state and the users-collection ROLE rows keyed to the
// documented QA emails.
//
// Usage:
//   node scripts/seed-qa-parcels.js                      (dry-run - writes nothing)
//   node scripts/seed-qa-parcels.js --confirm-seed       (upsert QA users + parcels)
//   node scripts/seed-qa-parcels.js --reset              (dry-run of the namespaced cleanup)
//   node scripts/seed-qa-parcels.js --reset --confirm-seed   (delete QA data, then reseed)
//
// If both --dry-run and --confirm-seed are passed, the safer dry-run wins.
//
// Safety design (mirrors scripts/seed-service-definitions.js exactly, and
// reuses its isSafeToSeed check): refuses to run when isProductionEnvironment()
// is true AND independently when the resolved database name looks like a
// production database. Every read, write, and delete is scoped to the QA
// namespace (trackingId starts with QA_TRACKING_PREFIX, emails end with
// QA_EMAIL_DOMAIN) - it never touches a real user, rider, payment, or parcel.
// It performs no Stripe calls and no Storage access. Never prints MONGO_URI or
// any secret - only the resolved database name and computed counts.
//
// This is both a CLI entrypoint and a requirable module: the pure builders
// (buildQaUsers / buildQaParcels) and the safety re-export are usable from
// tests without the CLI's connect/process.exit flow.

const { ObjectId } = require('mongodb');
const { isSafeToSeed } = require('./seed-service-definitions');

// --- QA namespace (the ONLY documents this script ever reads or writes) ------
const QA_TRACKING_PREFIX = 'QA-';
const QA_EMAIL_DOMAIN = '@sarabo.local';

const QA_IDENTITIES = {
    customer: { email: `qa.customer${QA_EMAIL_DOMAIN}`, role: 'user', name: 'QA Customer' },
    techA: { email: `qa.tech-a${QA_EMAIL_DOMAIN}`, role: 'rider', name: 'QA Technician A' },
    techB: { email: `qa.tech-b${QA_EMAIL_DOMAIN}`, role: 'rider', name: 'QA Technician B' },
    admin: { email: `qa.admin${QA_EMAIL_DOMAIN}`, role: 'admin', name: 'QA Admin' },
};

// Deterministic, obviously-fake ObjectIds for the two QA technicians so the
// seeded parcels reference a stable riderId across re-runs.
const QA_TECH_A_ID = new ObjectId('0000000000000000000000a1');
const QA_TECH_B_ID = new ObjectId('0000000000000000000000b2');

// A fixed base time so re-running the seed produces identical documents
// (idempotency by value, not just by key).
const QA_BASE_TIME = new Date('2026-01-01T00:00:00.000Z');
function at(minutesOffset) {
    return new Date(QA_BASE_TIME.getTime() + minutesOffset * 60_000);
}

// Role rows for the QA identities. Firebase Auth accounts with the same emails
// must be created manually (docs/local-v1.1-qa.md) - these rows only carry the
// server-side role the app resolves after login.
function buildQaUsers() {
    return Object.values(QA_IDENTITIES).map((identity) => ({
        email: identity.email,
        role: identity.role,
        displayName: identity.name,
        createdAt: QA_BASE_TIME,
    }));
}

// --- Reusable sub-document builders (shapes match the real controllers) ------
function qaInspection() {
    return {
        status: 'submitted',
        diagnosis: { summary: 'Cracked display assembly; digitizer intact.', detectedIssues: [] },
        repairability: { decision: 'repairable', reason: 'Screen replacement is straightforward.' },
        estimate: { laborEstimate: 1500, partsEstimate: 3000, currency: 'BDT' },
        internalNotes: 'QA note (technician-private) - verify part number before ordering.',
        submittedAt: at(50),
        submittedByRiderId: QA_TECH_B_ID,
        submittedByEmail: QA_IDENTITIES.techB.email,
        version: 1,
    };
}
function qaQuote(status) {
    return {
        status,
        laborAmount: 1500,
        partsAmount: 3000,
        additionalCharges: 0,
        totalAmount: 4500,
        currency: 'BDT',
        notes: 'QA quote note (internal).',
        submittedAt: at(60),
        submittedByRiderId: QA_TECH_B_ID,
        decidedAt: status === 'submitted' ? null : at(70),
        decisionReason: status === 'rejected' ? 'QA: customer declined the estimate.' : null,
        version: 1,
    };
}
function qaRepair(completed) {
    const base = {
        status: completed ? 'completed' : 'in_progress',
        startedAt: at(90),
        progressUpdates: [{ id: 'qa-p1', message: 'Ordered replacement screen.', createdAt: at(95) }],
        version: 1,
    };
    if (completed) {
        base.completedAt = at(120);
        base.completedByRiderId = QA_TECH_B_ID;
        base.completion = {
            summary: 'Screen replaced and unit tested.',
            evidenceImages: [{ imageId: 'qa-ev1', storageKey: 'repair-evidence/QA/ev1.jpg', mimeType: 'image/jpeg', size: 1024 }],
        };
    }
    return base;
}
function qaPayment() {
    return {
        status: 'completed',
        provider: 'stripe',
        paymentIntentId: 'pi_QA_seed_test_only',
        amount: 4500,
        currency: 'BDT',
        quoteVersion: 1,
        completedAt: at(80),
    };
}
function pendingAssignmentEntry(techEmail, techName) {
    return {
        assignmentId: 'qa-assign-1',
        riderId: QA_TECH_A_ID,
        riderEmail: techEmail,
        riderName: techName,
        assignedByEmail: QA_IDENTITIES.admin.email,
        decision: 'pending',
        decidedAt: null,
        createdAt: at(20),
    };
}
function rejectedAssignmentEntry(techEmail, techName) {
    return {
        assignmentId: 'qa-assign-0',
        riderId: QA_TECH_A_ID,
        riderEmail: techEmail,
        riderName: techName,
        assignedByEmail: QA_IDENTITIES.admin.email,
        decision: 'rejected',
        rejectionReason: 'QA: Technician A is unavailable for this repair window.',
        decidedAt: at(25),
        createdAt: at(20),
    };
}

// Every QA parcel shares this base; scenario builders layer status + the
// relevant sub-documents on top.
function baseParcel(seq, overrides) {
    const trackingId = `${QA_TRACKING_PREFIX}${String(seq).padStart(2, '0')}`;
    return {
        schemaVersion: 2,
        trackingId,
        senderEmail: QA_IDENTITIES.customer.email,
        senderName: QA_IDENTITIES.customer.name,
        parcelName: 'Laptop screen repair',
        product: { categorySlug: 'laptop', brand: 'Acme', model: 'X1' },
        damage: { description: 'Cracked screen after a drop.', images: [] },
        paymentStatus: 'unpaid',
        cost: 4500,
        createdAt: at(seq),
        updatedAt: at(seq),
        ...overrides,
    };
}
function assignedTo(identity) {
    return { riderEmail: identity.email, riderName: identity.name, riderId: QA_TECH_B_ID };
}

// The full deterministic scenario matrix (12 requests).
function buildQaParcels() {
    return [
        // 1. brand-new, unassigned, deletable
        baseParcel(1, { deliveryStatus: 'pending-pickup' }),
        // 2. offered to a technician, awaiting their decision
        baseParcel(2, {
            deliveryStatus: 'assignment_pending',
            ...assignedTo(QA_IDENTITIES.techB),
            assignmentHistory: [pendingAssignmentEntry(QA_IDENTITIES.techB.email, QA_IDENTITIES.techB.name)],
        }),
        // 3. technician accepted -> assigned
        baseParcel(3, { deliveryStatus: 'driver_assigned', ...assignedTo(QA_IDENTITIES.techB) }),
        // 4. picked up
        baseParcel(4, { deliveryStatus: 'parcel_picked_up', ...assignedTo(QA_IDENTITIES.techB) }),
        // 5. inspection completed
        baseParcel(5, { deliveryStatus: 'inspection_completed', ...assignedTo(QA_IDENTITIES.techB), inspection: qaInspection() }),
        // 6. quote submitted, awaiting customer decision
        baseParcel(6, { deliveryStatus: 'quote_submitted', ...assignedTo(QA_IDENTITIES.techB), inspection: qaInspection(), quote: qaQuote('submitted') }),
        // 7. quote approved, payment eligible
        baseParcel(7, { deliveryStatus: 'quote_approved', ...assignedTo(QA_IDENTITIES.techB), inspection: qaInspection(), quote: qaQuote('approved') }),
        // 8. payment completed
        baseParcel(8, {
            deliveryStatus: 'payment_completed', paymentStatus: 'paid',
            ...assignedTo(QA_IDENTITIES.techB), inspection: qaInspection(), quote: qaQuote('approved'), payment: qaPayment(),
        }),
        // 9. repair in progress
        baseParcel(9, {
            deliveryStatus: 'repair_in_progress', paymentStatus: 'paid',
            ...assignedTo(QA_IDENTITIES.techB), inspection: qaInspection(), quote: qaQuote('approved'), payment: qaPayment(), repair: qaRepair(false),
        }),
        // 10. repair completed
        baseParcel(10, {
            deliveryStatus: 'repair_completed', paymentStatus: 'paid',
            ...assignedTo(QA_IDENTITIES.techB), inspection: qaInspection(), quote: qaQuote('approved'), payment: qaPayment(), repair: qaRepair(true),
        }),
        // 11. an assignment that was rejected, returned for reassignment
        baseParcel(11, {
            deliveryStatus: 'pending-pickup',
            assignmentHistory: [rejectedAssignmentEntry(QA_IDENTITIES.techA.email, QA_IDENTITIES.techA.name)],
        }),
        // 12. a quote the customer rejected
        baseParcel(12, {
            deliveryStatus: 'quote_rejected',
            ...assignedTo(QA_IDENTITIES.techB), inspection: qaInspection(), quote: qaQuote('rejected'),
        }),
    ];
}

// --- Idempotent write / namespaced cleanup (pure of console/process) --------
async function runQaSeed({ collections, dryRun }) {
    const users = buildQaUsers();
    const parcels = buildQaParcels();
    if (dryRun) {
        return { dryRun: true, usersUpserted: 0, parcelsUpserted: 0, wouldUpsertUsers: users.length, wouldUpsertParcels: parcels.length };
    }
    let usersUpserted = 0;
    for (const user of users) {
        await collections.users.updateOne({ email: user.email }, { $set: user }, { upsert: true });
        usersUpserted += 1;
    }
    let parcelsUpserted = 0;
    for (const parcel of parcels) {
        await collections.parcels.updateOne({ trackingId: parcel.trackingId }, { $set: parcel }, { upsert: true });
        parcelsUpserted += 1;
    }
    return { dryRun: false, usersUpserted, parcelsUpserted };
}

async function runQaReset({ collections, dryRun }) {
    const parcelFilter = { trackingId: { $regex: `^${QA_TRACKING_PREFIX}` } };
    const userFilter = { email: { $regex: `${QA_EMAIL_DOMAIN.replace('.', '\\.')}$` } };
    if (dryRun) {
        const [parcels, users] = await Promise.all([
            collections.parcels.countDocuments(parcelFilter),
            collections.users.countDocuments(userFilter),
        ]);
        return { dryRun: true, wouldDeleteParcels: parcels, wouldDeleteUsers: users };
    }
    const [p, u] = await Promise.all([
        collections.parcels.deleteMany(parcelFilter),
        collections.users.deleteMany(userFilter),
    ]);
    return { dryRun: false, deletedParcels: p.deletedCount, deletedUsers: u.deletedCount };
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
    const args = process.argv.slice(2);
    const confirmSeed = args.includes('--confirm-seed');
    const explicitDryRun = args.includes('--dry-run');
    const isDryRun = explicitDryRun || !confirmSeed;
    const isReset = args.includes('--reset');

    (async () => {
        console.log(`QA seed - database: "${resolvedDbName}", mode: ${isDryRun ? 'DRY RUN (no writes)' : 'WRITE (--confirm-seed)'}${isReset ? ', reset requested' : ''}`);
        console.log(`QA namespace: trackingId "${QA_TRACKING_PREFIX}*", emails "*${QA_EMAIL_DOMAIN}" (nothing else is ever touched)`);
        console.log('');

        await connectDatabase();

        if (isReset) {
            const reset = await runQaReset({ collections, dryRun: isDryRun });
            if (reset.dryRun) console.log(`Reset (dry run): would delete ${reset.wouldDeleteParcels} QA parcels, ${reset.wouldDeleteUsers} QA users.`);
            else console.log(`Reset: deleted ${reset.deletedParcels} QA parcels, ${reset.deletedUsers} QA users.`);
        }

        const result = await runQaSeed({ collections, dryRun: isDryRun });
        if (result.dryRun) {
            console.log(`Seed (dry run): would upsert ${result.wouldUpsertUsers} QA users and ${result.wouldUpsertParcels} QA parcels.`);
            console.log('');
            console.log('Dry run only - nothing written. Re-run with --confirm-seed to write.');
        } else {
            console.log(`Seed: upserted ${result.usersUpserted} QA users and ${result.parcelsUpserted} QA parcels.`);
        }
    })()
        .catch((error) => {
            console.error('QA seed execution error:', error.message);
            process.exitCode = 1;
        })
        .finally(async () => {
            await client.close();
        });
}

module.exports = {
    QA_TRACKING_PREFIX,
    QA_EMAIL_DOMAIN,
    QA_IDENTITIES,
    buildQaUsers,
    buildQaParcels,
    runQaSeed,
    runQaReset,
    isSafeToSeed,
};
