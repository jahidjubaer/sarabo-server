// Damage-upload pure helpers (Phase 6.4 Unit 1). No MongoDB, no Firebase -
// orchestration of those lives in controllers/damageUploadController.js /
// services/damageStorageService.js. Reuses the already-locked MIME/size
// constants from utils/repairRequestV2.js rather than redefining them.

const crypto = require('crypto');
const { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_SIZE_BYTES, MAX_DAMAGE_IMAGES } = require('./repairRequestV2');

// Fixed at the midpoint of the spec's 15-30 minute recommended range.
const UPLOAD_SESSION_TTL_MS = 20 * 60 * 1000;

// Only the three MIME types already allowed for a persisted damage image -
// SVG/GIF/HEIC/PDF/octet-stream are rejected simply by absence from this map.
const MIME_TO_EXTENSION = Object.freeze({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
});

const FILE_NAME_MAX_LENGTH = 255;

function deriveSafeExtension(mimeType) {
    return MIME_TO_EXTENSION[mimeType] || null;
}

// Informational only - never trusted as MIME authority, never persisted,
// never used to build the storage key. This only rejects malformed/hostile
// input (path traversal, null bytes, absurd length) so a careless or
// hostile client can't smuggle unexpected characters into logs or errors.
function isValidFileName(fileName) {
    if (typeof fileName !== 'string') return false;
    const trimmed = fileName.trim();
    if (trimmed.length === 0 || trimmed.length > FILE_NAME_MAX_LENGTH) return false;
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0') || trimmed.includes('..')) return false;
    return true;
}

// The unpredictable component of both the public uploadSessionId and the
// storage key - a real crypto-random UUID (crypto.randomUUID(), not a
// MongoDB ObjectId, which is time+counter based and not itself
// unpredictable). Used as the DamageUploadSession document's own _id, so
// there is exactly one identifier for "this upload session" everywhere:
// the public session token, the removal-endpoint imageId, and the
// unguessable segment of the storage path.
function generateUploadSessionId() {
    return crypto.randomUUID();
}

// Server-owned, request-scoped, unpredictable storage key. Never derives
// any part of the path from client input (filename, email, timestamp) -
// only from the server-validated request ID, the crypto-random session id,
// and the extension implied by the *validated* MIME type (never the
// client's claimed file extension). No user-controlled directory segment,
// no path traversal possible (requestId is a validated ObjectId string,
// uploadSessionId is a UUID, extension comes only from the fixed map
// above).
function generateStorageKey(requestId, mimeType, uploadSessionId) {
    const extension = deriveSafeExtension(mimeType);
    if (!extension) return null;
    return `repair-requests/${requestId}/damage/${uploadSessionId}.${extension}`;
}

// Mirrors services/cancellationPolicy.js's own "only the very first stage
// of the repair lifecycle" gate - once a technician is assigned (or the
// request has progressed past pending-pickup, or been cancelled),
// customer-submitted damage evidence must stay stable for quote/inspection
// to reference later, so no further upload/finalize/removal is allowed.
// Unlike cancellationPolicy this has no payment dimension - payment is
// unrelated to whether evidence may still be edited.
function isDamageEvidenceEditable(parcel) {
    const status = parcel.deliveryStatus || 'pending-pickup';
    if (status !== 'pending-pickup') return false;
    // Defensive: a technician reference should never exist while status is
    // still pending-pickup, but never trust deliveryStatus alone (mirrors
    // the same defensive riderEmail check in getCancellationEligibility).
    if (parcel.riderId || parcel.riderEmail) return false;
    return true;
}

module.exports = {
    UPLOAD_SESSION_TTL_MS,
    MIME_TO_EXTENSION,
    FILE_NAME_MAX_LENGTH,
    ALLOWED_IMAGE_MIME_TYPES,
    MAX_IMAGE_SIZE_BYTES,
    MAX_DAMAGE_IMAGES,
    deriveSafeExtension,
    isValidFileName,
    generateUploadSessionId,
    generateStorageKey,
    isDamageEvidenceEditable
};
