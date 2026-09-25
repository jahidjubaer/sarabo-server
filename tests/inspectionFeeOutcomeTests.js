// Inspection-fee money outcomes (job-portal phase D). When the repair does not
// go ahead, a paid inspection fee is either refunded in full or kept and split
// 90/10 (technician wallet / Sarabo):
//
//   technician no-show (admin withdraws the missed pickup) -> refund
//   customer cancels >= 2 hours before the visit           -> refund
//   customer cancels later                                 -> kept
//   customer declines the final price                      -> kept
//
// Plus: a refund Stripe did not complete stays pending and an admin can retry
// it. Requests are inserted directly in the state under test; refunds go to an
// injected fake.
const { ObjectId } = require('mongodb');

function fakeRes() {
    return {
        statusCode: 200,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; },
    };
}

async function runInspectionFeeOutcomeTests({ logTest }) {
    const { connectDatabase, collections: c } = require('../config/database');
    const { initializeModels } = require('../models');
    const InspectionFeeController = require('../controllers/inspectionFeeController');
    const MissedPickupController = require('../controllers/missedPickupController');
    const QuoteController = require('../controllers/quoteController');
    const WalletController = require('../controllers/walletController');
    const AdminAttentionController = require('../controllers/adminAttentionController');
    const AdminReportController = require('../controllers/adminReportController');
    const { bookingCancellationOutcome, inspectionFeeSplit, inspectionPaymentView } = require('../utils/inspectionFee');
    const { calculateWallet } = require('../utils/settlement');
    if (process.env.NODE_ENV !== 'test' || !c.repairRequests.dbName.includes('test') || c.repairRequests.dbName === 'sarabo-db') {
        throw new Error('Isolated test database required');
    }
    await connectDatabase();
    const models = initializeModels(c);
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const CUSTOMER = `outcome-customer-${runId}@example.test`;
    const ADMIN = `outcome-admin-${runId}@example.test`;
    const emails = [CUSTOMER, ADMIN];
    const requestIds = [];
    const technicianIds = [];
    const HOUR = 60 * 60 * 1000;
    const FEE = 300;

    const refunds = [];
    let refundsFail = false;
    const refundPayment = async ({ paymentIntentId, idempotencyKey }) => {
        if (refundsFail) throw new Error('stripe is down');
        refunds.push({ paymentIntentId, idempotencyKey });
        return `re_${paymentIntentId}`;
    };
    const fees = new InspectionFeeController(models, c, { refundPayment });
    const missed = new MissedPickupController(models, c, { refundPayment });
    const quotes = new QuoteController(models, c);
    const wallet = new WalletController(models, c);
    const call = async (controller, method, email, req = {}) => {
        const res = fakeRes();
        await controller[method]({ decoded_email: email, decoded_email_verified: true, params: {}, query: {}, body: {}, ...req }, res);
        return res;
    };

    const insertTech = async (name) => {
        const email = `outcome-${name}-${runId}@example.test`;
        emails.push(email);
        await c.users.insertOne({ email, role: 'rider', createdAt: new Date() });
        const { insertedId } = await c.technicians.insertOne({
            name: `${name} ${runId}`, email, region: 'R', district: 'D', status: 'approved', workStatus: 'in_delivery', createdAt: new Date(),
        });
        technicianIds.push(insertedId);
        return { id: insertedId.toString(), email };
    };
    // A request booked with `tech`, its fee paid (and its payments row).
    const insertBooked = async (tech, { deliveryStatus = 'driver_assigned', startsAt, extra = {} } = {}) => {
        const n = requestIds.length;
        const sessionId = `cs_outcome_${runId}_${n}`;
        const paidAt = new Date();
        const doc = {
            schemaVersion: 2, senderEmail: CUSTOMER, trackingId: `OUT-${runId}-${n}`,
            deliveryStatus, technicianId: tech.id, technicianEmail: tech.email, technicianName: 'T',
            pickupSlot: { startsAt, endsAt: new Date(startsAt.getTime() + 2 * HOUR) },
            inspectionPayment: { status: 'paid', amount: FEE, currency: 'BDT', provider: 'stripe', paymentIntentId: `pi_${sessionId}`, sessionId, technicianId: tech.id, paidAt },
            createdAt: new Date(), ...extra,
        };
        const { insertedId } = await c.repairRequests.insertOne(doc);
        requestIds.push(insertedId);
        await c.payments.insertOne({
            sessionId, transactionId: `pi_${sessionId}`, requestId: insertedId.toString(), trackingId: doc.trackingId, customerEmail: CUSTOMER,
            amount: FEE, currency: 'BDT', paymentStatus: 'paid', purpose: 'inspection_fee', technicianId: tech.id, schemaVersion: 2, paidAt,
        });
        return { id: insertedId.toString(), sessionId };
    };
    const load = (id) => c.repairRequests.findOne({ _id: new ObjectId(id) });
    const techOf = (tech) => c.technicians.findOne({ _id: new ObjectId(tech.id) });

    try {
        await c.users.insertMany([
            { email: CUSTOMER, role: 'user', createdAt: new Date() },
            { email: ADMIN, role: 'admin', createdAt: new Date() },
        ]);

        // ---- pure rules ----
        const now = new Date('2099-03-01T10:00:00Z');
        const paid = { inspectionPayment: { status: 'paid', amount: FEE } };
        logTest('Fee outcomes: cancelling 2 hours or more before the visit refunds, later keeps it',
            bookingCancellationOutcome({ ...paid, pickupSlot: { startsAt: new Date(now.getTime() + 2 * HOUR) } }, now).outcome === 'refund'
            && bookingCancellationOutcome({ ...paid, pickupSlot: { startsAt: new Date(now.getTime() + 2 * HOUR - 1) } }, now).outcome === 'kept'
            && bookingCancellationOutcome({ ...paid, pickupSlot: { startsAt: new Date(now.getTime() - HOUR) } }, now).outcome === 'kept');
        logTest('Fee outcomes: no fee paid means nothing to refund or keep; no pickup time on record counts as early',
            bookingCancellationOutcome({ pickupSlot: { startsAt: now } }, now).outcome === 'none'
            && bookingCancellationOutcome({ inspectionPayment: { status: 'refunded', amount: FEE } }, now).outcome === 'none'
            && bookingCancellationOutcome(paid, now).outcome === 'refund');
        const split = inspectionFeeSplit(300);
        const odd = inspectionFeeSplit(305);
        logTest('Fee outcomes: a kept fee is split 90/10 in whole taka, adding up exactly',
            split.technicianReceivable === 270 && split.platformCommission === 30
            && odd.platformCommission + odd.technicianReceivable === 305 && odd.commissionRate === 0.1);
        const view = inspectionPaymentView({ inspectionPayment: { status: 'paid', amount: FEE, paymentIntentId: 'pi_x', sessionId: 'cs_x', technicianId: 't' } });
        logTest('Fee outcomes: the fee shown on a request never carries Stripe ids',
            view.status === 'paid' && view.amount === FEE && !('paymentIntentId' in view) && !('sessionId' in view) && !('technicianId' in view));

        // ---- customer cancels early: full refund ----
        const early = await insertTech('early');
        const e = await insertBooked(early, { startsAt: new Date(Date.now() + 5 * HOUR) });
        const earlyPreview = await call(fees, 'preview', CUSTOMER, { params: { id: e.id } });
        logTest('Fee outcomes: the customer is told beforehand that cancelling now refunds the fee',
            earlyPreview.body.cancellable === true && earlyPreview.body.outcome === 'refund' && earlyPreview.body.fee === FEE);
        const stranger = await call(fees, 'cancelBooking', `nobody-${runId}@example.test`, { params: { id: e.id } });
        logTest('Fee outcomes: nobody else can cancel the visit (reported as not found)',
            stranger.statusCode === 404 && (await load(e.id)).deliveryStatus === 'driver_assigned');
        const earlyCancel = await call(fees, 'cancelBooking', CUSTOMER, { params: { id: e.id } });
        const earlyAfter = await load(e.id);
        logTest('Fee outcomes: an early cancellation cancels the visit and refunds the fee in full',
            earlyCancel.statusCode === 200 && earlyCancel.body.inspectionFee === 'refunded'
            && earlyAfter.deliveryStatus === 'cancelled' && earlyAfter.cancellationReason === 'customer_cancelled_booking'
            && earlyAfter.inspectionPayment.status === 'refunded' && earlyAfter.inspectionPayment.refundReason === 'customer_cancelled'
            && !earlyAfter.inspectionFeeSettlement
            && refunds.length === 1 && refunds[0].paymentIntentId === `pi_${e.sessionId}` && refunds[0].idempotencyKey === `inspection-refund-${e.sessionId}`
            && (await c.payments.findOne({ sessionId: e.sessionId })).refundStatus === 'refunded');
        logTest('Fee outcomes: the technician is freed and told; the customer is told the fee is coming back',
            (await techOf(early)).workStatus === 'available'
            && (await c.notifications.findOne({ recipientEmail: early.email, type: 'booking_cancelled_by_customer', entityId: e.id })).metadata.feeOutcome === 'refunded'
            && (await c.notifications.findOne({ recipientEmail: CUSTOMER, type: 'inspection_fee_refunded', entityId: e.id })).metadata.reason === 'customer_cancelled');
        const twice = await call(fees, 'cancelBooking', CUSTOMER, { params: { id: e.id } });
        logTest('Fee outcomes: cancelling twice refunds nothing more',
            twice.statusCode === 409 && twice.body.code === 'ALREADY_CANCELLED' && refunds.length === 1);

        // ---- customer cancels late: the technician keeps 90% ----
        const late = await insertTech('late');
        const l = await insertBooked(late, { startsAt: new Date(Date.now() + HOUR) });
        const latePreview = await call(fees, 'preview', CUSTOMER, { params: { id: l.id } });
        const lateCancel = await call(fees, 'cancelBooking', CUSTOMER, { params: { id: l.id } });
        const lateAfter = await load(l.id);
        logTest('Fee outcomes: a cancellation less than 2 hours before the visit keeps the fee - 90% to the technician, 10% to Sarabo',
            latePreview.body.outcome === 'kept' && lateCancel.statusCode === 200 && lateCancel.body.inspectionFee === 'kept'
            && lateAfter.deliveryStatus === 'cancelled' && lateAfter.inspectionPayment.status === 'kept' && lateAfter.inspectionPayment.keptReason === 'late_cancellation'
            && lateAfter.inspectionFeeSettlement.technicianReceivable === 270 && lateAfter.inspectionFeeSettlement.platformCommission === 30
            && lateAfter.inspectionFeeSettlement.technicianEmail === late.email && lateAfter.inspectionFeeSettlement.status === 'available'
            && refunds.length === 1 && (await c.payments.findOne({ sessionId: l.sessionId })).refundStatus === undefined);
        const lateWallet = await wallet.loadWallet(late.email);
        const walletRes = fakeRes();
        await wallet.getWallet({ decoded_email: late.email }, walletRes);
        logTest("Fee outcomes: the kept share is in the technician's wallet, ready to withdraw",
            lateWallet.wallet.availableBalance === 270 && lateWallet.wallet.lifetimeReceivable === 270
            && walletRes.body.settlements.length === 1 && walletRes.body.settlements[0].kind === 'inspection_fee'
            && walletRes.body.settlements[0].technicianReceivable === 270 && walletRes.body.settlements[0].reason === 'late_cancellation'
            && (await c.notifications.findOne({ recipientEmail: late.email, type: 'booking_cancelled_by_customer', entityId: l.id })).metadata.feeOutcome === 'kept');
        logTest('Fee outcomes: a repair settlement and a kept fee add up in one wallet',
            calculateWallet({ repairRequests: [
                { technicianSettlement: { status: 'available', technicianReceivable: 900 } },
                { inspectionFeeSettlement: { status: 'available', technicianReceivable: 270 } },
            ] }).availableBalance === 1170);

        // ---- only a booked, fee-paid visit can be cancelled here ----
        const noFee = await insertTech('nofee');
        const n = await insertBooked(noFee, { startsAt: new Date(Date.now() + 5 * HOUR) });
        await c.repairRequests.updateOne({ _id: new ObjectId(n.id) }, { $unset: { inspectionPayment: '' } });
        const noFeeCancel = await call(fees, 'cancelBooking', CUSTOMER, { params: { id: n.id } });
        const pickedUp = await insertBooked(noFee, { deliveryStatus: 'parcel_picked_up', startsAt: new Date(Date.now() + 5 * HOUR) });
        const pickedUpCancel = await call(fees, 'cancelBooking', CUSTOMER, { params: { id: pickedUp.id } });
        logTest('Fee outcomes: a visit without a paid fee, or a device already collected, cannot be cancelled here',
            noFeeCancel.statusCode === 409 && noFeeCancel.body.code === 'BOOKING_NOT_CANCELLABLE'
            && pickedUpCancel.statusCode === 409 && (await load(pickedUp.id)).deliveryStatus === 'parcel_picked_up'
            && (await call(fees, 'preview', CUSTOMER, { params: { id: pickedUp.id } })).body.cancellable === false);

        // ---- customer declines the final price ----
        const decliner = await insertTech('decline');
        const d = await insertBooked(decliner, {
            deliveryStatus: 'quote_rejected', startsAt: new Date(Date.now() - 48 * HOUR),
            extra: { quote: { status: 'rejected', partsAmount: 1000, laborAmount: 500, additionalCharges: 0, totalAmount: 1500 } },
        });
        const closed = await call(quotes, 'cancelAfterQuoteRejection', decliner.email, { params: { id: d.id } });
        const declinedAfter = await load(d.id);
        logTest('Fee outcomes: when the customer declines the final price, the fee is kept - 90% to the technician',
            closed.statusCode === 200 && declinedAfter.deliveryStatus === 'cancelled' && declinedAfter.cancellationReason === 'quote_declined'
            && declinedAfter.inspectionPayment.status === 'kept' && declinedAfter.inspectionPayment.keptReason === 'quote_declined'
            && declinedAfter.inspectionFeeSettlement.reason === 'quote_declined' && declinedAfter.inspectionFeeSettlement.technicianReceivable === 270
            && (await wallet.loadWallet(decliner.email)).wallet.availableBalance === 270 && refunds.length === 1);

        // ---- technician no-show: full refund, portal reopens ----
        const noShow = await insertTech('noshow');
        const other = await insertTech('other');
        const s = await insertBooked(noShow, {
            startsAt: new Date(Date.now() - 5 * HOUR),
            extra: { acceptedApplication: { technicianId: 'x', inspectionFee: FEE }, assignmentHistory: [{ technicianEmail: '', decision: 'accepted' }] },
        });
        await c.repairRequests.updateOne({ _id: new ObjectId(s.id) }, { $set: { 'assignmentHistory.0.technicianEmail': noShow.email } });
        await c.jobApplications.insertMany([
            { requestId: s.id, technicianId: noShow.id, status: 'accepted', inspectionFee: FEE, createdAt: new Date() },
            { requestId: s.id, technicianId: other.id, status: 'not_chosen', inspectionFee: 200, createdAt: new Date() },
        ]);
        const withdrawn = await call(missed, 'withdraw', ADMIN, { params: { id: s.id } });
        const noShowAfter = await load(s.id);
        logTest('Fee outcomes: when the technician does not come, the fee is refunded in full',
            withdrawn.statusCode === 200 && withdrawn.body.inspectionFee === 'refunded'
            && noShowAfter.deliveryStatus === 'pending-pickup' && !noShowAfter.technicianId && !noShowAfter.acceptedApplication
            && noShowAfter.inspectionPayment.status === 'refunded' && noShowAfter.inspectionPayment.refundReason === 'technician_no_show'
            && refunds.length === 2 && refunds[1].idempotencyKey === `inspection-refund-${s.sessionId}`
            && (await c.notifications.findOne({ recipientEmail: CUSTOMER, type: 'inspection_fee_refunded', entityId: s.id })).metadata.reason === 'technician_no_show');
        logTest('Fee outcomes: after a no-show the other applicants can be chosen again, the absent one cannot',
            (await c.jobApplications.findOne({ requestId: s.id, technicianId: other.id })).status === 'pending'
            && (await c.jobApplications.findOne({ requestId: s.id, technicianId: noShow.id })).status === 'no_show');

        // ---- a refund Stripe does not complete stays pending; admin retries ----
        const retry = await insertTech('retry');
        const r = await insertBooked(retry, { startsAt: new Date(Date.now() + 6 * HOUR) });
        refundsFail = true;
        const failedCancel = await call(fees, 'cancelBooking', CUSTOMER, { params: { id: r.id } });
        const pendingRow = await c.payments.findOne({ sessionId: r.sessionId });
        logTest('Fee outcomes: if Stripe fails, the cancellation still stands and the refund is kept pending, not lost',
            failedCancel.statusCode === 200 && failedCancel.body.inspectionFee === 'refund_pending'
            && (await load(r.id)).deliveryStatus === 'cancelled' && (await load(r.id)).inspectionPayment.status === 'refund_pending'
            && pendingRow.refundStatus === 'pending' && pendingRow.lastRefundError === 'stripe is down');
        const attentionRes = fakeRes();
        await new AdminAttentionController(models, c).getAttention({ decoded_email: ADMIN, query: {} }, attentionRes);
        const waitingRefund = attentionRes.body.feeRefunds.find((row) => row.id === r.id);
        logTest('Fee outcomes: a refund waiting on Stripe is on the admin attention list - without the customer or Stripe ids',
            attentionRes.statusCode === 200 && attentionRes.body.counts.feeRefunds >= 1 && waitingRefund
            && waitingRefund.amount === FEE && waitingRefund.reason === 'customer_cancelled' && waitingRefund.lastAttemptAt
            && !('customerEmail' in waitingRefund) && !('transactionId' in waitingRefund) && !('sessionId' in waitingRefund));
        const stillFailing = await call(fees, 'retryRefund', ADMIN, { params: { id: r.id } });
        refundsFail = false;
        const retried = await call(fees, 'retryRefund', ADMIN, { params: { id: r.id } });
        logTest('Fee outcomes: an admin retries the pending refund once Stripe is back - same idempotency key',
            stillFailing.statusCode === 502 && stillFailing.body.stillPending === 1
            && retried.statusCode === 200 && retried.body.refunded === 1
            && (await load(r.id)).inspectionPayment.status === 'refunded' && (await c.payments.findOne({ sessionId: r.sessionId })).refundStatus === 'refunded'
            && refunds[refunds.length - 1].idempotencyKey === `inspection-refund-${r.sessionId}`);
        const nothingLeft = await call(fees, 'retryRefund', ADMIN, { params: { id: r.id } });
        logTest('Fee outcomes: with nothing pending, a retry refunds nothing',
            nothingLeft.statusCode === 409 && nothingLeft.body.code === 'NO_REFUND_PENDING' && refunds.length === 3);
        const afterRetry = fakeRes();
        await new AdminAttentionController(models, c).getAttention({ decoded_email: ADMIN, query: {} }, afterRetry);
        logTest('Fee outcomes: once refunded, it leaves the attention list',
            !afterRetry.body.feeRefunds.some((row) => row.id === r.id));

        // ---- reports: fee money in the period (a far-future week of its own) ----
        const at = (day) => new Date(`2098-06-${day}T06:00:00Z`);
        const reportTech = await insertTech('report');
        const paidIn = await insertBooked(reportTech, { startsAt: at('10') });
        const refundedIn = await insertBooked(reportTech, { startsAt: at('10') });
        const keptIn = await insertBooked(reportTech, { startsAt: at('10') });
        const pendingNow = await insertBooked(reportTech, { startsAt: at('10') });
        const before = await insertBooked(reportTech, { startsAt: at('01') });
        for (const row of [paidIn, refundedIn, keptIn, pendingNow]) await c.payments.updateOne({ sessionId: row.sessionId }, { $set: { paidAt: at('10') } });
        await c.payments.updateOne({ sessionId: before.sessionId }, { $set: { paidAt: at('01') } });
        await c.payments.updateOne({ sessionId: refundedIn.sessionId }, { $set: { refundStatus: 'refunded', refundedAt: at('11') } });
        await c.payments.updateOne({ sessionId: pendingNow.sessionId }, { $set: { refundStatus: 'pending' } });
        await c.repairRequests.updateOne({ _id: new ObjectId(keptIn.id) }, { $set: { inspectionFeeSettlement: {
            status: 'available', reason: 'quote_declined', feeAmount: FEE, platformCommission: 30, technicianReceivable: 270, settledAt: at('12'),
        } } });
        const reportRes = fakeRes();
        await new AdminReportController(models, c, { now: () => at('14') }).getReport({ decoded_email: ADMIN, query: { days: '7' } }, reportRes);
        const money = reportRes.body.inspectionFees;
        logTest('Fee outcomes: the report counts fees paid, refunded and kept in the period, with the 90/10 split',
            reportRes.statusCode === 200
            && money.paid.count === 4 && money.paid.amount === 4 * FEE
            && money.refunded.count === 1 && money.refunded.amount === FEE
            && money.kept.count === 1 && money.kept.technicianShare === 270 && money.kept.saraboShare === 30
            && money.kept.quoteDeclined === 1 && money.kept.lateCancellations === 0
            && money.refundPending.count >= 1);
    } finally {
        const ids = requestIds.map(String);
        await c.payments.deleteMany({ requestId: { $in: ids } });
        await c.jobApplications.deleteMany({ requestId: { $in: ids } });
        await c.notifications.deleteMany({ entityId: { $in: ids } });
        if (requestIds.length) {
            const tracking = (await c.repairRequests.find({ _id: { $in: requestIds } }, { projection: { trackingId: 1 } }).toArray()).map((row) => row.trackingId);
            await c.trackingEvents.deleteMany({ trackingId: { $in: tracking } });
            await c.repairRequests.deleteMany({ _id: { $in: requestIds } });
        }
        if (technicianIds.length) await c.technicians.deleteMany({ _id: { $in: technicianIds } });
        await c.users.deleteMany({ email: { $in: emails } });
    }
}

module.exports = { runInspectionFeeOutcomeTests };
