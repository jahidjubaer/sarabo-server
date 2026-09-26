// Same focused-runner convention as test-support.js; Mongo is isolated.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (process.env.NODE_ENV !== 'test') throw new Error('Feedback tests require NODE_ENV=test');
process.env.MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'sarabo-test-db';
process.env.AI_SUPPORT_ENABLED = 'false';
// Tests never send real email (they use a fake transport where needed).
process.env.EMAIL_ENABLED = 'false';
// Email verification is always enforced in tests, whatever a local .env says.
process.env.SKIP_EMAIL_VERIFICATION = 'false';
// Fixtures create requests in made-up regions; tests that cover the
// technician gate turn it on explicitly.
process.env.SKIP_TECHNICIAN_MATCH_CHECK = 'true';
require('dotenv').config();
const { client } = require('./config/database');
const { runFeedbackTests } = require('./tests/feedbackTests');
let passed = 0;
let failed = 0;
function logTest(name, condition) {
    if (condition) { passed++; console.log(`PASS ${name}`); }
    else { failed++; console.error(`FAIL ${name}`); }
}
(async () => {
    try {
        await runFeedbackTests({ logTest });
        console.log(`Feedback Tests: ${passed + failed}\nPassed: ${passed}\nFailed: ${failed}`);
        process.exitCode = failed ? 1 : 0;
    } catch (error) {
        console.error('Feedback test execution failed:', error.message);
        process.exitCode = 1;
    } finally { await client.close(); }
})();
