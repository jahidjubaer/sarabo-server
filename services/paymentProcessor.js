const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { logTracking } = require('../middleware/logging');
const { createCheckoutSessionManager } = require('./checkoutSessionManager');
const { PAYMENT_CURRENCY, V2_PAYMENT_CURRENCY, toSmallestUnit, isValidStoredCost, isValidQuoteTotal, isBdtQuoteCurrency } = require('../config/paymentConfig');
const { isV2RepairRequest } = require('../utils/repairRequestSchema');
const { QUOTE_APPROVED, PAYMENT_COMPLETED } = require('../utils/repairRequestStatus');
const { calculateSettlement, buildSettlementDocument } = require('../utils/settlement');

function normalize(value) {
    return (value || '').trim().toLowerCase();
}

// Single source of truth for turning an already-resolved, trusted Stripe
// Checkout Session into a recorded payment - shared by the authenticated
// browser-verification endpoint (Unit 2) and the Stripe webhook (Unit 3), so
// there is exactly one place that validates ownership/amount/currency and
// exactly one transaction that records a payment and marks a repair request paid.
//
// `session` must already be trusted by the caller: either freshly retrieved
// from Stripe with a client-supplied sessionId (browser path - Stripe itself
// is the source of truth for that session's contents), or the `data.object`
// of a signature-verified webhook event (webhook path). This function never
// contacts Stripe and never verifies a signature itself.
//
// `callerEmail` is only present for the browser path, where an authenticated
// Firebase identity must additionally match the request owner. The webhook
// has no such identity and relies solely on Stripe/MongoDB agreement.
// `notifications` is the already-constructed createNotificationService(models)
// instance, injected by the caller (controllers/paymentController.js) rather
// than required directly here - services/notificationService.js itself
// requires this file for `normalize`, so requiring it back here would create
// a module-load cycle between the two service files.
function createPaymentProcessor(models, collections, notifications) {
    const { RepairRequest, User } = models;
    const checkoutSessionManager = createCheckoutSessionManager(collections);

    // Completes a v2 approved-quote payment. Reached only from the shared
    // processor below, after session mode/paid, metadata, repair request load, and
    // ownership have already been verified for a v2 repair request. Everything
    // authoritative is re-derived from the persisted approved quote; the client
    // (and Stripe metadata) never influence the amount or currency here.
    async function completeV2CheckoutSession({ session, repairRequest, sessionId, source }) {
        const quote = repairRequest.quote;
        // The quote must still be approved and the request still awaiting
        // payment. These mirror the eligibility rules but are re-checked here
        // against fresh repair request state, since a payment can only be finalized for
        // a request that is genuinely in the payable state right now.
        if (!quote || quote.status !== 'approved') {
            return { code: 'V2_QUOTE_NOT_APPROVED' };
        }
        if (!isBdtQuoteCurrency(quote.currency) || !isValidQuoteTotal(quote.totalAmount)) {
            return { code: 'INVALID_STORED_COST' };
        }

        const expectedAmount = toSmallestUnit(quote.totalAmount);
        if (session.amount_total !== expectedAmount) {
            return { code: 'AMOUNT_MISMATCH' };
        }
        if (normalize(session.currency) !== V2_PAYMENT_CURRENCY) {
            return { code: 'CURRENCY_MISMATCH' };
        }

        // A cancelled request can never become paid - the customer's
        // cancellation is authoritative (common non-racing case; the guarded
        // update below covers the true concurrent race).
        if (repairRequest.deliveryStatus === 'cancelled') {
            return { code: 'REQUEST_CANCELLED' };
        }
        // Already completed through a different session (this exact session was
        // ruled out by the existing-payment fast path in the caller).
        if (repairRequest.deliveryStatus === PAYMENT_COMPLETED || (repairRequest.payment && repairRequest.payment.status === 'completed')) {
            return { code: 'ALREADY_PAID_OTHER_SESSION' };
        }

        const ownerEmail = normalize(repairRequest.senderEmail);
        const trackingId = repairRequest.trackingId;
        const paymentIntentId = session.payment_intent || null;

        const paymentRecord = {
            sessionId,
            transactionId: paymentIntentId,
            requestId: repairRequest._id.toString(),
            trackingId,
            customerEmail: ownerEmail,
            amount: quote.totalAmount,
            currency: quote.currency,
            paymentStatus: 'paid',
            // v2 provenance - never used for authorization; sessionId remains
            // the sole idempotency key (unique index on payments.sessionId).
            schemaVersion: 2,
            quoteVersion: quote.version,
            source,
        };

        const mongoSession = client.startSession();
        let committed = null;
        let conflict = false;
        let ownerRoleUnresolved = false;
        try {
            await mongoSession.withTransaction(async () => {
                conflict = false;
                ownerRoleUnresolved = false;
                committed = null;

                const resolvedOwnerRole = await User.findRoleByEmail(repairRequest.senderEmail, { session: mongoSession });
                if (!resolvedOwnerRole) {
                    ownerRoleUnresolved = true;
                    return;
                }

                const now = new Date();
                let insertedId;
                try {
                    paymentRecord.paidAt = now;
                    const insertResult = await collections.payments.insertOne(paymentRecord, { session: mongoSession });
                    insertedId = insertResult.insertedId;
                } catch (insertError) {
                    if (insertError.code === 11000) {
                        // A concurrent completion (webhook, browser, or Stripe
                        // retry) already recorded this exact session.
                        conflict = true;
                        return;
                    }
                    throw insertError;
                }

                // Guarded update - the filter itself resolves every race: a
                // concurrent cancellation, a concurrent completion, or a quote
                // that is no longer approved all make matchedCount 0. The
                // approved quote total/currency were validated above; the
                // payment sub-document records the completion without ever
                // altering the quote line items.
                const updateResult = await collections.repairRequests.updateOne(
                    {
                        _id: repairRequest._id,
                        schemaVersion: 2,
                        deliveryStatus: QUOTE_APPROVED,
                        'quote.status': 'approved',
                        'payment.status': { $ne: 'completed' },
                    },
                    {
                        $set: {
                            deliveryStatus: PAYMENT_COMPLETED,
                            payment: {
                                status: 'completed',
                                provider: 'stripe',
                                paymentIntentId,
                                amount: quote.totalAmount,
                                currency: quote.currency,
                                quoteVersion: quote.version,
                                completedAt: now,
                            },
                            updatedAt: now,
                        },
                    },
                    { session: mongoSession }
                );
                if (updateResult.matchedCount === 0) {
                    conflict = true;
                    await collections.payments.deleteOne({ _id: insertedId }, { session: mongoSession });
                    return;
                }

                // Release the active checkout slot atomically with completion.
                await checkoutSessionManager.completeByRequestId(repairRequest._id.toString(), mongoSession);

                // Tracking + notifications join this same transaction, so no
                // payment can commit without them and none can be emitted for a
                // payment that did not commit. Safe text only - never card
                // data, a client secret, a Stripe id, or an amount.
                await logTracking(collections.trackingEvents, trackingId, PAYMENT_COMPLETED, mongoSession);
                await notifications.createNotification({
                    session: mongoSession,
                    recipientEmail: repairRequest.senderEmail,
                    recipientRole: resolvedOwnerRole,
                    type: 'payment_completed',
                    entityType: 'repair_request',
                    entityId: repairRequest._id.toString(),
                    actorEmail: null,
                    metadata: { trackingId },
                });
                if (repairRequest.technicianEmail) {
                    await notifications.createNotification({
                        session: mongoSession,
                        recipientEmail: repairRequest.technicianEmail,
                        recipientRole: 'rider',
                        type: 'payment_completed_technician',
                        entityType: 'repair_request',
                        entityId: repairRequest._id.toString(),
                        actorEmail: null,
                        metadata: { trackingId },
                    });
                }

                committed = { transactionId: paymentIntentId, trackingId };
            });
        } finally {
            await mongoSession.endSession();
        }

        if (ownerRoleUnresolved) {
            return { code: 'REPAIR_OWNER_ROLE_UNRESOLVED' };
        }
        if (conflict) {
            const winner = await collections.payments.findOne({ sessionId });
            if (winner) {
                await checkoutSessionManager.completeByRequestId(winner.requestId);
                return { code: 'OK', alreadyProcessed: true, transactionId: winner.transactionId, trackingId: winner.trackingId };
            }
            const latestRepairRequest = await RepairRequest.findById(repairRequest._id.toString());
            if (latestRepairRequest && latestRepairRequest.deliveryStatus === 'cancelled') {
                return { code: 'REQUEST_CANCELLED' };
            }
            return { code: 'ALREADY_PAID_OTHER_SESSION' };
        }

        return { code: 'OK', alreadyProcessed: false, transactionId: committed.transactionId, trackingId: committed.trackingId };
    }

    return async function processVerifiedCheckoutSession({ session, source, callerEmail = null }) {
        const sessionId = session.id;
        const normalizedCaller = callerEmail ? normalize(callerEmail) : null;

        // Fast idempotent path: this exact session was already recorded,
        // by either source, on a previous call.
        const existingPayment = await collections.payments.findOne({ sessionId });
        if (existingPayment) {
            const repairRequest = await RepairRequest.findById(existingPayment.requestId);
            if (!repairRequest) {
                return { code: 'PARCEL_NOT_FOUND' };
            }
            if (normalizedCaller && normalize(repairRequest.senderEmail) !== normalizedCaller) {
                return { code: 'OWNERSHIP_MISMATCH' };
            }
            // Defensive reconciliation: the active checkout row (if any) for
            // this repair request should already be completed from the first call
            // that recorded this payment, but this keeps repeat/idempotent
            // calls safe even if that earlier reconciliation did not run.
            await checkoutSessionManager.completeByRequestId(existingPayment.requestId);
            return {
                code: 'OK',
                alreadyProcessed: true,
                transactionId: existingPayment.transactionId,
                trackingId: existingPayment.trackingId
            };
        }

        if (session.mode !== 'payment') {
            return { code: 'INVALID_SESSION_SHAPE' };
        }
        if (session.payment_status !== 'paid') {
            return { code: 'NOT_PAID' };
        }

        const requestId = session.metadata && session.metadata.requestId;
        if (!requestId || !ObjectId.isValid(requestId)) {
            return { code: 'MISSING_METADATA' };
        }

        const repairRequest = await RepairRequest.findById(requestId);
        if (!repairRequest) {
            return { code: 'PARCEL_NOT_FOUND' };
        }

        // Ownership: the stored request owner and Stripe's own record of who
        // paid must agree - this holds regardless of source, since Unit 1
        // always creates the session with customer_email set to the owner.
        // The authenticated caller (browser path only) must also agree.
        const ownerEmail = normalize(repairRequest.senderEmail);
        const stripeEmail = normalize(session.customer_email);
        if (ownerEmail !== stripeEmail) {
            return { code: 'OWNERSHIP_MISMATCH' };
        }
        if (normalizedCaller && normalizedCaller !== ownerEmail) {
            return { code: 'OWNERSHIP_MISMATCH' };
        }

        // Repair Request v2 approved-quote payments (Phase 6.4 Unit 6) diverge
        // from the legacy path entirely from here: the authoritative amount and
        // currency come from the immutable approved quote (BDT), never from
        // repair request.cost/PAYMENT_CURRENCY, and completion transitions
        // deliveryStatus to payment_completed rather than only flipping
        // paymentStatus. The shared checks above (session mode/paid, metadata,
        // repair request load, ownership) and the idempotent existing-payment fast path
        // at the top apply to both paths unchanged. A legacy request never
        // reaches this branch (legacy checkout creation rejects every v2
        // request), and a v2 request never falls through to the legacy code
        // below.
        if (isV2RepairRequest(repairRequest)) {
            return await completeV2CheckoutSession({ session, repairRequest, sessionId, source });
        }

        const cost = Number(repairRequest.cost);
        if (!isValidStoredCost(cost)) {
            return { code: 'INVALID_STORED_COST' };
        }
        const expectedAmount = toSmallestUnit(cost);
        if (session.amount_total !== expectedAmount) {
            return { code: 'AMOUNT_MISMATCH' };
        }
        if (normalize(session.currency) !== PAYMENT_CURRENCY) {
            return { code: 'CURRENCY_MISMATCH' };
        }

        // A cancelled request must never become paid, regardless of whether
        // the Stripe session itself is genuinely valid - the customer's
        // cancellation decision is authoritative. This is the common,
        // non-racing case (cancellation already committed well before this
        // call); the transaction's guarded update below additionally covers
        // the true concurrent race (Phase 2.5 Unit 1, Case 3).
        if (repairRequest.deliveryStatus === 'cancelled') {
            return { code: 'REQUEST_CANCELLED' };
        }

        if (repairRequest.paymentStatus === 'paid') {
            // No payment record referenced this sessionId above, so this
            // repair request was already paid through a different session. Reconcile
            // defensively in case that other session's own completion never
            // released the active checkout row.
            await checkoutSessionManager.completeByRequestId(repairRequest._id.toString());
            return { code: 'ALREADY_PAID_OTHER_SESSION' };
        }

        const trackingId = repairRequest.trackingId;
        const transactionId = session.payment_intent;
        const paymentRecord = {
            sessionId,
            transactionId,
            requestId: repairRequest._id.toString(),
            trackingId,
            customerEmail: ownerEmail,
            amount: cost,
            currency: PAYMENT_CURRENCY,
            paymentStatus: 'paid',
            // Operational traceability only - never used for authorization
            // or uniqueness (sessionId alone remains the idempotency key).
            source
        };

        const mongoSession = client.startSession();
        let committedPayment = null;
        let conflict = false;
        let ownerRoleUnresolved = false;
        try {
            await mongoSession.withTransaction(async () => {
                // Resolved first, inside the same transaction, before any
                // write below - the real current role, never trusted from
                // the repair request document, the client, or Stripe. A missing or
                // invalid owner account aborts before anything is written,
                // mirroring the outcome-object pattern used for every other
                // pre-write conflict in this function.
                const resolvedOwnerRole = await User.findRoleByEmail(repairRequest.senderEmail, { session: mongoSession });
                if (!resolvedOwnerRole) {
                    ownerRoleUnresolved = true;
                    return;
                }

                let insertedId;
                try {
                    paymentRecord.paidAt = new Date();
                    const insertResult = await collections.payments.insertOne(paymentRecord, { session: mongoSession });
                    insertedId = insertResult.insertedId;
                } catch (insertError) {
                    if (insertError.code === 11000) {
                        // A concurrent request (webhook, browser, or a Stripe
                        // retry) already recorded this exact session.
                        conflict = true;
                        return;
                    }
                    throw insertError;
                }

                // deliveryStatus is intentionally left untouched by a normal
                // payment completion - payment and repair-lifecycle status
                // are independent concerns. The one exception is 'cancelled':
                // this guard ensures a customer cancellation that commits
                // concurrently with this very transaction still wins - the
                // query condition itself is the race-resolver, not a
                // read-then-write check (the early check above only catches
                // the non-racing case).
                // Technician settlement snapshot, frozen here at the moment
                // payment becomes final and written in the SAME guarded update
                // as paymentStatus - so it is created exactly once, by the
                // single winner, and a retry can never duplicate it or
                // overwrite one that already exists.
                //
                // Derived from the persisted APPROVED quote (guaranteed present
                // and approved by the payment-eligibility gate above), never
                // from Stripe metadata and never from the client. Because it is
                // a snapshot that nothing ever recomputes, a later quote edit
                // cannot silently move money that has already been settled.
                //
                // Deliberately non-fatal when it cannot be derived: a repair
                // with no assigned technician, or a quote whose lines do not
                // reconcile, records no settlement rather than failing the
                // customer's payment. Accounting must never be able to reject
                // money that Stripe has already taken. Such a repair simply
                // never enters any wallet.
                const paymentSet = { paymentStatus: 'paid' };
                const settlementTechnicianEmail = normalize(repairRequest.technicianEmail);
                const settlementResult = calculateSettlement(repairRequest.quote);
                if (settlementResult.valid && settlementTechnicianEmail && repairRequest.technicianId) {
                    paymentSet.technicianSettlement = buildSettlementDocument(settlementResult.settlement, {
                        technicianId: repairRequest.technicianId,
                        technicianEmail: settlementTechnicianEmail,
                        now: new Date(),
                    });
                }

                // The guard is unchanged from before this snapshot existed:
                // paymentStatus: { $ne: 'paid' } already means "nobody has
                // completed this payment yet", and the settlement is only ever
                // written together with that flip. Adding a second condition on
                // technicianSettlement would introduce a new way for this
                // update to fail without describing a real conflict.
                const updateResult = await collections.repairRequests.updateOne(
                    { _id: repairRequest._id, paymentStatus: { $ne: 'paid' }, deliveryStatus: { $ne: 'cancelled' } },
                    { $set: paymentSet },
                    { session: mongoSession }
                );
                if (updateResult.matchedCount === 0) {
                    // RepairRequest became paid by a concurrent different-session
                    // request between our earlier check and this write.
                    conflict = true;
                    await collections.payments.deleteOne({ _id: insertedId }, { session: mongoSession });
                    return;
                }

                // Same transaction as the payment insert + repair request update - the
                // active checkout slot is released atomically with the payment
                // becoming final, never left dangling as "in progress" once
                // the repair request is actually paid.
                await checkoutSessionManager.completeByRequestId(repairRequest._id.toString(), mongoSession);

                // Joins this same transaction, reached only on the genuine
                // first-time commit path (never on a conflict/no-op return
                // above, never on the alreadyProcessed fast path, which
                // returns long before any transaction opens). A genuine
                // failure here throws and aborts the whole transaction - no
                // payment document and no paid repair request can commit without it.
                await notifications.createNotification({
                    session: mongoSession,
                    recipientEmail: repairRequest.senderEmail,
                    recipientRole: resolvedOwnerRole,
                    type: 'payment_confirmed',
                    entityType: 'repair_request',
                    entityId: repairRequest._id.toString(),
                    actorEmail: null,
                    actorRole: null,
                    metadata: { trackingId: repairRequest.trackingId }
                });

                committedPayment = { ...paymentRecord, _id: insertedId };
            });
        } finally {
            await mongoSession.endSession();
        }

        if (ownerRoleUnresolved) {
            return { code: 'REPAIR_OWNER_ROLE_UNRESOLVED' };
        }

        if (conflict) {
            const winner = await collections.payments.findOne({ sessionId });
            if (winner) {
                // The concurrent call that actually committed already
                // reconciled the checkout row in its own transaction - this
                // is a defensive no-op unless that reconciliation somehow
                // did not happen.
                await checkoutSessionManager.completeByRequestId(winner.requestId);
                return {
                    code: 'OK',
                    alreadyProcessed: true,
                    transactionId: winner.transactionId,
                    trackingId: winner.trackingId
                };
            }
            // No payment ever recorded for this sessionId, yet the guarded
            // update still lost - a concurrent cancellation, not a
            // concurrent payment, must have won the race (Case 3).
            const latestRepairRequest = await RepairRequest.findById(repairRequest._id.toString());
            if (latestRepairRequest && latestRepairRequest.deliveryStatus === 'cancelled') {
                return { code: 'REQUEST_CANCELLED' };
            }
            return { code: 'ALREADY_PAID_OTHER_SESSION' };
        }

        logTracking(collections.trackingEvents, trackingId, 'repair_request_paid');

        return {
            code: 'OK',
            alreadyProcessed: false,
            transactionId: committedPayment.transactionId,
            trackingId: committedPayment.trackingId
        };
    };
}

module.exports = { createPaymentProcessor, normalize };
