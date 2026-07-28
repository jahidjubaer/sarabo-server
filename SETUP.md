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
- Parcel management (`/parcels/*`)
- Rider management (`/riders/*`)
- Payment processing (`/payments/*`)
- Tracking (`/trackings/*`)

Most endpoints require Firebase authentication via the `Authorization` header.
Exceptions: the root health check, the Stripe webhook (`POST /stripe-webhook`,
authenticated by its Stripe signature instead), and the public repair-tracking
endpoint below.

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
- Make sure you have the Firebase Admin SDK JSON file (`zap-shift-firebase-adminsdk.json`) if you're using it directly (though the code uses base64 encoded version)
- For production, use environment variables provided by your hosting platform (Vercel, etc.)

