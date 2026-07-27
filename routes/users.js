const { verifyFBToken, verifyAdmin } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function userRoutes(app, controllers) {
    const userController = controllers.user;

    // Get all users with search (admin only)
    app.get('/users', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => userController.getAllUsers(req, res));

    // Get user by ID
    app.get('/users/:id', verifyFBToken, ensureDatabaseReady, (req, res) => userController.getUserById(req, res));

    // Get user role by email
    app.get('/users/:email/role', verifyFBToken, ensureDatabaseReady, (req, res) => userController.getUserRole(req, res));

    // Create/sync the authenticated caller's own user record - requires a
    // verified Firebase token; identity and role are always server-derived
    // (see userController.createUser), never trusted from the request body
    app.post('/users', verifyFBToken, ensureDatabaseReady, (req, res) => userController.createUser(req, res));

    // Update user role (admin only)
    app.patch('/users/:id/role', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => userController.updateUserRole(req, res));
}

module.exports = userRoutes;
