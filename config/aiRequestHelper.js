const { loadAiSupportConfig } = require('./aiSupport');

// The AI helpers (create-request draft, technician offer note, admin weekly
// summary) share the Gemini key and model with AI support, but each has its
// own on/off switch and its own daily budget, so one feature can never use up
// another's free quota.
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

// `prefix` names the env variables: `${prefix}_ENABLED`, `${prefix}_TIMEOUT_MS`,
// `${prefix}_USER_10M_LIMIT`, `${prefix}_USER_DAILY_LIMIT`,
// `${prefix}_GLOBAL_DAILY_LIMIT`.
function buildAiHelperConfig(env, prefix, overrides = {}) {
    const defaults = { ...DEFAULTS, ...overrides };
    const support = loadAiSupportConfig(env);
    const enabled = String(env[`${prefix}_ENABLED`] || '').trim().toLowerCase() === 'true';
    return Object.freeze({
        // Off unless switched on AND a Gemini key is configured.
        enabled: enabled && Boolean(support.apiKey),
        apiKey: support.apiKey,
        model: support.model,
        providerMaxAttempts: support.providerMaxAttempts,
        providerRetryBaseDelayMs: support.providerRetryBaseDelayMs,
        providerRetryMaxDelayMs: support.providerRetryMaxDelayMs,
        timeoutMs: readPositiveInteger(env[`${prefix}_TIMEOUT_MS`], defaults.timeoutMs, { min: 1000, max: 60000 }),
        maxOutputTokens: defaults.maxOutputTokens,
        textMaxChars: defaults.textMaxChars,
        // Shape expected by createSupportRateLimit. Only signed-in users can
        // call the helpers, so the anonymous limits are never used.
        shortWindowMs: support.shortWindowMs,
        dailyWindowMs: support.dailyWindowMs,
        anonymousShortWindowLimit: 1,
        anonymousDailyLimit: 1,
        authenticatedShortWindowLimit: readPositiveInteger(env[`${prefix}_USER_10M_LIMIT`], defaults.userShortWindowLimit),
        authenticatedDailyLimit: readPositiveInteger(env[`${prefix}_USER_DAILY_LIMIT`], defaults.userDailyLimit),
        authenticatedIpShortWindowLimit: defaults.ipShortWindowLimit,
        authenticatedIpDailyLimit: defaults.ipDailyLimit,
        globalDailyLimit: readPositiveInteger(env[`${prefix}_GLOBAL_DAILY_LIMIT`], defaults.globalDailyLimit),
    });
}

function loadAiRequestHelperConfig(env = process.env) {
    return buildAiHelperConfig(env, 'AI_REQUEST_HELPER');
}

// Technicians write offer notes: short output, a few per job.
function loadAiOfferHelperConfig(env = process.env) {
    return buildAiHelperConfig(env, 'AI_OFFER_HELPER', { maxOutputTokens: 400, timeoutMs: 15000, userDailyLimit: 40 });
}

// Admins write a report summary now and then: a longer answer, a few a day.
function loadAiReportSummaryConfig(env = process.env) {
    return buildAiHelperConfig(env, 'AI_REPORT_SUMMARY', {
        maxOutputTokens: 900, timeoutMs: 25000, userShortWindowLimit: 5, userDailyLimit: 20, globalDailyLimit: 50,
    });
}

module.exports = { DEFAULTS, buildAiHelperConfig, loadAiRequestHelperConfig, loadAiOfferHelperConfig, loadAiReportSummaryConfig };
