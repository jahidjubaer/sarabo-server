const { getSupabaseClient } = require('../config/supabase');

// Supabase Storage presented through the SAME minimal bucket surface
// damageStorageService has always consumed (Phase 9.1):
//
//     bucket.name
//     bucket.file(key).getSignedUrl(opts) -> [url]
//     bucket.file(key).getMetadata()      -> [metadata]
//     bucket.file(key).delete()
//
// Deliberately shaped this way rather than rewriting DamageStorageService
// around the Supabase SDK. That class, its five public methods, its error
// codes, and the three fake buckets the test suite injects all describe this
// surface already - so swapping the storage vendor becomes one new adapter
// instead of an edit that reaches into every caller and every test.
//
// The GCS-style two-element array returns ([url], [metadata]) are part of that
// existing contract, not an accident of this file.

const SIGNED_URL_PATH_PREFIX = '/storage/v1';

function notFoundError() {
    // code 404 is what damageStorageService#isNotFoundError already looks for.
    return Object.assign(new Error('storage object not found'), { code: 404 });
}

// Supabase reports a missing object inconsistently across endpoints (the REST
// layer answers HTTP 400 with a body statusCode of "404" for /object/info),
// so every plausible carrier is checked rather than trusting one field.
function isMissingObject(error) {
    if (!error) return false;
    if (error.statusCode === '404' || error.statusCode === 404) return true;
    if (error.status === 404) return true;
    return /not[\s_]?found|NoSuchKey/i.test(error.message || '');
}

function unavailableError(error) {
    return Object.assign(new Error('damage image storage is unavailable'), {
        code: 'STORAGE_UNAVAILABLE',
        cause: error,
    });
}

function createSupabaseBucket() {
    const client = getSupabaseClient();
    const bucketName = process.env.SUPABASE_STORAGE_BUCKET;
    if (!client || !bucketName) return null;

    const baseUrl = String(process.env.SUPABASE_URL).replace(/\/+$/, '');
    const storage = client.storage.from(bucketName);

    // NOTE: the SDK returns `signedUrl` already ABSOLUTE for both the upload
    // and download signing calls, and camelCases the metadata - unlike the raw
    // /storage/v1 REST endpoints, which return a relative `url`/`signedURL` and
    // snake_case fields. Verified against the live project; do not "fix" these
    // by prepending baseUrl or reading content_type.

    return {
        name: bucketName,

        // Canonical, stable identifier persisted as damage.images[].url. As
        // before, this is NOT an anonymously fetchable link - the bucket is
        // private, and real byte access always goes through a freshly signed
        // read URL.
        canonicalUrl(storageKey) {
            return `${baseUrl}${SIGNED_URL_PATH_PREFIX}/object/${bucketName}/${storageKey}`;
        },

        file(storageKey) {
            return {
                async getSignedUrl(options = {}) {
                    if (options.action === 'write') {
                        // Supabase binds the upload to the object path and a
                        // one-shot token, NOT to a Content-Type the way a GCS V4
                        // signature does. The declared mimeType therefore is not
                        // signed here - and does not need to be: the client still
                        // sends it (so the stored object gets the right type),
                        // and finalization re-reads the object's REAL server-side
                        // metadata and re-validates it against the allow-list, so
                        // a lying client is caught there exactly as before.
                        //
                        // options.expires is intentionally unused: this endpoint
                        // has a fixed token lifetime. Upload expiry is enforced
                        // by the upload-session record the controller persists,
                        // which is the authority finalization actually checks.
                        const { data, error } = await storage.createSignedUploadUrl(storageKey);
                        if (error || !data) throw unavailableError(error);
                        return [data.signedUrl];
                    }

                    // Read. GCS took an absolute expiry timestamp; Supabase takes
                    // a duration, so the caller's `expires` is converted rather
                    // than reinterpreted. Floored at 1s so a already-past expiry
                    // cannot become a negative (never-expiring) duration.
                    const expiresAtMs = options.expires ? new Date(options.expires).getTime() : Date.now();
                    const expiresInSeconds = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000));
                    const { data, error } = await storage.createSignedUrl(storageKey, expiresInSeconds);
                    if (error || !data) {
                        if (isMissingObject(error)) throw notFoundError();
                        throw unavailableError(error);
                    }
                    return [data.signedUrl];
                },

                // Trusted, server-side object metadata - never the client's
                // declared values. The SDK already reports contentType/size in
                // the same camelCase shape GCS used; content_type is accepted
                // only as a fallback because the underlying REST endpoint
                // answers in snake_case if this ever bypasses the SDK.
                async getMetadata() {
                    const { data, error } = await storage.info(storageKey);
                    if (error || !data) {
                        if (isMissingObject(error)) throw notFoundError();
                        throw unavailableError(error);
                    }
                    return [{
                        contentType: data.contentType || data.content_type || null,
                        size: data.size,
                    }];
                },

                async delete() {
                    const { data, error } = await storage.remove([storageKey]);
                    if (error) {
                        if (isMissingObject(error)) throw notFoundError();
                        throw unavailableError(error);
                    }
                    // remove() succeeds with an empty array when the key matched
                    // nothing. Surfaced as 404 so the caller's existing
                    // "already missing" branch handles it, instead of silently
                    // reporting a delete that never happened.
                    if (Array.isArray(data) && data.length === 0) throw notFoundError();
                    return [data];
                },
            };
        },
    };
}

module.exports = { createSupabaseBucket };
