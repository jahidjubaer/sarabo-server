const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { createNotificationService } = require('../services/notificationService');
const { canTechnicianEverTakeRequest } = require('../services/technicianEligibilityService');
const {
    isOpenForApplications, publishedAt, lastPostedAt, canReoffer, maxInspectionFee, minInspectionFee, validateApplicationInput, validateDeclineInput,
    OPEN_REQUEST_FILTER,
} = require('../utils/jobPortal');
const { bookApplication, notifyBooking } = require('../services/jobBooking');
const { announceJob } = require('../services/jobAnnouncements');
const { createCheckoutSessionManager } = require('../services/checkoutSessionManager');
const { INSPECTION_FEE_PURPOSE } = require('../utils/inspectionFee');
const { V2_PAYMENT_CURRENCY, toSmallestUnit } = require('../config/paymentConfig');
const { normalizeSiteOrigin } = require('../config/siteOrigin');
const { buildPriceGuide } = require('../services/offerPriceGuide');
const { rankOffers, medianResponseMinutes, RESPONSE_SAMPLE_LIMIT } = require('../services/offerRanking');
const { AiHelperError } = require('../services/aiHelperCall');
const { LANGUAGES: NOTE_LANGUAGES } = require('../services/aiOfferNoteService');
const { findSensitiveInputKind } = require('../utils/supportValidation');
const { getProductCategoryBySlug } = require('../utils/productCategory');
const { logSafeError, getSafeLogPath, ERROR_CATEGORIES } = require('../utils/safeLogger');

const TECHNICIAN_NOTES_MAX_LENGTH = 300;

// Job portal (job-portal phase B). Customers' waiting requests with a photo
// are listed to every approved technician who could take them (same region,
// device, repair and level as assignment). Technicians apply with an estimate
// and an inspection fee; the customer compares the applications and accepts
// one, which books that technician for the chosen pickup time - the same state
// an admin assignment accepted by the technician reaches. The other
// applications are closed. Admins can invite a technician to apply.
//
// Inspection fee (phase C): when the chosen technician charges a fee, choosing
// opens a Stripe Checkout for it and the technician is booked only once that
// payment is confirmed (services/paymentProcessor.js). A zero fee books at once.
//
// Before a technician is chosen they see the district, pickup time, problem
// and photos - never the customer's name, email or street address.
//
// Open jobs board: GET /jobs lists open requests to anyone, signed in or not,
// with a safe summary only (device, repair, district, pickup day, offers) -
// no problem text, photos or tracking id. Rejecting an offer reposts the
// request: it moves back to the top of the board, and that technician may
// send one revised offer.
const PORTAL_LIMIT = 100;

function byLastPostedDesc(a, b) {
    return (lastPostedAt(b) || 0) - (lastPostedAt(a) || 0);
}
const MAX_DEFINITIONS = 500;

function normalize(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function refuse(res, status, code, message) {
    return res.status(status).send({ message, code });
}

class JobPortalController {
    constructor(models, collections, { now = () => new Date(), mongoClient = client, stripeClient, siteOrigin, aiOfferNoteService = null } = {}) {
        this.collections = collections;
        this.aiOfferNoteService = aiOfferNoteService;
        // Stripe (test mode) is created lazily so tests can inject a fake.
        this.stripeClient = stripeClient || null;
        this.siteOrigin = siteOrigin || null;
        this.checkoutSessions = createCheckoutSessionManager(collections);
        this.Technician = models.Technician;
        this.User = models.User;
        this.TechnicianReview = models.TechnicianReview;
        this.notifications = createNotificationService(models);
        this.now = now;
        this.mongoClient = mongoClient;
    }

    stripe() {
        if (!this.stripeClient) this.stripeClient = require('stripe')(process.env.STRIPE_SECRET);
        return this.stripeClient;
    }

    origin() {
        if (!this.siteOrigin) this.siteOrigin = normalizeSiteOrigin(process.env.SITE_DOMAIN);
        return this.siteOrigin;
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

    // The caller's technician record and a job open to them, or null after
    // sending the refusal - the same rule as applying.
    async openJobForCaller(req, res) {
        const technician = await this.callerTechnician(req, res);
        if (!technician) return null;
        const request = await this.loadRequest(req.params.id);
        if (!request) {
            refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            return null;
        }
        const levels = await this.levelsByDefinition();
        if (!isOpenForApplications(request) || !canTechnicianEverTakeRequest(technician, this.needsOf(request, levels))) {
            refuse(res, 409, 'JOB_NOT_OPEN', 'this job is not open to you');
            return null;
        }
        return { technician, request };
    }

    // GET /repair-requests/:id/applications/price-guide  (technician, no AI)
    // The usual estimate and inspection fee for this service, from recent
    // offers - or the catalogue's range when there are too few.
    async priceGuide(req, res) {
        try {
            const job = await this.openJobForCaller(req, res);
            if (!job) return;
            const guide = await buildPriceGuide({
                collections: this.collections, request: job.request, maxInspectionFee: maxInspectionFee(job.request), now: this.now(),
            });
            res.send({ guide });
        } catch (error) {
            res.status(500).send({ message: 'Error loading the price guide', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/applications/ai-note  { language?: 'en'|'bn', technicianNotes? }
    // An AI draft of the offer note; the technician edits it before sending.
    async aiNote(req, res) {
        const startedAt = Date.now();
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const language = body.language === undefined ? 'en' : body.language;
        if (!NOTE_LANGUAGES.includes(language)) return refuse(res, 400, 'AI_HELPER_VALIDATION_ERROR', 'the language must be en or bn');
        const technicianNotes = typeof body.technicianNotes === 'string' ? body.technicianNotes.trim() : '';
        if (technicianNotes.length > TECHNICIAN_NOTES_MAX_LENGTH) {
            return refuse(res, 400, 'AI_HELPER_VALIDATION_ERROR', `your notes must be at most ${TECHNICIAN_NOTES_MAX_LENGTH} characters`);
        }
        if (findSensitiveInputKind(technicianNotes)) {
            return refuse(res, 400, 'AI_HELPER_VALIDATION_ERROR', 'please remove private details (card numbers, passwords, codes) from your notes');
        }
        try {
            const job = await this.openJobForCaller(req, res);
            if (!job) return;
            if (!this.aiOfferNoteService) return refuse(res, 503, 'AI_HELPER_UNAVAILABLE', 'The AI note writer is not available right now. Please write the note yourself.');
            const { request } = job;
            const definitionId = request.service && request.service.definitionId;
            const definition = definitionId && ObjectId.isValid(definitionId)
                ? await this.collections.serviceDefinitions.findOne({ _id: new ObjectId(definitionId) }, { projection: { label: 1 } })
                : null;
            const category = getProductCategoryBySlug(request.product && request.product.categorySlug);
            const note = await this.aiOfferNoteService.writeNote({
                job: {
                    deviceLabel: category ? category.label : request.product.categorySlug,
                    brand: request.product.brand,
                    model: request.product.model,
                    repairLabel: definition ? definition.label : request.service.repairCategorySlug,
                    problem: (request.damage && request.damage.description) || '',
                    photoCount: Array.isArray(request.damage && request.damage.images) ? request.damage.images.length : 0,
                },
                language,
                technicianNotes,
                requestId: req.requestId,
            });
            res.send({ note });
        } catch (error) {
            const status = error instanceof AiHelperError ? error.status : 500;
            logSafeError({ requestId: req.requestId, method: req.method, path: getSafeLogPath(req), status, category: ERROR_CATEGORIES.INTERNAL_ERROR, durationMs: Date.now() - startedAt });
            if (error instanceof AiHelperError) return res.status(error.status).send({ message: error.message, code: error.code });
            res.status(500).send({ message: 'The AI note writer failed. Please write the note yourself.', code: 'INTERNAL_ERROR' });
        }
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
                    { ...OPEN_REQUEST_FILTER, 'product.categorySlug': { $in: products } },
                    { projection: { trackingId: 1, product: 1, service: 1, serviceLocation: 1, pickupSlot: 1, damage: 1, pricing: 1, createdAt: 1, invitations: 1, deliveryStatus: 1, schemaVersion: 1, repostedAt: 1 } }
                ).sort({ createdAt: -1 }).limit(PORTAL_LIMIT * 3).toArray(),
                this.levelsByDefinition(),
            ]);
            const open = candidates
                .filter((r) => isOpenForApplications(r) && canTechnicianEverTakeRequest(technician, this.needsOf(r, levels)))
                .sort(byLastPostedDesc)
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
                        minInspectionFee: minInspectionFee(r),
                        publishedAt: publishedAt(r),
                        postedAt: lastPostedAt(r),
                        reposted: !!r.repostedAt,
                        invited: Array.isArray(r.invitations) && r.invitations.some((i) => i.technicianId === myId),
                        otherApplications: Math.max((countByRequest.get(r._id.toString()) || 0) - (application && application.status === 'pending' ? 1 : 0), 0),
                        myApplication: application ? {
                            id: application._id.toString(), status: application.status, estimateMin: application.estimateMin,
                            estimateMax: application.estimateMax, inspectionFee: application.inspectionFee, note: application.note,
                            revised: !!application.revisedAfterDecline,
                            declineReason: application.status === 'declined' ? application.declineReason || null : null,
                            declineNote: application.status === 'declined' ? application.declineNote || '' : '',
                            canReoffer: canReoffer(application),
                        } : null,
                    };
                }),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading the job portal', code: 'INTERNAL_ERROR' });
        }
    }

    // GET /jobs  (no sign-in)  ?region=&product=
    // The open jobs board: a safe summary of every open request. Technicians
    // sign in and use GET /technician/job-portal for the details.
    async listPublic(req, res) {
        try {
            const query = req.query || {};
            const filter = { ...OPEN_REQUEST_FILTER };
            const region = typeof query.region === 'string' ? query.region.trim().slice(0, 60) : '';
            const product = typeof query.product === 'string' ? query.product.trim().slice(0, 60) : '';
            if (region) filter['serviceLocation.region'] = region;
            if (product) filter['product.categorySlug'] = product;
            const candidates = await this.collections.repairRequests.find(
                filter,
                { projection: { product: 1, service: 1, serviceLocation: 1, pickupSlot: 1, damage: 1, pricing: 1, createdAt: 1, deliveryStatus: 1, schemaVersion: 1, repostedAt: 1 } }
            ).sort({ createdAt: -1 }).limit(PORTAL_LIMIT * 3).toArray();
            const open = candidates.filter(isOpenForApplications).sort(byLastPostedDesc).slice(0, PORTAL_LIMIT);
            const ids = open.map((r) => r._id.toString());
            const counts = ids.length ? await this.collections.jobApplications.aggregate([
                { $match: { requestId: { $in: ids }, status: 'pending' } },
                { $group: { _id: '$requestId', count: { $sum: 1 } } },
            ]).toArray() : [];
            const countByRequest = new Map(counts.map((c) => [c._id, c.count]));
            res.send({
                jobs: open.map((r) => ({
                    id: r._id.toString(),
                    product: { categorySlug: r.product.categorySlug, brand: r.product.brand || null },
                    repairCategorySlug: r.service.repairCategorySlug,
                    region: r.serviceLocation.region,
                    district: r.serviceLocation.district,
                    pickupDate: r.pickupSlot && r.pickupSlot.date ? r.pickupSlot.date : null,
                    catalogueEstimate: { min: r.pricing.estimateMin, max: r.pricing.estimateMax, currency: r.pricing.currency },
                    postedAt: lastPostedAt(r),
                    reposted: !!r.repostedAt,
                    offers: countByRequest.get(r._id.toString()) || 0,
                })),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading open jobs', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/applications  { estimateMin, estimateMax, inspectionFee, note }
    // Applying again while pending (or after withdrawing) updates the application.
    // After the customer rejects it, the technician may send one revised offer.
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
            const check = validateApplicationInput(req.body, { maxFee: maxInspectionFee(request), minFee: minInspectionFee(request) });
            if (!check.valid) return refuse(res, 400, check.code, check.message);

            const requestId = request._id.toString();
            const technicianId = technician._id.toString();
            const now = this.now();
            const existing = await this.collections.jobApplications.findOne({ requestId, technicianId });
            const revising = canReoffer(existing);
            if (existing && !revising && !['pending', 'withdrawn'].includes(existing.status)) {
                const message = existing.status === 'declined'
                    ? 'the customer rejected your revised offer - you cannot send another for this job'
                    : 'your application for this job is already decided';
                return refuse(res, 409, 'APPLICATION_CLOSED', message);
            }
            try {
                if (revising) {
                    const result = await this.collections.jobApplications.updateOne(
                        { requestId, technicianId, status: 'declined', revisedAfterDecline: { $ne: true } },
                        { $set: { ...check.normalized, status: 'pending', technicianName: technician.name, updatedAt: now, revisedAfterDecline: true, revisedAt: now } }
                    );
                    if (result.matchedCount === 0) return refuse(res, 409, 'APPLICATION_CLOSED', 'your application for this job is already decided');
                } else {
                    await this.collections.jobApplications.updateOne(
                        { requestId, technicianId, status: { $in: ['pending', 'withdrawn'] } },
                        {
                            $set: { ...check.normalized, status: 'pending', technicianName: technician.name, updatedAt: now },
                            $setOnInsert: { requestId, technicianId, technicianEmail: normalize(technician.email), createdAt: now },
                        },
                        { upsert: true }
                    );
                }
            } catch (error) {
                if (error && error.code === 11000) return refuse(res, 409, 'APPLICATION_CLOSED', 'your application for this job is already decided');
                throw error;
            }
            const saved = await this.collections.jobApplications.findOne({ requestId, technicianId });
            // The customer hears about each technician once, and again for a
            // revised offer after rejecting one.
            const ownerRole = await this.User.findRoleByEmail(request.senderEmail);
            if (ownerRole && (!existing || revising)) {
                await this.notifySafely({
                    recipientEmail: request.senderEmail, recipientRole: ownerRole, type: 'application_received',
                    entityType: 'repair_request', entityId: requestId, actorEmail: normalize(technician.email), actorRole: 'rider',
                    metadata: { trackingId: request.trackingId, occurrence: revising ? `${technicianId}:revised` : technicianId },
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
                .find({ requestId: request._id.toString(), status: { $in: ['pending', 'accepted', 'not_chosen', 'declined'] } })
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
            const [ratings, history] = await Promise.all([
                Promise.all(techIds.map((id) => this.TechnicianReview.aggregate(id))),
                this.matchHistory(applications.filter((a) => a.status === 'pending').map((a) => a.technicianId)),
            ]);
            const ratingById = new Map(techIds.map((id, i) => [id, ratings[i]]));
            const product = request.product && request.product.categorySlug;
            const ratingOf = (id) => ratingById.get(id) || { averageRating: null, reviewCount: 0 };

            // Smarter matching: rank the waiting offers (services/offerRanking.js).
            const ranking = rankOffers(
                applications.filter((a) => a.status === 'pending').map((a) => {
                    const t = techById.get(a.technicianId) || {};
                    const rating = ratingOf(a.technicianId);
                    const past = history.get(a.technicianId) || { noShows: 0, medianResponseMinutes: null };
                    return {
                        id: a._id.toString(), estimateMin: a.estimateMin, estimateMax: a.estimateMax, inspectionFee: a.inspectionFee, createdAt: a.createdAt,
                        technician: {
                            district: t.district || null, averageRating: rating.averageRating, reviewCount: rating.reviewCount,
                            completedRepairs: completedById.get(a.technicianId) || 0, noShows: past.noShows, medianResponseMinutes: past.medianResponseMinutes,
                        },
                    };
                }),
                { customerDistrict: request.serviceLocation && request.serviceLocation.district },
            );

            res.send({
                open: isOpenForApplications(request),
                publishedAt: publishedAt(request),
                postedAt: lastPostedAt(request),
                repostCount: request.repostCount || 0,
                applications: applications.map((a) => {
                    const t = techById.get(a.technicianId) || {};
                    const entry = (t.expertise || []).find((e) => e && e.productCategorySlug === product) || null;
                    const rating = ratingOf(a.technicianId);
                    const match = ranking.get(a._id.toString()) || null;
                    // Public technician facts only - never their email, phone or address.
                    return {
                        ...(match ? { match } : {}),
                        id: a._id.toString(),
                        status: a.status,
                        estimateMin: a.estimateMin,
                        estimateMax: a.estimateMax,
                        inspectionFee: a.inspectionFee,
                        note: a.note || '',
                        createdAt: a.createdAt,
                        revised: !!a.revisedAfterDecline,
                        declineReason: a.status === 'declined' ? a.declineReason || null : null,
                        canReoffer: canReoffer(a),
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

    // For smarter matching: each technician's missed pickups and their median
    // minutes from a job being posted to their offer (recent offers only).
    // Map technicianId -> { noShows, medianResponseMinutes }.
    async matchHistory(technicianIds) {
        const ids = [...new Set(technicianIds)];
        if (ids.length === 0) return new Map();
        const [noShows, recent] = await Promise.all([
            this.collections.jobApplications.aggregate([
                { $match: { technicianId: { $in: ids }, status: 'no_show' } },
                { $group: { _id: '$technicianId', count: { $sum: 1 } } },
            ]).toArray(),
            this.collections.jobApplications.aggregate([
                { $match: { technicianId: { $in: ids } } },
                { $sort: { createdAt: -1 } },
                { $group: { _id: '$technicianId', offers: { $push: { requestId: '$requestId', createdAt: '$createdAt' } } } },
                { $project: { offers: { $slice: ['$offers', RESPONSE_SAMPLE_LIMIT] } } },
            ]).toArray(),
        ]);
        const requestIds = [...new Set(recent.flatMap((r) => r.offers.map((o) => o.requestId)))].filter((id) => ObjectId.isValid(id));
        const requests = requestIds.length ? await this.collections.repairRequests.find(
            { _id: { $in: requestIds.map((id) => new ObjectId(id)) } },
            { projection: { createdAt: 1, repostedAt: 1, damage: 1 } }
        ).toArray() : [];
        const requestById = new Map(requests.map((r) => [r._id.toString(), r]));
        const noShowsById = new Map(noShows.map((n) => [n._id, n.count]));

        return new Map(ids.map((id) => {
            const row = recent.find((r) => r._id === id);
            const samples = (row ? row.offers : []).map((o) => {
                const job = requestById.get(o.requestId);
                if (!job || !o.createdAt) return null;
                // Offers sent after a repost count from the repost.
                const reposted = job.repostedAt ? new Date(job.repostedAt) : null;
                const postedAt = reposted && reposted <= new Date(o.createdAt) ? reposted : publishedAt(job);
                return postedAt ? { appliedAt: o.createdAt, postedAt } : null;
            }).filter(Boolean);
            return [id, { noShows: noShowsById.get(id) || 0, medianResponseMinutes: medianResponseMinutes(samples) }];
        }));
    }

    // POST /repair-requests/:id/applications/:applicationId/accept  (the owner)
    // Zero fee: books the technician now -> { success, booked: true }.
    // Otherwise: opens (or reuses) the inspection-fee checkout -> { checkoutUrl }.
    async accept(req, res) {
        try {
            const request = await this.loadRequest(req.params.id);
            const caller = normalize(req.decoded_email);
            if (!request || normalize(request.senderEmail) !== caller) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            if (!ObjectId.isValid(req.params.applicationId)) return refuse(res, 404, 'APPLICATION_NOT_FOUND', 'application not found');
            const application = await this.collections.jobApplications.findOne({ _id: new ObjectId(req.params.applicationId), requestId: request._id.toString() });
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

            if (application.inspectionFee > 0) return this.startFeeCheckout(req, res, { request, application, technician });

            const now = this.now();
            const outcome = await this.bookInTransaction({ request, application, technician, customerEmail: caller, now });
            if (outcome !== 'OK') return this.refuseBooking(res, outcome);
            await notifyBooking({ collections: this.collections, notifications: this.notifications, request, technician, customerEmail: caller, now });
            res.send({ success: true, booked: true, deliveryStatus: 'driver_assigned', technicianName: technician.name });
        } catch (error) {
            res.status(500).send({ message: 'Error accepting the application', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/applications/:applicationId/decline  { reason?, note? }  (the owner)
    // The customer does not agree with the offer (price, inspection fee or
    // anything else): the offer is rejected and the request is reposted to the
    // jobs board. The technician is told and may send one revised offer.
    async decline(req, res) {
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
            const check = validateDeclineInput(req.body);
            if (!check.valid) return refuse(res, 400, check.code, check.message);

            const now = this.now();
            const result = await this.collections.jobApplications.updateOne(
                { _id: application._id, status: 'pending' },
                { $set: { status: 'declined', declineReason: check.normalized.reason, declineNote: check.normalized.note, declinedAt: now, updatedAt: now } }
            );
            if (result.matchedCount === 0) return refuse(res, 409, 'APPLICATION_NOT_PENDING', 'this application is no longer open');

            // A checkout already opened for this offer must never be paid.
            await this.closeFeeCheckoutFor(request, application._id.toString());
            const reposted = await this.collections.repairRequests.findOneAndUpdate(
                { _id: request._id, deliveryStatus: 'pending-pickup', technicianId: { $exists: false } },
                { $set: { repostedAt: now, updatedAt: now }, $inc: { repostCount: 1 } },
                { returnDocument: 'after', projection: { repostCount: 1 } }
            );
            const repostCount = reposted && reposted.repostCount ? reposted.repostCount : (request.repostCount || 0) + 1;
            const reoffer = canReoffer({ ...application, status: 'declined' });
            await this.notifySafely({
                recipientEmail: application.technicianEmail, recipientRole: 'rider', type: 'application_declined',
                entityType: 'repair_request', entityId: requestId, actorEmail: caller, actorRole: 'user',
                metadata: { trackingId: request.trackingId, canReoffer: reoffer ? 'yes' : 'no', occurrence: application.revisedAfterDecline ? 'revised' : 'first' },
            });
            res.send({ success: true, reposted: true, postedAt: now });
            // After answering: tell the other technicians who could take it.
            await this.notifyRepost({ request, repostCount, rejectedTechnicianId: application.technicianId, customerEmail: caller });
        } catch (error) {
            res.status(500).send({ message: 'Error rejecting the offer', code: 'INTERNAL_ERROR' });
        }
    }

    // A reposted request is news to every approved technician who could take
    // it - except the one just rejected (told separately) and anyone whose
    // offer is still waiting (services/jobAnnouncements.js). Never fatal.
    async notifyRepost({ request, repostCount, rejectedTechnicianId, customerEmail }) {
        await announceJob({
            collections: this.collections, notifications: this.notifications, request, type: 'job_reposted',
            occurrence: String(repostCount), excludeTechnicianIds: [rejectedTechnicianId], actorEmail: customerEmail,
        });
    }

    async closeFeeCheckoutFor(request, applicationId) {
        const requestId = request._id.toString();
        const active = await this.checkoutSessions.findActive(requestId);
        if (!active || active.purpose !== INSPECTION_FEE_PURPOSE || active.applicationId !== applicationId) return;
        const cancelled = await this.checkoutSessions.cancelByRequestId(requestId);
        if (cancelled && cancelled.sessionId) {
            try { await this.stripe().checkout.sessions.expire(cancelled.sessionId); } catch (error) { /* already closed */ }
        }
        await this.collections.repairRequests.updateOne(
            { _id: request._id, 'feeCheckout.applicationId': applicationId },
            { $unset: { feeCheckout: '' } }
        );
    }

    async bookInTransaction({ request, application, technician, customerEmail, now }) {
        const session = this.mongoClient.startSession();
        let outcome = 'OK';
        try {
            await session.withTransaction(async () => {
                // A refusal returns before any write, so there is nothing to undo.
                outcome = await bookApplication({ collections: this.collections, request, application, technician, customerEmail, now, session });
            });
        } catch (error) {
            if (error && error.code === 'TECHNICIAN_BUSY') outcome = 'TECHNICIAN_BUSY';
            else if (outcome === 'OK') throw error;
        } finally {
            await session.endSession();
        }
        return outcome;
    }

    refuseBooking(res, outcome) {
        if (outcome === 'TECHNICIAN_BUSY') return refuse(res, 409, 'TECHNICIAN_BUSY', 'this technician is on another job right now - choose another or try later');
        return refuse(res, 409, 'JOB_NOT_OPEN', 'a technician has already been chosen for this request');
    }

    // Opens a Stripe Checkout (test mode) for the chosen technician's
    // inspection fee. One active checkout per request: choosing the same
    // application again reuses it; choosing another replaces it.
    async startFeeCheckout(req, res, { request, application, technician }) {
        const requestId = request._id.toString();
        const applicationId = application._id.toString();
        const amount = application.inspectionFee;
        const stripe = this.stripe();

        const active = await this.checkoutSessions.findActive(requestId);
        if (active) {
            const sameChoice = active.purpose === INSPECTION_FEE_PURPOSE && active.applicationId === applicationId && active.status === 'open';
            if (sameChoice) {
                try {
                    const existing = await stripe.checkout.sessions.retrieve(active.sessionId);
                    if (existing && existing.status === 'open' && existing.url) {
                        return res.send({ checkoutUrl: existing.url, reused: true });
                    }
                } catch (error) {
                    // Fall through and replace it.
                }
            }
            if (active.status === 'creating') {
                return refuse(res, 409, 'CHECKOUT_CREATION_IN_PROGRESS', 'a payment is already being prepared - try again in a moment');
            }
            // A different choice (or an unusable session): close it first so an
            // old checkout link can never be paid.
            const cancelled = await this.checkoutSessions.cancelByRequestId(requestId);
            if (cancelled && cancelled.sessionId) {
                try { await stripe.checkout.sessions.expire(cancelled.sessionId); } catch (error) { /* already closed */ }
            }
        }

        const claim = await this.checkoutSessions.claim({
            requestId, ownerEmail: normalize(request.senderEmail), amount, currency: V2_PAYMENT_CURRENCY,
            purpose: INSPECTION_FEE_PURPOSE, applicationId,
        });
        if (!claim.claimed) return refuse(res, 409, 'CHECKOUT_CREATION_IN_PROGRESS', 'a payment is already being prepared - try again in a moment');

        let session;
        try {
            const device = [request.product && request.product.brand, request.product && request.product.model].filter(Boolean).join(' ') || 'your device';
            session = await stripe.checkout.sessions.create({
                mode: 'payment',
                line_items: [{
                    price_data: {
                        currency: V2_PAYMENT_CURRENCY,
                        unit_amount: toSmallestUnit(amount),
                        product_data: { name: `Inspection visit: ${device}`, description: `${technician.name} - counts toward the final price if you go ahead` },
                    },
                    quantity: 1,
                }],
                customer_email: request.senderEmail,
                metadata: {
                    requestId, trackingId: request.trackingId, schemaVersion: '2',
                    paymentType: INSPECTION_FEE_PURPOSE, applicationId,
                },
                success_url: `${this.origin()}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${this.origin()}/dashboard/my-requests/${requestId}`,
            }, { idempotencyKey: `inspection-checkout-${claim.id.toString()}` });
        } catch (error) {
            await this.checkoutSessions.markFailed(claim.id);
            return res.status(502).send({ message: 'the payment page could not be opened - please try again', code: 'CHECKOUT_UNAVAILABLE' });
        }
        await this.checkoutSessions.markOpen(claim.id, {
            sessionId: session.id,
            expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
        });
        await this.collections.repairRequests.updateOne(
            { _id: request._id },
            { $set: { feeCheckout: { applicationId, technicianId: application.technicianId, amount, sessionId: session.id, startedAt: this.now() } } }
        );
        res.send({ checkoutUrl: session.url, reused: false });
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
