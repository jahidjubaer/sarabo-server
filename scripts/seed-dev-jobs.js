// DEVELOPMENT-ONLY seed of dummy open jobs for the open jobs board (/jobs):
// waiting repair requests from the seeded customers, each with a placeholder
// photo (so it is open), some with offers from seeded technicians and some
// reposted after a rejected offer.
//
// Usage:
//   node scripts/seed-dev-jobs.js                         (dry run - writes nothing)
//   node scripts/seed-dev-jobs.js --confirm-seed          (upsert the dummy jobs)
//   node scripts/seed-dev-jobs.js --reset --confirm-seed  (delete them and their offers)
//   options: --count=24
//
// Needs the dummy people first (node scripts/seed-dev-people.js --confirm-seed).
// About 40% of the jobs are ones your own (non-seeded) approved technicians
// can take, so they show up in the signed-in technician view; the rest are
// spread over every region. Every job can be taken by at least one approved
// technician, as the app requires when a request is created.
//
// The placeholder photo has no stored file: the board and matching treat the
// job as open, and the photo viewer simply shows no photos.
//
// Safety: same guards as seed-dev-people.js (never production; only the
// local dev database or a test database). Everything written carries
// `seed: SEED_MARKER`; jobs start SEED_TRACKING_PREFIX. --reset deletes only those.
const { isSafeToSeed } = require('./seed-service-definitions');
const { SEED_MARKER: PEOPLE_MARKER, REGIONS, isDevOrTestDatabase } = require('./seed-dev-people');
const { canTechnicianEverTakeRequest } = require('../services/technicianEligibilityService');
const { PICKUP_SLOTS, validatePickupSlotInput, dhakaDateString } = require('../utils/pickupSlots');

const SEED_MARKER = 'dev-jobs';
const SEED_TRACKING_PREFIX = 'SEED-J';
const DEFAULT_COUNT = 24;
const MAX_COUNT = 200;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const BRANDS = {
    smartphone: ['Samsung', 'Xiaomi', 'Realme', 'Apple', 'Oppo', 'Vivo'],
    'laptop-computer': ['HP', 'Lenovo', 'Dell', 'Asus', 'Acer'],
    television: ['Walton', 'Samsung', 'Sony', 'LG', 'Vision'],
    refrigerator: ['Walton', 'Singer', 'LG', 'Samsung'],
    'air-conditioner': ['Gree', 'General', 'Walton', 'Midea'],
    'washing-machine': ['LG', 'Samsung', 'Walton', 'Whirlpool'],
    'microwave-oven': ['Walton', 'Panasonic', 'Samsung', 'Miyako'],
};
const PROBLEMS = {
    'display-screen': ['Screen cracked after a fall, touch works only on the top half.', 'Display shows green lines and flickers.', 'Screen went black but I can hear sound.'],
    'battery-power': ['Battery drains from full to zero in two hours.', 'Does not charge unless the cable is held at an angle.', 'Battery is swollen and the back cover is lifting.'],
    motherboard: ['Phone fell in water and will not turn on now.', 'Restarts by itself every few minutes.'],
    'cooling-overheating': ['Runs all day but the room never gets cool.', 'Outdoor unit makes a loud noise and the indoor unit drips water.'],
    'compressor-cooling': ['Freezer works but the bottom part is not cold.', 'Compressor clicks on and off and nothing cools.'],
    'electrical-power': ['Trips the breaker as soon as I switch it on.', 'No power at all, the display stays off.'],
    'mechanical-parts': ['Drum does not spin and there is a burning smell.', 'Door will not lock so the wash never starts.'],
    diagnosis: ['Not sure what is wrong - it stopped working yesterday.', 'Makes a strange noise and then switches off.'],
    other: ['Buttons stopped responding after a power cut.', 'Remote and panel both stopped working.'],
};
const OFFER_NOTES = [
    'I can check it the same day and bring the part if needed.',
    'Likely a common fault - I have the part in stock.',
    'Price depends on the part after inspection.',
    '',
];

// Small deterministic PRNG (mulberry32), so every run builds the same jobs.
function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const pick = (random, list) => list[Math.floor(random() * list.length)];

function needsOf(region, definition) {
    return {
        region,
        productCategorySlug: definition.productCategorySlug,
        repairCategorySlug: definition.repairCategorySlug,
        requiredExpertiseLevel: definition.requiredExpertiseLevel,
    };
}

// An upcoming pickup slot (1-6 days ahead, never a Friday), checked by the app's rules.
function upcomingPickupSlot(random, now) {
    const slotId = pick(random, PICKUP_SLOTS).slotId;
    const start = 1 + Math.floor(random() * 6);
    for (let offset = 0; offset < 8; offset += 1) {
        const date = dhakaDateString(new Date(now.getTime() + (start + offset) * DAY_MS));
        if (new Date(`${date}T00:00:00Z`).getUTCDay() === 5) continue;
        const check = validatePickupSlotInput({ date, slotId }, now);
        if (check.valid) return check.pickupSlot;
    }
    return null;
}

// Pure: builds the job documents and their offers (offers carry the job's
// trackingId; the request id is filled in once the job is written).
function buildOpenJobs(count, { customers, technicians, definitions, now = new Date() }) {
    const random = createRandom(7171);
    const approved = technicians.filter((t) => t.status === 'approved');
    const own = approved.filter((t) => t.seed !== PEOPLE_MARKER);
    const seeded = approved.filter((t) => t.seed === PEOPLE_MARKER);
    const regions = Object.keys(REGIONS);
    const jobs = [];
    const offers = [];

    for (let i = 1; i <= count; i += 1) {
        const forOwn = own.length > 0 && i <= Math.ceil(count * 0.4);
        // Only repairs someone there can take, as the app's creation gate requires.
        let region = null;
        let definition = null;
        for (let attempt = 0; attempt < 20 && !definition; attempt += 1) {
            const target = forOwn ? pick(random, own) : null;
            const tryRegion = target ? target.region : pick(random, regions);
            const takers = target ? [target] : approved;
            const possible = definitions.filter((d) => takers.some((t) => canTechnicianEverTakeRequest(t, needsOf(tryRegion, d))));
            if (possible.length) {
                region = tryRegion;
                definition = pick(random, possible);
            }
        }
        if (!definition) continue;

        const trackingId = `${SEED_TRACKING_PREFIX}${String(i).padStart(4, '0')}`;
        const district = REGIONS[region] ? pick(random, REGIONS[region]) : region;
        // Mostly recent; the last two are over a day old with no offers, so
        // the admin's "No offers in 24h" alert has something to show.
        const stale = i > count - 2;
        const postedAt = new Date(now.getTime() - (stale ? 26 + random() * 10 : 1 + random() * 20) * HOUR_MS);
        const reposted = !stale && random() < 0.2;
        const brand = pick(random, BRANDS[definition.productCategorySlug] || ['Generic']);
        const job = {
            schemaVersion: 2,
            senderEmail: pick(random, customers).email,
            trackingId,
            product: { categorySlug: definition.productCategorySlug, brand, model: `M${100 + Math.floor(random() * 900)}` },
            service: { definitionId: definition._id.toString(), repairCategorySlug: definition.repairCategorySlug },
            damage: {
                description: pick(random, PROBLEMS[definition.repairCategorySlug] || PROBLEMS.diagnosis),
                images: [{
                    storageKey: `seed/${SEED_MARKER}/${trackingId}.jpg`, url: '', mimeType: 'image/jpeg', size: 1,
                    uploadedAt: postedAt, uploadedByRole: 'user', seed: true,
                }],
            },
            serviceLocation: { region, district, address: `${1 + Math.floor(random() * 150)} ${district} Road` },
            pricing: {
                currency: definition.pricingRule.currency,
                estimateMin: definition.pricingRule.baseMin,
                estimateMax: definition.pricingRule.baseMax,
                inspectionFee: definition.pricingRule.inspectionFee,
                calculationVersion: definition.pricingRule.version,
                quotedAmount: null,
                quoteStatus: definition.inspectionRequired ? 'pending_inspection' : 'awaiting_quote',
                customerApprovedAt: null,
                finalAmount: null,
            },
            pickupSlot: upcomingPickupSlot(random, now),
            deliveryStatus: 'pending-pickup',
            createdAt: new Date(postedAt.getTime() - 10 * 60 * 1000),
            updatedAt: postedAt,
            seed: SEED_MARKER,
        };
        if (reposted) {
            job.repostedAt = new Date(Math.min(now.getTime(), postedAt.getTime() + (1 + random() * 4) * HOUR_MS));
            job.repostCount = 1;
        }
        jobs.push(job);

        // 0-2 offers from seeded technicians (never your own, so you can apply).
        if (stale) continue;
        const takers = seeded.filter((t) => canTechnicianEverTakeRequest(t, needsOf(region, definition)));
        const offerCount = Math.min(takers.length, Math.floor(random() * 3));
        const cap = Math.floor(definition.pricingRule.inspectionFee || 0);
        const chosen = new Set();
        while (chosen.size < offerCount) chosen.add(pick(random, takers));
        for (const tech of chosen) {
            const min = definition.pricingRule.baseMin + Math.floor(random() * 5) * 100;
            offers.push({
                trackingId,
                technicianId: tech._id.toString(),
                technicianEmail: tech.email,
                technicianName: tech.name,
                estimateMin: min,
                estimateMax: Math.max(min, definition.pricingRule.baseMax - Math.floor(random() * 5) * 100),
                inspectionFee: cap > 0 ? Math.max(0, cap - Math.floor(random() * 3) * 50) : 0,
                note: pick(random, OFFER_NOTES),
                status: 'pending',
                createdAt: new Date(postedAt.getTime() + (1 + random() * 3) * HOUR_MS),
                updatedAt: new Date(postedAt.getTime() + (1 + random() * 3) * HOUR_MS),
                seed: SEED_MARKER,
            });
        }
    }
    return { jobs, offers, ownTechnicians: own.length };
}

const seededJobFilter = { seed: SEED_MARKER, trackingId: { $regex: `^${SEED_TRACKING_PREFIX}` } };

async function seededJobIds(collections) {
    return (await collections.repairRequests.find(seededJobFilter, { projection: { _id: 1 } }).toArray()).map((r) => r._id.toString());
}

async function runJobSeed({ collections, count, dryRun, now = new Date() }) {
    const [customers, technicians, definitions] = await Promise.all([
        collections.users.find({ seed: PEOPLE_MARKER, role: 'user' }).toArray(),
        collections.technicians.find({ status: 'approved' }).toArray(),
        collections.serviceDefinitions.find({ isActive: true }).toArray(),
    ]);
    if (customers.length === 0) throw new Error('seed the dummy people first: node scripts/seed-dev-people.js --confirm-seed');
    if (definitions.length === 0) throw new Error('no active service definitions - run npm run seed:service-definitions first');
    const { jobs, offers, ownTechnicians } = buildOpenJobs(count, { customers, technicians, definitions, now });
    const summary = {
        jobs: jobs.length,
        offers: offers.length,
        reposted: jobs.filter((j) => j.repostedAt).length,
        forOwnTechnicians: ownTechnicians,
        byRegion: jobs.reduce((acc, j) => ({ ...acc, [j.serviceLocation.region]: (acc[j.serviceLocation.region] || 0) + 1 }), {}),
    };
    if (dryRun) return { dryRun: true, ...summary };

    // Old offers on seeded jobs go first, then the jobs are upserted and the
    // offers written fresh against their ids.
    await collections.jobApplications.deleteMany({ requestId: { $in: await seededJobIds(collections) } });
    if (jobs.length) {
        await collections.repairRequests.bulkWrite(jobs.map((doc) => ({
            replaceOne: { filter: { trackingId: doc.trackingId, seed: SEED_MARKER }, replacement: doc, upsert: true },
        })), { ordered: false });
    }
    await collections.repairRequests.deleteMany({ ...seededJobFilter, trackingId: { $nin: jobs.map((j) => j.trackingId) } });
    const idByTracking = new Map((await collections.repairRequests.find(seededJobFilter, { projection: { trackingId: 1 } }).toArray())
        .map((r) => [r.trackingId, r._id.toString()]));
    const offerDocs = offers.map(({ trackingId, ...offer }) => ({ ...offer, requestId: idByTracking.get(trackingId) })).filter((o) => o.requestId);
    if (offerDocs.length) await collections.jobApplications.insertMany(offerDocs, { ordered: false });
    return { dryRun: false, ...summary };
}

async function runJobReset({ collections, dryRun }) {
    const ids = await seededJobIds(collections);
    if (dryRun) {
        return { dryRun: true, jobs: ids.length, offers: await collections.jobApplications.countDocuments({ requestId: { $in: ids } }) };
    }
    const offers = await collections.jobApplications.deleteMany({ requestId: { $in: ids } });
    const jobs = await collections.repairRequests.deleteMany(seededJobFilter);
    return { dryRun: false, jobs: jobs.deletedCount, offers: offers.deletedCount };
}

function readCount(args, fallback) {
    const arg = args.find((a) => a.startsWith('--count='));
    if (!arg) return fallback;
    const value = Number(arg.split('=')[1]);
    if (!Number.isInteger(value) || value < 1 || value > MAX_COUNT) throw new Error(`--count must be a whole number from 1 to ${MAX_COUNT}`);
    return value;
}

if (require.main === module) {
    require('dotenv').config({ quiet: true });
    const { isProductionEnvironment } = require('../config/siteOrigin');
    const { resolveDatabaseName } = require('../config/databaseName');

    const resolvedDbName = resolveDatabaseName();
    const safety = isSafeToSeed({ isProduction: isProductionEnvironment(), resolvedDbName });
    if (!safety.safe) {
        console.error(`Refusing to run: ${safety.reason}.`);
        process.exit(1);
    }
    if (!isDevOrTestDatabase(resolvedDbName)) {
        console.error(`Refusing to run: "${resolvedDbName}" is not the local dev database or a test database.`);
        process.exit(1);
    }

    const args = process.argv.slice(2);
    const dryRun = !args.includes('--confirm-seed');
    const reset = args.includes('--reset');
    let count;
    try {
        count = readCount(args, DEFAULT_COUNT);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }

    const { connectDatabase, collections, client } = require('../config/database');
    (async () => {
        console.log(`Dev jobs seed - database "${resolvedDbName}", ${dryRun ? 'DRY RUN (nothing written)' : 'WRITE'}${reset ? ', reset' : ''}`);
        await connectDatabase();
        if (reset) {
            const r = await runJobReset({ collections, dryRun });
            console.log(`${r.dryRun ? 'Would delete' : 'Deleted'} ${r.jobs} seeded jobs and ${r.offers} offers on them.`);
            if (r.dryRun) console.log('Re-run with --confirm-seed to delete.');
            return;
        }
        const s = await runJobSeed({ collections, count, dryRun });
        console.log(`${s.dryRun ? 'Would upsert' : 'Upserted'} ${s.jobs} open jobs (${s.reposted} reposted) with ${s.offers} offers from seeded technicians.`);
        console.log('Jobs by region:', Object.entries(s.byRegion).map(([k, v]) => `${k} ${v}`).join(', '));
        if (s.forOwnTechnicians === 0) console.log('No non-seeded approved technician found, so no jobs were aimed at your own account.');
        if (s.dryRun) console.log('Dry run only. Re-run with --confirm-seed to write.');
        else console.log(`Seeded jobs start ${SEED_TRACKING_PREFIX}. Remove with --reset --confirm-seed.`);
    })()
        .catch((error) => {
            console.error('Seed failed:', error.message);
            process.exitCode = 1;
        })
        .finally(() => client.close());
}

module.exports = { SEED_MARKER, SEED_TRACKING_PREFIX, buildOpenJobs, runJobSeed, runJobReset };
