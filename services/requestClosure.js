const { ObjectId } = require('mongodb');
const { logTracking } = require('../middleware/logging');
const { ACTIVE_STATUSES, QUOTE_APPROVED, INSPECTION_COMPLETED } = require('../utils/repairRequestStatus');
const { inspectionCredit, buildInspectionFeeSettlement } = require('../utils/inspectionFee');
const { createCheckoutSessionManager } = require('./checkoutSessionManager');

// Closing an unpaid request after the device was collected, so it can never
// sit forever with the technician held "busy" (workflow review, 2026-10-14):
//
//   payment_not_made           approved quote not paid within 3 days (daily job)
//   customer_cancelled_unpaid  the customer backs out after approving, before paying
//   not_repairable             the inspection found it not repairable / not economical
//
// Same outcome as a declined quote (services/declinedQuoteClose.js): the
// request is cancelled, a paid inspection fee is kept 90/10 (the technician
// collected and inspected the device), the technician is released, and both
// sides are told. The technician returns the device.
const UNPAID_APPROVED_CLOSE_MS = 3 * 24 * 60 * 60 * 1000;
const NOT_REPAIRABLE_DECISIONS = Object.freeze(['not_repairable', 'not_economical']);
const REASONS = Object.freeze({
    payment_not_made: QUOTE_APPROVED,
    customer_cancelled_unpaid: QUOTE_APPROVED,
    not_repairable: INSPECTION_COMPLETED,
});

function isNotRepairable(request) {
    return NOT_REPAIRABLE_DECISIONS.includes(request?.inspection?.repairability?.decision);
}

// Resolves to { closed, feeKept, code? }. code PAYMENT_IN_PROGRESS when the
// customer has a checkout open right now (closing would risk a payment for a
// cancelled request); closed false otherwise means someone else acted first.
async function closeUnpaidRequest({
    collections, notifications, User, mongoClient, request, reason, closedBy, actorEmail = null, now = new Date(), expireCheckout = null,
}) {
    const fromStatus = REASONS[reason];
    if (!fromStatus) throw new Error(`unknown closure reason: ${reason}`);
    const checkouts = createCheckoutSessionManager(collections);
    const requestId = request._id.toString();
    if (fromStatus === QUOTE_APPROVED && await checkouts.findActive(requestId)) return { closed: false, feeKept: false, code: 'PAYMENT_IN_PROGRESS' };

    const feeKept = inspectionCredit(request) > 0;
    const session = mongoClient.startSession();
    let closed = false;
    try {
        await session.withTransaction(async () => {
            closed = false;
            const result = await collections.repairRequests.updateOne(
                { _id: request._id, schemaVersion: 2, deliveryStatus: fromStatus, paymentStatus: { $ne: 'paid' }, 'payment.status': { $ne: 'completed' } },
                {
                    $set: {
                        deliveryStatus: 'cancelled',
                        cancelledAt: now,
                        cancelledBy: closedBy === 'auto' ? 'system' : actorEmail,
                        cancellationReason: reason,
                        closedBy,
                        updatedAt: now,
                        ...(feeKept ? {
                            'inspectionPayment.status': 'kept',
                            'inspectionPayment.keptReason': reason,
                            inspectionFeeSettlement: buildInspectionFeeSettlement(request, { reason, now }),
                        } : {}),
                    },
                },
                { session }
            );
            if (result.matchedCount === 0) return;
            closed = true;

            // Release the technician unless they hold other active work.
            if (request.technicianId && ObjectId.isValid(request.technicianId)) {
                const technicianObjectId = new ObjectId(request.technicianId);
                const technician = await collections.technicians.findOne({ _id: technicianObjectId }, { session });
                if (technician) {
                    const otherActive = await collections.repairRequests.findOne(
                        { technicianId: request.technicianId, deliveryStatus: { $in: ACTIVE_STATUSES }, _id: { $ne: request._id } },
                        { session, projection: { _id: 1 } }
                    );
                    await collections.technicians.updateOne(
                        { _id: technicianObjectId },
                        { $set: { workStatus: otherActive ? technician.workStatus : 'available' } },
                        { session }
                    );
                }
            }
            await logTracking(collections.trackingEvents, request.trackingId, 'cancelled', session);
        });
    } finally {
        await session.endSession();
    }
    if (!closed) return { closed: false, feeKept: false };

    // An unused checkout must never be paid for a cancelled request.
    try {
        const row = await checkouts.cancelByRequestId(requestId);
        if (row && row.sessionId && expireCheckout) await expireCheckout(row.sessionId);
    } catch (error) {
        console.error('Expiring a checkout after closing failed (non-fatal):', error.message);
    }

    const metadata = { trackingId: request.trackingId, occurrence: 'closed', step: reason };
    try {
        if (closedBy !== 'customer') {
            const ownerRole = (await User.findRoleByEmail(request.senderEmail)) || 'user';
            if (reason !== 'customer_cancelled_unpaid') {
                await notifications.createNotification({
                    recipientEmail: request.senderEmail, recipientRole: ownerRole, type: 'repair_update',
                    entityType: 'repair_request', entityId: requestId, metadata,
                });
            }
        }
        if (closedBy !== 'technician' && request.technicianEmail) {
            await notifications.createNotification({
                recipientEmail: request.technicianEmail, recipientRole: 'rider', type: 'repair_update_technician',
                entityType: 'repair_request', entityId: requestId, metadata,
            });
        }
    } catch (error) {
        console.error('Closure notification failed (non-fatal):', error.message);
    }
    return { closed: true, feeKept };
}

// The daily job: approved quotes left unpaid for 3 days are closed. A request
// with a checkout open right now is skipped (tried again tomorrow).
async function closeUnpaidApprovedQuotes({ collections, notifications, User, mongoClient, now = new Date(), expireCheckout = null, limit = 200 }) {
    const cutoff = new Date(now.getTime() - UNPAID_APPROVED_CLOSE_MS);
    const stale = await collections.repairRequests.find({
        schemaVersion: 2, deliveryStatus: QUOTE_APPROVED, paymentStatus: { $ne: 'paid' }, 'payment.status': { $ne: 'completed' }, 'quote.decidedAt': { $lte: cutoff },
    }).sort({ 'quote.decidedAt': 1 }).limit(limit).toArray();
    const counts = { found: stale.length, closed: 0, skipped: 0, failed: 0 };
    for (const request of stale) {
        try {
            const result = await closeUnpaidRequest({
                collections, notifications, User, mongoClient, request, reason: 'payment_not_made', closedBy: 'auto', now, expireCheckout,
            });
            if (result.closed) counts.closed += 1;
            else counts.skipped += 1;
        } catch (error) {
            counts.failed += 1;
            console.error('Closing an unpaid approved quote failed (will retry tomorrow):', error.message);
        }
    }
    return counts;
}

module.exports = { UNPAID_APPROVED_CLOSE_MS, NOT_REPAIRABLE_DECISIONS, isNotRepairable, closeUnpaidRequest, closeUnpaidApprovedQuotes };
