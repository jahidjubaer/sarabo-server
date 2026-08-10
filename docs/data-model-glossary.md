# Sarabo Data Model — Domain ↔ Storage Name Mapping

Sarabo began life as **"zap_shift"**, a parcel-delivery app, and was later repurposed
into a device-repair platform.

As of **Phase 8.7B**, the **Mongo collection names** are the canonical Sarabo domain
names (snake_case: `technicians`, `repair_requests`, …). Still inherited from Zap Shift,
and **deferred to Phase 8.7C**, are two internal layers: the **JS collection-handle keys**
in `config/database.js` (e.g. `collections.riders` — which now points at the
`technicians` collection) and many **document field names** (`riderId`, `riderEmail`,
`deliveryStatus`, …). This glossary maps all three layers.

> **Databases** (`config/databaseName.js`):
> - Development → **`sarabo-db`** (the fallback default; set `MONGO_DB_NAME` to override).
> - Automated tests → **`sarabo-test-db`** (the suite refuses to run against `sarabo-db`
>   or any production database).
> - Production → its own name, never `sarabo-db`.
>
> The collection handles live in `config/database.js`.

---

## Collections

| Domain term (product/UI) | Mongo collection (canonical) | JS handle (`config/database.js`, legacy — 8.7C) | Notes |
| --- | --- | --- | --- |
| Users / accounts | `users` | `collections.users` | Holds the authoritative `role` (`user` \| `rider` \| `admin`). |
| **Technicians** | **`technicians`** | `collections.riders` | Technician application + profile (expertise, service area, `workStatus`). |
| **Repair requests** | **`repair_requests`** | `collections.parcels` | One repair request per document; carries the whole lifecycle. |
| Service catalog (taxonomy + pricing) | `service_definitions` | `collections.serviceDefinitions` | Product/repair categories, pricing rules, `requiredExpertiseLevel`. |
| Notifications | `notifications` | `collections.notifications` | In-app notifications; no public creation route. |
| **Tracking timeline events** | **`tracking_events`** | `collections.trackings` | Public, sanitized status timeline (joined by `trackingId`). |
| Payments | `payments` | `collections.payments` | Stripe payment records; a **separate** collection. |
| Stripe checkout sessions | `checkout_sessions` | `collections.checkoutSessions` | Session idempotency / expiry tracking. |
| Damage-image upload sessions | `damage_upload_sessions` | `collections.damageUploadSessions` | Customer damage-image upload sessions. |
| Completion-evidence upload sessions | `repair_evidence_sessions` | `collections.repairEvidenceSessions` | Technician repair-evidence upload sessions. |
| Deletion cleanup jobs | `deletion_cleanups` | `collections.deletionCleanups` | Async storage-cleanup retry records for deleted requests. |

Canonical collections inside `sarabo-db` (development) / `sarabo-test-db` (tests):

```
sarabo-db
├── users
├── technicians               # JS handle: collections.riders
├── repair_requests           # JS handle: collections.parcels
├── service_definitions       # taxonomy + pricing catalog
├── notifications
├── tracking_events           # public tracking timeline events
├── payments                  # separate; Stripe payment records
├── checkout_sessions         # Stripe session idempotency/expiry
├── damage_upload_sessions    # damage-image upload sessions
├── repair_evidence_sessions  # completion-evidence upload sessions
└── deletion_cleanups         # async storage-cleanup retries
```

---

## Field names (the confusing ones)

### On a `parcels` document (a repair request)

| Domain meaning | Storage field |
| -------------- | ------------- |
| Customer email | `senderEmail` |
| Customer name | `senderName` |
| Device / request title | `parcelName` |
| Lifecycle status | `deliveryStatus` |
| Assigned technician id / email / name | `riderId` / `riderEmail` / `riderName` |
| Agreed/quoted price | `cost` (and `quote.totalAmount` for the approved quote) |
| Public tracking id | `trackingId` |
| V2 (repair-platform) request marker | `schemaVersion: 2` |

Repair-lifecycle sub-documents on a parcel: `damage`, `inspection`, `quote`, `repair`,
`payment`, and `assignmentHistory` (append-only technician-assignment audit).

### On a `riders` document (a technician)

| Domain meaning | Storage field / value |
| -------------- | --------------------- |
| Application state | `status`: `pending` \| `approved` \| `rejected` |
| Operational availability | `workStatus`: `available` \| `in_delivery` |
| **"On a repair" (busy)** | `workStatus: 'in_delivery'` — the label predates the repair rename; shown to admins as "On a repair". |
| Expertise (canonical) | `expertise: [{ productCategorySlug, repairCategorySlugs, level, experienceYears }]` |
| Service area | `region`, `district` |

---

## `deliveryStatus` lifecycle values (on `parcels`)

The stored status strings are a mix of legacy delivery names and newer repair names:

| Storage value | Domain meaning |
| ------------- | -------------- |
| `pending-pickup` | Newly created; awaiting technician assignment |
| `assignment_pending` | Offered to a technician; awaiting their accept/reject |
| `assignment_rejected` | *(internal tracking event only — never a public status)* |
| `driver_assigned` | Technician accepted; assigned |
| `rider_arriving` | Technician en route |
| `parcel_picked_up` | Device collected |
| `inspection_completed` | Inspection submitted |
| `quote_submitted` / `quote_approved` / `quote_rejected` | Quote workflow |
| `payment_completed` | Customer paid |
| `repair_in_progress` | Repair underway |
| `repair_completed` | Repair finished |
| `parcel_delivered` | Device returned to customer (terminal) |
| `cancelled` | Request cancelled |

---

## Migration status

- **Phase 8.7B (done):** the database names (`sarabo-db` / `sarabo-test-db`, test isolation
  + fail-fast guards), the Zap Shift branding, and the **Mongo collection names** are
  migrated to the canonical Sarabo domain terms. Nothing is created under `riders`/`parcels`
  any more.
- **Phase 8.7C (deferred):** the internal **JS collection-handle keys** (`collections.riders`
  → `collections.technicians`), the persisted **document field names** (`riderId`,
  `riderEmail`, `riderName`, `deliveryStatus`, `parcelName`, …), the `rider`/`parcel`
  code vocabulary, file names (`parcelController.js` → …), API routes (`/riders`,
  `/parcels`), and the client terminology. These touch ~4,500 occurrences and the API
  contract, so they must migrate atomically across server + client + tests + seed in a
  dedicated phase.
- **Frozen:** the persisted workflow **status enum values** (`driver_assigned`,
  `rider_arriving`, `parcel_picked_up`, `parcel_delivered`) are a separate state-machine
  contract change and stay unchanged until their own dedicated phase.

This glossary maps all three layers so the still-legacy handles/fields stay legible.
