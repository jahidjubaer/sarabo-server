const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// Vercel sets VERCEL for every deployment - production, preview, and `vercel
// dev` alike - but only VERCEL_ENV distinguishes which kind ('production',
// 'preview', or 'development'). NODE_ENV is NOT reliable on Vercel: Vercel
// sets NODE_ENV=production for preview builds too, so using it there would
// wrongly treat a preview deployment as production. Off Vercel (local dev, or
// a local "simulate production config" run), NODE_ENV is the only signal
// available and is used directly.
//
// Preview deployments are therefore deliberately NOT treated as production by
// this check - they fall through to the same origin rules as local
// development (see config/cors.js). There is no PREVIEW_ORIGIN (or
// equivalent) environment variable defined anywhere in this codebase today,
// so a preview deployment has no dedicated allowed client origin of its own
// unless one is introduced later; this is a documented gap, not a bug.
function isProductionEnvironment() {
    if (process.env.VERCEL) {
        return process.env.VERCEL_ENV === 'production';
    }
    return process.env.NODE_ENV === 'production';
}

// Single source of truth for what SITE_DOMAIN is allowed to be, reused by
// both the CORS production allowlist and Stripe checkout URL construction -
// see config/cors.js and controllers/paymentController.js. Throws a plain
// Error naming the variable and the unmet requirement, never the value
// itself.
function normalizeSiteOrigin(rawValue) {
    const trimmed = (rawValue ?? '').trim();
    if (!trimmed) {
        throw new Error('SITE_DOMAIN is required and must be an absolute origin URL (no path, query, or fragment).');
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error('SITE_DOMAIN must be a well-formed absolute URL.');
    }

    // An origin has no meaningful path of its own - "/" (the default empty
    // pathname the URL parser fills in) is the only acceptable pathname.
    const hasPath = parsed.pathname !== '/' && parsed.pathname !== '';
    if (hasPath || parsed.search || parsed.hash) {
        throw new Error('SITE_DOMAIN must be an origin only - no path, query string, or fragment.');
    }

    if (isProductionEnvironment()) {
        if (parsed.protocol !== 'https:') {
            throw new Error('SITE_DOMAIN must use https:// in production.');
        }
        if (LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
            throw new Error('SITE_DOMAIN must not be a loopback/localhost address in production.');
        }
    }

    return parsed.origin;
}

module.exports = { isProductionEnvironment, normalizeSiteOrigin, LOOPBACK_HOSTNAMES };
