// scripts/seed-dev-jobs.js: deterministic dummy open jobs that follow the
// app's rules (open, takeable, offers within the fee limit, pickup slots valid).
async function runSeedDevJobsTests({ logTest }) {
    const { ObjectId } = require('mongodb');
    const { connectDatabase, collections: c } = require('../config/database');
    const people = require('../scripts/seed-dev-people');
    const jobsSeed = require('../scripts/seed-dev-jobs');
    const { isOpenForApplications } = require('../utils/jobPortal');
    const { canTechnicianEverTakeRequest } = require('../services/technicianEligibilityService');
    const { validatePickupSlotInput } = require('../utils/pickupSlots');
    if (process.env.NODE_ENV !== 'test' || !c.users.dbName.includes('test')) throw new Error('Isolated test database required');
    await connectDatabase();

    const now = new Date('2026-09-30T06:00:00Z');
    const definitions = await c.serviceDefinitions.find({ isActive: true }).toArray();
    const seededTechs = people.buildTechnicians(120, { now }).technicians.map((t) => ({ ...t, _id: new ObjectId() }));
    const own = {
        _id: new ObjectId(), name: 'Own Tech', email: 'own@example.test', status: 'approved', region: 'Sylhet', district: 'Sylhet',
        expertise: [{ productCategorySlug: definitions[0].productCategorySlug, repairCategorySlugs: [definitions[0].repairCategorySlug], level: 'expert', experienceYears: 9 }],
    };
    const input = { customers: people.buildCustomers(20, { now }), technicians: [own, ...seededTechs], definitions, now };
    const a = jobsSeed.buildOpenJobs(24, input);
    const b = jobsSeed.buildOpenJobs(24, input);
    const defById = new Map(definitions.map((d) => [d._id.toString(), d]));
    const needs = (j) => ({
        region: j.serviceLocation.region, productCategorySlug: j.product.categorySlug,
        repairCategorySlug: j.service.repairCategorySlug, requiredExpertiseLevel: defById.get(j.service.definitionId).requiredExpertiseLevel,
    });

    logTest('Seed jobs: the same jobs and offers are built every run', JSON.stringify(a) === JSON.stringify(b) && a.jobs.length === 24);
    logTest('Seed jobs: every job is open on the board and carries the seed marker and prefix',
        a.jobs.every((j) => isOpenForApplications(j) && j.seed === jobsSeed.SEED_MARKER && j.trackingId.startsWith(jobsSeed.SEED_TRACKING_PREFIX)));
    logTest('Seed jobs: every job can be taken by an approved technician, and some by your own technician',
        a.jobs.every((j) => input.technicians.some((t) => canTechnicianEverTakeRequest(t, needs(j))))
        && a.jobs.filter((j) => canTechnicianEverTakeRequest(own, needs(j))).length >= Math.ceil(24 * 0.4));
    logTest('Seed jobs: pickup slots are real, upcoming and never on a Friday',
        a.jobs.every((j) => j.pickupSlot && validatePickupSlotInput({ date: j.pickupSlot.date, slotId: j.pickupSlot.slotId }, now).valid
            && new Date(`${j.pickupSlot.date}T00:00:00Z`).getUTCDay() !== 5));
    const jobByTracking = new Map(a.jobs.map((j) => [j.trackingId, j]));
    logTest('Seed jobs: offers come only from seeded technicians who can take the job, within the fee limit',
        a.offers.length > 0 && a.offers.every((o) => {
            const job = jobByTracking.get(o.trackingId);
            const tech = seededTechs.find((t) => t._id.toString() === o.technicianId);
            return job && tech && canTechnicianEverTakeRequest(tech, needs(job)) && o.status === 'pending'
                && o.inspectionFee <= job.pricing.inspectionFee && o.estimateMin <= o.estimateMax;
        }));
    logTest('Seed jobs: some are reposted and the oldest two have no offers (for the 24-hour alert)',
        a.jobs.some((j) => j.repostedAt && j.repostCount === 1)
        && a.jobs.slice(-2).every((j) => !a.offers.some((o) => o.trackingId === j.trackingId) && now - j.createdAt > 24 * 3600000));
}

module.exports = { runSeedDevJobsTests };
