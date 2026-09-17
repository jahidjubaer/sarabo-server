async function verifyFirebaseIdToken(token) {
    const admin = require('../config/firebase');
    return admin.auth().verifyIdToken(token);
}

function unauthorized(res) {
    return res.status(401).send({
        message: 'unauthorized access',
        code: 'AUTHENTICATION_REQUIRED',
    });
}

function createOptionalAuth({ verifyIdToken = verifyFirebaseIdToken } = {}) {
    return async function optionalAuth(req, res, next) {
        const authorization = req.headers && req.headers.authorization;
        if (authorization === undefined) {
            req.supportAuth = Object.freeze({ authenticated: false });
            return next();
        }
        if (typeof authorization !== 'string') return unauthorized(res);

        const match = authorization.match(/^Bearer ([^\s]+)$/);
        if (!match) return unauthorized(res);
        try {
            const decoded = await verifyIdToken(match[1]);
            const uid = decoded && (decoded.uid || decoded.sub);
            if (typeof uid !== 'string' || uid.trim().length === 0) {
                return unauthorized(res);
            }
            req.supportAuth = Object.freeze({ authenticated: true, uid: uid.trim() });
            return next();
        } catch {
            return unauthorized(res);
        }
    };
}

const optionalAuth = createOptionalAuth();

module.exports = { optionalAuth, createOptionalAuth };
