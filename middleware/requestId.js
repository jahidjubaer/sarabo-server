const crypto = require('crypto');

// Vercel's own request id format (e.g. "iad1::abc12-1700000000000-abcdef123456")
// only ever uses letters, digits, hyphen, underscore, colon, and period -
// this allowlist matches that shape without hardcoding Vercel's exact
// region-prefix format, so it also accepts any well-formed id a future
// Vercel format variation might use.
const MAX_REQUEST_ID_LENGTH = 128;
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

// x-vercel-id is untrusted input (edge network today, but never assume that
// won't change) - every rule below is enforced on the TRIMMED value, so
// incidental leading/trailing whitespace doesn't disqualify an otherwise
// well-formed id, while any INTERNAL whitespace or control character still
// fails the character allowlist below. `typeof value !== 'string'` rejects
// both a missing header and the array shape Node gives 'set-cookie'-style
// multi-value headers (this header isn't one of those - Node instead joins
// duplicates into one comma-separated string, which the same character
// allowlist also rejects, since ',' and ' ' are not in it). This function
// can never throw - every branch is a plain comparison, never a call that
// can fail.
function sanitizeIncomingRequestId(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_REQUEST_ID_LENGTH) return null;
    if (!SAFE_REQUEST_ID_PATTERN.test(trimmed)) return null;
    return trimmed;
}

// Attaches req.requestId / X-Request-Id before anything else, including the
// raw-body webhook route below - it only reads headers and sets a response
// header, so it cannot interfere with express.raw()'s exact-bytes capture.
// Never derived from anything identity-bearing (email, uid, token, IP,
// cookies, body) - it carries no meaning beyond "same value = same request".
function requestId(req, res, next) {
    const sanitized = sanitizeIncomingRequestId(req.headers['x-vercel-id']);
    const id = sanitized || crypto.randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
}

module.exports = { requestId, sanitizeIncomingRequestId, MAX_REQUEST_ID_LENGTH, SAFE_REQUEST_ID_PATTERN };
