// Local development origins that are always allowed, regardless of SITE_DOMAIN.
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function normalizeOrigin(origin) {
    return origin.replace(/\/+$/, '');
}

const allowedOrigins = new Set(DEV_ORIGINS);
if (process.env.SITE_DOMAIN) {
    allowedOrigins.add(normalizeOrigin(process.env.SITE_DOMAIN));
}

const corsOptions = {
    // Requests with no Origin header (curl, Postman, health checks,
    // server-to-server calls, local test scripts) are not browser requests
    // and are not subject to CORS, so they are always allowed here.
    origin(origin, callback) {
        if (!origin || allowedOrigins.has(normalizeOrigin(origin))) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
};

module.exports = { corsOptions };
