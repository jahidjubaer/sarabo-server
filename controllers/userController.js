const { ObjectId } = require('mongodb');
const { client } = require('../config/database');
const { normalize } = require('../services/paymentProcessor');

class UserController {
    constructor(models, collections) {
        this.User = models.User;
        this.Parcel = models.Parcel;
        this.collections = collections;
    }

    async getAllUsers(req, res) {
        try {
            const searchText = req.query.searchText;
            const users = await this.User.findAll(searchText);
            res.send(users);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching users', error: error.message });
        }
    }

    async getUserById(req, res) {
        try {
            const id = req.params.id;
            const user = await this.User.findById(id);
            
            if (!user) {
                return res.status(404).send({ message: 'User not found' });
            }
            
            // Users can only view their own profile, or admins can view any
            if (user.email !== req.decoded_email) {
                const currentUser = await this.User.findByEmail(req.decoded_email);
                if (!currentUser || currentUser.role !== 'admin') {
                    return res.status(403).send({ message: 'forbidden access' });
                }
            }
            
            res.send(user);
        } catch (error) {
            res.status(500).send({ message: 'Error fetching user', error: error.message });
        }
    }

    // Returns the ROLE of the caller's own account, derived entirely from
    // the verified Firebase token (req.decoded_email) - never from a URL,
    // query, or body-supplied identity. Replaces the old GET
    // /users/:email/role (Phase 5.10 privacy hardening): no email can ever
    // appear in this route's path, so Vercel's own platform-level request
    // logging (which happens before any application-log sanitization) can
    // no longer record a real email address for this endpoint. The
    // cross-user-by-email lookup the old route also allowed for admins is
    // intentionally not preserved here - GET /users (search/list) and GET
    // /users/:id already cover that need without an email ever appearing in
    // a URL.
    async getMyRole(req, res) {
        try {
            const email = req.decoded_email;
            if (!email) {
                // Verified token without an email claim - extremely
                // unlikely for this app's Google/password providers, but
                // must fail safely here rather than ever falling back to a
                // URL/query/body-supplied value.
                return res.status(401).send({ message: 'unauthorized access', code: 'AUTHENTICATION_REQUIRED' });
            }
            const role = await this.User.findRoleByEmail(email);
            res.send({ role: role || 'user' });
        } catch (error) {
            res.status(500).send({ message: 'Error fetching user role', error: error.message });
        }
    }

    // Syncs the currently-authenticated Firebase account into MongoDB after
    // registration or a Google-login sync. Identity always comes from the
    // verified token, never the request body - a caller cannot create a
    // record for a different email, and cannot influence their own role.
    // Only an explicit allowlist of safe profile fields is ever read from
    // the body; anything else supplied (including `role`) is silently
    // ignored, and `User.create` itself also forces role: 'user'
    // unconditionally as a second layer.
    async createUser(req, res) {
        try {
            const email = req.decoded_email;
            const { displayName, photoURL } = req.body;
            const userExists = await this.User.exists(email);

            if (userExists) {
                return res.send({ message: 'user exists', code: 'USER_ALREADY_EXISTS' });
            }

            const result = await this.User.create({ email, displayName, photoURL });
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error creating user', code: 'INTERNAL_ERROR' });
        }
    }

    // Admin-only role update, hardened (Phase 6.2 Unit 1 / BL-002, BL-005).
    // Every safety check below runs inside one transaction so the eventual
    // write is guarded against stale reads, not just validated up front:
    //   - target role must be one of UserModel.VALID_ROLES (no arbitrary
    //     string can ever be written to users.role)
    //   - the acting admin can never demote their own account away from
    //     admin (self-demotion is blocked before any write)
    //   - the last remaining admin account can never be demoted (see the
    //     "fence" comment below for how this stays correct under
    //     concurrent requests targeting two different admins)
    //   - promoting a user to 'rider' requires an existing, approved
    //     technician application for that exact email - this is the narrow
    //     BL-005 guard: a generic role edit must never produce
    //     users.role = 'rider' with no corresponding riders document
    // Identity for the acting admin comes only from req.decoded_email (the
    // verified token) - never from the request body/query/params.
    async updateUserRole(req, res) {
        const targetId = req.params.id;
        const requestedRole = req.body?.role;

        try {
            if (!ObjectId.isValid(targetId)) {
                return res.status(400).send({ message: 'invalid user id', code: 'INVALID_USER_ID' });
            }

            if (typeof requestedRole !== 'string') {
                return res.status(400).send({ message: 'invalid role', code: 'INVALID_ROLE' });
            }
            const normalizedRole = requestedRole.trim();
            const VALID_ROLES = this.User.constructor.VALID_ROLES;
            if (!normalizedRole || !VALID_ROLES.includes(normalizedRole)) {
                return res.status(400).send({ message: 'invalid role', code: 'INVALID_ROLE' });
            }

            const actingEmail = req.decoded_email;
            const actingAdmin = actingEmail ? await this.collections.users.findOne({ email: actingEmail }) : null;
            // verifyAdmin already guarantees the caller is an admin - this is
            // defense in depth, and it's also how we get actingAdmin._id for
            // the self-demotion check below without ever trusting a
            // body/query-supplied identity.
            if (!actingAdmin || actingAdmin.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access', code: 'FORBIDDEN' });
            }

            const mongoSession = client.startSession();
            let outcome = null;
            try {
                await mongoSession.withTransaction(async () => {
                    const targetUser = await this.collections.users.findOne(
                        { _id: new ObjectId(targetId) },
                        { session: mongoSession }
                    );
                    if (!targetUser) {
                        outcome = { httpStatus: 404, code: 'USER_NOT_FOUND', message: 'user not found' };
                        return;
                    }

                    const currentRole = targetUser.role;
                    const isSelf = targetUser._id.equals(actingAdmin._id);
                    const isDemotionFromAdmin = currentRole === 'admin' && normalizedRole !== 'admin';

                    if (isSelf && isDemotionFromAdmin) {
                        outcome = { httpStatus: 409, code: 'SELF_DEMOTION_BLOCKED', message: 'you cannot change your own admin role' };
                        return;
                    }

                    if (currentRole === normalizedRole) {
                        // Genuine no-op, including an admin re-confirming
                        // their own admin role - never treated as an error.
                        outcome = { idempotent: true, role: normalizedRole };
                        return;
                    }

                    if (isDemotionFromAdmin) {
                        // Concurrency fence: a plain "count then update the
                        // target" check is not enough - two concurrent
                        // transactions demoting two *different* admins can
                        // each independently observe the same admin count
                        // (neither sees the other's still-uncommitted write)
                        // and both commit, leaving zero admins. Two earlier
                        // designs were tried and empirically disproved by
                        // real concurrent-request testing before this one:
                        // (1) a same-value touch on "every other admin"
                        // fails because which documents get touched depends
                        // on the target, so two transactions demoting two
                        // different admins don't reliably share one; (2) a
                        // same-value touch on one deterministic document
                        // (lowest-_id admin) still failed, because a $set to
                        // a value a document already has appears not to
                        // register as real contention for MongoDB's
                        // transaction conflict detection. This version
                        // increments a counter on that same deterministic
                        // document instead - a genuine value change every
                        // time, on the exact same document for every
                        // concurrent demote-from-admin transaction
                        // regardless of which admin it's demoting - which
                        // reliably forces a real write conflict. Whichever
                        // transaction loses that conflict is retried by
                        // withTransaction()'s built-in retry, and the retry
                        // re-evaluates the admin count against the
                        // now-committed state. _roleGuardVersion exists
                        // solely for this fence and is never read anywhere.
                        const currentAdmins = await this.collections.users.find(
                            { role: 'admin' },
                            { session: mongoSession, projection: { _id: 1 }, sort: { _id: 1 } }
                        ).toArray();

                        const adminCount = currentAdmins.length;
                        if (adminCount <= 1) {
                            outcome = { httpStatus: 409, code: 'LAST_ADMIN_BLOCKED', message: 'the final admin account cannot be demoted' };
                            return;
                        }

                        const fenceId = currentAdmins[0]._id;
                        await this.collections.users.updateOne(
                            { _id: fenceId, role: 'admin' },
                            { $inc: { _roleGuardVersion: 1 } },
                            { session: mongoSession }
                        );
                    }

                    if (normalizedRole === 'rider') {
                        const email = normalize(targetUser.email);
                        const riderDoc = email
                            ? await this.collections.riders.findOne({ email }, { session: mongoSession })
                            : null;
                        if (!riderDoc) {
                            outcome = { httpStatus: 409, code: 'RIDER_RECORD_NOT_FOUND', message: 'no technician application exists for this user' };
                            return;
                        }
                        if (riderDoc.status !== 'approved') {
                            outcome = { httpStatus: 409, code: 'RIDER_NOT_APPROVED', message: 'technician application for this user is not approved' };
                            return;
                        }
                    }

                    // Guarded atomically against a concurrent change to this
                    // exact target between our read above and this write.
                    const updateResult = await this.collections.users.updateOne(
                        { _id: targetUser._id, role: currentRole },
                        { $set: { role: normalizedRole } },
                        { session: mongoSession }
                    );
                    if (updateResult.matchedCount === 0) {
                        outcome = { httpStatus: 409, code: 'ROLE_UPDATE_CONFLICT', message: 'user role was changed concurrently' };
                        return;
                    }

                    outcome = { success: true, role: normalizedRole };
                });
            } finally {
                await mongoSession.endSession();
            }

            if (outcome.idempotent) {
                return res.send({ message: 'user role already set', role: outcome.role, alreadyConsistent: true });
            }
            if (outcome.success) {
                return res.send({ message: 'user role updated', role: outcome.role });
            }
            return res.status(outcome.httpStatus).send({ message: outcome.message, code: outcome.code });
        } catch (error) {
            console.error('User role update transaction aborted:', error.message);
            res.status(500).send({ message: 'Error updating user role', code: 'INTERNAL_ERROR' });
        }
    }
}

module.exports = UserController;

