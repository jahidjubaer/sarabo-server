const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { logTracking } = require('../middleware/logging');
const { createCheckoutSessionManager } = require('./checkoutSessionManager');
const { PAYMENT_CURRENCY, toSmallestUnit, isValidStoredCost } = require('../config/paymentConfig');

function normalize(value) {
    return (value || '').trim().toLowerCase();
}

// Single source of truth for turning an already-resolved, trusted Stripe
// Checkout Session into a recorded payment - shared by the authenticated
// browser-verification endpoint (Unit 2) and the Stripe webhook (Unit 3), so
// there is exactly one place that validates ownership/amount/currency and
// exactly one transaction that records a payment and marks a parcel paid.
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
    const { Parcel, User } = models;
    const checkoutSessionManager = createCheckoutSessionManager(collections);

    return async function processVerifiedCheckoutSession({ session, source, callerEmail = null }) {
        const sessionId = session.id;
        const normalizedCaller = callerEmail ? normalize(callerEmail) : null;

        // Fast idempotent path: this exact session was already recorded,
        // by either source, on a previous call.
        const existingPayment = await collections.payments.findOne({ sessionId });
        if (existingPayment) {
            const parcel = await Parcel.findById(existingPayment.parcelId);
            if (!parcel) {
                return { code: 'PARCEL_NOT_FOUND' };
            }
            if (normalizedCaller && normalize(parcel.senderEmail) !== normalizedCaller) {
                return { code: 'OWNERSHIP_MISMATCH' };
            }
            // Defensive reconciliation: the active checkout row (if any) for
            // this parcel should already be completed from the first call
            // that recorded this payment, but this keeps repeat/idempotent
            // calls safe even if that earlier reconciliation did not run.
            await checkoutSessionManager.completeByParcelId(existingPayment.parcelId);
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

        const parcelId = session.metadata && session.metadata.parcelId;
        if (!parcelId || !ObjectId.isValid(parcelId)) {
            return { code: 'MISSING_METADATA' };
        }

        const parcel = await Parcel.findById(parcelId);
        if (!parcel) {
            return { code: 'PARCEL_NOT_FOUND' };
        }

        // Ownership: the stored request owner and Stripe's own record of who
        // paid must agree - this holds regardless of source, since Unit 1
        // always creates the session with customer_email set to the owner.
        // The authenticated caller (browser path only) must also agree.
        const ownerEmail = normalize(parcel.senderEmail);
        const stripeEmail = normalize(session.customer_email);
        if (ownerEmail !== stripeEmail) {
            return { code: 'OWNERSHIP_MISMATCH' };
        }
        if (normalizedCaller && normalizedCaller !== ownerEmail) {
            return { code: 'OWNERSHIP_MISMATCH' };
        }

        const cost = Number(parcel.cost);
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
        if (parcel.deliveryStatus === 'cancelled') {
            return { code: 'REQUEST_CANCELLED' };
        }

        if (parcel.paymentStatus === 'paid') {
            // No payment record referenced this sessionId above, so this
            // parcel was already paid through a different session. Reconcile
            // defensively in case that other session's own completion never
            // released the active checkout row.
            await checkoutSessionManager.completeByParcelId(parcel._id.toString());
            return { code: 'ALREADY_PAID_OTHER_SESSION' };
        }

        const trackingId = parcel.trackingId;
        const transactionId = session.payment_intent;
        const paymentRecord = {
            sessionId,
            transactionId,
            parcelId: parcel._id.toString(),
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
                // the parcel document, the client, or Stripe. A missing or
                // invalid owner account aborts before anything is written,
                // mirroring the outcome-object pattern used for every other
                // pre-write conflict in this function.
                const resolvedOwnerRole = await User.findRoleByEmail(parcel.senderEmail, { session: mongoSession });
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
                const updateResult = await collections.parcels.updateOne(
                    { _id: parcel._id, paymentStatus: { $ne: 'paid' }, deliveryStatus: { $ne: 'cancelled' } },
                    { $set: { paymentStatus: 'paid' } },
                    { session: mongoSession }
                );
                if (updateResult.matchedCount === 0) {
                    // Parcel became paid by a concurrent different-session
                    // request between our earlier check and this write.
                    conflict = true;
                    await collections.payments.deleteOne({ _id: insertedId }, { session: mongoSession });
                    return;
                }

                // Same transaction as the payment insert + parcel update - the
                // active checkout slot is released atomically with the payment
                // becoming final, never left dangling as "in progress" once
                // the parcel is actually paid.
                await checkoutSessionManager.completeByParcelId(parcel._id.toString(), mongoSession);

                // Joins this same transaction, reached only on the genuine
                // first-time commit path (never on a conflict/no-op return
                // above, never on the alreadyProcessed fast path, which
                // returns long before any transaction opens). A genuine
                // failure here throws and aborts the whole transaction - no
                // payment document and no paid parcel can commit without it.
                await notifications.createNotification({
                    session: mongoSession,
                    recipientEmail: parcel.senderEmail,
                    recipientRole: resolvedOwnerRole,
                    type: 'payment_confirmed',
                    entityType: 'parcel',
                    entityId: parcel._id.toString(),
                    actorEmail: null,
                    actorRole: null,
                    metadata: { trackingId: parcel.trackingId }
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
                await checkoutSessionManager.completeByParcelId(winner.parcelId);
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
            const latestParcel = await Parcel.findById(parcel._id.toString());
            if (latestParcel && latestParcel.deliveryStatus === 'cancelled') {
                return { code: 'REQUEST_CANCELLED' };
            }
            return { code: 'ALREADY_PAID_OTHER_SESSION' };
        }

        logTracking(collections.trackings, trackingId, 'parcel_paid');

        return {
            code: 'OK',
            alreadyProcessed: false,
            transactionId: committedPayment.transactionId,
            trackingId: committedPayment.trackingId
        };
    };
}

module.exports = { createPaymentProcessor, normalize };
