// Non-destructive production smoke check (Phase 5.9 / 5.9A). Every request
// here is read-only/anonymous and safe to run repeatedly against a live
// production deployment: no authentication, no writes, no Stripe checkout,
// no parcel or rider creation. Never prints response bodies verbatim - only
// derived, non-sensitive facts (status codes, booleans) ever reach stdout.
//
// Usage: node scripts/production-smoke.js [baseUrl]
// Defaults to https://sarabo-server.vercel.app if no argument is given.
// The target must always be https:// - this deliberately refuses to run
// against a plaintext http:// endpoint (which also rules out an accidental
// local-dev target), since this script's whole purpose is checking the real
// deployed production service, never a local server.

const https = require('https');
const { URL } = require('url');

const REQUEST_TIMEOUT_MS = 5000;

const baseUrl = process.argv[2] || 'https://sarabo-server.vercel.app';

const parsedBaseUrl = new URL(baseUrl);
if (parsedBaseUrl.protocol !== 'https:') {
    console.error(`Refusing to run: target must use https:// (got "${parsedBaseUrl.protocol}").`);
    process.exit(1);
}

function request(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, baseUrl);
        const req = https.request(
            url,
            { method: options.method || 'GET', headers: options.headers || {}, timeout: REQUEST_TIMEOUT_MS },
            (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => resolve({ status: res.statusCode, data }));
            }
        );
        req.on('timeout', () => req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`)));
        req.on('error', reject);
        req.end();
    });
}

let failures = 0;

function check(name, actualStatus, expectedStatuses) {
    const ok = expectedStatuses.includes(actualStatus);
    console.log(`${ok ? '✓' : '✗'} ${name} - status ${actualStatus} (expected one of: ${expectedStatuses.join(', ')})`);
    if (!ok) failures += 1;
}

async function main() {
    console.log(`Production smoke check against ${baseUrl}\n`);

    const root = await request('/');
    check('GET /', root.status, [200]);

    const health = await request('/health');
    check('GET /health', health.status, [200, 503]);

    const notifications = await request('/notifications');
    check('GET /notifications (unauthenticated)', notifications.status, [401]);

    const tracking = await request('/public/trackings/SMOKE-CHECK-NONEXISTENT');
    check('GET /public/trackings/:code (nonexistent)', tracking.status, [404, 429]);

    const corsRejected = await request('/', { headers: { Origin: 'http://smoke-check-not-allowed.example' } });
    check('GET / (unexpected Origin, expect CORS rejection)', corsRejected.status, [403]);

    console.log('');
    if (failures === 0) {
        console.log('All smoke checks passed.');
        process.exit(0);
    } else {
        console.log(`${failures} smoke check(s) failed.`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Smoke check execution error:', err.message);
    process.exit(1);
});
