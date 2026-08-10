const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { normalize } = require('../services/paymentProcessor');
const { createNotificationService } = require('../services/notificationService');
const { REQUESTABLE_STATUSES, ROLE_FOR_STATUS, isValidRiderTransition } = require('../utils/riderStatus');
const { ACTIVE_STATUSES } = require('../utils/parcelStatus');
const { validateTechnicianExpertise, normalizeTechnicianExpertise } = require('../utils/technicianExpertise');

// Explicit allow-list for the (unauthenticated) technician-application body
// (Phase 8.7A mass-assignment protection). ONLY these applicant-supplied
// profile fields are ever persisted from POST /riders. Operational and
// authoritative fields are never taken from the client: `status` is forced to
// 'pending' by the Rider model, `workStatus` is initialized server-side only on
// approval, `role` lives on the users collection and changes only through the
// admin approval transaction, and anything else a caller tries to inject
// (approved, riderId, ratings, moderation flags, ...) is simply dropped here.
const APPLICATION_ALLOWED_FIELDS = ['name', 'email', 'phone', 'region', 'district', 'address', 'nid', 'expertise'];

// Identity + matching-critical fields a new application must provide so the
// resulting technician can actually be matched (the eligible-technician matcher
// requires a complete name/region/district profile AND a non-empty valid
// expertise array - see services/technicianEligibilityService.js).
const REQUIRED_APPLICATION_FIELDS = ['name', 'email', 'region', 'district'];

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

// A technician record has a "matchable profile" when it carries everything the
// eligible-technician matcher treats as a hard requirement: a complete
// name/region/district profile and a valid, non-empty canonical expertise
// array. Used both to validate a new application and to gate admin approval so
// a legacy/incomplete application can never be approved into an unmatchable
// technician.
function hasMatchableProfile(rider) {
    return isNonEmptyString(rider.name)
        && isNonEmptyString(rider.region)
        && isNonEmptyString(rider.district)
        && Array.isArray(rider.expertise)
        && rider.expertise.length > 0
        && validateTechnicianExpertise(rider.expertise).valid;
}

class RiderController {
    constructor(models, collections) {
        this.Rider = models.Rider;
        this.User = models.User;
        this.Parcel = models.Parcel;
        this.collections = collections;
        this.notifications = createNotificationService(models);
    }

    async getAllRiders(req, res) {
        try {
            const { status, district, workStatus } = req.query;
            const query = {};

            if (status) {
                query.status = status;
            }
            if (district) {
                query.district = district;
            }
            if (workStatus) {
                query.workStatus = workStatus;
            }

            const result = await this.Rider.findAll(query);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching technicians', error: error.message });
        }
    }

    async getDeliveryPerDay(req, res) {
        try {
            const email = req.decoded_email;
            const pipeline = [
                {
                    $match: {
                        riderEmail: email,
                        deliveryStatus: "parcel_delivered"
                    }
                },
                {
                    $lookup: {
                        from: "tracking_events",
                        localField: "trackingId",
                        foreignField: "trackingId",
                        as: "parcel_trackings"
                    }
                },
                {
                    $unwind: "$parcel_trackings"
                },
                {
                    $match: {
                        "parcel_trackings.status": "parcel_delivered"
                    }
                },
                {
                    $addFields: {
                        deliveryDay: {
                            $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$parcel_trackings.createdAt"
                            }
                        }
                    }
                },
                {
                    $group: {
                        _id: "$deliveryDay",
                        deliveredCount: { $sum: 1 }
                    }
                }
            ];

            const result = await this.collections.parcels.aggregate(pipeline).toArray();
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching repair stats', error: error.message });
        }
    }

    // Technician application intake (Phase 8.7A). This route is unauthenticated
    // (routes/riders.js), so the body is treated as fully untrusted: it is
    // reduced to an explicit allow-list (APPLICATION_ALLOWED_FIELDS) before
    // anything is persisted - no client-supplied status/workStatus/role/riderId
    // or moderation field can ride along. The application must now provide the
    // information the eligible-technician matcher requires (name/region/district
    // + a valid, non-empty canonical expertise array), so an approved applicant
    // becomes matchable without any manual database edit. Legacy riders already
    // in the collection without expertise are untouched here - approval-time
    // gating (updateRiderStatus) handles them.
    async createRider(req, res) {
        try {
            const body = req.body || {};

            // 1. Allow-list projection (mass-assignment protection).
            const application = {};
            for (const field of APPLICATION_ALLOWED_FIELDS) {
                if (body[field] !== undefined) {
                    application[field] = typeof body[field] === 'string' ? body[field].trim() : body[field];
                }
            }

            // 2. Required identity + matching profile fields.
            for (const field of REQUIRED_APPLICATION_FIELDS) {
                if (!isNonEmptyString(application[field])) {
                    return res.status(400).send({ message: `${field} is required`, code: 'MISSING_APPLICATION_FIELD' });
                }
            }

            // 3. Expertise is required, and must be a valid, non-empty canonical
            //    array (an empty array passes the shape validator, so reject it
            //    explicitly before deferring to the canonical validator).
            if (!Array.isArray(application.expertise) || application.expertise.length === 0) {
                return res.status(400).send({ message: 'at least one area of expertise is required', code: 'MISSING_EXPERTISE' });
            }
            const validation = validateTechnicianExpertise(application.expertise);
            if (!validation.valid) {
                return res.status(400).send({ message: validation.message, code: validation.code });
            }
            application.expertise = normalizeTechnicianExpertise(application.expertise);

            const result = await this.Rider.create(application);

            // Best-effort admin fan-out - this route is unauthenticated
            // (routes/riders.js), so there is no req.decoded_email; the actor
            // is the applicant's own submitted email, and actorRole is
            // always null since no verified identity exists for it. A
            // lookup or notification failure here must never fail
            // technician application creation, since the application itself
            // has already been durably created above.
            await this.notifyAdminsOfNewApplication(application, result.insertedId);

            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error creating technician application', error: error.message });
        }
    }

    async notifyAdminsOfNewApplication(rider, riderId) {
        let adminEmails = [];
        try {
            adminEmails = await this.User.findEmailsByRole('admin');
        } catch (error) {
            console.error('Admin lookup failed for technician application notification (non-fatal):', error.message);
            return;
        }
        if (adminEmails.length === 0) {
            return;
        }

        const applicantEmail = normalize(rider.email);
        await Promise.all(adminEmails.map(async (adminEmail) => {
            try {
                await this.notifications.createNotification({
                    recipientEmail: adminEmail,
                    recipientRole: 'admin',
                    type: 'technician_application_submitted',
                    entityType: 'rider',
                    entityId: riderId.toString(),
                    actorEmail: applicantEmail || null,
                    actorRole: null,
                    // Each admin's deduplicationKey uniqueness comes from the
                    // trusted recipientEmail in createNotification's render
                    // context (see utils/notificationEvents.js), never from
                    // metadata - recipientEmail is never persisted as metadata.
                    metadata: {}
                });
            } catch (error) {
                console.error('Admin notification failed for technician application (non-fatal):', error.message);
            }
        }));
    }

    // Whether any repair request currently in an active lifecycle status
    // (utils/parcelStatus.js's ACTIVE_STATUSES) names this technician as its
    // assigned rider. Read inside the caller's own transaction session so
    // the check is consistent with everything else read/written in that
    // same transaction attempt.
    async hasActiveAssignment(riderId, session) {
        const activeParcel = await this.collections.parcels.findOne(
            { riderId: riderId.toString(), deliveryStatus: { $in: ACTIVE_STATUSES } },
            { session, projection: { _id: 1 } }
        );
        return !!activeParcel;
    }

    // Admin-only technician approval/rejection. The application's status and
    // the linked user's role are one transactionally consistent operation -
    // both commit together or neither does. Previously these were two
    // independent writes using a client-supplied email for the role update;
    // if the second write failed or matched zero, the application could end
    // up "approved" while the user never actually gained rider access, and
    // the admin still saw success. The linked email is always read from the
    // already-validated technician record inside the transaction, never
    // trusted from the request body.
    async updateRiderStatus(req, res) {
        const requestedStatus = req.body.status;
        try {
            const riderId = req.params.id;

            if (!ObjectId.isValid(riderId)) {
                return res.status(400).send({ message: 'invalid technician id', code: 'INVALID_TECHNICIAN_ID' });
            }
            if (!REQUESTABLE_STATUSES.includes(requestedStatus)) {
                return res.status(400).send({ message: 'invalid technician status', code: 'INVALID_TECHNICIAN_STATUS' });
            }

            const mongoSession = client.startSession();
            // Set exactly once inside the transaction to describe the
            // outcome to report after the session ends - either a genuine
            // conflict/not-found (no throw needed, nothing was written) or a
            // success/idempotent-success marker. A thrown error is reserved
            // for a write actually failing after another write in the same
            // transaction already succeeded, so the whole thing rolls back.
            let outcome = null;
            try {
                await mongoSession.withTransaction(async () => {
                    const technician = await this.collections.riders.findOne(
                        { _id: new ObjectId(riderId) },
                        { session: mongoSession }
                    );
                    if (!technician) {
                        outcome = { httpStatus: 404, code: 'TECHNICIAN_NOT_FOUND', message: 'technician not found' };
                        return;
                    }

                    const currentStatus = technician.status;
                    const email = normalize(technician.email);

                    if (currentStatus === requestedStatus) {
                        // Same-status request - only a genuine no-op when the
                        // linked user's role already matches too. Otherwise
                        // this is a pre-existing inconsistency between the
                        // two records, which must never be silently reported
                        // as success.
                        const linkedUser = email ? await this.collections.users.findOne({ email }, { session: mongoSession }) : null;
                        if (linkedUser && linkedUser.role === ROLE_FOR_STATUS[requestedStatus]) {
                            // Reapproval (approved -> approved) recalculates
                            // workStatus from actual assignment state rather
                            // than just reporting success - this is the only
                            // place workStatus can silently drift back to
                            // 'available' out from under an active
                            // assignment (e.g. an admin re-approving a
                            // technician the assignment path itself had
                            // already correctly marked in_delivery). Never
                            // touches `status`, never sends a notification -
                            // still genuinely idempotent from the caller's
                            // perspective. Guarded on the read workStatus too
                            // so a concurrent assignment/completion between
                            // the read above and this write is detected
                            // rather than silently overwritten.
                            if (requestedStatus === 'approved') {
                                const activeNow = await this.hasActiveAssignment(technician._id, mongoSession);
                                const correctWorkStatus = activeNow ? 'in_delivery' : 'available';
                                if (technician.workStatus !== correctWorkStatus) {
                                    await this.collections.riders.updateOne(
                                        { _id: technician._id, status: currentStatus, workStatus: technician.workStatus },
                                        { $set: { workStatus: correctWorkStatus } },
                                        { session: mongoSession }
                                    );
                                }
                            }
                            outcome = { idempotent: true };
                            return;
                        }
                        outcome = {
                            httpStatus: 409, code: 'TECHNICIAN_STATUS_CONFLICT',
                            message: 'technician application and linked user role are already inconsistent for this status'
                        };
                        return;
                    }

                    if (!isValidRiderTransition(currentStatus, requestedStatus)) {
                        // Only reachable with an unrecognized/legacy current
                        // status - every recognized-status pair other than
                        // "same status" (handled above) is already a legal
                        // transition.
                        outcome = {
                            httpStatus: 409, code: 'TECHNICIAN_STATUS_CONFLICT',
                            message: 'technician application status does not allow this transition'
                        };
                        return;
                    }

                    if (!email) {
                        outcome = { httpStatus: 404, code: 'LINKED_USER_NOT_FOUND', message: 'technician application has no valid linked email' };
                        return;
                    }

                    const linkedUser = await this.collections.users.findOne({ email }, { session: mongoSession });
                    if (!linkedUser) {
                        outcome = { httpStatus: 404, code: 'LINKED_USER_NOT_FOUND', message: 'linked user account not found' };
                        return;
                    }

                    // An admin account must never be silently downgraded by a
                    // technician-application action.
                    if (linkedUser.role === 'admin') {
                        outcome = { httpStatus: 409, code: 'LINKED_USER_ROLE_CONFLICT', message: 'linked user has an admin role and will not be modified' };
                        return;
                    }

                    // Phase 8.7A: never approve an application into an
                    // unmatchable technician. Approval requires a complete
                    // matching profile (name/region/district + a valid,
                    // non-empty canonical expertise array) - the exact hard
                    // requirements the eligible-technician matcher enforces. A
                    // legacy/incomplete application must have its expertise and
                    // service-area completed first (via the technician/admin
                    // expertise-update path) before it can be approved; blocking
                    // here is strictly safer than creating a technician who can
                    // never be matched. Only gates the approval transition -
                    // rejection of an incomplete application is always allowed.
                    if (requestedStatus === 'approved' && !hasMatchableProfile(technician)) {
                        outcome = {
                            httpStatus: 409, code: 'INCOMPLETE_TECHNICIAN_PROFILE',
                            message: 'technician application is missing the expertise or service-area information required for matching'
                        };
                        return;
                    }

                    // BL-004 follow-up: workStatus must reflect real
                    // assignment state, not just get reset to 'available' on
                    // every status change. Rejection of an actively-assigned
                    // technician is refused outright (rejecting someone
                    // mid-repair is a product decision this unit doesn't
                    // make); approval derives the correct workStatus instead
                    // of assuming one.
                    const activeAssignment = await this.hasActiveAssignment(technician._id, mongoSession);
                    if (requestedStatus === 'rejected' && activeAssignment) {
                        outcome = {
                            httpStatus: 409, code: 'TECHNICIAN_HAS_ACTIVE_ASSIGNMENT',
                            message: 'technician has an active repair assignment and cannot be rejected'
                        };
                        return;
                    }
                    const newWorkStatus = requestedStatus === 'approved'
                        ? (activeAssignment ? 'in_delivery' : 'available')
                        : 'available';

                    // Guarded atomically against a concurrent admin action on
                    // the same application, AND against a concurrent
                    // assignment/completion changing workStatus between the
                    // read above and this write - the predicate includes
                    // both fields we actually read, not just the one we're
                    // changing, so either kind of concurrent change is
                    // detected here rather than silently overwritten.
                    const technicianUpdateResult = await this.collections.riders.updateOne(
                        { _id: technician._id, status: currentStatus, workStatus: technician.workStatus },
                        { $set: { status: requestedStatus, workStatus: newWorkStatus } },
                        { session: mongoSession }
                    );
                    if (technicianUpdateResult.matchedCount === 0) {
                        outcome = { httpStatus: 409, code: 'TECHNICIAN_STATUS_CONFLICT', message: 'technician application was changed concurrently' };
                        return;
                    }

                    // Re-verifies the linked user's role hasn't changed since
                    // it was read moments ago in this same transaction.
                    const userUpdateResult = await this.collections.users.updateOne(
                        { _id: linkedUser._id, role: linkedUser.role },
                        { $set: { role: ROLE_FOR_STATUS[requestedStatus] } },
                        { session: mongoSession }
                    );
                    if (userUpdateResult.matchedCount === 0) {
                        // The linked user's role changed between our read and
                        // this write - abort the whole transaction (including
                        // the technician update above) rather than leave the
                        // application approved/rejected with no matching
                        // change to the user's own role.
                        throw Object.assign(
                            new Error('linked user role update failed'),
                            { code: requestedStatus === 'approved' ? 'TECHNICIAN_APPROVAL_FAILED' : 'TECHNICIAN_REJECTION_FAILED' }
                        );
                    }

                    // Notification joins this same transaction (Strategy A) -
                    // a failure here aborts the technician-status and
                    // linked-user-role updates above exactly like any other
                    // guarded write in this transaction. recipientRole for
                    // the rejection path is 'user' - the role the linked
                    // user was just set to above, per
                    // ROLE_FOR_STATUS.rejected, never 'rider'.
                    if (requestedStatus === 'approved') {
                        await this.notifications.createNotification({
                            session: mongoSession,
                            recipientEmail: email,
                            recipientRole: 'rider',
                            type: 'technician_application_approved',
                            entityType: 'rider',
                            entityId: technician._id.toString(),
                            actorEmail: req.decoded_email,
                            actorRole: 'admin',
                            metadata: {}
                        });
                    } else {
                        await this.notifications.createNotification({
                            session: mongoSession,
                            recipientEmail: email,
                            recipientRole: 'user',
                            type: 'technician_application_rejected',
                            entityType: 'rider',
                            entityId: technician._id.toString(),
                            actorEmail: req.decoded_email,
                            actorRole: 'admin',
                            metadata: {}
                        });
                    }

                    outcome = { success: true };
                });
            } finally {
                await mongoSession.endSession();
            }

            if (outcome.idempotent) {
                return res.send({ message: 'technician status already set', status: requestedStatus, alreadyConsistent: true });
            }
            if (outcome.success) {
                return res.send({ message: 'technician status updated', status: requestedStatus, alreadyConsistent: false });
            }
            return res.status(outcome.httpStatus).send({ message: outcome.message, code: outcome.code });
        } catch (error) {
            const failureCode = requestedStatus === 'approved' ? 'TECHNICIAN_APPROVAL_FAILED' : 'TECHNICIAN_REJECTION_FAILED';
            if (error.code === 'TECHNICIAN_APPROVAL_FAILED' || error.code === 'TECHNICIAN_REJECTION_FAILED') {
                console.error('Technician status transaction aborted:', error.code);
                return res.status(500).send({ message: 'Error updating linked user role', code: error.code });
            }
            console.error('Technician status transaction aborted:', error.message);
            res.status(500).send({ message: 'Error updating technician status', code: failureCode });
        }
    }

    // Full-replacement expertise update (Phase 6.3 Unit 3). The technician
    // may update their own expertise; an admin may update any technician;
    // every other authenticated caller is forbidden. Deliberately does NOT
    // reveal to a non-self, non-admin caller whether a given technician id
    // even exists - a nonexistent id and an id belonging to someone else
    // both produce the exact same 403 FORBIDDEN for such a caller, so this
    // route can never be used as an existence oracle by an unrelated
    // account. An admin caller still receives an honest 404 for a genuinely
    // missing id, since an admin is privileged to manage any technician.
    // This mirrors the "never distinguish absent from foreign" privacy
    // pattern already established by models/Notification.js.
    async updateTechnicianExpertise(req, res) {
        try {
            const riderId = req.params.id;
            if (!ObjectId.isValid(riderId)) {
                return res.status(400).send({ message: 'invalid technician id', code: 'INVALID_TECHNICIAN_ID' });
            }

            const requesterEmail = normalize(req.decoded_email);

            // Read once, before the transaction/retry loop below -
            // deliberately NOT re-read inside the transaction body.
            // mongoSession.withTransaction retries its entire callback on a
            // transient write conflict; if this read (and therefore the
            // optimistic-concurrency guard it feeds) were inside that
            // retried callback, a retry would transparently re-read the
            // *other* writer's already-committed value and adopt it as its
            // own new baseline, silently overwriting it again instead of
            // ever reporting a conflict. Capturing it once here, outside the
            // retry boundary, is what makes "exactly one winner, one
            // controlled conflict" actually hold under a genuine race
            // (verified empirically - the in-transaction-read version of
            // this method let two concurrent updates both report success,
            // the second one silently clobbering the first).
            const requester = requesterEmail ? await this.collections.users.findOne({ email: requesterEmail }) : null;
            const isAdmin = !!requester && requester.role === 'admin';
            const technician = await this.collections.riders.findOne({ _id: new ObjectId(riderId) });

            if (!technician) {
                const notFound = isAdmin
                    ? { httpStatus: 404, code: 'TECHNICIAN_NOT_FOUND', message: 'technician not found' }
                    : { httpStatus: 403, code: 'FORBIDDEN', message: 'not authorized to update this technician\'s expertise' };
                return res.status(notFound.httpStatus).send({ message: notFound.message, code: notFound.code });
            }

            const isSelf = !!requesterEmail && normalize(technician.email) === requesterEmail;
            if (!isSelf && !isAdmin) {
                return res.status(403).send({ message: 'not authorized to update this technician\'s expertise', code: 'FORBIDDEN' });
            }

            const expertiseInput = req.body && req.body.expertise;
            const validation = validateTechnicianExpertise(expertiseInput);
            if (!validation.valid) {
                return res.status(400).send({ message: validation.message, code: validation.code });
            }
            const normalizedExpertise = normalizeTechnicianExpertise(expertiseInput);
            const hasExpertiseField = Object.prototype.hasOwnProperty.call(technician, 'expertise');

            const mongoSession = client.startSession();
            let outcome = null;
            try {
                await mongoSession.withTransaction(async () => {
                    // Re-checked fresh on every attempt, including any
                    // automatic retry - unlike the expertise snapshot above,
                    // this MUST reflect the latest committed state: if a
                    // separate assignment transaction has committed since
                    // the reads above, this has to detect it (on this
                    // attempt or a retry) and block the write.
                    const activeAssignment = await this.hasActiveAssignment(technician._id, mongoSession);
                    if (activeAssignment) {
                        outcome = {
                            httpStatus: 409, code: 'TECHNICIAN_HAS_ACTIVE_ASSIGNMENT',
                            message: 'technician has an active repair assignment and cannot update expertise'
                        };
                        return;
                    }

                    const updateResult = await this.Rider.replaceExpertise({
                        id: technician._id,
                        hasExpertiseField,
                        expectedExpertise: technician.expertise,
                        newExpertise: normalizedExpertise,
                        session: mongoSession
                    });
                    if (updateResult.matchedCount === 0) {
                        // Either a concurrent expertise update, or a
                        // concurrent assignment that changed this document
                        // between the reads above and this write - both are
                        // reported the same way: the caller's snapshot was
                        // stale, never silently overwritten.
                        outcome = { httpStatus: 409, code: 'EXPERTISE_UPDATE_CONFLICT', message: 'technician expertise was changed concurrently' };
                        return;
                    }

                    outcome = { success: true, expertise: normalizedExpertise };
                });
            } finally {
                await mongoSession.endSession();
            }

            if (outcome.success) {
                return res.send({ message: 'technician expertise updated', expertise: outcome.expertise });
            }
            return res.status(outcome.httpStatus).send({ message: outcome.message, code: outcome.code });
        } catch (error) {
            console.error('Technician expertise update transaction aborted:', error.message);
            res.status(500).send({ message: 'Error updating technician expertise', code: 'EXPERTISE_UPDATE_FAILED' });
        }
    }
}

module.exports = RiderController;

