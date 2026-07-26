const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { ObjectId } = require('mongodb');
const { logTracking } = require('../middleware/logging');

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
            const ownerEmail = (parcel.senderEmail || '').toLowerCase();
            const callerEmail = (req.decoded_email || '').toLowerCase();
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
                            currency: 'usd',
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

    async handlePaymentSuccess(req, res) {
        try {
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);

            const transactionId = session.payment_intent;
            const paymentExist = await this.Payment.findByTransactionId(transactionId);
            
            if (paymentExist) {
                return res.send({
                    message: 'already exists',
                    transactionId,
                    trackingId: paymentExist.trackingId
                });
            }

            const trackingId = session.metadata.trackingId;

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const update = {
                    paymentStatus: 'paid',
                    deliveryStatus: 'pending-pickup'
                };

                const result = await this.Parcel.update(id, update);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    trackingId: trackingId
                };

                const resultPayment = await this.Payment.create(payment);
                logTracking(this.collections.trackings, trackingId, 'parcel_paid');

                return res.send({
                    success: true,
                    modifyParcel: result,
                    trackingId: trackingId,
                    transactionId: session.payment_intent,
                    paymentInfo: resultPayment
                });
            }
            
            return res.send({ success: false });
        } catch (error) {
            res.status(500).send({ message: 'Error processing payment success', error: error.message });
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

