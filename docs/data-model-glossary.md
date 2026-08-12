# Sarabo Data Model — Domain ↔ Storage Name Mapping

Sarabo began life as **"zap_shift"**, a parcel-delivery app, and was later repurposed
into a device-repair platform. *(Historical origin only — the product, code, config, API,
and client are all canonical Sarabo terminology as of Phase 8.7C; see "Migration status".)*

As of **Phase 8.7C (complete)**, the **Mongo collection names**, the **JS
collection-handle keys** in `config/database.js`, the **persisted document field names**,
the **server modules/files**, the **API routes**, the **client code/UI**, and the **QA
seed** all use canonical Sarabo terminology. The only remaining legacy vocabulary is a
small set of explicitly frozen contract values (see "Frozen contract debt" below).

> **Databases** (`config/databaseName.js`):
> - Development → **`sarabo-db`** (the fallback default; set `MONGO_DB_NAME` to override).
> - Automated tests → **`sarabo-test-db`** (the suite refuses to run against `sarabo-db`
>   or any production database).
> - Production → its own name, never `sarabo-db`.
>
> The collection handles live in `config/database.js`.

---

## Collections

| Domain term (product/UI) | Mongo collection (canonical) | JS handle (`config/database.js`) | Notes |
| --- | --- | --- | --- |
| Users / accounts | `users` | `collections.users` | Holds the authoritative `role` (`user` \| `rider` \| `admin` — see frozen role value below). |
| **Technicians** | **`technicians`** | `collections.technicians` | Technician application + profile (expertise, service area, `workStatus`). |
| **Repair requests** | **`repair_requests`** | `collections.repairRequests` | One repair request per document; carries the whole lifecycle. |
| Service catalog (taxonomy + pricing) | `service_definitions` | `collections.serviceDefinitions` | Product/repair categories, pricing rules, `requiredExpertiseLevel`. |
| Notifications | `notifications` | `collections.notifications` | In-app notifications; no public creation route. |
| **Tracking timeline events** | **`tracking_events`** | `collections.trackingEvents` | Public, sanitized status timeline (joined by `trackingId`). |
| Payments | `payments` | `collections.payments` | Stripe payment records; a **separate** collection. |
| Stripe checkout sessions | `checkout_sessions` | `collections.checkoutSessions` | Session idempotency / expiry tracking. |
| Damage-image upload sessions | `damage_upload_sessions` | `collections.damageUploadSessions` | Customer damage-image upload sessions. |
| Completion-evidence upload sessions | `repair_evidence_sessions` | `collections.repairEvidenceSessions` | Technician repair-evidence upload sessions. |
| Deletion cleanup jobs | `deletion_cleanups` | `collections.deletionCleanups` | Async storage-cleanup retry records for deleted requests. |

Canonical collections inside `sarabo-db` (development) / `sarabo-test-db` (tests):

```
sarabo-db
├── users
├── technicians               # JS handle: collections.technicians
├── repair_requests           # JS handle: collections.repairRequests
├── service_definitions       # taxonomy + pricing catalog
├── notifications
├── tracking_events           # JS handle: collections.trackingEvents
├── payments                  # separate; Stripe payment records
├── checkout_sessions         # Stripe session idempotency/expiry
├── damage_upload_sessions    # damage-image upload sessions
├── repair_evidence_sessions  # completion-evidence upload sessions
└── deletion_cleanups         # async storage-cleanup retries
```

---

## Field names

### On a `repair_requests` document (a repair request)

| Domain meaning | Storage field |
| -------------- | ------------- |
| Customer email | `senderEmail` |
| Customer name | `senderName` |
| Device / request title (legacy V1 requests only) | `deviceName` |
| Lifecycle status | `deliveryStatus` *(frozen field name — see below)* |
| Assigned technician id / email / name | `technicianId` / `technicianEmail` / `technicianName` |
| Embedded repair-request reference (checkout/damage/evidence/deletion linkage) | `requestId` |
| Agreed/quoted price | `cost` (and `quote.totalAmount` for the approved quote) |
| Public tracking id | `trackingId` |
| V2 (repair-platform) request marker | `schemaVersion: 2` |

Repair-lifecycle sub-documents on a repair request: `damage`, `inspection`, `quote`,
`repair`, `payment`, and `assignmentHistory` (append-only technician-assignment audit).
Sub-document submitter identity is canonical: `submittedByTechnicianId` (inspection/quote),
`completedByTechnicianId` / `createdByTechnicianId` (repair / evidence sessions).

> Modern (V2) requests carry structured `product` / `service` taxonomy and have **no**
> `deviceName`. `deviceName` (formerly `parcelName`) survives only on legacy V1 requests;
> the current client never writes it. Other inherited V1-only fields (`receiverRegion`,
> `license`, `bike`) are legacy debt the V2 flow never reads.

### On a `technicians` document (a technician)

| Domain meaning | Storage field / value |
| -------------- | --------------------- |
| Application state | `status`: `pending` \| `approved` \| `rejected` |
| Operational availability | `workStatus`: `available` \| `in_delivery` |
| **"On a repair" (busy)** | `workStatus: 'in_delivery'` — the value predates the repair rename; shown to admins as "On a repair". |
| Expertise (canonical) | `expertise: [{ productCategorySlug, repairCategorySlugs, level, experienceYears }]` |
| Service area | `region`, `district` |

---

## `deliveryStatus` lifecycle values (on `repair_requests`)

The stored status strings are a **frozen** mix of legacy delivery names and newer repair
names (a state-machine contract change deferred to its own dedicated phase). Client labels
present them in canonical Sarabo terms; only the raw stored values remain legacy.

| Storage value (frozen) | Domain meaning / client label |
| ------------- | -------------- |
| `pending-pickup` | Newly created; awaiting technician assignment |
| `assignment_pending` | Offered to a technician; awaiting their accept/reject |
| `assignment_rejected` | *(internal tracking event only — never a public status)* |
| `driver_assigned` | Technician accepted; "Technician Assigned" |
| `rider_arriving` | "Technician On The Way" |
| `parcel_picked_up` | "Device Collected" |
| `inspection_completed` | Inspection submitted |
| `quote_submitted` / `quote_approved` / `quote_rejected` | Quote workflow |
| `payment_completed` | Customer paid |
| `repair_in_progress` | Repair underway |
| `repair_completed` | Repair finished |
| `parcel_delivered` | "Repair Completed" (terminal) |
| `cancelled` | Request cancelled |

---

## API routes (canonical, Phase 8.7C)

| Family | Route |
| --- | --- |
| Technicians | `/technicians` (+ `/technicians/:id`, `/technicians/:id/expertise`, `/technicians/delivery-per-day`) |
| Repair requests | `/repair-requests` (+ `/repair-requests/:id` and nested workflow: `/assignment`, `/assignment/accept`, `/assignment/reject`, `/eligible-technicians`, `/inspection`, `/quote`, `/quote/decision`, `/payment-eligibility`, `/checkout-session`, `/repair/*`, `/damage-images/*`, `/cancel`, `/status`) |
| Admin repair requests | `/admin/repair-requests` |
| Technician's own assigned jobs | `/repair-requests/technician` |
| Public tracking | `/public/trackings/:trackingCode` |

The inherited `/riders`, `/parcels`, `/admin/parcels` families are **unmounted** (404) —
no aliases, no dual-route support.

---

## Migration status

- **Phase 8.7B (done):** database names (`sarabo-db` / `sarabo-test-db`, test isolation +
  fail-fast guards), the Zap Shift branding removal from product config, and the **Mongo
  collection names** migrated to canonical snake_case.
- **Phase 8.7C (done):** the **JS collection-handle keys** (`collections.technicians` /
  `collections.repairRequests` / `collections.trackingEvents`), the persisted **identity
  document field names** (`technicianId` / `technicianEmail` / `technicianName` /
  `requestId`, and `deviceName` ← `parcelName`), the server **modules/files**, the **API
  routes** (`/technicians`, `/repair-requests`, `/admin/repair-requests`), the **client**
  code/UI terminology, and the **QA seed** (`scripts/seed-qa-repair-requests.js`,
  `npm run seed:qa-repair-requests`) are all canonical.

### Frozen contract debt (intentionally retained)

These retain legacy vocabulary because changing them is a separate contract migration,
not a naming cleanup:

- **Raw persisted role value `'rider'`** (`users.role`) — the authorization contract value.
  The UI/domain label is always "Technician"; only the stored value stays `'rider'`.
- **`deliveryStatus` / `workStatus` field names** and their **status enum values**
  (`driver_assigned`, `rider_arriving`, `parcel_picked_up`, `parcel_delivered`,
  `assignment_pending`, `assignment_rejected`, `in_delivery`) — a state-machine contract
  change deferred to its own dedicated phase. Client labels are canonical (see above).
- **Legacy V1-only document fields** (`receiverRegion`, `license`, `bike`) — never read by
  the V2 flow; retained for read-compat with any legacy record.
- **External Firebase service-account artifact filename** (`zap-shift-firebase-adminsdk.json`,
  referenced in `SETUP.md`) — an external artifact whose name is outside repo control; the
  product/domain naming is Sarabo.
