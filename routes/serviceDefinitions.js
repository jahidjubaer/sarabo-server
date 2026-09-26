const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyAdmin } = require('../middleware/auth');

// Public catalog routes (Phase 6.3 Unit 2 / Phase H) are unauthenticated and
// read-only, and return active services only. Admin catalogue management
// (quick-wins phase) lives under /admin/service-definitions behind
// verifyFBToken + verifyAdmin; there is no delete - a service referenced by
// requests is switched off instead.
function serviceDefinitionRoutes(app, controllers) {
    const serviceDefinitionController = controllers.serviceDefinition;
    const adminController = controllers.adminServiceDefinition;

    app.get('/service-definitions', ensureDatabaseReady, (req, res) => serviceDefinitionController.listServiceDefinitions(req, res));
    app.get('/service-definitions/:id', ensureDatabaseReady, (req, res) => serviceDefinitionController.getServiceDefinitionById(req, res));

    if (adminController) {
        app.get('/admin/service-definitions', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => adminController.list(req, res));
        app.post('/admin/service-definitions', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => adminController.create(req, res));
        app.patch('/admin/service-definitions/:id', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => adminController.update(req, res));
    }
}

module.exports = serviceDefinitionRoutes;
