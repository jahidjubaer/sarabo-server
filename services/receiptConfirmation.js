const { REPAIR_COMPLETED } = require('../utils/repairRequestStatus');
const { SETTLEMENT_PENDING, SETTLEMENT_AVAILABLE } = require('../utils/settlement');

// Confirming the customer got their repaired device back (Phase 8.9). This one
// update releases the technician's settlement and starts the 30-day warranty,
// so it lives in one place for all three ways it can happen:
//
//   customer  presses "I received my device"
//   auto      the technician marked it returned 3 days ago and the customer
//             neither confirmed nor said it has not arrived (daily job)
//   admin     settles a dispute ("I have not received it")
//
// confirmedBy is always the owner's email (reviews require it); `method` says
// how it happened.
const AUTO_CONFIRM_MS = 3 * 24 * 60 * 60 * 1000;
const METHODS = Object.freeze(['customer', 'auto', 'admin']);

// Resolves to the confirmation written, or null when the request is not a
// completed, unconfirmed repair (already confirmed, or not finished).
async function confirmReceiptOnce({ collections, request, method, now = new Date(), adminEmail = null, note = null }) {
    if (!METHODS.includes(method)) throw new Error(`unknown confirmation method: ${method}`);
    const ownerEmail = String(request.senderEmail || '').trim().toLowerCase();
    const confirmation = {
        status: 'confirmed', confirmedAt: now, confirmedBy: ownerEmail,
        ...(method === 'customer' ? {} : { method, ...(adminEmail ? { confirmedByAdmin: adminEmail } : {}), ...(note ? { note } : {}) }),
    };
    // Single-winner guard: completed and not yet confirmed. An auto
    // confirmation also needs the return mark and no dispute.
    const filter = {
        _id: request._id,
        deliveryStatus: REPAIR_COMPLETED,
        $or: [
            { customerReceiptConfirmation: { $exists: false } },
            { 'customerReceiptConfirmation.status': { $ne: 'confirmed' } },
        ],
        ...(method === 'auto' ? { 'deviceReturn.markedAt': { $lte: new Date(now.getTime() - AUTO_CONFIRM_MS) }, 'deviceReturn.disputedAt': { $exists: false } } : {}),
    };
    // The settlement becomes withdrawable in exactly this update, so the money
    // is released once and a failure cannot leave it half done.
    const result = await collections.repairRequests.updateOne(filter, {
        $set: {
            deliveryStatus: 'parcel_delivered',
            customerReceiptConfirmation: confirmation,
            ...(request.technicianSettlement?.status === SETTLEMENT_PENDING
                ? { 'technicianSettlement.status': SETTLEMENT_AVAILABLE, 'technicianSettlement.availableAt': now }
                : {}),
            ...(method === 'admin' && request.deviceReturn?.disputedAt ? { 'deviceReturn.resolvedAt': now } : {}),
            updatedAt: now,
        },
    });
    return result.matchedCount === 1 ? confirmation : null;
}

module.exports = { AUTO_CONFIRM_MS, METHODS, confirmReceiptOnce };
