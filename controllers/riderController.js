const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { normalize } = require('../services/paymentProcessor');
const { REQUESTABLE_STATUSES, ROLE_FOR_STATUS, isValidRiderTransition } = require('../utils/riderStatus');

class RiderController {
    constructor(models, collections) {
        this.Rider = models.Rider;
        this.User = models.User;
        this.Parcel = models.Parcel;
        this.collections = collections;
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
                        from: "trackings",
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

    async createRider(req, res) {
        try {
            const rider = req.body;
            const result = await this.Rider.create(rider);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error creating technician application', error: error.message });
        }
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

                    // Guarded atomically against a concurrent admin action on
                    // the same application - re-verifies the status is still
                    // what was just read, not just a read-then-write check.
                    const technicianUpdateResult = await this.collections.riders.updateOne(
                        { _id: technician._id, status: currentStatus },
                        { $set: { status: requestedStatus, workStatus: 'available' } },
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
}

module.exports = RiderController;

