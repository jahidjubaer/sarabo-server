class UserController {
    constructor(models) {
        this.User = models.User;
        this.Parcel = models.Parcel;
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

    async updateUserRole(req, res) {
        try {
            const id = req.params.id;
            const roleInfo = req.body;
            const result = await this.User.updateRole(id, roleInfo.role);
            res.send(result);
        } catch (error) {
            res.status(500).send({ message: 'Error updating user role', error: error.message });
        }
    }
}

module.exports = UserController;

