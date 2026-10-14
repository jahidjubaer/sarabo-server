const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { createNotificationService } = require('../services/notificationService');
const { damageStorageService } = require('../services/damageStorageService');
const { createStripeRefunder } = require('../services/inspectionFeeRefunds');
const { sendWarrantyRefund } = require('../services/warrantyRefunds');
const { SETTLEMENT_REVERSED } = require('../utils/settlement');
const { isValidFileName, generateUploadSessionId } = require('../utils/damageUpload');
const {
    WARRANTY_DAYS, MAX_CLAIM_PHOTOS, STATUS, CLAIM_STATUSES, ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_SIZE_BYTES,
    warrantyWindow, reviewDeadline, isClaimOpen, claimEligibility,
    validateClaimInput, validateScheduleInput, validateDecisionInput, validateRerepairInput, validateConfirmInput, validateReviewDecision,
    refundPlan, generateClaimPhotoStorageKey,
} = require('../utils/warranty');

// Repair warranty and returns (policy and lifecycle: utils/warranty.js).
// Customers open a claim on a finished repair within 30 days of confirming
// they got the device back; the technician who did the repair re-inspects for
// free and decides; admins review disputed decisions and make refunds.
//
// Every write is a guarded update on the claim's current status, so two
// people acting at once can never both win, and nobody can skip a step.

const PHOTO_UPLOAD_TTL_MS = 20 * 60 * 1000;
const PHOTO_READ_URL_TTL_MS = 5 * 60 * 1000;
const LIST_LIMIT = 100;
const NEEDS_ADMIN = [STATUS.REVIEW_REQUESTED, STATUS.REFUND_PENDING];

function normalize(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function refuse(res, status, code, message) {
    return res.status(status).send({ message, code });
}

const ELIGIBILITY_MESSAGES = {
    WARRANTY_NOT_STARTED: 'the warranty starts when you confirm you received the repaired device',
    WARRANTY_EXPIRED: `the ${WARRANTY_DAYS}-day warranty for this repair has ended`,
    CLAIM_ALREADY_OPEN: 'this repair already has an open warranty claim',
    CLAIM_LIMIT_REACHED: 'this repair has reached the limit of warranty claims',
};

class WarrantyController {
    constructor(models, collections, { now = () => new Date(), mongoClient = client, storage = damageStorageService, refundPayment = null } = {}) {
        this.collections = collections;
        this.User = models.User;
        this.notifications = createNotificationService(models);
        this.now = now;
        this.mongoClient = mongoClient;
        this.storage = storage;
        this.refundPayment = refundPayment || ((args) => createStripeRefunder(require('stripe')(process.env.STRIPE_SECRET))(args));
    }

    async loadRequest(id) {
        if (!ObjectId.isValid(id)) return null;
        return this.collections.repairRequests.findOne({ _id: new ObjectId(id) });
    }

    async loadClaim(id) {
        if (!ObjectId.isValid(id)) return null;
        return this.collections.warrantyClaims.findOne({ _id: new ObjectId(id) });
    }

    claimsFor(requestId) {
        return this.collections.warrantyClaims.find({ requestId }).sort({ createdAt: 1 }).toArray();
    }

    // The claim's photos with short-lived read links (never the storage key).
    async photoViews(claim) {
        const views = [];
        for (const photo of claim.photos || []) {
            let url = null;
            try {
                url = await this.storage.createReadUrl({ storageKey: photo.storageKey, expiresInMs: PHOTO_READ_URL_TTL_MS });
            } catch {
                url = null;
            }
            views.push({ id: photo.uploadId, url, mimeType: photo.mimeType });
        }
        return views;
    }

    // What everyone involved may see. `audience` is customer | technician | admin.
    async claimView(claim, audience) {
        const now = this.now();
        const deadline = reviewDeadline(claim);
        return {
            id: claim._id.toString(),
            requestId: claim.requestId,
            trackingId: claim.trackingId,
            status: claim.status,
            open: isClaimOpen(claim, now),
            kind: claim.kind,
            description: claim.description,
            photos: await this.photoViews(claim),
            technicianName: claim.technicianName || 'Technician',
            createdAt: claim.createdAt,
            updatedAt: claim.updatedAt,
            inspection: claim.inspection || null,
            decision: claim.decision || null,
            canRequestReview: audience === 'customer' && claim.status === STATUS.NOT_COVERED && !!deadline && now <= deadline,
            reviewDeadline: claim.status === STATUS.NOT_COVERED ? deadline : null,
            review: claim.review || null,
            rerepair: claim.rerepair || null,
            confirmation: claim.confirmation || null,
            refund: claim.refund ? {
                total: claim.refund.total,
                currency: claim.refund.currency,
                refundedAt: claim.refund.refundedAt || null,
                ...(audience === 'admin' ? { parts: (claim.refund.parts || []).map((p) => ({ purpose: p.purpose, amount: p.amount, status: p.status || 'pending', lastError: p.lastError || null })) } : {}),
            } : null,
            ...(audience === 'admin' ? { customerEmail: claim.customerEmail, technicianEmail: claim.technicianEmail, history: claim.history || [] } : {}),
        };
    }

    async ownerRole(email) {
        return (await this.User.findRoleByEmail(email)) || 'user';
    }

    async notify(input) {
        try {
            await this.notifications.createNotification({ entityType: 'repair_request', actorEmail: null, ...input });
        } catch (error) {
            console.error(`Warranty notification ${input.type} failed (non-fatal):`, error.message);
        }
    }

    async notifyCustomer(claim, step, occurrence = claim._id.toString()) {
        await this.notify({
            recipientEmail: claim.customerEmail, recipientRole: await this.ownerRole(claim.customerEmail), type: 'warranty_update',
            entityId: claim.requestId, metadata: { trackingId: claim.trackingId, occurrence, step },
        });
    }

    async notifyTechnician(claim, step) {
        if (!claim.technicianEmail) return;
        await this.notify({
            recipientEmail: claim.technicianEmail, recipientRole: 'rider', type: 'warranty_update_technician',
            entityId: claim.requestId, metadata: { trackingId: claim.trackingId, occurrence: claim._id.toString(), step },
        });
    }

    async notifyAdmins(claim, step) {
        let admins = [];
        try {
            admins = await this.User.findEmailsByRole('admin');
        } catch (error) {
            console.error('Admin lookup for a warranty notification failed (non-fatal):', error.message);
        }
        await Promise.all(admins.map((email) => this.notify({
            recipientEmail: email, recipientRole: 'admin', type: 'warranty_admin_action',
            entityId: claim.requestId, metadata: { trackingId: claim.trackingId, occurrence: claim._id.toString(), step },
        })));
    }

    // Moves a claim from one of `from` to `to`, setting `set`, only if it is
    // still in that state (and passes `extraFilter`). Returns the updated claim
    // or null when someone else got there first.
    async advance(claim, { from, to, set = {}, by, extraFilter = {}, session }) {
        const now = this.now();
        const result = await this.collections.warrantyClaims.findOneAndUpdate(
            { _id: claim._id, status: { $in: from }, ...extraFilter },
            { $set: { ...set, status: to, updatedAt: now }, $push: { history: { status: to, at: now, by } } },
            { returnDocument: 'after', session }
        );
        return result || null;
    }

    // ---- Reads -------------------------------------------------------------

    // GET /repair-requests/:id/warranty  (owner, its technician, or an admin)
    async getForRequest(req, res) {
        try {
            const request = await this.loadRequest(req.params.id);
            const caller = normalize(req.decoded_email);
            const isOwner = request && normalize(request.senderEmail) === caller;
            const isTechnician = request && !isOwner && normalize(request.technicianEmail) === caller;
            const isAdmin = request && !isOwner && !isTechnician && (await this.User.findRoleByEmail(caller)) === 'admin';
            if (!request || (!isOwner && !isTechnician && !isAdmin)) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');

            const claims = await this.claimsFor(request._id.toString());
            const eligibility = claimEligibility(request, claims, this.now());
            const audience = isOwner ? 'customer' : isTechnician ? 'technician' : 'admin';
            res.set('Cache-Control', 'private, no-store');
            res.send({
                warranty: eligibility.window ? { days: WARRANTY_DAYS, startsAt: eligibility.window.startsAt, endsAt: eligibility.window.endsAt } : null,
                canClaim: isOwner && eligibility.ok,
                cannotClaimReason: eligibility.ok ? null : eligibility.code,
                maxPhotos: MAX_CLAIM_PHOTOS,
                claims: await Promise.all(claims.map((c) => this.claimView(c, audience))),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading the warranty', code: 'INTERNAL_ERROR' });
        }
    }

    // GET /technician/warranty-claims  (the caller's own claims)
    async listForTechnician(req, res) {
        try {
            const claims = await this.collections.warrantyClaims
                .find({ technicianEmail: normalize(req.decoded_email) }).sort({ updatedAt: -1 }).limit(LIST_LIMIT).toArray();
            res.send({ claims: await Promise.all(claims.map((c) => this.claimView(c, 'technician'))) });
        } catch (error) {
            res.status(500).send({ message: 'Error loading warranty claims', code: 'INTERNAL_ERROR' });
        }
    }

    // GET /admin/warranty-claims?status=needs_action|all|<status>
    async listForAdmin(req, res) {
        try {
            const wanted = typeof req.query?.status === 'string' ? req.query.status : 'needs_action';
            let filter;
            if (wanted === 'needs_action') filter = { status: { $in: NEEDS_ADMIN } };
            else if (wanted === 'all') filter = {};
            else if (CLAIM_STATUSES.includes(wanted)) filter = { status: wanted };
            else return refuse(res, 400, 'INVALID_STATUS', 'unknown status filter');
            const claims = await this.collections.warrantyClaims.find(filter).sort({ updatedAt: -1 }).limit(LIST_LIMIT).toArray();
            res.send({ claims: await Promise.all(claims.map((c) => this.claimView(c, 'admin'))) });
        } catch (error) {
            res.status(500).send({ message: 'Error loading warranty claims', code: 'INTERNAL_ERROR' });
        }
    }

    // ---- Customer ----------------------------------------------------------

    // The caller's own repair, open to a new claim now - or null after refusing.
    async ownClaimableRequest(req, res) {
        const request = await this.loadRequest(req.params.id);
        if (!request || normalize(request.senderEmail) !== normalize(req.decoded_email)) {
            refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            return null;
        }
        const claims = await this.claimsFor(request._id.toString());
        const eligibility = claimEligibility(request, claims, this.now());
        if (!eligibility.ok) {
            refuse(res, 409, eligibility.code, ELIGIBILITY_MESSAGES[eligibility.code]);
            return null;
        }
        return request;
    }

    // POST /repair-requests/:id/warranty/photos  { fileName, mimeType, size }
    // A signed upload link for one claim photo.
    async createPhotoUpload(req, res) {
        try {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            if (!isValidFileName(body.fileName)) return refuse(res, 400, 'INVALID_FILE_NAME', 'fileName is invalid');
            if (!ALLOWED_IMAGE_MIME_TYPES.includes(body.mimeType)) return refuse(res, 400, 'INVALID_PHOTO_TYPE', `photos must be ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`);
            if (!Number.isInteger(body.size) || body.size <= 0 || body.size > MAX_IMAGE_SIZE_BYTES) {
                return refuse(res, 400, 'INVALID_PHOTO_SIZE', `a photo must be at most ${MAX_IMAGE_SIZE_BYTES} bytes`);
            }
            const request = await this.ownClaimableRequest(req, res);
            if (!request) return;

            const requestId = request._id.toString();
            const uploadId = generateUploadSessionId();
            const storageKey = generateClaimPhotoStorageKey(requestId, body.mimeType, uploadId);
            const expiresAt = new Date(this.now().getTime() + PHOTO_UPLOAD_TTL_MS);
            let target;
            try {
                target = await this.storage.createUploadTarget({ storageKey, mimeType: body.mimeType, expiresAt });
            } catch {
                return refuse(res, 503, 'STORAGE_UNAVAILABLE', 'photo upload is not available right now - you can send the claim without photos');
            }
            await this.collections.warrantyPhotoUploads.insertOne({
                _id: uploadId, requestId, customerEmail: normalize(request.senderEmail), storageKey, mimeType: body.mimeType,
                status: 'pending', createdAt: this.now(), expiresAt,
            });
            res.status(201).send({
                photoId: uploadId,
                upload: { method: target.method, url: target.uploadUrl, headers: { 'Content-Type': body.mimeType }, expiresAt: expiresAt.toISOString() },
            });
        } catch (error) {
            res.status(500).send({ message: 'Error preparing the photo upload', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/warranty-claims  { kind, description, photoIds? }
    async openClaim(req, res) {
        try {
            const check = validateClaimInput(req.body);
            if (!check.valid) return refuse(res, 400, check.code, check.message);
            const request = await this.ownClaimableRequest(req, res);
            if (!request) return;
            const requestId = request._id.toString();
            const customerEmail = normalize(request.senderEmail);

            // Every photo must be this customer's upload for this repair, and
            // actually be in storage.
            const photos = [];
            for (const photoId of check.normalized.photoIds) {
                const upload = await this.collections.warrantyPhotoUploads.findOne({ _id: photoId, requestId, customerEmail, status: 'pending' });
                if (!upload) return refuse(res, 404, 'PHOTO_NOT_FOUND', 'a photo could not be found - please add it again');
                let object;
                try {
                    object = await this.storage.verifyObject({ storageKey: upload.storageKey });
                } catch {
                    return refuse(res, 503, 'STORAGE_UNAVAILABLE', 'photo storage is not available right now - you can send the claim without photos');
                }
                if (!object.exists || !ALLOWED_IMAGE_MIME_TYPES.includes(object.mimeType) || !(object.size > 0 && object.size <= MAX_IMAGE_SIZE_BYTES)) {
                    return refuse(res, 400, 'PHOTO_NOT_UPLOADED', 'a photo did not finish uploading - please add it again');
                }
                photos.push({ uploadId: photoId, storageKey: upload.storageKey, mimeType: object.mimeType, size: object.size });
            }

            const technician = request.technicianId && ObjectId.isValid(request.technicianId)
                ? await this.collections.technicians.findOne({ _id: new ObjectId(request.technicianId) }, { projection: { name: 1 } })
                : null;
            const now = this.now();
            const claim = {
                requestId,
                trackingId: request.trackingId,
                customerEmail,
                technicianId: request.technicianId || null,
                technicianEmail: normalize(request.technicianEmail) || null,
                technicianName: technician ? technician.name : null,
                kind: check.normalized.kind,
                description: check.normalized.description,
                photos,
                status: STATUS.SUBMITTED,
                createdAt: now,
                updatedAt: now,
                history: [{ status: STATUS.SUBMITTED, at: now, by: 'customer' }],
            };
            const { insertedId } = await this.collections.warrantyClaims.insertOne(claim);
            claim._id = insertedId;
            if (photos.length) {
                await this.collections.warrantyPhotoUploads.updateMany(
                    { _id: { $in: photos.map((p) => p.uploadId) } },
                    { $set: { status: 'attached', claimId: insertedId.toString() }, $unset: { expiresAt: '' } }
                );
            }
            // A second claim racing this one: keep the first, withdraw this one.
            const open = (await this.claimsFor(requestId)).filter((c) => isClaimOpen(c, now));
            if (open.length > 1 && open[0]._id.toString() !== insertedId.toString()) {
                await this.collections.warrantyClaims.deleteOne({ _id: insertedId });
                return refuse(res, 409, 'CLAIM_ALREADY_OPEN', ELIGIBILITY_MESSAGES.CLAIM_ALREADY_OPEN);
            }
            await this.notifyTechnician(claim, 'opened');
            res.status(201).send({ claim: await this.claimView(claim, 'customer') });
        } catch (error) {
            res.status(500).send({ message: 'Error opening the warranty claim', code: 'INTERNAL_ERROR' });
        }
    }

    // The caller's own claim (as its customer), or null after refusing.
    async ownClaim(req, res) {
        const claim = await this.loadClaim(req.params.claimId);
        if (!claim || claim.customerEmail !== normalize(req.decoded_email)) {
            refuse(res, 404, 'CLAIM_NOT_FOUND', 'warranty claim not found');
            return null;
        }
        return claim;
    }

    // POST /warranty-claims/:claimId/confirm  { fixed, note? }  (after a re-repair)
    async confirmFix(req, res) {
        try {
            const check = validateConfirmInput(req.body);
            if (!check.valid) return refuse(res, 400, check.code, check.message);
            const claim = await this.ownClaim(req, res);
            if (!claim) return;
            const { fixed, note } = check.normalized;
            const updated = await this.advance(claim, {
                from: [STATUS.FIXED_PENDING_CONFIRMATION],
                to: fixed ? STATUS.RESOLVED : STATUS.REFUND_PENDING,
                set: { confirmation: { fixed, note, at: this.now() } },
                by: 'customer',
            });
            if (!updated) return refuse(res, 409, 'CLAIM_NOT_AWAITING_CONFIRMATION', 'this claim is not waiting for your confirmation');
            await this.notifyTechnician(updated, fixed ? 'confirmed_fixed' : 'not_fixed');
            if (!fixed) await this.notifyAdmins(updated, 'refund_needed');
            res.send({ claim: await this.claimView(updated, 'customer') });
        } catch (error) {
            res.status(500).send({ message: 'Error saving your answer', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /warranty-claims/:claimId/review-request  { note? }  (within 7 days of "not covered")
    async requestReview(req, res) {
        try {
            const claim = await this.ownClaim(req, res);
            if (!claim) return;
            const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
            if (note.length > 500) return refuse(res, 400, 'INVALID_NOTE', 'the note must be at most 500 characters');
            const deadline = reviewDeadline(claim);
            if (claim.status === STATUS.NOT_COVERED && (!deadline || this.now() > deadline)) {
                return refuse(res, 409, 'REVIEW_WINDOW_CLOSED', 'the 7 days to ask for a review have passed');
            }
            const updated = await this.advance(claim, {
                from: [STATUS.NOT_COVERED],
                to: STATUS.REVIEW_REQUESTED,
                set: { review: { requestedAt: this.now(), customerNote: note } },
                by: 'customer',
            });
            if (!updated) return refuse(res, 409, 'CLAIM_NOT_REVIEWABLE', 'only a "not covered" decision can be reviewed');
            await this.notifyTechnician(updated, 'review_requested');
            await this.notifyAdmins(updated, 'review_requested');
            res.send({ claim: await this.claimView(updated, 'customer') });
        } catch (error) {
            res.status(500).send({ message: 'Error asking for a review', code: 'INTERNAL_ERROR' });
        }
    }

    // ---- Technician --------------------------------------------------------

    async technicianClaim(req, res) {
        const claim = await this.loadClaim(req.params.claimId);
        if (!claim || !claim.technicianEmail || claim.technicianEmail !== normalize(req.decoded_email)) {
            refuse(res, 404, 'CLAIM_NOT_FOUND', 'warranty claim not found');
            return null;
        }
        return claim;
    }

    // POST /warranty-claims/:claimId/schedule  { visitAt, note? }  - the free re-inspection.
    async schedule(req, res) {
        try {
            const check = validateScheduleInput(req.body, this.now());
            if (!check.valid) return refuse(res, 400, check.code, check.message);
            const claim = await this.technicianClaim(req, res);
            if (!claim) return;
            const updated = await this.advance(claim, {
                from: [STATUS.SUBMITTED, STATUS.INSPECTION_SCHEDULED],
                to: STATUS.INSPECTION_SCHEDULED,
                set: { inspection: { visitAt: check.normalized.visitAt, note: check.normalized.note, scheduledAt: this.now() } },
                by: 'technician',
            });
            if (!updated) return refuse(res, 409, 'CLAIM_ALREADY_INSPECTED', 'this claim has already been decided');
            // Rescheduling tells the customer again (a new occurrence per booking).
            const rebooked = claim.status === STATUS.INSPECTION_SCHEDULED;
            await this.notifyCustomer(updated, 'inspection_scheduled', rebooked ? `${updated._id}-${updated.history.length}` : undefined);
            res.send({ claim: await this.claimView(updated, 'technician') });
        } catch (error) {
            res.status(500).send({ message: 'Error booking the re-inspection', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /warranty-claims/:claimId/decision  { covered, reason?, note }  - after re-inspecting.
    async decide(req, res) {
        try {
            const check = validateDecisionInput(req.body);
            if (!check.valid) return refuse(res, 400, check.code, check.message);
            const claim = await this.technicianClaim(req, res);
            if (!claim) return;
            const { covered, reason, note } = check.normalized;
            const updated = await this.advance(claim, {
                from: [STATUS.INSPECTION_SCHEDULED],
                to: covered ? STATUS.COVERED : STATUS.NOT_COVERED,
                set: { decision: { covered, reason, note, decidedAt: this.now() } },
                by: 'technician',
            });
            if (!updated) {
                const code = claim.status === STATUS.SUBMITTED ? 'INSPECTION_NOT_BOOKED' : 'CLAIM_ALREADY_DECIDED';
                return refuse(res, 409, code, code === 'INSPECTION_NOT_BOOKED' ? 'book the re-inspection first' : 'this claim has already been decided');
            }
            await this.notifyCustomer(updated, covered ? 'covered' : 'not_covered');
            res.send({ claim: await this.claimView(updated, 'technician') });
        } catch (error) {
            res.status(500).send({ message: 'Error saving the decision', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /warranty-claims/:claimId/rerepair  { outcome: fixed | cannot_fix, note? }
    async reportRerepair(req, res) {
        try {
            const check = validateRerepairInput(req.body);
            if (!check.valid) return refuse(res, 400, check.code, check.message);
            const claim = await this.technicianClaim(req, res);
            if (!claim) return;
            const { outcome, note } = check.normalized;
            const updated = await this.advance(claim, {
                from: [STATUS.COVERED],
                to: outcome === 'fixed' ? STATUS.FIXED_PENDING_CONFIRMATION : STATUS.REFUND_PENDING,
                set: { rerepair: { outcome, note, reportedAt: this.now() } },
                by: 'technician',
            });
            if (!updated) return refuse(res, 409, 'CLAIM_NOT_COVERED', 'only a covered claim can be repaired again');
            await this.notifyCustomer(updated, outcome);
            if (outcome === 'cannot_fix') await this.notifyAdmins(updated, 'refund_needed');
            res.send({ claim: await this.claimView(updated, 'technician') });
        } catch (error) {
            res.status(500).send({ message: 'Error saving the repair result', code: 'INTERNAL_ERROR' });
        }
    }

    // ---- Admin -------------------------------------------------------------

    // POST /admin/warranty-claims/:claimId/review  { decision: uphold | overturn, note }
    async adminReview(req, res) {
        try {
            const check = validateReviewDecision(req.body);
            if (!check.valid) return refuse(res, 400, check.code, check.message);
            const claim = await this.loadClaim(req.params.claimId);
            if (!claim) return refuse(res, 404, 'CLAIM_NOT_FOUND', 'warranty claim not found');
            const { decision, note } = check.normalized;
            const updated = await this.advance(claim, {
                from: [STATUS.REVIEW_REQUESTED],
                to: decision === 'uphold' ? STATUS.REJECTED : STATUS.COVERED,
                set: { 'review.decision': decision, 'review.note': note, 'review.decidedAt': this.now(), 'review.decidedBy': normalize(req.decoded_email) },
                by: 'admin',
            });
            if (!updated) return refuse(res, 409, 'CLAIM_NOT_UNDER_REVIEW', 'this claim is not waiting for a review');
            const step = decision === 'uphold' ? 'review_upheld' : 'review_overturned';
            await this.notifyCustomer(updated, step);
            await this.notifyTechnician(updated, step);
            res.send({ claim: await this.claimView(updated, 'admin') });
        } catch (error) {
            res.status(500).send({ message: 'Error saving the review', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /admin/warranty-claims/:claimId/refund
    // Refunds the repair amount through Stripe and takes the technician's share
    // of that repair back from their wallet. Calling it again retries any part
    // that failed; nothing is ever refunded twice.
    async adminRefund(req, res) {
        try {
            let claim = await this.loadClaim(req.params.claimId);
            if (!claim) return refuse(res, 404, 'CLAIM_NOT_FOUND', 'warranty claim not found');
            if (claim.status === STATUS.REFUNDED) return refuse(res, 409, 'ALREADY_REFUNDED', 'this claim has already been refunded');
            if (claim.status !== STATUS.REFUND_PENDING) return refuse(res, 409, 'REFUND_NOT_DUE', 'this claim is not waiting for a refund');

            if (!claim.refund) {
                const request = await this.loadRequest(claim.requestId);
                if (!request) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
                const plan = refundPlan(request);
                const now = this.now();
                const admin = normalize(req.decoded_email);
                // One transaction: the claim records the plan and the
                // technician's settlement is reversed - both or neither.
                const session = this.mongoClient.startSession();
                let won = false;
                try {
                    await session.withTransaction(async () => {
                        won = false;
                        const result = await this.collections.warrantyClaims.updateOne(
                            { _id: claim._id, status: STATUS.REFUND_PENDING, refund: { $exists: false } },
                            { $set: { refund: { ...plan, parts: plan.parts.map((p) => ({ ...p, status: 'pending' })), approvedAt: now, approvedBy: admin }, updatedAt: now } },
                            { session }
                        );
                        if (result.matchedCount === 0) return;
                        await this.collections.repairRequests.updateOne(
                            { _id: request._id, technicianSettlement: { $exists: true }, 'technicianSettlement.status': { $ne: SETTLEMENT_REVERSED } },
                            { $set: { 'technicianSettlement.status': SETTLEMENT_REVERSED, 'technicianSettlement.reversedAt': now, 'technicianSettlement.reversalReason': 'warranty_refund', updatedAt: now } },
                            { session }
                        );
                        won = true;
                    });
                } finally {
                    await session.endSession();
                }
                claim = await this.loadClaim(req.params.claimId);
                if (!won && !claim.refund) return refuse(res, 409, 'REFUND_NOT_DUE', 'this claim is not waiting for a refund');
            }

            const result = await sendWarrantyRefund({ collections: this.collections, refundPayment: this.refundPayment, claim, now: this.now() });
            const after = await this.loadClaim(req.params.claimId);
            if (result.refunded) {
                await this.notifyCustomer(after, 'refunded');
                await this.notifyTechnician(after, 'refunded');
                return res.send({ refunded: true, claim: await this.claimView(after, 'admin') });
            }
            res.status(502).send({
                refunded: false, code: result.code || 'REFUND_FAILED',
                message: 'The refund could not be completed. Nothing was refunded twice - try again.',
                claim: await this.claimView(after, 'admin'),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error making the refund', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = WarrantyController;
