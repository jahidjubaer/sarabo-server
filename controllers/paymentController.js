const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { ObjectId } = require('mongodb');
const { createPaymentProcessor, normalize } = require('../services/paymentProcessor');
const { createCheckoutSessionManager } = require('../services/checkoutSessionManager');
const { getPaymentEligibility } = require('../services/paymentEligibility');
const { createNotificationService } = require('../services/notificationService');
const { PAYMENT_CURRENCY, toSmallestUnit } = require('../config/paymentConfig');

// Stripe Checkout Session IDs are base62-ish (letters, digits, underscores).
// A generous max length guards against pathological inputs without coupling
// to Stripe's exact internal ID format.
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_]{1,500}$/;

class PaymentController {
    constructor(models, collections) {
        this.Payment = models.Payment;
        this.Parcel = models.Parcel;
        this.User = models.User;
        this.collections = collections;
        // Same notification-service construction parcelController.js already
        // uses - injected into the payment processor rather than required
        // from within services/paymentProcessor.js itself, since
        // services/notificationService.js requires paymentProcessor.js back
        // for `normalize` and a direct require here would create a cycle.
        this.notifications = createNotificationService(models);
        // Shared with the Stripe webhook handler below - exactly one place
        // validates a Checkout Session and records a payment for it.
        this.processCheckoutSession = createPaymentProcessor(models, collections, this.notifications);
        // Guards against duplicate concurrent Stripe Checkout Sessions for
        // the same parcel - see services/checkoutSessionManager.js.
        this.checkoutSessions = createCheckoutSessionManager(collections);
    }

    async createCheckoutSession(req, res) {
        try {
            const { parcelId: rawParcelId } = req.body;

            if (!rawParcelId || !ObjectId.isValid(rawParcelId)) {
                return res.status(400).send({ message: 'invalid or missing repair request id' });
            }

            const parcel = await this.Parcel.findById(rawParcelId);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found' });
            }

            // Only the request's own owner may create a checkout session for
            // it - the authenticated token email is authoritative, never a
            // client-supplied email.
            const ownerEmail = normalize(parcel.senderEmail);
            const callerEmail = normalize(req.decoded_email);
            if (ownerEmail !== callerEmail) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            // Centralizes every parcel-state-only eligibility rule (already
            // paid, permitted lifecycle status, valid stored cost) - see
            // services/paymentEligibility.js. Must run before any checkout-
            // session slot is claimed or Stripe is called, but this same
            // check is never applied to webhook/browser-success completion,
            // which must remain able to finalize a session created earlier
            // even if the repair lifecycle has since moved on.
            const eligibility = getPaymentEligibility(parcel);
            if (!eligibility.eligible) {
                const statusByCode = { ALREADY_PAID: 409, PAYMENT_NOT_AVAILABLE: 409, INVALID_PAYMENT_AMOUNT: 400 };
                return res.status(statusByCode[eligibility.code] || 400).send({
                    message: eligibility.reason,
                    code: eligibility.code
                });
            }

            // The Stripe amount always comes from the trusted, server-stored
            // cost - a client-supplied amount is never accepted or used.
            const cost = eligibility.cost;
            const unitAmount = toSmallestUnit(cost);
            const parcelId = parcel._id.toString();

            const conflictResponse = () => res.status(409).send({
                message: 'a checkout session is already being created for this request, please try again shortly',
                code: 'CHECKOUT_CREATION_IN_PROGRESS'
            });

            // Reuse an existing, still-open Stripe Checkout Session for this
            // parcel if one exists - this is what prevents multiple tabs,
            // rapid retries, or concurrent requests from spawning multiple
            // live Stripe sessions for the same repair request.
            const activeRow = await this.checkoutSessions.findActive(parcelId);
            if (activeRow) {
                if (activeRow.status === 'creating') {
                    return conflictResponse();
                }
                // status === 'open' - always retrieve the live session from
                // Stripe itself (never a locally stored copy) both to obtain
                // a fresh URL (never persisted at rest) and to double-check
                // it is genuinely still open before reusing it.
                try {
                    const existingSession = await stripe.checkout.sessions.retrieve(activeRow.sessionId);
                    if (existingSession.status === 'open' && existingSession.url) {
                        return res.send({ url: existingSession.url, reused: true });
                    }
                } catch (stripeError) {
                    console.error('Stripe session retrieval failed during reuse check:', stripeError.message);
                }
                // Stripe disagrees with our record (already completed/expired,
                // or unreachable) - release the stale slot and fall through
                // to create a fresh session below.
                await this.checkoutSessions.markFailed(activeRow._id);
            }

            const claimResult = await this.checkoutSessions.claim({
                parcelId, ownerEmail, amount: cost, currency: PAYMENT_CURRENCY
            });
            if (!claimResult.claimed) {
                // Lost the race to another concurrent request between the
                // findActive() check above and this claim attempt - the
                // unique partial index on checkoutSessions is the real guard.
                return conflictResponse();
            }

            let session;
            try {
                session = await stripe.checkout.sessions.create(
                    {
                        line_items: [
                            {
                                price_data: {
                                    currency: PAYMENT_CURRENCY,
                                    unit_amount: unitAmount,
                                    product_data: {
                                        name: `Repair request: ${parcel.parcelName}`
                                    }
                                },
                                quantity: 1,
                            },
                        ],
                        mode: 'payment',
                        metadata: {
                            parcelId,
                            trackingId: parcel.trackingId
                        },
                        customer_email: req.decoded_email,
                        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
                    },
                    // Ties this Stripe API call to our own claim record, so a
                    // network-level retry of this exact request (e.g. our own
                    // process retrying after a timeout) reuses the same
                    // Stripe session instead of creating a second one.
                    { idempotencyKey: `checkout-create-${claimResult.id.toString()}` }
                );
            } catch (stripeError) {
                console.error('Checkout session creation failed:', stripeError.message);
                // Release the slot - a failed Stripe call must never
                // permanently lock the parcel out of future checkout attempts.
                await this.checkoutSessions.markFailed(claimResult.id);
                return res.status(500).send({ message: 'Error creating checkout session' });
            }

            const expiresAt = session.expires_at
                ? new Date(session.expires_at * 1000)
                : new Date(Date.now() + 24 * 60 * 60 * 1000);
            try {
                await this.checkoutSessions.markOpen(claimResult.id, { sessionId: session.id, expiresAt });
            } catch (dbError) {
                // The Stripe session itself is real and valid regardless of
                // whether we could record it - never block a customer from
                // paying because of our own bookkeeping. The claim row stays
                // 'creating' and will be reclaimed by the TTL check in
                // findActive() once it goes stale, at worst allowing one
                // extra session to be created next time.
                console.error('Failed to persist checkout session record:', dbError.message);
            }

            res.send({ url: session.url, reused: false });
        } catch (error) {
            console.error('Checkout session creation failed:', error.message);
            res.status(500).send({ message: 'Error creating checkout session' });
        }
    }

    // Verifies a completed Stripe Checkout Session server-side and marks the
    // corresponding request paid. The browser only ever supplies the
    // sessionId - every other fact (owner, amount, currency, parcel state)
    // is re-derived from Stripe and MongoDB, never trusted from the client.
    // This remains a transitional fallback alongside the Stripe webhook
    // (handleStripeWebhook below), which is the authoritative completion
    // path - both funnel into the same idempotent processCheckoutSession.
    async handlePaymentSuccess(req, res) {
        try {
            const rawSessionId = req.body.sessionId;

            if (typeof rawSessionId !== 'string') {
                return res.status(400).send({ message: 'invalid or missing sessionId' });
            }
            const sessionId = rawSessionId.trim();
            if (!SESSION_ID_PATTERN.test(sessionId)) {
                return res.status(400).send({ message: 'invalid or missing sessionId' });
            }

            let session;
            try {
                session = await stripe.checkout.sessions.retrieve(sessionId);
            } catch (stripeError) {
                console.error('Stripe session retrieval failed:', stripeError.message);
                return res.status(404).send({ message: 'payment session not found' });
            }

            const result = await this.processCheckoutSession({
                session,
                source: 'browser-verification',
                callerEmail: req.decoded_email
            });

            switch (result.code) {
                case 'OK':
                    return res.send({
                        success: true,
                        alreadyProcessed: result.alreadyProcessed,
                        transactionId: result.transactionId,
                        trackingId: result.trackingId
                    });
                case 'OWNERSHIP_MISMATCH':
                    return res.status(403).send({ message: 'forbidden access' });
                case 'MISSING_METADATA':
                case 'PARCEL_NOT_FOUND':
                    return res.status(404).send({ message: 'repair request not found' });
                case 'INVALID_STORED_COST':
                    return res.status(400).send({ message: 'invalid stored amount for this request' });
                case 'INVALID_SESSION_SHAPE':
                    return res.status(409).send({ message: 'payment session is not in a valid state' });
                case 'NOT_PAID':
                    return res.status(409).send({ message: 'payment has not been completed' });
                case 'AMOUNT_MISMATCH':
                    return res.status(409).send({ message: 'payment amount does not match this request' });
                case 'CURRENCY_MISMATCH':
                    return res.status(409).send({ message: 'payment currency does not match this request' });
                case 'ALREADY_PAID_OTHER_SESSION':
                    return res.status(409).send({ message: 'this request has already been paid for' });
                case 'REQUEST_CANCELLED':
                    return res.status(409).send({ message: 'this request has been cancelled and cannot be paid for', code: 'REQUEST_CANCELLED' });
                case 'REPAIR_OWNER_ROLE_UNRESOLVED':
                    return res.status(409).send({ message: 'repair request owner account could not be verified', code: 'REPAIR_OWNER_ROLE_UNRESOLVED' });
                default:
                    return res.status(500).send({ message: 'Error processing payment success' });
            }
        } catch (error) {
            console.error('Payment success verification failed:', error.message);
            res.status(500).send({ message: 'Error processing payment success' });
        }
    }

    // Authoritative payment-completion path: Stripe calls this directly,
    // independent of whether the customer's browser ever reaches the success
    // page. Authenticity comes entirely from the Stripe signature (never a
    // Firebase token, never trusting the parsed JSON body itself), and
    // req.body must still be the raw, unparsed Buffer express.raw() produced
    // (see routes/paymentWebhook.js) - constructEvent recomputes the
    // signature over these exact bytes.
    async handleStripeWebhook(req, res) {
        const signature = req.headers['stripe-signature'];
        if (!signature) {
            return res.status(400).send({ message: 'missing stripe-signature header' });
        }
        if (!process.env.STRIPE_WEBHOOK_SECRET) {
            console.error('STRIPE_WEBHOOK_SECRET is not configured');
            return res.status(500).send({ message: 'webhook not configured' });
        }

        let event;
        try {
            event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
        } catch (err) {
            console.error('Stripe webhook signature verification failed:', err.message);
            return res.status(400).send({ message: 'invalid signature' });
        }

        if (event.type !== 'checkout.session.completed') {
            // Any other valid, signed event type is acknowledged and ignored -
            // no mutation, no error. checkout.session.async_payment_succeeded
            // is deliberately not handled: this project's Checkout Sessions
            // never enable an async payment method, so Stripe cannot produce
            // that event for a session created here.
            return res.status(200).send({ received: true, ignored: true, type: event.type });
        }

        try {
            const session = event.data.object;
            const result = await this.processCheckoutSession({ session, source: 'webhook' });
            console.log(`Stripe webhook ${event.id} (${event.type}) -> ${result.code}`);

            // Every outcome here - success, idempotent replay, or a permanent
            // business-data conflict (bad ownership/amount/currency/already
            // paid) - is acknowledged with 200. None of these will ever
            // change on retry, so asking Stripe to redeliver would only
            // waste its retry budget. Only an unexpected/transient failure
            // (caught below) asks for a retry.
            return res.status(200).send({ received: true, result: result.code });
        } catch (err) {
            console.error('Stripe webhook processing failed:', err.message);
            return res.status(500).send({ message: 'processing failed' });
        }
    }

    // Non-admin callers are always scoped to their own identity - an
    // omitted `email` query must never fall through to "every payment in
    // the system" (that was the actual vulnerability: the old code only
    // checked ownership when an email was supplied at all). Only an admin
    // may see other customers' payments, optionally filtered by email.
    async getAllPayments(req, res) {
        try {
            const requesterEmail = req.decoded_email;
            const requestedEmail = req.query.email;
            const currentUser = await this.User.findByEmail(requesterEmail);
            const role = currentUser?.role;

            if (role === 'rider') {
                // No legitimate technician-facing view needs payment records.
                return res.status(403).send({ message: 'forbidden access', code: 'FORBIDDEN' });
            }

            const query = {};
            if (role === 'admin') {
                if (requestedEmail) {
                    query.customerEmail = requestedEmail;
                }
            } else {
                if (requestedEmail && requestedEmail !== requesterEmail) {
                    return res.status(403).send({ message: 'forbidden access', code: 'FORBIDDEN' });
                }
                query.customerEmail = requesterEmail;
            }

            const result = await this.Payment.findAll(query);
            // The raw Stripe checkout session id is an internal reference no
            // client consumer uses - never included in the response.
            const sanitized = result.map(({ sessionId, ...rest }) => rest);
            res.send(sanitized);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching payments', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = PaymentController;
