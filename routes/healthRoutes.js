// Deliberately unauthenticated and not gated by ensureDatabaseReady - the
// whole point of this endpoint is to report the database's actual state
// (connected or not), not to require it up front like every business route.
function healthRoutes(app, controllers) {
    const healthController = controllers.health;
    app.get('/health', (req, res) => healthController.getHealth(req, res));
}

module.exports = healthRoutes;
