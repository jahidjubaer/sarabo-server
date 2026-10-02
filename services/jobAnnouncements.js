const { ObjectId } = require('mongodb');
const { canTechnicianEverTakeRequest } = require('./technicianEligibilityService');
const { isOpenForApplications, OPEN_REQUEST_FILTER, lastPostedAt } = require('../utils/jobPortal');

// Tells approved technicians who could take an open request that it is on the
// jobs board: `job_posted` when it is created, `job_reposted` after the
// customer rejected an offer. In-app notifications only (free). Never throws;
// returns how many were told.
//
// announceOpenJobsToTechnician covers the other direction: a technician who
// starts matching later (just approved, or added a repair to their expertise)
// is told about the open jobs they can now take.
const ANNOUNCE_LIMIT = 50;

async function announceJob({ collections, notifications, request, type, occurrence = null, excludeTechnicianIds = [], actorEmail = null, limit = ANNOUNCE_LIMIT }) {
    try {
        if (!isOpenForApplications(request)) return 0;
        const requestId = request._id.toString();
        const [technicians, definition, waiting] = await Promise.all([
            collections.technicians.find({ status: 'approved' }, { projection: { email: 1, status: 1, region: 1, expertise: 1 } }).toArray(),
            request.service && ObjectId.isValid(request.service.definitionId)
                ? collections.serviceDefinitions.findOne({ _id: new ObjectId(request.service.definitionId) }, { projection: { requiredExpertiseLevel: 1 } })
                : null,
            collections.jobApplications.find({ requestId, status: 'pending' }, { projection: { technicianId: 1 } }).toArray(),
        ]);
        const needs = {
            region: request.serviceLocation && request.serviceLocation.region,
            productCategorySlug: request.product && request.product.categorySlug,
            repairCategorySlug: request.service && request.service.repairCategorySlug,
            requiredExpertiseLevel: definition ? definition.requiredExpertiseLevel : undefined,
        };
        const skip = new Set([...excludeTechnicianIds, ...waiting.map((a) => a.technicianId)].filter(Boolean));
        const recipients = technicians
            .filter((t) => t.email && !skip.has(t._id.toString()) && canTechnicianEverTakeRequest(t, needs))
            .slice(0, limit);
        let sent = 0;
        for (const technician of recipients) {
            try {
                await notifications.createNotification({
                    recipientEmail: technician.email, recipientRole: 'rider', type,
                    entityType: 'repair_request', entityId: requestId,
                    ...(actorEmail ? { actorEmail, actorRole: 'user' } : {}),
                    metadata: { trackingId: request.trackingId, ...(occurrence ? { occurrence } : {}) },
                });
                sent += 1;
            } catch (error) {
                console.error(`Job announcement ${type} failed (non-fatal):`, error.message);
            }
        }
        return sent;
    } catch (error) {
        console.error(`Job announcements ${type} failed (non-fatal):`, error.message);
        return 0;
    }
}

// One `job_posted` per open job this technician can now take and has not
// offered on, newest first, at most `limit`. The notification's dedupe key is
// per request and technician, so a job they were already told about (at
// creation, or by an earlier expertise change) is never announced twice.
// Never throws; returns how many were told.
async function announceOpenJobsToTechnician({ collections, notifications, technicianId, limit = ANNOUNCE_LIMIT }) {
    try {
        if (!ObjectId.isValid(technicianId)) return 0;
        const technician = await collections.technicians.findOne(
            { _id: new ObjectId(technicianId) }, { projection: { email: 1, status: 1, region: 1, expertise: 1 } });
        if (!technician || technician.status !== 'approved' || !technician.email || !Array.isArray(technician.expertise)) return 0;
        const products = technician.expertise.map((entry) => entry && entry.productCategorySlug).filter(Boolean);
        if (products.length === 0) return 0;
        const [requests, applied] = await Promise.all([
            collections.repairRequests.find(
                { ...OPEN_REQUEST_FILTER, 'product.categorySlug': { $in: products } },
                { projection: { schemaVersion: 1, deliveryStatus: 1, technicianId: 1, trackingId: 1, product: 1, service: 1, serviceLocation: 1, createdAt: 1, repostedAt: 1, damage: 1 } }
            ).limit(500).toArray(),
            collections.jobApplications.find({ technicianId: technician._id.toString() }, { projection: { requestId: 1 } }).toArray(),
        ]);
        const alreadyOffered = new Set(applied.map((a) => String(a.requestId)));
        const definitionIds = [...new Set(requests.map((r) => r.service && r.service.definitionId).filter((id) => ObjectId.isValid(id)))];
        const definitions = definitionIds.length > 0
            ? await collections.serviceDefinitions.find({ _id: { $in: definitionIds.map((id) => new ObjectId(id)) } }, { projection: { requiredExpertiseLevel: 1 } }).toArray()
            : [];
        const levelById = new Map(definitions.map((d) => [d._id.toString(), d.requiredExpertiseLevel]));
        const matches = requests
            .filter((r) => isOpenForApplications(r) && !alreadyOffered.has(r._id.toString())
                && canTechnicianEverTakeRequest(technician, {
                    region: r.serviceLocation && r.serviceLocation.region,
                    productCategorySlug: r.product && r.product.categorySlug,
                    repairCategorySlug: r.service && r.service.repairCategorySlug,
                    requiredExpertiseLevel: r.service ? levelById.get(String(r.service.definitionId)) : undefined,
                }))
            .sort((a, b) => (lastPostedAt(b) || 0) - (lastPostedAt(a) || 0))
            .slice(0, limit);
        let sent = 0;
        for (const request of matches) {
            try {
                const result = await notifications.createNotification({
                    recipientEmail: technician.email, recipientRole: 'rider', type: 'job_posted',
                    entityType: 'repair_request', entityId: request._id.toString(),
                    metadata: { trackingId: request.trackingId },
                });
                if (result && result.created) sent += 1;
            } catch (error) {
                console.error('Open-job announcement failed (non-fatal):', error.message);
            }
        }
        return sent;
    } catch (error) {
        console.error('Open-job announcements failed (non-fatal):', error.message);
        return 0;
    }
}

module.exports = { announceJob, announceOpenJobsToTechnician, ANNOUNCE_LIMIT };
