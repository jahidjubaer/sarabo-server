// Firebase Storage abstraction for damage-evidence uploads (Phase 6.4
// Unit 1). No request/controller-specific authorization lives here -
// controllers/damageUploadController.js owns ownership/state checks; this
// module only ever talks to Firebase Storage and normalizes its errors.
//
// Constructed with an optional injected `bucket` (any object exposing the
// minimal GCS Bucket surface this module actually uses: .file(name) ->
// { getSignedUrl, getMetadata, delete }) so tests can exercise the full
// contract with a fake adapter and never touch a real bucket. Production
// code uses the default export's real-bucket resolution.

const { createSupabaseBucket } = require('./supabaseBucketAdapter');

const STORAGE_PREFIX = 'repair-requests/';
const DEFAULT_READ_URL_TTL_MS = 15 * 60 * 1000;

function isNotFoundError(error) {
    return !!error && (error.code === 404 || error.code === 'STORAGE_OBJECT_NOT_FOUND');
}

// Never leaks a raw Firebase/GCS error (stack trace, bucket name, internal
// request id, credentials) to a caller - every failure this service can
// produce collapses to one of a small set of safe domain codes.
function normalizeStorageError(error) {
    if (error && error.code === 'STORAGE_UNAVAILABLE') return error;
    if (isNotFoundError(error)) {
        return Object.assign(new Error('storage object not found'), { code: 'STORAGE_OBJECT_NOT_FOUND' });
    }
    return Object.assign(new Error('damage image storage is unavailable'), { code: 'STORAGE_UNAVAILABLE' });
}

class DamageStorageService {
    constructor({ bucket } = {}) {
        this._injectedBucket = bucket || null;
    }

    // Lazily resolved (and never cached across calls) so a missing/changed
    // SUPABASE_* env var is detected on every call, not just once at process
    // startup.
    //
    // Phase 9.1: backed by Supabase Storage instead of Firebase Storage, which
    // is gated behind the paid Blaze plan. Only the backend moved - this
    // class's five public methods, their return shapes and their error codes
    // are unchanged, which is why nothing above this line and no caller needed
    // editing. Firebase is still the identity provider.
    _getBucket() {
        if (this._injectedBucket) return this._injectedBucket;
        const bucket = createSupabaseBucket();
        if (!bucket) {
            throw Object.assign(new Error('damage image storage is not configured'), { code: 'STORAGE_UNAVAILABLE' });
        }
        return bucket;
    }

    // Returns { uploadUrl, method } - a V4 signed URL the client can PUT the
    // exact declared content type to directly, never routing image bytes
    // through this server. The signed URL itself is the only authorization
    // material returned; no service-account credential ever leaves this
    // process.
    async createUploadTarget({ storageKey, mimeType, expiresAt }) {
        const bucket = this._getBucket();
        try {
            const [uploadUrl] = await bucket.file(storageKey).getSignedUrl({
                version: 'v4',
                action: 'write',
                expires: expiresAt,
                contentType: mimeType
            });
            return { uploadUrl, method: 'PUT' };
        } catch (error) {
            throw normalizeStorageError(error);
        }
    }

    // Synchronous, non-network canonical identifier - persisted as
    // damage.images[].url (see Phase I decision in the Unit 1 report). This
    // is a stable https:// GCS URI, NOT a working anonymous fetch link
    // (the object is never made publicly readable) - actual byte access
    // requires createReadUrl() above, generated fresh, on demand, by
    // whatever future endpoint serves authorized image display.
    buildCanonicalUrl({ storageKey }) {
        const bucket = this._getBucket();
        // Delegated when the backing adapter knows its own canonical form
        // (Supabase does). The literal GCS fallback remains for injected test
        // buckets, which model a plain object store and have no opinion about
        // their own public URL shape.
        if (typeof bucket.canonicalUrl === 'function') return bucket.canonicalUrl(storageKey);
        return `https://storage.googleapis.com/${bucket.name}/${storageKey}`;
    }

    // Reads trusted, server-verified object metadata - never trusts a
    // client-declared mimeType/size at finalization time. A missing object
    // is a legitimate outcome, not an error: { exists: false } lets the
    // caller decide what that means (STORAGE_OBJECT_NOT_FOUND).
    async verifyObject({ storageKey }) {
        const bucket = this._getBucket();
        try {
            const [metadata] = await bucket.file(storageKey).getMetadata();
            return {
                exists: true,
                mimeType: metadata.contentType || null,
                size: metadata.size !== undefined && metadata.size !== null ? Number(metadata.size) : null
            };
        } catch (error) {
            if (isNotFoundError(error)) return { exists: false, mimeType: null, size: null };
            throw normalizeStorageError(error);
        }
    }

    // Short-lived signed read URL, generated on demand - never persisted as
    // canonical truth (see Phase I decision in the Unit 1 report). Not
    // consumed by any endpoint in this unit; provided so a future
    // authorized-display endpoint has a ready primitive to call.
    async createReadUrl({ storageKey, expiresInMs = DEFAULT_READ_URL_TTL_MS }) {
        const bucket = this._getBucket();
        try {
            const [readUrl] = await bucket.file(storageKey).getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + expiresInMs
            });
            return readUrl;
        } catch (error) {
            throw normalizeStorageError(error);
        }
    }

    async deleteObject({ storageKey }) {
        const bucket = this._getBucket();
        try {
            await bucket.file(storageKey).delete();
            return { deleted: true };
        } catch (error) {
            if (isNotFoundError(error)) return { deleted: false, alreadyMissing: true };
            throw normalizeStorageError(error);
        }
    }
}

module.exports = {
    DamageStorageService,
    STORAGE_PREFIX,
    DEFAULT_READ_URL_TTL_MS,
    damageStorageService: new DamageStorageService()
};
