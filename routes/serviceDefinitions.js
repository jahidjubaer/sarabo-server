const { ensureDatabaseReady } = require('../middleware/database');

// Public, unauthenticated, read-only catalog routes (Phase 6.3 Unit 2 /
// Phase H) - no verifyFBToken, no ownership check, no admin-only branch.
// There is no create/update/delete route here in this unit.
function serviceDefinitionRoutes(app, controllers) {
    const serviceDefinitionController = controllers.serviceDefinition;

    app.get('/service-definitions', ensureDatabaseReady, (req, res) => serviceDefinitionController.listServiceDefinitions(req, res));
    app.get('/service-definitions/:id', ensureDatabaseReady, (req, res) => serviceDefinitionController.getServiceDefinitionById(req, res));
}

module.exports = serviceDefinitionRoutes;
