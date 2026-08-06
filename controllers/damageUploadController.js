// Damage upload orchestration (Phase 6.4 Unit 1). Firebase calls are never
// made directly here - only through the injected storageService (see
// services/damageStorageService.js). Constructed with an optional
// storageService override so tests can exercise the full contract against
// a fake storage adapter and never touch a real Firebase bucket; production
// wiring (controllers/index.js) uses the real default singleton.

const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { normalize } = require('../services/paymentProcessor');
const { isV2RepairRequest } = require('../utils/repairRequestSchema');
const {
    UPLOAD_SESSION_TTL_MS, READ_URL_TTL_MS, ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_SIZE_BYTES, MAX_DAMAGE_IMAGES,
    isValidFileName, generateUploadSessionId, generateStorageKey, isDamageEvidenceEditable
} = require('../utils/damageUpload');
const { damageStorageService } = require('../services/damageStorageService');
const { resolveImageAccess } = require('../services/damageImageAccessService');

const UPLOAD_SESSION_BODY_FIELDS = ['fileName', 'mimeType', 'size'];

class DamageUploadController {
    constructor(models, collections, storageService = damageStorageService) {
        this.Parcel = models.Parcel;
        this.DamageUploadSession = models.DamageUploadSession;
        this.User = models.User;
        this.Rider = models.Rider;
        this.models = models;
        this.collections = collections;
        this.storage = storageService;
    }

    // Shared entry guard for all three endpoints: validates the request id,
    // resolves the parcel, enforces ownership, and rejects legacy requests.
    // A non-owner and a genuinely missing request receive the identical
    // 404 REQUEST_NOT_FOUND response (Phase N existence-oracle policy) -
    // never a 403 that would confirm the request exists. Writes the
    // response and returns null when the caller should stop; returns the
    // parcel otherwise.
    async _loadOwnedV2Parcel(req, res, parcelId) {
        if (!ObjectId.isValid(parcelId)) {
            res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            return null;
        }
        const parcel = await this.Parcel.findById(parcelId);
        if (!parcel) {
            res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            return null;
        }
        const ownerEmail = normalize(parcel.senderEmail);
        const callerEmail = normalize(req.decoded_email);
        if (ownerEmail !== callerEmail) {
            res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            return null;
        }
        // Never inferred from field presence - schemaVersion is the single
        // source of truth (see utils/repairRequestSchema.js).
        if (!isV2RepairRequest(parcel)) {
            res.status(409).send({ message: 'damage image upload is only available for schemaVersion 2 requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            return null;
        }
        return parcel;
    }

    _sendStorageError(res, error) {
        if (error && error.code === 'STORAGE_OBJECT_NOT_FOUND') {
            return res.status(404).send({ message: 'storage object not found', code: 'STORAGE_OBJECT_NOT_FOUND' });
        }
        console.error('Damage storage error:', error && error.message);
        return res.status(503).send({ message: 'damage image storage is currently unavailable', code: 'STORAGE_UNAVAILABLE' });
    }

    _serializeImage(imageId, image) {
        return {
            imageId,
            mimeType: image.mimeType,
            size: image.size,
            width: image.width,
            height: image.height,
            uploadedAt: image.uploadedAt instanceof Date ? image.uploadedAt.toISOString() : image.uploadedAt
        };
    }

    async createUploadSession(req, res) {
        try {
            const parcelId = req.params.id;
            const parcel = await this._loadOwnedV2Parcel(req, res, parcelId);
            if (!parcel) return;

            if (!isDamageEvidenceEditable(parcel)) {
                return res.status(409).send({ message: 'damage evidence can no longer be modified for this request', code: 'DAMAGE_IMAGES_LOCKED' });
            }

            const currentCount = this.Parcel.countDamageImages(parcel);
            if (currentCount >= MAX_DAMAGE_IMAGES) {
                return res.status(409).send({ message: 'this request already has the maximum number of damage images', code: 'DAMAGE_IMAGE_LIMIT_REACHED' });
            }

            const body = req.body || {};
            const unexpectedField = Object.keys(body).find((key) => !UPLOAD_SESSION_BODY_FIELDS.includes(key));
            if (unexpectedField !== undefined) {
                return res.status(400).send({ message: `unexpected field: ${unexpectedField}`, code: 'INVALID_UPLOAD_REQUEST' });
            }

            const { fileName, mimeType, size } = body;
            // Informational only - never trusted as MIME authority, never
            // persisted (see utils/damageUpload.js#isValidFileName).
            if (!isValidFileName(fileName)) {
                return res.status(400).send({ message: 'fileName is invalid', code: 'INVALID_FILE_NAME' });
            }
            if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
                return res.status(400).send({ message: `mimeType must be one of: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}`, code: 'INVALID_DAMAGE_IMAGE_MIME' });
            }
            if (!Number.isInteger(size) || size <= 0 || size > MAX_IMAGE_SIZE_BYTES) {
                return res.status(400).send({ message: `size must be a positive integer of at most ${MAX_IMAGE_SIZE_BYTES} bytes`, code: 'INVALID_DAMAGE_IMAGE_SIZE' });
            }

            const uploadSessionId = generateUploadSessionId();
            const storageKey = generateStorageKey(parcelId, mimeType, uploadSessionId);
            const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS);

            let uploadTarget;
            try {
                uploadTarget = await this.storage.createUploadTarget({ storageKey, mimeType, expiresAt });
            } catch (error) {
                return this._sendStorageError(res, error);
            }

            // No Firebase object is created by the signed-URL generation
            // above (the client hasn't uploaded anything yet), so nothing
            // needs cleanup if this insert fails - the unused signed URL is
            // harmless.
            await this.DamageUploadSession.create({
                id: uploadSessionId,
                requestId: parcelId,
                ownerEmail: normalize(req.decoded_email),
                storageKey,
                mimeType,
                declaredSize: size,
                expiresAt
            });

            // Browser-usable contract (Phase 6.4 Unit 2, Phase L): the
            // client's PUT must send Content-Type: <mimeType> exactly - the
            // V4 signed URL was signed with that content type as part of
            // its signature, and GCS rejects a PUT whose actual
            // Content-Type header doesn't match what was signed.
            return res.status(201).send({
                uploadSessionId,
                upload: {
                    method: uploadTarget.method,
                    url: uploadTarget.uploadUrl,
                    headers: { 'Content-Type': mimeType },
                    expiresAt: expiresAt.toISOString()
                },
                constraints: {
                    allowedMimeTypes: ALLOWED_IMAGE_MIME_TYPES,
                    maxSizeBytes: MAX_IMAGE_SIZE_BYTES,
                    maxImages: MAX_DAMAGE_IMAGES
                }
            });
        } catch (error) {
            console.error('Damage upload session creation failed:', error.message);
            return res.status(500).send({ message: 'unable to create upload session', code: 'UPLOAD_SESSION_FAILED' });
        }
    }

    async finalizeUpload(req, res) {
        try {
            const parcelId = req.params.id;
            const parcel = await this._loadOwnedV2Parcel(req, res, parcelId);
            if (!parcel) return;

            const uploadSessionId = req.body && req.body.uploadSessionId;
            if (typeof uploadSessionId !== 'string' || uploadSessionId.trim().length === 0) {
                return res.status(400).send({ message: 'uploadSessionId is required', code: 'INVALID_UPLOAD_REQUEST' });
            }

            const uploadSession = await this.DamageUploadSession.findById(uploadSessionId);
            const callerEmail = normalize(req.decoded_email);
            // Wrong request, wrong owner, and genuinely missing all collapse
            // to the same controlled not-found response - a session created
            // for a different request/owner is never confirmed to exist.
            if (!uploadSession || uploadSession.requestId !== parcelId || uploadSession.ownerEmail !== callerEmail) {
                return res.status(404).send({ message: 'upload session not found', code: 'UPLOAD_SESSION_NOT_FOUND' });
            }

            if (uploadSession.status === 'finalized') {
                const existingImage = this.Parcel.findDamageImage(parcel, uploadSession.storageKey);
                if (existingImage) {
                    return res.status(200).send({ message: 'already finalized', image: this._serializeImage(uploadSession._id, existingImage) });
                }
                // Corrupted/unexpected state (finalized session, no
                // matching parcel entry) - fail safely rather than
                // silently succeed with fabricated data.
                return res.status(409).send({ message: 'upload session was already finalized', code: 'UPLOAD_SESSION_ALREADY_FINALIZED' });
            }
            if (uploadSession.status !== 'pending' && uploadSession.status !== 'uploaded') {
                return res.status(409).send({ message: 'upload session is no longer active', code: 'UPLOAD_SESSION_CONFLICT' });
            }

            const now = new Date();
            if (new Date(uploadSession.expiresAt).getTime() <= now.getTime()) {
                return res.status(409).send({ message: 'upload session has expired', code: 'UPLOAD_SESSION_EXPIRED' });
            }

            // Re-read fresh: the parcel's editable state may have changed
            // between session creation and this call (e.g. a technician was
            // assigned in the meantime).
            if (!isDamageEvidenceEditable(parcel)) {
                return res.status(409).send({ message: 'damage evidence can no longer be modified for this request', code: 'DAMAGE_IMAGES_LOCKED' });
            }

            // Actual object verification - never finalized based only on
            // client-declared metadata.
            let objectMetadata;
            try {
                objectMetadata = await this.storage.verifyObject({ storageKey: uploadSession.storageKey });
            } catch (error) {
                return this._sendStorageError(res, error);
            }
            if (!objectMetadata.exists) {
                return res.status(404).send({ message: 'uploaded object not found', code: 'STORAGE_OBJECT_NOT_FOUND' });
            }
            if (!ALLOWED_IMAGE_MIME_TYPES.includes(objectMetadata.mimeType)) {
                return res.status(409).send({ message: 'uploaded object has an unexpected content type', code: 'INVALID_DAMAGE_IMAGE_MIME' });
            }
            if (!Number.isInteger(objectMetadata.size) || objectMetadata.size <= 0 || objectMetadata.size > MAX_IMAGE_SIZE_BYTES) {
                return res.status(409).send({ message: 'uploaded object size is invalid', code: 'INVALID_DAMAGE_IMAGE_SIZE' });
            }

            const imageEntry = {
                url: this.storage.buildCanonicalUrl({ storageKey: uploadSession.storageKey }),
                storageKey: uploadSession.storageKey,
                mimeType: objectMetadata.mimeType,
                size: objectMetadata.size,
                width: null,
                height: null,
                uploadedAt: now,
                uploadedByRole: 'user'
            };

            const mongoSession = client.startSession();
            let outcome = null;
            try {
                await mongoSession.withTransaction(async () => {
                    const attachResult = await this.Parcel.attachDamageImage({
                        requestId: parcelId, storageKey: uploadSession.storageKey, image: imageEntry, session: mongoSession
                    });
                    if (attachResult.matchedCount === 0) {
                        const freshParcel = await this.collections.parcels.findOne({ _id: new ObjectId(parcelId) }, { session: mongoSession });
                        if (!freshParcel) {
                            outcome = { code: 'REQUEST_NOT_FOUND', httpStatus: 404 };
                            return;
                        }
                        const existing = this.Parcel.findDamageImage(freshParcel, uploadSession.storageKey);
                        outcome = existing
                            ? { code: 'DAMAGE_IMAGE_ALREADY_ATTACHED', httpStatus: 409 }
                            : { code: 'DAMAGE_IMAGE_LIMIT_REACHED', httpStatus: 409 };
                        return;
                    }

                    const finalizeResult = await this.DamageUploadSession.markFinalized({
                        id: uploadSession._id, requestId: parcelId, ownerEmail: callerEmail,
                        storageKey: uploadSession.storageKey, now, session: mongoSession
                    });
                    if (finalizeResult.matchedCount === 0) {
                        // Session state changed between the pre-transaction
                        // read and here (concurrent finalize, or it just
                        // expired) - abort so the parcel push above is
                        // rolled back too. Nothing partial survives.
                        throw Object.assign(new Error('upload session changed during finalization'), { code: 'UPLOAD_SESSION_CONFLICT', httpStatus: 409 });
                    }
                });
            } finally {
                await mongoSession.endSession();
            }

            if (outcome) {
                return res.status(outcome.httpStatus).send({ message: outcome.code, code: outcome.code });
            }

            return res.status(200).send({
                message: 'damage image attached',
                image: this._serializeImage(uploadSession._id, imageEntry)
            });
        } catch (error) {
            if (error && error.httpStatus) {
                return res.status(error.httpStatus).send({ message: error.code, code: error.code });
            }
            console.error('Damage upload finalize failed:', error.message);
            return res.status(500).send({ message: 'unable to finalize damage image upload', code: 'FINALIZE_FAILED' });
        }
    }

    async removeImage(req, res) {
        try {
            const parcelId = req.params.id;
            const parcel = await this._loadOwnedV2Parcel(req, res, parcelId);
            if (!parcel) return;

            const imageId = req.params.imageId;
            if (typeof imageId !== 'string' || imageId.trim().length === 0) {
                return res.status(404).send({ message: 'damage image not found', code: 'DAMAGE_IMAGE_NOT_FOUND' });
            }

            const uploadSession = await this.DamageUploadSession.findById(imageId);
            const callerEmail = normalize(req.decoded_email);
            if (!uploadSession || uploadSession.requestId !== parcelId || uploadSession.ownerEmail !== callerEmail || uploadSession.status !== 'finalized') {
                return res.status(404).send({ message: 'damage image not found', code: 'DAMAGE_IMAGE_NOT_FOUND' });
            }

            if (!isDamageEvidenceEditable(parcel)) {
                return res.status(409).send({ message: 'damage evidence can no longer be modified for this request', code: 'DAMAGE_IMAGES_LOCKED' });
            }

            const existingImage = this.Parcel.findDamageImage(parcel, uploadSession.storageKey);
            if (!existingImage) {
                // Already removed (repeated-removal retry) - safe, idempotent
                // success, not an error.
                return res.status(200).send({ message: 'damage image removed', removedImageId: imageId });
            }

            // Metadata removed first, atomically, then the object is
            // deleted (Phase L: never the reverse order, which risks a
            // "success" response while metadata still points at a deleted
            // object). If storage deletion fails below, the metadata is
            // already gone - there is no dangling pointer and nothing
            // misleading in the response; the orphaned Firebase object
            // becomes cleanup debt for scripts/audit-damage-uploads.js.
            const removeResult = await this.Parcel.removeDamageImage({ requestId: parcelId, storageKey: uploadSession.storageKey });
            if (removeResult.modifiedCount === 0) {
                // Raced with another removal of the same image - idempotent
                // success either way.
                return res.status(200).send({ message: 'damage image removed', removedImageId: imageId });
            }

            try {
                await this.storage.deleteObject({ storageKey: uploadSession.storageKey });
            } catch (error) {
                console.error('Damage image object deletion failed (metadata already removed; orphan cleanup debt recorded):', error.message);
            }

            return res.status(200).send({ message: 'damage image removed', removedImageId: imageId });
        } catch (error) {
            console.error('Damage image removal failed:', error.message);
            return res.status(500).send({ message: 'unable to remove damage image', code: 'REMOVAL_FAILED' });
        }
    }

    // Authorized read access (Phase 6.4 Unit 2). Unlike upload/finalize/
    // remove above (owner-only), this endpoint additionally admits an
    // admin or the currently-assigned technician - see
    // services/damageImageAccessService.js for the exact rule set. A
    // denied caller receives the identical REQUEST_NOT_FOUND response as a
    // genuinely missing request (existence-oracle safe).
    async listImages(req, res) {
        try {
            const parcelId = req.params.id;
            if (!ObjectId.isValid(parcelId)) {
                return res.status(400).send({ message: 'invalid repair request id', code: 'INVALID_REQUEST_ID' });
            }

            const parcel = await this.Parcel.findById(parcelId);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            const access = await resolveImageAccess({ parcel, callerEmail: req.decoded_email, models: this.models });
            if (!access.allowed) {
                return res.status(404).send({ message: 'repair request not found', code: 'REQUEST_NOT_FOUND' });
            }

            if (!isV2RepairRequest(parcel)) {
                return res.status(409).send({ message: 'damage image access is only available for schemaVersion 2 requests', code: 'LEGACY_REQUEST_NOT_SUPPORTED' });
            }

            // Authorization-bearing signed URLs below must never be cached
            // by a shared proxy or reused past their own short expiry.
            res.set('Cache-Control', 'private, no-store');

            const attachedImages = (parcel.damage && Array.isArray(parcel.damage.images)) ? parcel.damage.images : [];
            if (attachedImages.length === 0) {
                return res.status(200).send({
                    requestId: parcelId, accessRole: access.accessRole,
                    images: [], totalImages: 0, maxImages: MAX_DAMAGE_IMAGES
                });
            }

            // Persisted image metadata carries no explicit imageId - the
            // finalized upload session whose storageKey matches is the
            // join (see models/DamageUploadSession.js).
            const finalizedSessions = await this.DamageUploadSession.findFinalizedByRequestId(parcelId);
            const storageKeyToImageId = new Map(finalizedSessions.map((session) => [session.storageKey, session._id]));

            const sortableImages = attachedImages
                .map((image) => ({ image, imageId: storageKeyToImageId.get(image.storageKey) || null }))
                // Defensive only: under Unit 1's transactional attach
                // guarantee, every persisted image already has a matching
                // finalized session. An entry with no resolvable imageId
                // never occurs in normal operation and is dropped rather
                // than surfaced with a fabricated identifier.
                .filter((entry) => entry.imageId !== null);

            sortableImages.sort((a, b) => {
                const timeDiff = new Date(a.image.uploadedAt).getTime() - new Date(b.image.uploadedAt).getTime();
                if (timeDiff !== 0) return timeDiff;
                return a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0;
            });

            const images = [];
            const unavailableImages = [];
            for (const { image, imageId } of sortableImages) {
                let objectMetadata;
                try {
                    objectMetadata = await this.storage.verifyObject({ storageKey: image.storageKey });
                } catch (error) {
                    unavailableImages.push({ imageId, code: 'STORAGE_UNAVAILABLE' });
                    continue;
                }
                if (!objectMetadata.exists) {
                    unavailableImages.push({ imageId, code: 'STORAGE_OBJECT_NOT_FOUND' });
                    continue;
                }

                let readUrl;
                try {
                    readUrl = await this.storage.createReadUrl({ storageKey: image.storageKey, expiresInMs: READ_URL_TTL_MS });
                } catch (error) {
                    unavailableImages.push({ imageId, code: 'STORAGE_UNAVAILABLE' });
                    continue;
                }

                images.push({
                    imageId,
                    mimeType: image.mimeType,
                    size: image.size,
                    width: image.width,
                    height: image.height,
                    uploadedAt: image.uploadedAt instanceof Date ? image.uploadedAt.toISOString() : image.uploadedAt,
                    readUrl,
                    readUrlExpiresAt: new Date(Date.now() + READ_URL_TTL_MS).toISOString()
                });
            }

            const responseBody = {
                requestId: parcelId,
                accessRole: access.accessRole,
                images,
                totalImages: sortableImages.length,
                maxImages: MAX_DAMAGE_IMAGES
            };

            if (unavailableImages.length > 0) {
                // Admin receives enough detail to actually investigate;
                // owner/technician receive only a safe count - never
                // storageKey, never a raw Firebase/GCS error.
                if (access.accessRole === 'admin') {
                    responseBody.unavailableImages = unavailableImages;
                } else {
                    responseBody.unavailableCount = unavailableImages.length;
                }
            }

            return res.status(200).send(responseBody);
        } catch (error) {
            console.error('Damage image list failed:', error.message);
            return res.status(500).send({ message: 'unable to list damage images', code: 'LIST_FAILED' });
        }
    }
}

module.exports = DamageUploadController;
