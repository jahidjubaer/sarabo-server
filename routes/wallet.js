const { verifyFBToken } = require('../middleware/auth');
const { verifyAdmin, verifyTechnician } = require('../middleware/auth');
const { ensureDatabaseReady } = require('../middleware/database');

// Technician wallet + withdrawal routes, and the admin withdrawal queue
// (Phase 9). Follows the existing convention exactly: verifyFBToken first so a
// missing/invalid token fails without waiting on the database, then
// ensureDatabaseReady, then the role guard.
//
// The two technician routes are technician-only (verifyTechnician re-derives
// the role from the database, never from the token). The three admin routes are
// admin-only via verifyAdmin, and walletController additionally re-checks the
// admin role in-controller before touching any withdrawal - the same defence in
// depth the retired per-repair settlement endpoint used.
//
// No route anywhere here accepts a technician identity: the wallet owner is
// always req.decoded_email from the verified token, so one technician can never
// read or spend another's balance.
function walletRoutes(app, controllers) {
    const walletController = controllers.wallet;

    // Technician - own wallet only.
    app.get('/technician/wallet', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => walletController.getWallet(req, res));
    app.post('/technician/withdrawals', verifyFBToken, ensureDatabaseReady, verifyTechnician, (req, res) => walletController.requestWithdrawal(req, res));

    // Admin - the payout queue.
    app.get('/admin/withdrawals', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => walletController.listWithdrawals(req, res));
    app.post('/admin/withdrawals/:id/mark-paid', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => walletController.markWithdrawalPaid(req, res));
    app.post('/admin/withdrawals/:id/reject', verifyFBToken, ensureDatabaseReady, verifyAdmin, (req, res) => walletController.rejectWithdrawal(req, res));
}

module.exports = walletRoutes;
