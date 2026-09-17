const { validateSupportChatInput } = require('../utils/supportValidation');
const { SupportServiceError } = require('../services/aiSupportService');
const { logSafeError, getSafeLogPath, ERROR_CATEGORIES } = require('../utils/safeLogger');

function logSupportFailure(req, status, category, startedAt) {
    logSafeError({
        requestId: req.requestId,
        method: req.method,
        path: getSafeLogPath(req),
        status,
        category,
        durationMs: Date.now() - startedAt,
    });
}

class SupportController {
    constructor({ aiSupportService, supportKnowledgeService, config }) {
        this.aiSupportService = aiSupportService;
        this.supportKnowledgeService = supportKnowledgeService;
        this.config = config;
    }

    async chat(req, res) {
        const startedAt = Date.now();
        const validation = validateSupportChatInput(req.body, this.config);
        if (!validation.valid) {
            logSupportFailure(req, 400, ERROR_CATEGORIES.VALIDATION_ERROR, startedAt);
            return res.status(400).send({
                message: validation.message,
                code: validation.code,
            });
        }

        try {
            this.aiSupportService.assertAvailable();
            const knowledge = await this.supportKnowledgeService.buildKnowledge();
            const messages = [
                ...validation.normalized.history,
                { role: 'user', content: validation.normalized.message },
            ];
            const response = await this.aiSupportService.generateReply({
                messages,
                knowledge,
                requestId: req.requestId,
            });
            return res.send(response);
        } catch (error) {
            if (error instanceof SupportServiceError) {
                logSupportFailure(req, error.status, ERROR_CATEGORIES.INTERNAL_ERROR, startedAt);
                return res.status(error.status).send({ message: error.message, code: error.code });
            }
            logSupportFailure(req, 500, ERROR_CATEGORIES.INTERNAL_ERROR, startedAt);
            return res.status(500).send({
                message: 'Unable to process the support request.',
                code: 'INTERNAL_ERROR',
            });
        }
    }
}

module.exports = SupportController;
