// Tracks at most one active (occupying-the-slot) Stripe Checkout Session per
// parcel, so concurrent checkout requests (multiple tabs, rapid retries,
// direct API calls, two browser sessions) can never spawn more than one live
// Stripe session for the same repair request. The real guard is the unique
// partial index on checkoutSessions.parcelId (see config/database.js, filtered
// to active:true) - every function here is written so a duplicate-key error
// on that index is a normal, expected outcome of a race, not a bug.
//
// No full Stripe session object or checkout URL is ever persisted here - only
// the sessionId is stored, and a fresh URL is retrieved from Stripe itself
// whenever a caller needs to reuse an open session (see
// controllers/paymentController.js).
const CREATING_CLAIM_TTL_MS = 60 * 1000;

function createCheckoutSessionManager(collections) {
    const checkoutSessions = collections.checkoutSessions;

    // Returns the parcel's active row, if any, after opportunistically
    // reconciling it away when it is stale:
    //  - status 'creating' older than the claim TTL means the request that
    //    claimed it died (crashed, restarted) before ever calling Stripe or
    //    persisting the result - the slot must not stay locked forever.
    //  - status 'open' past its own Stripe expiresAt is no longer usable.
    // Both cases mark the row active:false and return null, letting the
    // caller create a fresh session immediately - there is no separate sweep
    // job, expiry is only ever noticed the next time it actually matters.
    async function findActive(parcelId) {
        const row = await checkoutSessions.findOne({ parcelId, active: true });
        if (!row) return null;

        if (row.status === 'creating') {
            const age = Date.now() - row.createdAt.getTime();
            if (age > CREATING_CLAIM_TTL_MS) {
                await checkoutSessions.updateOne(
                    { _id: row._id, active: true },
                    { $set: { status: 'failed', active: false, updatedAt: new Date() } }
                );
                return null;
            }
            return row;
        }

        if (row.status === 'open' && row.expiresAt && row.expiresAt <= new Date()) {
            await checkoutSessions.updateOne(
                { _id: row._id, active: true },
                { $set: { status: 'expired', active: false, updatedAt: new Date() } }
            );
            return null;
        }

        return row;
    }

    // Atomically attempts to occupy the per-parcel slot before any Stripe API
    // call is made, so two concurrent requests never both reach
    // stripe.checkout.sessions.create for the same parcel. A duplicate-key
    // error here means another request (any tab/device/retry) won the race
    // between the caller's own findActive() check and this insert.
    async function claim({ parcelId, ownerEmail, amount, currency }) {
        const now = new Date();
        try {
            const result = await checkoutSessions.insertOne({
                parcelId,
                ownerEmail,
                amount,
                currency,
                status: 'creating',
                active: true,
                sessionId: null,
                expiresAt: null,
                createdAt: now,
                updatedAt: now
            });
            return { claimed: true, id: result.insertedId };
        } catch (error) {
            if (error.code === 11000) {
                return { claimed: false };
            }
            throw error;
        }
    }

    async function markOpen(id, { sessionId, expiresAt }) {
        await checkoutSessions.updateOne(
            { _id: id },
            { $set: { status: 'open', sessionId, expiresAt, updatedAt: new Date() } }
        );
    }

    // Releases the slot after a failed Stripe creation attempt (or a stale
    // reused row that Stripe no longer recognizes as open) - the parcel is
    // never left permanently unable to start a new checkout.
    async function markFailed(id) {
        await checkoutSessions.updateOne(
            { _id: id },
            { $set: { status: 'failed', active: false, updatedAt: new Date() } }
        );
    }

    // Called once a payment for this parcel is confirmed (browser or
    // webhook path, see services/paymentProcessor.js) - releases the active
    // slot so it stops being reported as reusable/in-progress. Safe to call
    // even when no active row exists, and safe to call repeatedly (idempotent
    // no-op once already inactive). Accepts an optional MongoDB session so it
    // can participate in the same transaction as the payment write.
    async function completeByParcelId(parcelId, mongoSession = null) {
        await checkoutSessions.updateOne(
            { parcelId, active: true },
            { $set: { status: 'completed', active: false, updatedAt: new Date() } },
            mongoSession ? { session: mongoSession } : {}
        );
    }

    // Called when a customer cancels a repair request - releases the active
    // slot so an old checkout URL can never be reused to reach a valid paid
    // state, regardless of whether the real Stripe session itself can also
    // be expired (see controllers/parcelController.js's cancelParcel, which
    // uses the returned row's sessionId to best-effort expire it). Returns
    // the row that was active (with its sessionId), or null if none existed.
    async function cancelByParcelId(parcelId) {
        const row = await checkoutSessions.findOne({ parcelId, active: true });
        if (!row) return null;
        await checkoutSessions.updateOne(
            { _id: row._id, active: true },
            { $set: { status: 'cancelled', active: false, updatedAt: new Date() } }
        );
        return row;
    }

    return { findActive, claim, markOpen, markFailed, completeByParcelId, cancelByParcelId };
}

module.exports = { createCheckoutSessionManager, CREATING_CLAIM_TTL_MS };
