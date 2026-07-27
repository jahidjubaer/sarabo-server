// Tracking-log statuses safe to show on the unauthenticated public endpoint -
// deliberately excludes 'parcel_paid' (and anything else outside the real
// repair lifecycle): this endpoint must never reveal payment status, even in
// a generic "payment received" form. 'parcel_created' is normalized to
// 'pending-pickup' since they represent the same starting point and only the
// latter is understood by the client's repair-status label mapping.
const PUBLIC_TIMELINE_STATUSES = new Set(['parcel_created', 'driver_assigned', 'rider_arriving', 'parcel_picked_up', 'parcel_delivered', 'cancelled']);

// Tracking codes are exact-matched bearer-style lookup keys (see
// utils/trackingId.js) - this also doubles as a cheap format guard so an
// obviously malformed code never reaches MongoDB. Long enough to cover both
// the legacy PRCL-YYYYMMDD-XXXXXX format and the current SRB-<base64url>
// format.
const TRACKING_CODE_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

class TrackingController {
    constructor(models, collections) {
        this.Tracking = models.Tracking;
        this.Parcel = models.Parcel;
        this.User = models.User;
        this.collections = collections;
    }

    async getTrackingLogs(req, res) {
        try {
            const trackingId = req.params.trackingId;

            // Check if user has access to this tracking (via repair request ownership or assignment)
            const parcel = await this.Parcel.findByTrackingId(trackingId);
            if (!parcel) {
                return res.status(404).send({ message: 'tracking not found' });
            }

            const currentUser = await this.User.findByEmail(req.decoded_email);
            const isOwner = parcel.senderEmail === req.decoded_email;
            const isAssignedRider = parcel.riderEmail === req.decoded_email;
            const isAdmin = currentUser && currentUser.role === 'admin';

            if (!isOwner && !isAssignedRider && !isAdmin) {
                return res.status(403).send({ message: 'forbidden access' });
            }

            const result = await this.Tracking.findAllByTrackingId(trackingId);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching tracking logs', error: error.message });
        }
    }

    // Authoritative public-by-link contract: no Firebase auth, no ownership
    // check - possession of a sufficiently random tracking code is the only
    // access control, by design (see utils/trackingId.js and the public
    // tracking security boundary this endpoint was built against). Every
    // field returned is explicitly selected, never a spread of a MongoDB
    // document, and the underlying queries themselves already use an
    // allow-list projection (models/Parcel.js, models/Tracking.js) so no
    // private field is ever pulled from the database for this path, let
    // alone sent to the client.
    async getPublicTracking(req, res) {
        // Public-by-link progress data should never be cached by an
        // intermediary or the browser, and the response is always plain
        // JSON we constructed ourselves - guard against MIME-sniffing. Set
        // once, up front, so every response path (success or error) below
        // gets the same headers.
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        try {
            const trackingCode = req.params.trackingCode;
            if (typeof trackingCode !== 'string' || !TRACKING_CODE_PATTERN.test(trackingCode)) {
                // Same generic message as "not found" below - an invalid
                // shape and a well-formed-but-nonexistent code must be
                // indistinguishable to the caller.
                return res.status(404).send({ message: 'Repair tracking information not found.' });
            }

            const parcel = await this.Parcel.findPublicProjectionByTrackingId(trackingCode);
            if (!parcel) {
                return res.status(404).send({ message: 'Repair tracking information not found.' });
            }

            const logs = await this.Tracking.findPublicLogsByTrackingId(trackingCode);
            const sortedLogs = [...logs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

            const timeline = [];
            for (const log of sortedLogs) {
                if (!PUBLIC_TIMELINE_STATUSES.has(log.status)) continue;
                const status = log.status === 'parcel_created' ? 'pending-pickup' : log.status;
                const previous = timeline[timeline.length - 1];
                // Collapses consecutive duplicate statuses (e.g. a retried
                // status update) into one entry - the first occurrence's
                // timestamp is the meaningful one; repeats carry no
                // additional business meaning for a customer-facing view.
                if (previous && previous.status === status) continue;
                timeline.push({ status, timestamp: log.createdAt });
            }

            const updatedAt = sortedLogs.length
                ? sortedLogs[sortedLogs.length - 1].createdAt
                : parcel.createdAt;

            res.send({
                trackingCode,
                currentStatus: parcel.deliveryStatus || 'pending-pickup',
                createdAt: parcel.createdAt,
                updatedAt,
                timeline
            });
        } catch (error) {
            console.error('Public tracking lookup failed:', error.message);
            res.status(500).send({ message: 'Unable to load repair tracking information right now.' });
        }
    }
}

module.exports = TrackingController;

