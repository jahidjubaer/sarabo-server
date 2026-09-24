// Shared, narrow production guard for the data-preparation scripts
// (service-definition seed, BDT pricing migration, legacy schema migration).
//
// Production stays blocked by default. A script may run against a production
// target only when the operator supplies BOTH:
//   1. that script's own override variable, set to exactly "true"
//      (ALLOW_PROD_SERVICE_SEED / ALLOW_PROD_BDT_MIGRATION /
//      ALLOW_PROD_SCHEMA_MIGRATION - one per script, the same
//      ALLOW_PROD_<ACTION> convention scripts/retry-deletion-cleanup.js
//      already uses), and
//   2. --expect-db=<name> equal to the database the process actually resolved.
// There is deliberately no global "disable production safety" switch: each
// override unlocks one script, and only for the database the operator named.
//
// A "production target" is either a production environment
// (isProductionEnvironment()) or any database whose name contains
// "production" - the same two independent checks the seed script has always
// applied.
//
// Everything here is pure: callers pass values in, nothing reads process.env
// or argv, so the rules are unit-testable without touching the environment.

function isProductionTarget({ isProduction, resolvedDbName }) {
    return isProduction === true
        || (typeof resolvedDbName === 'string' && resolvedDbName.toLowerCase().includes('production'));
}

// Returns { safe, reason, productionTarget }.
//   requireExpectedDb: the caller demands --expect-db even outside production
//   (the legacy schema migration always does).
function evaluateProductionGuard({
    isProduction,
    resolvedDbName,
    expectedDbName,
    overrideVarName,
    overrideValue,
    requireExpectedDb = false,
}) {
    const productionTarget = isProductionTarget({ isProduction, resolvedDbName });
    const hasExpected = typeof expectedDbName === 'string' && expectedDbName.length > 0;

    if ((productionTarget || requireExpectedDb) && !hasExpected) {
        return {
            safe: false,
            productionTarget,
            reason: 'pass --expect-db=<exact database name> naming the database this run is meant for',
        };
    }
    if (hasExpected && expectedDbName !== resolvedDbName) {
        return {
            safe: false,
            productionTarget,
            reason: `--expect-db "${expectedDbName}" does not match the resolved database "${resolvedDbName}"`,
        };
    }
    if (productionTarget && overrideValue !== 'true') {
        const why = isProduction === true
            ? 'production environment (isProductionEnvironment() === true)'
            : `resolved database name "${resolvedDbName}" looks like a production database`;
        return {
            safe: false,
            productionTarget,
            reason: `${why}; set ${overrideVarName}=true together with --expect-db to run against it deliberately`,
        };
    }
    return { safe: true, productionTarget, reason: null };
}

// "--expect-db=<name>" -> "<name>"; absent or empty -> null.
function readExpectedDbArg(argv) {
    const arg = (argv || []).find((value) => typeof value === 'string' && value.startsWith('--expect-db='));
    if (!arg) return null;
    const name = arg.slice('--expect-db='.length).trim();
    return name || null;
}

module.exports = { isProductionTarget, evaluateProductionGuard, readExpectedDbArg };
