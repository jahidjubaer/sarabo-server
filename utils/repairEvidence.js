// Repair-completion evidence pure helpers (Phase 6.4 Unit 7). No MongoDB, no
// Firebase - orchestration lives in controllers/repairController.js, and the
// actual storage I/O reuses services/damageStorageService.js unchanged (it is
// generic over any storageKey). This deliberately mirrors utils/damageUpload.js
// but writes into a SEPARATE completion namespace: repair evidence is a
// technician-produced artifact, distinct from the customer's damage photos, and
// must never share a storage path or collection with them.

const crypto = require('crypto');
const {
    MIME_TO_EXTENSION, FILE_NAME_MAX_LENGTH, deriveSafeExtension, isValidFileName,
    generateUploadSessionId,
} = require('./damageUpload');
const { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_SIZE_BYTES } = require('./repairRequestV2');

// Same upload-session TTL and read-URL TTL as damage uploads - the security
// characteristics are identical (short-lived signed PUT, short-lived signed
// read), so there is no reason to diverge.
const EVIDENCE_UPLOAD_SESSION_TTL_MS = 20 * 60 * 1000;
const EVIDENCE_READ_URL_TTL_MS = 5 * 60 * 1000;

// Completion evidence bounds (Phase 6.4 Unit 7): at least one photo is required
// to complete a repair, at most three are kept.
const MIN_EVIDENCE_IMAGES = 1;
const MAX_EVIDENCE_IMAGES = 3;

// Server-owned, request-scoped, unpredictable storage key under the completion
// namespace. Same guarantees as generateStorageKey in utils/damageUpload.js -
// no client-controlled path segment, extension derived only from the validated
// MIME type - but a distinct `completion/` path so evidence can never collide
// with or be mistaken for a customer damage photo.
function generateEvidenceStorageKey(requestId, mimeType, uploadSessionId) {
    const extension = deriveSafeExtension(mimeType);
    if (!extension) return null;
    return `repair-requests/${requestId}/completion/${uploadSessionId}.${extension}`;
}

// A syntactically valid evidence image id is exactly the crypto.randomUUID()
// shape generateUploadSessionId produces - nothing else is ever accepted as an
// evidence reference at completion time, so a client cannot smuggle an
// arbitrary string, a MongoDB operator object, or a storageKey through the
// evidenceImageIds field.
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidEvidenceId(id) {
    return typeof id === 'string' && UUID_V4_PATTERN.test(id);
}

module.exports = {
    EVIDENCE_UPLOAD_SESSION_TTL_MS,
    EVIDENCE_READ_URL_TTL_MS,
    MIN_EVIDENCE_IMAGES,
    MAX_EVIDENCE_IMAGES,
    MIME_TO_EXTENSION,
    FILE_NAME_MAX_LENGTH,
    ALLOWED_IMAGE_MIME_TYPES,
    MAX_IMAGE_SIZE_BYTES,
    deriveSafeExtension,
    isValidFileName,
    generateUploadSessionId,
    generateEvidenceStorageKey,
    isValidEvidenceId,
};
