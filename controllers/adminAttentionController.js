const { canTechnicianEverTakeRequest } = require('../services/technicianEligibilityService');
const { isOpenForApplications, publishedAt, lastPostedAt, CHOOSE_WITHIN_MS } = require('../utils/jobPortal');
const { findStalledWork } = require('../services/stalledWork');

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
// - unchosen        open in the job portal (has a photo, nobody chosen), no
//                   technician has an offer waiting, and it was last posted
//                   (published, or reposted after the customer rejected an
//                   offer) 24 hours or more ago. While any technician has
//                   replied, the customer decides and no admin is needed.
// - feeRefunds      an inspection-fee refund Stripe has not completed yet
//                   (job-portal phase D) - an admin retries it from the
//                   request page. Read from the payments rows, which are what
//                   gets refunded.
// - blockedRepairs  the technician says a paid repair cannot be finished - an
//                   admin cancels and refunds it (controllers/workflowController.js).
// - receiptDisputes the customer says the device was not returned (a finished
//                   repair, or one cancelled after pickup) and no admin has settled it.
// - conditionDisputes the customer disagrees with the condition recorded at pickup.
// - stalled         work that has not moved on in time (services/stalledWork.js).
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
    schemaVersion: 1, 'damage.images.uploadedAt': 1, repostedAt: 1, repostCount: 1,
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

    // Everything that needs an admin now; also used by the AI report summary.
    async buildAttention(now = this.now()) {
        const rr = this.collections.repairRequests;
        const missedFilter = {
            deliveryStatus: { $in: ASSIGNED_NOT_COLLECTED },
            'pickupSlot.endsAt': { $lte: now },
            pickupRescheduleRequestedAt: { $exists: false },
        };
        // Any payment waiting for its refund: inspection fees, and a repair
        // payment that arrived after the request was cancelled.
        const refundFilter = { refundStatus: 'pending' };
        const blockedFilter = { deliveryStatus: { $in: ['payment_completed', 'repair_in_progress'] }, repairBlocked: { $exists: true } };
        const disputeFilter = {
            deliveryStatus: { $in: ['repair_completed', 'cancelled'] }, 'deviceReturn.disputedAt': { $exists: true },
            'deviceReturn.resolvedAt': { $exists: false }, 'deviceReturn.confirmedAt': { $exists: false },
        };
        const conditionFilter = { 'pickupCondition.customerDisputedAt': { $exists: true }, 'pickupCondition.reviewedAt': { $exists: false } };
        const [overdueWaiting, overdueWaitingTotal, missedPickups, missedPickupsTotal, waiting, technicians, definitions, feeRefunds, feeRefundsTotal, blockedRepairs, receiptDisputes, conditionDisputes, stalled] = await Promise.all([
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
            // Oldest first; never the customer's email or Stripe ids.
            this.collections.payments.find(refundFilter, { projection: { requestId: 1, trackingId: 1, amount: 1, currency: 1, purpose: 1, refundReason: 1, paidAt: 1, lastRefundAttemptAt: 1 } })
                .sort({ paidAt: 1 }).limit(LIST_LIMIT).toArray(),
            this.collections.payments.countDocuments(refundFilter),
            rr.find(blockedFilter, { projection: { ...SUMMARY_PROJECTION, repairBlocked: 1 } }).sort({ 'repairBlocked.reportedAt': 1 }).limit(LIST_LIMIT).toArray(),
            rr.find(disputeFilter, { projection: { ...SUMMARY_PROJECTION, deviceReturn: 1 } }).sort({ 'deviceReturn.disputedAt': 1 }).limit(LIST_LIMIT).toArray(),
            rr.find(conditionFilter, { projection: { ...SUMMARY_PROJECTION, pickupCondition: 1 } }).sort({ 'pickupCondition.customerDisputedAt': 1 }).limit(LIST_LIMIT).toArray(),
            findStalledWork(this.collections, now),
        ]);

        const levelByDefinition = new Map(definitions.map((d) => [d._id.toString(), d.requiredExpertiseLevel]));
        const chooseBy = now.getTime() - CHOOSE_WITHIN_MS;
        const staleOpen = waiting.filter((doc) => {
            if (!isOpenForApplications(doc)) return false;
            const posted = lastPostedAt(doc);
            return posted !== null && posted.getTime() <= chooseBy;
        });
        const staleIds = staleOpen.map((doc) => doc._id.toString());
        // aggregate, not distinct: the connection uses the strict Stable API.
        const withOffers = staleIds.length ? await this.collections.jobApplications.aggregate([
            { $match: { requestId: { $in: staleIds }, status: 'pending' } },
            { $group: { _id: '$requestId' } },
        ]).toArray() : [];
        const answered = new Set(withOffers.map((row) => row._id));
        const unchosen = staleOpen.filter((doc) => !answered.has(doc._id.toString()));
        const unmatchable = waiting.filter((doc) => !technicians.some((t) => canTechnicianEverTakeRequest(t, {
            region: doc.serviceLocation && doc.serviceLocation.region,
            productCategorySlug: doc.product && doc.product.categorySlug,
            repairCategorySlug: doc.service && doc.service.repairCategorySlug,
            requiredExpertiseLevel: levelByDefinition.get(doc.service && doc.service.definitionId),
        })));

        return {
            generatedAt: now,
            counts: {
                overdueWaiting: overdueWaitingTotal,
                missedPickups: missedPickupsTotal,
                unmatchable: unmatchable.length,
                unchosen: unchosen.length,
                feeRefunds: feeRefundsTotal,
                blockedRepairs: blockedRepairs.length,
                receiptDisputes: receiptDisputes.length,
                conditionDisputes: conditionDisputes.length,
                stalled: stalled.length,
            },
            overdueWaiting: overdueWaiting.map(summarize),
            missedPickups: missedPickups.map(summarize),
            unmatchable: unmatchable.slice(0, LIST_LIMIT).map(summarize),
            unchosen: unchosen.slice(0, LIST_LIMIT).map((doc) => ({
                ...summarize(doc),
                publishedAt: publishedAt(doc),
                postedAt: lastPostedAt(doc),
                repostCount: doc.repostCount || 0,
                pendingApplications: 0,
            })),
            blockedRepairs: blockedRepairs.map((doc) => ({ ...summarize(doc), reason: doc.repairBlocked.reason, reportedAt: doc.repairBlocked.reportedAt })),
            receiptDisputes: receiptDisputes.map((doc) => ({ ...summarize(doc), note: doc.deviceReturn.disputeNote || '', disputedAt: doc.deviceReturn.disputedAt })),
            conditionDisputes: conditionDisputes.map((doc) => ({ ...summarize(doc), note: doc.pickupCondition.customerNote || '', disputedAt: doc.pickupCondition.customerDisputedAt })),
            stalled: stalled.slice(0, LIST_LIMIT).map((item) => ({ ...summarize(item.request), stage: item.stage, since: item.since })),
            feeRefunds: feeRefunds.map((row) => ({
                id: row.requestId,
                trackingId: row.trackingId || null,
                amount: row.amount,
                currency: row.currency || 'BDT',
                reason: row.refundReason || null,
                purpose: row.purpose || 'inspection_fee',
                paidAt: row.paidAt || null,
                lastAttemptAt: row.lastRefundAttemptAt || null,
            })),
        };
    }

    // GET /admin/attention
    async getAttention(req, res) {
        try {
            res.send(await this.buildAttention());
        } catch (error) {
            res.status(500).send({ message: 'Error loading requests that need attention', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = AdminAttentionController;
