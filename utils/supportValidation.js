const ALLOWED_BODY_FIELDS = Object.freeze(['message', 'history']);
const ALLOWED_HISTORY_FIELDS = Object.freeze(['role', 'content']);
const ALLOWED_HISTORY_ROLES = Object.freeze(['user', 'assistant']);

const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const API_KEY_PATTERN = /\b(?:sk_(?:live|test|proj)_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{12,})\b/;
const LABELED_SECRET_PATTERN = /\b(?:api[_ -]?key|secret|access[_ -]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/i;
const SECURE_TRACKING_CODE_PATTERN = /(?:^|[^A-Za-z0-9_-])SRB-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/;
const LEGACY_TRACKING_CODE_PATTERN = /\bPRCL-\d{8}-[A-Fa-f0-9]{6}\b/;
const CARD_CANDIDATE_PATTERN = /(?:\d[ -]?){13,19}/g;

function isPlainObject(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasOnlyFields(value, allowedFields) {
    return Object.keys(value).every((key) => allowedFields.includes(key));
}

function passesLuhnCheck(digits) {
    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
        let digit = Number(digits[index]);
        if (doubleDigit) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
}

function containsPaymentCardNumber(value) {
    const candidates = value.match(CARD_CANDIDATE_PATTERN) || [];
    return candidates.some((candidate) => {
        const digits = candidate.replace(/\D/g, '');
        return digits.length >= 13 && digits.length <= 19 && passesLuhnCheck(digits);
    });
}

function findSensitiveInputKind(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    if (BEARER_TOKEN_PATTERN.test(value) || JWT_PATTERN.test(value)) return 'AUTH_TOKEN';
    if (API_KEY_PATTERN.test(value) || LABELED_SECRET_PATTERN.test(value)) return 'SECRET';
    if (containsPaymentCardNumber(value)) return 'PAYMENT_CARD';
    if (SECURE_TRACKING_CODE_PATTERN.test(value) || LEGACY_TRACKING_CODE_PATTERN.test(value)) return 'TRACKING_CODE';
    return null;
}

function invalid(message, reason = 'INVALID_INPUT') {
    return { valid: false, code: 'SUPPORT_VALIDATION_ERROR', message, reason };
}

function validateSupportChatInput(body, limits) {
    if (!isPlainObject(body)) {
        return invalid('support request body must be an object');
    }
    if (!hasOnlyFields(body, ALLOWED_BODY_FIELDS)) {
        return invalid('support request contains an unsupported field');
    }
    if (typeof body.message !== 'string') {
        return invalid('message must be a string');
    }

    const message = body.message.trim();
    if (message.length === 0 || message.length > limits.messageMaxChars) {
        return invalid(`message must contain between 1 and ${limits.messageMaxChars} characters`);
    }

    const historyInput = body.history === undefined ? [] : body.history;
    if (!Array.isArray(historyInput)) {
        return invalid('history must be an array');
    }
    if (historyInput.length > limits.historyMaxMessages) {
        return invalid(`history must contain at most ${limits.historyMaxMessages} messages`);
    }

    const history = [];
    let aggregateHistoryLength = 0;
    for (const entry of historyInput) {
        if (!isPlainObject(entry) || !hasOnlyFields(entry, ALLOWED_HISTORY_FIELDS)) {
            return invalid('each history entry must contain only role and content');
        }
        if (!ALLOWED_HISTORY_ROLES.includes(entry.role)) {
            return invalid('history role must be user or assistant');
        }
        if (typeof entry.content !== 'string') {
            return invalid('history content must be a string');
        }
        const content = entry.content.trim();
        if (content.length === 0 || content.length > limits.historyMessageMaxChars) {
            return invalid(`history content must contain between 1 and ${limits.historyMessageMaxChars} characters`);
        }
        aggregateHistoryLength += content.length;
        if (aggregateHistoryLength > limits.historyMaxChars) {
            return invalid(`history must contain at most ${limits.historyMaxChars} characters in total`);
        }
        history.push({ role: entry.role, content });
    }

    const sensitiveKind = [message, ...history.map((entry) => entry.content)]
        .map(findSensitiveInputKind)
        .find(Boolean);
    if (sensitiveKind) {
        return invalid(
            'Do not send passwords, authentication tokens, API keys, payment-card details, or tracking codes to AI support.',
            'SENSITIVE_INPUT'
        );
    }

    return {
        valid: true,
        normalized: {
            message,
            history,
        },
    };
}

module.exports = {
    ALLOWED_HISTORY_ROLES,
    findSensitiveInputKind,
    containsPaymentCardNumber,
    validateSupportChatInput,
};
