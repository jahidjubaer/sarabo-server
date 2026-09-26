// Prints a base64 FB_SERVICE_KEY for CI: a correctly shaped service account
// with a freshly generated, throwaway private key. firebase-admin only checks
// the shape at startup and the tests never call Firebase, so no real
// credential is needed (or ever given to CI).
const { generateKeyPairSync } = require('crypto');

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const serviceAccount = {
    type: 'service_account',
    project_id: 'sarabo-ci',
    private_key_id: 'ci',
    private_key: privateKey,
    client_email: 'ci@sarabo-ci.iam.gserviceaccount.com',
    client_id: '0',
    token_uri: 'https://oauth2.googleapis.com/token',
};

process.stdout.write(Buffer.from(JSON.stringify(serviceAccount)).toString('base64'));
