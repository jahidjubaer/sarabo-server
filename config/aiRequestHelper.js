const { loadAiSupportConfig } = require('./aiSupport');

// The "describe your problem" helper on the create-request form. It shares the
// Gemini key and model with AI support but has its own on/off switch and its
// own daily budget, so one feature can never use up the other's free quota.
const DEFAULTS = Object.freeze({
    enabled: false,
    timeoutMs: 20000,
    maxOutputTokens: 700,
    textMaxChars: 1500,
    userShortWindowLimit: 10,
    userDailyLimit: 30,
    ipShortWindowLimit: 30,
    ipDailyLimit: 100,
    globalDailyLimit: 200,
});

function readPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function loadAiRequestHelperConfig(env = process.env) {
    const support = loadAiSupportConfig(env);
    const enabled = String(env.AI_REQUEST_HELPER_ENABLED || '').trim().toLowerCase() === 'true';
    return Object.freeze({
        // Off unless switched on AND a Gemini key is configured.
        enabled: enabled && Boolean(support.apiKey),
        apiKey: support.apiKey,
        model: support.model,
        providerMaxAttempts: support.providerMaxAttempts,
        providerRetryBaseDelayMs: support.providerRetryBaseDelayMs,
        providerRetryMaxDelayMs: support.providerRetryMaxDelayMs,
        timeoutMs: readPositiveInteger(env.AI_REQUEST_HELPER_TIMEOUT_MS, DEFAULTS.timeoutMs, { min: 1000, max: 60000 }),
        maxOutputTokens: DEFAULTS.maxOutputTokens,
        textMaxChars: DEFAULTS.textMaxChars,
        // Shape expected by createSupportRateLimit. Only signed-in customers
        // can call the helper, so the anonymous limits are never used.
        shortWindowMs: support.shortWindowMs,
        dailyWindowMs: support.dailyWindowMs,
        anonymousShortWindowLimit: 1,
        anonymousDailyLimit: 1,
        authenticatedShortWindowLimit: readPositiveInteger(env.AI_REQUEST_HELPER_USER_10M_LIMIT, DEFAULTS.userShortWindowLimit),
        authenticatedDailyLimit: readPositiveInteger(env.AI_REQUEST_HELPER_USER_DAILY_LIMIT, DEFAULTS.userDailyLimit),
        authenticatedIpShortWindowLimit: DEFAULTS.ipShortWindowLimit,
        authenticatedIpDailyLimit: DEFAULTS.ipDailyLimit,
        globalDailyLimit: readPositiveInteger(env.AI_REQUEST_HELPER_GLOBAL_DAILY_LIMIT, DEFAULTS.globalDailyLimit),
    });
}

module.exports = { DEFAULTS, loadAiRequestHelperConfig };
