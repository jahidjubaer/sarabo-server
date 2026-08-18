const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { logTracking } = require('../middleware/logging');
const { createNotificationService } = require('../services/notificationService');
const { isV2RepairRequest } = require('../utils/repairRequestSchema');
const {
    PAYMENT_COMPLETED, REPAIR_IN_PROGRESS, REPAIR_COMPLETED, ACTIVE_STATUSES,
} = require('../utils/repairRequestStatus');
const {
    MAX_PROGRESS_UPDATES, buildInitialRepair, validateProgressInput, buildProgressUpdate,
    validateCompletionInput, buildRepairView,
} = require('../utils/repair');
const {
    EVIDENCE_UPLOAD_SESSION_TTL_MS, EVIDENCE_READ_URL_TTL_MS, ALLOWED_IMAGE_MIME_TYPES,
    MAX_IMAGE_SIZE_BYTES, MAX_EVIDENCE_IMAGES, isValidFileName, generateUploadSessionId,
    generateEvidenceStorageKey,
} = require('../utils/repairEvidence');
const { damageStorageService } = require('../services/damageStorageService');

const UPLOAD_SESSION_BODY_FIELDS = ['fileName', 'mimeType', 'size'];

// Repair progress + completion + technician release (Phase 6.4 Unit 7). Same
// security spine as the inspection/quote workflows: DB-authoritative identity,
// assignment/role/lifecycle re-validated atomically inside every write
// transaction (so a reassignment, role removal, status mutation, or competing
// write always loses via matchedCount 0), and existence-oracle-safe reads.
// Completion additionally reuses the damage-evidence storage service unchanged
// (services/damageStorageService.js is generic over any storageKey) via a
// SEPARATE completion namespace, and releases the technician exactly once, in
// the same transaction that marks the repair complete.
class RepairController {
    constructor(models, collections, storageService = damageStorageService) {
        this.RepairRequest = models.RepairRequest;
        this.User = models.User;
        this.RepairEvidenceSession = models.RepairEvidenceSession;
        this.collections = collections;
        this.storage = storageService;
        this.notifications = createNotificationService(models);
    }

    async resolveAccess(repairRequest, email) {
        const currentUser = await this.User.findByEmail(email);
        const role = currentUser ? currentUser.role : 'user';
        return {
            role,
            isOwner: !!repairRequest && repairRequest.senderEmail === email,
            isAdmin: role === 'admin',
            isAssignedByEmail: !!repairRequest && repairRequest.technicianEmail === email,
        };
    }

    statusForCode(code) {
        return {
            REQUEST_NOT_FOUND: 404,
            TECHNICIAN_ROLE_REQUIRED: 403,
            LEGACY_REQUEST_NOT_SUPPORTED: 400,
            REPAIR_NOT_PAYABLE_COMPLETE: 409,
            REPAIR_ALREADY_STARTED: 409,
            REPAIR_NOT_STARTED: 409,
            REPAIR_NOT_IN_PROGRESS: 409,
            REPAIR_ALREADY_COMPLETED: 409,
            PROGRESS_LIMIT_REACHED: 409,
            REQUEST_NOT_ASSIGNED_TO_TECHNICIAN: 409,
            INVALID_COMPLETION_EVIDENCE: 400,
            EVIDENCE_NOT_FOUND: 404,
            STORAGE_UNAVAILABLE: 503,
        }[code] || 409;
    }

    messageForCode(code) {
        return {
            REQUEST_NOT_FOUND: 'repair request not found',
            TECHNICIAN_ROLE_REQUIRED: 'only the assigned technician can perform this action',
            LEGACY_REQUEST_NOT_SUPPORTED: 'the repair workflow is only available for newer (v2) repair requests',
            REPAIR_NOT_PAYABLE_COMPLETE: 'the repair cannot start until payment is completed',
            REPAIR_ALREADY_STARTED: 'the repair has already been started',
            REPAIR_NOT_STARTED: 'the repair has not been started yet',
            REPAIR_NOT_IN_PROGRESS: 'the repair is not in progress',
            REPAIR_ALREADY_COMPLETED: 'the repair has already been completed',
            PROGRESS_LIMIT_REACHED: 'the maximum number of progress updates has been reached',
            REQUEST_NOT_ASSIGNED_TO_TECHNICIAN: 'this request is no longer assigned to you',
            INVALID_COMPLETION_EVIDENCE: 'the completion evidence is invalid',
            EVIDENCE_NOT_FOUND: 'the completion evidence could not be found',
            STORAGE_UNAVAILABLE: 'repair evidence storage is currently unavailable',
        }[code] || 'the repair request could not be completed';
    }

    // Shared entry guard for the technician-only write endpoints: valid id,
    // resolvable repair request, caller can see it (else existence-oracle 404), caller
    // is the currently-role-valid assigned technician (else 403), and the
    // request is v2 (else 400). Returns { repair request, email } or null (response
    // already sent).
    async _loadAssignedV2(req, res) {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
            res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            return null;
        }
        const email = req.decoded_email;
        const repairRequest = await this.RepairRequest.findById(id);
        const access = await this.resolveAccess(repairRequest, email);
        const canSee = repairRequest && (access.isOwner || access.isAdmin || access.isAssignedByEmail);
        if (!repairRequest || !canSee) {
            res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            return null;
        }
        if (!(access.role === 'rider' && access.isAssignedByEmail)) {
            res.status(403).send({ message: 'only the assigned technician can perform this action', code: 'TECHNICIAN_ROLE_REQUIRED' });
            return null;
        }
        if (!isV2RepairRequest(repairRequest)) {
            res.status(400).send({ message: 'the repair workflow is only available for newer (v2) repair requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            return null;
        }
        return { repairRequest, email };
    }

    async startRepair(req, res) {
        try {
            const loaded = await this._loadAssignedV2(req, res);
            if (!loaded) return;
            const { repairRequest, email } = loaded;

            // "Already started" is checked BEFORE the payment/status gate: once a
            // repair is in progress the deliveryStatus is no longer
            // payment_completed, so the payment gate would otherwise mask the
            // true (more precise) reason on a duplicate start.
            if (repairRequest.repair && repairRequest.repair.status && repairRequest.repair.status !== 'not_started') {
                return res.status(409).send({ message: this.messageForCode('REPAIR_ALREADY_STARTED'), code: 'REPAIR_ALREADY_STARTED' });
            }
            if (repairRequest.deliveryStatus !== PAYMENT_COMPLETED || !repairRequest.payment || repairRequest.payment.status !== 'completed' || !repairRequest.quote || repairRequest.quote.status !== 'approved') {
                return res.status(409).send({ message: this.messageForCode('REPAIR_NOT_PAYABLE_COMPLETE'), code: 'REPAIR_NOT_PAYABLE_COMPLETE' });
            }

            const mongoSession = client.startSession();
            let conflictCode = null;
            let repairDoc = null;
            try {
                await mongoSession.withTransaction(async () => {
                    conflictCode = null;
                    repairDoc = null;

                    const liveRole = await this.User.findRoleByEmail(email, { session: mongoSession });
                    if (liveRole !== 'rider') {
                        conflictCode = 'TECHNICIAN_ROLE_REQUIRED';
                        throw new Error('technician role changed during repair start');
                    }

                    const now = new Date();
                    repairDoc = buildInitialRepair(now);

                    const updateResult = await this.collections.repairRequests.updateOne(
                        {
                            _id: repairRequest._id,
                            schemaVersion: 2,
                            deliveryStatus: PAYMENT_COMPLETED,
                            technicianEmail: email,
                            technicianId: repairRequest.technicianId,
                            'payment.status': 'completed',
                            'quote.status': 'approved',
                            $or: [{ repair: { $exists: false } }, { 'repair.status': 'not_started' }],
                        },
                        { $set: { repair: repairDoc, deliveryStatus: REPAIR_IN_PROGRESS, updatedAt: now } },
                        { session: mongoSession }
                    );
                    if (updateResult.matchedCount === 0) {
                        const fresh = await this.collections.repairRequests.findOne({ _id: repairRequest._id }, { session: mongoSession });
                        if (!fresh) conflictCode = 'REQUEST_NOT_FOUND';
                        else if (fresh.repair && fresh.repair.status && fresh.repair.status !== 'not_started') conflictCode = 'REPAIR_ALREADY_STARTED';
                        else if (fresh.technicianEmail !== email || fresh.technicianId !== repairRequest.technicianId) conflictCode = 'REQUEST_NOT_ASSIGNED_TO_TECHNICIAN';
                        else conflictCode = 'REPAIR_NOT_PAYABLE_COMPLETE';
                        throw new Error('repair start guard failed');
                    }

                    await logTracking(this.collections.trackingEvents, repairRequest.trackingId, 'repair_started', mongoSession);
                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: repairRequest.senderEmail,
                        recipientRole: (await this.User.findRoleByEmail(repairRequest.senderEmail, { session: mongoSession })) || 'user',
                        type: 'repair_started',
                        entityType: 'repair_request',
                        entityId: repairRequest._id.toString(),
                        metadata: { trackingId: repairRequest.trackingId },
                        actorEmail: null,
                    });
                });
            } catch (txError) {
                if (!conflictCode) throw txError;
            } finally {
                await mongoSession.endSession();
            }

            if (conflictCode) {
                return res.status(this.statusForCode(conflictCode)).send({ message: this.messageForCode(conflictCode), code: conflictCode });
            }
            return res.status(201).send({ message: 'repair started', deliveryStatus: REPAIR_IN_PROGRESS, repair: buildRepairView(repairDoc) });
        } catch (error) {
            return res.status(500).send({ message: 'Error starting repair', code: 'INTERNAL_ERROR' });
        }
    }

    async addProgress(req, res) {
        try {
            const loaded = await this._loadAssignedV2(req, res);
            if (!loaded) return;
            const { repairRequest, email } = loaded;

            if (!repairRequest.repair || repairRequest.repair.status !== 'in_progress' || repairRequest.deliveryStatus !== REPAIR_IN_PROGRESS) {
                const code = repairRequest.repair && repairRequest.repair.status === 'completed' ? 'REPAIR_ALREADY_COMPLETED' : 'REPAIR_NOT_IN_PROGRESS';
                return res.status(409).send({ message: this.messageForCode(code), code });
            }

            const validation = validateProgressInput(req.body);
            if (!validation.valid) {
                return res.status(400).send({ message: validation.message, code: validation.code });
            }

            const mongoSession = client.startSession();
            let conflictCode = null;
            let update = null;
            try {
                await mongoSession.withTransaction(async () => {
                    conflictCode = null;
                    update = null;

                    const liveRole = await this.User.findRoleByEmail(email, { session: mongoSession });
                    if (liveRole !== 'rider') {
                        conflictCode = 'TECHNICIAN_ROLE_REQUIRED';
                        throw new Error('technician role changed during progress update');
                    }

                    const now = new Date();
                    update = buildProgressUpdate(validation.normalized, {
                        createdByTechnicianId: repairRequest.technicianId ? new ObjectId(repairRequest.technicianId) : null,
                        now,
                    });

                    // The $expr size guard is evaluated under the document write
                    // lock, so two concurrent appends serialize: both are pushed
                    // while under the limit (never overwriting each other), and
                    // the one that would exceed 50 matches nothing.
                    const updateResult = await this.collections.repairRequests.updateOne(
                        {
                            _id: repairRequest._id,
                            schemaVersion: 2,
                            deliveryStatus: REPAIR_IN_PROGRESS,
                            technicianEmail: email,
                            technicianId: repairRequest.technicianId,
                            'repair.status': 'in_progress',
                            $expr: { $lt: [{ $size: { $ifNull: ['$repair.progressUpdates', []] } }, MAX_PROGRESS_UPDATES] },
                        },
                        { $push: { 'repair.progressUpdates': update }, $set: { updatedAt: now } },
                        { session: mongoSession }
                    );
                    if (updateResult.matchedCount === 0) {
                        const fresh = await this.collections.repairRequests.findOne({ _id: repairRequest._id }, { session: mongoSession });
                        if (!fresh) conflictCode = 'REQUEST_NOT_FOUND';
                        else if (fresh.technicianEmail !== email || fresh.technicianId !== repairRequest.technicianId) conflictCode = 'REQUEST_NOT_ASSIGNED_TO_TECHNICIAN';
                        else if (!fresh.repair || fresh.repair.status !== 'in_progress') conflictCode = 'REPAIR_NOT_IN_PROGRESS';
                        else conflictCode = 'PROGRESS_LIMIT_REACHED';
                        throw new Error('progress update guard failed');
                    }

                    await logTracking(this.collections.trackingEvents, repairRequest.trackingId, 'repair_progress_updated', mongoSession);
                });
            } catch (txError) {
                if (!conflictCode) throw txError;
            } finally {
                await mongoSession.endSession();
            }

            if (conflictCode) {
                return res.status(this.statusForCode(conflictCode)).send({ message: this.messageForCode(conflictCode), code: conflictCode });
            }
            // Return the customer-safe shape of the appended update (no technician id).
            return res.status(201).send({ message: 'progress added', update: { id: update.id, message: update.message, createdAt: update.createdAt } });
        } catch (error) {
            return res.status(500).send({ message: 'Error adding progress update', code: 'INTERNAL_ERROR' });
        }
    }

    // Creates a signed PUT upload target for one completion evidence image.
    // Technician-only, tied to this request + assigned technician, only while the
    // repair is in progress. Reuses the damage-evidence storage service and MIME
    // /size validation unchanged, writing into the completion namespace.
    async createEvidenceUploadSession(req, res) {
        try {
            const loaded = await this._loadAssignedV2(req, res);
            if (!loaded) return;
            const { repairRequest, email } = loaded;

            if (!repairRequest.repair || repairRequest.repair.status !== 'in_progress' || repairRequest.deliveryStatus !== REPAIR_IN_PROGRESS) {
                const code = repairRequest.repair && repairRequest.repair.status === 'completed' ? 'REPAIR_ALREADY_COMPLETED' : 'REPAIR_NOT_IN_PROGRESS';
                return res.status(409).send({ message: this.messageForCode(code), code });
            }

            const body = req.body || {};
            const unexpected = Object.keys(body).find((k) => !UPLOAD_SESSION_BODY_FIELDS.includes(k));
            if (unexpected !== undefined) {
                return res.status(400).send({ message: `unexpected field: ${unexpected}`, code: 'INVALID_UPLOAD_REQUEST' });
            }
            const { fileName, mimeType, size } = body;
            if (!isValidFileName(fileName)) {
                return res.status(400).send({ message: 'fileName is invalid', code: 'INVALID_FILE_NAME' });
            }
            if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
                return res.status(400).send({ message: `mimeType must be one of: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`, code: 'INVALID_EVIDENCE_MIME' });
            }
            if (!Number.isInteger(size) || size <= 0 || size > MAX_IMAGE_SIZE_BYTES) {
                return res.status(400).send({ message: `size must be a positive integer of at most ${MAX_IMAGE_SIZE_BYTES} bytes`, code: 'INVALID_EVIDENCE_SIZE' });
            }

            const requestId = repairRequest._id.toString();
            const uploadSessionId = generateUploadSessionId();
            const storageKey = generateEvidenceStorageKey(requestId, mimeType, uploadSessionId);
            const expiresAt = new Date(Date.now() + EVIDENCE_UPLOAD_SESSION_TTL_MS);

            let uploadTarget;
            try {
                uploadTarget = await this.storage.createUploadTarget({ storageKey, mimeType, expiresAt });
            } catch (error) {
                return res.status(503).send({ message: this.messageForCode('STORAGE_UNAVAILABLE'), code: 'STORAGE_UNAVAILABLE' });
            }

            await this.RepairEvidenceSession.create({
                id: uploadSessionId,
                requestId: requestId,
                createdByTechnicianId: repairRequest.technicianId,
                technicianEmail: email,
                storageKey,
                mimeType,
                declaredSize: size,
                expiresAt,
            });

            return res.status(201).send({
                uploadSessionId,
                upload: {
                    method: uploadTarget.method,
                    url: uploadTarget.uploadUrl,
                    headers: { 'Content-Type': mimeType },
                    expiresAt: expiresAt.toISOString(),
                },
                constraints: { allowedMimeTypes: ALLOWED_IMAGE_MIME_TYPES, maxSizeBytes: MAX_IMAGE_SIZE_BYTES, maxImages: MAX_EVIDENCE_IMAGES },
            });
        } catch (error) {
            return res.status(500).send({ message: 'unable to create evidence upload session', code: 'EVIDENCE_SESSION_FAILED' });
        }
    }

    async completeRepair(req, res) {
        try {
            const loaded = await this._loadAssignedV2(req, res);
            if (!loaded) return;
            const { repairRequest, email } = loaded;

            if (!repairRequest.repair || repairRequest.repair.status !== 'in_progress' || repairRequest.deliveryStatus !== REPAIR_IN_PROGRESS) {
                const code = repairRequest.repair && repairRequest.repair.status === 'completed' ? 'REPAIR_ALREADY_COMPLETED' : 'REPAIR_NOT_IN_PROGRESS';
                return res.status(409).send({ message: this.messageForCode(code), code });
            }
            if (!repairRequest.technicianId || !ObjectId.isValid(repairRequest.technicianId)) {
                return res.status(409).send({ message: 'this request has no valid assigned technician', code: 'REQUEST_NOT_ASSIGNED' });
            }

            const validation = validateCompletionInput(req.body);
            if (!validation.valid) {
                return res.status(400).send({ message: validation.message, code: validation.code });
            }

            // Resolve + verify every evidence reference BEFORE opening the
            // transaction (mirrors damage finalize): each must be a pending
            // session for THIS request AND assigned technician, and its object must
            // actually exist in storage with a valid content type/size. A
            // foreign/missing/tampered reference is rejected here, and only safe
            // references (imageId + storageKey + verified mime/size) survive.
            const evidenceImages = [];
            const seenStorageKeys = new Set();
            for (const imageId of validation.normalized.evidenceImageIds) {
                const session = await this.RepairEvidenceSession.findById(imageId);
                if (!session || session.requestId !== repairRequest._id.toString() || session.createdByTechnicianId !== repairRequest.technicianId || session.status !== 'pending') {
                    return res.status(this.statusForCode('EVIDENCE_NOT_FOUND')).send({ message: this.messageForCode('EVIDENCE_NOT_FOUND'), code: 'EVIDENCE_NOT_FOUND' });
                }
                if (seenStorageKeys.has(session.storageKey)) {
                    return res.status(400).send({ message: this.messageForCode('INVALID_COMPLETION_EVIDENCE'), code: 'INVALID_COMPLETION_EVIDENCE' });
                }
                seenStorageKeys.add(session.storageKey);

                let objectMetadata;
                try {
                    objectMetadata = await this.storage.verifyObject({ storageKey: session.storageKey });
                } catch (error) {
                    return res.status(503).send({ message: this.messageForCode('STORAGE_UNAVAILABLE'), code: 'STORAGE_UNAVAILABLE' });
                }
                if (!objectMetadata.exists) {
                    return res.status(this.statusForCode('EVIDENCE_NOT_FOUND')).send({ message: this.messageForCode('EVIDENCE_NOT_FOUND'), code: 'EVIDENCE_NOT_FOUND' });
                }
                if (!ALLOWED_IMAGE_MIME_TYPES.includes(objectMetadata.mimeType) || !Number.isInteger(objectMetadata.size) || objectMetadata.size <= 0 || objectMetadata.size > MAX_IMAGE_SIZE_BYTES) {
                    return res.status(400).send({ message: this.messageForCode('INVALID_COMPLETION_EVIDENCE'), code: 'INVALID_COMPLETION_EVIDENCE' });
                }
                evidenceImages.push({ imageId, storageKey: session.storageKey, mimeType: objectMetadata.mimeType, size: objectMetadata.size });
            }

            const mongoSession = client.startSession();
            let conflictCode = null;
            let completion = null;
            try {
                await mongoSession.withTransaction(async () => {
                    conflictCode = null;
                    completion = null;

                    // Role-removal race: stale technician loses.
                    const liveRole = await this.User.findRoleByEmail(email, { session: mongoSession });
                    if (liveRole !== 'rider') {
                        conflictCode = 'TECHNICIAN_ROLE_REQUIRED';
                        throw new Error('technician role changed during completion');
                    }

                    const now = new Date();
                    const completionDoc = {
                        summary: validation.normalized.summary,
                        evidenceImages,
                        completedAt: now,
                    };

                    // RETIRED (Phase 9): the labour-only `technicianEarning`
                    // snapshot is no longer written here.
                    //
                    // It paid the technician the quote's laborAmount and nothing
                    // else, which meant two quotes charging the customer the same
                    // total paid the technician wildly different amounts purely on
                    // how the technician had split parts against labour. It is
                    // replaced by `technicianSettlement` - 90% of the whole
                    // customer-approved subtotal - written at PAYMENT
                    // confirmation instead of here (services/paymentProcessor.js),
                    // because money the customer has not paid yet should never
                    // appear in a technician's wallet.
                    //
                    // The field itself is deliberately NOT deleted from existing
                    // documents: historical records keep it, it is still read for
                    // display, and a repair whose legacy earning was already
                    // marked paid is permanently excluded from wallet balances so
                    // it can never be paid a second time (see
                    // utils/settlement.js's isLegacyAlreadyPaid).
                    const completionSet = {
                        deliveryStatus: REPAIR_COMPLETED,
                        'repair.status': 'completed',
                        'repair.completion': completionDoc,
                        customerReceiptConfirmation: { status: 'pending', confirmedAt: null, confirmedBy: null },
                        updatedAt: now,
                    };

                    // Guarded transition: still v2, still in progress, still
                    // this technician, repair still in_progress. Any concurrent
                    // completion / reassignment / status mutation makes this
                    // match zero - so the technician is released exactly once,
                    // by the single winner.
                    const repairRequestUpdate = await this.collections.repairRequests.updateOne(
                        {
                            _id: repairRequest._id,
                            schemaVersion: 2,
                            deliveryStatus: REPAIR_IN_PROGRESS,
                            technicianEmail: email,
                            technicianId: repairRequest.technicianId,
                            'repair.status': 'in_progress',
                        },
                        // customerReceiptConfirmation (Phase 8.9) is written here
                        // in the same guarded update (see completionSet above): a
                        // post-completion handover object initialized to 'pending'
                        // (NOT a deliveryStatus enum - that migration stays frozen,
                        // and it never gates technician release), set exactly once
                        // by the single winner. Confirming it later is also what
                        // releases the technician's settlement into their
                        // withdrawable balance (Phase 9).
                        { $set: completionSet },
                        { session: mongoSession }
                    );
                    if (repairRequestUpdate.matchedCount === 0) {
                        const fresh = await this.collections.repairRequests.findOne({ _id: repairRequest._id }, { session: mongoSession });
                        if (!fresh) conflictCode = 'REQUEST_NOT_FOUND';
                        else if (fresh.repair && fresh.repair.status === 'completed') conflictCode = 'REPAIR_ALREADY_COMPLETED';
                        else if (fresh.technicianEmail !== email || fresh.technicianId !== repairRequest.technicianId) conflictCode = 'REQUEST_NOT_ASSIGNED_TO_TECHNICIAN';
                        else conflictCode = 'REPAIR_NOT_IN_PROGRESS';
                        throw new Error('repair completion guard failed');
                    }

                    // Finalize every evidence session in the same transaction -
                    // guarded on request + technician so a stale/foreign session can
                    // never be flipped.
                    for (const ev of evidenceImages) {
                        await this.RepairEvidenceSession.markFinalized({
                            id: ev.imageId, requestId: repairRequest._id.toString(), createdByTechnicianId: repairRequest.technicianId, now, session: mongoSession,
                        });
                    }

                    // Technician release - exactly once, in this same
                    // transaction. Mirrors repairRequestController.completeRepairRequest: only
                    // set available if the technician holds no OTHER active
                    // assignment (defense in depth). Historical technicianId/technicianEmail
                    // are intentionally retained on the request for audit/history.
                    const technicianObjectId = new ObjectId(repairRequest.technicianId);
                    const technician = await this.collections.technicians.findOne({ _id: technicianObjectId }, { session: mongoSession });
                    if (!technician) {
                        throw Object.assign(new Error('assigned technician not found during completion'), { code: 'COMPLETION_FAILED' });
                    }
                    const otherActive = await this.collections.repairRequests.findOne(
                        { technicianId: repairRequest.technicianId, deliveryStatus: { $in: ACTIVE_STATUSES }, _id: { $ne: repairRequest._id } },
                        { session: mongoSession }
                    );
                    const technicianUpdate = await this.collections.technicians.updateOne(
                        { _id: technicianObjectId },
                        { $set: { workStatus: otherActive ? technician.workStatus : 'available' } },
                        { session: mongoSession }
                    );
                    if (technicianUpdate.matchedCount === 0) {
                        throw Object.assign(new Error('technician release failed during completion'), { code: 'COMPLETION_FAILED' });
                    }

                    await logTracking(this.collections.trackingEvents, repairRequest.trackingId, 'repair_completed', mongoSession);
                    await this.notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: repairRequest.senderEmail,
                        recipientRole: (await this.User.findRoleByEmail(repairRequest.senderEmail, { session: mongoSession })) || 'user',
                        type: 'repair_finished',
                        entityType: 'repair_request',
                        entityId: repairRequest._id.toString(),
                        metadata: { trackingId: repairRequest.trackingId },
                        actorEmail: null,
                    });

                    completion = completionDoc;
                });
            } catch (txError) {
                if (!conflictCode) throw txError;
            } finally {
                await mongoSession.endSession();
            }

            if (conflictCode) {
                return res.status(this.statusForCode(conflictCode)).send({ message: this.messageForCode(conflictCode), code: conflictCode });
            }
            return res.status(200).send({
                message: 'repair completed',
                deliveryStatus: REPAIR_COMPLETED,
                repair: buildRepairView({ status: 'completed', startedAt: repairRequest.repair.startedAt, progressUpdates: repairRequest.repair.progressUpdates, completion, version: repairRequest.repair.version }),
            });
        } catch (error) {
            return res.status(500).send({ message: 'Error completing repair', code: 'COMPLETION_FAILED' });
        }
    }

    // Owner / admin / assigned (or historical) technician read. Completion
    // evidence images are returned with short-lived signed read urls, generated
    // on demand - never the storageKey, upload-session id, technician id, or bucket.
    async getRepair(req, res) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }
            const email = req.decoded_email;
            const repairRequest = await this.RepairRequest.findById(id);
            const access = await this.resolveAccess(repairRequest, email);
            const canRead = repairRequest && (access.isOwner || access.isAdmin || access.isAssignedByEmail);
            if (!repairRequest || !canRead) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }
            if (!isV2RepairRequest(repairRequest)) {
                return res.status(400).send({ message: 'the repair workflow is only available for newer (v2) repair requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            }

            const view = buildRepairView(repairRequest.repair);

            // Attach signed read urls for completion evidence (memory-only,
            // short-lived). The raw persisted evidence carries storageKey; the
            // view above already dropped it, so re-derive urls from the stored
            // sub-document here.
            if (repairRequest.repair && repairRequest.repair.completion && Array.isArray(repairRequest.repair.completion.evidenceImages) && view.completion) {
                res.set('Cache-Control', 'private, no-store');
                const withUrls = [];
                for (const ev of repairRequest.repair.completion.evidenceImages) {
                    let readUrl = null;
                    try {
                        readUrl = await this.storage.createReadUrl({ storageKey: ev.storageKey, expiresInMs: EVIDENCE_READ_URL_TTL_MS });
                    } catch (error) {
                        readUrl = null;
                    }
                    withUrls.push({
                        imageId: ev.imageId,
                        url: readUrl,
                        mimeType: ev.mimeType,
                        size: ev.size,
                        readUrlExpiresAt: readUrl ? new Date(Date.now() + EVIDENCE_READ_URL_TTL_MS).toISOString() : null,
                    });
                }
                view.completion.evidenceImages = withUrls;
            }

            return res.send({ repair: view });
        } catch (error) {
            return res.status(500).send({ message: 'Error fetching repair', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = RepairController;
