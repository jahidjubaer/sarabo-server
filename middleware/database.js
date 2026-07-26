const { connectDatabase, collections } = require('../config/database');

// Confirms the shared, cached database connection is ready before any
// database-backed route handler runs. Placed after auth middleware in each
// route's chain, so a missing/invalid token still returns 401 without
// waiting on the database. A genuine database outage returns 503 here
// instead of the request ever reaching a handler that would fail
// unpredictably (and instead of the route appearing to not exist).
const ensureDatabaseReady = async (req, res, next) => {
    try {
        await connectDatabase();
        req.collections = collections;
        next();
    } catch (error) {
        res.status(503).send({ message: 'Service temporarily unavailable, please try again shortly' });
    }
};

module.exports = { ensureDatabaseReady };
