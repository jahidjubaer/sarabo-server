const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { logTracking } = require('../middleware/logging');
const { createNotificationService } = require('../services/notificationService');
const { canTechnicianEverTakeRequest } = require('../services/technicianEligibilityService');
const { buildPendingAssignmentEntry } = require('../utils/assignmentDecision');
const { ACTIVE_STATUSES } = require('../utils/repairRequestStatus');
const { isOpenForApplications, publishedAt, maxInspectionFee, validateApplicationInput } = require('../utils/jobPortal');

// Job portal (job-portal phase B). Customers' waiting requests with a photo
// are listed to every approved technician who could take them (same region,
// device, repair and level as assignment). Technicians apply with an estimate
// and an inspection fee; the customer compares the applications and accepts
// one, which books that technician for the chosen pickup time - the same state
// an admin assignment accepted by the technician reaches. The other
// applications are closed. Admins can invite a technician to apply.
//
// Before a technician is chosen they see the district, pickup time, problem
// and photos - never the customer's name, email or street address.
const PORTAL_LIMIT = 100;
const MAX_DEFINITIONS = 500;

function normalize(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function refuse(res, status, code, message) {
    return res.status(status).send({ message, code });
}

class JobPortalController {
    constructor(models, collections, { now = () => new Date(), mongoClient = client } = {}) {
        this.collections = collections;
        this.Technician = models.Technician;
        this.User = models.User;
        this.TechnicianReview = models.TechnicianReview;
        this.notifications = createNotificationService(models);
        this.now = now;
        this.mongoClient = mongoClient;
    }

    async levelsByDefinition() {
        const rows = await this.collections.serviceDefinitions.find({}, { projection: { requiredExpertiseLevel: 1 } }).limit(MAX_DEFINITIONS).toArray();
        return new Map(rows.map((d) => [d._id.toString(), d.requiredExpertiseLevel]));
    }

    needsOf(request, levels) {
        return {
            region: request.serviceLocation && request.serviceLocation.region,
            productCategorySlug: request.product && request.product.categorySlug,
            repairCategorySlug: request.service && request.service.repairCategorySlug,
            requiredExpertiseLevel: levels.get(request.service && request.service.definitionId),
        };
    }

    // The caller's own approved technician record, or a refusal.
    async callerTechnician(req, res) {
        const technician = await this.Technician.findByEmail(normalize(req.decoded_email));
        if (!technician || technician.status !== 'approved') {
            refuse(res, 403, 'TECHNICIAN_NOT_APPROVED', 'only approved technicians can use the job portal');
            return null;
        }
        return technician;
    }

    async loadRequest(id) {
        if (!ObjectId.isValid(id)) return null;
        return this.collections.repairRequests.findOne({ _id: new ObjectId(id) });
    }

    async notifySafely(input) {
        try {
            await this.notifications.createNotification(input);
        } catch (error) {
            console.error(`Job portal notification ${input.type} failed (non-fatal):`, error.message);
        }
    }

    // GET /technician/job-portal
    async listPortal(req, res) {
        try {
            const technician = await this.callerTechnician(req, res);
            if (!technician) return;
            const products = (technician.expertise || []).map((e) => e && e.productCategorySlug).filter(Boolean);
            if (products.length === 0) return res.send({ jobs: [] });

            const [candidates, levels] = await Promise.all([
                this.collections.repairRequests.find(
                    {
                        schemaVersion: 2, deliveryStatus: 'pending-pickup', technicianId: { $exists: false },
                        'damage.images.0': { $exists: true }, 'product.categorySlug': { $in: products },
                    },
                    { projection: { trackingId: 1, product: 1, service: 1, serviceLocation: 1, pickupSlot: 1, damage: 1, pricing: 1, createdAt: 1, invitations: 1, deliveryStatus: 1, schemaVersion: 1 } }
                ).sort({ createdAt: -1 }).limit(PORTAL_LIMIT * 3).toArray(),
                this.levelsByDefinition(),
            ]);
            const open = candidates
                .filter((r) => isOpenForApplications(r) && canTechnicianEverTakeRequest(technician, this.needsOf(r, levels)))
                .slice(0, PORTAL_LIMIT);
            const ids = open.map((r) => r._id.toString());
            const [mine, counts] = await Promise.all([
                this.collections.jobApplications.find({ requestId: { $in: ids }, technicianId: technician._id.toString() }).toArray(),
                this.collections.jobApplications.aggregate([
                    { $match: { requestId: { $in: ids }, status: 'pending' } },
                    { $group: { _id: '$requestId', count: { $sum: 1 } } },
                ]).toArray(),
            ]);
            const mineByRequest = new Map(mine.map((a) => [a.requestId, a]));
            const countByRequest = new Map(counts.map((c) => [c._id, c.count]));
            const myId = technician._id.toString();

            res.send({
                jobs: open.map((r) => {
                    const application = mineByRequest.get(r._id.toString());
                    return {
                        id: r._id.toString(),
                        trackingId: r.trackingId,
                        product: { categorySlug: r.product.categorySlug, brand: r.product.brand || null, model: r.product.model || null },
                        repairCategorySlug: r.service.repairCategorySlug,
                        region: r.serviceLocation.region,
                        district: r.serviceLocation.district,
                        pickupSlot: r.pickupSlot || null,
                        problem: r.damage.description || '',
                        photoCount: r.damage.images.length,
                        catalogueEstimate: { min: r.pricing.estimateMin, max: r.pricing.estimateMax, currency: r.pricing.currency },
                        maxInspectionFee: maxInspectionFee(r),
                        publishedAt: publishedAt(r),
                        invited: Array.isArray(r.invitations) && r.invitations.some((i) => i.technicianId === myId),
                        otherApplications: Math.max((countByRequest.get(r._id.toString()) || 0) - (application && application.status === 'pending' ? 1 : 0), 0),
                        myApplication: application ? {
                            id: application._id.toString(), status: application.status, estimateMin: application.estimateMin,
                            estimateMax: application.estimateMax, inspectionFee: application.inspectionFee, note: application.note,
                        } : null,
                    };
                }),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading the job portal', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/applications  { estimateMin, estimateMax, inspectionFee, note }
    // Applying again while pending (or after withdrawing) updates the application.
    async apply(req, res) {
        try {
            const technician = await this.callerTechnician(req, res);
            if (!technician) return;
            const request = await this.loadRequest(req.params.id);
            if (!request) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            const levels = await this.levelsByDefinition();
            if (!isOpenForApplications(request) || !canTechnicianEverTakeRequest(technician, this.needsOf(request, levels))) {
                return refuse(res, 409, 'JOB_NOT_OPEN', 'this job is not open to you');
            }
            const check = validateApplicationInput(req.body, { maxFee: maxInspectionFee(request) });
            if (!check.valid) return refuse(res, 400, check.code, check.message);

            const requestId = request._id.toString();
            const technicianId = technician._id.toString();
            const now = this.now();
            const existing = await this.collections.jobApplications.findOne({ requestId, technicianId });
            if (existing && !['pending', 'withdrawn'].includes(existing.status)) {
                return refuse(res, 409, 'APPLICATION_CLOSED', 'your application for this job is already decided');
            }
            try {
                await this.collections.jobApplications.updateOne(
                    { requestId, technicianId, status: { $in: ['pending', 'withdrawn'] } },
                    {
                        $set: { ...check.normalized, status: 'pending', technicianName: technician.name, updatedAt: now },
                        $setOnInsert: { requestId, technicianId, technicianEmail: normalize(technician.email), createdAt: now },
                    },
                    { upsert: true }
                );
            } catch (error) {
                if (error && error.code === 11000) return refuse(res, 409, 'APPLICATION_CLOSED', 'your application for this job is already decided');
                throw error;
            }
            const saved = await this.collections.jobApplications.findOne({ requestId, technicianId });
            // The customer hears about each technician once.
            const ownerRole = await this.User.findRoleByEmail(request.senderEmail);
            if (ownerRole && !existing) {
                await this.notifySafely({
                    recipientEmail: request.senderEmail, recipientRole: ownerRole, type: 'application_received',
                    entityType: 'repair_request', entityId: requestId, actorEmail: normalize(technician.email), actorRole: 'rider',
                    metadata: { trackingId: request.trackingId, occurrence: technicianId },
                });
            }
            res.status(existing ? 200 : 201).send({ application: { id: saved._id.toString(), status: saved.status, ...check.normalized } });
        } catch (error) {
            res.status(500).send({ message: 'Error saving the application', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/applications/mine/withdraw
    async withdraw(req, res) {
        try {
            const technician = await this.callerTechnician(req, res);
            if (!technician) return;
            if (!ObjectId.isValid(req.params.id)) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            const result = await this.collections.jobApplications.updateOne(
                { requestId: req.params.id, technicianId: technician._id.toString(), status: 'pending' },
                { $set: { status: 'withdrawn', updatedAt: this.now() } }
            );
            if (result.matchedCount === 0) return refuse(res, 409, 'NO_PENDING_APPLICATION', 'you have no pending application for this job');
            res.send({ success: true });
        } catch (error) {
            res.status(500).send({ message: 'Error withdrawing the application', code: 'INTERNAL_ERROR' });
        }
    }

    // GET /repair-requests/:id/applications  (the request's owner, or an admin)
    async listForRequest(req, res) {
        try {
            const request = await this.loadRequest(req.params.id);
            const caller = normalize(req.decoded_email);
            const isOwner = request && normalize(request.senderEmail) === caller;
            const isAdmin = request && !isOwner && (await this.User.findRoleByEmail(caller)) === 'admin';
            // Not found and not yours look the same.
            if (!request || (!isOwner && !isAdmin)) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');

            const applications = await this.collections.jobApplications
                .find({ requestId: request._id.toString(), status: { $in: ['pending', 'accepted', 'not_chosen'] } })
                .sort({ createdAt: 1 }).toArray();
            const techIds = applications.map((a) => a.technicianId).filter((id) => ObjectId.isValid(id));
            const [technicians, completed] = await Promise.all([
                this.collections.technicians.find(
                    { _id: { $in: techIds.map((id) => new ObjectId(id)) } },
                    { projection: { name: 1, district: 1, region: 1, expertise: 1 } }
                ).toArray(),
                this.collections.repairRequests.aggregate([
                    { $match: { technicianId: { $in: techIds }, deliveryStatus: { $in: ['repair_completed', 'parcel_delivered'] } } },
                    { $group: { _id: '$technicianId', count: { $sum: 1 } } },
                ]).toArray(),
            ]);
            const techById = new Map(technicians.map((t) => [t._id.toString(), t]));
            const completedById = new Map(completed.map((c) => [c._id, c.count]));
            const ratings = await Promise.all(techIds.map((id) => this.TechnicianReview.aggregate(id)));
            const ratingById = new Map(techIds.map((id, i) => [id, ratings[i]]));
            const product = request.product && request.product.categorySlug;

            res.send({
                open: isOpenForApplications(request),
                publishedAt: publishedAt(request),
                applications: applications.map((a) => {
                    const t = techById.get(a.technicianId) || {};
                    const entry = (t.expertise || []).find((e) => e && e.productCategorySlug === product) || null;
                    const rating = ratingById.get(a.technicianId) || { averageRating: null, reviewCount: 0 };
                    // Public technician facts only - never their email, phone or address.
                    return {
                        id: a._id.toString(),
                        status: a.status,
                        estimateMin: a.estimateMin,
                        estimateMax: a.estimateMax,
                        inspectionFee: a.inspectionFee,
                        note: a.note || '',
                        createdAt: a.createdAt,
                        technician: {
                            name: t.name || a.technicianName || 'Technician',
                            district: t.district || null,
                            level: entry ? entry.level : null,
                            experienceYears: entry ? entry.experienceYears : null,
                            completedRepairs: completedById.get(a.technicianId) || 0,
                            averageRating: rating.averageRating === null ? null : Math.round(rating.averageRating * 10) / 10,
                            reviewCount: rating.reviewCount,
                        },
                    };
                }),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading applications', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/applications/:applicationId/accept  (the owner)
    async accept(req, res) {
        try {
            const request = await this.loadRequest(req.params.id);
            const caller = normalize(req.decoded_email);
            if (!request || normalize(request.senderEmail) !== caller) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            if (!ObjectId.isValid(req.params.applicationId)) return refuse(res, 404, 'APPLICATION_NOT_FOUND', 'application not found');
            const requestId = request._id.toString();
            const application = await this.collections.jobApplications.findOne({ _id: new ObjectId(req.params.applicationId), requestId });
            if (!application) return refuse(res, 404, 'APPLICATION_NOT_FOUND', 'application not found');
            if (application.status !== 'pending') return refuse(res, 409, 'APPLICATION_NOT_PENDING', 'this application is no longer open');
            if (!isOpenForApplications(request)) return refuse(res, 409, 'JOB_NOT_OPEN', 'a technician has already been chosen for this request');

            const technician = ObjectId.isValid(application.technicianId)
                ? await this.collections.technicians.findOne({ _id: new ObjectId(application.technicianId) })
                : null;
            const levels = await this.levelsByDefinition();
            if (!technician || !canTechnicianEverTakeRequest(technician, this.needsOf(request, levels))) {
                return refuse(res, 409, 'TECHNICIAN_NOT_ELIGIBLE', 'this technician can no longer take the job');
            }
            if (technician.workStatus !== 'available') {
                return refuse(res, 409, 'TECHNICIAN_BUSY', 'this technician is on another job right now - choose another or try later');
            }

            const now = this.now();
            const session = this.mongoClient.startSession();
            let conflict = null;
            try {
                await session.withTransaction(async () => {
                    conflict = null;
                    const busy = await this.collections.repairRequests.findOne(
                        { technicianId: application.technicianId, deliveryStatus: { $in: ACTIVE_STATUSES }, _id: { $ne: request._id } },
                        { session }
                    );
                    if (busy) { conflict = 'TECHNICIAN_BUSY'; return; }
                    const requestUpdate = await this.collections.repairRequests.updateOne(
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
                            },
                            // The technician offered and the customer accepted:
                            // recorded as an accepted assignment.
                            $push: {
                                assignmentHistory: {
                                    ...buildPendingAssignmentEntry({
                                        assignmentId: application._id.toString(), technicianId: application.technicianId,
                                        technicianEmail: technician.email, technicianName: technician.name,
                                        assignedBy: caller, assignedAt: now,
                                    }),
                                    decision: 'accepted',
                                    decidedAt: now,
                                    source: 'job_portal',
                                },
                            },
                        },
                        { session }
                    );
                    if (requestUpdate.matchedCount === 0) { conflict = 'JOB_NOT_OPEN'; return; }
                    const technicianUpdate = await this.collections.technicians.updateOne(
                        { _id: technician._id, status: 'approved', workStatus: 'available' },
                        { $set: { workStatus: 'in_delivery' } },
                        { session }
                    );
                    if (technicianUpdate.matchedCount === 0) {
                        throw Object.assign(new Error('technician became unavailable'), { code: 'TECHNICIAN_BUSY' });
                    }
                    await this.collections.jobApplications.updateOne({ _id: application._id, status: 'pending' }, { $set: { status: 'accepted', decidedAt: now } }, { session });
                    await this.collections.jobApplications.updateMany(
                        { requestId, _id: { $ne: application._id }, status: 'pending' },
                        { $set: { status: 'not_chosen', decidedAt: now } },
                        { session }
                    );
                    await logTracking(this.collections.trackingEvents, request.trackingId, 'driver_assigned', session);
                });
            } catch (error) {
                if (error && error.code === 'TECHNICIAN_BUSY') conflict = 'TECHNICIAN_BUSY';
                else throw error;
            } finally {
                await session.endSession();
            }
            if (conflict === 'TECHNICIAN_BUSY') return refuse(res, 409, 'TECHNICIAN_BUSY', 'this technician is on another job right now - choose another or try later');
            if (conflict === 'JOB_NOT_OPEN') return refuse(res, 409, 'JOB_NOT_OPEN', 'a technician has already been chosen for this request');

            await this.notifySafely({
                recipientEmail: technician.email, recipientRole: 'rider', type: 'application_accepted',
                entityType: 'repair_request', entityId: requestId, actorEmail: caller, actorRole: 'user',
                metadata: { trackingId: request.trackingId },
            });
            const others = await this.collections.jobApplications.find({ requestId, status: 'not_chosen', decidedAt: now }).toArray();
            for (const other of others) {
                await this.notifySafely({
                    recipientEmail: other.technicianEmail, recipientRole: 'rider', type: 'application_not_chosen',
                    entityType: 'repair_request', entityId: requestId, metadata: { trackingId: request.trackingId },
                });
            }
            res.send({ success: true, deliveryStatus: 'driver_assigned', technicianName: technician.name });
        } catch (error) {
            res.status(500).send({ message: 'Error accepting the application', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /admin/repair-requests/:id/invite  { technicianId }
    async invite(req, res) {
        try {
            const request = await this.loadRequest(req.params.id);
            if (!request) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            const technicianId = req.body && req.body.technicianId;
            if (!ObjectId.isValid(technicianId)) return refuse(res, 400, 'INVALID_TECHNICIAN_ID', 'invalid technician id');
            if (!isOpenForApplications(request)) return refuse(res, 409, 'JOB_NOT_OPEN', 'this request is not open for applications');
            const technician = await this.collections.technicians.findOne({ _id: new ObjectId(technicianId) });
            const levels = await this.levelsByDefinition();
            if (!technician || !canTechnicianEverTakeRequest(technician, this.needsOf(request, levels))) {
                return refuse(res, 409, 'TECHNICIAN_NOT_ELIGIBLE', 'this technician cannot take this request');
            }
            const now = this.now();
            const result = await this.collections.repairRequests.updateOne(
                { _id: request._id, 'invitations.technicianId': { $ne: technicianId } },
                { $push: { invitations: { technicianId, invitedAt: now, invitedBy: normalize(req.decoded_email) } } }
            );
            if (result.matchedCount === 0) return refuse(res, 409, 'ALREADY_INVITED', 'this technician has already been invited');
            await this.notifySafely({
                recipientEmail: technician.email, recipientRole: 'rider', type: 'job_invitation',
                entityType: 'repair_request', entityId: request._id.toString(), actorEmail: normalize(req.decoded_email), actorRole: 'admin',
                metadata: { trackingId: request.trackingId },
            });
            res.send({ success: true });
        } catch (error) {
            res.status(500).send({ message: 'Error inviting the technician', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = JobPortalController;
