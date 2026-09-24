// Focused runner for the production-preparation tooling (legacy schema
// migration, guarded service seed, guarded BDT migration). Same convention as
// test-feedback.js; the suite uses its own throwaway test database.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
if (process.env.NODE_ENV !== 'test') throw new Error('Migration tests require NODE_ENV=test');
process.env.MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'sarabo-test-db';
process.env.AI_SUPPORT_ENABLED = 'false';
// Tests never send real email (they use a fake transport where needed).
process.env.EMAIL_ENABLED = 'false';
require('dotenv').config();
const { client } = require('./config/database');
const { runProductionMigrationTests } = require('./tests/productionMigrationTests');
let passed = 0;
let failed = 0;
function logTest(name, condition, detail) {
    if (condition) { passed++; console.log(`PASS ${name}`); }
    else { failed++; console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
}
(async () => {
    try {
        await runProductionMigrationTests({ logTest });
        console.log(`Migration Tests: ${passed + failed}\nPassed: ${passed}\nFailed: ${failed}`);
        process.exitCode = failed ? 1 : 0;
    } catch (error) {
        console.error('Migration test execution failed:', error.message);
        process.exitCode = 1;
    } finally { await client.close(); }
})();
