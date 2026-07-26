const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { ObjectId } = require('mongodb');
const { logTracking } = require('../middleware/logging');
const { client } = require('../config/database');

const EXPECTED_CURRENCY = 'usd';
// Stripe Checkout Session IDs are base62-ish (letters, digits, underscores).
// A generous max length guards against pathological inputs without coupling
// to Stripe's exact internal ID format.
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_]{1,500}$/;

function normalize(value) {
    return (value || '').trim().toLowerCase();
}

class PaymentController {
    constructor(models, collections) {
        this.Payment = models.Payment;
        this.Parcel = models.Parcel;
        this.collections = collections;
    }

    async createCheckoutSession(req, res) {
        try {
            const { parcelId } = req.body;

            if (!parcelId || !ObjectId.isValid(parcelId)) {
                return res.status(400).send({ message: 'invalid or missing parcelId' });
            }

            const parcel = await this.Parcel.findById(parcelId);
            if (!parcel) {
                return res.status(404).send({ message: 'parcel not found' });
            }

            // Only the request's own owner may create a checkout session for
            // it - the authenticated token email is authoritative, never a
            // client-supplied email.
            const ownerEmail = normalize(parcel.senderEmail);
            const callerEmail = normalize(req.decoded_email);
            if (ownerEmail !== callerEmail) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            if (parcel.paymentStatus === 'paid') {
                return res.status(409).send({ message: 'this request has already been paid for' });
            }

            // The Stripe amount always comes from the trusted, server-stored
            // cost - a client-supplied amount is never accepted or used.
            const cost = Number(parcel.cost);
            if (!Number.isFinite(cost) || cost <= 0) {
                return res.status(400).send({ message: 'invalid stored amount for this request' });
            }

            // Controlled rounding to Stripe's smallest currency unit - raw
            // floating-point multiplication (e.g. 19.99 * 100) can produce
            // values like 1998.9999999999998.
            const unitAmount = Math.round(cost * 100);

            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: EXPECTED_CURRENCY,
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
                    parcelId: parcel._id.toString(),
                    trackingId: parcel.trackingId
                },
                customer_email: req.decoded_email,
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            });

            res.send({ url: session.url });
        } catch (error) {
            console.error('Checkout session creation failed:', error.message);
            res.status(500).send({ message: 'Error creating checkout session' });
        }
    }

    // Verifies a completed Stripe Checkout Session server-side and marks the
    // corresponding request paid. The browser only ever supplies the
    // sessionId - every other fact (owner, amount, currency, parcel state)
    // is re-derived from Stripe and MongoDB, never trusted from the client.
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

            const callerEmail = normalize(req.decoded_email);

            // Fast idempotent path: if this exact session was already recorded,
            // return the same result without re-verifying or re-mutating.
            const existingPayment = await this.collections.payments.findOne({ sessionId });
            if (existingPayment) {
                const parcel = await this.Parcel.findById(existingPayment.parcelId);
                if (!parcel || normalize(parcel.senderEmail) !== callerEmail) {
                    return res.status(403).send({ message: 'forbidden access' });
                }
                return res.send({
                    success: true,
                    alreadyProcessed: true,
                    transactionId: existingPayment.transactionId,
                    trackingId: existingPayment.trackingId
                });
            }

            let session;
            try {
                session = await stripe.checkout.sessions.retrieve(sessionId);
            } catch (stripeError) {
                console.error('Stripe session retrieval failed:', stripeError.message);
                return res.status(404).send({ message: 'payment session not found' });
            }

            if (session.mode !== 'payment') {
                return res.status(409).send({ message: 'payment session is not in a valid state' });
            }
            if (session.payment_status !== 'paid') {
                return res.status(409).send({ message: 'payment has not been completed' });
            }

            const parcelId = session.metadata && session.metadata.parcelId;
            if (!parcelId || !ObjectId.isValid(parcelId)) {
                return res.status(404).send({ message: 'repair request could not be identified for this payment' });
            }

            const parcel = await this.Parcel.findById(parcelId);
            if (!parcel) {
                return res.status(404).send({ message: 'repair request not found' });
            }

            // Ownership: the authenticated caller, the stored request owner,
            // and Stripe's own record of who paid must all agree.
            const ownerEmail = normalize(parcel.senderEmail);
            const stripeEmail = normalize(session.customer_email);
            if (callerEmail !== ownerEmail || callerEmail !== stripeEmail) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            const cost = Number(parcel.cost);
            if (!Number.isFinite(cost) || cost <= 0) {
                return res.status(400).send({ message: 'invalid stored amount for this request' });
            }
            const expectedAmount = Math.round(cost * 100);
            if (session.amount_total !== expectedAmount) {
                return res.status(409).send({ message: 'payment amount does not match this request' });
            }
            if (normalize(session.currency) !== EXPECTED_CURRENCY) {
                return res.status(409).send({ message: 'payment currency does not match this request' });
            }

            if (parcel.paymentStatus === 'paid') {
                // No payment record referenced this sessionId above, so this
                // parcel was already paid through a different session.
                return res.status(409).send({ message: 'this request has already been paid for' });
            }

            const trackingId = parcel.trackingId;
            const transactionId = session.payment_intent;
            const paymentRecord = {
                sessionId,
                transactionId,
                parcelId: parcel._id.toString(),
                trackingId,
                customerEmail: callerEmail,
                amount: cost,
                currency: EXPECTED_CURRENCY,
                paymentStatus: 'paid'
            };

            const mongoSession = client.startSession();
            let committedPayment = null;
            let conflict = false;
            try {
                await mongoSession.withTransaction(async () => {
                    let insertedId;
                    try {
                        paymentRecord.paidAt = new Date();
                        const insertResult = await this.collections.payments.insertOne(paymentRecord, { session: mongoSession });
                        insertedId = insertResult.insertedId;
                    } catch (insertError) {
                        if (insertError.code === 11000) {
                            // A concurrent request already recorded this exact
                            // session - treat this call as idempotent, not an error.
                            conflict = true;
                            return;
                        }
                        throw insertError;
                    }

                    // deliveryStatus is intentionally untouched - payment and
                    // repair-lifecycle status are independent concerns.
                    const updateResult = await this.collections.parcels.updateOne(
                        { _id: parcel._id, paymentStatus: { $ne: 'paid' } },
                        { $set: { paymentStatus: 'paid' } },
                        { session: mongoSession }
                    );
                    if (updateResult.matchedCount === 0) {
                        // Parcel became paid by a concurrent different-session
                        // request between our earlier check and this write.
                        conflict = true;
                        await this.collections.payments.deleteOne({ _id: insertedId }, { session: mongoSession });
                        return;
                    }

                    committedPayment = { ...paymentRecord, _id: insertedId };
                });
            } finally {
                await mongoSession.endSession();
            }

            if (conflict) {
                const winner = await this.collections.payments.findOne({ sessionId });
                if (winner) {
                    return res.send({
                        success: true,
                        alreadyProcessed: true,
                        transactionId: winner.transactionId,
                        trackingId: winner.trackingId
                    });
                }
                return res.status(409).send({ message: 'this request has already been paid for' });
            }

            logTracking(this.collections.trackings, trackingId, 'parcel_paid');

            return res.send({
                success: true,
                alreadyProcessed: false,
                transactionId: committedPayment.transactionId,
                trackingId: committedPayment.trackingId
            });
        } catch (error) {
            console.error('Payment success verification failed:', error.message);
            res.status(500).send({ message: 'Error processing payment success' });
        }
    }

    async getAllPayments(req, res) {
        try {
            const email = req.query.email;
            const query = {};

            if (email) {
                query.customerEmail = email;

                // check email address
                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: 'forbidden access' });
                }
            }

            const result = await this.Payment.findAll(query);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching payments', error: error.message });
        }
    }
}

module.exports = PaymentController;

