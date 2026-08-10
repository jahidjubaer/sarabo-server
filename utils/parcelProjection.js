// Safe projection helpers for general parcel reads (Phase 8.3 / BL-032).
//
// The raw `damage.images[]` array carries internal Storage metadata -
// storageKey, the (short-lived) url, mimeType, size, and uploadedByRole - which
// must never leave a general parcel read (GET /parcels, GET /parcels/:id, the
// technician assigned-jobs list). Damage images are read ONLY through the
// dedicated, authorized GET /parcels/:id/damage-images endpoint, which returns
// a freshly-signed, role-projected view. This helper replaces the raw array
// with a safe aggregate ({ description, imageCount }) so callers can still show
// the problem description and a count without ever receiving a storageKey.
//
// Pure: does not mutate its input.
function stripDamageImages(parcel) {
    if (!parcel || !parcel.damage || typeof parcel.damage !== 'object') {
        return parcel;
    }
    const images = Array.isArray(parcel.damage.images) ? parcel.damage.images : [];
    return {
        ...parcel,
        damage: {
            description: parcel.damage.description ?? null,
            imageCount: images.length,
        },
    };
}

// Safe projection for a GENERAL parcel LIST item (GET /parcels, GET
// /parcels/rider): strips raw damage images (BL-032) AND assignmentHistory
// (Phase 8.2 - it carries rider/admin identities + rejection reasons and is
// read only through the role-projected GET /parcels/:id/assignment). Current
// active-assignment fields (riderName/riderEmail) and the inspection/quote/
// repair existence markers the client's deletion-eligibility check relies on
// are preserved. Pure: does not mutate its input.
function projectSafeListParcel(parcel) {
    const safe = stripDamageImages(parcel);
    if (safe && typeof safe === 'object' && 'assignmentHistory' in safe) {
        // eslint-disable-next-line no-unused-vars
        const { assignmentHistory, ...rest } = safe;
        return rest;
    }
    return safe;
}

module.exports = { stripDamageImages, projectSafeListParcel };
