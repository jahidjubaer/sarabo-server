# Sarabo Production Runbook

No secret values appear in this document. Everywhere a credential is
referenced, only its variable name is given.

## Production URLs

- Client: `https://sarabo-jahid.web.app`
- Server: `https://sarabo-server.vercel.app`

## Deployed commit hashes (as of Phase 5.9)

- Client (`sarabo-client`, `main`): `a27caaf7d21357f2ed6e60af4de2c06575c69ee2`
- Server (`sarabo-server`, `main`): `00eb39ec58dd0efb5b64deb8d10743d791baa34e`

## Required environment variables (Vercel, Production scope only)

| Variable | Purpose |
|---|---|
| `MONGO_URI` | MongoDB Atlas connection string |
| `MONGO_DB_NAME` | Must be `sarabo_production` in production - required, must not be empty, must not equal the dev database name |
| `FB_SERVICE_KEY` | Base64-encoded Firebase Admin service account JSON |
| `STRIPE_SECRET` | Stripe secret key (currently test-mode, `sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the active Stripe webhook endpoint |
| `SITE_DOMAIN` | Must be the exact production client origin, `https://sarabo-jahid.web.app`, https only, no path/query/fragment |

Verify presence and Production-only scope with `vercel env ls production` /
`vercel env ls preview` / `vercel env ls development` - these list names and
scopes only, never values.

## Release data preparation (pre-rename → Sarabo schema)

Before the first deploy of the renamed server, production data must be copied
into the canonical collections and the service catalogue seeded. Exact,
dry-run-first commands, the full old → new mapping and the seed/BDT decision
table are in `docs/production-data-migration.md`.

The three operator-only overrides - `ALLOW_PROD_SCHEMA_MIGRATION`,
`ALLOW_PROD_SERVICE_SEED`, `ALLOW_PROD_BDT_MIGRATION` - are set on the
command line of a single script run, together with `--expect-db=<name>`.
**Never add them to Vercel**: the server never reads them, and a standing
value would only weaken the next accidental script run.

## AI support limits

The AI support chat is rate limited per visitor, per signed-in user, per IP
and site-wide. The counters live in MongoDB (`support_rate_limits`, expired
by a TTL index on `expiresAt`), so every Vercel instance shares them.

- `AI_SUPPORT_GLOBAL_DAILY_LIMIT` (default `300`) - AI questions answered
  per UTC day across the whole site. Once reached, chat returns
  `429 SUPPORT_DAILY_CAPACITY_REACHED` until the next day.
- The per-visitor limits (`AI_SUPPORT_ANON_*`, `AI_SUPPORT_AUTH_*`) are
  listed in `.env.example`.
- If the database cannot be reached, chat is refused with
  `503 SUPPORT_UNAVAILABLE` (fail closed) - the provider is never called
  without a counted limit.
- These limits cap requests, not money. Set a budget alert and a spending
  cap on the Gemini API key's Google Cloud project as the final backstop.

## Service catalogue

Admins edit services and prices at **Dashboard → Services & prices**. A price
change raises `pricingRule.version`; existing requests keep their price
snapshot. Switching a service off with requests waiting for a technician
needs a confirmation - those requests cannot be assigned until it is back on.
There is no delete.

After an admin edits a standard service, `seed:service-definitions` reports
that row as a conflict and never overwrites it, and the BDT migration refuses
to run; both are expected.

## Pickup scheduling

Customers choose a 2-hour pickup window when they create a request:
10:00-12:00, 12:00-14:00, 14:00-16:00 or 16:00-18:00 Bangladesh time,
Saturday to Thursday (closed Friday), up to 7 days ahead and at least 1 hour
from now. They can change it until the device is picked up.

- `PICKUP_SLOT_CAPACITY` (default `3`) - pickups per region per slot. A full
  slot returns `409 PICKUP_SLOT_FULL`.
- The count is checked before saving, not locked, so two customers booking
  the last place in the same second can both get it. Admins can see every
  request's pickup time on Assign technicians.
- Requests created before this release have no pickup time and show
  "Not scheduled"; the customer can choose one from the request page.

## Email updates

Free, sent through a Gmail account (about 500 emails a day). Three emails:
request received (and again when the pickup time changes), a pickup reminder
the evening before, and a new job offer to the technician. Email never blocks
or fails a request - a failed send is logged and recorded in `email_log`
(records delete themselves after 90 days).

Turning it on (Vercel, Production):
1. On the Gmail account: Google Account -> Security -> turn on 2-Step
   Verification -> App passwords -> create one for "Sarabo".
2. Set `EMAIL_ENABLED=true`, `GMAIL_USER=<the gmail address>`,
   `GMAIL_APP_PASSWORD=<the 16-letter app password>`; optionally
   `EMAIL_FROM_NAME` (default `Sarabo`). `SITE_DOMAIN` gives the links.
3. Set `CRON_SECRET` to a long random string. Vercel Cron then calls
   `GET /cron/pickup-reminders` daily at 12:00 UTC (18:00 in Dhaka, see
   `vercel.json`) with it; without `CRON_SECRET` the job refuses to run.

**Pickup reminders do not need email.** The same daily job always posts an
in-app notification to the customer ("Your pickup is tomorrow") and to the
assigned technician ("Pickup tomorrow"); the email is sent in addition when
email is on. Only `CRON_SECRET` is required for the in-app reminders. Each
pickup slot is reminded once - re-running the job sends nothing new, and a
moved pickup is reminded again.

Check it: `email_log` shows each email with status `sent` or `failed` and a
short reason (e.g. `EAUTH` = wrong app password). Tests never send email.

## Technician matching

A technician can only be assigned to a request in **their own region**
(`OUTSIDE_SERVICE_REGION`). Same district ranks highest; a different district
in the same region is still allowed. Assign technicians lists everyone else
as "Not available" with the reason.

## Database

- Production database: `sarabo_production` (same Atlas cluster as development)
- Development database: `sarabo-db` (tests use the isolated `sarabo-test-db`)
- Isolation is enforced in code by `config/databaseName.js`'s
  `resolveDatabaseName()`: production must supply an explicit
  `MONGO_DB_NAME` that is not the dev database name.

## Health checks

- **Liveness**: `GET /` - always `200`, no database dependency. If this
  fails, the function itself isn't running (check Vercel deployment status,
  not the database).
- **Readiness**: `GET /health` - `200` with `{"status":"ok","database":"connected",...}`
  when the database is reachable; `503` with `{"status":"unavailable","database":"error",...}`
  otherwise. Never exposes the connection string, hostname, or credentials.

## URL privacy (current-user endpoints)

- **Current-user role**: `GET /users/me/role` - identity is derived entirely
  from the verified Firebase token (`Authorization: Bearer <idToken>`),
  never from the URL. The old `GET /users/:email/role` route (Phase 5.10)
  put a real email address in the request path, which Vercel's platform
  logging records before any application-level log sanitization runs - that
  route has been removed, not deprecated, since it had no external consumer.
- Any future "current user's own X" endpoint should follow the same
  pattern: read identity from the verified token, not a URL/query/body
  parameter, so a real email/UID never appears in a request path.
- **Account-switch cache safety**: the client's role query cache
  (`src/hooks/roleKeys.js`) is explicitly cleared on logout/account change
  in `AuthProvider.jsx`, the same pattern already used for the notification
  cache - this prevents a previously-signed-in account's role from ever
  being shown to a different account signing in afterward.
- **Post-deployment verification**: after this change ships, confirm via
  `vercel logs` that new entries show `GET /users/me/role` and that no new
  `GET /users/<email>/role` entries appear. Do not consider this fix
  verified until that's confirmed against live traffic, not just local
  tests.
- Admin cross-user lookups continue to use `GET /users` (search/list) and
  `GET /users/:id` (MongoDB document ID) - neither ever placed an email in
  a URL, so neither needed to change.

## Common failure symptoms

| Symptom | Likely cause | Where to look |
|---|---|---|
| Every request `500 FUNCTION_INVOCATION_FAILED` | Missing/invalid `MONGO_DB_NAME`, malformed `SITE_DOMAIN`, or malformed `FB_SERVICE_KEY` - all three throw synchronously at module load | Vercel function logs (`vercel logs <url>`) for the exact startup error message (never a secret value) |
| `GET /health` returns `503`, `GET /` returns `200` | Database reachable at process start but the cluster/network is now unavailable | `vercel logs`; MongoDB Atlas cluster status |
| `403 Origin not allowed` from the real client | `SITE_DOMAIN` misconfigured, or the client is calling from an unexpected origin | Confirm `SITE_DOMAIN` matches the client's actual origin exactly |
| AI chat returns `503 SUPPORT_UNAVAILABLE` | The limiter could not reach MongoDB (the chat fails closed) | `GET /health`; Atlas status |
| AI chat returns `429 SUPPORT_DAILY_CAPACITY_REACHED` | The site-wide daily cap was reached | Raise `AI_SUPPORT_GLOBAL_DAILY_LIMIT` only if the Gemini budget allows |
| Stripe webhook returns `500 webhook not configured` | `STRIPE_WEBHOOK_SECRET` missing | Vercel env vars |
| Stripe webhook returns `400 invalid signature` repeatedly | `STRIPE_WEBHOOK_SECRET` doesn't match the active endpoint in the Stripe dashboard (commonly after a secret rotation) | Stripe Dashboard -> Webhooks -> endpoint -> signing secret |

## Vercel rollback procedure

1. `vercel ls` (from `sarabo-server`) to list recent deployments and confirm
   a prior known-good one is still `Ready`.
2. `vercel promote <deployment-url>` (or use the Vercel dashboard's
   "Promote to Production" action on the prior deployment) to roll back
   without a new build.
3. Confirm with `GET /` and `GET /health` against the production URL.
4. This does not require a git revert - the prior deployment's build
   artifact is reused as-is.

## Firebase Hosting rollback procedure

1. `firebase hosting:channel:list` / Firebase Console -> Hosting -> release
   history for `sarabo-jahid`.
2. Use the Console's "Rollback" action on the prior release, or
   `firebase hosting:clone <source-site>:<source-version> <target-site>:live`.
3. Confirm the client loads and successfully calls the server's `GET /`.

## Stripe webhook verification steps

1. Stripe Dashboard -> Developers -> Webhooks -> confirm the production
   endpoint URL is `https://sarabo-server.vercel.app/stripe-webhook` and its
   status is enabled.
2. Confirm the endpoint's current signing secret matches
   `STRIPE_WEBHOOK_SECRET` in Vercel (compare only that both were rotated
   together - never paste the value itself anywhere).
3. Use Stripe's "Send test webhook" for `checkout.session.completed` and
   confirm a `200 {"received":true,...}` response and a corresponding safe
   log line (`Stripe webhook <event id> (checkout.session.completed) -> ...`).

## MongoDB backup verification

1. Atlas -> Cluster -> Backup -> confirm a snapshot exists within the last
   24 hours.
2. Confirm the snapshot covers the cluster hosting both `sarabo_production`
   and `sarabo-db` (same cluster, per this project's cutover design).
3. Do not restore/test-restore into the same cluster without an explicit,
   separate, owner-approved plan - a restore is a destructive, high-blast-
   radius operation.

## Secret-rotation checklist

1. Rotate the credential at its source (Atlas database user, Firebase
   service account, Stripe API key/webhook secret) first.
2. Add the new value to Vercel (Production scope only) - prefer adding
   fresh rather than editing an existing variable in place, since scope
   edits have previously resulted in accidental deletion in this project's
   history.
3. Confirm the new variable is present and Production-only via
   `vercel env ls production` / `preview` / `development` before removing
   the old value anywhere.
4. Trigger a redeploy (or wait for the next natural one) so the new value
   is actually picked up - env var changes alone do not retroactively apply
   to an already-running function instance's environment in all cases.
5. Verify with `GET /health` and a provider-specific check (e.g. a Stripe
   test webhook) before revoking the old credential at its source.
6. Only revoke the old credential once the new one is confirmed working
   end-to-end.

## Incident containment

1. Confirm scope first: is `GET /` down (deployment/runtime issue) or just
   `GET /health` (database-specific)? This determines whether to look at
   Vercel or at Atlas/network first.
2. Never guess-fix production environment variables without first reading
   their current state (`vercel env ls`, names/scopes only).
3. Prefer `vercel promote` to a last-known-good deployment over pushing a
   new fix under time pressure, when a fix isn't already reviewed and
   tested.
4. Any data-safety question (accidental writes, unexpected records) must be
   resolved via exact-ID verification before any deletion - never delete by
   broad email/date/role match.

## Production data cleanup rules

- Any test/smoke fixture created against production must use an explicit,
  unique marker in its identifying field (e.g. `TEST-ISO-PROD`,
  `TEST-BASELINE-PROD`), matching this project's established convention.
- Cleanup must delete by exact `_id` (or another exact unique identifier
  obtained from the fixture's own creation response), never by a broad
  prefix, email, date range, or role match.
- Always verify existence immediately before deletion and absence
  immediately after, and re-verify the retained baseline (currently 3
  users, 1 rider) and cluster-wide counts are unaffected afterward.
- Never delete the four approved baseline records (admin/customer/
  technician users, technician rider record) as a side effect of fixture
  cleanup.
