const { ObjectId } = require('mongodb');
const { canTechnicianEverTakeRequest } = require('./technicianEligibilityService');
const { isOpenForApplications } = require('../utils/jobPortal');

// Tells approved technicians who could take an open request that it is on the
// jobs board: `job_posted` when it is first published (its first photo),
// `job_reposted` after the customer rejected an offer. In-app notifications
// only (free). Never throws; returns how many were told.
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

module.exports = { announceJob, ANNOUNCE_LIMIT };
