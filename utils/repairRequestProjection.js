// Safe projection helpers for general repair request reads (Phase 8.3 / BL-032).
//
// The raw `damage.images[]` array carries internal Storage metadata -
// storageKey, the (short-lived) url, mimeType, size, and uploadedByRole - which
// must never leave a general repair request read (GET /repair-requests, GET /repair-requests/:id, the
// technician assigned-jobs list). Damage images are read ONLY through the
// dedicated, authorized GET /repair-requests/:id/damage-images endpoint, which returns
// a freshly-signed, role-projected view. This helper replaces the raw array
// with a safe aggregate ({ description, imageCount }) so callers can still show
// the problem description and a count without ever receiving a storageKey.
//
// Pure: does not mutate its input.
function stripDamageImages(repairRequest) {
    if (!repairRequest || !repairRequest.damage || typeof repairRequest.damage !== 'object') {
        return repairRequest;
    }
    const images = Array.isArray(repairRequest.damage.images) ? repairRequest.damage.images : [];
    return {
        ...repairRequest,
        damage: {
            description: repairRequest.damage.description ?? null,
            imageCount: images.length,
        },
    };
}

// The only quote fields a general list is allowed to carry: the customer's
// request list (getAgreedPrice in customerRequestPresentation.js) renders the
// AGREED price of an approved quote from exactly these three fields. Everything
// else on the stored quote - the labor/parts/additional breakdown, free-text
// notes, the submitting technician's id, the customer's decision reason, and
// submission timestamps - is internal and never belongs on a general list. The
// full quote is read only through the dedicated, role-projected
// GET /repair-requests/:id/quote. Pure: builds a fresh object.
function summarizeQuoteForList(quote) {
    return {
        status: quote.status ?? null,
        totalAmount: quote.totalAmount ?? null,
        currency: quote.currency ?? null,
    };
}

// Safe projection for a GENERAL repair request LIST item (GET /repair-requests, GET
// /repair-requests/technician). Beyond the BL-032 damage-image strip and the Phase 8.2
// assignmentHistory strip, this removes the detail sub-documents that carried
// technician-only and provider-internal data onto general lists (Phase 8.4
// MEDIUM debt / Phase 8.5):
//
//   - inspection: internalNotes (explicitly customer-private), the submitting
//     technician's email/id, the diagnosis, and the estimate. Read only through
//     the role-projected GET /repair-requests/:id/inspection.
//   - repair:     completion evidence storage metadata (imageId/mimeType/size),
//     progress-update ids, and technician identifiers. Read only through
//     GET /repair-requests/:id/repair.
//   - quote:      the full pricing breakdown, notes, submitter identity, and
//     decision reason - reduced to the agreed-price summary above.
//   - payment:    the Stripe paymentIntentId and provider name. The top-level
//     `paymentStatus` (the only field any list renders) is preserved.
//
// The three sub-documents are replaced with boolean existence markers
// (hasInspection / hasQuote / hasRepair) so the client's deletion-eligibility
// heuristic keeps the same information it always relied on without receiving any
// sub-document body. Active-assignment fields (technicianName/technicianEmail) and every
// top-level status/cost field are untouched. Pure: does not mutate its input.
function projectSafeListRepairRequest(repairRequest) {
    const safe = stripDamageImages(repairRequest);
    if (!safe || typeof safe !== 'object') {
        return safe;
    }
    // technicianEarning (Phase 8.11) is internal accounting - it carries the
    // settling admin's email (paidBy) and is never customer-facing. It is
    // stripped from every GENERAL list here; the technician Completed Repairs
    // view re-attaches a sanitized, paidBy-free earning in the controller, and
    // admin settlement reads the full earning through GET /repair-requests/:id.
    // eslint-disable-next-line no-unused-vars
    const { assignmentHistory, inspection, repair, quote, payment, technicianEarning, ...rest } = safe;
    const projected = {
        ...rest,
        hasInspection: Boolean(inspection),
        hasQuote: Boolean(quote),
        hasRepair: Boolean(repair),
    };
    if (quote && typeof quote === 'object') {
        projected.quote = summarizeQuoteForList(quote);
    }
    return projected;
}

module.exports = { stripDamageImages, projectSafeListRepairRequest, summarizeQuoteForList };
