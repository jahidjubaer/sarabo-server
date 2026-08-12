const { verifyFBToken, verifyAdmin, verifyTechnician, verifyEmailVerified } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

function repairRequestRoutes(app, controllers) {
    const repairRequestController = controllers.repairRequest;

    // Get all repair requests
    app.get('/repair-requests', verifyFBToken, ensureDatabaseReady, (req, res) => repairRequestController.getAllRepairRequests(req, res));

    // Get repair requests for technician
    app.get('/repair-requests/technician', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => repairRequestController.getTechnicianRepairRequests(req, res));

    // Authenticated technician's own earnings summary (Phase 8.11). A distinct
    // 3-segment literal path so Express never confuses it with /repair-requests/:id;
    // the controller aggregates server-side over the caller's own completed
    // repairs (never a client-supplied total).
    app.get('/repair-requests/technician/earnings-summary', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => repairRequestController.getTechnicianEarningsSummary(req, res));

    // Get repair request by ID
    app.get('/repair-requests/:id', verifyFBToken, ensureDatabaseReady, (req, res) => repairRequestController.getRepairRequestById(req, res));

    // Get repair status stats (admin only)
    app.get('/repair-requests/delivery-status/stats', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => repairRequestController.getDeliveryStatusStats(req, res));

    // Admin-only, read-only eligible-technician recommendations (Phase 6.3
    // Unit 5) - v2 requests only, no mutation. A distinct 3-segment path so
    // Express can never structurally confuse this with the 2-segment
    // /repair-requests/:id route below, matching the same convention already used
    // for /notifications/:id/read and /technicians/:id/expertise.
    app.get('/repair-requests/:id/eligible-technicians', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => repairRequestController.getEligibleTechnicians(req, res));

    // Admin request-management list - paginated/searchable/filterable,
    // deliberately separate from GET /repair-requests above (whose flat-array
    // response shape is already relied on by MyRequests and
    // AssignTechnicians and is not changed by this route).
    app.get('/admin/repair-requests', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => repairRequestController.getAdminRepairRequests(req, res));

    // Admin-only manual settlement of a completed repair's technician earning
    // (Phase 8.11). Accounting/settlement state only - marks the earning "paid";
    // no external money transfer occurs. Idempotent (duplicate settlement -> 409).
    app.post('/admin/repair-requests/:id/technician-earning/mark-paid', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => repairRequestController.markTechnicianEarningPaid(req, res));

    // Create new repair request. Customer-exclusive business mutation - gated
    // by verifyEmailVerified (Phase 8.1) so an unverified email/password user
    // cannot create a request; server token is authoritative (client guard is
    // UX only). verifyEmailVerified runs after verifyFBToken and before the
    // controller.
    app.post('/repair-requests', verifyFBToken, ensureDatabaseReady, verifyEmailVerified, (req, res) => repairRequestController.createRepairRequest(req, res));

    // Update repair request status
    app.patch('/repair-requests/:id/status', verifyFBToken, ensureDatabaseReady, (req, res) => repairRequestController.updateRepairRequestStatus(req, res));

    // Customer-initiated soft cancellation - ownership is enforced inside
    // the controller (never delegated to route middleware alone), so any
    // authenticated caller may reach this route but only the request's own
    // owner can actually cancel it.
    app.patch('/repair-requests/:id/cancel', verifyFBToken, ensureDatabaseReady, (req, res) => repairRequestController.cancelRepairRequest(req, res));

    // Customer device-receipt confirmation (Phase 8.9) - a post-completion
    // handover acknowledgement. Owner-only is enforced inside the controller
    // (existence-preserving 404 for any non-owner), the same convention as
    // cancel above; any authenticated caller may reach the route but only the
    // request's own owner can actually confirm receipt.
    app.post('/repair-requests/:id/confirm-receipt', verifyFBToken, ensureDatabaseReady, (req, res) => repairRequestController.confirmReceipt(req, res));

    // Technician assignment decision (Phase 8.2). Accept/reject are technician
    // operations - verifyTechnician gates role; the controller additionally enforces
    // that the caller is the CURRENTLY offered technician and that the request
    // is still assignment_pending, and resolves concurrency atomically. These
    // (not the generic status PATCH) are the sole authority for the
    // assignment_pending -> driver_assigned / -> pending-pickup transitions.
    // Not gated by verifyEmailVerified (technician operation, not a customer
    // mutation).
    app.post('/repair-requests/:id/assignment/accept', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => repairRequestController.acceptAssignment(req, res));
    app.post('/repair-requests/:id/assignment/reject', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => repairRequestController.rejectAssignment(req, res));

    // Role-projected assignment read (Phase 8.2) - owner/assigned-technician/
    // admin; the controller strips rejection reasons + identities from non-admin
    // projections.
    app.get('/repair-requests/:id/assignment', verifyFBToken, ensureDatabaseReady, (req, res) => repairRequestController.getAssignment(req, res));

    // Assign technician to repair request (admin only)
    app.patch('/repair-requests/:id', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => repairRequestController.assignTechnicianToRepairRequest(req, res));

    // Safe deletion of a repair request (Phase 6.5 Unit 8). Ownership/role is
    // enforced inside the controller - the request's own owner OR an admin may
    // delete, but only while the request is still at its first lifecycle stage
    // (pending-pickup, unassigned, uninspected, unquoted, unpaid, no repair).
    // Deliberately NOT gated by verifyAdmin at the route level (unlike before):
    // a customer must be able to delete their own not-yet-started request, and
    // the controller is the single authority that decides who and when, the
    // same convention already used for cancelRepairRequest above.
    app.delete('/repair-requests/:id', verifyFBToken, ensureDatabaseReady, (req, res) => repairRequestController.deleteRepairRequest(req, res));
}

module.exports = repairRequestRoutes;
