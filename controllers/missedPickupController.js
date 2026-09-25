const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { logTracking, logTrackingSafely } = require('../middleware/logging');
const { createNotificationService } = require('../services/notificationService');

// Admin actions on a missed pickup (missed-pickup phase). A pickup is missed
// when a technician is assigned (offered, accepted or on the way) but the
// pickup window has ended and the device was not collected - the same rule as
// GET /admin/attention.
//
// - withdraw:    take the job off the technician (who becomes free again) and
//                put the request back to "waiting for a technician", so the
//                admin can offer it to someone else.
// - askNewTime:  keep the technician; ask the customer to choose a new pickup
//                time. Until they do, the request is off the missed list; their
//                new time (PATCH /repair-requests/:id/pickup-slot) clears it.
const ASSIGNED_NOT_COLLECTED = ['assignment_pending', 'driver_assigned', 'rider_arriving'];

function normalize(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

class MissedPickupController {
    constructor(models, collections, { now = () => new Date(), mongoClient = client } = {}) {
        this.collections = collections;
        this.User = models.User;
        this.notifications = createNotificationService(models);
        this.now = now;
        this.mongoClient = mongoClient;
    }

    // The request, if it exists and its pickup is currently missed; otherwise
    // an { status, code, message } refusal.
    async loadMissed(id) {
        if (!ObjectId.isValid(id)) return { refusal: { status: 400, code: 'INVALID_REQUEST_ID', message: 'invalid repair request id' } };
        const request = await this.collections.repairRequests.findOne({ _id: new ObjectId(id) });
        if (!request) return { refusal: { status: 404, code: 'REQUEST_NOT_FOUND', message: 'repair request not found' } };
        const endsAt = request.pickupSlot && request.pickupSlot.endsAt ? new Date(request.pickupSlot.endsAt) : null;
        if (!ASSIGNED_NOT_COLLECTED.includes(request.deliveryStatus) || !request.technicianEmail || !endsAt || endsAt > this.now()) {
            return { refusal: { status: 409, code: 'PICKUP_NOT_MISSED', message: 'this request does not have a missed pickup' } };
        }
        return { request };
    }

    // POST /admin/repair-requests/:id/missed-pickup/withdraw
    async withdraw(req, res) {
        try {
            const { request, refusal } = await this.loadMissed(req.params.id);
            if (refusal) return res.status(refusal.status).send({ message: refusal.message, code: refusal.code });

            const now = this.now();
            const adminEmail = normalize(req.decoded_email);
            const session = this.mongoClient.startSession();
            let changed = false;
            try {
                await session.withTransaction(async () => {
                    // Guarded on the exact state just read: a pickup or a
                    // technician decision landing at the same moment wins.
                    const result = await this.collections.repairRequests.updateOne(
                        { _id: request._id, deliveryStatus: request.deliveryStatus, technicianEmail: request.technicianEmail },
                        {
                            $set: {
                                deliveryStatus: 'pending-pickup',
                                updatedAt: now,
                                'assignmentHistory.$[cur].decision': 'withdrawn',
                                'assignmentHistory.$[cur].withdrawnAt': now,
                                'assignmentHistory.$[cur].withdrawnBy': adminEmail,
                                'assignmentHistory.$[cur].withdrawalReason': 'missed_pickup',
                            },
                            $unset: { technicianId: '', technicianName: '', technicianEmail: '', pickupRescheduleRequestedAt: '' },
                        },
                        {
                            arrayFilters: [{ 'cur.decision': { $in: ['pending', 'accepted'] }, 'cur.technicianEmail': request.technicianEmail }],
                            session,
                        }
                    );
                    if (result.matchedCount === 0) return;
                    changed = true;
                    if (request.technicianId && ObjectId.isValid(request.technicianId)) {
                        await this.collections.technicians.updateOne(
                            { _id: new ObjectId(request.technicianId), workStatus: 'in_delivery' },
                            { $set: { workStatus: 'available' } },
                            { session }
                        );
                    }
                    await logTracking(this.collections.trackingEvents, request.trackingId, 'assignment_withdrawn', session);
                    await this.notifications.createNotification({
                        session,
                        recipientEmail: request.technicianEmail,
                        recipientRole: 'rider',
                        type: 'assignment_withdrawn',
                        entityType: 'repair_request',
                        entityId: request._id.toString(),
                        actorEmail: adminEmail,
                        actorRole: 'admin',
                        metadata: { trackingId: request.trackingId, occurrence: String(now.getTime()) },
                    });
                });
            } finally {
                await session.endSession();
            }
            if (!changed) {
                return res.status(409).send({ message: 'this request changed meanwhile - reload it', code: 'REQUEST_CHANGED' });
            }
            res.send({ success: true, deliveryStatus: 'pending-pickup' });
        } catch (error) {
            res.status(500).send({ message: 'Error taking the job off the technician', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /admin/repair-requests/:id/missed-pickup/ask-new-time
    async askNewTime(req, res) {
        try {
            const { request, refusal } = await this.loadMissed(req.params.id);
            if (refusal) return res.status(refusal.status).send({ message: refusal.message, code: refusal.code });
            if (request.pickupRescheduleRequestedAt) {
                return res.status(409).send({ message: 'the customer has already been asked for a new time', code: 'NEW_TIME_ALREADY_REQUESTED' });
            }
            const ownerRole = await this.User.findRoleByEmail(request.senderEmail);
            if (!ownerRole) {
                return res.status(409).send({ message: 'the customer account could not be found', code: 'OWNER_NOT_FOUND' });
            }
            const now = this.now();
            const result = await this.collections.repairRequests.updateOne(
                { _id: request._id, deliveryStatus: request.deliveryStatus, pickupRescheduleRequestedAt: { $exists: false } },
                { $set: { pickupRescheduleRequestedAt: now, updatedAt: now } }
            );
            if (result.matchedCount === 0) {
                return res.status(409).send({ message: 'this request changed meanwhile - reload it', code: 'REQUEST_CHANGED' });
            }
            await logTrackingSafely(this.collections.trackingEvents, request.trackingId, 'pickup_reschedule_requested');
            try {
                await this.notifications.createNotification({
                    recipientEmail: request.senderEmail,
                    recipientRole: ownerRole,
                    type: 'pickup_reschedule_requested',
                    entityType: 'repair_request',
                    entityId: request._id.toString(),
                    actorEmail: normalize(req.decoded_email),
                    actorRole: 'admin',
                    metadata: { trackingId: request.trackingId, occurrence: String(now.getTime()) },
                });
            } catch (error) {
                // The request is already marked; the customer also sees the
                // prompt on the request page itself.
                console.error('New-pickup-time notification failed (non-fatal):', error.message);
            }
            res.send({ success: true, pickupRescheduleRequestedAt: now });
        } catch (error) {
            res.status(500).send({ message: 'Error asking the customer for a new time', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = MissedPickupController;
module.exports.ASSIGNED_NOT_COLLECTED = ASSIGNED_NOT_COLLECTED;
