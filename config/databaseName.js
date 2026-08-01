const { isProductionEnvironment } = require('./siteOrigin');

// The database name every local development environment has always used
// (see the git history of config/database.js). Production must never resolve
// to this - see resolveDatabaseName() below. No override variable is
// provided for this rejection: the safer default is none, since no existing
// deployment recovery pattern requires one.
const DEV_DB_NAME = 'zap_shift_db';

const MAX_LENGTH = 64; // MongoDB's own database-name length limit.
// MongoDB forbids these characters in a database name on the platforms it
// supports: / \ . " $ * < > : |  (plus control characters, checked
// separately below). Rejecting them here, before ever reaching the driver,
// turns an invalid name into a clear config error instead of a cryptic
// driver-level failure.
const FORBIDDEN_CHARS_PATTERN = /["$*<>:|\\/.]/;

// Narrow structural validation only - trims, checks length/forbidden
// characters/URI-like syntax. Does not know about production/test/dev
// semantics; resolveDatabaseName() layers those rules on top. Throws a plain
// Error naming only MONGO_DB_NAME and the unmet rule, never the value.
function validateDatabaseNameShape(rawValue) {
    const trimmed = (rawValue ?? '').trim();
    if (!trimmed) {
        throw new Error('MONGO_DB_NAME must not be empty or whitespace-only.');
    }
    if (trimmed.length > MAX_LENGTH) {
        throw new Error(`MONGO_DB_NAME must be ${MAX_LENGTH} characters or fewer.`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(trimmed)) {
        throw new Error('MONGO_DB_NAME must not contain a null byte or other control character.');
    }
    if (trimmed.includes('://') || /[?#]/.test(trimmed)) {
        throw new Error('MONGO_DB_NAME must be a plain database name, not a URI, query string, or fragment.');
    }
    if (FORBIDDEN_CHARS_PATTERN.test(trimmed)) {
        throw new Error('MONGO_DB_NAME contains a character MongoDB does not allow in a database name.');
    }
    return trimmed;
}

function hasExplicitTestMarker(name) {
    return name.toLowerCase().includes('test');
}

// Approved test-mode targets: anything with an explicit "test" marker (for a
// genuinely separate, dedicated test database), plus the existing
// development database itself. The latter is a deliberate, documented
// interim allowance - Phase 5.7's test-strategy decision found that the
// existing test suite (test-all.js) depends on pre-seeded real user/rider/
// role records that only exist in the development database today, and
// seeding an equivalent baseline into a genuinely separate database is a
// broad data-migration effort explicitly out of that phase's scope. Once
// that seeding is done separately, an operator can opt into a real dedicated
// test database (e.g. MONGO_DB_NAME=sarabo_test) and this same check passes
// via the "test" marker instead.
function isApprovedTestTarget(name) {
    return hasExplicitTestMarker(name) || name === DEV_DB_NAME;
}

// Single source of truth for which database this process connects to.
// Called once, at module load, by config/database.js - see that file for why
// database selection must happen synchronously before any connection
// resolves. Layers production/test/development semantics on top of
// validateDatabaseNameShape()'s purely structural checks.
function resolveDatabaseName() {
    const rawValue = process.env.MONGO_DB_NAME;
    const production = isProductionEnvironment();
    const testMode = process.env.NODE_ENV === 'test';

    if (production) {
        if (!(rawValue ?? '').trim()) {
            throw new Error('MONGO_DB_NAME is required in production and must not be empty.');
        }
        const name = validateDatabaseNameShape(rawValue);
        if (name === DEV_DB_NAME) {
            throw new Error(`MONGO_DB_NAME must not be the development database name ("${DEV_DB_NAME}") in production.`);
        }
        return name;
    }

    if (testMode) {
        const trimmed = (rawValue ?? '').trim();
        const name = trimmed ? validateDatabaseNameShape(rawValue) : DEV_DB_NAME;
        if (!isApprovedTestTarget(name)) {
            throw new Error('MONGO_DB_NAME must be an approved test target (contain "test", or be the development database) when NODE_ENV=test.');
        }
        return name;
    }

    // Development: an explicit name is preferred, but a backwards-compatible
    // fallback to the historical name keeps existing local setups working.
    const trimmed = (rawValue ?? '').trim();
    if (!trimmed) {
        console.warn(
            `[config] MONGO_DB_NAME is not set - falling back to '${DEV_DB_NAME}'. ` +
            'Set MONGO_DB_NAME in your .env for an explicit development database name.'
        );
        return DEV_DB_NAME;
    }
    return validateDatabaseNameShape(rawValue);
}

module.exports = {
    resolveDatabaseName,
    validateDatabaseNameShape,
    hasExplicitTestMarker,
    isApprovedTestTarget,
    DEV_DB_NAME,
};
