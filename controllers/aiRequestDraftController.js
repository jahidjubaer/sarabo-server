const { RequestDraftError } = require('../services/aiRequestDraftService');
const { findSensitiveInputKind } = require('../utils/supportValidation');
const { logSafeError, getSafeLogPath, ERROR_CATEGORIES } = require('../utils/safeLogger');

const TEXT_MIN_CHARS = 5;
// The form shrinks a photo to about 1024px before sending, so a real one is
// far below this. Base64 makes the JSON body about a third bigger.
const PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function startsWith(buffer, bytes, offset = 0) {
    return bytes.every((byte, i) => buffer[offset + i] === byte);
}

// The file's first bytes must match the type it claims.
const PHOTO_SIGNATURES = Object.freeze({
    'image/jpeg': (b) => startsWith(b, [0xFF, 0xD8, 0xFF]),
    'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    'image/webp': (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
});

// Returns { photo } (null when none was sent) or { error }.
function readPhoto(value) {
    if (value === undefined || value === null) return { photo: null };
    if (typeof value !== 'object' || Array.isArray(value)) return { error: 'The photo could not be read. Please choose it again.' };
    const check = PHOTO_SIGNATURES[value.mimeType];
    if (!check) return { error: 'Please use a JPEG, PNG or WebP photo.' };
    if (typeof value.data !== 'string' || value.data.length === 0 || !BASE64_PATTERN.test(value.data)) {
        return { error: 'The photo could not be read. Please choose it again.' };
    }
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length > PHOTO_MAX_BYTES) return { error: 'The photo is too large. Please choose a smaller one.' };
    if (bytes.length < 12 || !check(bytes)) return { error: 'The photo could not be read. Please choose it again.' };
    return { photo: { mimeType: value.mimeType, data: value.data } };
}

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
    constructor({ aiRequestDraftService, aiOfferNoteService = null, aiReportSummaryService = null, config }) {
        this.service = aiRequestDraftService;
        this.offerNoteService = aiOfferNoteService;
        this.reportSummaryService = aiReportSummaryService;
        this.config = config;
    }

    // Lets each form show its AI helper only when it can work.
    status(req, res) {
        return res.send({
            requestHelper: this.service.isAvailable(),
            offerHelper: Boolean(this.offerNoteService && this.offerNoteService.isAvailable()),
            reportSummary: Boolean(this.reportSummaryService && this.reportSummaryService.isAvailable()),
        });
    }

    async draft(req, res) {
        const startedAt = Date.now();
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const { photo, error: photoError } = readPhoto(body.photo);
        if (photoError) return invalid(res, photoError);
        // A photo alone is enough; without one, a few words are needed.
        if (!photo && text.length < TEXT_MIN_CHARS) return invalid(res, 'Please describe the problem in a few words, or add a photo.');
        if (text.length > this.config.textMaxChars) return invalid(res, `Please keep it under ${this.config.textMaxChars} characters.`);
        const sensitive = findSensitiveInputKind(text);
        if (sensitive) return invalid(res, SENSITIVE_MESSAGES[sensitive] || 'Please remove private details from your text.');

        try {
            const draft = await this.service.draftRequest({ text, photo, requestId: req.requestId });
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
module.exports.PHOTO_MAX_BYTES = PHOTO_MAX_BYTES;
