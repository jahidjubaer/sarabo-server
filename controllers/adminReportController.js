const { ACTIVE_STATUSES, REPAIR_COMPLETED } = require('../utils/repairRequestStatus');
const { canTechnicianEverTakeRequest } = require('../services/technicianEligibilityService');
const { PICKUP_SLOTS, TIMEZONE, dhakaDateString } = require('../utils/pickupSlots');

// Admin reports (reports phase): one read-only summary for the Reports page.
//
// Definitions (shown on the page too):
// - created    requests made in the period
// - completed  repairs finished in the period (repair.completion.completedAt).
//              Older requests finished before completion times were recorded
//              ('parcel_delivered') have no finish time and are left out.
// - cancelled  requests cancelled in the period (their last update)
// - success rate  completed / (completed + cancelled) in the period
// - avg days   request made -> repair finished, for repairs finished in the period
// - turned away  requests a customer could not submit because no technician
//              in the region offers that repair (one per customer, service,
//              region and day - services/technicianMatchGate.js)
// Days are Bangladesh days (Asia/Dhaka).
const ALLOWED_DAYS = [7, 30, 90];
const DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_LIMIT = 8;
const TOP_TECHNICIANS = 10;
// Waiting requests are few (they are work not yet started), but cap the
// in-memory matching anyway.
const MAX_WAITING_FOR_MATCHING = 2000;
const WAITING_STATUS = 'pending-pickup';

function round1(value) {
    return Math.round(value * 10) / 10;
}

class AdminReportController {
    constructor(models, collections, { now = () => new Date() } = {}) {
        this.collections = collections;
        this.now = now;
    }

    // created / completed / cancelled / avg days for [from, to).
    async periodTotals(from, to) {
        const rr = this.collections.repairRequests;
        const [created, cancelled, completion, turnedAway] = await Promise.all([
            rr.countDocuments({ createdAt: { $gte: from, $lt: to } }),
            rr.countDocuments({ deliveryStatus: 'cancelled', updatedAt: { $gte: from, $lt: to } }),
            rr.aggregate([
                { $match: { 'repair.completion.completedAt': { $gte: from, $lt: to } } },
                { $group: { _id: null, count: { $sum: 1 }, totalMs: { $sum: { $subtract: ['$repair.completion.completedAt', '$createdAt'] } } } },
            ]).toArray(),
            this.collections.turnedAwayRequests.countDocuments({ createdAt: { $gte: from, $lt: to } }),
        ]);
        const completed = completion[0] ? completion[0].count : 0;
        const finished = completed + cancelled;
        return {
            created,
            completed,
            cancelled,
            successRate: finished > 0 ? round1((completed / finished) * 100) : null,
            avgDaysToComplete: completed > 0 ? round1(completion[0].totalMs / completed / DAY_MS) : null,
            turnedAway,
        };
    }

    // Requests made and repairs finished per Bangladesh day.
    async daily(from, to) {
        const rr = this.collections.repairRequests;
        const byDay = (field) => [
            { $match: { [field]: { $gte: from, $lt: to } } },
            { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: TIMEZONE } }, count: { $sum: 1 } } },
        ];
        const [created, completed] = await Promise.all([
            rr.aggregate(byDay('createdAt')).toArray(),
            rr.aggregate(byDay('repair.completion.completedAt')).toArray(),
        ]);
        const createdMap = new Map(created.map((r) => [r._id, r.count]));
        const completedMap = new Map(completed.map((r) => [r._id, r.count]));
        const days = [];
        // Every Bangladesh day from the start of the period up to and including today.
        for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
            const date = dhakaDateString(new Date(t));
            if (days.length && days[days.length - 1].date === date) continue;
            days.push({ date, created: createdMap.get(date) || 0, completed: completedMap.get(date) || 0 });
        }
        return days;
    }

    // Demand vs supply per region. `unmatchedWaiting` counts waiting requests
    // that no approved technician in that region can take (right device,
    // repair and level) - the same rule assignment enforces.
    async regions(from, to, technicians) {
        const rr = this.collections.repairRequests;
        const [requestRows, waiting, definitions, turnedAwayRows] = await Promise.all([
            rr.aggregate([
                { $match: { createdAt: { $gte: from, $lt: to }, 'serviceLocation.region': { $type: 'string' } } },
                { $group: { _id: '$serviceLocation.region', requests: { $sum: 1 } } },
            ]).toArray(),
            rr.find(
                { deliveryStatus: WAITING_STATUS, schemaVersion: 2 },
                { projection: { serviceLocation: 1, product: 1, service: 1 } }
            ).limit(MAX_WAITING_FOR_MATCHING).toArray(),
            this.collections.serviceDefinitions.find({}, { projection: { requiredExpertiseLevel: 1 } }).toArray(),
            this.collections.turnedAwayRequests.aggregate([
                { $match: { createdAt: { $gte: from, $lt: to } } },
                { $group: { _id: '$region', count: { $sum: 1 } } },
            ]).toArray(),
        ]);
        const levelByDefinition = new Map(definitions.map((d) => [d._id.toString(), d.requiredExpertiseLevel]));
        const regions = new Map();
        const entry = (name) => {
            if (!regions.has(name)) regions.set(name, { region: name, requests: 0, waiting: 0, unmatchedWaiting: 0, turnedAway: 0, approvedTechnicians: 0, availableTechnicians: 0 });
            return regions.get(name);
        };
        for (const row of requestRows) entry(row._id).requests = row.requests;
        for (const row of turnedAwayRows) if (row._id) entry(row._id).turnedAway = row.count;
        const approved = technicians.filter((t) => t.status === 'approved');
        for (const t of approved) {
            if (typeof t.region !== 'string' || !t.region) continue;
            const r = entry(t.region);
            r.approvedTechnicians += 1;
            if (t.workStatus === 'available') r.availableTechnicians += 1;
        }
        for (const request of waiting) {
            const region = request.serviceLocation && request.serviceLocation.region;
            if (!region) continue;
            const r = entry(region);
            r.waiting += 1;
            const needs = {
                region,
                productCategorySlug: request.product && request.product.categorySlug,
                repairCategorySlug: request.service && request.service.repairCategorySlug,
                requiredExpertiseLevel: levelByDefinition.get(request.service && request.service.definitionId),
            };
            if (!approved.some((t) => canTechnicianEverTakeRequest(t, needs))) r.unmatchedWaiting += 1;
        }
        return [...regions.values()].sort((a, b) => b.requests - a.requests || b.waiting - a.waiting || a.region.localeCompare(b.region));
    }

    async breakdowns(from, to) {
        const rr = this.collections.repairRequests;
        const top = (field) => rr.aggregate([
            { $match: { createdAt: { $gte: from, $lt: to }, [field]: { $type: 'string' } } },
            { $group: { _id: `$${field}`, requests: { $sum: 1 } } },
            { $sort: { requests: -1, _id: 1 } },
            { $limit: TOP_LIMIT },
        ]).toArray();
        const [devices, repairs, pickups] = await Promise.all([
            top('product.categorySlug'),
            top('service.repairCategorySlug'),
            // Pickups booked in the period, by slot date.
            rr.aggregate([
                { $match: { createdAt: { $gte: from, $lt: to }, 'pickupSlot.date': { $type: 'string' } } },
                { $group: { _id: { date: '$pickupSlot.date', slotId: '$pickupSlot.slotId' }, count: { $sum: 1 } } },
            ]).toArray(),
        ]);
        // Day-of-week x slot grid (0 = Sunday).
        const grid = new Map();
        for (const row of pickups) {
            const weekday = new Date(`${row._id.date}T00:00:00Z`).getUTCDay();
            const key = `${weekday}|${row._id.slotId}`;
            grid.set(key, (grid.get(key) || 0) + row.count);
        }
        const pickupLoad = [];
        for (let weekday = 0; weekday < 7; weekday += 1) {
            for (const slot of PICKUP_SLOTS) pickupLoad.push({ weekday, slotId: slot.slotId, count: grid.get(`${weekday}|${slot.slotId}`) || 0 });
        }
        return {
            devices: devices.map((d) => ({ productCategorySlug: d._id, requests: d.requests })),
            repairs: repairs.map((r) => ({ repairCategorySlug: r._id, requests: r.requests })),
            pickupLoad,
            slots: PICKUP_SLOTS.map(({ slotId, label }) => ({ slotId, label })),
        };
    }

    async workload(from, to, technicians) {
        const rr = this.collections.repairRequests;
        const approved = technicians.filter((t) => t.status === 'approved');
        const [activeRows, everRows, completedRows] = await Promise.all([
            rr.aggregate([
                { $match: { deliveryStatus: { $in: ACTIVE_STATUSES }, technicianId: { $type: 'string' } } },
                { $group: { _id: '$technicianId', count: { $sum: 1 } } },
            ]).toArray(),
            rr.aggregate([
                { $match: { technicianId: { $type: 'string' } } },
                { $group: { _id: '$technicianId' } },
            ]).toArray(),
            rr.aggregate([
                { $match: { deliveryStatus: REPAIR_COMPLETED, 'repair.completion.completedAt': { $gte: from, $lt: to }, technicianId: { $type: 'string' } } },
                { $group: { _id: '$technicianId', completed: { $sum: 1 } } },
                { $sort: { completed: -1 } },
                { $limit: TOP_TECHNICIANS * 3 },
            ]).toArray(),
        ]);
        const active = new Map(activeRows.map((r) => [r._id, r.count]));
        const everAssigned = new Set(everRows.map((r) => r._id));
        const byId = new Map(approved.map((t) => [t._id.toString(), t]));
        const busy = approved.filter((t) => active.has(t._id.toString())).length;
        return {
            approved: approved.length,
            busy,
            free: approved.length - busy,
            neverAssigned: approved.filter((t) => !everAssigned.has(t._id.toString())).length,
            // Only names, region and counts - never contact details.
            top: completedRows
                .filter((r) => byId.has(r._id))
                .slice(0, TOP_TECHNICIANS)
                .map((r) => {
                    const t = byId.get(r._id);
                    return { technicianId: r._id, name: t.name || 'Unnamed technician', region: t.region || null, completed: r.completed, active: active.get(r._id) || 0 };
                }),
        };
    }

    // GET /admin/reports?days=7|30|90
    async getReport(req, res) {
        try {
            const raw = req.query.days;
            const days = raw === undefined ? DEFAULT_DAYS : Number(raw);
            if (!ALLOWED_DAYS.includes(days)) {
                return res.status(400).send({ message: `days must be one of ${ALLOWED_DAYS.join(', ')}`, code: 'INVALID_REPORT_RANGE' });
            }
            const to = this.now();
            const from = new Date(to.getTime() - days * DAY_MS);
            const previousFrom = new Date(from.getTime() - days * DAY_MS);
            const technicians = await this.collections.technicians.find(
                {},
                { projection: { name: 1, region: 1, status: 1, workStatus: 1, expertise: 1 } }
            ).toArray();

            const [current, previous, daily, regions, breakdowns, workload] = await Promise.all([
                this.periodTotals(from, to),
                this.periodTotals(previousFrom, from),
                this.daily(from, to),
                this.regions(from, to, technicians),
                this.breakdowns(from, to),
                this.workload(from, to, technicians),
            ]);

            res.send({
                range: { days, from, to, timezone: TIMEZONE },
                overview: { ...current, previous },
                daily,
                regions,
                ...breakdowns,
                workload,
            });
        } catch (error) {
            res.status(500).send({ message: 'Error building the report', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = AdminReportController;
module.exports.ALLOWED_DAYS = ALLOWED_DAYS;
