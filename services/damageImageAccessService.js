// Authorized damage-image access classification (Phase 6.4 Unit 2). Pure
// decision logic plus the minimal live database reads it genuinely needs
// (caller's linked role, caller's rider record) - never calls Firebase
// Storage, never mutates any document. Reused by exactly one endpoint today
// (GET /parcels/:id/damage-images) so access rules never get re-derived in
// a second controller branch.
//
// Never trusts a client-supplied role, rider id, or email - every identity
// fact used here is either the token-verified caller email or a value read
// fresh from the current parcel/user/rider documents.

const { normalize } = require('./paymentProcessor');
const { ACTIVE_STATUSES } = require('../utils/parcelStatus');

// Conservative technician policy (Phase D): access holds only while the
// assignment is still "in flight" - driver_assigned, rider_arriving,
// parcel_picked_up. Deliberately excludes parcel_delivered (ACTIVE_STATUSES
// already excludes it) - post-completion technician access to customer
// evidence is deferred, not granted by default, until a concrete
// warranty/support need proves it's required. The owner and any admin
// retain access at every lifecycle stage regardless (checked separately,
// above the technician branch).
async function resolveImageAccess({ parcel, callerEmail, models, session } = {}) {
    const callerNormalized = normalize(callerEmail);
    const ownerEmail = normalize(parcel.senderEmail);
    if (ownerEmail && ownerEmail === callerNormalized) {
        return { allowed: true, accessRole: 'owner', code: null };
    }

    const findOptions = session ? { session } : {};
    const callerRole = await models.User.findRoleByEmail(callerEmail, findOptions);

    if (callerRole === 'admin') {
        return { allowed: true, accessRole: 'admin', code: null };
    }

    // Only worth a rider lookup at all when the caller's own linked account
    // is currently role "rider" and the request actually has a live,
    // in-flight assignment - avoids a wasted query for every other caller.
    if (callerRole === 'rider' && parcel.technicianId && ACTIVE_STATUSES.includes(parcel.deliveryStatus)) {
        const rider = await models.Technician.findByEmail(callerEmail, findOptions);
        if (rider && rider._id.toString() === parcel.technicianId) {
            return { allowed: true, accessRole: 'assigned-technician', code: null };
        }
    }

    return { allowed: false, accessRole: null, code: 'ACCESS_DENIED' };
}

module.exports = { resolveImageAccess };
