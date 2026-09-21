// Same focused-runner convention as test-support.js; Mongo is isolated.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (process.env.NODE_ENV !== 'test') throw new Error('Feedback tests require NODE_ENV=test');
process.env.MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'sarabo-test-db';
process.env.AI_SUPPORT_ENABLED = 'false';
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
