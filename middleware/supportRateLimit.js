const rateLimit = require('express-rate-limit');
const { loadAiSupportConfig } = require('../config/aiSupport');
const { logSafeError, getSafeLogPath, ERROR_CATEGORIES } = require('../utils/safeLogger');
const { MongoRateLimitStore } = require('./mongoRateLimitStore');

function retryAfterSeconds(req) {
    const resetTime = req.rateLimit && req.rateLimit.resetTime;
    if (!(resetTime instanceof Date)) return 1;
    return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
}

function createLimiter({ windowMs, limit, keyGenerator, store, code = 'SUPPORT_RATE_LIMITED', message = 'Too many support requests. Please try again later.' }) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
        // Fail closed: if the shared counter store cannot be reached, the
        // request is refused (see createSupportRateLimit), never let through
        // uncounted.
        passOnStoreError: false,
        ...(store ? { store } : {}),
        ...(keyGenerator ? { keyGenerator } : {}),
        handler: (req, res) => {
            const retryAfter = retryAfterSeconds(req);
            logSafeError({
                requestId: req.requestId,
                method: req.method,
                path: getSafeLogPath(req),
                status: 429,
                category: ERROR_CATEGORIES.RATE_LIMITED,
            });
            res.status(429).send({
                message,
                code,
                retryAfterSeconds: retryAfter,
            });
        },
    });
}

function runMiddlewareChain(middlewares, req, res, next) {
    let index = 0;
    function run(error) {
        if (error) return next(error);
        const middleware = middlewares[index];
        index += 1;
        return middleware ? middleware(req, res, run) : next();
    }
    return run();
}

// Limits are counted in MongoDB (MongoRateLimitStore), so they hold across
// every serverless instance. `keyPrefix` namespaces the counters (tests use a
// unique one per run); `storeFactory` can replace the store entirely.
//
// Order matters: per-client limits run first, the site-wide daily cap last,
// so a request refused for its own limit never spends the shared budget.
//
// If the counter store is unreachable, the request is refused with the same
// 503 SUPPORT_UNAVAILABLE the service returns when AI is off - never allowed
// through uncounted (the rest of the API is down in that case anyway).
function createSupportRateLimit(config = loadAiSupportConfig(), { keyPrefix = 'support', storeFactory } = {}) {
    const makeStore = storeFactory || ((name) => new MongoRateLimitStore({ prefix: `${keyPrefix}:${name}` }));
    const limiter = (name, options) => createLimiter({ ...options, store: makeStore(name) });

    const anonymousShort = limiter('anon-10m', {
        windowMs: config.shortWindowMs,
        limit: config.anonymousShortWindowLimit,
    });
    const anonymousDaily = limiter('anon-day', {
        windowMs: config.dailyWindowMs,
        limit: config.anonymousDailyLimit,
    });
    const authenticatedUserShort = limiter('user-10m', {
        windowMs: config.shortWindowMs,
        limit: config.authenticatedShortWindowLimit,
        keyGenerator: (req) => `user:${req.supportAuth.uid}`,
    });
    const authenticatedUserDaily = limiter('user-day', {
        windowMs: config.dailyWindowMs,
        limit: config.authenticatedDailyLimit,
        keyGenerator: (req) => `user:${req.supportAuth.uid}`,
    });
    const authenticatedIpShort = limiter('ip-10m', {
        windowMs: config.shortWindowMs,
        limit: config.authenticatedIpShortWindowLimit,
    });
    const authenticatedIpDaily = limiter('ip-day', {
        windowMs: config.dailyWindowMs,
        limit: config.authenticatedIpDailyLimit,
    });
    const globalDaily = limiter('global-day', {
        windowMs: config.dailyWindowMs,
        limit: config.globalDailyLimit,
        keyGenerator: () => 'all',
        code: 'SUPPORT_DAILY_CAPACITY_REACHED',
        message: 'AI support has reached its limit for today. Please try again tomorrow.',
    });

    return function supportRateLimit(req, res, next) {
        const failClosed = (error) => {
            if (!error) return next();
            logSafeError({
                requestId: req.requestId,
                method: req.method,
                path: getSafeLogPath(req),
                status: 503,
                category: ERROR_CATEGORIES.DATABASE_UNAVAILABLE,
            });
            return res.status(503).send({
                message: 'AI support is temporarily unavailable. Please try again later.',
                code: 'SUPPORT_UNAVAILABLE',
            });
        };
        if (req.supportAuth && req.supportAuth.authenticated === true) {
            return runMiddlewareChain(
                [authenticatedIpShort, authenticatedIpDaily, authenticatedUserShort, authenticatedUserDaily, globalDaily],
                req,
                res,
                failClosed
            );
        }
        return runMiddlewareChain([anonymousShort, anonymousDaily, globalDaily], req, res, failClosed);
    };
}

const supportRateLimit = createSupportRateLimit();

module.exports = { createSupportRateLimit, supportRateLimit };
