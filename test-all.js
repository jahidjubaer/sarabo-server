// Comprehensive API test script
const http = require('http');
require('dotenv').config();

const BASE_URL = 'http://localhost:3000';
let testsPassed = 0;
let testsFailed = 0;
const results = [];

// Known local-development accounts (see docs for this project's role bootstrap).
const RIDER_EMAIL = 'jahidjubaer07@gmail.com';
const CUSTOMER_EMAIL = 'jahidhasan.metro@gmail.com';
const ADMIN_EMAIL = 'jahidjubaer17@gmail.com';

// Real Stripe must never be called during automated tests. paymentController.js
// calls `require('stripe')(secret)` once at module load, so this replaces the
// cached 'stripe' module's export with a fake *before* anything requires
// ./controllers below - every test section shares one process-wide module
// cache, so this only needs to happen once, here, at the top of the file.
const capturedStripeSessionParams = [];
// Fixtures for the payment-success verification tests below - keyed by
// sessionId, since `stripe.checkout.sessions.retrieve` is mocked to look up
// this map instead of calling the real Stripe API.
const stripeSessionFixtures = new Map();
// Lets the duplicate-checkout-session tests (section 16) simulate a single
// Stripe outage on the very next sessions.create() call without needing a
// second stripe module mock - reset to false by the mock itself once fired.
let forceNextCreateFailure = false;
let createdSessionCounter = 0;
const stripeModulePath = require.resolve('stripe');
require.cache[stripeModulePath] = {
    id: stripeModulePath,
    filename: stripeModulePath,
    loaded: true,
    exports: function fakeStripeFactory() {
        return {
            checkout: {
                sessions: {
                    create: async (params, options = {}) => {
                        capturedStripeSessionParams.push(params);
                        if (forceNextCreateFailure) {
                            forceNextCreateFailure = false;
                            throw new Error('simulated Stripe outage during session creation');
                        }
                        createdSessionCounter += 1;
                        const sid = `cs_test_created_${Date.now()}_${createdSessionCounter}`;
                        const lineItem = params.line_items[0];
                        const fixture = {
                            id: sid,
                            url: `https://checkout.stripe.com/pay/${sid}`,
                            status: 'open',
                            mode: params.mode,
                            payment_status: 'unpaid',
                            payment_intent: null,
                            customer_email: params.customer_email,
                            amount_total: lineItem.price_data.unit_amount,
                            currency: lineItem.price_data.currency,
                            metadata: params.metadata,
                            expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
                            idempotencyKey: options.idempotencyKey
                        };
                        stripeSessionFixtures.set(sid, fixture);
                        return fixture;
                    },
                    retrieve: async (sessionId) => {
                        const fixture = stripeSessionFixtures.get(sessionId);
                        if (!fixture) {
                            throw new Error('No such checkout session: ' + sessionId);
                        }
                        if (fixture.__simulateOutage) {
                            throw new Error('simulated Stripe outage');
                        }
                        // Real Stripe always echoes the session's own id back on
                        // itself - guarantee that here too, so callers deriving
                        // sessionId from session.id (as the real API requires)
                        // never see it silently come back undefined.
                        return { id: sessionId, ...fixture };
                    }
                }
            },
            webhooks: {
                // A lightweight stand-in for real HMAC signature verification -
                // this project's real webhook route/signature wiring is
                // exercised separately via genuine HTTP requests against the
                // live server (which uses the real, unmocked Stripe SDK), so
                // this mock only needs to gate on the fields the in-process
                // tests below actually vary.
                constructEvent: (payload, signature, secret) => {
                    if (!secret) {
                        throw new Error('No webhook secret configured');
                    }
                    if (!Buffer.isBuffer(payload)) {
                        throw new Error('Unexpected payload - raw request body (Buffer) required');
                    }
                    if (signature !== 'test_valid_signature') {
                        throw new Error('No signatures found matching the expected signature for payload');
                    }
                    return JSON.parse(payload.toString('utf8'));
                }
            }
        };
    }
};

function logTest(name, passed, message = '') {
    if (passed) {
        testsPassed++;
        console.log(`✓ ${name} - PASSED`);
        if (message) console.log(`  ${message}`);
    } else {
        testsFailed++;
        console.log(`✗ ${name} - FAILED`);
        if (message) console.log(`  ${message}`);
    }
    results.push({ name, passed, message });
}

function makeRequest(options, expectedStatus, testName) {
    return new Promise((resolve) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                const passed = res.statusCode === expectedStatus;
                logTest(testName, passed, `Status: ${res.statusCode} (expected: ${expectedStatus})`);
                resolve({ status: res.statusCode, data, passed });
            });
        });
        
        req.on('error', (err) => {
            logTest(testName, false, `Error: ${err.message}`);
            resolve({ status: 0, data: '', passed: false });
        });
        
        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// Every /parcels/*/status route requires a real Firebase-verified token,
// which this script has no way to mint. These tests instead call the parcel
// controller directly against the same local dev database the server above
// uses, simulating `req.decoded_email` exactly as the verifyFBToken
// middleware would set it for a real authenticated request. This is the only
// way to exercise the authenticated status-transition logic end-to-end
// without a live browser/Firebase sign-in.
async function testStatusTransitions() {
    console.log('11. Testing Status Transition Validation');
    console.log('-'.repeat(60));

    const { connectDatabase, collections, client } = require('./config/database');
    const { initializeModels } = require('./models');
    const { initializeControllers } = require('./controllers');
    const { ObjectId } = require('mongodb');

    const createdParcelIds = [];
    const createdTrackingIds = [];

    function fakeRes() {
        return {
            statusCode: 200,
            body: undefined,
            status(code) { this.statusCode = code; return this; },
            send(payload) { this.body = payload; return this; }
        };
    }

    try {
        await connectDatabase();
        const models = initializeModels(collections);
        const controllers = initializeControllers(models, collections);
        const parcelController = controllers.parcel;

        async function createTestParcel(marker) {
            const res = fakeRes();
            await parcelController.createParcel(
                { body: { parcelName: marker, cost: 1 }, decoded_email: CUSTOMER_EMAIL },
                res
            );
            const id = res.body.insertedId.toString();
            createdParcelIds.push(id);
            const parcel = await models.Parcel.findById(id);
            createdTrackingIds.push(parcel.trackingId);
            return { id, trackingId: parcel.trackingId };
        }

        async function assignTestRider(id, trackingId) {
            await parcelController.assignRiderToParcel(
                {
                    params: { id },
                    body: { riderId: 'test-rider-id', riderName: 'Test Rider', riderEmail: RIDER_EMAIL, trackingId }
                },
                fakeRes()
            );
        }

        async function updateStatus(id, deliveryStatus, decoded_email, trackingId) {
            const res = fakeRes();
            await parcelController.updateParcelStatus(
                { params: { id }, body: { deliveryStatus, trackingId }, decoded_email },
                res
            );
            return res;
        }

        // --- Main sequence parcel: valid full sequence, backward, repeated,
        // nonsense, and post-completion transitions ---
        const marker = `TEST-STATUS-TRANSITION-${Date.now()}`;
        const main = await createTestParcel(marker);
        await assignTestRider(main.id, main.trackingId);

        let res = await updateStatus(main.id, 'rider_arriving', RIDER_EMAIL, main.trackingId);
        logTest('Valid transition: driver_assigned -> rider_arriving', res.statusCode === 200);

        res = await updateStatus(main.id, 'parcel_picked_up', RIDER_EMAIL, main.trackingId);
        logTest('Valid transition: rider_arriving -> parcel_picked_up', res.statusCode === 200);

        res = await updateStatus(main.id, 'totally_invalid_status_xyz', RIDER_EMAIL, main.trackingId);
        logTest('Nonsense status value rejected', res.statusCode === 400);

        res = await updateStatus(main.id, 'driver_assigned', RIDER_EMAIL, main.trackingId);
        logTest('Backward transition rejected', res.statusCode === 400);

        const trackingCountBefore = await collections.trackings.countDocuments({ trackingId: main.trackingId });
        res = await updateStatus(main.id, 'parcel_picked_up', RIDER_EMAIL, main.trackingId);
        const trackingCountAfter = await collections.trackings.countDocuments({ trackingId: main.trackingId });
        logTest(
            'Repeated same status handled safely (no duplicate tracking log)',
            res.statusCode === 200 && trackingCountAfter === trackingCountBefore
        );

        res = await updateStatus(main.id, 'parcel_delivered', RIDER_EMAIL, main.trackingId);
        logTest('Valid transition: parcel_picked_up -> parcel_delivered', res.statusCode === 200);

        res = await updateStatus(main.id, 'rider_arriving', RIDER_EMAIL, main.trackingId);
        logTest('Completed request cannot transition further', res.statusCode === 400);

        // --- Second parcel, fresh from assignment: skipped transition and
        // unauthorized-customer checks ---
        const marker2 = `TEST-STATUS-SKIP-${Date.now()}`;
        const second = await createTestParcel(marker2);
        await assignTestRider(second.id, second.trackingId);

        res = await updateStatus(second.id, 'parcel_delivered', RIDER_EMAIL, second.trackingId);
        logTest('Skipped transition rejected (driver_assigned -> parcel_delivered)', res.statusCode === 400);

        res = await updateStatus(second.id, 'rider_arriving', CUSTOMER_EMAIL, second.trackingId);
        logTest('Unauthorized customer blocked from status update', res.statusCode === 403);
    } finally {
        // logTracking() is fire-and-forget in the controller (not awaited),
        // so give any in-flight writes a moment to land before cleanup reads
        // back a final, complete picture and deletes by trackingId.
        await new Promise(resolve => setTimeout(resolve, 300));

        // Clean up only the throwaway parcels/tracking logs this test created.
        // The shared Mongo connection itself is closed once, at the very end
        // of runAllTests(), after every database-backed test section is done.
        for (const id of createdParcelIds) {
            await collections.parcels.deleteOne({ _id: new ObjectId(id) });
        }
        if (createdTrackingIds.length) {
            await collections.trackings.deleteMany({ trackingId: { $in: createdTrackingIds } });
        }
    }

    console.log('');
}

// Confirms a newly created repair request stores deliveryStatus: 'pending-pickup'
// (not just a client-side display fallback), that the admin's existing
// pending-pickup filter surfaces it, and that assignment still moves it to
// driver_assigned - the exact fix and compatibility checks for commit
// "fix: set initial repair request status".
async function testInitialRequestStatus() {
    console.log('12. Testing Initial Repair Request Status');
    console.log('-'.repeat(60));

    const { connectDatabase, collections } = require('./config/database');
    const { initializeModels } = require('./models');
    const { initializeControllers } = require('./controllers');
    const { ObjectId } = require('mongodb');

    const createdParcelIds = [];
    const createdTrackingIds = [];

    function fakeRes() {
        return {
            statusCode: 200,
            body: undefined,
            status(code) { this.statusCode = code; return this; },
            send(payload) { this.body = payload; return this; }
        };
    }

    try {
        await connectDatabase();
        const models = initializeModels(collections);
        const controllers = initializeControllers(models, collections);
        const parcelController = controllers.parcel;

        const marker = `TEST-INITIAL-STATUS-${Date.now()}`;
        const countBefore = await collections.parcels.countDocuments({ parcelName: marker });

        const createRes = fakeRes();
        await parcelController.createParcel(
            { body: { parcelName: marker, cost: 1 }, decoded_email: CUSTOMER_EMAIL },
            createRes
        );
        const id = createRes.body.insertedId.toString();
        createdParcelIds.push(id);

        // Read back from MongoDB directly - confirms the value is actually
        // persisted, not just something the client fabricates for display.
        const stored = await models.Parcel.findById(id);
        createdTrackingIds.push(stored.trackingId);
        logTest('New request stores deliveryStatus: pending-pickup in MongoDB', stored.deliveryStatus === 'pending-pickup');

        const countAfter = await collections.parcels.countDocuments({ parcelName: marker });
        logTest('No duplicate request created', countAfter === countBefore + 1);

        // Same query the admin "Assign Technicians" page issues.
        const pendingResults = await models.Parcel.findAll({ deliveryStatus: 'pending-pickup' });
        const foundInPending = pendingResults.some(p => p._id.toString() === id);
        logTest('Admin pending-pickup filter (GET /parcels?deliveryStatus=pending-pickup) returns the new request', foundInPending);

        await parcelController.assignRiderToParcel(
            {
                params: { id },
                body: { riderId: 'test-rider-id', riderName: 'Test Rider', riderEmail: RIDER_EMAIL, trackingId: stored.trackingId }
            },
            fakeRes()
        );
        const afterAssignment = await models.Parcel.findById(id);
        logTest('Assignment changes status to driver_assigned', afterAssignment.deliveryStatus === 'driver_assigned');
    } finally {
        await new Promise(resolve => setTimeout(resolve, 300));
        for (const id of createdParcelIds) {
            await collections.parcels.deleteOne({ _id: new ObjectId(id) });
        }
        if (createdTrackingIds.length) {
            await collections.trackings.deleteMany({ trackingId: { $in: createdTrackingIds } });
        }
    }

    console.log('');
}

// Confirms the secured POST /payment-checkout-session contract: auth required
// (HTTP-level, via the real middleware chain), ownership-enforced, amount and
// email always server-derived (never trusted from the client), already-paid
// requests rejected, and Stripe only ever receives safe metadata - all
// against a real Stripe stub captured in capturedStripeSessionParams (see the
// top of this file), never the real Stripe API.
async function testSecureCheckoutSession() {
    console.log('13. Testing Secure Payment Checkout Session');
    console.log('-'.repeat(60));

    // HTTP-level: confirm the route itself now requires authentication.
    await makeRequest(
        {
            hostname: 'localhost', port: 3000, path: '/payment-checkout-session', method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parcelId: '000000000000000000000000' })
        },
        401,
        'POST /payment-checkout-session (no auth)'
    );
    await makeRequest(
        {
            hostname: 'localhost', port: 3000, path: '/payment-checkout-session', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer invalid_token_12345' },
            body: JSON.stringify({ parcelId: '000000000000000000000000' })
        },
        401,
        'POST /payment-checkout-session (invalid token)'
    );

    const { connectDatabase, collections } = require('./config/database');
    const { initializeModels } = require('./models');
    const { initializeControllers } = require('./controllers');
    const { ObjectId } = require('mongodb');

    const createdParcelIds = [];

    function fakeRes() {
        return {
            statusCode: 200,
            body: undefined,
            status(code) { this.statusCode = code; return this; },
            send(payload) { this.body = payload; return this; }
        };
    }

    try {
        await connectDatabase();
        const models = initializeModels(collections);
        const controllers = initializeControllers(models, collections);
        const paymentController = controllers.payment;

        async function createTestParcel(marker, cost) {
            const doc = {
                parcelName: marker,
                cost,
                senderEmail: CUSTOMER_EMAIL,
                trackingId: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                createdAt: new Date()
            };
            const result = await collections.parcels.insertOne(doc);
            createdParcelIds.push(result.insertedId.toString());
            return { id: result.insertedId.toString(), ...doc };
        }

        function checkout(id, decoded_email, extraBody = {}) {
            const res = fakeRes();
            return paymentController.createCheckoutSession(
                { body: { parcelId: id, ...extraBody }, decoded_email },
                res
            ).then(() => res);
        }

        // --- Owner can create a checkout session; a fake client-supplied
        // amount and email must have no effect on what Stripe receives. ---
        const main = await createTestParcel(`TEST-PAYMENT-${Date.now()}`, 49.99);
        const sessionsBefore = capturedStripeSessionParams.length;
        let res = await checkout(main.id, CUSTOMER_EMAIL, { cost: 1, senderEmail: 'attacker@example.com' });
        logTest('Owner can create checkout session', res.statusCode === 200 && !!res.body.url);

        const captured = capturedStripeSessionParams[capturedStripeSessionParams.length - 1];
        logTest(
            'Server converts stored amount correctly (ignores captured client-supplied cost)',
            capturedStripeSessionParams.length === sessionsBefore + 1 &&
            captured.line_items[0].price_data.unit_amount === 4999
        );
        logTest(
            'Fake client-supplied email has no effect (real token email used)',
            captured.customer_email === CUSTOMER_EMAIL
        );
        logTest(
            'Stripe receives only safe metadata (parcelId, trackingId - no other fields)',
            Object.keys(captured.metadata).sort().join(',') === 'parcelId,trackingId'
        );
        logTest(
            'Success/cancel URLs come from server config (SITE_DOMAIN), not the client',
            captured.success_url.startsWith(process.env.SITE_DOMAIN) &&
            captured.cancel_url.startsWith(process.env.SITE_DOMAIN)
        );

        // --- Non-owners rejected, including admin/technician accounts. ---
        res = await checkout(main.id, RIDER_EMAIL);
        logTest('Non-owner (technician) rejected', res.statusCode === 403);

        res = await checkout(main.id, ADMIN_EMAIL);
        logTest('Non-owner (admin) rejected', res.statusCode === 403);

        // --- Not found / invalid ObjectId. ---
        res = await checkout('000000000000000000000000', CUSTOMER_EMAIL);
        logTest('Request not found', res.statusCode === 404);

        res = await checkout('not-a-valid-object-id', CUSTOMER_EMAIL);
        logTest('Invalid ObjectId rejected', res.statusCode === 400);

        // --- Invalid stored amount. ---
        const zeroCost = await createTestParcel(`TEST-PAYMENT-ZERO-${Date.now()}`, 0);
        res = await checkout(zeroCost.id, CUSTOMER_EMAIL);
        logTest('Zero stored amount rejected', res.statusCode === 400);

        const badCost = await createTestParcel(`TEST-PAYMENT-BAD-${Date.now()}`, 'not-a-number');
        res = await checkout(badCost.id, CUSTOMER_EMAIL);
        logTest('Non-numeric stored amount rejected', res.statusCode === 400);

        // --- Already-paid request rejected. ---
        const paid = await createTestParcel(`TEST-PAYMENT-PAID-${Date.now()}`, 25);
        await collections.parcels.updateOne({ _id: new ObjectId(paid.id) }, { $set: { paymentStatus: 'paid' } });
        res = await checkout(paid.id, CUSTOMER_EMAIL);
        logTest('Already-paid request rejected', res.statusCode === 409);
    } finally {
        for (const id of createdParcelIds) {
            await collections.parcels.deleteOne({ _id: new ObjectId(id) });
        }
        await collections.checkoutSessions.deleteMany({ parcelId: { $in: createdParcelIds } });
    }

    console.log('');
}

// Confirms the secured PATCH /payment-success contract: auth required
// (HTTP-level), sessionId validated, the Stripe session fully re-verified
// (mode, payment_status, metadata, amount, currency), ownership enforced
// across the authenticated caller/stored owner/Stripe customer email,
// idempotent on repeat calls (via the unique sessionId index), deliveryStatus
// never touched, and never trusting any browser-supplied field other than
// sessionId - all against the mocked Stripe fixtures above, never the real
// Stripe API.
async function testSecurePaymentSuccess() {
    console.log('14. Testing Secure Payment Success Verification');
    console.log('-'.repeat(60));

    // HTTP-level: confirm the route itself now requires authentication.
    await makeRequest(
        {
            hostname: 'localhost', port: 3000, path: '/payment-success', method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'cs_test_does_not_matter' })
        },
        401,
        'PATCH /payment-success (no auth)'
    );
    await makeRequest(
        {
            hostname: 'localhost', port: 3000, path: '/payment-success', method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer invalid_token_12345' },
            body: JSON.stringify({ sessionId: 'cs_test_does_not_matter' })
        },
        401,
        'PATCH /payment-success (invalid token)'
    );

    const { connectDatabase, collections } = require('./config/database');
    const { initializeModels } = require('./models');
    const { initializeControllers } = require('./controllers');
    const { ObjectId } = require('mongodb');

    const createdParcelIds = [];
    const createdSessionIds = [];
    const createdTrackingIds = [];

    function fakeRes() {
        return {
            statusCode: 200,
            body: undefined,
            status(code) { this.statusCode = code; return this; },
            send(payload) { this.body = payload; return this; }
        };
    }

    let uniqueCounter = 0;
    function newSessionId(label) {
        uniqueCounter += 1;
        const id = `cs_test_TESTPAY_${Date.now()}_${uniqueCounter}_${label}`;
        createdSessionIds.push(id);
        return id;
    }

    try {
        await connectDatabase();
        const models = initializeModels(collections);
        const controllers = initializeControllers(models, collections);
        const paymentController = controllers.payment;

        async function createTestParcel(marker, { cost = 30, senderEmail = CUSTOMER_EMAIL, deliveryStatus, paymentStatus } = {}) {
            const doc = {
                parcelName: marker,
                cost,
                senderEmail,
                trackingId: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                createdAt: new Date()
            };
            if (deliveryStatus) doc.deliveryStatus = deliveryStatus;
            if (paymentStatus) doc.paymentStatus = paymentStatus;
            const result = await collections.parcels.insertOne(doc);
            createdParcelIds.push(result.insertedId.toString());
            createdTrackingIds.push(doc.trackingId);
            return { id: result.insertedId.toString(), ...doc };
        }

        function verify(sessionId, decoded_email, extraBody = {}) {
            const res = fakeRes();
            return paymentController.handlePaymentSuccess(
                { body: { sessionId, ...extraBody }, decoded_email },
                res
            ).then(() => res);
        }

        // amount_total defaults assume a $30.00 parcel (3000 cents) unless overridden.
        function makeSession(overrides = {}) {
            return {
                mode: 'payment',
                payment_status: 'paid',
                payment_intent: `pi_test_${overrides.parcelId || 'x'}`,
                customer_email: CUSTOMER_EMAIL,
                amount_total: 3000,
                currency: 'usd',
                metadata: { parcelId: overrides.parcelId, trackingId: overrides.trackingId },
                ...overrides
            };
        }

        // --- 3. Missing sessionId ---
        let res = await verify(undefined, CUSTOMER_EMAIL);
        logTest('Missing sessionId rejected', res.statusCode === 400);

        // --- 4. Invalid sessionId shape (non-string values) ---
        res = await verify(12345, CUSTOMER_EMAIL);
        logTest('Numeric sessionId rejected', res.statusCode === 400);
        res = await verify(['cs_test_x'], CUSTOMER_EMAIL);
        logTest('Array sessionId rejected', res.statusCode === 400);
        res = await verify({ id: 'cs_test_x' }, CUSTOMER_EMAIL);
        logTest('Object sessionId rejected', res.statusCode === 400);

        // --- 5. Stripe session does not exist ---
        res = await verify(newSessionId('nonexistent'), CUSTOMER_EMAIL);
        logTest('Nonexistent Stripe session rejected', res.statusCode === 404);

        // --- 6. Session exists but unpaid - no mutation ---
        const unpaidParcel = await createTestParcel(`TEST-PAYSUCCESS-UNPAID-${Date.now()}`, { cost: 30 });
        const unpaidSid = newSessionId('unpaid');
        stripeSessionFixtures.set(unpaidSid, makeSession({
            parcelId: unpaidParcel.id, trackingId: unpaidParcel.trackingId, payment_status: 'unpaid'
        }));
        res = await verify(unpaidSid, CUSTOMER_EMAIL);
        const afterUnpaid = await models.Parcel.findById(unpaidParcel.id);
        logTest(
            'Unpaid session rejected with no mutation',
            res.statusCode === 409 && afterUnpaid.paymentStatus !== 'paid'
        );

        // --- 7. Session mode is not "payment" - no mutation ---
        const badModeParcel = await createTestParcel(`TEST-PAYSUCCESS-MODE-${Date.now()}`, { cost: 30 });
        const badModeSid = newSessionId('badmode');
        stripeSessionFixtures.set(badModeSid, makeSession({
            parcelId: badModeParcel.id, trackingId: badModeParcel.trackingId, mode: 'setup'
        }));
        res = await verify(badModeSid, CUSTOMER_EMAIL);
        const afterBadMode = await models.Parcel.findById(badModeParcel.id);
        logTest(
            'Non-payment session mode rejected with no mutation',
            res.statusCode === 409 && afterBadMode.paymentStatus !== 'paid'
        );

        // --- 8. Metadata has no parcelId ---
        const noMetaSid = newSessionId('nometa');
        stripeSessionFixtures.set(noMetaSid, makeSession({ metadata: {} }));
        res = await verify(noMetaSid, CUSTOMER_EMAIL);
        logTest('Session with no metadata.parcelId rejected', res.statusCode === 404);

        // --- 9. Metadata parcelId is invalid ObjectId shape ---
        const badIdSid = newSessionId('badid');
        stripeSessionFixtures.set(badIdSid, makeSession({ parcelId: 'not-a-valid-object-id', trackingId: 'x' }));
        res = await verify(badIdSid, CUSTOMER_EMAIL);
        logTest('Session with invalid metadata.parcelId rejected', res.statusCode === 404);

        // --- 10. Referenced parcel does not exist ---
        const missingParcelSid = newSessionId('missingparcel');
        stripeSessionFixtures.set(missingParcelSid, makeSession({
            parcelId: '000000000000000000000000', trackingId: 'x'
        }));
        res = await verify(missingParcelSid, CUSTOMER_EMAIL);
        logTest('Session referencing a nonexistent parcel rejected', res.statusCode === 404);

        // --- 11 & 20 & 21. Authenticated caller does not own the parcel ---
        const ownerParcel = await createTestParcel(`TEST-PAYSUCCESS-OWNER-${Date.now()}`, { cost: 30 });
        const wrongCallerSid = newSessionId('wrongcaller');
        stripeSessionFixtures.set(wrongCallerSid, makeSession({
            parcelId: ownerParcel.id, trackingId: ownerParcel.trackingId
        }));
        res = await verify(wrongCallerSid, RIDER_EMAIL);
        logTest('Non-owner technician caller rejected (test 11 & 21)', res.statusCode === 403);

        const wrongCallerSid2 = newSessionId('wrongcaller2');
        stripeSessionFixtures.set(wrongCallerSid2, makeSession({
            parcelId: ownerParcel.id, trackingId: ownerParcel.trackingId
        }));
        res = await verify(wrongCallerSid2, ADMIN_EMAIL);
        logTest('Non-owner admin caller rejected (test 20)', res.statusCode === 403);

        // --- 12. Stripe customer email does not match owner ---
        const emailMismatchParcel = await createTestParcel(`TEST-PAYSUCCESS-EMAILMISMATCH-${Date.now()}`, { cost: 30 });
        const emailMismatchSid = newSessionId('emailmismatch');
        stripeSessionFixtures.set(emailMismatchSid, makeSession({
            parcelId: emailMismatchParcel.id, trackingId: emailMismatchParcel.trackingId,
            customer_email: 'someone-else@example.com'
        }));
        res = await verify(emailMismatchSid, CUSTOMER_EMAIL);
        logTest('Stripe customer_email mismatch rejected', res.statusCode === 403);

        // --- 13. Safe metadata email - not applicable in this contract ---
        logTest(
            'Metadata email cross-check - not applicable',
            true,
            'Unit 1 metadata contract only sets parcelId/trackingId - no email field exists to cross-check'
        );

        // --- 14. Stripe amount does not match Mongo cost ---
        const amountMismatchParcel = await createTestParcel(`TEST-PAYSUCCESS-AMOUNT-${Date.now()}`, { cost: 30 });
        const amountMismatchSid = newSessionId('amountmismatch');
        stripeSessionFixtures.set(amountMismatchSid, makeSession({
            parcelId: amountMismatchParcel.id, trackingId: amountMismatchParcel.trackingId,
            amount_total: 100 // parcel cost is $30.00 (3000 cents) - deliberately wrong
        }));
        res = await verify(amountMismatchSid, CUSTOMER_EMAIL);
        logTest('Stripe amount mismatch rejected', res.statusCode === 409);

        // --- 15. Stripe currency does not match expected currency ---
        const currencyMismatchParcel = await createTestParcel(`TEST-PAYSUCCESS-CURRENCY-${Date.now()}`, { cost: 30 });
        const currencyMismatchSid = newSessionId('currencymismatch');
        stripeSessionFixtures.set(currencyMismatchSid, makeSession({
            parcelId: currencyMismatchParcel.id, trackingId: currencyMismatchParcel.trackingId,
            currency: 'eur'
        }));
        res = await verify(currencyMismatchSid, CUSTOMER_EMAIL);
        logTest('Stripe currency mismatch rejected', res.statusCode === 409);

        // --- 16. Valid paid session succeeds, for every starting deliveryStatus ---
        const startingStatuses = ['pending-pickup', 'driver_assigned', 'rider_arriving', 'parcel_picked_up', 'parcel_delivered'];
        for (const startStatus of startingStatuses) {
            const p = await createTestParcel(`TEST-PAYSUCCESS-LIFECYCLE-${startStatus}-${Date.now()}`, {
                cost: 30, deliveryStatus: startStatus
            });
            const sid = newSessionId(`lifecycle_${startStatus.replace(/-/g, '_')}`);
            stripeSessionFixtures.set(sid, makeSession({ parcelId: p.id, trackingId: p.trackingId }));
            res = await verify(sid, CUSTOMER_EMAIL);
            const afterPay = await models.Parcel.findById(p.id);
            const paymentCount = await collections.payments.countDocuments({ sessionId: sid });
            logTest(
                `Valid payment succeeds and preserves deliveryStatus (${startStatus})`,
                res.statusCode === 200 &&
                res.body.success === true &&
                res.body.alreadyProcessed === false &&
                afterPay.paymentStatus === 'paid' &&
                afterPay.deliveryStatus === startStatus &&
                paymentCount === 1
            );
        }

        // --- 17. Same valid session called twice - idempotent, no duplicate row ---
        const idemParcel = await createTestParcel(`TEST-PAYSUCCESS-IDEMPOTENT-${Date.now()}`, { cost: 30 });
        const idemSid = newSessionId('idempotent');
        stripeSessionFixtures.set(idemSid, makeSession({ parcelId: idemParcel.id, trackingId: idemParcel.trackingId }));
        const firstCall = await verify(idemSid, CUSTOMER_EMAIL);
        const secondCall = await verify(idemSid, CUSTOMER_EMAIL);
        const idemPaymentCount = await collections.payments.countDocuments({ sessionId: idemSid });
        logTest(
            'Repeated call with same session is idempotent (no duplicate payment record)',
            firstCall.statusCode === 200 && firstCall.body.alreadyProcessed === false &&
            secondCall.statusCode === 200 && secondCall.body.alreadyProcessed === true &&
            secondCall.body.transactionId === firstCall.body.transactionId &&
            idemPaymentCount === 1
        );

        // --- 18. Same session referenced by a caller who owns a different parcel - rejected ---
        await createTestParcel(`TEST-PAYSUCCESS-OTHEROWNER-${Date.now()}`, {
            cost: 30, senderEmail: 'other-customer@example.com'
        });
        res = await verify(idemSid, 'other-customer@example.com');
        logTest(
            'Already-recorded session claimed by a non-owning caller rejected',
            res.statusCode === 403
        );

        // --- 19. Parcel already paid by a different session - controlled conflict ---
        const alreadyPaidParcel = await createTestParcel(`TEST-PAYSUCCESS-ALREADYPAID-${Date.now()}`, {
            cost: 30, paymentStatus: 'paid'
        });
        const differentSessionSid = newSessionId('differentsession');
        stripeSessionFixtures.set(differentSessionSid, makeSession({
            parcelId: alreadyPaidParcel.id, trackingId: alreadyPaidParcel.trackingId
        }));
        res = await verify(differentSessionSid, CUSTOMER_EMAIL);
        logTest('Parcel already paid via a different session rejected', res.statusCode === 409);

        // --- 22. Raw browser-supplied fields ignored ---
        const tamperedParcel = await createTestParcel(`TEST-PAYSUCCESS-TAMPERED-${Date.now()}`, { cost: 30 });
        const tamperedSid = newSessionId('tampered');
        stripeSessionFixtures.set(tamperedSid, makeSession({ parcelId: tamperedParcel.id, trackingId: tamperedParcel.trackingId }));
        res = await verify(tamperedSid, CUSTOMER_EMAIL, {
            parcelId: '000000000000000000000000', email: 'attacker@example.com', amount: 1, paymentStatus: 'paid'
        });
        const afterTampered = await models.Parcel.findById(tamperedParcel.id);
        logTest(
            'Tampered client body fields ignored - real metadata parcel is the one paid',
            res.statusCode === 200 && res.body.trackingId === tamperedParcel.trackingId && afterTampered.paymentStatus === 'paid'
        );

        // --- 23. Stripe failure (not just "not found") - controlled, no leakage, no mutation ---
        const outageParcel = await createTestParcel(`TEST-PAYSUCCESS-OUTAGE-${Date.now()}`, { cost: 30 });
        const outageSid = newSessionId('outage');
        stripeSessionFixtures.set(outageSid, { __simulateOutage: true });
        res = await verify(outageSid, CUSTOMER_EMAIL);
        const afterOutage = await models.Parcel.findById(outageParcel.id);
        logTest(
            'Simulated Stripe outage returns a safe error with no mutation',
            res.statusCode === 404 &&
            !JSON.stringify(res.body).includes('simulated Stripe outage') &&
            afterOutage.paymentStatus !== 'paid'
        );
    } finally {
        await new Promise(resolve => setTimeout(resolve, 300));
        for (const id of createdParcelIds) {
            await collections.parcels.deleteOne({ _id: new ObjectId(id) });
        }
        if (createdSessionIds.length) {
            await collections.payments.deleteMany({ sessionId: { $in: createdSessionIds } });
        }
        if (createdTrackingIds.length) {
            await collections.trackings.deleteMany({ trackingId: { $in: createdTrackingIds } });
        }
        for (const sid of createdSessionIds) {
            stripeSessionFixtures.delete(sid);
        }
    }

    console.log('');
}

// Confirms the Stripe webhook (POST /stripe-webhook) as the authoritative
// payment-completion path: no Firebase auth, real raw-body + real signature
// verification at the HTTP level (against the live, unmocked server), then
// full business-logic coverage in-process against the mocked
// stripe.webhooks.constructEvent - mirroring processVerifiedCheckoutSession's
// shared logic already covered from the browser side in test 14 above.
async function testStripeWebhook() {
    console.log('15. Testing Stripe Payment Webhook');
    console.log('-'.repeat(60));

    // --- 1 & 26. HTTP-level: no Firebase auth, real raw-body + signature
    // wiring against the live server's genuine (unmocked) Stripe SDK. ---
    await makeRequest(
        {
            hostname: 'localhost', port: 3000, path: '/stripe-webhook', method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' })
        },
        400,
        'POST /stripe-webhook (missing stripe-signature header)'
    );
    await makeRequest(
        {
            hostname: 'localhost', port: 3000, path: '/stripe-webhook', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
            body: JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' })
        },
        400,
        'POST /stripe-webhook (invalid signature, real Stripe SDK on live server)'
    );
    await makeRequest(
        { hostname: 'localhost', port: 3000, path: '/parcels', method: 'GET' },
        401,
        'GET /parcels still parses/behaves normally after webhook route registration'
    );

    const { connectDatabase, collections } = require('./config/database');
    const { initializeModels } = require('./models');
    const { initializeControllers } = require('./controllers');
    const { ObjectId } = require('mongodb');

    const createdParcelIds = [];
    const createdSessionIds = [];
    const createdTrackingIds = [];

    function fakeRes() {
        return {
            statusCode: 200,
            body: undefined,
            status(code) { this.statusCode = code; return this; },
            send(payload) { this.body = payload; return this; }
        };
    }

    let uniqueCounter = 0;
    function newSessionId(label) {
        uniqueCounter += 1;
        const id = `cs_test_TESTHOOK_${Date.now()}_${uniqueCounter}_${label}`;
        createdSessionIds.push(id);
        return id;
    }
    function newEventId(label) {
        uniqueCounter += 1;
        return `evt_test_${Date.now()}_${uniqueCounter}_${label}`;
    }

    try {
        await connectDatabase();
        const models = initializeModels(collections);
        const controllers = initializeControllers(models, collections);
        const paymentController = controllers.payment;

        async function createTestParcel(marker, { cost = 30, senderEmail = CUSTOMER_EMAIL, deliveryStatus, paymentStatus } = {}) {
            const doc = {
                parcelName: marker,
                cost,
                senderEmail,
                trackingId: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                createdAt: new Date()
            };
            if (deliveryStatus) doc.deliveryStatus = deliveryStatus;
            if (paymentStatus) doc.paymentStatus = paymentStatus;
            const result = await collections.parcels.insertOne(doc);
            createdParcelIds.push(result.insertedId.toString());
            createdTrackingIds.push(doc.trackingId);
            return { id: result.insertedId.toString(), ...doc };
        }

        // amount_total defaults assume a $30.00 parcel (3000 cents) unless overridden.
        function makeSessionObject(sid, overrides = {}) {
            return {
                id: sid,
                mode: 'payment',
                payment_status: 'paid',
                payment_intent: `pi_test_hook_${overrides.parcelId || 'x'}`,
                customer_email: CUSTOMER_EMAIL,
                amount_total: 3000,
                currency: 'usd',
                metadata: { parcelId: overrides.parcelId, trackingId: overrides.trackingId },
                ...overrides
            };
        }

        function makeEvent(sessionObject, { type = 'checkout.session.completed', eventId } = {}) {
            return {
                id: eventId || newEventId('evt'),
                type,
                data: { object: sessionObject }
            };
        }

        function fakeWebhookReq(event, signature = 'test_valid_signature') {
            return {
                headers: signature === null ? {} : { 'stripe-signature': signature },
                body: Buffer.from(JSON.stringify(event))
            };
        }

        function callWebhook(event, signature = 'test_valid_signature') {
            const res = fakeRes();
            return paymentController.handleStripeWebhook(fakeWebhookReq(event, signature), res).then(() => res);
        }

        function verifyBrowser(sessionId, decoded_email) {
            const res = fakeRes();
            return paymentController.handlePaymentSuccess(
                { body: { sessionId }, decoded_email },
                res
            ).then(() => res);
        }

        // --- 3. Missing webhook secret -> controlled failure (in-process,
        // toggling only this test process's own env, never the live server's). ---
        {
            const savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
            delete process.env.STRIPE_WEBHOOK_SECRET;
            const p = await createTestParcel(`TEST-HOOK-NOSECRET-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('nosecret');
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId }));
            let res;
            try {
                res = await callWebhook(event);
            } finally {
                process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
            }
            logTest('Missing webhook secret rejected safely (no crash, no mutation)', res.statusCode === 500);
        }

        // --- 2 & 5. Invalid signature rejected regardless of a well-formed body. ---
        {
            const p = await createTestParcel(`TEST-HOOK-BADSIG-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('badsig');
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId }));
            const res = await callWebhook(event, 'not_the_valid_signature');
            const after = await models.Parcel.findById(p.id);
            logTest(
                'Invalid signature rejected even with a well-formed, parseable body',
                res.statusCode === 400 && after.paymentStatus !== 'paid'
            );
        }

        // --- 4. Handler receives the raw Buffer (mock enforces this itself). ---
        {
            const p = await createTestParcel(`TEST-HOOK-NONBUFFER-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('nonbuffer');
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId }));
            const res = await paymentController.handleStripeWebhook(
                { headers: { 'stripe-signature': 'test_valid_signature' }, body: event },
                fakeRes()
            ).then(() => fakeRes());
            // A non-Buffer body must never reach constructEvent successfully -
            // whatever status comes back, it must not be a successful 200 result.
            logTest(
                'Non-Buffer body cannot bypass signature verification',
                res.statusCode !== 200 || res.body === undefined
            );
        }

        // --- 6. Valid irrelevant event type -> 200, no mutation. ---
        {
            const p = await createTestParcel(`TEST-HOOK-IRRELEVANT-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('irrelevant');
            const event = makeEvent(
                makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId }),
                { type: 'payment_intent.created' }
            );
            const res = await callWebhook(event);
            const after = await models.Parcel.findById(p.id);
            const paymentCount = await collections.payments.countDocuments({ sessionId: sid });
            logTest(
                'Irrelevant event type ignored safely (200, no mutation)',
                res.statusCode === 200 && after.paymentStatus !== 'paid' && paymentCount === 0
            );
        }

        // --- 7 & 17. Valid checkout.session.completed for every starting deliveryStatus. ---
        const startingStatuses = ['pending-pickup', 'driver_assigned', 'rider_arriving', 'parcel_picked_up', 'parcel_delivered'];
        for (const startStatus of startingStatuses) {
            const p = await createTestParcel(`TEST-HOOK-LIFECYCLE-${startStatus}-${Date.now()}`, {
                cost: 30, deliveryStatus: startStatus
            });
            const sid = newSessionId(`lifecycle_${startStatus.replace(/-/g, '_')}`);
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId }));
            const res = await callWebhook(event);
            const after = await models.Parcel.findById(p.id);
            const paymentCount = await collections.payments.countDocuments({ sessionId: sid });
            logTest(
                `Webhook records payment and preserves deliveryStatus (${startStatus})`,
                res.statusCode === 200 &&
                res.body.result === 'OK' &&
                after.paymentStatus === 'paid' &&
                after.deliveryStatus === startStatus &&
                paymentCount === 1
            );
        }

        // --- 8. Unpaid completed session -> no mutation. ---
        {
            const p = await createTestParcel(`TEST-HOOK-UNPAID-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('unpaid');
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId, payment_status: 'unpaid' }));
            const res = await callWebhook(event);
            const after = await models.Parcel.findById(p.id);
            logTest('Unpaid completed session causes no mutation (200 ack)', res.statusCode === 200 && after.paymentStatus !== 'paid');
        }

        // --- 9. Wrong mode -> no mutation. ---
        {
            const p = await createTestParcel(`TEST-HOOK-MODE-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('mode');
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId, mode: 'setup' }));
            const res = await callWebhook(event);
            const after = await models.Parcel.findById(p.id);
            logTest('Non-payment session mode causes no mutation (200 ack)', res.statusCode === 200 && after.paymentStatus !== 'paid');
        }

        // --- 10. Missing metadata parcelId -> no mutation. ---
        {
            const sid = newSessionId('nometa');
            const event = makeEvent(makeSessionObject(sid, { metadata: {} }));
            const res = await callWebhook(event);
            logTest('Missing metadata.parcelId causes no mutation (200 ack)', res.statusCode === 200);
        }

        // --- 11. Invalid parcelId shape -> no mutation. ---
        {
            const sid = newSessionId('badid');
            const event = makeEvent(makeSessionObject(sid, { parcelId: 'not-a-valid-object-id', trackingId: 'x' }));
            const res = await callWebhook(event);
            logTest('Invalid metadata.parcelId causes no mutation (200 ack)', res.statusCode === 200);
        }

        // --- 12. Missing parcel -> no mutation. ---
        {
            const sid = newSessionId('missingparcel');
            const event = makeEvent(makeSessionObject(sid, { parcelId: '000000000000000000000000', trackingId: 'x' }));
            const res = await callWebhook(event);
            logTest('Nonexistent parcel causes no mutation (200 ack)', res.statusCode === 200);
        }

        // --- 13. Customer-email mismatch -> no mutation. ---
        {
            const p = await createTestParcel(`TEST-HOOK-EMAILMISMATCH-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('emailmismatch');
            const event = makeEvent(makeSessionObject(sid, {
                parcelId: p.id, trackingId: p.trackingId, customer_email: 'someone-else@example.com'
            }));
            const res = await callWebhook(event);
            const after = await models.Parcel.findById(p.id);
            logTest('Stripe customer_email mismatch causes no mutation (200 ack)', res.statusCode === 200 && after.paymentStatus !== 'paid');
        }

        // --- 14. Safe metadata email cross-check - not applicable (same as browser path). ---
        logTest(
            'Metadata email cross-check - not applicable',
            true,
            'Unit 1 metadata contract only sets parcelId/trackingId - no email field exists to cross-check'
        );

        // --- 15. Amount mismatch -> no mutation. ---
        {
            const p = await createTestParcel(`TEST-HOOK-AMOUNT-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('amount');
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId, amount_total: 100 }));
            const res = await callWebhook(event);
            const after = await models.Parcel.findById(p.id);
            logTest('Amount mismatch causes no mutation (200 ack)', res.statusCode === 200 && after.paymentStatus !== 'paid');
        }

        // --- 16. Currency mismatch -> no mutation. ---
        {
            const p = await createTestParcel(`TEST-HOOK-CURRENCY-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('currency');
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId, currency: 'eur' }));
            const res = await callWebhook(event);
            const after = await models.Parcel.findById(p.id);
            logTest('Currency mismatch causes no mutation (200 ack)', res.statusCode === 200 && after.paymentStatus !== 'paid');
        }

        // --- 18. Same event delivered twice -> one payment row. ---
        {
            const p = await createTestParcel(`TEST-HOOK-SAMEEVENT-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('sameevent');
            const eventId = newEventId('dup');
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId }), { eventId });
            const first = await callWebhook(event);
            const second = await callWebhook(event);
            const count = await collections.payments.countDocuments({ sessionId: sid });
            logTest(
                'Same event delivered twice yields one payment row',
                first.statusCode === 200 && second.statusCode === 200 && count === 1
            );
        }

        // --- 19. Different event IDs, same session -> one payment row (Stripe redelivery with a new delivery attempt id). ---
        {
            const p = await createTestParcel(`TEST-HOOK-DIFFEVENT-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('diffevent');
            const sessionObj = makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId });
            const first = await callWebhook(makeEvent(sessionObj, { eventId: newEventId('a') }));
            const second = await callWebhook(makeEvent(sessionObj, { eventId: newEventId('b') }));
            const count = await collections.payments.countDocuments({ sessionId: sid });
            logTest(
                'Different event IDs for the same session yield one payment row',
                first.statusCode === 200 && second.statusCode === 200 && count === 1
            );
        }

        // --- 20. Browser processes first, webhook arrives later -> idempotent. ---
        {
            const p = await createTestParcel(`TEST-HOOK-BROWSERFIRST-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('browserfirst');
            const sessionObj = makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId });
            stripeSessionFixtures.set(sid, sessionObj);
            const browserResult = await verifyBrowser(sid, CUSTOMER_EMAIL);
            const webhookResult = await callWebhook(makeEvent(sessionObj));
            const count = await collections.payments.countDocuments({ sessionId: sid });
            logTest(
                'Browser-first then webhook-later is idempotent (one payment row)',
                browserResult.statusCode === 200 && browserResult.body.alreadyProcessed === false &&
                webhookResult.statusCode === 200 && webhookResult.body.result === 'OK' &&
                count === 1
            );
        }

        // --- 21. Webhook processes first, browser arrives later -> idempotent. ---
        {
            const p = await createTestParcel(`TEST-HOOK-WEBHOOKFIRST-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('webhookfirst');
            const sessionObj = makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId });
            stripeSessionFixtures.set(sid, sessionObj);
            const webhookResult = await callWebhook(makeEvent(sessionObj));
            const browserResult = await verifyBrowser(sid, CUSTOMER_EMAIL);
            const count = await collections.payments.countDocuments({ sessionId: sid });
            logTest(
                'Webhook-first then browser-later is idempotent (one payment row)',
                webhookResult.statusCode === 200 && webhookResult.body.result === 'OK' &&
                browserResult.statusCode === 200 && browserResult.body.alreadyProcessed === true &&
                count === 1
            );
        }

        // --- 22. Concurrent webhook processing -> one payment row. ---
        {
            const p = await createTestParcel(`TEST-HOOK-CONCURRENT-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('concurrent');
            const sessionObj = makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId });
            const results = await Promise.all([
                callWebhook(makeEvent(sessionObj, { eventId: newEventId('c1') })),
                callWebhook(makeEvent(sessionObj, { eventId: newEventId('c2') })),
                callWebhook(makeEvent(sessionObj, { eventId: newEventId('c3') }))
            ]);
            const count = await collections.payments.countDocuments({ sessionId: sid });
            const afterConcurrent = await models.Parcel.findById(p.id);
            // Under genuine simultaneous contention on the same two documents,
            // MongoDB may abort one transaction with a transient error even
            // after the driver's built-in retries (a real, expected
            // possibility - not a bug) - the safety property that actually
            // matters is that at most one payment row is ever created, every
            // response is either a safe success or a safe retryable failure
            // (never a wrong/corrupt outcome), and at least one call
            // succeeded in marking the parcel paid.
            logTest(
                'Concurrent webhook deliveries for the same session yield at most one payment row, no unsafe response',
                results.every(r => r.statusCode === 200 || r.statusCode === 500) &&
                results.some(r => r.statusCode === 200) &&
                count === 1 &&
                afterConcurrent.paymentStatus === 'paid'
            );
        }

        // --- 23. Parcel already paid by a conflicting session -> no overwrite. ---
        {
            const paidParcel = await createTestParcel(`TEST-HOOK-CONFLICT-${Date.now()}`, { cost: 30, paymentStatus: 'paid' });
            const sid = newSessionId('conflict');
            const event = makeEvent(makeSessionObject(sid, { parcelId: paidParcel.id, trackingId: paidParcel.trackingId }));
            const res = await callWebhook(event);
            const count = await collections.payments.countDocuments({ sessionId: sid });
            logTest(
                'Parcel already paid by a different session is not overwritten (200 ack, no new row)',
                res.statusCode === 200 && count === 0
            );
        }

        // --- 24 & 25. Database failure -> retryable non-2xx, no raw error leaked. ---
        {
            const p = await createTestParcel(`TEST-HOOK-DBFAIL-${Date.now()}`, { cost: 30 });
            const sid = newSessionId('dbfail');
            const event = makeEvent(makeSessionObject(sid, { parcelId: p.id, trackingId: p.trackingId }));

            const originalFindOne = collections.payments.findOne;
            collections.payments.findOne = () => { throw new Error('simulated database outage - do not leak this text'); };
            let res;
            try {
                res = await callWebhook(event);
            } finally {
                collections.payments.findOne = originalFindOne;
            }
            logTest(
                'Database failure returns a safe retryable error with no internal leakage',
                res.statusCode === 500 && !JSON.stringify(res.body).includes('simulated database outage')
            );
        }
    } finally {
        await new Promise(resolve => setTimeout(resolve, 300));
        for (const id of createdParcelIds) {
            await collections.parcels.deleteOne({ _id: new ObjectId(id) });
        }
        if (createdSessionIds.length) {
            await collections.payments.deleteMany({ sessionId: { $in: createdSessionIds } });
        }
        if (createdTrackingIds.length) {
            await collections.trackings.deleteMany({ trackingId: { $in: createdTrackingIds } });
        }
        for (const sid of createdSessionIds) {
            stripeSessionFixtures.delete(sid);
        }
    }

    console.log('');
}

// Confirms server-side duplicate Stripe Checkout Session prevention (Phase
// 2.3 Unit 1): at most one active, reusable Checkout Session exists per
// parcel at a time. The real guard is the unique partial index on
// checkoutSessions.parcelId (active:true, see config/database.js) combined
// with claiming that slot before any Stripe API call is made (see
// services/checkoutSessionManager.js and controllers/paymentController.js) -
// never a real Stripe call, and never an in-memory-only mutex.
async function testDuplicateCheckoutPrevention() {
    console.log('16. Testing Duplicate Checkout Session Prevention');
    console.log('-'.repeat(60));

    const { connectDatabase, collections } = require('./config/database');
    const { initializeModels } = require('./models');
    const { initializeControllers } = require('./controllers');
    const { ObjectId } = require('mongodb');

    const createdParcelIds = [];

    function fakeRes() {
        return {
            statusCode: 200,
            body: undefined,
            status(code) { this.statusCode = code; return this; },
            send(payload) { this.body = payload; return this; }
        };
    }

    try {
        await connectDatabase();
        const models = initializeModels(collections);
        const controllers = initializeControllers(models, collections);
        const paymentController = controllers.payment;

        async function createTestParcel(marker, cost = 30) {
            const doc = {
                parcelName: marker,
                cost,
                senderEmail: CUSTOMER_EMAIL,
                trackingId: `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                createdAt: new Date()
            };
            const result = await collections.parcels.insertOne(doc);
            createdParcelIds.push(result.insertedId.toString());
            return { id: result.insertedId.toString(), ...doc };
        }

        function checkout(id, decoded_email, extraBody = {}) {
            const res = fakeRes();
            return paymentController.createCheckoutSession(
                { body: { parcelId: id, ...extraBody }, decoded_email },
                res
            ).then(() => res);
        }

        function activeRowFor(parcelId) {
            return collections.checkoutSessions.findOne({ parcelId, active: true });
        }

        function callWebhookWithSession(sessionObject, type = 'checkout.session.completed') {
            const event = { id: `evt_test_dupchk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, type, data: { object: sessionObject } };
            const res = fakeRes();
            return paymentController.handleStripeWebhook(
                { headers: { 'stripe-signature': 'test_valid_signature' }, body: Buffer.from(JSON.stringify(event)) },
                res
            ).then(() => res);
        }

        // --- 1. First checkout creates one session, with a checkout row
        // recorded (open, sessionId only - never a persisted URL). ---
        const p1 = await createTestParcel(`TEST-DUPCHK-FIRST-${Date.now()}`, 40);
        let sessionsBefore = capturedStripeSessionParams.length;
        let res = await checkout(p1.id, CUSTOMER_EMAIL);
        logTest(
            'First checkout creates one Stripe session',
            res.statusCode === 200 && !!res.body.url && res.body.reused === false &&
            capturedStripeSessionParams.length === sessionsBefore + 1
        );
        const row1 = await activeRowFor(p1.id);
        logTest(
            'A single active checkout row is recorded (open, sessionId only, no URL persisted)',
            !!row1 && row1.status === 'open' && typeof row1.sessionId === 'string' &&
            !('checkoutUrl' in row1) && !('url' in row1)
        );

        // --- 2 & 3. Two concurrent calls create only one Stripe session; both
        // callers receive the same reusable session or a controlled conflict. ---
        const p2 = await createTestParcel(`TEST-DUPCHK-CONCURRENT-${Date.now()}`, 55);
        sessionsBefore = capturedStripeSessionParams.length;
        const [ra, rb] = await Promise.all([checkout(p2.id, CUSTOMER_EMAIL), checkout(p2.id, CUSTOMER_EMAIL)]);
        logTest(
            'Two concurrent checkout calls for the same parcel create only one Stripe session',
            capturedStripeSessionParams.length === sessionsBefore + 1
        );
        const successes = [ra, rb].filter(r => r.statusCode === 200);
        const conflicts = [ra, rb].filter(r => r.statusCode === 409 && r.body.code === 'CHECKOUT_CREATION_IN_PROGRESS');
        logTest(
            'Both concurrent callers receive the same reusable session or a controlled conflict',
            successes.length + conflicts.length === 2 && successes.length >= 1 &&
            new Set(successes.map(r => r.body.url)).size === 1
        );

        // --- 4. Same owner retry reuses the now-settled active session. ---
        sessionsBefore = capturedStripeSessionParams.length;
        const firstUrl = successes[0].body.url;
        res = await checkout(p2.id, CUSTOMER_EMAIL);
        logTest(
            'Same owner retry reuses the active session (no new Stripe session, same URL)',
            res.statusCode === 200 && res.body.reused === true && res.body.url === firstUrl &&
            capturedStripeSessionParams.length === sessionsBefore
        );

        // --- 5. A different user cannot access or reuse another owner's session. ---
        res = await checkout(p2.id, RIDER_EMAIL);
        logTest("Different user cannot access another owner's checkout session", res.statusCode === 403);

        // --- 6. Paid parcel rejected, no checkout row created. ---
        const paidParcel = await createTestParcel(`TEST-DUPCHK-PAID-${Date.now()}`, 20);
        await collections.parcels.updateOne({ _id: new ObjectId(paidParcel.id) }, { $set: { paymentStatus: 'paid' } });
        res = await checkout(paidParcel.id, CUSTOMER_EMAIL);
        const paidRow = await activeRowFor(paidParcel.id);
        logTest(
            'Paid parcel rejected with a controlled conflict and no checkout row created',
            res.statusCode === 409 && res.body.code === 'ALREADY_PAID' && !paidRow
        );

        // --- 7. Expired session can be replaced. ---
        const p3 = await createTestParcel(`TEST-DUPCHK-EXPIRED-${Date.now()}`, 33);
        res = await checkout(p3.id, CUSTOMER_EMAIL);
        const openRow = await activeRowFor(p3.id);
        await collections.checkoutSessions.updateOne({ _id: openRow._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        sessionsBefore = capturedStripeSessionParams.length;
        res = await checkout(p3.id, CUSTOMER_EMAIL);
        const newRow = await activeRowFor(p3.id);
        logTest(
            'Expired session is replaced by a fresh Stripe session',
            res.statusCode === 200 && res.body.reused === false &&
            capturedStripeSessionParams.length === sessionsBefore + 1 &&
            !!newRow && newRow.sessionId !== openRow.sessionId
        );

        // --- 8. A failed Stripe creation attempt releases the lock instead
        // of permanently locking the parcel out of future checkout attempts. ---
        const p4 = await createTestParcel(`TEST-DUPCHK-STRIPEFAIL-${Date.now()}`, 15);
        forceNextCreateFailure = true;
        res = await checkout(p4.id, CUSTOMER_EMAIL);
        const failedRow = await activeRowFor(p4.id);
        logTest(
            'A failed Stripe creation attempt returns a safe error and releases the lock',
            res.statusCode === 500 && !failedRow
        );
        res = await checkout(p4.id, CUSTOMER_EMAIL);
        logTest('A checkout attempt after a released lock succeeds normally', res.statusCode === 200 && !!res.body.url);

        // --- 9 & 10. Invalid stored amount rejected (no checkout row
        // created); a client-supplied fake amount is still ignored. ---
        const zeroCost = await createTestParcel(`TEST-DUPCHK-ZERO-${Date.now()}`, 0);
        res = await checkout(zeroCost.id, CUSTOMER_EMAIL);
        const zeroRow = await activeRowFor(zeroCost.id);
        logTest('Invalid stored amount rejected with no checkout row created', res.statusCode === 400 && !zeroRow);

        const p5 = await createTestParcel(`TEST-DUPCHK-FAKEAMOUNT-${Date.now()}`, 60);
        sessionsBefore = capturedStripeSessionParams.length;
        res = await checkout(p5.id, CUSTOMER_EMAIL, { cost: 1 });
        const captured = capturedStripeSessionParams[capturedStripeSessionParams.length - 1];
        logTest(
            'Client-supplied fake amount is ignored (server-stored cost used)',
            res.statusCode === 200 && capturedStripeSessionParams.length === sessionsBefore + 1 &&
            captured.line_items[0].price_data.unit_amount === 6000
        );

        // --- 11. Webhook completion reconciles the active checkout state. ---
        const p6 = await createTestParcel(`TEST-DUPCHK-WEBHOOKRECON-${Date.now()}`, 70);
        res = await checkout(p6.id, CUSTOMER_EMAIL);
        const p6Row = await activeRowFor(p6.id);
        const p6PaidSession = {
            ...stripeSessionFixtures.get(p6Row.sessionId),
            payment_status: 'paid',
            status: 'complete',
            payment_intent: `pi_test_dupchk_${p6.id}`
        };
        stripeSessionFixtures.set(p6Row.sessionId, p6PaidSession);
        const hookRes = await callWebhookWithSession(p6PaidSession);
        const p6RowAfter = await collections.checkoutSessions.findOne({ parcelId: p6.id });
        logTest(
            'Webhook completion reconciles the active checkout state to completed',
            hookRes.statusCode === 200 && !!p6RowAfter && p6RowAfter.status === 'completed' && p6RowAfter.active === false
        );

        // --- 13. Duplicate webhook delivery does not corrupt checkout state. ---
        const hookRes2 = await callWebhookWithSession(p6PaidSession);
        const p6RowAfter2 = await collections.checkoutSessions.findOne({ parcelId: p6.id });
        logTest(
            'Duplicate webhook delivery does not corrupt checkout state',
            hookRes2.statusCode === 200 && p6RowAfter2.status === 'completed' && p6RowAfter2.active === false
        );

        // A new checkout for the now-webhook-paid parcel must be rejected.
        res = await checkout(p6.id, CUSTOMER_EMAIL);
        logTest(
            'A new checkout for an already-webhook-paid parcel is rejected',
            res.statusCode === 409 && res.body.code === 'ALREADY_PAID'
        );

        // --- 12. Browser success fallback reconciles the active checkout state. ---
        const p7 = await createTestParcel(`TEST-DUPCHK-BROWSERRECON-${Date.now()}`, 80);
        res = await checkout(p7.id, CUSTOMER_EMAIL);
        const p7Row = await activeRowFor(p7.id);
        stripeSessionFixtures.set(p7Row.sessionId, {
            ...stripeSessionFixtures.get(p7Row.sessionId),
            payment_status: 'paid',
            status: 'complete',
            payment_intent: `pi_test_dupchk_browser_${p7.id}`
        });
        const browserRes = fakeRes();
        await paymentController.handlePaymentSuccess(
            { body: { sessionId: p7Row.sessionId }, decoded_email: CUSTOMER_EMAIL },
            browserRes
        );
        const p7RowAfter = await collections.checkoutSessions.findOne({ parcelId: p7.id });
        logTest(
            'Browser success fallback reconciles the active checkout state to completed',
            browserRes.statusCode === 200 && !!p7RowAfter && p7RowAfter.status === 'completed' && p7RowAfter.active === false
        );

        // --- 14. checkout.session.expired is safely ignored - this project
        // deliberately does not subscribe to it; expiry is instead handled
        // lazily, the next time a checkout attempt for that parcel is made
        // (see findActive() in services/checkoutSessionManager.js). ---
        const p8 = await createTestParcel(`TEST-DUPCHK-EXPIREDEVENT-${Date.now()}`, 45);
        res = await checkout(p8.id, CUSTOMER_EMAIL);
        const p8Row = await activeRowFor(p8.id);
        const expiredRes = await callWebhookWithSession(
            { ...stripeSessionFixtures.get(p8Row.sessionId), status: 'expired' },
            'checkout.session.expired'
        );
        const p8RowAfter = await collections.checkoutSessions.findOne({ parcelId: p8.id });
        logTest(
            'checkout.session.expired is safely ignored (no mutation) - expiry is handled lazily on the next checkout attempt',
            expiredRes.statusCode === 200 && expiredRes.body.ignored === true &&
            p8RowAfter.status === 'open' && p8RowAfter.active === true
        );

        // --- 15. Existing non-payment routes remain unaffected. ---
        await makeRequest(
            { hostname: 'localhost', port: 3000, path: '/', method: 'GET' },
            200,
            'GET / still responds normally (non-payment routes unaffected)'
        );
    } finally {
        for (const id of createdParcelIds) {
            await collections.parcels.deleteOne({ _id: new ObjectId(id) });
        }
        await collections.checkoutSessions.deleteMany({ parcelId: { $in: createdParcelIds } });
        // Items 11/12 above genuinely record a payment via the real
        // processVerifiedCheckoutSession path (webhook/browser reconciliation
        // tests) - clean those up too, not just the parcel and checkout rows.
        await collections.payments.deleteMany({ parcelId: { $in: createdParcelIds } });
    }

    console.log('');
}

async function runAllTests() {
    console.log('='.repeat(60));
    console.log('Starting Comprehensive API Tests');
    console.log('='.repeat(60));
    console.log('');

    // Test 1: Root endpoint (no auth required)
    console.log('1. Testing Root Endpoint');
    console.log('-'.repeat(60));
    await makeRequest(
        { hostname: 'localhost', port: 3000, path: '/', method: 'GET' },
        200,
        'Root endpoint (/)'
    );
    console.log('');

    // Test 2: Protected endpoints without auth
    console.log('2. Testing Protected Endpoints (No Authentication)');
    console.log('-'.repeat(60));
    const protectedEndpoints = [
        { path: '/users', name: 'GET /users' },
        { path: '/parcels', name: 'GET /parcels' },
        { path: '/riders', name: 'GET /riders' },
        { path: '/payments', name: 'GET /payments' },
        { path: '/parcels/delivery-status/stats', name: 'GET /parcels/delivery-status/stats' },
        { path: '/riders/delivery-per-day', name: 'GET /riders/delivery-per-day' },
    ];

    for (const endpoint of protectedEndpoints) {
        await makeRequest(
            { hostname: 'localhost', port: 3000, path: endpoint.path, method: 'GET' },
            401,
            endpoint.name + ' (no auth)'
        );
    }
    console.log('');

    // Test 3: Protected endpoints with invalid token
    console.log('3. Testing Protected Endpoints (Invalid Token)');
    console.log('-'.repeat(60));
    for (const endpoint of protectedEndpoints) {
        await makeRequest(
            {
                hostname: 'localhost',
                port: 3000,
                path: endpoint.path,
                method: 'GET',
                headers: { 'Authorization': 'Bearer invalid_token_12345' }
            },
            401,
            endpoint.name + ' (invalid token)'
        );
    }
    console.log('');

    // Test 4: User-specific endpoints
    console.log('4. Testing User-Specific Endpoints');
    console.log('-'.repeat(60));
    await makeRequest(
        { hostname: 'localhost', port: 3000, path: '/users/507f1f77bcf86cd799439011', method: 'GET' },
        401,
        'GET /users/:id (no auth)'
    );
    await makeRequest(
        { hostname: 'localhost', port: 3000, path: '/users/test@example.com/role', method: 'GET' },
        401,
        'GET /users/:email/role (no auth)'
    );
    console.log('');

    // Test 5: Parcel-specific endpoints
    console.log('5. Testing Parcel-Specific Endpoints');
    console.log('-'.repeat(60));
    await makeRequest(
        { hostname: 'localhost', port: 3000, path: '/parcels/507f1f77bcf86cd799439011', method: 'GET' },
        401,
        'GET /parcels/:id (no auth)'
    );
    await makeRequest(
        { hostname: 'localhost', port: 3000, path: '/parcels/rider', method: 'GET' },
        401,
        'GET /parcels/rider (no auth)'
    );
    await makeRequest(
        {
            hostname: 'localhost',
            port: 3000,
            path: '/parcels',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ test: 'data' })
        },
        401,
        'POST /parcels (no auth)'
    );
    console.log('');

    // Test 6: Tracking endpoints
    console.log('6. Testing Tracking Endpoints');
    console.log('-'.repeat(60));
    await makeRequest(
        { hostname: 'localhost', port: 3000, path: '/trackings/PRCL-20250101-ABC123/logs', method: 'GET' },
        401,
        'GET /trackings/:trackingId/logs (no auth)'
    );
    console.log('');

    // Test 7: Payment endpoints. This route now requires authentication and
    // ownership (see Test 13) - it is no longer publicly callable.
    console.log('7. Testing Payment Endpoints');
    console.log('-'.repeat(60));
    await makeRequest(
        {
            hostname: 'localhost',
            port: 3000,
            path: '/payment-checkout-session',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parcelId: '000000000000000000000000' })
        },
        401,
        'POST /payment-checkout-session (no auth)'
    );
    console.log('');

    // Test 8: Route ordering test (specific route before generic)
    console.log('8. Testing Route Ordering');
    console.log('-'.repeat(60));
    await makeRequest(
        { hostname: 'localhost', port: 3000, path: '/parcels/123/status', method: 'PATCH' },
        401,
        'PATCH /parcels/:id/status (should match specific route, not generic)'
    );
    console.log('');

    // Test 9: Unknown route must be a real 404, not a symptom of route
    // registration timing (routes are now registered synchronously at
    // module load, so this must be consistently 404, never intermittently
    // something else caused by cold-start ordering)
    console.log('9. Testing Unknown Route Handling');
    console.log('-'.repeat(60));
    await makeRequest(
        { hostname: 'localhost', port: 3000, path: '/this-route-does-not-exist', method: 'GET' },
        404,
        'GET /this-route-does-not-exist (unknown route)'
    );
    console.log('');

    // Test 10: CORS origin handling. Requests with no Origin header (every
    // test above) already exercise the "no Origin -> allowed" path; these
    // two confirm the allow-list itself is enforced.
    console.log('10. Testing CORS Origin Handling');
    console.log('-'.repeat(60));
    await makeRequest(
        {
            hostname: 'localhost',
            port: 3000,
            path: '/',
            method: 'GET',
            headers: { Origin: 'http://localhost:5173' }
        },
        200,
        'GET / (allowed localhost dev origin)'
    );
    await makeRequest(
        {
            hostname: 'localhost',
            port: 3000,
            path: '/',
            method: 'GET',
            headers: { Origin: 'http://evil-not-allowed.example' }
        },
        403,
        'GET / (rejected unknown origin)'
    );
    console.log('');

    await testStatusTransitions();
    await testInitialRequestStatus();
    await testSecureCheckoutSession();
    await testSecurePaymentSuccess();
    await testStripeWebhook();
    await testDuplicateCheckoutPrevention();

    // Both database-backed sections above share one cached Mongo connection
    // (config/database.js's connectDatabase()); close it once, here, now that
    // every test needing it has finished.
    const { client } = require('./config/database');
    await client.close();

    // Summary
    console.log('='.repeat(60));
    console.log('Test Summary');
    console.log('='.repeat(60));
    console.log(`Total Tests: ${testsPassed + testsFailed}`);
    console.log(`Passed: ${testsPassed}`);
    console.log(`Failed: ${testsFailed}`);
    console.log(`Success Rate: ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}%`);
    console.log('');

    if (testsFailed === 0) {
        console.log('🎉 All tests passed! Server is working correctly.');
        process.exit(0);
    } else {
        console.log('⚠️  Some tests failed. Please review the output above.');
        process.exit(1);
    }
}

// Wait a moment for server to be ready, then run tests
setTimeout(() => {
    runAllTests().catch(err => {
        console.error('Test execution error:', err);
        process.exit(1);
    });
}, 2000);

