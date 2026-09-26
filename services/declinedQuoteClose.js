const { ObjectId } = require('mongodb');
const { logTracking } = require('../middleware/logging');
const { QUOTE_REJECTED, ACTIVE_STATUSES } = require('../utils/repairRequestStatus');
const { inspectionCredit, buildInspectionFeeSettlement } = require('../utils/inspectionFee');

// Ending a request whose final price the customer declined (Phase 9.2, and
// the declined-quote follow-through). Three ways, one outcome:
//
//   technician  closes the job instead of revising the quote
//   customer    says they don't want the repair
//   auto        nobody acted for DECLINED_AUTO_CLOSE_MS after the decline -
//               the daily job closes it (controllers/pickupReminderController.js)
//
// The request becomes 'cancelled' (reason quote_declined) and a paid
// inspection fee is kept: 90% to the technician's wallet, 10% to Sarabo
// (job-portal phase D). Revising the quote moves the request out of
// quote_rejected, so a revision in progress is never closed.
const DECLINED_AUTO_CLOSE_MS = 3 * 24 * 60 * 60 * 1000;
const CLOSED_BY = Object.freeze(['technician', 'customer', 'auto']);

// Closes `request` in one transaction. Resolves to { closed, feeKept }; closed
// is false when the request is no longer a declined, unpaid quote (someone
// else acted first).
async function closeDeclinedRequest({ collections, notifications, User, mongoClient, request, closedBy, actorEmail = null, now = new Date() }) {
    if (!CLOSED_BY.includes(closedBy)) throw new Error(`unknown closedBy: ${closedBy}`);
    const feeKept = inspectionCredit(request) > 0;
    const requestId = request._id.toString();
    // The owner's real role, for owner-facing notifications (a request owner
    // is not always a 'user').
    const ownerRole = closedBy === 'auto' ? await User.findRoleByEmail(request.senderEmail) : null;
    const session = mongoClient.startSession();
    let closed = false;
    try {
        await session.withTransaction(async () => {
            closed = false;
            const result = await collections.repairRequests.updateOne(
                { _id: request._id, schemaVersion: 2, deliveryStatus: QUOTE_REJECTED, paymentStatus: { $ne: 'paid' } },
                {
                    $set: {
                        deliveryStatus: 'cancelled',
                        cancelledAt: now,
                        cancelledBy: closedBy === 'auto' ? 'system' : actorEmail,
                        cancellationReason: 'quote_declined',
                        closedBy,
                        updatedAt: now,
                        ...(feeKept ? {
                            'inspectionPayment.status': 'kept',
                            'inspectionPayment.keptReason': 'quote_declined',
                            inspectionFeeSettlement: buildInspectionFeeSettlement(request, { reason: 'quote_declined', now }),
                        } : {}),
                    },
                },
                { session }
            );
            if (result.matchedCount === 0) return;
            closed = true;

            // quote_rejected already released the technician, but one who
            // was given other work in between must not be flipped available.
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

            if (closedBy === 'technician') {
                await notifications.createNotification({
                    session, recipientEmail: request.senderEmail, recipientRole: 'user', type: 'repair_cancelled_by_technician',
                    entityType: 'repair_request', entityId: requestId, metadata: { trackingId: request.trackingId }, actorEmail,
                });
            } else if (request.technicianEmail) {
                await notifications.createNotification({
                    session, recipientEmail: request.technicianEmail, recipientRole: 'rider', type: 'declined_request_closed',
                    entityType: 'repair_request', entityId: requestId,
                    metadata: { trackingId: request.trackingId, closedBy, feeOutcome: feeKept ? 'kept' : 'none' },
                    ...(actorEmail ? { actorEmail } : {}),
                });
            }
            if (closedBy === 'auto' && ownerRole) {
                await notifications.createNotification({
                    session, recipientEmail: request.senderEmail, recipientRole: ownerRole, type: 'declined_request_auto_closed',
                    entityType: 'repair_request', entityId: requestId, metadata: { trackingId: request.trackingId },
                });
            }
        });
    } finally {
        await session.endSession();
    }
    return { closed, feeKept };
}

// The daily job: closes every declined quote nobody acted on in time. One
// failure never stops the others. Resolves to { found, closed, failed }.
async function closeStaleDeclinedRequests({ collections, notifications, User, mongoClient, now = new Date(), limit = 200 }) {
    const cutoff = new Date(now.getTime() - DECLINED_AUTO_CLOSE_MS);
    const stale = await collections.repairRequests.find(
        { schemaVersion: 2, deliveryStatus: QUOTE_REJECTED, paymentStatus: { $ne: 'paid' }, 'quote.decidedAt': { $lte: cutoff } }
    ).sort({ 'quote.decidedAt': 1 }).limit(limit).toArray();
    const counts = { found: stale.length, closed: 0, failed: 0 };
    for (const request of stale) {
        try {
            const { closed } = await closeDeclinedRequest({ collections, notifications, User, mongoClient, request, closedBy: 'auto', now });
            if (closed) counts.closed += 1;
        } catch (error) {
            counts.failed += 1;
            console.error('Closing a declined request failed (will retry tomorrow):', error.message);
        }
    }
    return counts;
}

module.exports = { DECLINED_AUTO_CLOSE_MS, CLOSED_BY, closeDeclinedRequest, closeStaleDeclinedRequests };
