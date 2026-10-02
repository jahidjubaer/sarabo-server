const { RequestDraftError } = require('../services/aiRequestDraftService');
const { findSensitiveInputKind } = require('../utils/supportValidation');
const { logSafeError, getSafeLogPath, ERROR_CATEGORIES } = require('../utils/safeLogger');

const TEXT_MIN_CHARS = 5;

const SENSITIVE_MESSAGES = Object.freeze({
    AUTH_TOKEN: 'Please remove the login token from your text.',
    SECRET: 'Please remove the password or secret from your text.',
    PAYMENT_CARD: 'Please remove the card number from your text.',
    TRACKING_CODE: 'Please remove the tracking code from your text.',
});

function invalid(res, message) {
    return res.status(400).send({ message, code: 'AI_HELPER_VALIDATION_ERROR' });
}

class AiRequestDraftController {
    constructor({ aiRequestDraftService, config }) {
        this.service = aiRequestDraftService;
        this.config = config;
    }

    // Lets the form show the helper only when it can work.
    status(req, res) {
        return res.send({ requestHelper: this.service.isAvailable() });
    }

    async draft(req, res) {
        const startedAt = Date.now();
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (text.length < TEXT_MIN_CHARS) return invalid(res, 'Please describe the problem in a few words.');
        if (text.length > this.config.textMaxChars) return invalid(res, `Please keep it under ${this.config.textMaxChars} characters.`);
        const sensitive = findSensitiveInputKind(text);
        if (sensitive) return invalid(res, SENSITIVE_MESSAGES[sensitive] || 'Please remove private details from your text.');

        try {
            const draft = await this.service.draftRequest({ text, requestId: req.requestId });
            return res.send({ draft });
        } catch (error) {
            const status = error instanceof RequestDraftError ? error.status : 500;
            logSafeError({
                requestId: req.requestId,
                method: req.method,
                path: getSafeLogPath(req),
                status,
                category: ERROR_CATEGORIES.INTERNAL_ERROR,
                durationMs: Date.now() - startedAt,
            });
            if (error instanceof RequestDraftError) {
                return res.status(error.status).send({ message: error.message, code: error.code });
            }
            return res.status(500).send({ message: 'The AI helper failed. Please fill in the form yourself.', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = AiRequestDraftController;
