const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { logTrackingSafely } = require('../middleware/logging');
const { createNotificationService } = require('../services/notificationService');
const { createStripeRefunder } = require('../services/inspectionFeeRefunds');
const { refundParts, markPaymentRowsRefunded } = require('../services/refundParts');
const { closeUnpaidRequest, isNotRepairable } = require('../services/requestClosure');
const { confirmReceiptOnce, AUTO_CONFIRM_MS } = require('../services/receiptConfirmation');
const { refundPlan } = require('../utils/warranty');
const { SETTLEMENT_REVERSED } = require('../utils/settlement');
const {
    ACTIVE_STATUSES, INSPECTION_COMPLETED, QUOTE_APPROVED, PAYMENT_COMPLETED, REPAIR_IN_PROGRESS, REPAIR_COMPLETED,
} = require('../utils/repairRequestStatus');

// Ways out of states where a repair used to get stuck (workflow review,
// 2026-10-14). Each action is a guarded update on the request's current
// state, so it runs once and only from the right step.
//
//   not repairable     the inspection says not repairable / not economical:
//                      the technician or the customer closes the request
//   cancel unpaid      the customer backs out after approving, before paying
//   cannot complete    the technician cannot finish a paid repair: admins are
//                      alerted, and an admin cancels it and refunds the customer
//   device returned    the technician marks the device returned; the customer
//                      confirms, says it has not arrived, or after 3 days it is
//                      confirmed automatically (daily job)
//   confirm receipt    an admin settles "I have not received it"
// (Unpaid approved quotes are closed after 3 days by the daily job -
// services/requestClosure.js.)

const PAID_STATUSES = [PAYMENT_COMPLETED, REPAIR_IN_PROGRESS];
const NOTE_MIN = 10;
const NOTE_MAX = 500;

function normalize(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function refuse(res, status, code, message) {
    return res.status(status).send({ message, code });
}

// { ok, note } or { ok: false, message }. `required` asks for 10+ characters.
function readNote(body, { required = false } = {}) {
    const raw = body && typeof body === 'object' ? body.note : undefined;
    const note = typeof raw === 'string' ? raw.trim() : '';
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return { ok: false, message: 'the note must be text' };
    if (note.length > NOTE_MAX) return { ok: false, message: `the note must be at most ${NOTE_MAX} characters` };
    if (required && note.length < NOTE_MIN) return { ok: false, message: `please explain in at least ${NOTE_MIN} characters` };
    return { ok: true, note };
}

class WorkflowController {
    constructor(models, collections, { now = () => new Date(), mongoClient = client, refundPayment = null, expireCheckout = null } = {}) {
        this.collections = collections;
        this.User = models.User;
        this.notifications = createNotificationService(models);
        this.now = now;
        this.mongoClient = mongoClient;
        this.refundPayment = refundPayment || ((args) => createStripeRefunder(require('stripe')(process.env.STRIPE_SECRET))(args));
        this.expireCheckout = expireCheckout || ((sessionId) => require('stripe')(process.env.STRIPE_SECRET).checkout.sessions.expire(sessionId));
    }

    async loadRequest(id) {
        if (!ObjectId.isValid(id)) return null;
        return this.collections.repairRequests.findOne({ _id: new ObjectId(id) });
    }

    // Who the caller is to this request. Anyone else gets the same 404.
    async access(req) {
        const request = await this.loadRequest(req.params.id);
        const caller = normalize(req.decoded_email);
        if (!request) return { request: null };
        const isOwner = normalize(request.senderEmail) === caller;
        const isTechnician = !isOwner && !!request.technicianEmail && normalize(request.technicianEmail) === caller
            && (await this.User.findRoleByEmail(caller)) === 'rider';
        return { request, caller, isOwner, isTechnician };
    }

    async notify(input) {
        try {
            await this.notifications.createNotification({ entityType: 'repair_request', actorEmail: null, ...input });
        } catch (error) {
            console.error(`Workflow notification ${input.type} failed (non-fatal):`, error.message);
        }
    }

    async notifyCustomer(request, step, occurrence = 'once') {
        await this.notify({
            recipientEmail: request.senderEmail, recipientRole: (await this.User.findRoleByEmail(request.senderEmail)) || 'user',
            type: 'repair_update', entityId: request._id.toString(), metadata: { trackingId: request.trackingId, occurrence, step },
        });
    }

    async notifyTechnician(request, step, occurrence = 'once') {
        if (!request.technicianEmail) return;
        await this.notify({
            recipientEmail: request.technicianEmail, recipientRole: 'rider', type: 'repair_update_technician',
            entityId: request._id.toString(), metadata: { trackingId: request.trackingId, occurrence, step },
        });
    }

    async notifyAdmins(request, step, occurrence = 'once') {
        let admins = [];
        try {
            admins = await this.User.findEmailsByRole('admin');
        } catch (error) {
            console.error('Admin lookup failed (non-fatal):', error.message);
        }
        await Promise.all(admins.map((email) => this.notify({
            recipientEmail: email, recipientRole: 'admin', type: 'repair_needs_admin',
            entityId: request._id.toString(), metadata: { trackingId: request.trackingId, occurrence, step },
        })));
    }

    // ---- Closing unpaid work -----------------------------------------------

    // POST /repair-requests/:id/close-not-repairable  (its technician or the customer)
    async closeNotRepairable(req, res) {
        try {
            const { request, caller, isOwner, isTechnician } = await this.access(req);
            if (!request || (!isOwner && !isTechnician)) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            if (request.deliveryStatus !== INSPECTION_COMPLETED || !isNotRepairable(request)) {
                return refuse(res, 409, 'NOT_CLOSABLE', 'only a request the inspection found not repairable can be closed this way');
            }
            const result = await closeUnpaidRequest({
                collections: this.collections, notifications: this.notifications, User: this.User, mongoClient: this.mongoClient,
                request, reason: 'not_repairable', closedBy: isOwner ? 'customer' : 'technician', actorEmail: caller, now: this.now(), expireCheckout: this.expireCheckout,
            });
            if (!result.closed) return refuse(res, 409, 'REQUEST_CHANGED', 'this request changed meanwhile - reload it');
            res.send({ deliveryStatus: 'cancelled', inspectionFee: result.feeKept ? 'kept' : 'none' });
        } catch (error) {
            res.status(500).send({ message: 'Error closing the request', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/cancel-unpaid  (the customer, after approving, before paying)
    async cancelUnpaid(req, res) {
        try {
            const { request, caller, isOwner } = await this.access(req);
            if (!request || !isOwner) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            if (request.deliveryStatus !== QUOTE_APPROVED) return refuse(res, 409, 'NOT_CLOSABLE', 'only an approved, unpaid quote can be cancelled this way');
            const result = await closeUnpaidRequest({
                collections: this.collections, notifications: this.notifications, User: this.User, mongoClient: this.mongoClient,
                request, reason: 'customer_cancelled_unpaid', closedBy: 'customer', actorEmail: caller, now: this.now(), expireCheckout: this.expireCheckout,
            });
            if (result.code === 'PAYMENT_IN_PROGRESS') {
                return refuse(res, 409, 'PAYMENT_IN_PROGRESS', 'a payment page is open for this repair - finish or close it, then try again');
            }
            if (!result.closed) return refuse(res, 409, 'REQUEST_CHANGED', 'this request changed meanwhile - reload it');
            res.send({ deliveryStatus: 'cancelled', inspectionFee: result.feeKept ? 'kept' : 'none' });
        } catch (error) {
            res.status(500).send({ message: 'Error cancelling the request', code: 'INTERNAL_ERROR' });
        }
    }

    // ---- Paid repair that cannot be finished -------------------------------

    // POST /repair-requests/:id/repair/cannot-complete  { note }  (its technician)
    async reportCannotComplete(req, res) {
        try {
            const check = readNote(req.body, { required: true });
            if (!check.ok) return refuse(res, 400, 'INVALID_NOTE', check.message);
            const { request, isTechnician } = await this.access(req);
            if (!request || !isTechnician) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            const now = this.now();
            const result = await this.collections.repairRequests.updateOne(
                { _id: request._id, deliveryStatus: { $in: PAID_STATUSES }, technicianEmail: request.technicianEmail, repairBlocked: { $exists: false } },
                { $set: { repairBlocked: { reason: check.note, reportedAt: now }, updatedAt: now } }
            );
            if (result.matchedCount === 0) {
                const code = request.repairBlocked ? 'ALREADY_REPORTED' : 'NOT_A_PAID_REPAIR';
                return refuse(res, 409, code, code === 'ALREADY_REPORTED' ? 'you have already reported this - an admin will decide' : 'only a paid repair in progress can be reported');
            }
            await this.notifyAdmins(request, 'cannot_complete');
            res.send({ repairBlocked: { reason: check.note, reportedAt: now } });
        } catch (error) {
            res.status(500).send({ message: 'Error saving the report', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /admin/repair-requests/:id/cancel-paid-repair  { note }
    // Cancels a paid repair that cannot be finished, refunds the customer the
    // whole quote total (repair payment + credited inspection fee) through
    // Stripe test mode, reverses the technician's settlement and releases them.
    // Calling it again retries a refund part that failed; nothing is refunded twice.
    async adminCancelPaidRepair(req, res) {
        try {
            const check = readNote(req.body, { required: true });
            const request = await this.loadRequest(req.params.id);
            if (!request) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            const retry = request.deliveryStatus === 'cancelled' && request.cancellationReason === 'paid_repair_cancelled';
            if (!retry) {
                if (!check.ok) return refuse(res, 400, 'INVALID_NOTE', check.message);
                if (!PAID_STATUSES.includes(request.deliveryStatus)) return refuse(res, 409, 'NOT_A_PAID_REPAIR', 'only a paid repair that is not finished can be cancelled this way');
                const won = await this.cancelPaidInTransaction(request, { note: check.note, admin: normalize(req.decoded_email) });
                if (!won) return refuse(res, 409, 'REQUEST_CHANGED', 'this request changed meanwhile - reload it');
            } else if (request.cancellationRefund?.refundedAt) {
                return refuse(res, 409, 'ALREADY_REFUNDED', 'this repair was already cancelled and refunded');
            }

            const fresh = await this.loadRequest(req.params.id);
            const now = this.now();
            const { parts, refunded } = await refundParts({
                collections: this.collections, refundPayment: this.refundPayment, parts: fresh.cancellationRefund.parts, keyPrefix: `paid-cancel-refund-${fresh._id}`, now,
            });
            await this.collections.repairRequests.updateOne(
                { _id: fresh._id },
                { $set: { 'cancellationRefund.parts': parts, 'cancellationRefund.lastAttemptAt': now, ...(refunded ? { 'cancellationRefund.refundedAt': now } : {}) } }
            );
            await markPaymentRowsRefunded({ collections: this.collections, parts, reason: 'paid_repair_cancelled', now });
            if (!retry) {
                await logTrackingSafely(this.collections.trackingEvents, fresh.trackingId, 'cancelled');
                await this.notifyCustomer(fresh, 'paid_repair_cancelled');
                await this.notifyTechnician(fresh, 'paid_repair_cancelled');
            }
            const view = { total: fresh.cancellationRefund.total, currency: fresh.cancellationRefund.currency, refunded, parts: parts.map((p) => ({ purpose: p.purpose, amount: p.amount, status: p.status, lastError: p.lastError || null })) };
            if (!refunded) return res.status(502).send({ code: 'REFUND_FAILED', message: 'The repair is cancelled but the refund did not complete. Nothing was refunded twice - try again.', refund: view });
            res.send({ deliveryStatus: 'cancelled', refund: view });
        } catch (error) {
            res.status(500).send({ message: 'Error cancelling the repair', code: 'INTERNAL_ERROR' });
        }
    }

    // One transaction: cancel, record the refund plan, reverse the settlement,
    // release the technician. Resolves to whether this call won.
    async cancelPaidInTransaction(request, { note, admin }) {
        const plan = refundPlan(request);
        const now = this.now();
        const session = this.mongoClient.startSession();
        let won = false;
        try {
            await session.withTransaction(async () => {
                won = false;
                const result = await this.collections.repairRequests.updateOne(
                    { _id: request._id, deliveryStatus: { $in: PAID_STATUSES } },
                    {
                        $set: {
                            deliveryStatus: 'cancelled', cancelledAt: now, cancelledBy: admin, cancellationReason: 'paid_repair_cancelled', cancellationNote: note,
                            cancellationRefund: { ...plan, parts: plan.parts.map((p) => ({ ...p, status: 'pending' })), approvedAt: now, approvedBy: admin },
                            ...(request.technicianSettlement ? {
                                'technicianSettlement.status': SETTLEMENT_REVERSED, 'technicianSettlement.reversedAt': now, 'technicianSettlement.reversalReason': 'paid_repair_cancelled',
                            } : {}),
                            updatedAt: now,
                        },
                    },
                    { session }
                );
                if (result.matchedCount === 0) return;
                won = true;
                if (request.technicianId && ObjectId.isValid(request.technicianId)) {
                    const technicianObjectId = new ObjectId(request.technicianId);
                    const otherActive = await this.collections.repairRequests.findOne(
                        { technicianId: request.technicianId, deliveryStatus: { $in: ACTIVE_STATUSES }, _id: { $ne: request._id } },
                        { session, projection: { _id: 1 } }
                    );
                    if (!otherActive) await this.collections.technicians.updateOne({ _id: technicianObjectId }, { $set: { workStatus: 'available' } }, { session });
                }
            });
        } finally {
            await session.endSession();
        }
        return won;
    }

    // ---- Device return and receipt -----------------------------------------

    // POST /repair-requests/:id/mark-returned  (its technician)
    async markReturned(req, res) {
        try {
            const { request, isTechnician } = await this.access(req);
            if (!request || !isTechnician) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            const now = this.now();
            const autoConfirmAt = new Date(now.getTime() + AUTO_CONFIRM_MS);
            const result = await this.collections.repairRequests.updateOne(
                {
                    _id: request._id, deliveryStatus: REPAIR_COMPLETED, technicianEmail: request.technicianEmail,
                    'customerReceiptConfirmation.status': { $ne: 'confirmed' }, 'deviceReturn.markedAt': { $exists: false },
                },
                { $set: { 'deviceReturn.markedAt': now, 'deviceReturn.autoConfirmAt': autoConfirmAt, updatedAt: now } }
            );
            if (result.matchedCount === 0) return refuse(res, 409, 'NOT_RETURNABLE', 'only a finished repair not yet confirmed can be marked returned (once)');
            await this.notifyCustomer(request, 'device_returned');
            res.send({ deviceReturn: { markedAt: now, autoConfirmAt } });
        } catch (error) {
            res.status(500).send({ message: 'Error marking the device returned', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /repair-requests/:id/receipt-dispute  { note? }  (the customer: "I have not received it")
    async disputeReceipt(req, res) {
        try {
            const check = readNote(req.body);
            if (!check.ok) return refuse(res, 400, 'INVALID_NOTE', check.message);
            const { request, isOwner } = await this.access(req);
            if (!request || !isOwner) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            const now = this.now();
            const result = await this.collections.repairRequests.updateOne(
                {
                    _id: request._id, deliveryStatus: REPAIR_COMPLETED,
                    'customerReceiptConfirmation.status': { $ne: 'confirmed' }, 'deviceReturn.disputedAt': { $exists: false },
                },
                { $set: { 'deviceReturn.disputedAt': now, 'deviceReturn.disputeNote': check.note, updatedAt: now } }
            );
            if (result.matchedCount === 0) return refuse(res, 409, 'NOT_DISPUTABLE', 'this repair is not waiting for you to receive the device');
            await this.notifyTechnician(request, 'receipt_disputed');
            await this.notifyAdmins(request, 'receipt_disputed');
            res.send({ deviceReturn: { ...(request.deviceReturn || {}), disputedAt: now, disputeNote: check.note } });
        } catch (error) {
            res.status(500).send({ message: 'Error saving your report', code: 'INTERNAL_ERROR' });
        }
    }

    // POST /admin/repair-requests/:id/confirm-receipt  { note }
    async adminConfirmReceipt(req, res) {
        try {
            const check = readNote(req.body, { required: true });
            if (!check.ok) return refuse(res, 400, 'INVALID_NOTE', check.message);
            const request = await this.loadRequest(req.params.id);
            if (!request) return refuse(res, 404, 'REQUEST_NOT_FOUND', 'repair request not found');
            const confirmation = await confirmReceiptOnce({
                collections: this.collections, request, method: 'admin', now: this.now(), adminEmail: normalize(req.decoded_email), note: check.note,
            });
            if (!confirmation) return refuse(res, 409, 'NOT_CONFIRMABLE', 'only a finished repair not yet confirmed can be confirmed');
            await logTrackingSafely(this.collections.trackingEvents, request.trackingId, 'customer_receipt_confirmed');
            await this.notifyCustomer(request, 'receipt_confirmed_by_admin');
            await this.notifyTechnician(request, 'receipt_confirmed_by_admin');
            res.send({ deliveryStatus: 'parcel_delivered', customerReceiptConfirmation: confirmation });
        } catch (error) {
            res.status(500).send({ message: 'Error confirming receipt', code: 'INTERNAL_ERROR' });
        }
    }

    // Daily job: confirms receipt where the technician marked the device
    // returned 3+ days ago and the customer neither confirmed nor disputed.
    async autoConfirmReceipts({ limit = 200 } = {}) {
        const now = this.now();
        const due = await this.collections.repairRequests.find({
            deliveryStatus: REPAIR_COMPLETED,
            'customerReceiptConfirmation.status': { $ne: 'confirmed' },
            'deviceReturn.markedAt': { $lte: new Date(now.getTime() - AUTO_CONFIRM_MS) },
            'deviceReturn.disputedAt': { $exists: false },
        }).limit(limit).toArray();
        const counts = { found: due.length, confirmed: 0, failed: 0 };
        for (const request of due) {
            try {
                const confirmation = await confirmReceiptOnce({ collections: this.collections, request, method: 'auto', now });
                if (!confirmation) continue;
                counts.confirmed += 1;
                await logTrackingSafely(this.collections.trackingEvents, request.trackingId, 'customer_receipt_confirmed');
                await this.notifyCustomer(request, 'receipt_auto_confirmed');
                if (request.technicianEmail) {
                    await this.notify({
                        recipientEmail: request.technicianEmail, recipientRole: 'rider', type: 'receipt_confirmed',
                        entityId: request._id.toString(), metadata: { trackingId: request.trackingId },
                    });
                }
            } catch (error) {
                counts.failed += 1;
                console.error('Auto-confirming receipt failed (will retry tomorrow):', error.message);
            }
        }
        return counts;
    }
}

module.exports = WorkflowController;
