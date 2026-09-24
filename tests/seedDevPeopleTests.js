// scripts/seed-dev-people.js: deterministic, valid dummy people; refuses any
// database but dev/test; reset removes only what it seeded.
async function runSeedDevPeopleTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const seed = require('../scripts/seed-dev-people');
    const { validateTechnicianExpertise } = require('../utils/technicianExpertise');
    if (process.env.NODE_ENV !== 'test' || !c.users.dbName.includes('test')) throw new Error('Isolated test database required');
    await connectDatabase();

    const now = new Date('2026-09-25T00:00:00Z');
    const a = seed.buildTechnicians(40, { now });
    const b = seed.buildTechnicians(40, { now });
    logTest('Seed: the same people are built every run', JSON.stringify(a) === JSON.stringify(b));
    logTest('Seed: every technician has valid expertise and a real region/district',
        a.technicians.every((t) => validateTechnicianExpertise(t.expertise).valid && (seed.REGIONS[t.region] || []).includes(t.district)));
    logTest('Seed: only approved technicians get the technician role',
        a.technicians.every((t, i) => (t.status === 'approved') === (a.users[i].role === 'rider')));
    logTest('Seed: every seeded email uses the seed domain and carries the marker',
        [...a.users, ...seed.buildCustomers(10, { now })].every((u) => u.email.endsWith(seed.SEED_EMAIL_DOMAIN) && u.seed === seed.SEED_MARKER));
    logTest('Seed: only the dev or a test database is allowed',
        seed.isDevOrTestDatabase('sarabo-db') && seed.isDevOrTestDatabase('sarabo-test-db') && !seed.isDevOrTestDatabase('sarabo_production'));

    // ---- seeded repair requests follow the app's rules ----
    const { ObjectId } = require('mongodb');
    const { satisfiesRequiredExpertiseLevel } = require('../utils/technicianExpertise');
    const { ACTIVE_STATUSES } = require('../utils/repairRequestStatus');
    const definitions = await c.serviceDefinitions.find({ isActive: true }).toArray();
    const people = seed.buildTechnicians(120, { now });
    const approved = people.technicians.filter((t) => t.status === 'approved').map((t) => ({ ...t, _id: new ObjectId() }));
    const built = seed.buildRepairRequests(300, { customers: seed.buildCustomers(60, { now }), technicians: approved, definitions, now });
    const byId = new Map(approved.map((t) => [t._id.toString(), t]));
    const defById = new Map(definitions.map((d) => [d._id.toString(), d]));
    const assigned = built.requests.filter((r) => r.technicianId);
    logTest('Seed requests: every assigned technician is local and qualified for the repair',
        assigned.length > 0 && assigned.every((r) => {
            const t = byId.get(r.technicianId);
            const entry = t && t.expertise.find((e) => e.productCategorySlug === r.product.categorySlug);
            return t && t.region === r.serviceLocation.region && entry && entry.repairCategorySlugs.includes(r.service.repairCategorySlug)
                && satisfiesRequiredExpertiseLevel(entry.level, defById.get(r.service.definitionId).requiredExpertiseLevel);
        }));
    const activeByTech = assigned.filter((r) => ACTIVE_STATUSES.includes(r.deliveryStatus)).map((r) => r.technicianId);
    logTest('Seed requests: no technician holds two active jobs, and busy ones are reported',
        new Set(activeByTech).size === activeByTech.length && built.busyTechnicianIds.length === activeByTech.length);
    logTest('Seed requests: paid means an approved quote; completed means a completion record; waiting means no technician',
        built.requests.every((r) => (r.paymentStatus !== 'paid' || (r.quote && r.quote.status === 'approved'))
            && (r.deliveryStatus !== 'repair_completed' || (r.repair && r.repair.completion && r.repair.completion.completedAt instanceof Date))
            && (r.deliveryStatus !== 'pending-pickup' || !r.technicianId)));
    logTest('Seed requests: every request has a pickup slot and nothing is dated in the future',
        built.requests.every((r) => r.pickupSlot && r.createdAt <= now && r.updatedAt <= now && r.createdAt <= r.updatedAt));

    const realEmail = `real-person-${Date.now()}@example.test`;
    await c.users.insertOne({ email: realEmail, role: 'user', createdAt: new Date() });
    try {
        await seed.runSeed({ collections: c, technicianCount: 12, customerCount: 5, dryRun: false });
        await seed.runSeed({ collections: c, technicianCount: 12, customerCount: 5, dryRun: false });
        const seededUsers = await c.users.countDocuments({ seed: seed.SEED_MARKER });
        const seededTechs = await c.technicians.countDocuments({ seed: seed.SEED_MARKER });
        logTest('Seed: running twice does not duplicate anyone', seededUsers === 17 && seededTechs === 12);
        const reset = await seed.runReset({ collections: c, dryRun: false });
        logTest('Seed: reset removes only seeded people',
            reset.users === 17 && reset.technicians === 12 && (await c.users.countDocuments({ email: realEmail })) === 1);
    } finally {
        await c.users.deleteOne({ email: realEmail });
        await seed.runReset({ collections: c, dryRun: false });
    }
}

module.exports = { runSeedDevPeopleTests };
