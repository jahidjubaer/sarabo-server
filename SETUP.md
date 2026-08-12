# Local Setup Guide

## Prerequisites

1. **Node.js** (v14 or higher recommended)
   - Download from [nodejs.org](https://nodejs.org/)
   - Verify installation: `node --version`

2. **MongoDB Atlas Account** (or local MongoDB)
   - The project uses MongoDB Atlas (cloud database)
   - You'll need your MongoDB connection credentials

3. **Firebase Project**
   - You'll need a Firebase service account key (JSON file)
   - The key should be base64 encoded in the `.env` file

4. **Stripe Account** (for payment functionality)
   - You'll need a Stripe secret key

## Installation Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Server Port (optional, defaults to 3000)
PORT=3000

# MongoDB Connection
# Full connection string, e.g. mongodb+srv://<user>:<password>@<cluster>/...
MONGO_URI=your_mongodb_connection_string

# Firebase Admin SDK
# This should be a base64 encoded JSON service account key
FB_SERVICE_KEY=your_base64_encoded_firebase_service_account_key

# Firebase Storage bucket (optional - only required for the damage-evidence
# upload feature, Phase 6.4). Just the bucket name, e.g.
# your-project-id.appspot.com - not a URL. Without this set, damage-upload
# endpoints fail safely with a controlled 503 STORAGE_UNAVAILABLE response;
# every other endpoint is unaffected.
FIREBASE_STORAGE_BUCKET=your_project_id.appspot.com

# Stripe Payment
STRIPE_SECRET=your_stripe_secret_key

# Stripe Webhook Signing Secret
# Required to verify that POST /stripe-webhook requests genuinely came from
# Stripe. Without it, the webhook endpoint refuses every event (500 "webhook
# not configured") rather than trusting an unsigned/unverifiable request.
# A local Stripe CLI session (`stripe listen --forward-to ...`) and a webhook
# endpoint configured in the Stripe Dashboard are two DIFFERENT signing
# secrets, even for the same Stripe account - use the one that matches
# whichever endpoint is actually receiving events for this environment:
#   - Local development: the secret printed by `stripe listen`
#   - Deployed environment: the "Signing secret" shown for that specific
#     endpoint URL under Stripe Dashboard > Developers > Webhooks
# Keep Stripe test-mode and live-mode entirely separate: a test-mode secret
# only verifies test-mode events, and vice versa.
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_signing_secret

# Site Domain
# The client origin, used for Stripe redirect URLs and for the server's CORS
# allow-list. Must include the protocol (http:// or https://) and must not
# include a trailing path or trailing slash.
# For local development, this must be the React client's dev server origin
# (not the Express server's own port) - the client (Vite) defaults to 5173:
SITE_DOMAIN=http://localhost:5173
# For a deployed environment, use the deployed client URL instead, e.g.
# https://your-client-domain.example
```

### Environment variables reference

| Name | Purpose |
|---|---|
| `FB_SERVICE_KEY` | Base64-encoded Firebase Admin service account key, used to verify Firebase ID tokens. |
| `FIREBASE_STORAGE_BUCKET` | Optional. Firebase Storage bucket name (not a URL) backing the damage-evidence upload endpoints (`/repair-requests/:id/damage-images/*`). Every other endpoint works without it; damage-upload endpoints return a controlled `STORAGE_UNAVAILABLE` (503) if unset. |
| `MONGO_URI` | MongoDB connection string. |
| `STRIPE_SECRET` | Stripe secret key, used to create checkout sessions. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret, used to verify `POST /stripe-webhook` requests. The local Stripe CLI and a deployed Stripe Dashboard webhook endpoint each have their own distinct secret - use whichever one matches the endpoint actually receiving events in this environment, and never mix test-mode and live-mode secrets. |
| `SITE_DOMAIN` | Client origin (protocol + host, no trailing path/slash) - the React client's dev server (`http://localhost:5173`) for local development, or the deployed client URL otherwise. Used for Stripe redirect URLs and allowed in the server's CORS policy. |

No actual values are listed above - see your own `.env` file (never committed) for the real configuration.

### 3. Get Firebase Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to Project Settings > Service Accounts
4. Click "Generate New Private Key"
5. Download the JSON file
6. Convert it to base64:
   ```bash
   # On Windows (PowerShell):
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("path/to/serviceAccountKey.json"))
   
   # On Mac/Linux:
   base64 -i path/to/serviceAccountKey.json
   ```
7. Copy the base64 string to `FB_SERVICE_KEY` in your `.env` file

### 4. Run the Server

```bash
npm start
```

Or:

```bash
node index.js
```

The server will start on `http://localhost:3000` (or the port specified in your `.env` file).

## Testing the Server

Once running, you can test it by visiting:
- `http://localhost:3000/` - Should return "zap is shifting shifting!"

## API Endpoints

The server provides various endpoints for:
- User management (`/users/*`)
- Repair request management (`/repair-requests/*`)
- Technician management (`/technicians/*`)
- Payment processing (`/payments/*`)
- Tracking (`/trackings/*`)
- Service definitions and pricing, read-only (`/service-definitions/*`)
- Damage-evidence upload for v2 repair requests (`/repair-requests/:id/damage-images/*`)

Most endpoints require Firebase authentication via the `Authorization` header.
Exceptions: the root health check, the Stripe webhook (`POST /stripe-webhook`,
authenticated by its Stripe signature instead), and the public repair-tracking
endpoint below.

## Damage-Evidence Upload (Phase 6.4)

Damage-evidence images for v2 repair requests use a server-authorized
direct-to-Firebase-Storage upload, not a multipart upload through this
server (Express has no upload middleware installed, and Vercel's
serverless request-body limits make routing multi-megabyte image bytes
through the API impractical). The flow is:

1. `POST /repair-requests/:id/damage-images/upload-session` - the owner requests a
   session; the server validates ownership/state/MIME/size and returns a
   short-lived Firebase Storage v4 signed upload URL. No image bytes touch
   this server.
2. The client `PUT`s the file bytes directly to that signed URL (not yet
   implemented on the client side - out of scope for this unit).
3. `POST /repair-requests/:id/damage-images/finalize` - the server re-verifies the
   *actual* stored object (content type, size) directly against Firebase
   Storage, never trusting client-declared metadata, then atomically
   attaches the image to the request (MongoDB transaction, max 3 images,
   race-safe).
4. `GET /repair-requests/:id/damage-images` (Phase 6.4 Unit 2) - the request owner,
   an admin, or the currently-assigned technician (while the assignment is
   still active) can list attached images, each with a fresh, short-lived
   signed *read* URL generated on demand. No client implementation exists
   yet for this either.

No Firebase Storage Security Rules deployment is required for this flow:
signed URLs are pre-authorized by the Admin SDK and bypass Storage Rules
entirely (rules only govern direct Firebase Client SDK access, which this
feature does not use). Objects are never made publicly readable; the
persisted `damage.images[].url` is a stable, non-public identifier, never
returned by the authorized list endpoint - actual byte access always goes
through a fresh signed read URL, generated per request, never persisted.

### Browser upload contract

`POST /repair-requests/:id/damage-images/upload-session` returns:

```json
{
  "uploadSessionId": "...",
  "upload": {
    "method": "PUT",
    "url": "https://storage.googleapis.com/...(signed)...",
    "headers": { "Content-Type": "image/jpeg" },
    "expiresAt": "2026-01-01T00:20:00.000Z"
  },
  "constraints": { "allowedMimeTypes": ["image/jpeg", "image/png", "image/webp"], "maxSizeBytes": 8388608, "maxImages": 3 }
}
```

The client must `fetch(upload.url, { method: upload.method, headers: upload.headers, body: fileBytes })` and send the **exact** `Content-Type` header shown - the signed URL was cryptographically signed with that content type, and GCS rejects the PUT if the actual header sent doesn't match.

`GET /repair-requests/:id/damage-images` returns per-image `readUrl`/`readUrlExpiresAt` (5-minute expiry) - treat `readUrl` as temporary: never persist it (localStorage, app database), keep it only in memory/component state, and re-call this endpoint after `readUrlExpiresAt` to get a fresh one. Never log or send a signed URL to analytics.

`scripts/audit-damage-uploads.js` provides a read-only report of
expired/abandoned upload sessions - it never deletes anything.

### Non-production live verification (manual, optional)

No Firebase Storage bucket is configured in this repository's default
development setup - the automated test suite never contacts real Firebase
Storage (it uses an injected fake adapter). To manually verify the real
Firebase Storage integration end-to-end, only against a **non-production**
bucket:

1. Create or reuse a Firebase project/bucket you control that is clearly
   NOT the production bucket (e.g. a separate dev/staging Firebase project).
2. Set `FIREBASE_STORAGE_BUCKET` in your local `.env` to that bucket's name.
3. Confirm the service account behind `FB_SERVICE_KEY` belongs to that same
   non-production project, or has been granted only narrow, bucket-scoped
   permissions - never a production project's service account.
4. Never point `FIREBASE_STORAGE_BUCKET` at a production bucket for
   ordinary local testing.
5. Start the local dev server (`node index.js`).
6. Create a synthetic v2 repair request (a real customer account is fine
   for a manual local check; avoid touching production data).
7. Call `POST /repair-requests/:id/damage-images/upload-session` to get a signed
   upload URL.
8. `PUT` a small test image (e.g. a few KB JPEG) to that URL with the exact
   `Content-Type` header from the response.
9. Call `POST /repair-requests/:id/damage-images/finalize` and confirm it returns
   canonical metadata (not the client's declared values).
10. Call `GET /repair-requests/:id/damage-images` and confirm a working, browser-
    loadable `readUrl` is returned for the image.
11. Confirm the persisted canonical `url` (visible only via direct database
    inspection, never via any API response) is **not** directly fetchable
    anonymously - it should 403/401 without a signed query string.
12. Call `DELETE /repair-requests/:id/damage-images/:imageId` and confirm the
    response reports success.
13. Confirm both the MongoDB metadata and the Firebase Storage object are
    gone (re-listing returns no images; the object no longer exists in the
    bucket).
14. Delete the synthetic request/session documents you created for this
    check.
15. Unset `FIREBASE_STORAGE_BUCKET` again afterward if you don't want the
    feature active in your local environment by default.

Do not perform this walkthrough against a production bucket, and never
commit real project IDs, bucket names, or credentials into this file or any
tracked file.

### Stripe webhook configuration

The webhook endpoint is `POST /stripe-webhook`. It is authenticated entirely
by the Stripe signature on the request (the `stripe-signature` header,
verified against `STRIPE_WEBHOOK_SECRET`) - there is no Firebase token
involved, and requests with a missing or invalid signature are rejected.

To receive events locally, run the Stripe CLI and forward to this endpoint:

```bash
stripe listen --forward-to localhost:3000/stripe-webhook
```

The CLI prints its own signing secret when it starts - set that as
`STRIPE_WEBHOOK_SECRET` for local development. This is a **different**
secret from the one shown for any webhook endpoint configured in the Stripe
Dashboard (Developers > Webhooks) for a deployed environment; each endpoint
URL has its own signing secret. Always use the secret that matches the
specific endpoint actually receiving events for the environment you're
running, and keep Stripe test-mode and live-mode configuration (keys and
webhook secrets) separate - a test-mode secret cannot verify a live-mode
event or vice versa.

### Public repair tracking

`GET /public/trackings/:trackingCode` is intentionally unauthenticated -
tracking codes are designed as bearer-style lookup keys, safe to share as a
link. It returns only a sanitized progress view (current status, a status
timeline, created/updated timestamps) and never customer or technician
identity, payment data, or the MongoDB document ID. It is rate-limited
per-IP and does not support search, listing, or partial-code matching -
only an exact tracking-code match resolves. The existing
`GET /trackings/:trackingId/logs` remains the authenticated, detailed
endpoint for signed-in owners/technicians/admins and is unchanged.

New repair requests receive a tracking code in the format `SRB-<random>`
(128 bits of cryptographically random entropy) rather than the older,
weaker `PRCL-YYYYMMDD-XXXXXX` format - existing codes in that older format
continue to resolve normally, they are simply no longer generated for new
requests.

### Service definitions and pricing (read-only)

`GET /service-definitions` and `GET /service-definitions/:id` are public and
unauthenticated, always active-definitions-only. Each service definition
pairs one product category with one repair category (see
`utils/productCategory.js` / `utils/repairCategory.js`) and carries a
server-owned `pricingRule` (currency, a `baseMin`/`baseMax` estimate range,
an optional `inspectionFee`, and a `version`). Prices are decimal USD, the
same representation the legacy `parcels.cost` field already uses - not
integer cents; conversion to Stripe's integer smallest unit only happens at
the eventual charge boundary, via the existing `toSmallestUnit()` in
`config/paymentConfig.js`. There is no create/update/delete endpoint yet;
service definitions are currently populated only by
`scripts/seed-service-definitions.js`.

**Provisional/demo pricing warning:** every price shipped in
`data/serviceDefinitionSeed.js` is a placeholder for local development and
testing only - none of it has been reviewed or approved by the business
owner, and none of it reflects researched real-world repair pricing.

**Seed safety:** the seed script is idempotent (upserts by the unique
`productCategorySlug` + `repairCategorySlug` pair, never overwrites an
existing row whose pricing differs) and defaults to a dry run - it only
writes when given `--confirm-seed`. It independently refuses to run against
a production database, both by checking the same production-environment
signal the rest of the codebase trusts and by rejecting any resolved
database name that looks like a production one. Never run
`--confirm-seed` against a shared or production database without the
business owner's review of the pricing involved.

```bash
node scripts/seed-service-definitions.js               # dry run (default)
node scripts/seed-service-definitions.js --confirm-seed # writes new rows only
```

## Troubleshooting

1. **MongoDB Connection Issues**
   - Verify your MongoDB Atlas credentials
   - Check if your IP is whitelisted in MongoDB Atlas
   - Ensure the connection string format is correct

2. **Firebase Authentication Errors**
   - Verify your `FB_SERVICE_KEY` is correctly base64 encoded
   - Ensure the service account has proper permissions

3. **Port Already in Use**
   - Change the `PORT` in your `.env` file
   - Or kill the process using that port

4. **Module Not Found Errors**
   - Run `npm install` again
   - Delete `node_modules` and `package-lock.json`, then run `npm install`

## Notes

- The `.env` file is gitignored and should not be committed
- Make sure you have the Firebase Admin SDK JSON file (`zap-shift-firebase-adminsdk.json`) if you're using it directly (though the code uses base64 encoded version). *(Legacy external Firebase service-account artifact filename, retained as-is — it is generated outside this repo and renaming it would break credential coupling. The product/domain naming is Sarabo.)*
- For production, use environment variables provided by your hosting platform (Vercel, etc.)

