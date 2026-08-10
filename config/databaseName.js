const { isProductionEnvironment } = require('./siteOrigin');

// The Sarabo local-development database (Phase 8.7B; formerly the inherited
// Zap Shift name). Production must never resolve to this - see
// resolveDatabaseName() below. No override variable is provided for that
// rejection: the safer default is none, since no existing deployment recovery
// pattern requires one.
const DEV_DB_NAME = 'sarabo-db';

// The dedicated, isolated automated-test database (Phase 8.7B). The suite must
// NEVER run against DEV_DB_NAME or any production database - see the testMode
// branch of resolveDatabaseName(), which defaults to this name and fails fast
// on anything that is not an explicit "test" database.
const TEST_DB_NAME = 'sarabo-test-db';

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

// Approved test-mode targets (Phase 8.7B): ONLY a database with an explicit
// "test" marker. The suite now has its own dedicated, self-seeding database
// (TEST_DB_NAME) with a baseline created at startup, so the previous interim
// allowance that let tests share the development database is deliberately gone:
// tests must never touch DEV_DB_NAME or any production database.
function isApprovedTestTarget(name) {
    return hasExplicitTestMarker(name);
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
        // Default to the dedicated test database; an explicit MONGO_DB_NAME may
        // override it, but ONLY to another explicit "test" database. Running the
        // suite against the development database or a production database is
        // refused here, before any fixture setup/cleanup can touch real data.
        const trimmed = (rawValue ?? '').trim();
        const name = trimmed ? validateDatabaseNameShape(rawValue) : TEST_DB_NAME;
        if (name === DEV_DB_NAME) {
            throw new Error(`Tests must not run against the development database ("${DEV_DB_NAME}"); use "${TEST_DB_NAME}" (or another database whose name contains "test").`);
        }
        if (!isApprovedTestTarget(name)) {
            throw new Error(`MONGO_DB_NAME must be an explicit test database (its name must contain "test") when NODE_ENV=test; refusing to run against "${name}".`);
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
    TEST_DB_NAME,
};
