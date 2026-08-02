const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { collections } = require('./config/database');
const { corsOptions } = require('./config/cors');
const { initializeModels } = require('./models');
const { initializeControllers } = require('./controllers');
const { requestId } = require('./middleware/requestId');
const { logSafeError, getSafeLogPath, ERROR_CATEGORIES } = require('./utils/safeLogger');

// Import routes
const userRoutes = require('./routes/users');
const parcelRoutes = require('./routes/parcels');
const paymentRoutes = require('./routes/payments');
const { registerPaymentWebhookRoute } = require('./routes/paymentWebhook');
const riderRoutes = require('./routes/riders');
const trackingRoutes = require('./routes/trackings');
const publicTrackingRoutes = require('./routes/publicTracking');
const notificationRoutes = require('./routes/notifications');
const healthRoutes = require('./routes/healthRoutes');

const app = express();
// Vercel's edge network is the sole reverse proxy in front of this function,
// so trusting exactly one hop is correct here - it lets express-rate-limit
// (see routes/publicTracking.js) read the real client IP from Vercel's own
// X-Forwarded-For header instead of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR,
// without over-trusting an attacker-supplied proxy chain (`true` would trust
// every hop, including a spoofable leftmost entry).
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
// Vercel sets this in every deployed serverless invocation; it is unset for local `node index.js`.
const isServerless = !!process.env.VERCEL;

// Attaches req.requestId / X-Request-Id before anything else, including the
// raw-body webhook route below - it only reads headers and sets a response
// header, so it cannot interfere with express.raw()'s exact-bytes capture.
app.use(requestId);

// Collection handles (see config/database.js) are synchronous and
// side-effect-free - building models/controllers from them does not require
// an active MongoDB connection, so every route can register immediately.
const models = initializeModels(collections);
const controllers = initializeControllers(models, collections);

// The Stripe webhook route must be registered before express.json() below -
// it needs express.raw() to keep the exact request bytes for signature
// verification, and once express.json() has consumed the body stream for a
// request, no other middleware can recover the original bytes. Every other
// route continues to receive normally parsed JSON via the global middleware.
registerPaymentWebhookRoute(app, controllers);

// Middleware
app.use(express.json());
app.use(cors(corsOptions));
// Turns a rejected-origin CORS error into a controlled response instead of
// falling through to Express's default error handler.
app.use((err, req, res, next) => {
    if (err && err.message === 'Not allowed by CORS') {
        logSafeError({
            requestId: req.requestId,
            method: req.method,
            path: getSafeLogPath(req),
            status: 403,
            category: ERROR_CATEGORIES.FORBIDDEN,
        });
        return res.status(403).send({ message: 'Origin not allowed' });
    }
    next(err);
});

// Root endpoint - does not depend on the database, always available immediately
app.get('/', (req, res) => {
    res.send('zap is shifting shifting!')
});

// Register all remaining routes synchronously, at module load time. Route
// existence never depends on the database connection resolving. Each
// database-backed route applies the shared `ensureDatabaseReady` middleware
// (see middleware/database.js) after authentication, so a missing/invalid
// token still returns 401 without waiting on the database, and a real
// database outage returns 503 instead of the route appearing as an
// unregistered 404.
userRoutes(app, controllers);
parcelRoutes(app, controllers);
paymentRoutes(app, controllers);
riderRoutes(app, controllers);
trackingRoutes(app, controllers);
publicTrackingRoutes(app, controllers);
notificationRoutes(app, controllers);
healthRoutes(app, controllers);

// Start server (only for local/traditional hosting - Vercel invokes the
// exported app directly per request and does not use a listening port)
if (!isServerless) {
    app.listen(port, () => {
        console.log(`Server listening on port ${port}`)
    });
}

// Required for Vercel's @vercel/node builder (see vercel.json) to serve this
// app - it needs the file to export a request handler. Express apps are
// themselves valid (req, res) => {} handlers, so exporting `app` directly is
// sufficient.
module.exports = app;
