const { ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { client } = require('../config/database');
const { generateSecureTrackingId } = require('../utils/trackingId');
const { logTracking } = require('../middleware/logging');
const { VALID_STATUSES, ACTIVE_STATUSES, isValidTransition } = require('../utils/parcelStatus');
const { normalize } = require('../services/paymentProcessor');
const { createNotificationService } = require('../services/notificationService');
const { createCheckoutSessionManager } = require('../services/checkoutSessionManager');
const { getCancellationEligibility } = require('../services/cancellationPolicy');
const { canAssignRequest } = require('../services/assignmentEligibility');
const { escapeRegex, sanitizeSearchText } = require('../utils/searchSanitize');
const { CURRENT_REPAIR_REQUEST_SCHEMA_VERSION, validateRepairRequestSchemaVersion, isV2RepairRequest } = require('../utils/repairRequestSchema');
const {
    STAGED_MIN_DAMAGE_IMAGES, validateProductInput, buildProductSnapshot, validateServiceDefinitionMatch,
    validateDamageDescription, validateDamageImages, buildDamageSnapshot, validateServiceLocation,
    buildServiceLocationSnapshot, validateClientPricingAbsence
} = require('../utils/repairRequestV2');
const { getPricingEstimate } = require('../services/pricingService');
const {
    ELIGIBILITY_VERSION, DIAGNOSTIC_INELIGIBLE_CAP, validateDiagnosticFlag, validatePagination,
    deriveRequestTaxonomy, validateCurrentServiceDefinition, deriveServiceAreaMatch, evaluateTechnician,
    scoreTechnician, sortTechnicians, buildEligibleTechnicianEntry, buildIneligibleTechnicianEntry, paginate
} = require('../services/technicianEligibilityService');

const ADMIN_LIST_DEFAULT_LIMIT = 10;
const ADMIN_LIST_MAX_LIMIT = 50;
const ADMIN_LIST_MAX_SEARCH_LENGTH = 100;
// Every status the admin request-management filter accepts - deliberately
// the same set utils/parcelStatus.js's VALID_STATUSES plus the two values
// that can never appear in that list (the implicit initial 'pending-pickup'
// and the terminal 'cancelled', neither of which is a client-settable
// transition target for updateParcelStatus, but both of which are real,
// filterable request states).
const ADMIN_LIST_VALID_STATUSES = ['pending-pickup', 'driver_assigned', 'rider_arriving', 'parcel_picked_up', 'parcel_delivered', 'cancelled'];

class ParcelController {
    constructor(models, collections) {
        this.Parcel = models.Parcel;
        this.Rider = models.Rider;
        this.User = models.User;
        this.ServiceDefinition = models.ServiceDefinition;
        this.collections = collections;
        // Guards against duplicate concurrent Stripe Checkout Sessions and
        // is reused here to release/expire an active session on cancellation
        // - see services/checkoutSessionManager.js.
        this.checkoutSessions = createCheckoutSessionManager(collections);
        this.notifications = createNotificationService(models);
    }

    async getAllParcels(req, res) {
        try {
            const query = {};
            const { email, deliveryStatus } = req.query;
            const currentUser = await this.User.findByEmail(req.decoded_email);

            // Non-admin users can only see their own repair requests
            if (!currentUser || currentUser.role !== 'admin') {
                query.senderEmail = req.decoded_email;
            } else if (email) {
                // Admins can filter by email
                query.senderEmail = email;
            }

            if (deliveryStatus) {
                query.deliveryStatus = deliveryStatus;
            }

            const result = await this.Parcel.findAll(query);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair requests', error: error.message });
        }
    }

    async getRiderParcels(req, res) {
        try {
            const { deliveryStatus } = req.query;
            const query = { riderEmail: req.decoded_email };

            if (deliveryStatus !== 'parcel_delivered') {
                query.deliveryStatus = { $nin: ['parcel_delivered'] };
            } else {
                query.deliveryStatus = deliveryStatus;
            }

            const result = await this.Parcel.findAll(query);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching technician repair requests', error: error.message });
        }
    }

    async getParcelById(req, res) {
        try {
            const id = req.params.id;
            const parcel = await this.Parcel.findById(id);
            
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found' });
            }
            
            const currentUser = await this.User.findByEmail(req.decoded_email);
            const isOwner = parcel.senderEmail === req.decoded_email;
            const isAssignedRider = parcel.riderEmail === req.decoded_email;
            const isAdmin = currentUser && currentUser.role === 'admin';
            
            if (!isOwner && !isAssignedRider && !isAdmin) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            // The inspection sub-document (Phase 6.4 Unit 4) is never served
            // through this raw-parcel endpoint - it carries technician
            // internalNotes and submitter identity that must never reach the
            // customer here. All inspection reads go through the dedicated,
            // role-projected GET /parcels/:id/inspection (see
            // controllers/inspectionController.js), exactly as damage images
            // are served only through their own authorized endpoint. Only the
            // inspection field is stripped; deliveryStatus (which may be
            // inspection_completed) is preserved.
            // The inspection, quote, and repair sub-documents (Phase 6.4 Units
            // 4-7) are never served through this raw-parcel endpoint - they are
            // read only through their own dedicated, role-projected endpoints
            // (inspectionController / quoteController / repairController), which
            // strip internal submitter identity, storage keys, and signed URLs.
            // deliveryStatus (which may be a quote_*/payment/repair_* state) is
            // preserved.
            const { inspection, quote, repair, ...safeParcel } = parcel;
            res.send(safeParcel);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair request', error: error.message });
        }
    }

    async getDeliveryStatusStats(req, res) {
        try {
            const result = await this.Parcel.getDeliveryStatusStats();
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair status stats', error: error.message });
        }
    }

    // Admin-only complete request-management view: paginated, searchable,
    // filterable, and explicitly projected (see Parcel.findPaginated) so it
    // never depends on the generic GET /parcels contract that MyRequests and
    // AssignTechnicians already rely on. Every query parameter is validated
    // against a fixed allow-list before being used to build the MongoDB
    // filter - nothing from the client is ever passed through as a raw
    // Mongo operator or field selector.
    async getAdminParcels(req, res) {
        try {
            let { page, limit, search, status, paymentStatus, sort } = req.query;

            page = parseInt(page, 10);
            if (!Number.isInteger(page) || page < 1) {
                page = 1;
            }

            limit = parseInt(limit, 10);
            if (!Number.isInteger(limit) || limit < 1) {
                limit = ADMIN_LIST_DEFAULT_LIMIT;
            }
            if (limit > ADMIN_LIST_MAX_LIMIT) {
                limit = ADMIN_LIST_MAX_LIMIT;
            }

            const query = {};

            if (status && status !== 'all' && ADMIN_LIST_VALID_STATUSES.includes(status)) {
                query.deliveryStatus = status;
            }

            if (paymentStatus === 'paid') {
                query.paymentStatus = 'paid';
            } else if (paymentStatus === 'unpaid') {
                query.paymentStatus = { $ne: 'paid' };
            }

            const searchText = sanitizeSearchText(search, ADMIN_LIST_MAX_SEARCH_LENGTH);
            if (searchText) {
                const pattern = { $regex: escapeRegex(searchText), $options: 'i' };
                query.$or = [
                    { trackingId: pattern },
                    { senderEmail: pattern },
                    { senderName: pattern },
                    { parcelName: pattern }
                ];
            }

            const sortDirection = sort === 'oldest' ? 1 : -1;

            const { data, totalItems } = await this.Parcel.findPaginated(query, {
                page,
                limit,
                sort: { createdAt: sortDirection }
            });

            const enrichedData = data.map(parcel => ({
                ...parcel,
                canAssign: canAssignRequest(parcel)
            }));

            const totalPages = Math.max(Math.ceil(totalItems / limit), 1);

            res.send({
                data: enrichedData,
                pagination: {
                    page,
                    limit,
                    totalItems,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1
                }
            });
        } catch (error) {
            res.status(500).send({ message: 'Error fetching admin repair requests', error: error.message });
        }
    }

    // Dispatches on schemaVersion (Phase 6.3 Unit 4) - absent or 1 is the
    // existing legacy path below, completely unchanged; 2 is the new v2
    // path (createRepairRequestV2); anything else is a controlled 400. The
    // dispatch check is the only thing added to this method - every line of
    // the legacy path itself is untouched, so legacy creation behavior stays
    // byte-for-byte identical to before this unit.
    async createParcel(req, res) {
        const schemaCheck = validateRepairRequestSchemaVersion(req.body && req.body.schemaVersion);
        if (!schemaCheck.valid) {
            return res.status(400).send({ message: schemaCheck.message, code: schemaCheck.code });
        }
        if (schemaCheck.version === CURRENT_REPAIR_REQUEST_SCHEMA_VERSION) {
            return this.createRepairRequestV2(req, res);
        }

        try {
            const parcel = req.body;
            parcel.createdAt = new Date();
            parcel.senderEmail = req.decoded_email;
            parcel.deliveryStatus = 'pending-pickup';

            // Collision retry: astronomically unlikely at 128 bits of
            // randomness, but the unique index on trackingId
            // (config/database.js) is the real guard - a duplicate-key
            // error here just means try again with a fresh code, the same
            // pattern already used for payments/checkoutSessions elsewhere
            // in this codebase.
            const MAX_TRACKING_ID_ATTEMPTS = 5;
            let result;
            for (let attempt = 1; attempt <= MAX_TRACKING_ID_ATTEMPTS; attempt++) {
                parcel.trackingId = generateSecureTrackingId();
                try {
                    result = await this.Parcel.create(parcel);
                    break;
                } catch (error) {
                    if (error.code === 11000 && attempt < MAX_TRACKING_ID_ATTEMPTS) continue;
                    throw error;
                }
            }

            logTracking(this.collections.trackings, parcel.trackingId, 'parcel_created');

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error creating repair request', error: error.message });
        }
    }

    // Canonical v2 repair-request creation (Phase 6.3 Unit 4). Ownership
    // (senderEmail) always comes from the verified token, never the request
    // body - a client cannot create a request for another email. Product,
    // service, damage, and location are all strictly validated; pricing is
    // entirely server-derived from the persisted service definition via
    // services/pricingService.js's getPricingEstimate() - a client-supplied
    // pricing-authority field is rejected outright (validateClientPricingAbsence),
    // never silently overwritten. No transaction: this is a single read (the
    // service definition) followed by a single insert of an immutable
    // pricing snapshot - the persisted request remains valid even if the
    // catalog changes afterward (see the unit report's Phase S/creation-
    // atomicity discussion).
    async createRepairRequestV2(req, res) {
        try {
            const body = req.body || {};

            const pricingGuard = validateClientPricingAbsence(body);
            if (!pricingGuard.valid) {
                return res.status(400).send({ message: pricingGuard.message, code: pricingGuard.code });
            }

            const productValidation = validateProductInput(body.product);
            if (!productValidation.valid) {
                return res.status(400).send({ message: productValidation.message, code: productValidation.code });
            }

            const serviceDefinitionId = (body.service && body.service.definitionId) || body.serviceDefinitionId;
            if (!ObjectId.isValid(serviceDefinitionId)) {
                return res.status(400).send({ message: 'invalid service definition id', code: 'INVALID_SERVICE_DEFINITION_ID' });
            }

            const definition = await this.ServiceDefinition.findById(serviceDefinitionId);
            const matchResult = validateServiceDefinitionMatch(definition, body.product && body.product.categorySlug);
            if (!matchResult.valid) {
                return res.status(400).send({ message: matchResult.message, code: matchResult.code });
            }

            const damageDescriptionInput = body.damage && body.damage.description;
            const descriptionValidation = validateDamageDescription(damageDescriptionInput);
            if (!descriptionValidation.valid) {
                return res.status(400).send({ message: descriptionValidation.message, code: descriptionValidation.code });
            }

            // Staged compatibility (Phase L): Firebase Storage upload is not
            // implemented in this unit, so 0 images is temporarily permitted
            // - see STAGED_MIN_DAMAGE_IMAGES in utils/repairRequestV2.js.
            // When supplied, images are still fully validated against the
            // canonical metadata shape/bounds; only the minimum count is
            // relaxed.
            const damageImagesInput = (body.damage && body.damage.images) || [];
            const imagesValidation = validateDamageImages(damageImagesInput, { minImages: STAGED_MIN_DAMAGE_IMAGES });
            if (!imagesValidation.valid) {
                return res.status(400).send({ message: imagesValidation.message, code: imagesValidation.code });
            }

            const locationValidation = validateServiceLocation(body.serviceLocation);
            if (!locationValidation.valid) {
                return res.status(400).send({ message: locationValidation.message, code: locationValidation.code });
            }

            // Server-owned pricing snapshot - never the client's. No current
            // service definition has an exact fixed price (every seeded row
            // is a baseMin/baseMax range), so quotedAmount/finalAmount are
            // always null at creation; quoteStatus reflects whether an
            // in-person inspection or a remote quote is the next step.
            const estimate = getPricingEstimate(definition);
            const quoteStatus = definition.inspectionRequired === true ? 'pending_inspection' : 'awaiting_quote';

            const now = new Date();
            const document = {
                schemaVersion: CURRENT_REPAIR_REQUEST_SCHEMA_VERSION,
                senderEmail: normalize(req.decoded_email),
                product: buildProductSnapshot(body.product),
                // repairCategorySlug always comes from the definition itself,
                // never from any client-supplied service.repairCategorySlug.
                service: { definitionId: definition._id.toString(), repairCategorySlug: definition.repairCategorySlug },
                damage: buildDamageSnapshot({ description: damageDescriptionInput, images: damageImagesInput }),
                serviceLocation: buildServiceLocationSnapshot(body.serviceLocation),
                pricing: {
                    currency: estimate.currency,
                    estimateMin: estimate.estimateMin,
                    estimateMax: estimate.estimateMax,
                    inspectionFee: estimate.inspectionFee,
                    calculationVersion: estimate.pricingVersion,
                    quotedAmount: null,
                    quoteStatus,
                    customerApprovedAt: null,
                    finalAmount: null
                },
                deliveryStatus: 'pending-pickup',
                createdAt: now,
                updatedAt: now
            };

            const MAX_TRACKING_ID_ATTEMPTS = 5;
            let result;
            for (let attempt = 1; attempt <= MAX_TRACKING_ID_ATTEMPTS; attempt++) {
                document.trackingId = generateSecureTrackingId();
                try {
                    result = await this.Parcel.create(document);
                    break;
                } catch (error) {
                    if (error.code === 11000 && attempt < MAX_TRACKING_ID_ATTEMPTS) continue;
                    throw error;
                }
            }

            logTracking(this.collections.trackings, document.trackingId, 'parcel_created');

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error creating repair request', error: error.message });
        }
    }

    // Admin-only, read-only eligible-technician recommendations (Phase 6.3
    // Unit 5). Never mutates any record - no rider/parcel write, no
    // notification, no tracking write, no assignment claim. Advisory only:
    // the assignment transaction (a future unit) independently revalidates
    // eligibility at commit time, exactly as it already does for approval
    // status and availability today. All business logic (hard eligibility,
    // ranking, safe shaping) lives in services/technicianEligibilityService.js;
    // this method only orchestrates the set-based database reads that
    // service needs, so no N+1 query pattern is introduced regardless of
    // candidate count.
    async getEligibleTechnicians(req, res) {
        try {
            const requestId = req.params.id;
            if (!ObjectId.isValid(requestId)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }

            const diagnosticCheck = validateDiagnosticFlag(req.query.diagnostic);
            if (!diagnosticCheck.valid) {
                return res.status(400).send({ message: diagnosticCheck.message, code: diagnosticCheck.code });
            }
            const paginationCheck = validatePagination(req.query.page, req.query.limit);
            if (!paginationCheck.valid) {
                return res.status(400).send({ message: paginationCheck.message, code: paginationCheck.code });
            }

            const parcel = await this.Parcel.findById(requestId);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            // Taxonomy always comes from the request's own persisted
            // snapshot - never guessed from legacy fields (parcelName,
            // receiverRegion, license, bike) for a legacy request, which is
            // rejected outright instead.
            const taxonomyResult = deriveRequestTaxonomy(parcel);
            if (!taxonomyResult.valid) {
                return res.status(409).send({ message: taxonomyResult.message, code: taxonomyResult.code });
            }

            // Current service activity/match is a hard requirement,
            // independent of what the request's historical snapshot says -
            // ServiceDefinition.findById already returns null for a
            // malformed id, which correctly resolves to
            // SERVICE_DEFINITION_NOT_FOUND below rather than throwing.
            const serviceDefinition = await this.ServiceDefinition.findById(taxonomyResult.definitionId);
            const definitionValidation = validateCurrentServiceDefinition(serviceDefinition, taxonomyResult);
            if (!definitionValidation.valid) {
                return res.status(409).send({ message: definitionValidation.message, code: definitionValidation.code });
            }

            const diagnostic = diagnosticCheck.value;
            // Diagnostic mode additionally fetches non-approved candidates
            // solely so it can report TECHNICIAN_NOT_APPROVED for them - the
            // default path never needs to see them, since they could never
            // be eligible regardless of anything else.
            const candidates = await this.Rider.findEligibilityCandidates({ approvedOnly: !diagnostic });
            const candidateIds = candidates.map((rider) => rider._id.toString());
            const candidateEmails = candidates.map((rider) => normalize(rider.email)).filter(Boolean);

            // Every per-candidate fact is fetched in exactly one set-based
            // query/aggregation each - never one query per candidate.
            const [activeRiderIds, completedCounts, linkedUserDocs] = await Promise.all([
                this.Parcel.findRiderIdsWithDeliveryStatuses(candidateIds, ACTIVE_STATUSES),
                this.Parcel.aggregateCompletedCountsByRider(candidateIds, 'parcel_delivered'),
                candidateEmails.length
                    ? this.collections.users.find({ email: { $in: candidateEmails } }, { projection: { email: 1, role: 1, _id: 0 } }).toArray()
                    : []
            ]);
            const roleByEmail = new Map(linkedUserDocs.map((doc) => [normalize(doc.email), doc.role]));

            const eligible = [];
            const ineligible = [];

            for (const rider of candidates) {
                const riderRole = roleByEmail.get(normalize(rider.email)) || null;
                const evaluation = evaluateTechnician(rider, {
                    requestTaxonomy: taxonomyResult,
                    serviceDefinition,
                    activeRiderIds,
                    riderRole
                });

                if (evaluation.eligible) {
                    const serviceAreaMatch = deriveServiceAreaMatch(taxonomyResult, rider);
                    const completedRepairCount = completedCounts.get(rider._id.toString()) || 0;
                    const scoreResult = scoreTechnician({
                        matchedExpertiseEntry: evaluation.matchedExpertiseEntry,
                        serviceAreaMatch,
                        completedRepairCount
                    });
                    eligible.push(buildEligibleTechnicianEntry(rider, evaluation, scoreResult, serviceAreaMatch, completedRepairCount));
                } else if (diagnostic) {
                    ineligible.push(buildIneligibleTechnicianEntry(rider, evaluation));
                }
            }

            const sortedEligible = sortTechnicians(eligible);
            const { pageItems, pagination } = paginate(sortedEligible, { page: paginationCheck.page, limit: paginationCheck.limit });

            const response = {
                requestId: parcel._id.toString(),
                eligibilityVersion: ELIGIBILITY_VERSION,
                requestSummary: {
                    productCategorySlug: taxonomyResult.productCategorySlug,
                    repairCategorySlug: taxonomyResult.repairCategorySlug,
                    requiredExpertiseLevel: serviceDefinition.requiredExpertiseLevel,
                    serviceArea: { region: taxonomyResult.region, district: taxonomyResult.district }
                },
                technicians: pageItems,
                pagination
            };

            if (diagnostic) {
                response.ineligibleTechnicians = ineligible.slice(0, DIAGNOSTIC_INELIGIBLE_CAP);
                response.totalIneligible = ineligible.length;
            }

            res.send(response);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching eligible technicians', error: error.message });
        }
    }

    // Non-completion status transitions (rider_arriving, parcel_picked_up)
    // only ever touch the repair request itself, so a single guarded update
    // is enough. The final parcel_delivered transition is different - it
    // must also atomically reset the assigned technician and write exactly
    // one completion tracking log, so it is handled separately by
    // completeParcel below, which is the actual deliverable of this unit.
    async updateParcelStatus(req, res) {
        try {
            const id = req.params.id;
            const requestedStatus = req.body.deliveryStatus;

            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }
            if (!VALID_STATUSES.includes(requestedStatus)) {
                return res.status(400).send({ message: 'invalid repair status', code: 'INVALID_REPAIR_STATUS' });
            }

            const parcel = await this.Parcel.findById(id);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            const currentUser = await this.User.findByEmail(req.decoded_email);
            const isRider = currentUser && currentUser.role === 'rider';
            const isAdmin = currentUser && currentUser.role === 'admin';
            const isAssignedRider = parcel.riderEmail === req.decoded_email;

            // Only the assigned technician or admins can update the repair request status
            if (!isAdmin && !(isRider && isAssignedRider)) {
                return res.status(403).send({ message: 'forbidden access', code: isRider ? 'NOT_ASSIGNED_TECHNICIAN' : 'FORBIDDEN' });
            }

            // The completion transition has its own transactional path - see
            // completeParcel. Everything below only ever applies to the
            // earlier, technician-only steps of the lifecycle.
            if (requestedStatus === 'parcel_delivered') {
                return this.completeParcel(res, parcel, req.decoded_email);
            }

            if (requestedStatus === parcel.deliveryStatus) {
                // Idempotent re-submission of the current status: nothing to
                // persist, and no tracking log (or lifecycle notification)
                // should be duplicated for it.
                return res.send({ message: 'status unchanged', matchedCount: 1, modifiedCount: 0 });
            }

            if (!isValidTransition(parcel.deliveryStatus, requestedStatus)) {
                return res.status(409).send({ message: 'invalid status transition', code: 'STATUS_TRANSITION_NOT_ALLOWED' });
            }

            // Guarded atomically against a concurrent status change landing
            // between the read above and this write - the query condition
            // itself is the race-resolver, not the read-then-write check.
            const result = await this.collections.parcels.updateOne(
                { _id: parcel._id, deliveryStatus: parcel.deliveryStatus },
                { $set: { deliveryStatus: requestedStatus } }
            );

            if (result.matchedCount === 0) {
                return res.status(409).send({ message: 'this request was updated concurrently', code: 'STATUS_TRANSITION_NOT_ALLOWED' });
            }

            // The tracking log always uses the repair request's own
            // trackingId, never a client-supplied value - trusting the body
            // here would let a caller write a tracking event under an
            // arbitrary/unrelated trackingId.
            logTracking(this.collections.trackings, parcel.trackingId, requestedStatus);

            // Best-effort lifecycle notification - only reached after a
            // genuine, newly-committed transition (never on the no-op or
            // invalid-transition paths above). This never runs inside a
            // transaction (the status update itself isn't one), and a
            // failure here can never turn this already-successful status
            // transition into an error response - see
            // notifyRepairOwnerBestEffort.
            if (requestedStatus === 'rider_arriving') {
                await this.notifyRepairOwnerBestEffort({ parcel, type: 'technician_on_the_way', actorEmail: req.decoded_email });
            } else if (requestedStatus === 'parcel_picked_up') {
                await this.notifyRepairOwnerBestEffort({ parcel, type: 'repair_in_progress', actorEmail: req.decoded_email });
            }

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error updating repair status', error: error.message });
        }
    }

    // Best-effort, non-blocking repair-lifecycle notification for the two
    // non-transactional status transitions (rider_arriving, parcel_picked_up)
    // - never for repair_completed, which joins completeParcel's own
    // transaction instead. Resolves both the repair owner's real current
    // role and the authenticated actor's real current role from the users
    // collection (never trusted from the parcel document, request body, or
    // a hardcoded assumption, never defaulted); if either lookup fails, or
    // the notification insert itself fails, the failure is logged and
    // swallowed here so the already-successful status transition above is
    // never turned into an error response.
    async notifyRepairOwnerBestEffort({ parcel, type, actorEmail }) {
        try {
            const resolvedOwnerRole = await this.User.findRoleByEmail(parcel.senderEmail);
            if (!resolvedOwnerRole) {
                console.error('Repair owner role could not be resolved for lifecycle notification (non-fatal):', type, parcel._id.toString());
                return;
            }
            // The endpoint's own authorization already permits either the
            // assigned rider or an admin to trigger this transition - the
            // persisted actorRole must reflect whichever one actually
            // authenticated, never an assumed/hardcoded value.
            const resolvedActorRole = await this.User.findRoleByEmail(actorEmail);
            if (resolvedActorRole !== 'rider' && resolvedActorRole !== 'admin') {
                console.error('Actor role could not be resolved as rider/admin for lifecycle notification (non-fatal):', type, parcel._id.toString());
                return;
            }
            await this.notifications.createNotification({
                recipientEmail: parcel.senderEmail,
                recipientRole: resolvedOwnerRole,
                type,
                entityType: 'parcel',
                entityId: parcel._id.toString(),
                actorEmail,
                actorRole: resolvedActorRole,
                metadata: { trackingId: parcel.trackingId }
            });
        } catch (error) {
            console.error('Best-effort repair lifecycle notification failed (non-fatal):', type, error.message);
        }
    }

    // Final repair-completion transition. Atomically commits three things
    // together: the repair request's deliveryStatus -> parcel_delivered, the
    // assigned technician's workStatus -> available, and exactly one
    // completion tracking log entry. Previously these were three independent
    // writes (the last two using a client-supplied riderId/trackingId and
    // not even awaited); if the technician reset or tracking insert failed
    // after the request had already committed as delivered, the request was
    // left "completed" while the technician stayed in_delivery, with no way
    // for a retry to repair it. The assigned technician is always the one
    // recorded on the repair request itself (parcel.riderId) - a
    // client-supplied riderId is never trusted to select who gets reset.
    async completeParcel(res, parcel, actorEmail) {
        try {
            if (!parcel.riderId || !ObjectId.isValid(parcel.riderId)) {
                return res.status(409).send({ message: 'this request has no valid assigned technician', code: 'REQUEST_NOT_ASSIGNED' });
            }

            const mongoSession = client.startSession();
            // Set exactly once inside the transaction, mirroring the
            // assignment/approval transactions elsewhere in this file -
            // either a genuine conflict/not-found (no throw, nothing was
            // written) or a success/idempotent-success marker. A thrown
            // error is reserved for a write actually failing after another
            // write in the same transaction already succeeded, so the whole
            // thing rolls back.
            let outcome = null;
            try {
                await mongoSession.withTransaction(async () => {
                    const freshParcel = await this.collections.parcels.findOne(
                        { _id: parcel._id },
                        { session: mongoSession }
                    );
                    if (!freshParcel) {
                        outcome = { httpStatus: 404, code: 'REQUEST_NOT_FOUND', message: 'repair request not found' };
                        return;
                    }

                    const currentStatus = freshParcel.deliveryStatus;
                    const riderId = freshParcel.riderId;

                    if (!riderId || !ObjectId.isValid(riderId)) {
                        outcome = { httpStatus: 409, code: 'REQUEST_NOT_ASSIGNED', message: 'this request has no valid assigned technician' };
                        return;
                    }

                    if (currentStatus === 'parcel_delivered') {
                        // Same-status request - only a genuine no-op when the
                        // assigned technician is already available too.
                        // Otherwise this is a pre-existing inconsistency
                        // between the request and the technician, which must
                        // never be silently reported as success.
                        const technician = await this.collections.riders.findOne(
                            { _id: new ObjectId(riderId) },
                            { session: mongoSession }
                        );
                        if (technician && technician.workStatus === 'available') {
                            outcome = { idempotent: true };
                            return;
                        }
                        outcome = {
                            httpStatus: 409, code: 'COMPLETION_CONFLICT',
                            message: 'this request is already completed but the technician state is inconsistent'
                        };
                        return;
                    }

                    if (currentStatus !== 'parcel_picked_up') {
                        outcome = {
                            httpStatus: 409, code: 'STATUS_TRANSITION_NOT_ALLOWED',
                            message: currentStatus === 'cancelled' ? 'this request has been cancelled' : 'repair request is not ready to be completed'
                        };
                        return;
                    }

                    const technician = await this.collections.riders.findOne(
                        { _id: new ObjectId(riderId) },
                        { session: mongoSession }
                    );
                    if (!technician) {
                        outcome = { httpStatus: 404, code: 'TECHNICIAN_NOT_FOUND', message: 'assigned technician not found' };
                        return;
                    }

                    // The repair request's owner is resolved from the real
                    // users collection state inside this same transaction -
                    // never trusted from the parcel document itself, and
                    // never defaulted. Resolved before any guarded write
                    // below, so a missing/invalid owner account aborts
                    // completion before anything commits: no parcel
                    // completion, no technician reset, no tracking write, no
                    // notification. Mirrors the same outcome-object pattern
                    // as every other pre-write conflict above (nothing was
                    // written yet, so no throw/rollback is needed).
                    const resolvedOwnerRole = await this.User.findRoleByEmail(freshParcel.senderEmail, { session: mongoSession });
                    if (!resolvedOwnerRole) {
                        outcome = { httpStatus: 409, code: 'REPAIR_OWNER_ROLE_UNRESOLVED', message: 'repair request owner account could not be verified' };
                        return;
                    }

                    // The authenticated actor's real current role is
                    // resolved the same way, inside the same transaction -
                    // this endpoint's own authorization already permits
                    // either the assigned rider or an admin to complete a
                    // repair, so the persisted actorRole must reflect
                    // whichever one actually authenticated, never an
                    // assumed/hardcoded value. Resolved before any guarded
                    // write below, mirroring the owner-role check above.
                    const resolvedActorRole = await this.User.findRoleByEmail(actorEmail, { session: mongoSession });
                    if (resolvedActorRole !== 'rider' && resolvedActorRole !== 'admin') {
                        outcome = { httpStatus: 409, code: 'REPAIR_ACTOR_ROLE_UNRESOLVED', message: 'repair completion actor account could not be verified' };
                        return;
                    }

                    // Guarded atomically against a concurrent completion
                    // attempt on the same request - re-verifies the status is
                    // still what was just read, not just a read-then-write
                    // check.
                    const parcelUpdateResult = await this.collections.parcels.updateOne(
                        { _id: freshParcel._id, deliveryStatus: 'parcel_picked_up' },
                        { $set: { deliveryStatus: 'parcel_delivered' } },
                        { session: mongoSession }
                    );
                    if (parcelUpdateResult.matchedCount === 0) {
                        outcome = { httpStatus: 409, code: 'COMPLETION_CONFLICT', message: 'this request was updated concurrently' };
                        return;
                    }

                    // Phase 6.2 Unit 2 defense in depth: under the current
                    // one-active-assignment invariant this should never find
                    // anything (a technician can't be assigned a second
                    // active request while already holding one), but
                    // historical data drift or a direct/manual edit could
                    // still leave one. Freeing the technician anyway would
                    // let them be assigned yet another request while still
                    // actually holding this other one - so completion of
                    // *this* request still proceeds (there's a safer,
                    // narrower fix than blocking it), it just leaves the
                    // technician's workStatus untouched rather than
                    // incorrectly marking them available.
                    const otherActiveAssignment = await this.collections.parcels.findOne(
                        {
                            riderId: technician._id.toString(),
                            deliveryStatus: { $in: ACTIVE_STATUSES },
                            _id: { $ne: freshParcel._id }
                        },
                        { session: mongoSession }
                    );

                    const riderUpdateResult = await this.collections.riders.updateOne(
                        { _id: technician._id },
                        { $set: { workStatus: otherActiveAssignment ? technician.workStatus : 'available' } },
                        { session: mongoSession }
                    );
                    if (riderUpdateResult.matchedCount === 0) {
                        // The technician document vanished between the read
                        // above and this write - abort the whole transaction
                        // (including the parcel update above) rather than
                        // leave the request completed with no matching
                        // technician reset.
                        throw Object.assign(new Error('technician reset failed during completion'), { code: 'COMPLETION_FAILED' });
                    }

                    const trackingResult = await this.collections.trackings.insertOne(
                        {
                            trackingId: freshParcel.trackingId,
                            status: 'parcel_delivered',
                            details: 'parcel delivered',
                            createdAt: new Date()
                        },
                        { session: mongoSession }
                    );
                    if (!trackingResult.insertedId) {
                        throw Object.assign(new Error('completion tracking log failed'), { code: 'COMPLETION_FAILED' });
                    }

                    // Notification joins this same transaction - a failure
                    // here aborts the parcel completion, technician reset,
                    // and tracking log above exactly like any other guarded
                    // write in this transaction.
                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: freshParcel.senderEmail,
                        recipientRole: resolvedOwnerRole,
                        type: 'repair_completed',
                        entityType: 'parcel',
                        entityId: freshParcel._id.toString(),
                        actorEmail,
                        actorRole: resolvedActorRole,
                        metadata: { trackingId: freshParcel.trackingId }
                    });

                    outcome = { success: true };
                });
            } finally {
                await mongoSession.endSession();
            }

            if (outcome.idempotent) {
                return res.send({ message: 'repair already completed', deliveryStatus: 'parcel_delivered', alreadyCompleted: true });
            }
            if (outcome.success) {
                return res.send({ message: 'repair completed', deliveryStatus: 'parcel_delivered', matchedCount: 1, modifiedCount: 1, alreadyCompleted: false });
            }
            return res.status(outcome.httpStatus).send({ message: outcome.message, code: outcome.code });
        } catch (error) {
            console.error('Completion transaction aborted:', error.message);
            res.status(500).send({ message: 'Error completing repair request', code: 'COMPLETION_FAILED' });
        }
    }

    // Admin-only technician assignment. Request update, technician
    // workStatus update, and the assignment tracking log are one
    // transactionally consistent operation - all three commit together or
    // none do. Previously these were three independent writes; if
    // Rider.updateWorkStatus or the tracking insert failed after the parcel
    // update had already committed, the request ended up assigned with no
    // matching technician/tracking state and the caller saw a misleading
    // 500. Cheap validation (ObjectId shape, existence, approval) happens
    // before the transaction opens, purely to produce fast 400/404s - the
    // actual concurrency guarantee comes from the guarded updates inside the
    // transaction, never from these preliminary reads alone.
    async assignRiderToParcel(req, res) {
        try {
            const parcelId = req.params.id;
            const { riderId } = req.body;

            if (!ObjectId.isValid(parcelId)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }
            if (!riderId || !ObjectId.isValid(riderId)) {
                return res.status(400).send({ message: 'invalid technician id', code: 'INVALID_TECHNICIAN_ID' });
            }

            const parcel = await this.Parcel.findById(parcelId);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            const technician = await this.Rider.findById(riderId);
            if (!technician) {
                return res.status(404).send({ message: 'technician not found', code: 'TECHNICIAN_NOT_FOUND' });
            }
            if (technician.status !== 'approved') {
                return res.status(409).send({ message: 'technician is not approved', code: 'TECHNICIAN_NOT_APPROVED' });
            }

            // A request to (re-)assign a technician to a parcel they are
            // *already* the assigned technician for is not a new-assignment
            // scenario BL-004 is about - it's the pre-existing redundant-
            // reassignment case, which the transaction below already
            // rejects correctly (REQUEST_ALREADY_ASSIGNED, via the parcel no
            // longer being pending-pickup). Skipping the two checks below in
            // that one case preserves that existing, more specific reason
            // instead of masking it behind a workStatus check that's true
            // only because of this exact parcel.
            const isAlreadyThisTechnician = parcel.riderId === technician._id.toString();
            if (!isAlreadyThisTechnician) {
                if (technician.workStatus !== 'available') {
                    return res.status(409).send({ message: 'technician is not currently available', code: 'RIDER_UNAVAILABLE' });
                }
                // Defense in depth beyond workStatus (BL-004): a fast,
                // friendly pre-check for the case where historical data
                // drift left workStatus 'available' while some other
                // request still records this technician as its active
                // assignment. This is not the race-safety mechanism itself
                // (the guarded rider update inside the transaction below
                // is) - it only produces a faster, clearer rejection in the
                // common non-concurrent case.
                const existingActiveAssignment = await this.collections.parcels.findOne({
                    riderId: technician._id.toString(),
                    deliveryStatus: { $in: ACTIVE_STATUSES },
                    _id: { $ne: parcel._id }
                });
                if (existingActiveAssignment) {
                    return res.status(409).send({ message: 'technician already has an active assignment', code: 'RIDER_ALREADY_ASSIGNED' });
                }
            }

            const mongoSession = client.startSession();
            let conflict = false;
            let conflictCode = null;
            try {
                await mongoSession.withTransaction(async () => {
                    // The repair request's owner is resolved from the real
                    // users collection state inside this same transaction -
                    // never trusted from the parcel document itself or any
                    // request body value, and never defaulted. Resolved
                    // before any guarded write below, so a missing/invalid
                    // owner account aborts before anything is committed: no
                    // assignment, no technician workload change, no tracking
                    // write, no notification.
                    const resolvedOwnerRole = await this.User.findRoleByEmail(parcel.senderEmail, { session: mongoSession });
                    if (!resolvedOwnerRole) {
                        throw Object.assign(
                            new Error('repair request owner role could not be resolved'),
                            { code: 'REPAIR_OWNER_ROLE_UNRESOLVED' }
                        );
                    }

                    // Re-verifies the active-parcel defense above inside this
                    // transaction's own snapshot, immediately before any
                    // write - closes the window between the preliminary
                    // check and here. The actual concurrency guarantee
                    // against two *different* parcels racing for the *same*
                    // technician still comes from the guarded rider update
                    // below (workStatus: 'available' in its filter), not
                    // from this query - a plain read can't by itself
                    // prevent a race the way a conditional write can.
                    const activeAssignmentInTransaction = await this.collections.parcels.findOne(
                        {
                            riderId: technician._id.toString(),
                            deliveryStatus: { $in: ACTIVE_STATUSES },
                            _id: { $ne: parcel._id }
                        },
                        { session: mongoSession }
                    );
                    if (activeAssignmentInTransaction) {
                        conflict = true;
                        conflictCode = 'RIDER_ALREADY_ASSIGNED';
                        return;
                    }

                    // v2 hard-eligibility revalidation (Phase 6.3 Unit 6).
                    // Legacy requests (no schemaVersion or schemaVersion 1)
                    // never reach this block, so their assignment behavior
                    // is byte-for-byte unchanged. The Unit 5 recommendation
                    // endpoint is advisory only and is never trusted here -
                    // the service definition is re-read inside this same
                    // transaction (so a definition deactivated concurrently
                    // is never missed), and reuses
                    // services/technicianEligibilityService.js's own
                    // evaluateTechnician rather than re-deriving the rules.
                    // Service area is intentionally not part of this
                    // evaluation - it is ranking-only and must never block
                    // assignment. Skipped for the redundant
                    // reassign-to-same-technician case above so that its
                    // existing, more specific REQUEST_ALREADY_ASSIGNED
                    // outcome (via the parcel update guard below) is never
                    // masked by a new eligibility rejection.
                    let v2ExpertiseGuard = null;
                    if (!isAlreadyThisTechnician && isV2RepairRequest(parcel)) {
                        const requestTaxonomy = deriveRequestTaxonomy(parcel);
                        if (!requestTaxonomy.valid) {
                            throw Object.assign(new Error(requestTaxonomy.message), { code: requestTaxonomy.code, httpStatus: 409 });
                        }

                        const serviceDefinition = await this.ServiceDefinition.findById(requestTaxonomy.definitionId, { session: mongoSession });
                        const definitionValidation = validateCurrentServiceDefinition(serviceDefinition, requestTaxonomy);
                        if (!definitionValidation.valid) {
                            throw Object.assign(new Error(definitionValidation.message), { code: definitionValidation.code, httpStatus: 409 });
                        }

                        const riderRole = await this.User.findRoleByEmail(technician.email, { session: mongoSession });

                        // No other active assignment for this technician was
                        // already independently confirmed above - passing an
                        // empty set here just lets evaluateTechnician's own
                        // TECHNICIAN_ALREADY_ASSIGNED check be a no-op rather
                        // than re-querying the same fact a second time.
                        const evaluation = evaluateTechnician(technician, {
                            requestTaxonomy,
                            serviceDefinition,
                            activeRiderIds: new Set(),
                            riderRole
                        });

                        if (!evaluation.eligible) {
                            throw Object.assign(
                                new Error('technician does not meet current service requirements'),
                                { code: 'TECHNICIAN_NOT_ELIGIBLE', httpStatus: 409, reasonCodes: evaluation.reasonCodes }
                            );
                        }

                        // The exact expertise array just validated becomes
                        // part of the rider claim's own guard condition below
                        // (mirrors models/Rider.js#replaceExpertise's "guard
                        // on every field read, not just the field being
                        // changed" pattern) - closes the race where a
                        // concurrent expertise change lands between this
                        // evaluation and the write, which would otherwise let
                        // an assignment commit against expertise that was
                        // never actually validated. `technician` itself was
                        // captured once, before withTransaction's retry
                        // boundary (see Phase 6.3 Unit 3), so this value
                        // stays the exact snapshot that was just evaluated
                        // even if the transaction retries.
                        v2ExpertiseGuard = technician.expertise;
                    }

                    // Guarded atomically against a concurrent customer
                    // cancellation or a competing assignment - the query
                    // condition itself is the race-resolver, not a
                    // read-then-write check. Technician identity is always
                    // the server-validated document above, never trusted
                    // client-supplied name/email fields.
                    const parcelUpdateResult = await this.collections.parcels.updateOne(
                        {
                            _id: parcel._id,
                            $or: [
                                { deliveryStatus: { $exists: false } },
                                { deliveryStatus: 'pending-pickup' }
                            ]
                        },
                        {
                            $set: {
                                deliveryStatus: 'driver_assigned',
                                riderId: technician._id.toString(),
                                riderName: technician.name,
                                riderEmail: technician.email
                            }
                        },
                        { session: mongoSession }
                    );

                    if (parcelUpdateResult.matchedCount === 0) {
                        conflict = true;
                        return;
                    }

                    // Re-guards the technician's approval status AND
                    // availability atomically at write time, not just at the
                    // preliminary reads above (BL-004). This single
                    // conditional update is the actual concurrency guarantee
                    // against two different parcels racing for the same
                    // technician: MongoDB only lets one of two concurrent
                    // transactions match+modify this document while
                    // workStatus is still 'available', so a losing
                    // concurrent request always sees matchedCount 0 here.
                    const riderUpdateFilter = { _id: technician._id, status: 'approved', workStatus: 'available' };
                    if (v2ExpertiseGuard !== null) {
                        riderUpdateFilter.expertise = v2ExpertiseGuard;
                    }
                    const riderUpdateResult = await this.collections.riders.updateOne(
                        riderUpdateFilter,
                        { $set: { workStatus: 'in_delivery' } },
                        { session: mongoSession }
                    );

                    if (riderUpdateResult.matchedCount === 0) {
                        // The technician stopped being approved/available
                        // between the preliminary checks and this write -
                        // most commonly a genuine concurrent assignment to
                        // the same technician winning this race. Throwing
                        // (rather than just flagging and returning) is
                        // required here, not optional - the parcel update
                        // above already applied within this same
                        // transaction, and only a thrown error causes
                        // withTransaction to abort/roll it back too, rather
                        // than committing a parcel marked assigned to a
                        // technician whose own state was never actually
                        // claimed.
                        throw Object.assign(new Error('technician became unavailable during assignment'), { code: 'ASSIGNMENT_CONFLICT' });
                    }

                    await logTracking(this.collections.trackings, parcel.trackingId, 'driver_assigned', mongoSession);

                    // Both notifications join the same transaction - a
                    // failure creating either one aborts the parcel
                    // assignment, the technician workload update, and the
                    // tracking log above exactly like any other guarded
                    // write here. recipientRole for the customer copy is
                    // whatever the owner's real role actually is (user,
                    // rider, or admin), never hardcoded.
                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: parcel.senderEmail,
                        recipientRole: resolvedOwnerRole,
                        type: 'technician_assigned',
                        entityType: 'parcel',
                        entityId: parcelId,
                        actorEmail: req.decoded_email,
                        actorRole: 'admin',
                        metadata: { trackingId: parcel.trackingId }
                    });

                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: technician.email,
                        recipientRole: 'rider',
                        type: 'new_repair_assignment',
                        entityType: 'parcel',
                        entityId: parcelId,
                        actorEmail: req.decoded_email,
                        actorRole: 'admin',
                        metadata: { trackingId: parcel.trackingId }
                    });
                });
            } finally {
                await mongoSession.endSession();
            }

            if (conflict) {
                if (conflictCode === 'RIDER_ALREADY_ASSIGNED') {
                    return res.status(409).send({ message: 'technician already has an active assignment', code: 'RIDER_ALREADY_ASSIGNED' });
                }
                // Determine the transaction-bound current reason for an
                // accurate, controlled response.
                const latest = await this.Parcel.findById(parcelId);
                if (!latest) {
                    return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
                }
                if (latest.deliveryStatus === 'cancelled') {
                    return res.status(409).send({ message: 'this request has been cancelled', code: 'REQUEST_CANCELLED' });
                }
                if (latest.deliveryStatus && latest.deliveryStatus !== 'pending-pickup') {
                    return res.status(409).send({ message: 'this request has already been assigned', code: 'REQUEST_ALREADY_ASSIGNED' });
                }
                return res.status(409).send({ message: 'this request can no longer be assigned', code: 'ASSIGNMENT_NOT_ALLOWED' });
            }

            res.send({ acknowledged: true, matchedCount: 1, modifiedCount: 1, deliveryStatus: 'driver_assigned' });
        } catch (error) {
            if (error.code === 'REPAIR_OWNER_ROLE_UNRESOLVED') {
                console.error('Assignment transaction aborted: repair request owner role could not be resolved');
                return res.status(409).send({ message: 'repair request owner account could not be verified', code: 'REPAIR_OWNER_ROLE_UNRESOLVED' });
            }
            if (error.code === 'ASSIGNMENT_CONFLICT') {
                // Not a server failure - the technician's approval/
                // availability state changed between the preliminary checks
                // and the guarded write, almost always because a concurrent
                // assignment to the same technician committed first. The
                // transaction above has already rolled back the parcel
                // claim, so nothing partial is left behind.
                return res.status(409).send({ message: 'technician is no longer available for assignment', code: 'ASSIGNMENT_CONFLICT' });
            }
            if (error.httpStatus) {
                // v2 eligibility-revalidation rejections (Phase 6.3 Unit 6) -
                // structured the same way as every other controlled
                // rejection above, distinguished only by carrying an
                // explicit status so this one handler covers every
                // eligibility-derived code (REQUEST_TAXONOMY_INCOMPLETE,
                // SERVICE_DEFINITION_NOT_FOUND, SERVICE_NOT_ACTIVE,
                // REQUEST_SERVICE_MISMATCH, TECHNICIAN_NOT_ELIGIBLE) without
                // one branch per code.
                const body = { message: error.message, code: error.code };
                if (error.reasonCodes) {
                    body.reasonCodes = error.reasonCodes;
                }
                return res.status(error.httpStatus).send(body);
            }
            console.error('Assignment transaction aborted:', error.message);
            res.status(500).send({ message: 'Error assigning technician to repair request', code: 'ASSIGNMENT_FAILED' });
        }
    }

    async deleteParcel(req, res) {
        try {
            const id = req.params.id;
            const result = await this.Parcel.delete(id);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error deleting repair request', error: error.message });
        }
    }

    // Customer-initiated soft cancellation - the only cancellation path in
    // this unit. Ownership is enforced here (never delegated to a route
    // guard alone); eligibility is centralized in
    // services/cancellationPolicy.js. Never deletes the document, never
    // touches payment records, never issues a refund.
    async cancelParcel(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }

            const parcel = await this.Parcel.findById(id);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            const ownerEmail = normalize(parcel.senderEmail);
            const callerEmail = normalize(req.decoded_email);
            if (ownerEmail !== callerEmail) {
                return res.status(403).send({ message: 'forbidden access', code: 'NOT_REQUEST_OWNER' });
            }

            // A completed payment record is authoritative even if
            // parcel.paymentStatus is somehow inconsistent with it.
            const existingPayment = await this.collections.payments.findOne({ parcelId: id });
            const eligibility = getCancellationEligibility(parcel, { hasCompletedPayment: !!existingPayment });

            if (!eligibility.eligible) {
                if (eligibility.alreadyCancelled) {
                    return res.send({ message: 'Repair request is already cancelled.', status: 'cancelled', alreadyCancelled: true });
                }
                const statusByCode = {
                    REQUEST_ALREADY_ASSIGNED: 409,
                    REQUEST_ALREADY_PAID: 409,
                    INVALID_REQUEST_STATUS: 400
                };
                return res.status(statusByCode[eligibility.code] || 409).send({ message: eligibility.reason, code: eligibility.code });
            }

            // Atomic guarded update - the query condition itself is the real
            // race-resolver against a concurrent assignment or payment
            // completion, not the read-then-write eligibility check above.
            const updateResult = await this.collections.parcels.updateOne(
                {
                    _id: parcel._id,
                    $or: [
                        { deliveryStatus: { $exists: false } },
                        { deliveryStatus: 'pending-pickup' }
                    ],
                    riderEmail: { $exists: false },
                    paymentStatus: { $ne: 'paid' }
                },
                { $set: { deliveryStatus: 'cancelled' } }
            );

            if (updateResult.matchedCount === 0) {
                // Lost a race (assignment or payment committed between the
                // eligibility check above and this atomic update) - re-fetch
                // to report an accurate, current conflict.
                const latest = await this.Parcel.findById(id);
                if (latest && latest.deliveryStatus === 'cancelled') {
                    return res.send({ message: 'Repair request is already cancelled.', status: 'cancelled', alreadyCancelled: true });
                }
                return res.status(409).send({ message: 'this request can no longer be cancelled', code: 'CANCELLATION_NOT_ALLOWED' });
            }

            logTracking(this.collections.trackings, parcel.trackingId, 'cancelled');

            // Release any active checkout session for this parcel so an old
            // checkout URL can never be reused to reach a valid paid state.
            const cancelledRow = await this.checkoutSessions.cancelByParcelId(parcel._id.toString());
            if (cancelledRow && cancelledRow.sessionId) {
                try {
                    await stripe.checkout.sessions.expire(cancelledRow.sessionId);
                } catch (stripeError) {
                    // Best-effort only - our own checkoutSessions row and the
                    // parcel's cancelled status are already authoritative
                    // regardless of whether Stripe's own expiry call
                    // succeeds (e.g. the session may already be
                    // expired/completed on Stripe's side, which throws here
                    // too).
                    console.error('Stripe session expire failed (non-fatal):', stripeError.message);
                }
            }

            res.send({ message: 'Repair request cancelled successfully.', status: 'cancelled', alreadyCancelled: false });
        } catch (error) {
            res.status(500).send({ message: 'Error cancelling repair request' });
        }
    }
}

module.exports = ParcelController;

