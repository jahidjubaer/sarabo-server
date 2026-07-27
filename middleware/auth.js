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
        next();
    }
    catch (err) {
        return res.status(401).send({ message: 'unauthorized access', code: 'AUTHENTICATION_REQUIRED' })
    }
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

const verifyRider = async (req, res, next) => {
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

module.exports = { verifyFBToken, verifyAdmin, verifyRider };

