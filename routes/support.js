const { optionalAuth } = require('../middleware/optionalAuth');
const { supportRateLimit } = require('../middleware/supportRateLimit');

function supportRoutes(app, controllers, options = {}) {
    const supportController = controllers.support;
    const authMiddleware = options.authMiddleware || optionalAuth;
    const rateLimitMiddleware = options.rateLimitMiddleware || supportRateLimit;

    app.post(
        '/support/chat',
        authMiddleware,
        rateLimitMiddleware,
        (req, res) => supportController.chat(req, res)
    );
}

module.exports = supportRoutes;
