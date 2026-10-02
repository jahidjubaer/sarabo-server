const {
    SupportProviderError,
    classifyGeminiError,
    calculateRetryDelayMs,
    waitForRetry,
} = require('./geminiSupportProvider');
const { logSafeSupportProviderEvent } = require('../../utils/safeLogger');

// One Gemini call that must answer JSON, with at most one retry on a
// temporary failure (rate limit, 5xx, network). Shared by the AI helpers.
// Throws SupportProviderError with a PROVIDER_* code; never returns raw text.
async function callGeminiJson({
    client,
    model,
    request,
    signal,
    requestId,
    maxAttempts = 2,
    retryBaseDelayMs = 600,
    retryMaxDelayMs = 1000,
    diagnosticLogger = logSafeSupportProviderEvent,
    wait = waitForRetry,
    now = Date.now,
}) {
    const attemptLimit = Math.min(2, Math.max(1, maxAttempts));
    const overallStartedAt = now();
    const log = (attempt, outcome, failureClass, startedAt) => diagnosticLogger({
        requestId,
        provider: 'gemini',
        model,
        attempt,
        outcome,
        failureClass,
        durationMs: Math.max(0, now() - startedAt),
        totalDurationMs: Math.max(0, now() - overallStartedAt),
    });

    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
        const startedAt = now();
        let response;
        try {
            response = await client.models.generateContent({ ...request, model, config: { ...request.config, abortSignal: signal } });
        } catch (error) {
            const classification = classifyGeminiError(error, signal);
            const canRetry = classification.retryable && attempt < attemptLimit;
            log(attempt, canRetry ? 'retrying' : 'failed', classification.failureClass, startedAt);
            if (canRetry) {
                await wait(calculateRetryDelayMs({ baseDelayMs: retryBaseDelayMs, maxDelayMs: retryMaxDelayMs }), signal);
                continue;
            }
            throw new SupportProviderError(classification.code, 'The AI provider request failed.', {
                failureClass: classification.failureClass,
                attempts: attempt,
            });
        }
        try {
            const parsed = JSON.parse(response && response.text);
            log(attempt, 'succeeded', null, startedAt);
            return parsed;
        } catch {
            log(attempt, 'failed', 'invalid_response', startedAt);
            throw new SupportProviderError('PROVIDER_INVALID_RESPONSE', 'The AI provider returned an unusable response.');
        }
    }
    throw new SupportProviderError('PROVIDER_REQUEST_FAILED', 'The AI provider request failed.');
}

module.exports = { callGeminiJson };
