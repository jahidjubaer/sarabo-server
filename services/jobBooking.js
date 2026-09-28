const { logTracking } = require('../middleware/logging');
const { buildPendingAssignmentEntry } = require('../utils/assignmentDecision');
const { ACTIVE_STATUSES } = require('../utils/repairRequestStatus');

// Books the technician whose job-portal application the customer chose
// (job-portal phases B/C): the request moves to driver_assigned with the
// technician, the technician is marked busy, the chosen application is
// accepted and the other pending ones are closed. Used both when the fee is
// zero (straight from the customer's choice) and when the inspection fee
// payment is confirmed (inside the payment transaction).
//
// Must run inside a MongoDB transaction `session`. Returns 'OK',
// 'TECHNICIAN_BUSY' or 'JOB_NOT_OPEN'; throws (aborting the transaction) if
// the technician is claimed by someone else between the checks and the write.
async function bookApplication({ collections, request, application, technician, customerEmail, now, session, extraSet = {} }) {
    const requestId = request._id.toString();
    // The customer may have rejected this offer (or the technician withdrawn
    // it) after the checkout opened: then nothing is booked and a paid fee is
    // refunded by the caller.
    const current = await collections.jobApplications.findOne({ _id: application._id }, { session, projection: { status: 1 } });
    if (!current || current.status !== 'pending') return 'JOB_NOT_OPEN';

    const busy = await collections.repairRequests.findOne(
        { technicianId: application.technicianId, deliveryStatus: { $in: ACTIVE_STATUSES }, _id: { $ne: request._id } },
        { session }
    );
    if (busy) return 'TECHNICIAN_BUSY';

    const requestUpdate = await collections.repairRequests.updateOne(
        { _id: request._id, deliveryStatus: 'pending-pickup', technicianId: { $exists: false } },
        {
            $set: {
                deliveryStatus: 'driver_assigned',
                technicianId: application.technicianId,
                technicianName: technician.name,
                technicianEmail: technician.email,
                acceptedApplication: {
                    applicationId: application._id.toString(),
                    estimateMin: application.estimateMin,
                    estimateMax: application.estimateMax,
                    inspectionFee: application.inspectionFee,
                    acceptedAt: now,
                },
                updatedAt: now,
                ...extraSet,
            },
            $unset: { feeCheckout: '' },
            // The technician offered and the customer accepted: recorded as an
            // accepted assignment.
            $push: {
                assignmentHistory: {
                    ...buildPendingAssignmentEntry({
                        assignmentId: application._id.toString(), technicianId: application.technicianId,
                        technicianEmail: technician.email, technicianName: technician.name,
                        assignedBy: customerEmail, assignedAt: now,
                    }),
                    decision: 'accepted',
                    decidedAt: now,
                    source: 'job_portal',
                },
            },
        },
        { session }
    );
    if (requestUpdate.matchedCount === 0) return 'JOB_NOT_OPEN';

    const technicianUpdate = await collections.technicians.updateOne(
        { _id: technician._id, status: 'approved', workStatus: 'available' },
        { $set: { workStatus: 'in_delivery' } },
        { session }
    );
    if (technicianUpdate.matchedCount === 0) {
        throw Object.assign(new Error('technician became unavailable'), { code: 'TECHNICIAN_BUSY' });
    }
    await collections.jobApplications.updateOne({ _id: application._id, status: 'pending' }, { $set: { status: 'accepted', decidedAt: now } }, { session });
    await collections.jobApplications.updateMany(
        { requestId, _id: { $ne: application._id }, status: 'pending' },
        { $set: { status: 'not_chosen', decidedAt: now } },
        { session }
    );
    await logTracking(collections.trackingEvents, request.trackingId, 'driver_assigned', session);
    return 'OK';
}

// After a booking commits: tell the chosen technician and the ones not chosen.
// Never throws.
async function notifyBooking({ collections, notifications, request, technician, customerEmail, now }) {
    const requestId = request._id.toString();
    const send = async (input) => {
        try {
            await notifications.createNotification(input);
        } catch (error) {
            console.error(`Booking notification ${input.type} failed (non-fatal):`, error.message);
        }
    };
    await send({
        recipientEmail: technician.email, recipientRole: 'rider', type: 'application_accepted',
        entityType: 'repair_request', entityId: requestId, actorEmail: customerEmail, actorRole: 'user',
        metadata: { trackingId: request.trackingId },
    });
    const others = await collections.jobApplications.find({ requestId, status: 'not_chosen', decidedAt: now }).toArray();
    for (const other of others) {
        await send({
            recipientEmail: other.technicianEmail, recipientRole: 'rider', type: 'application_not_chosen',
            entityType: 'repair_request', entityId: requestId, metadata: { trackingId: request.trackingId },
        });
    }
}

module.exports = { bookApplication, notifyBooking };
