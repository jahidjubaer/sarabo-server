const { ObjectId } = require('mongodb');
const { normalize } = require('../services/paymentProcessor');
const { createNotificationService } = require('../services/notificationService');
const {
    PLATFORM_COMMISSION_RATE, SETTLEMENT_CURRENCY,
    WITHDRAWAL_REQUESTED, WITHDRAWAL_PAID, WITHDRAWAL_REJECTED, WITHDRAWAL_STATUSES,
    calculateWallet, validateWithdrawalRequest, buildWithdrawalDocument,
    validateProcessingNote, buildSettlementView, buildWithdrawalView,
} = require('../utils/settlement');

const WALLET_SETTLEMENT_LIMIT = 25;
const WALLET_WITHDRAWAL_LIMIT = 25;
const ADMIN_LIST_DEFAULT_LIMIT = 20;
const ADMIN_LIST_MAX_LIMIT = 50;

// Technician wallet + withdrawal accounting, and the admin queue that processes
// withdrawals (Phase 9).
//
// THIS IS MANUAL PAYOUT ACCOUNTING. Nothing here moves real money. "Mark paid"
// records that an admin has settled a withdrawal out of band; there is no
// bKash, Nagad, bank or Stripe Connect integration behind any of it, and no
// transfer id is invented to imply otherwise.
//
// EVERY NUMBER IS SERVER-DERIVED. Balances, commission, and receivables are
// computed here from persisted settlement snapshots and withdrawal rows on
// every read - none is stored as a running total that could drift, and none is
// ever accepted from a client. The only value a client supplies anywhere in
// this file is a withdrawal `amount`, which is validated against a
// server-computed ceiling.
//
// IDENTITY IS SERVER-DERIVED. The technician is always req.decoded_email from
// the verified Firebase token, never an email in a body, query or path. There
// is no endpoint here that lets one technician name another.
class WalletController {
    constructor(models, collections) {
        this.User = models.User;
        this.TechnicianWithdrawal = models.TechnicianWithdrawal;
        this.collections = collections;
        this.notifications = createNotificationService(models);
    }

    // Loads everything one technician's wallet is derived from. Kept in one
    // place so the read path and the withdrawal-validation path can never
    // disagree about a balance - a withdrawal is checked against exactly the
    // figure GET /technician/wallet would have reported.
    async loadWallet(technicianEmail) {
        const [repairRequests, withdrawals] = await Promise.all([
            this.collections.repairRequests
                .find(
                    { technicianEmail, technicianSettlement: { $exists: true } },
                    // Explicit projection - the wallet needs the settlement, the
                    // reference to show against it, and the legacy earning purely
                    // to exclude already-paid historical repairs. It never needs
                    // customer identity, address, damage or quote notes.
                    { projection: { technicianSettlement: 1, technicianEarning: 1, trackingId: 1, updatedAt: 1 } }
                )
                .toArray(),
            this.TechnicianWithdrawal.findByTechnicianEmail(technicianEmail, { limit: 200 }),
        ]);
        return { repairRequests, withdrawals, wallet: calculateWallet({ repairRequests, withdrawals }) };
    }

    // GET /technician/wallet
    async getWallet(req, res) {
        try {
            const technicianEmail = normalize(req.decoded_email);
            const { repairRequests, withdrawals, wallet } = await this.loadWallet(technicianEmail);

            const settlements = repairRequests
                .map((repairRequest) => buildSettlementView(repairRequest))
                .filter(Boolean)
                .sort((a, b) => new Date(b.settledAt || 0) - new Date(a.settledAt || 0))
                .slice(0, WALLET_SETTLEMENT_LIMIT);

            const openWithdrawal = withdrawals.find((w) => w.status === WITHDRAWAL_REQUESTED) || null;

            return res.send({
                ...wallet,
                // Reported so the UI never has to hard-code the rate, and so a
                // future rate change reaches every surface at once.
                commissionRate: PLATFORM_COMMISSION_RATE,
                currency: SETTLEMENT_CURRENCY,
                hasOpenWithdrawal: !!openWithdrawal,
                openWithdrawal: buildWithdrawalView(openWithdrawal),
                settlements,
                withdrawals: withdrawals.slice(0, WALLET_WITHDRAWAL_LIMIT).map(buildWithdrawalView),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading wallet', code: 'WALLET_LOAD_FAILED' });
        }
    }

    // POST /technician/withdrawals
    async requestWithdrawal(req, res) {
        try {
            const technicianEmail = normalize(req.decoded_email);
            const { repairRequests, withdrawals, wallet } = await this.loadWallet(technicianEmail);
            const hasOpenWithdrawal = withdrawals.some((w) => w.status === WITHDRAWAL_REQUESTED);

            // Validated against the server's own availableBalance - which
            // already has reserved and withdrawn amounts subtracted, so an
            // approved-but-unpaid withdrawal cannot be requested twice over,
            // and pending (unconfirmed) money is never reachable because it
            // never entered grossAvailableBalance in the first place.
            const validation = validateWithdrawalRequest(req.body, {
                availableBalance: wallet.availableBalance,
                hasOpenWithdrawal,
            });
            if (!validation.valid) {
                const status = validation.code === 'WITHDRAWAL_ALREADY_OPEN' ? 409 : 400;
                return res.status(status).send({ message: validation.message, code: validation.code, availableBalance: wallet.availableBalance });
            }

            // Technician identity is resolved from the verified token only.
            // technicianId is best-effort context for the admin queue; its
            // absence never blocks a withdrawal, because the email is the
            // identity every balance is actually keyed on.
            const technicianRecord = await this.collections.technicians.findOne(
                { email: technicianEmail },
                { projection: { _id: 1, name: 1 } }
            );

            const document = buildWithdrawalDocument({
                technicianId: technicianRecord ? technicianRecord._id.toString() : null,
                technicianEmail,
                amount: validation.normalized.amount,
                now: new Date(),
            });

            // The unique partial index is the real single-winner guard here -
            // two concurrent requests that both passed the check above cannot
            // both insert, and the loser is reported as the same conflict.
            const created = await this.TechnicianWithdrawal.createRequested(document);
            if (!created.created) {
                return res.status(409).send({ message: 'you already have a withdrawal request awaiting processing', code: created.code });
            }

            // Recomputed from the settlements already in hand plus the row just
            // inserted, so the response reports the post-reservation balance
            // without a second round trip.
            const refreshed = calculateWallet({
                repairRequests,
                withdrawals: [...withdrawals, created.withdrawal],
            });

            return res.status(201).send({
                message: 'withdrawal requested',
                withdrawal: buildWithdrawalView(created.withdrawal),
                availableBalance: refreshed.availableBalance,
            });
        } catch (error) {
            res.status(500).send({ message: 'Error requesting withdrawal', code: 'WITHDRAWAL_REQUEST_FAILED' });
        }
    }

    // GET /admin/withdrawals
    async listWithdrawals(req, res) {
        try {
            const rawStatus = req.query.status;
            if (rawStatus !== undefined && !WITHDRAWAL_STATUSES.includes(rawStatus)) {
                return res.status(400).send({ message: `status must be one of: ${WITHDRAWAL_STATUSES.join(', ')}`, code: 'INVALID_WITHDRAWAL_STATUS' });
            }

            const rawPage = Number(req.query.page);
            const rawLimit = Number(req.query.limit);
            const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
            const limit = Number.isInteger(rawLimit) && rawLimit > 0
                ? Math.min(rawLimit, ADMIN_LIST_MAX_LIMIT)
                : ADMIN_LIST_DEFAULT_LIMIT;

            const { items, total } = await this.TechnicianWithdrawal.findAllPaged({
                status: rawStatus || null,
                skip: (page - 1) * limit,
                limit,
            });

            // The admin queue is the one place technician identity is shown, so
            // it carries the email and the display name - never any balance
            // figure, which would be a second, drifting source of truth beside
            // GET /technician/wallet.
            const emails = [...new Set(items.map((w) => w.technicianEmail).filter(Boolean))];
            const technicians = emails.length
                ? await this.collections.technicians.find({ email: { $in: emails } }, { projection: { email: 1, name: 1 } }).toArray()
                : [];
            const nameByEmail = new Map(technicians.map((t) => [t.email, t.name]));

            return res.send({
                withdrawals: items.map((withdrawal) => ({
                    ...buildWithdrawalView(withdrawal),
                    technicianEmail: withdrawal.technicianEmail,
                    technicianName: nameByEmail.get(withdrawal.technicianEmail) || null,
                    processedBy: withdrawal.processedBy ?? null,
                })),
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error loading withdrawals', code: 'WITHDRAWAL_LIST_FAILED' });
        }
    }

    // Shared terminal transition for mark-paid and reject. Both are single-
    // winner updates filtered on status: 'requested', so a withdrawal can leave
    // the open state exactly once - a second mark-paid, or a mark-paid racing a
    // reject, matches zero documents and returns a controlled 409 rather than
    // overwriting processedAt/processedBy. This is what makes paying a
    // withdrawal twice impossible.
    async processWithdrawal(req, res, targetStatus) {
        try {
            const id = req.params.id;
            if (!ObjectId.isValid(id)) {
                return res.status(400).send({ message: 'invalid withdrawal id', code: 'INVALID_WITHDRAWAL_ID' });
            }

            // Admin re-checked in-controller (defense in depth alongside the
            // route's verifyAdmin) and BEFORE any lookup, so a non-admin learns
            // nothing about whether the withdrawal exists.
            const caller = await this.User.findByEmail(normalize(req.decoded_email));
            if (!caller || caller.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access', code: 'ADMIN_REQUIRED' });
            }

            const noteValidation = validateProcessingNote(req.body);
            if (!noteValidation.valid) {
                return res.status(400).send({ message: noteValidation.message, code: noteValidation.code });
            }

            const withdrawal = await this.TechnicianWithdrawal.findById(id);
            if (!withdrawal) {
                return res.status(404).send({ message: 'withdrawal not found', code: 'WITHDRAWAL_NOT_FOUND' });
            }
            if (withdrawal.status !== WITHDRAWAL_REQUESTED) {
                return res.status(409).send({
                    message: `this withdrawal has already been ${withdrawal.status}`,
                    code: 'WITHDRAWAL_ALREADY_PROCESSED',
                });
            }

            const now = new Date();
            const adminEmail = normalize(req.decoded_email);
            const updateResult = await this.TechnicianWithdrawal.processFromRequested({
                id,
                status: targetStatus,
                processedBy: adminEmail,
                processedAt: now,
                note: noteValidation.normalized.note,
            });

            if (updateResult.matchedCount === 0) {
                const latest = await this.TechnicianWithdrawal.findById(id);
                return res.status(409).send({
                    message: latest && latest.status !== WITHDRAWAL_REQUESTED
                        ? `this withdrawal has already been ${latest.status}`
                        : 'the withdrawal could not be processed',
                    code: 'WITHDRAWAL_ALREADY_PROCESSED',
                });
            }

            // Best-effort - never roll back an authoritative settlement
            // decision because a notification failed.
            try {
                await this.notifications.createNotification({
                    recipientEmail: withdrawal.technicianEmail,
                    recipientRole: 'rider',
                    type: targetStatus === WITHDRAWAL_PAID ? 'withdrawal_paid' : 'withdrawal_rejected',
                    entityType: 'technician_withdrawal',
                    entityId: id,
                    metadata: { amount: withdrawal.amount, currency: withdrawal.currency || SETTLEMENT_CURRENCY },
                    actorEmail: adminEmail,
                });
            } catch (notifyError) {
                console.error('withdrawal notification failed (non-fatal):', notifyError.message);
            }

            return res.status(200).send({
                message: targetStatus === WITHDRAWAL_PAID ? 'withdrawal marked as paid' : 'withdrawal rejected',
                withdrawal: buildWithdrawalView({
                    ...withdrawal, status: targetStatus, processedAt: now, note: noteValidation.normalized.note,
                }),
            });
        } catch (error) {
            res.status(500).send({ message: 'Error processing withdrawal', code: 'WITHDRAWAL_PROCESS_FAILED' });
        }
    }

    // POST /admin/withdrawals/:id/mark-paid
    async markWithdrawalPaid(req, res) {
        return this.processWithdrawal(req, res, WITHDRAWAL_PAID);
    }

    // POST /admin/withdrawals/:id/reject
    //
    // Rejecting needs no compensating write to release the reservation: a
    // rejected withdrawal simply stops counting toward reservedBalance in
    // calculateWallet, so the money is available again the moment the status
    // changes. Nothing can be double-released, because there is nothing to
    // release.
    async rejectWithdrawal(req, res) {
        return this.processWithdrawal(req, res, WITHDRAWAL_REJECTED);
    }
}

module.exports = WalletController;
