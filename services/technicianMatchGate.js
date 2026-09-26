const crypto = require('crypto');
const { canTechnicianEverTakeRequest } = require('./technicianEligibilityService');
const { dhakaDateString } = require('../utils/pickupSlots');

// Request-creation gate (job-portal phase A): a customer can only create a
// request that at least one approved technician in its region could take
// (right device, repair and level) - the same rule the admin attention list
// and reports use. Being busy right now does not count against a technician;
// they will be free again.
//
// Refused attempts are recorded as "turned away" demand, so the reports can
// show where technicians are missing. One record per customer, service,
// region and day: retrying the form does not inflate the count. The customer
// is stored only as a one-way hash, never as an email.
const TURNED_AWAY_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

// Local development and the test runners can switch the gate off (many
// fixtures create requests in regions with no technicians). Never honoured
// on Vercel or with NODE_ENV=production.
function isMatchGateSkipped(env = process.env) {
    return env.SKIP_TECHNICIAN_MATCH_CHECK === 'true' && !env.VERCEL && env.NODE_ENV !== 'production';
}

// true when some approved technician in `region` can take this service.
async function hasTechnicianFor(collections, { region, definition }) {
    const needs = {
        region,
        productCategorySlug: definition.productCategorySlug,
        repairCategorySlug: definition.repairCategorySlug,
        requiredExpertiseLevel: definition.requiredExpertiseLevel,
    };
    // Narrowed in the database by device; region and level are compared
    // exactly as assignment compares them.
    const candidates = await collections.technicians.find(
        { status: 'approved', 'expertise.productCategorySlug': definition.productCategorySlug },
        { projection: { status: 1, region: 1, expertise: 1 } }
    ).toArray();
    return candidates.some((technician) => canTechnicianEverTakeRequest(technician, needs));
}

function hashCustomer(email) {
    return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
}

// Never throws: failing to record demand must not change the customer's answer.
async function recordTurnedAway(collections, { customerEmail, region, district, definition, now = new Date() }) {
    const day = dhakaDateString(now);
    const customerHash = hashCustomer(customerEmail);
    const key = `${customerHash}|${day}|${definition._id.toString()}|${String(region).trim().toLowerCase()}`;
    try {
        await collections.turnedAwayRequests.updateOne(
            { _id: key },
            {
                $setOnInsert: {
                    day,
                    region: String(region).trim(),
                    district: typeof district === 'string' ? district.trim() : null,
                    productCategorySlug: definition.productCategorySlug,
                    repairCategorySlug: definition.repairCategorySlug,
                    definitionId: definition._id.toString(),
                    customerHash,
                    createdAt: now,
                    expiresAt: new Date(now.getTime() + TURNED_AWAY_RETENTION_MS),
                },
            },
            { upsert: true }
        );
    } catch (error) {
        console.error('Recording turned-away demand failed (non-fatal):', error.message);
    }
}

module.exports = { isMatchGateSkipped, hasTechnicianFor, recordTurnedAway, hashCustomer };
