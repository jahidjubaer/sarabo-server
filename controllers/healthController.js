const dbHealth = require('../config/dbHealth');
const { logSafeError, getSafeLogPath, ERROR_CATEGORIES } = require('../utils/safeLogger');

// Module-level flag: persists across warm invocations of the same
// serverless container (Node's module cache), reset only on a genuine cold
// start. This is what makes cold starts observable via /health (Phase B
// audit item 8) without adding any new infrastructure.
let hasHandledAnyRequest = false;

class HealthController {
    async getHealth(req, res) {
        const coldStart = !hasHandledAnyRequest;
        hasHandledAnyRequest = true;
        const runtime = process.env.VERCEL ? 'serverless' : 'node';

        try {
            await dbHealth.checkDatabaseConnection();
            res.status(200).json({
                status: 'ok',
                service: 'sarabo-server',
                database: 'connected',
                runtime,
                coldStart,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            logSafeError({
                requestId: req.requestId,
                method: req.method,
                path: getSafeLogPath(req),
                status: 503,
                category: ERROR_CATEGORIES.DATABASE_UNAVAILABLE,
            });
            res.status(503).json({
                status: 'unavailable',
                service: 'sarabo-server',
                database: 'error',
                reason: 'database unreachable',
                timestamp: new Date().toISOString(),
            });
        }
    }
}

module.exports = HealthController;
