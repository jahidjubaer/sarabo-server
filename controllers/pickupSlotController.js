const { ObjectId } = require('mongodb');
const {
    TIMEZONE, SLOT_HOLDING_STATUSES, resolveSlotCapacity, validatePickupSlotInput, buildSlotCalendar,
} = require('../utils/pickupSlots');
const { isV2RepairRequest } = require('../utils/repairRequestSchema');
const { logTrackingSafely } = require('../middleware/logging');
const { createDisabledEmailService } = require('../services/emailService');

// Region names come from a fixed list, but compare them case-insensitively
// anyway so "dhaka" and "Dhaka" can never be counted as two regions.
const REGION_COLLATION = { locale: 'en', strength: 2 };
const MAX_REGION_LENGTH = 150;

function normalize(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Pickup scheduling (pickup-scheduling phase). Slots are per service region:
// each region can hold `capacity` pickups per slot (PICKUP_SLOT_CAPACITY,
// default 3). The count is a read-then-write check, so two customers booking
// the last place in the same second can both succeed - an occasional
// one-over booking is acceptable here and an admin can reschedule it.
class PickupSlotController {
    constructor(models, collections, { now = () => new Date(), env = process.env, emailService } = {}) {
        this.collections = collections;
        this.emailService = emailService || createDisabledEmailService();
        this.now = now;
        this.capacity = resolveSlotCapacity(env);
    }

    // How many requests in `region` hold each slot from today onwards, as a
    // Map of "date|slotId" -> count. `excludeRequestId` leaves one request
    // out (a reschedule must not count its own current booking).
    async bookedCounts(region, { excludeRequestId } = {}) {
        const match = {
            'serviceLocation.region': region,
            deliveryStatus: { $in: SLOT_HOLDING_STATUSES },
            'pickupSlot.startsAt': { $gte: this.now() },
        };
        if (excludeRequestId) match._id = { $ne: excludeRequestId };
        const rows = await this.collections.repairRequests.aggregate([
            { $match: match },
            { $group: { _id: { date: '$pickupSlot.date', slotId: '$pickupSlot.slotId' }, count: { $sum: 1 } } },
        ], { collation: REGION_COLLATION }).toArray();
        return new Map(rows.map((row) => [`${row._id.date}|${row._id.slotId}`, row.count]));
    }

    // Validates a chosen slot for a region, including capacity. Used by
    // request creation and by reschedule. Returns { valid, pickupSlot } or
    // { valid: false, status, code, message }.
    async checkSlot(input, region, { excludeRequestId } = {}) {
        const result = validatePickupSlotInput(input, this.now());
        if (!result.valid) return { ...result, status: 400 };
        const counts = await this.bookedCounts(region, { excludeRequestId });
        const booked = counts.get(`${result.pickupSlot.date}|${result.pickupSlot.slotId}`) || 0;
        if (booked >= this.capacity) {
            return { valid: false, status: 409, code: 'PICKUP_SLOT_FULL', message: 'this pickup slot is fully booked - please choose another' };
        }
        return result;
    }

    // GET /pickup-slots?region=<region>
    async listAvailability(req, res) {
        try {
            const region = typeof req.query.region === 'string' ? req.query.region.trim() : '';
            if (!region || region.length > MAX_REGION_LENGTH) {
                return res.status(400).send({ message: 'region is required', code: 'INVALID_REGION' });
            }
            const bookedCounts = await this.bookedCounts(region);
            res.send({
                timezone: TIMEZONE,
                capacity: this.capacity,
                days: buildSlotCalendar(this.now(), { bookedCounts, capacity: this.capacity }),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading pickup slots', code: 'INTERNAL_ERROR' });
        }
    }

    // PATCH /repair-requests/:id/pickup-slot   body: { pickupSlot: { date, slotId } }
    // The customer who owns the request can move the pickup until the device
    // is picked up. The write is guarded on owner and status, so a pickup that
    // happens at the same moment wins.
    async reschedule(req, res) {
        try {
            if (!ObjectId.isValid(req.params.id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }
            const _id = new ObjectId(req.params.id);
            const ownerEmail = normalize(req.decoded_email);
            const request = await this.collections.repairRequests.findOne({ _id });
            // Not found and not yours look the same, so ids cannot be probed.
            if (!request || normalize(request.senderEmail) !== ownerEmail) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }
            if (!isV2RepairRequest(request)) {
                return res.status(409).send({ message: 'pickup scheduling is only available for newer repair requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            }
            if (!SLOT_HOLDING_STATUSES.includes(request.deliveryStatus)) {
                return res.status(409).send({ message: 'the pickup time can no longer be changed', code: 'PICKUP_NOT_RESCHEDULABLE' });
            }

            const region = request.serviceLocation && request.serviceLocation.region;
            const check = await this.checkSlot(req.body && req.body.pickupSlot, region, { excludeRequestId: _id });
            if (!check.valid) {
                return res.status(check.status).send({ message: check.message, code: check.code });
            }

            const changedAt = new Date();
            const result = await this.collections.repairRequests.updateOne(
                { _id, senderEmail: request.senderEmail, deliveryStatus: { $in: SLOT_HOLDING_STATUSES } },
                // A new time answers an admin's "choose a new pickup time".
                { $set: { pickupSlot: check.pickupSlot, updatedAt: changedAt }, $unset: { pickupRescheduleRequestedAt: '' } }
            );
            if (result.matchedCount === 0) {
                return res.status(409).send({ message: 'the pickup time can no longer be changed', code: 'PICKUP_NOT_RESCHEDULABLE' });
            }
            await logTrackingSafely(this.collections.trackingEvents, request.trackingId, 'pickup_rescheduled');
            await this.emailService.sendPickupChanged({ ...request, pickupSlot: check.pickupSlot }, _id.toString(), changedAt);
            res.send({ pickupSlot: check.pickupSlot });
        } catch (error) {
            res.status(500).send({ message: 'Error changing the pickup time', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = PickupSlotController;
