const { verifyFBToken } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');
const { createSupportRateLimit } = require('../middleware/supportRateLimit');
const { loadAiRequestHelperConfig } = require('../config/aiRequestHelper');

// The shared AI rate limiter keys signed-in callers by req.supportAuth.uid.
function markSignedIn(req, res, next) {
    req.supportAuth = Object.freeze({ authenticated: true, uid: String(req.decoded_email || '').toLowerCase() });
    next();
}

let defaultRateLimit;
function getDefaultRateLimit() {
    if (!defaultRateLimit) {
        defaultRateLimit = createSupportRateLimit(loadAiRequestHelperConfig(), { keyPrefix: 'request-helper', label: 'AI helper' });
    }
    return defaultRateLimit;
}

function aiRequestDraftRoutes(app, controllers, options = {}) {
    const controller = controllers.aiRequestDraft;
    const rateLimit = options.rateLimitMiddleware || ((req, res, next) => getDefaultRateLimit()(req, res, next));

    app.get('/ai/status', (req, res) => controller.status(req, res));
    app.post(
        '/ai/request-draft',
        verifyFBToken,
        ensureDatabaseReady,
        markSignedIn,
        rateLimit,
        (req, res) => controller.draft(req, res)
    );
}

module.exports = aiRequestDraftRoutes;
