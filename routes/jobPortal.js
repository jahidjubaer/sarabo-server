const rateLimit = require('express-rate-limit');
const { ensureDatabaseReady } = require('../middleware/database');
const { verifyFBToken, verifyAdmin, verifyTechnician, verifyEmailVerified } = require('../middleware/auth');

// The open jobs board needs no sign-in, so it is rate limited per address
// (in-memory, like the public tracking lookup).
const publicJobsLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please try again shortly.' },
});

// Job portal (job-portal phase B). Technician routes need the technician role;
// the controller also requires an approved technician record. Customer
// routes check ownership in the controller; accepting needs a verified email
// like creating a request does.
function jobPortalRoutes(app, controllers) {
    const c = controllers.jobPortal;
    app.get('/jobs', publicJobsLimiter, ensureDatabaseReady, (req, res) => c.listPublic(req, res));
    app.get('/technician/job-portal', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => c.listPortal(req, res));
    app.post('/repair-requests/:id/applications', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => c.apply(req, res));
    app.post('/repair-requests/:id/applications/mine/withdraw', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => c.withdraw(req, res));
    app.get('/repair-requests/:id/applications', verifyFBToken, ensureDatabaseReady, (req, res) => c.listForRequest(req, res));
    app.post('/repair-requests/:id/applications/:applicationId/accept', verifyFBToken, ensureDatabaseReady, verifyEmailVerified, (req, res) => c.accept(req, res));
    app.post('/repair-requests/:id/applications/:applicationId/decline', verifyFBToken, ensureDatabaseReady, (req, res) => c.decline(req, res));
    app.post('/admin/repair-requests/:id/invite', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => c.invite(req, res));
}

module.exports = jobPortalRoutes;
