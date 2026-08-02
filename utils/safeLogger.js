// Single source of truth for the error categories this app ever reports in
// logs - keeps every call site choosing from the same fixed vocabulary
// instead of inventing ad-hoc strings.
const ERROR_CATEGORIES = Object.freeze({
    AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
    FORBIDDEN: 'FORBIDDEN',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    RATE_LIMITED: 'RATE_LIMITED',
    DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
    WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
});

const SAFE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_LOGGED_PATH_LENGTH = 200;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function safeRequestId(value) {
    return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : null;
}

function safeMethod(value) {
    if (typeof value !== 'string') return null;
    const upper = value.toUpperCase();
    return SAFE_METHODS.has(upper) ? upper : null;
}

// Strips a query string/fragment from whatever was passed as `path`, as a
// second line of defense even though every current call site already passes
// a pathname-only value (see middleware/requestId.js's caller and
// getSafeLogPath below) - a future call site that accidentally passes
// req.originalUrl/req.url can never leak a query string through this
// function. Also length-capped so an unexpectedly long value can never
// balloon a log line.
function safePath(value) {
    if (typeof value !== 'string') return null;
    const withoutQueryOrFragment = value.split('?')[0].split('#')[0];
    return withoutQueryOrFragment.length > MAX_LOGGED_PATH_LENGTH
        ? withoutQueryOrFragment.slice(0, MAX_LOGGED_PATH_LENGTH)
        : withoutQueryOrFragment;
}

// Prefers the matched route's template (e.g. "/public/trackings/:trackingId")
// over the concrete request path whenever Express has already resolved one,
// so a dynamic segment (a tracking code, a parcel id) is never logged in
// place of its safe template. req.path and req.route.path are both
// pathname-only already (Express strips the query string before setting
// either) - this deliberately never touches req.originalUrl/req.url, which
// still carry the query string.
function getSafeLogPath(req) {
    if (!req) return null;
    if (req.route && typeof req.route.path === 'string') {
        const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
        return safePath(base + req.route.path);
    }
    if (typeof req.path === 'string') return safePath(req.path);
    return null;
}

function safeStatus(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeDurationMs(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Narrow, allow-list-only structured error log. Deliberately takes exactly
// these fields rather than a raw error/req object, so a caller can never
// accidentally pass through an Authorization header, cookie, token, raw
// webhook body, or full user/payment document - there is simply no
// parameter for any of that to travel through. Every field is independently
// re-validated here (not just trusted from the caller), so a future call
// site passing an unsanitized value still cannot make it into the log line
// unchanged. Never throws - every helper above returns null on anything it
// doesn't recognize, never throws.
function logSafeError({ requestId, method, path, status, category, durationMs }) {
    const entry = {
        timestamp: new Date().toISOString(),
        requestId: safeRequestId(requestId),
        method: safeMethod(method),
        path: safePath(path),
        status: safeStatus(status),
        category: ERROR_CATEGORIES[category] || ERROR_CATEGORIES.INTERNAL_ERROR,
        durationMs: safeDurationMs(durationMs),
        runtime: process.env.VERCEL ? 'serverless' : 'node',
    };
    console.error(JSON.stringify(entry));
}

module.exports = {
    ERROR_CATEGORIES,
    logSafeError,
    getSafeLogPath,
    safeRequestId,
    safeMethod,
    safePath,
    safeStatus,
    safeDurationMs,
};
