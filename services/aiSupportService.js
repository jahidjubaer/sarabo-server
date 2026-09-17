const { resolveSupportActions } = require('../utils/supportActions');

const ESCALATION_REASON_CODES = Object.freeze([
    'PAYMENT_DISPUTE',
    'DUPLICATE_CHARGE',
    'REFUND_REQUEST',
    'DAMAGED_OR_MISSING_DEVICE',
    'REPAIR_DISPUTE',
    'TECHNICIAN_COMPLAINT',
    'ACCOUNT_ACCESS',
    'SECURITY_CONCERN',
]);

class SupportServiceError extends Error {
    constructor(code, status, message) {
        super(message);
        this.name = 'SupportServiceError';
        this.code = code;
        this.status = status;
    }
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidProviderResponse() {
    return new SupportServiceError(
        'SUPPORT_INVALID_RESPONSE',
        502,
        'AI support returned an invalid response. Please try again later.'
    );
}

function validateProviderResponse(value, outputMaxChars) {
    if (!isPlainObject(value) || typeof value.reply !== 'string') {
        throw invalidProviderResponse();
    }
    const reply = value.reply.trim();
    if (reply.length === 0 || reply.length > outputMaxChars) {
        throw invalidProviderResponse();
    }

    const rawActions = value.actions === undefined ? [] : value.actions;
    if (!Array.isArray(rawActions) || rawActions.length > 2) {
        throw invalidProviderResponse();
    }
    const actionIds = [];
    for (const action of rawActions) {
        if (!isPlainObject(action) || typeof action.id !== 'string' || action.id.trim().length === 0) {
            throw invalidProviderResponse();
        }
        actionIds.push(action.id.trim());
    }

    const escalation = value.escalation === undefined
        ? { recommended: false, reasonCode: null }
        : value.escalation;
    if (!isPlainObject(escalation) || typeof escalation.recommended !== 'boolean') {
        throw invalidProviderResponse();
    }
    if (escalation.recommended) {
        if (!ESCALATION_REASON_CODES.includes(escalation.reasonCode)) {
            throw invalidProviderResponse();
        }
    } else if (escalation.reasonCode !== null) {
        throw invalidProviderResponse();
    }

    return {
        reply,
        actionIds,
        escalation: {
            recommended: escalation.recommended,
            reasonCode: escalation.reasonCode,
        },
    };
}

function createAiSupportService({ provider = null, config }) {
    function assertAvailable() {
        if (!config.enabled || !provider || typeof provider.generateReply !== 'function') {
            throw new SupportServiceError(
                'SUPPORT_UNAVAILABLE',
                503,
                'AI support is temporarily unavailable. Please try again later.'
            );
        }
    }

    async function generateReply({ messages, knowledge, requestId }) {
        assertAvailable();
        const abortController = new AbortController();
        let timeoutId;
        const timeout = new Promise((resolve, reject) => {
            timeoutId = setTimeout(() => {
                reject(new SupportServiceError(
                    'SUPPORT_TIMEOUT',
                    504,
                    'AI support took too long to respond. Please try again.'
                ));
                // Reject the server-owned timeout first so an abort-aware SDK
                // cannot race the controlled SUPPORT_TIMEOUT into a generic
                // provider failure while the same signal cancels network I/O.
                abortController.abort();
            }, config.timeoutMs);
        });

        let providerResponse;
        try {
            providerResponse = await Promise.race([
                Promise.resolve().then(() => provider.generateReply({
                    messages,
                    knowledge,
                    signal: abortController.signal,
                    requestId,
                })),
                timeout,
            ]);
        } catch (error) {
            if (error instanceof SupportServiceError) throw error;
            if (error && error.code === 'PROVIDER_INVALID_RESPONSE') {
                throw invalidProviderResponse();
            }
            if (error && error.code === 'PROVIDER_TIMEOUT') {
                throw new SupportServiceError(
                    'SUPPORT_TIMEOUT',
                    504,
                    'AI support took too long to respond. Please try again.'
                );
            }
            throw new SupportServiceError(
                'SUPPORT_UNAVAILABLE',
                503,
                'AI support is temporarily unavailable. Please try again later.'
            );
        } finally {
            clearTimeout(timeoutId);
        }

        const validated = validateProviderResponse(providerResponse, config.outputMaxChars);
        return {
            reply: validated.reply,
            actions: resolveSupportActions(validated.actionIds),
            escalation: validated.escalation,
        };
    }

    return { assertAvailable, generateReply };
}

module.exports = {
    ESCALATION_REASON_CODES,
    SupportServiceError,
    validateProviderResponse,
    createAiSupportService,
};
