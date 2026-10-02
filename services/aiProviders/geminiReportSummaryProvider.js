const { createGeminiClient } = require('./geminiSupportProvider');
const { callGeminiJson } = require('./geminiJsonCall');

// Writes the admin Reports summary from the report's numbers. The service
// drops any sentence with a number that isn't in the facts.
const REPORT_SUMMARY_INSTRUCTIONS = Object.freeze([
    'You write a short business summary for the admin of Sarabo, a device repair service in Bangladesh. Customers request repairs; local technicians in each region send offers and do the work.',
    'You get the facts of one reporting period as JSON, with the period before for comparison. Use ONLY these facts. Never invent a number, a cause, a person or a place. Copy numbers exactly as given; you may say how much something went up or down between the two periods.',
    'headline: one sentence, the single most important thing about this period.',
    'highlights: 2 to 4 short sentences about what happened (demand, repairs finished, cancellations, where requests wait or are turned away, money from inspection fees). Skip anything that is zero or empty.',
    'actions: 1 to 3 concrete things the admin should do next, each tied to a fact - for example recruiting technicians where requests were turned away or wait with no technician, following up missed pickups, or sending refunds that are waiting. If nothing needs doing, give one action to keep watching the main number.',
    'Plain, simple English. Short sentences. Write money as "BDT" followed by the amount. If there is very little data, say so plainly instead of guessing.',
]).join('\n');

const REPORT_SUMMARY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        headline: { type: 'string' },
        highlights: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        actions: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    },
    required: ['headline', 'highlights', 'actions'],
    additionalProperties: false,
});

function createGeminiReportSummaryProvider({ apiKey, model, maxOutputTokens, maxAttempts, retryBaseDelayMs, retryMaxDelayMs, client, clientFactory = createGeminiClient, diagnosticLogger, wait, now } = {}) {
    if (!apiKey || !model || !Number.isInteger(maxOutputTokens)) return null;
    const geminiClient = client || clientFactory(apiKey);
    return Object.freeze({
        async generateSummary({ facts, signal, requestId }) {
            return callGeminiJson({
                client: geminiClient, model, signal, requestId, maxAttempts, retryBaseDelayMs, retryMaxDelayMs, diagnosticLogger, wait, now,
                request: {
                    contents: [{ role: 'user', parts: [{ text: `REPORT FACTS\n${JSON.stringify(facts)}` }] }],
                    config: {
                        systemInstruction: REPORT_SUMMARY_INSTRUCTIONS,
                        responseMimeType: 'application/json',
                        responseJsonSchema: REPORT_SUMMARY_SCHEMA,
                        maxOutputTokens,
                        thinkingConfig: { thinkingLevel: 'LOW', includeThoughts: false },
                    },
                },
            });
        },
    });
}

function createConfiguredGeminiReportSummaryProvider(config, { client, clientFactory } = {}) {
    if (!config || config.enabled !== true || !config.apiKey) return null;
    try {
        return createGeminiReportSummaryProvider({
            apiKey: config.apiKey,
            model: config.model,
            maxOutputTokens: config.maxOutputTokens,
            maxAttempts: config.providerMaxAttempts,
            retryBaseDelayMs: config.providerRetryBaseDelayMs,
            retryMaxDelayMs: config.providerRetryMaxDelayMs,
            client,
            clientFactory,
        });
    } catch {
        return null;
    }
}

module.exports = { REPORT_SUMMARY_INSTRUCTIONS, REPORT_SUMMARY_SCHEMA, createGeminiReportSummaryProvider, createConfiguredGeminiReportSummaryProvider };
