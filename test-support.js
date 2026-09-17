// Focused support tests must never inherit a shell setting that enables paid AI.
process.env.AI_SUPPORT_ENABLED = 'false';

const { runSupportFoundationTests } = require('./tests/supportFoundationTests');
const { runGeminiSupportProviderTests } = require('./tests/geminiSupportProviderTests');

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
