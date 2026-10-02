// Focused support tests must never inherit a shell setting that enables paid AI.
process.env.AI_SUPPORT_ENABLED = 'false';
// Tests never send real email (they use a fake transport where needed).
process.env.EMAIL_ENABLED = 'false';
// Email verification is always enforced in tests, whatever a local .env says.
process.env.SKIP_EMAIL_VERIFICATION = 'false';
// Fixtures create requests in made-up regions; tests that cover the
// technician gate turn it on explicitly.
process.env.SKIP_TECHNICIAN_MATCH_CHECK = 'true';
// The support rate limiter keeps its counters in MongoDB, so this runner is
// pinned to the isolated test database like test-feedback.js.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (process.env.NODE_ENV !== 'test') throw new Error('Support tests require NODE_ENV=test');
process.env.MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'sarabo-test-db';
require('dotenv').config();

const { runSupportFoundationTests } = require('./tests/supportFoundationTests');
const { runGeminiSupportProviderTests } = require('./tests/geminiSupportProviderTests');
const { runAiRequestDraftTests } = require('./tests/aiRequestDraftTests');
const { runAiOfferHelperTests } = require('./tests/aiOfferHelperTests');
const { runAiReportSummaryTests } = require('./tests/aiReportSummaryTests');

let passed = 0;
let failed = 0;

function logTest(name, condition, message = '') {
    if (condition) {
        passed += 1;
        console.log(`PASS ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL ${name}${message ? `: ${message}` : ''}`);
    }
}

(async () => {
    await runSupportFoundationTests({ logTest });
    await runGeminiSupportProviderTests({ logTest });
    await runAiRequestDraftTests({ logTest });
    await runAiOfferHelperTests({ logTest });
    await runAiReportSummaryTests({ logTest });
})()
    .then(() => {
        console.log(`\nSupport Tests: ${passed + failed}`);
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);
        process.exit(failed === 0 ? 0 : 1);
    })
    .catch((error) => {
        console.error('Support test execution error:', error.message);
        process.exit(1);
    });
