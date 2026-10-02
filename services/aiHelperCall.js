// Shared by the AI helpers (request draft, offer note, weekly summary): one
// error type the controllers turn into a response, and one way to call the
// provider with a server-owned timeout.
class AiHelperError extends Error {
    constructor(code, status, message) {
        super(message);
        this.name = 'AiHelperError';
        this.code = code;
        this.status = status;
    }
}

const DEFAULT_MESSAGES = Object.freeze({
    unavailable: 'The AI helper is not available right now.',
    timeout: 'The AI helper took too long. Please try again.',
    invalid: 'The AI helper could not answer that. Please try again.',
});

function helperErrors(messages = {}) {
    const text = { ...DEFAULT_MESSAGES, ...messages };
    return {
        unavailable: () => new AiHelperError('AI_HELPER_UNAVAILABLE', 503, text.unavailable),
        timedOut: () => new AiHelperError('AI_HELPER_TIMEOUT', 504, text.timeout),
        unusable: () => new AiHelperError('AI_HELPER_INVALID_RESPONSE', 502, text.invalid),
    };
}

// Runs `call(signal)` and rejects with AI_HELPER_TIMEOUT after `timeoutMs`,
// aborting the provider request. Provider errors become helper errors.
async function runAiCall({ timeoutMs, call, errors }) {
    const abortController = new AbortController();
    let timeoutId;
    const timeout = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
            // Reject first so an abort-aware SDK can't race in a generic error.
            reject(errors.timedOut());
            abortController.abort();
        }, timeoutMs);
    });
    try {
        return await Promise.race([Promise.resolve().then(() => call(abortController.signal)), timeout]);
    } catch (error) {
        if (error instanceof AiHelperError) throw error;
        if (error && error.code === 'PROVIDER_INVALID_RESPONSE') throw errors.unusable();
        if (error && error.code === 'PROVIDER_TIMEOUT') throw errors.timedOut();
        throw errors.unavailable();
    } finally {
        clearTimeout(timeoutId);
    }
}

module.exports = { AiHelperError, helperErrors, runAiCall };
