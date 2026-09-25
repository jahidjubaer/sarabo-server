const { canTechnicianEverTakeRequest } = require('../services/technicianEligibilityService');
const { isOpenForApplications, publishedAt, CHOOSE_WITHIN_MS } = require('../utils/jobPortal');

// Requests that need an admin now (overdue-alerts phase). Read-only.
//
// - overdueWaiting  still waiting for a technician, and its pickup time has
//                   started or passed.
// - missedPickups   a technician is assigned (offered, accepted or on the
//                   way) but the pickup window has ended and the device was
//                   not collected. Requests where the customer has already
//                   been asked for a new time are left out - they are waiting
//                   on the customer (controllers/missedPickupController.js).
// - unmatchable     waiting, and no approved technician in its region can
//                   ever take it (right device, repair and level) - it needs
//                   a new local technician, not just time.
// - unchosen        open in the job portal (has a photo, nobody chosen) for
//                   24 hours or more since it was published (job-portal phase B).
// A request can be in more than one list; each list is independent.
const WAITING = 'pending-pickup';
const ASSIGNED_NOT_COLLECTED = ['assignment_pending', 'driver_assigned', 'rider_arriving'];
const LIST_LIMIT = 200;
// Waiting work is small by nature; cap the in-memory matching anyway.
const MAX_WAITING_SCANNED = 2000;

// Only what the admin screens show - never the customer's contact details
// or storage internals.
const SUMMARY_PROJECTION = {
    trackingId: 1, product: 1, service: 1, serviceLocation: 1, pickupSlot: 1, deliveryStatus: 1,
    technicianId: 1, technicianName: 1, createdAt: 1,
    // For the job-portal checks only (publish time); never returned as-is.
    schemaVersion: 1, 'damage.images.uploadedAt': 1,
};

function summarize(doc) {
    return {
        id: doc._id.toString(),
        trackingId: doc.trackingId || null,
        deliveryStatus: doc.deliveryStatus,
        productCategorySlug: doc.product && doc.product.categorySlug ? doc.product.categorySlug : null,
        brand: doc.product && doc.product.brand ? doc.product.brand : null,
        model: doc.product && doc.product.model ? doc.product.model : null,
        repairCategorySlug: doc.service && doc.service.repairCategorySlug ? doc.service.repairCategorySlug : null,
        region: doc.serviceLocation && doc.serviceLocation.region ? doc.serviceLocation.region : null,
        district: doc.serviceLocation && doc.serviceLocation.district ? doc.serviceLocation.district : null,
        pickupSlot: doc.pickupSlot || null,
        technicianName: doc.technicianName || null,
        createdAt: doc.createdAt || null,
    };
}

class AdminAttentionController {
    constructor(models, collections, { now = () => new Date() } = {}) {
        this.collections = collections;
        this.now = now;
    }

    // GET /admin/attention
    async getAttention(req, res) {
        try {
            const now = this.now();
            const rr = this.collections.repairRequests;
            const missedFilter = {
                deliveryStatus: { $in: ASSIGNED_NOT_COLLECTED },
                'pickupSlot.endsAt': { $lte: now },
                pickupRescheduleRequestedAt: { $exists: false },
            };
            const [overdueWaiting, overdueWaitingTotal, missedPickups, missedPickupsTotal, waiting, technicians, definitions] = await Promise.all([
                // Longest overdue first.
                rr.find({ deliveryStatus: WAITING, 'pickupSlot.startsAt': { $lte: now } }, { projection: SUMMARY_PROJECTION })
                    .sort({ 'pickupSlot.startsAt': 1 }).limit(LIST_LIMIT).toArray(),
                rr.countDocuments({ deliveryStatus: WAITING, 'pickupSlot.startsAt': { $lte: now } }),
                rr.find(missedFilter, { projection: SUMMARY_PROJECTION })
                    .sort({ 'pickupSlot.endsAt': 1 }).limit(LIST_LIMIT).toArray(),
                rr.countDocuments(missedFilter),
                rr.find({ deliveryStatus: WAITING, schemaVersion: 2 }, { projection: SUMMARY_PROJECTION })
                    .sort({ createdAt: 1 }).limit(MAX_WAITING_SCANNED).toArray(),
                this.collections.technicians.find({ status: 'approved' }, { projection: { status: 1, region: 1, expertise: 1 } }).toArray(),
                this.collections.serviceDefinitions.find({}, { projection: { requiredExpertiseLevel: 1 } }).toArray(),
            ]);

            const levelByDefinition = new Map(definitions.map((d) => [d._id.toString(), d.requiredExpertiseLevel]));
            const chooseBy = now.getTime() - CHOOSE_WITHIN_MS;
            const unchosen = waiting.filter((doc) => {
                if (!isOpenForApplications(doc)) return false;
                const published = publishedAt(doc);
                return published !== null && published.getTime() <= chooseBy;
            });
            const unchosenIds = unchosen.map((doc) => doc._id.toString());
            const applicationCounts = unchosenIds.length ? await this.collections.jobApplications.aggregate([
                { $match: { requestId: { $in: unchosenIds }, status: 'pending' } },
                { $group: { _id: '$requestId', count: { $sum: 1 } } },
            ]).toArray() : [];
            const applicationsById = new Map(applicationCounts.map((row) => [row._id, row.count]));
            const unmatchable = waiting.filter((doc) => !technicians.some((t) => canTechnicianEverTakeRequest(t, {
                region: doc.serviceLocation && doc.serviceLocation.region,
                productCategorySlug: doc.product && doc.product.categorySlug,
                repairCategorySlug: doc.service && doc.service.repairCategorySlug,
                requiredExpertiseLevel: levelByDefinition.get(doc.service && doc.service.definitionId),
            })));

            res.send({
                generatedAt: now,
                counts: {
                    overdueWaiting: overdueWaitingTotal,
                    missedPickups: missedPickupsTotal,
                    unmatchable: unmatchable.length,
                    unchosen: unchosen.length,
                },
                overdueWaiting: overdueWaiting.map(summarize),
                missedPickups: missedPickups.map(summarize),
                unmatchable: unmatchable.slice(0, LIST_LIMIT).map(summarize),
                unchosen: unchosen.slice(0, LIST_LIMIT).map((doc) => ({
                    ...summarize(doc),
                    publishedAt: publishedAt(doc),
                    pendingApplications: applicationsById.get(doc._id.toString()) || 0,
                })),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading requests that need attention', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = AdminAttentionController;
