const { client } = require('./database');

// Lightweight liveness probe for the shared, cached MongoClient - never
// creates a new connection (reuses whatever connectDatabase() has already
// established) and never touches a business collection. A short maxTimeMS
// keeps a genuinely stalled cluster from hanging the health endpoint.
async function checkDatabaseConnection() {
    await client.db().admin().command({ ping: 1 }, { maxTimeMS: 2000 });
}

module.exports = { checkDatabaseConnection };
