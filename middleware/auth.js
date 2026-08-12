const admin = require('../config/firebase');

const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access', code: 'AUTHENTICATION_REQUIRED' })
    }

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        req.decoded_email = decoded.email;
        // Firebase Admin includes email_verified in the decoded ID token. This
        // is the authoritative verification signal (Firebase is the authority,
        // provider-independent) - captured here so verifyEmailVerified below
        // can gate sensitive customer mutations WITHOUT trusting any client-
        // supplied flag or a second database boolean. Coerced to a strict
        // boolean so a missing/undefined claim is treated as NOT verified.
        req.decoded_email_verified = decoded.email_verified === true;
        next();
    }
    catch (err) {
        return res.status(401).send({ message: 'unauthorized access', code: 'AUTHENTICATION_REQUIRED' })
    }
}

// Email-verification gate for sensitive customer business mutations (Phase
// 8.1). MUST run after verifyFBToken, which sets req.decoded_email_verified
// from the authoritative decoded Firebase token. Accepts ONLY an explicit
// verified state; a missing/false claim is rejected. Returns 403 (the request
// is authenticated but not permitted) with a safe code - never 401, which
// would wrongly signal an invalid session and trigger a client logout. No
// database lookup, no role mutation, no raw Firebase internals leaked.
const verifyEmailVerified = (req, res, next) => {
    if (req.decoded_email_verified === true) {
        return next();
    }
    return res.status(403).send({
        message: 'email verification required',
        code: 'EMAIL_NOT_VERIFIED',
    });
}

const verifyAdmin = async (req, res, next) => {
    if (!req.collections) {
        return res.status(500).send({ message: 'Database collections not available' });
    }
    const { users: userCollection } = req.collections;
    const email = req.decoded_email;
    const query = { email };
    const user = await userCollection.findOne(query);

    if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access', code: 'FORBIDDEN' });
    }

    next();
}

const verifyTechnician = async (req, res, next) => {
    if (!req.collections) {
        return res.status(500).send({ message: 'Database collections not available' });
    }
    const { users: userCollection } = req.collections;
    const email = req.decoded_email;
    const query = { email };
    const user = await userCollection.findOne(query);

    if (!user || user.role !== 'rider') {
        return res.status(403).send({ message: 'forbidden access', code: 'FORBIDDEN' });
    }

    next();
}

module.exports = { verifyFBToken, verifyAdmin, verifyTechnician, verifyEmailVerified };

