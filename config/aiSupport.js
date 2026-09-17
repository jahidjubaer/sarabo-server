const DEFAULTS = Object.freeze({
    enabled: false,
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    apiKey: null,
    timeoutMs: 22000,
    providerMaxAttempts: 2,
    providerRetryBaseDelayMs: 600,
    providerRetryMaxDelayMs: 1000,
    maxOutputTokens: 400,
    messageMaxChars: 1500,
    historyMaxMessages: 8,
    historyMessageMaxChars: 1500,
    historyMaxChars: 6000,
    outputMaxChars: 4000,
    anonymousShortWindowLimit: 8,
    anonymousDailyLimit: 30,
    authenticatedShortWindowLimit: 20,
    authenticatedDailyLimit: 100,
    authenticatedIpShortWindowLimit: 60,
    authenticatedIpDailyLimit: 300,
});

const TEN_MINUTES_MS = 10 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function readBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).trim().toLowerCase() === 'true';
}

function readOptionalString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readPositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function loadAiSupportConfig(env = process.env) {
    return Object.freeze({
        enabled: readBoolean(env.AI_SUPPORT_ENABLED, DEFAULTS.enabled),
        provider: readOptionalString(env.AI_SUPPORT_PROVIDER) || DEFAULTS.provider,
        model: readOptionalString(env.AI_SUPPORT_MODEL) || DEFAULTS.model,
        apiKey: readOptionalString(env.GEMINI_API_KEY),
        timeoutMs: readPositiveInteger(env.AI_SUPPORT_TIMEOUT_MS, DEFAULTS.timeoutMs, { min: 100, max: 60000 }),
        providerMaxAttempts: readPositiveInteger(
            env.AI_SUPPORT_PROVIDER_MAX_ATTEMPTS,
            DEFAULTS.providerMaxAttempts,
            { min: 1, max: 2 }
        ),
        providerRetryBaseDelayMs: readPositiveInteger(
            env.AI_SUPPORT_RETRY_BASE_DELAY_MS,
            DEFAULTS.providerRetryBaseDelayMs,
            { min: 100, max: 2000 }
        ),
        providerRetryMaxDelayMs: readPositiveInteger(
            env.AI_SUPPORT_RETRY_MAX_DELAY_MS,
            DEFAULTS.providerRetryMaxDelayMs,
            { min: 100, max: 2000 }
        ),
        maxOutputTokens: readPositiveInteger(
            env.AI_SUPPORT_MAX_OUTPUT_TOKENS,
            DEFAULTS.maxOutputTokens,
            { min: 64, max: 1000 }
        ),
        messageMaxChars: readPositiveInteger(env.AI_SUPPORT_MESSAGE_MAX_CHARS, DEFAULTS.messageMaxChars, { max: 10000 }),
        historyMaxMessages: readPositiveInteger(env.AI_SUPPORT_HISTORY_MAX_MESSAGES, DEFAULTS.historyMaxMessages, { max: 20 }),
        historyMessageMaxChars: readPositiveInteger(env.AI_SUPPORT_HISTORY_MESSAGE_MAX_CHARS, DEFAULTS.historyMessageMaxChars, { max: 10000 }),
        historyMaxChars: readPositiveInteger(env.AI_SUPPORT_HISTORY_MAX_CHARS, DEFAULTS.historyMaxChars, { max: 50000 }),
        outputMaxChars: readPositiveInteger(env.AI_SUPPORT_OUTPUT_MAX_CHARS, DEFAULTS.outputMaxChars, { max: 20000 }),
        shortWindowMs: TEN_MINUTES_MS,
        dailyWindowMs: ONE_DAY_MS,
        anonymousShortWindowLimit: readPositiveInteger(env.AI_SUPPORT_ANON_10M_LIMIT, DEFAULTS.anonymousShortWindowLimit),
        anonymousDailyLimit: readPositiveInteger(env.AI_SUPPORT_ANON_DAILY_LIMIT, DEFAULTS.anonymousDailyLimit),
        authenticatedShortWindowLimit: readPositiveInteger(env.AI_SUPPORT_AUTH_10M_LIMIT, DEFAULTS.authenticatedShortWindowLimit),
        authenticatedDailyLimit: readPositiveInteger(env.AI_SUPPORT_AUTH_DAILY_LIMIT, DEFAULTS.authenticatedDailyLimit),
        authenticatedIpShortWindowLimit: readPositiveInteger(env.AI_SUPPORT_AUTH_IP_10M_LIMIT, DEFAULTS.authenticatedIpShortWindowLimit),
        authenticatedIpDailyLimit: readPositiveInteger(env.AI_SUPPORT_AUTH_IP_DAILY_LIMIT, DEFAULTS.authenticatedIpDailyLimit),
    });
}

module.exports = {
    DEFAULTS,
    TEN_MINUTES_MS,
    ONE_DAY_MS,
    loadAiSupportConfig,
};
