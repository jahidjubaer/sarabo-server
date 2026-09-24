# Production Data Preparation (legacy schema → Sarabo schema)

No secret values appear in this document. Every credential is referenced by
variable name only. Nothing here runs automatically: Vercel deployments never
seed or migrate.

## Why this exists

The server on `development` reads only the canonical Sarabo names
(`docs/data-model-glossary.md`). A database last written by the pre-rename
server (`origin/main` `73d6604` and earlier) still holds its data under the old
names, which the new server would treat as empty. The new server also needs the
service catalogue (`service_definitions`) to exist before any customer can create
a repair request - and the pre-rename server never had one.

## Complete old → new mapping

| Where | Old (pre-rename server) | New (current server) | How it is migrated |
|---|---|---|---|
| collection | `parcels` | `repair_requests` | copied, same `_id` |
| collection | `riders` | `technicians` | copied, same `_id`, no field changes |
| collection | `trackings` | `tracking_events` | copied, same `_id` |
| collection | `checkoutSessions` | `checkout_sessions` | copied, same `_id` |
| collection | `serviceDefinitions` | `service_definitions` | copied if present (normally absent) |
| `repair_requests` field | `riderId` | `technicianId` | renamed on the copy (string value kept) |
| `repair_requests` field | `riderEmail` | `technicianEmail` | renamed on the copy |
| `repair_requests` field | `riderName` | `technicianName` | renamed on the copy |
| `repair_requests` field | `parcelName` | `deviceName` | renamed on the copy (legacy V1 device title) |
| `checkout_sessions` field | `parcelId` | `requestId` | renamed on the copy |
| `payments` field | `parcelId` | `requestId` | **added in place**; `parcelId` kept |
| `tracking_events.status` value | `parcel_created` | `repair_request_created` | rewritten on the copy (+ derived `details`) |
| `tracking_events.status` value | `parcel_paid` | `repair_request_paid` | rewritten on the copy (+ derived `details`) |

Checked and deliberately **not** changed:

- `users` - same collection and fields; the stored role value stays `'rider'` (frozen contract).
- `notifications` - same collection; types, action URLs, `entityId` and the `trackingId`
  metadata are all still valid. Legacy `entityType` values `parcel`/`rider` are never read by
  the server or client; the migration reports how many exist and leaves them.
- `deliveryStatus` / `workStatus` values (`driver_assigned`, `rider_arriving`,
  `parcel_picked_up`, `parcel_delivered`, `in_delivery`, ...) - frozen values the current
  server still uses. `in_delivery` still means "on a repair".
- `payments.sessionId` unique index - unchanged.
- API routes `/parcels`, `/riders`, `/payment-checkout-session` are gone with no aliases:
  the currently live frontend stops working the moment the new backend deploys, until the
  new frontend is deployed (see the release checklist - keep that window short).

## The three scripts and their production guards

Every script is a **dry run by default** and prints counts only (never emails, names,
amounts, or `MONGO_URI`). Production - a production environment, or any database whose
name contains `production` - is refused unless **both** that script's own override is set
to exactly `true` **and** `--expect-db` names the resolved database exactly. There is no
global safety switch.

| Script | Writes with | Production override |
|---|---|---|
| `scripts/migrate-legacy-schema.js` | `--confirm` | `ALLOW_PROD_SCHEMA_MIGRATION=true` (and `--expect-db` is required even outside production) |
| `scripts/seed-service-definitions.js` | `--confirm-seed` | `ALLOW_PROD_SERVICE_SEED=true` |
| `scripts/migrate-service-definitions-to-bdt.js` | `--confirm` | `ALLOW_PROD_BDT_MIGRATION=true` |

`--dry-run` always wins over the write flag.

**Legacy schema migration.** Copy-and-rename: source collections are never modified or
dropped (they stay as the rollback copy for this release). Validates everything first and
writes nothing on any blocking issue: an existing target document with the same `_id` that
differs, a document holding an old and a new field name with different values, duplicate
`trackingId`, a missing/invalid/dangling technician reference or technician email mismatch,
more than one active checkout per request, more than one paid payment per request,
duplicate payment `sessionId`, duplicate service-definition key, an incompatible existing
index. Orphans left by the old admin delete (tracking events, payments, checkout sessions,
notifications pointing at a deleted request) are **warnings** and are kept as-is. All
document writes happen in **one transaction** - all or nothing. The two unique indexes the
server needs on the targets are created just before it. A rerun writes nothing.

**Service seed.** Inserts only missing standard rows. An existing row that differs is a
reported conflict and is **never** overwritten, so a production customisation survives.

**BDT migration.** Upgrades a row only when it is field-for-field the untouched original
USD standard row (`data/serviceDefinitionSeedLegacyUsd.js`). Any other difference is a
customisation: the whole run aborts with nothing written. A missing or duplicated standard
row also aborts with nothing written.

## How to run against production (later, with approval)

Run from `sarabo-server` on the operator's machine. `MONGO_URI` comes from the local `.env`
(the production database lives on the same Atlas cluster as development - confirm the
Atlas user in that URI can read `sarabo_production` first). Never paste the URI into a
command line or a document.

Every command below runs with these two values exported; `sarabo_production` is the name the
runbook specifies - confirm it against `MONGO_DB_NAME` in Vercel (dashboard, or
`vercel env ls production` for names) before starting.

```bash
export NODE_ENV=production
export MONGO_DB_NAME=sarabo_production
```

Clear both again when finished (step 9) so no later command in that shell can
reach production by accident.

### 0. Before anything

- Atlas → Cluster → Backup: confirm a snapshot from the last 24 hours exists.
- `git status` clean on `development`; `npm run test:migrations` passes.

### 1. Read-only production inspection

Atlas Data Explorer or `mongosh` with a read-only user:

```js
use sarabo_production
db.getCollectionNames()
;["parcels","riders","trackings","checkoutSessions","serviceDefinitions",
  "repair_requests","technicians","tracking_events","checkout_sessions","service_definitions",
  "users","payments","notifications"].forEach(c => print(c, db.getCollection(c).countDocuments()))
db.users.aggregate([{ $group: { _id: "$role", n: { $sum: 1 } } }])
```

Steps 2, 4 and 6 are read-only as well and are the precise inspection: all three
dry runs connect without building the server's indexes and never write.

### 2. Data migration - dry run (read-only)

```bash
ALLOW_PROD_SCHEMA_MIGRATION=true node scripts/migrate-legacy-schema.js --expect-db=sarabo_production
```

Expect: per-collection counts, `Documents to write: N`, no `BLOCKING` section. Any
blocking line → stop and review; nothing has been written.

### 3. Data migration - confirmed

```bash
ALLOW_PROD_SCHEMA_MIGRATION=true node scripts/migrate-legacy-schema.js --expect-db=sarabo_production --confirm
```

Expect: `Written: N document(s) copied, M payment(s) linked.`, then every verification line
`OK`.
Exit code non-zero on any failure. Source collections are untouched.

### 4. Service catalogue seed - dry run (read-only)

```bash
ALLOW_PROD_SERVICE_SEED=true node scripts/seed-service-definitions.js --expect-db=sarabo_production
```

### 5. Service catalogue seed - confirmed (only if step 4 shows `WOULD CREATE` rows)

```bash
ALLOW_PROD_SERVICE_SEED=true node scripts/seed-service-definitions.js --expect-db=sarabo_production --confirm-seed
```

### 6. BDT migration - dry run (read-only)

```bash
ALLOW_PROD_BDT_MIGRATION=true node scripts/migrate-service-definitions-to-bdt.js --expect-db=sarabo_production
```

### 7. BDT migration - confirmed (only if step 6 shows `WOULD MODIFY` and is OK)

```bash
ALLOW_PROD_BDT_MIGRATION=true node scripts/migrate-service-definitions-to-bdt.js --expect-db=sarabo_production --confirm
```

### Seed vs BDT vs nothing

Decide from the dry runs (steps 4 and 6), after step 3:

| `service_definitions` state | Seed dry run says | BDT dry run says | Action |
|---|---|---|---|
| empty (expected for production) | 16 `WOULD CREATE` | NOT OK, 16 `MISSING` (needs the seed) | run step 5 only |
| 16 standard BDT rows | 16 `IDENTICAL` | 16 `UNCHANGED` | nothing |
| 16 original USD rows | 16 `CONFLICT` | OK, 16 `WOULD MODIFY` | run step 7 only |
| any `CUSTOM`, `DUPLICATE`, or partial set | conflicts | NOT OK | stop - manual review |

### 8. Post-migration verification

Rerun the three dry runs - each must now report nothing to do:

```bash
ALLOW_PROD_SCHEMA_MIGRATION=true node scripts/migrate-legacy-schema.js --expect-db=sarabo_production
#   -> "Dry run: nothing to migrate - every document is already in place."
ALLOW_PROD_SERVICE_SEED=true node scripts/seed-service-definitions.js --expect-db=sarabo_production
#   -> "Created:             0 (would create)" and "Skipped (identical): 16"
ALLOW_PROD_BDT_MIGRATION=true node scripts/migrate-service-definitions-to-bdt.js --expect-db=sarabo_production
#   -> "Unchanged:           16" and "Dry run only - no documents were written."
```

Then repeat the step 1 counts: every old collection still has its original count, and each
new collection has at least that many documents.

### 9. Finish

```bash
unset NODE_ENV MONGO_DB_NAME
```

Only then merge `development` into `main` and push (Vercel deploys), and deploy the client
afterwards (backend first - see the release checklist).

## Rollback

- The migration never modifies or deletes source collections; the old server
  (`origin/main`) keeps working against them unchanged.
- Rolling the backend back (Vercel "Promote" to the previous deployment) needs no data
  change.
- The new-name collections created by the migration can be removed only by an explicit,
  owner-approved manual step, by exact collection name - no script does it. Keep the old
  collections for at least this release; removing them is a later, separate change.
