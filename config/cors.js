const { isProductionEnvironment, normalizeSiteOrigin } = require('./siteOrigin');

// Local development origins - only ever allowed outside production. Never
// added to the allowlist when isProductionEnvironment() is true, so a real
// deployed production instance can only ever be reached (cross-origin) from
// the real client origin, never from a developer's local Vite server.
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function stripTrailingSlash(value) {
    return value.replace(/\/+$/, '');
}

function buildAllowedOrigins() {
    const production = isProductionEnvironment();
    const allowed = new Set(production ? [] : DEV_ORIGINS);

    if (process.env.SITE_DOMAIN) {
        // normalizeSiteOrigin() throws a clear config error (naming the
        // variable, never its value) if SITE_DOMAIN is malformed, or - in
        // production - not https/is a loopback address. Outside production,
        // the same structural checks apply (well-formed origin, no
        // path/query/fragment) so a typo is visible immediately rather than
        // silently producing a broken allowlist entry.
        allowed.add(normalizeSiteOrigin(process.env.SITE_DOMAIN));
    } else if (production) {
        throw new Error('SITE_DOMAIN is required in production for CORS to allow the real client origin.');
    }

    return allowed;
}

const allowedOrigins = buildAllowedOrigins();

const corsOptions = {
    // Requests with no Origin header (curl, Postman, health checks,
    // server-to-server calls, local test scripts) are not browser requests
    // and are not subject to CORS, so they are always allowed here -
    // unchanged by production/non-production status. The Stripe webhook
    // route is registered before this middleware in index.js and never
    // passes through here at all.
    origin(origin, callback) {
        if (!origin || allowedOrigins.has(stripTrailingSlash(origin))) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    // Never set to true: auth is an explicit Authorization header, never an
    // ambient browser-managed cookie, so there is nothing for
    // Access-Control-Allow-Credentials to protect here - and adding it would
    // be a real behavior change, not just hardening, so it's left exactly as
    // it was.
};

module.exports = { corsOptions };
