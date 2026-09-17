const rateLimit = require('express-rate-limit');
const { loadAiSupportConfig } = require('../config/aiSupport');
const { logSafeError, getSafeLogPath, ERROR_CATEGORIES } = require('../utils/safeLogger');

function retryAfterSeconds(req) {
    const resetTime = req.rateLimit && req.rateLimit.resetTime;
    if (!(resetTime instanceof Date)) return 1;
    return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
}

function createLimiter({ windowMs, limit, keyGenerator }) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: true,
        legacyHeaders: false,
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
                message: 'Too many support requests. Please try again later.',
                code: 'SUPPORT_RATE_LIMITED',
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

function createSupportRateLimit(config = loadAiSupportConfig()) {
    // express-rate-limit's default MemoryStore is intentionally process-local.
    // It is suitable for this development foundation only; multi-instance
    // production cost protection must replace it with a shared store.
    const anonymousShort = createLimiter({
        windowMs: config.shortWindowMs,
        limit: config.anonymousShortWindowLimit,
    });
    const anonymousDaily = createLimiter({
        windowMs: config.dailyWindowMs,
        limit: config.anonymousDailyLimit,
    });
    const authenticatedUserShort = createLimiter({
        windowMs: config.shortWindowMs,
        limit: config.authenticatedShortWindowLimit,
        keyGenerator: (req) => `user:${req.supportAuth.uid}`,
    });
    const authenticatedUserDaily = createLimiter({
        windowMs: config.dailyWindowMs,
        limit: config.authenticatedDailyLimit,
        keyGenerator: (req) => `user:${req.supportAuth.uid}`,
    });
    const authenticatedIpShort = createLimiter({
        windowMs: config.shortWindowMs,
        limit: config.authenticatedIpShortWindowLimit,
    });
    const authenticatedIpDaily = createLimiter({
        windowMs: config.dailyWindowMs,
        limit: config.authenticatedIpDailyLimit,
    });

    return function supportRateLimit(req, res, next) {
        if (req.supportAuth && req.supportAuth.authenticated === true) {
            return runMiddlewareChain(
                [authenticatedIpShort, authenticatedIpDaily, authenticatedUserShort, authenticatedUserDaily],
                req,
                res,
                next
            );
        }
        return runMiddlewareChain([anonymousShort, anonymousDaily], req, res, next);
    };
}

const supportRateLimit = createSupportRateLimit();

module.exports = { createSupportRateLimit, supportRateLimit };
