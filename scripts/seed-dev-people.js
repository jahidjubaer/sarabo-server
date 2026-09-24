// DEVELOPMENT-ONLY seed of dummy people: technicians across every region and
// device/repair type, plus customers - enough to exercise technician
// matching, the admin lists and reports locally.
//
// Usage:
//   node scripts/seed-dev-people.js                              (dry run - writes nothing)
//   node scripts/seed-dev-people.js --confirm-seed               (upsert the dummy people)
//   node scripts/seed-dev-people.js --reset --confirm-seed       (delete them all)
//   options: --technicians=120 --customers=60 --requests=300
//
// --requests=N also seeds N repair requests from the seeded customers over the
// last 90 days, at every stage: waiting, assigned, collected, quoted, in
// repair, completed (paid) and cancelled. Technicians are matched like the
// app does (same region, right device/repair/level, one active job each);
// requests nobody local can take stay waiting. Quotes, inspections and
// repair records are built with the app's own builders.
//
// Safety:
// - Refuses production twice over: isSafeToSeed (production environment or a
//   production-looking database name) AND the database must be the local dev
//   database (sarabo-db) or a test database.
// - Everything it writes has an email ending SEED_EMAIL_DOMAIN and
//   `seed: SEED_MARKER`; --reset deletes only those documents.
// - Deterministic (same names and details every run) and idempotent (upsert
//   by email), so re-running never duplicates anyone.
// - These people exist only in MongoDB. They have no Firebase account and
//   cannot sign in; they appear in admin lists, matching and reports.
const { ObjectId } = require('mongodb');
const { isSafeToSeed } = require('./seed-service-definitions');
const { PRODUCT_CATEGORY_SLUGS } = require('../utils/productCategory');
const { getAllowedRepairCategories } = require('../utils/serviceTaxonomy');
const { validateTechnicianExpertise, EXPERIENCE_BANDS, satisfiesRequiredExpertiseLevel } = require('../utils/technicianExpertise');
const { validateInspectionInput, buildInspectionDocument } = require('../utils/inspection');
const { validateQuoteSubmission, buildQuoteDocument } = require('../utils/quote');
const { buildInitialRepair } = require('../utils/repair');
const { buildPendingAssignmentEntry } = require('../utils/assignmentDecision');
const { PICKUP_SLOTS, validatePickupSlotInput, dhakaDateString } = require('../utils/pickupSlots');

const SEED_EMAIL_DOMAIN = '@seed.sarabo.local';
const SEED_MARKER = 'dev-people';
const DEFAULT_TECHNICIANS = 120;
const DEFAULT_CUSTOMERS = 60;
const MAX_PEOPLE = 1000;
const DEV_DB_NAME = 'sarabo-db';
const DEFAULT_REQUESTS = 0;
const SEED_TRACKING_PREFIX = 'SEED-R';

// Service regions and districts (same as the client's public/serviceAreas.json).
const REGIONS = {
    Dhaka: ['Dhaka', 'Faridpur', 'Gazipur', 'Gopalganj', 'Kishoreganj', 'Madaripur', 'Manikganj', 'Munshiganj', 'Narayanganj', 'Narsingdi', 'Rajbari', 'Shariatpur', 'Tangail'],
    Chattogram: ['Chattogram', "Cox's Bazar", 'Cumilla', 'Brahmanbaria', 'Chandpur', 'Feni', 'Khagrachari', 'Lakshmipur', 'Noakhali', 'Rangamati', 'Bandarban'],
    Sylhet: ['Sylhet', 'Moulvibazar', 'Habiganj', 'Sunamganj'],
    Rangpur: ['Rangpur', 'Dinajpur', 'Thakurgaon', 'Panchagarh', 'Nilphamari', 'Lalmonirhat', 'Kurigram', 'Gaibandha'],
    Khulna: ['Khulna', 'Jessore', 'Satkhira', 'Bagerhat', 'Magura', 'Narail', 'Jhenaidah', 'Chuadanga', 'Meherpur', 'Kushtia'],
    Rajshahi: ['Rajshahi', 'Natore', 'Naogaon', 'Chapainawabganj', 'Pabna', 'Sirajganj', 'Joypurhat', 'Bogura'],
    Barisal: ['Barisal', 'Bhola', 'Patuakhali', 'Pirojpur', 'Barguna', 'Jhalokati'],
    Mymensingh: ['Mymensingh', 'Netrokona', 'Jamalpur', 'Sherpur'],
};
// Roughly where the demand is: a third in Dhaka, the rest spread out.
const REGION_WEIGHTS = { Dhaka: 34, Chattogram: 18, Sylhet: 8, Rangpur: 8, Khulna: 10, Rajshahi: 9, Barisal: 6, Mymensingh: 7 };

const FIRST_NAMES = ['Rahim', 'Karim', 'Hasan', 'Tanvir', 'Arif', 'Sakib', 'Nayeem', 'Fahim', 'Imran', 'Rafi', 'Sabbir', 'Mahfuz', 'Shuvo', 'Rakib', 'Jubayer', 'Ashik', 'Mamun', 'Sohel', 'Nasrin', 'Farzana', 'Sumaiya', 'Tania', 'Rumana', 'Mitu', 'Sharmin', 'Nusrat', 'Anika', 'Tasnim', 'Lamia', 'Jannat'];
const LAST_NAMES = ['Ahmed', 'Hossain', 'Islam', 'Rahman', 'Khan', 'Chowdhury', 'Uddin', 'Sarker', 'Alam', 'Mia', 'Akter', 'Begum', 'Talukder', 'Bhuiyan', 'Sheikh', 'Mondal', 'Das', 'Roy', 'Paul', 'Kabir'];
const STREETS = ['Road', 'Lane', 'Avenue', 'Bypass', 'Main Road', 'College Road', 'Station Road', 'Bazar Road'];

// Small deterministic PRNG (mulberry32), so every run builds the same people.
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

function pickWeighted(random, weights) {
    const entries = Object.entries(weights);
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = random() * total;
    for (const [key, weight] of entries) {
        roll -= weight;
        if (roll < 0) return key;
    }
    return entries[entries.length - 1][0];
}

function pickSome(random, list, min, max) {
    const count = Math.min(list.length, min + Math.floor(random() * (max - min + 1)));
    const pool = [...list];
    const chosen = [];
    while (chosen.length < count) chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
    return chosen;
}

// Whole years inside the level's band (see utils/technicianExpertise.js).
function yearsForLevel(random, level) {
    const band = EXPERIENCE_BANDS[level];
    const top = band.maxInclusive ? Math.min(band.max, 15) : band.max - 1;
    return band.min + Math.floor(random() * (top - band.min + 1));
}

function buildExpertise(random) {
    const products = pickSome(random, PRODUCT_CATEGORY_SLUGS, 1, 3);
    return products.map((productCategorySlug) => {
        const level = pickWeighted(random, { beginner: 10, intermediate: 40, advanced: 35, expert: 15 });
        return {
            productCategorySlug,
            repairCategorySlugs: pickSome(random, getAllowedRepairCategories(productCategorySlug), 2, 4),
            level,
            experienceYears: yearsForLevel(random, level),
        };
    });
}

function daysAgo(now, days) {
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

// Pure builder: { technicians, users } for the technicians' own records and
// their users rows. Most are approved; some are still applying or rejected
// (approval is what makes a user a technician, so those keep role "user").
function buildTechnicians(count, { now = new Date() } = {}) {
    const random = createRandom(20260925);
    const technicians = [];
    const users = [];
    for (let i = 1; i <= count; i += 1) {
        const first = pick(random, FIRST_NAMES);
        const last = pick(random, LAST_NAMES);
        const email = `tech${String(i).padStart(3, '0')}${SEED_EMAIL_DOMAIN}`;
        const region = pickWeighted(random, REGION_WEIGHTS);
        const district = pick(random, REGIONS[region]);
        const status = pickWeighted(random, { approved: 85, pending: 10, rejected: 5 });
        const createdAt = daysAgo(now, 5 + Math.floor(random() * 170));
        const expertise = buildExpertise(random);
        const check = validateTechnicianExpertise(expertise);
        if (!check.valid) throw new Error(`seed built invalid expertise for ${email}: ${check.message}`);
        technicians.push({
            name: `${first} ${last}`,
            email,
            region,
            district,
            address: `${1 + Math.floor(random() * 200)} ${district} ${pick(random, STREETS)}`,
            nid: `SEED${String(1000000000 + i)}`,
            expertise,
            status,
            workStatus: 'available',
            createdAt,
            seed: SEED_MARKER,
        });
        users.push({
            email,
            displayName: `${first} ${last}`,
            photoURL: null,
            role: status === 'approved' ? 'rider' : 'user',
            createdAt,
            seed: SEED_MARKER,
        });
    }
    return { technicians, users };
}

function buildCustomers(count, { now = new Date() } = {}) {
    const random = createRandom(19700101);
    const users = [];
    for (let i = 1; i <= count; i += 1) {
        const first = pick(random, FIRST_NAMES);
        const last = pick(random, LAST_NAMES);
        users.push({
            email: `customer${String(i).padStart(3, '0')}${SEED_EMAIL_DOMAIN}`,
            displayName: `${first} ${last}`,
            photoURL: null,
            role: 'user',
            createdAt: daysAgo(now, Math.floor(random() * 180)),
            seed: SEED_MARKER,
        });
    }
    return users;
}

// ---- repair requests ----

const BRANDS = {
    smartphone: ['Samsung', 'Xiaomi', 'Realme', 'Oppo', 'Vivo', 'Apple', 'Symphony', 'Walton'],
    'laptop-computer': ['HP', 'Dell', 'Lenovo', 'Asus', 'Acer', 'Apple'],
    television: ['Walton', 'Samsung', 'LG', 'Sony', 'Singer', 'Vision'],
    refrigerator: ['Walton', 'Samsung', 'LG', 'Singer', 'Marcel', 'Vision'],
    'air-conditioner': ['Gree', 'General', 'Walton', 'Samsung', 'LG', 'Midea'],
    'washing-machine': ['Samsung', 'LG', 'Walton', 'Whirlpool', 'Singer'],
    'microwave-oven': ['Walton', 'Samsung', 'LG', 'Panasonic', 'Miyako'],
    'other-electronics': ['Walton', 'Philips', 'Panasonic', 'Vision', 'Miyako'],
};
// Stages where a technician is holding the job (one active job each).
const ACTIVE_STAGES = ['driver_assigned', 'parcel_picked_up', 'inspection_completed', 'quote_submitted', 'payment_completed', 'repair_in_progress'];
const COLLECTED_STAGES = ['parcel_picked_up', 'inspection_completed', 'quote_submitted', 'payment_completed', 'repair_in_progress', 'repair_completed', 'cancelled'];
const QUOTED_STAGES = ['quote_submitted', 'payment_completed', 'repair_in_progress', 'repair_completed', 'cancelled'];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const at = (base, hours) => new Date(base.getTime() + hours * HOUR_MS);

// Older requests have mostly finished; recent ones are spread over the pipeline.
function chooseStage(random, ageDays) {
    if (ageDays > 21) return pickWeighted(random, { repair_completed: 72, cancelled: 18, 'pending-pickup': 4, repair_in_progress: 6 });
    if (ageDays > 7) return pickWeighted(random, { repair_completed: 40, cancelled: 12, repair_in_progress: 14, payment_completed: 8, quote_submitted: 8, 'pending-pickup': 8, driver_assigned: 5, parcel_picked_up: 5 });
    return pickWeighted(random, { 'pending-pickup': 30, driver_assigned: 14, parcel_picked_up: 10, inspection_completed: 8, quote_submitted: 10, repair_in_progress: 8, repair_completed: 12, cancelled: 8 });
}

// A real slot (never a Friday) checked by the app's own rules: the first open
// one from now for a waiting request, otherwise 1-3 days after it was made.
function choosePickupSlot(random, createdAt, now, upcoming) {
    const slotId = pick(random, PICKUP_SLOTS).slotId;
    const start = upcoming ? now : new Date(createdAt.getTime() + (1 + Math.floor(random() * 3)) * DAY_MS);
    for (let offset = 0; offset < 8; offset += 1) {
        const date = dhakaDateString(new Date(start.getTime() + offset * DAY_MS));
        // Checked as if booked the day before, so past slots validate too.
        const bookedAt = upcoming ? now : new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS);
        const check = validatePickupSlotInput({ date, slotId }, bookedAt);
        if (check.valid) return check.pickupSlot;
    }
    return null;
}

function canTake(technician, request, definition) {
    if (technician.region !== request.serviceLocation.region) return false;
    const entry = technician.expertise.find((e) => e.productCategorySlug === request.product.categorySlug);
    return !!entry && entry.repairCategorySlugs.includes(request.service.repairCategorySlug)
        && satisfiesRequiredExpertiseLevel(entry.level, definition.requiredExpertiseLevel);
}

function inspectionFor(definition, random) {
    const labor = Math.round((definition.pricingRule.baseMin * (0.3 + random() * 0.2)) / 50) * 50;
    const parts = Math.round((definition.pricingRule.baseMin * (0.4 + random() * 0.8)) / 50) * 50;
    const v = validateInspectionInput({
        diagnosis: {
            summary: `Checked the device: ${definition.label.toLowerCase()} is needed to fix the reported fault.`,
            detectedIssues: [{ code: definition.repairCategorySlug, label: definition.label, severity: pick(random, ['moderate', 'major']), notes: '' }],
        },
        repairability: { decision: 'repairable_with_parts', reason: 'Fixable with a replacement part.' },
        estimate: { laborEstimate: labor, partsEstimate: parts },
        internalNotes: '',
    });
    if (!v.valid) throw new Error(`seed built an invalid inspection: ${v.message}`);
    return { normalized: v.normalized, labor, parts };
}

function quoteFor(inspection, random) {
    const v = validateQuoteSubmission({ laborAmount: inspection.labor, partsAmount: inspection.parts, additionalCharges: random() < 0.3 ? 200 : 0, notes: '' });
    if (!v.valid) throw new Error(`seed built an invalid quote: ${v.message}`);
    return v.normalized;
}

// Moves a request with its technician through the stages up to `stage`.
function progressRequest(request, { stage, tech, definition, customer, createdAt, random, index }) {
    const assignedAt = at(createdAt, 2 + random() * 20);
    Object.assign(request, { technicianId: tech._id.toString(), technicianEmail: tech.email, technicianName: tech.name });
    request.assignmentHistory = [{
        ...buildPendingAssignmentEntry({
            assignmentId: `seed-${index}`, technicianId: tech._id.toString(), technicianEmail: tech.email, technicianName: tech.name,
            assignedBy: `seed-admin${SEED_EMAIL_DOMAIN}`, assignedAt,
        }),
        decision: 'accepted',
        decidedAt: at(assignedAt, 1),
    }];
    if (!COLLECTED_STAGES.includes(stage)) return;

    const inspection = inspectionFor(definition, random);
    const inspectedAt = at(assignedAt, 30);
    if (stage !== 'parcel_picked_up') {
        request.inspection = buildInspectionDocument(inspection.normalized, { submittedByTechnicianId: tech._id.toString(), submittedByEmail: tech.email, now: inspectedAt });
    }
    if (!QUOTED_STAGES.includes(stage)) return;

    const quote = buildQuoteDocument(quoteFor(inspection, random), { submittedByTechnicianId: tech._id.toString(), now: at(inspectedAt, 2) });
    if (stage === 'quote_submitted') {
        request.quote = quote;
        return;
    }
    const decidedAt = at(inspectedAt, 12);
    // A cancelled request here is one where the customer declined the quote.
    if (stage === 'cancelled') {
        request.quote = { ...quote, status: 'rejected', decidedAt, decisionReason: 'Too expensive for me right now.' };
        return;
    }
    request.quote = { ...quote, status: 'approved', decidedAt };
    request.pricing = { ...request.pricing, quotedAmount: quote.totalAmount, quoteStatus: 'approved', customerApprovedAt: decidedAt, finalAmount: quote.totalAmount };
    request.paymentStatus = 'paid';
    request.paidAt = at(decidedAt, 2);
    if (stage === 'payment_completed') return;

    request.repair = buildInitialRepair(at(decidedAt, 24));
    if (stage === 'repair_in_progress') return;

    const completedAt = at(decidedAt, 48 + random() * 96);
    request.repair = { ...request.repair, status: 'completed', completion: { summary: `${definition.label} done and tested.`, evidenceImages: [], completedAt } };
    request.customerReceiptConfirmation = random() < 0.7
        ? { status: 'confirmed', confirmedAt: at(completedAt, 20), confirmedBy: customer.email }
        : { status: 'pending', confirmedAt: null, confirmedBy: null };
}

// Pure: builds the request documents and the ids of technicians left busy.
function buildRepairRequests(count, { customers, technicians, definitions, now = new Date() }) {
    const random = createRandom(4242);
    const busy = new Set();
    const requests = [];
    for (let i = 1; i <= count; i += 1) {
        const customer = pick(random, customers);
        const definition = pick(random, definitions);
        const region = pickWeighted(random, REGION_WEIGHTS);
        const district = pick(random, REGIONS[region]);
        // More recent requests than old ones.
        const ageDays = Math.floor(Math.pow(random(), 1.4) * 90);
        const createdAt = new Date(now.getTime() - ageDays * DAY_MS - Math.floor(random() * 12) * HOUR_MS);
        let stage = chooseStage(random, ageDays);
        const brands = BRANDS[definition.productCategorySlug] || BRANDS['other-electronics'];
        const request = {
            schemaVersion: 2,
            senderEmail: customer.email,
            trackingId: `${SEED_TRACKING_PREFIX}${String(i).padStart(4, '0')}`,
            product: { categorySlug: definition.productCategorySlug, brand: pick(random, brands), model: `M${100 + Math.floor(random() * 900)}` },
            service: { definitionId: definition._id.toString(), repairCategorySlug: definition.repairCategorySlug },
            damage: { description: `Customer reports a problem that needs ${definition.label.toLowerCase()}.`, images: [] },
            serviceLocation: { region, district, address: `${1 + Math.floor(random() * 150)} ${district} ${pick(random, STREETS)}` },
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
            createdAt,
            seed: SEED_MARKER,
        };

        // Some cancellations happen before anyone is assigned.
        const cancelledEarly = stage === 'cancelled' && random() < 0.5;
        if (stage !== 'pending-pickup' && !cancelledEarly) {
            const isActive = ACTIVE_STAGES.includes(stage);
            const candidates = technicians.filter((t) => canTake(t, request, definition) && (!isActive || !busy.has(t._id.toString())));
            if (candidates.length === 0) {
                // Nobody local can take it: it is still waiting.
                stage = 'pending-pickup';
            } else {
                const tech = pick(random, candidates);
                if (isActive) busy.add(tech._id.toString());
                progressRequest(request, { stage, tech, definition, customer, createdAt, random, index: i });
            }
        }
        request.deliveryStatus = stage;
        request.pickupSlot = choosePickupSlot(random, createdAt, now, stage === 'pending-pickup' && ageDays <= 7);

        // The latest thing that happened to it, never in the future.
        const moments = [createdAt, request.assignmentHistory && request.assignmentHistory[0].decidedAt, request.inspection && request.inspection.submittedAt,
            request.quote && (request.quote.decidedAt || request.quote.submittedAt), request.paidAt, request.repair && request.repair.startedAt,
            request.repair && request.repair.completion && request.repair.completion.completedAt,
            request.customerReceiptConfirmation && request.customerReceiptConfirmation.confirmedAt].filter(Boolean);
        const latest = Math.max(...moments.map((d) => d.getTime()));
        request.updatedAt = new Date(Math.min(now.getTime(), stage === 'cancelled' ? latest + 6 * HOUR_MS : latest));
        requests.push(request);
    }
    return { requests, busyTechnicianIds: [...busy] };
}

async function runRequestSeed({ collections, count, dryRun, now = new Date() }) {
    const [customers, technicians, definitions] = await Promise.all([
        collections.users.find({ seed: SEED_MARKER, role: 'user', email: { $regex: '^customer' } }).toArray(),
        collections.technicians.find({ seed: SEED_MARKER, status: 'approved' }).toArray(),
        collections.serviceDefinitions.find({ isActive: true }).toArray(),
    ]);
    if (customers.length === 0 || technicians.length === 0) throw new Error('seed the people first');
    if (definitions.length === 0) throw new Error('no active service definitions - run npm run seed:service-definitions first');
    const { requests, busyTechnicianIds } = buildRepairRequests(count, { customers, technicians, definitions, now });
    const byStatus = requests.reduce((acc, r) => ({ ...acc, [r.deliveryStatus]: (acc[r.deliveryStatus] || 0) + 1 }), {});
    if (dryRun) return { dryRun: true, requests: requests.length, byStatus, busyTechnicians: busyTechnicianIds.length };

    if (requests.length) {
        await collections.repairRequests.bulkWrite(requests.map((doc) => ({
            replaceOne: { filter: { trackingId: doc.trackingId, seed: SEED_MARKER }, replacement: doc, upsert: true },
        })), { ordered: false });
    }
    // A smaller re-run removes the extra seeded requests.
    await collections.repairRequests.deleteMany({ ...seededRequestFilter, trackingId: { $nin: requests.map((r) => r.trackingId) } });
    // Technicians holding an active job are busy, as after a real acceptance.
    await collections.technicians.updateMany({ seed: SEED_MARKER }, { $set: { workStatus: 'available' } });
    if (busyTechnicianIds.length) {
        await collections.technicians.updateMany(
            { seed: SEED_MARKER, _id: { $in: busyTechnicianIds.map((id) => new ObjectId(id)) } },
            { $set: { workStatus: 'in_delivery' } }
        );
    }
    return { dryRun: false, requests: requests.length, byStatus, busyTechnicians: busyTechnicianIds.length };
}

const seededRequestFilter = { seed: SEED_MARKER, trackingId: { $regex: `^${SEED_TRACKING_PREFIX}` } };

// Only ever matches seeded documents.
const seededFilter = { email: { $regex: `${SEED_EMAIL_DOMAIN.replace(/\./g, '\\.')}$` }, seed: SEED_MARKER };

async function upsertAll(collection, docs) {
    if (docs.length === 0) return 0;
    const result = await collection.bulkWrite(docs.map((doc) => ({
        // createdAt stays as first written, so re-running does not reshuffle history.
        updateOne: {
            filter: { email: doc.email, seed: SEED_MARKER },
            update: { $set: (({ createdAt, ...rest }) => rest)(doc), $setOnInsert: { createdAt: doc.createdAt } },
            upsert: true,
        },
    })), { ordered: false });
    return result.upsertedCount + result.modifiedCount;
}

async function runSeed({ collections, technicianCount, customerCount, dryRun }) {
    const { technicians, users: technicianUsers } = buildTechnicians(technicianCount);
    const customers = buildCustomers(customerCount);
    const summary = {
        technicians: technicians.length,
        approved: technicians.filter((t) => t.status === 'approved').length,
        pending: technicians.filter((t) => t.status === 'pending').length,
        rejected: technicians.filter((t) => t.status === 'rejected').length,
        customers: customers.length,
        byRegion: technicians.reduce((acc, t) => ({ ...acc, [t.region]: (acc[t.region] || 0) + 1 }), {}),
        byProduct: technicians.flatMap((t) => t.expertise).reduce((acc, e) => ({ ...acc, [e.productCategorySlug]: (acc[e.productCategorySlug] || 0) + 1 }), {}),
    };
    if (dryRun) return { dryRun: true, ...summary };

    // A seeded email can never collide with a real account (its own domain),
    // but refuse anyway if one already exists without the seed marker.
    const emails = [...technicianUsers, ...customers].map((u) => u.email);
    const foreign = await collections.users.countDocuments({ email: { $in: emails }, seed: { $ne: SEED_MARKER } });
    if (foreign > 0) throw new Error(`${foreign} existing non-seed user(s) use a seed email - refusing to overwrite them`);

    await upsertAll(collections.technicians, technicians);
    await upsertAll(collections.users, [...technicianUsers, ...customers]);
    return { dryRun: false, ...summary };
}

async function runReset({ collections, dryRun }) {
    if (dryRun) {
        return {
            dryRun: true,
            technicians: await collections.technicians.countDocuments(seededFilter),
            users: await collections.users.countDocuments(seededFilter),
            requests: await collections.repairRequests.countDocuments(seededRequestFilter),
        };
    }
    const [t, u, r] = await Promise.all([
        collections.technicians.deleteMany(seededFilter),
        collections.users.deleteMany(seededFilter),
        collections.repairRequests.deleteMany(seededRequestFilter),
    ]);
    return { dryRun: false, technicians: t.deletedCount, users: u.deletedCount, requests: r.deletedCount };
}

// The database must be the local dev database or a test database.
function isDevOrTestDatabase(name) {
    return name === DEV_DB_NAME || /test/i.test(name);
}

function readCount(args, flag, fallback) {
    const arg = args.find((a) => a.startsWith(`--${flag}=`));
    if (!arg) return fallback;
    const value = Number(arg.split('=')[1]);
    if (!Number.isInteger(value) || value < 0 || value > MAX_PEOPLE) throw new Error(`--${flag} must be a whole number from 0 to ${MAX_PEOPLE}`);
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
        console.error(`Refusing to run: "${resolvedDbName}" is not the local dev database (${DEV_DB_NAME}) or a test database.`);
        process.exit(1);
    }

    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run') || !args.includes('--confirm-seed');
    const reset = args.includes('--reset');
    let technicianCount;
    let customerCount;
    let requestCount;
    try {
        technicianCount = readCount(args, 'technicians', DEFAULT_TECHNICIANS);
        customerCount = readCount(args, 'customers', DEFAULT_CUSTOMERS);
        requestCount = readCount(args, 'requests', DEFAULT_REQUESTS);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }

    const { connectDatabase, collections, client } = require('../config/database');
    (async () => {
        console.log(`Dev people seed - database "${resolvedDbName}", ${dryRun ? 'DRY RUN (nothing written)' : 'WRITE'}${reset ? ', reset' : ''}`);
        await connectDatabase();
        if (reset) {
            const r = await runReset({ collections, dryRun });
            console.log(`${r.dryRun ? 'Would delete' : 'Deleted'} ${r.technicians} seeded technicians, ${r.users} seeded users and ${r.requests} seeded repair requests.`);
            if (r.dryRun) console.log('Re-run with --confirm-seed to delete.');
            return;
        }
        const s = await runSeed({ collections, technicianCount, customerCount, dryRun });
        console.log(`${s.dryRun ? 'Would upsert' : 'Upserted'} ${s.technicians} technicians (${s.approved} approved, ${s.pending} applying, ${s.rejected} rejected) and ${s.customers} customers.`);
        console.log('Technicians by region:', Object.entries(s.byRegion).map(([k, v]) => `${k} ${v}`).join(', '));
        console.log('Expertise by device:', Object.entries(s.byProduct).map(([k, v]) => `${k} ${v}`).join(', '));
        if (requestCount > 0) {
            if (s.dryRun) {
                console.log(`Would seed ${requestCount} repair requests (previewed after the people exist).`);
            } else {
                const q = await runRequestSeed({ collections, count: requestCount, dryRun: false });
                console.log(`Upserted ${q.requests} repair requests:`, Object.entries(q.byStatus).map(([k, v]) => `${k} ${v}`).join(', '));
                console.log(`${q.busyTechnicians} seeded technicians are busy on an active job.`);
            }
        }
        if (s.dryRun) console.log('Dry run only. Re-run with --confirm-seed to write.');
        else console.log(`Seeded emails end with ${SEED_EMAIL_DOMAIN} and requests start ${SEED_TRACKING_PREFIX}; seeded people cannot sign in. Remove with --reset --confirm-seed.`);
    })()
        .catch((error) => {
            console.error('Seed failed:', error.message);
            process.exitCode = 1;
        })
        .finally(() => client.close());
}

module.exports = {
    SEED_EMAIL_DOMAIN, SEED_MARKER, REGIONS,
    SEED_TRACKING_PREFIX,
    buildTechnicians, buildCustomers, buildRepairRequests, runSeed, runRequestSeed, runReset, isDevOrTestDatabase,
};
