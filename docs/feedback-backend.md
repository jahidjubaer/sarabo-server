# Customer reviews and private technician reports — backend V1

These are separate resources. Neither changes repair, payment, assignment,
account, approval, refund, withdrawal, or settlement state. No client UI or
public review endpoint is included.

## Authorization and endpoints

All routes authenticate through the existing Firebase middleware and wait for
the existing database initialization. Controllers independently resolve the
stored account role. Customer ownership continues to use `senderEmail`.
Non-owned repairs return the existing generic `REQUEST_NOT_FOUND` response.

| Method | Route | Access / accepted mutation fields |
| --- | --- | --- |
| GET | `/repair-requests/:id/feedback` | Customer repair owner |
| POST | `/repair-requests/:id/review` | Verified Customer owner; `rating`, `comment?` |
| POST | `/repair-requests/:id/technician-reports` | Customer owner; `reason`, `description`, `assignmentId?`; email verification not required |
| GET | `/technicians/me/reviews` | Stored Technician role (`rider`) |
| GET | `/admin/technician-reviews` | Admin |
| PATCH | `/admin/technician-reviews/:id/visibility` | Admin; `visibility`, `reason`, `expectedVersion` |
| GET | `/admin/technician-reports` | Admin |
| GET | `/admin/technician-reports/:id` | Admin |
| PATCH | `/admin/technician-reports/:id/status` | Admin; `status`, `expectedVersion`, `explanation?` |
| POST | `/admin/technician-reports/:id/notes` | Admin; `text`, `expectedVersion` |

Unexpected mutation fields and query filters are rejected. Reviews have no
customer edit/delete route. Pagination is `page` (default 1) and `limit`
(default 20, maximum 50), ordered by `createdAt DESC, _id DESC`. Admin lists
accept an exact `technicianId`, plus `visibility` for reviews or `status` for
reports. There is no complaint-content search.

## Models and eligibility

`technician_reviews`: ObjectId `_id`; string ObjectId references
`repairRequestId`, `customerId`, `technicianId`; `rating`, nullable `comment`,
`visibility`, append-only `moderationHistory`, integer `version`, Date
`createdAt` and `updatedAt`.

A review requires the current repair schema (2), `repair.status=completed`
with a valid completion timestamp, `deliveryStatus=parcel_delivered`, and
confirmed receipt with timestamp and `confirmedBy` matching the owner. The
last assignment-history entry must be accepted with its decision timestamp;
its technician ID/email must match the repair's current assignment and the
stored Technician record. An earlier accepted assignment is never substituted.
Legacy delivery status alone is insufficient. The server derives all references.

Rating is an integer 1–5. Optional comment is trimmed, blank becomes null,
and nonblank text is at most 1,000 characters. Text inputs reject markup and
unsafe control characters; future clients must render them as text, not HTML.
`verifiedRepair` is a response-only derivation from guarded creation, not a
client-controlled/stored claim.

`technician_reports`: ObjectId `_id`; string ObjectId references
`repairRequestId`, `customerId`, `technicianId`, nullable `assignmentId`;
`reason`, `description`, `status`, append-only `adminNotes` and `statusHistory`,
integer `version`, Date `createdAt`, `updatedAt`, nullable `closedAt` and
`closedBy` (Admin ID).

Report reasons: `unprofessional_behavior`, `suspected_fraud`, `device_damage`,
`missing_item`, `harassment`, `safety_concern`, `payment_issue`, `repair_dispute`,
`other`. Description is trimmed plain text, 20–2,000 characters. No attachments.

Reports do not depend on repair/payment/receipt success. Server-recorded pending,
accepted, and rejected assignments are verifiable report targets, including
historical assignments after reassignment. Each requires valid assignment and
Technician IDs, assignment time, and a matching stored Technician email. An
optional assignment ID can select a historical target only within this repair.
Without it, the server selects the current matching assignment. Where history
is absent/empty, only a matching stored current Technician ID/email qualifies;
malformed history fails closed. The summary exposes target assignment references
and display names, not raw history or contact information.

## Moderation and projections

Review visibility defaults to `visible`. Admin hide/restore requires a nonblank
plain-text reason (maximum 1,000) and integer `expectedVersion >= 1`. Atomic
compare-and-update increments version and appends visibility, reason, Admin ID,
and time. Rating/comment cannot be edited. Visible-only Mongo aggregation
returns `averageRating` and `reviewCount`; no reviews means null/0, not 0.0.
No rating counters are written to accounts or Technician records.

Reports start `open`. Allowed transitions are `open -> under_review|dismissed`
and `under_review -> resolved|dismissed`. Terminal states cannot reopen.
`resolved` means handling finished, not guilt or compensation. Terminal changes
require a private explanation. Every change appends from/to/Admin/time; optional
nonterminal explanations and required terminal explanations append private notes.
Standalone notes are trimmed plain text, 1–1,000 characters, append-only and
version-checked. Existing entries are never rewritten or pruned. Conflicts
return 409 without overwriting. No note-count limit prevents a required closing
explanation.

Explicit response projections:

- Owner feedback: review eligibility/code, own review, eligible report targets,
  own report summaries. No internal moderation history or private notes.
- Customer report: ID, reason, status, created/updated/closed times only.
- Technician review: review ID, rating/comment/time, `Verified customer` label
  and derived verified-repair meaning. No customer ID/contact, repair ID, or
  tracking code. Hidden reviews and all reports are inaccessible here.
- Admin review: explicit content/references/version/visibility and moderation
  history. Admin report: explicit references/content/version, notes and history.
  Neither endpoint returns raw Mongo documents.

## Uniqueness, indexes, and deletion safety

Central initialization creates exactly these seven application indexes:

- Reviews: unique `{repairRequestId:1}`;
  `{technicianId:1,visibility:1,createdAt:-1,_id:-1}`;
  `{visibility:1,createdAt:-1,_id:-1}`.
- Reports: unique `{repairRequestId:1,technicianId:1}`;
  `{status:1,createdAt:-1,_id:-1}`;
  `{technicianId:1,status:1,createdAt:-1,_id:-1}`;
  `{createdAt:-1,_id:-1}`.

Creation uses existing Mongo sessions/transactions. It rechecks role, ownership
and assignment, increments the repair's internal `feedbackRevision`, then inserts
the resource in the same transaction. Duplicate-key errors are translated to
stable 409 responses **outside** the transaction callback (never swallowed inside
an aborted transaction). Failed inserts roll back the retention write too.

Normal hard deletion rejects historical assignments, positive feedback revision,
or an associated report. Its atomic repair-delete predicate also rejects history
and feedback revision. A report check inside the deletion transaction protects
older/report-bearing documents even without a marker. Both paths write the same
repair document: a competing deletion forces creation to retry and recheck
existence; creation winning leaves the deletion guard unsatisfied. Reports are
never cascade-deleted, including resolved/dismissed reports. Internal revision
is removed from general repair projections. No legal retention duration or
exceptional privacy-removal process is invented.

## Notifications and logging

After a report commits, existing infrastructure sends a generic
`technician_report_submitted` notification to each stored Admin recipient,
deduplicated by report ID and recipient. It includes no description, reporter
contact, or sensitive metadata. Its entity reference is the report ID; navigation
uses existing `/dashboard` until a later authorized client phase adds moderation
UI. Failure is nonfatal: the Admin report queue remains authoritative.
No Technician review/report notifications or external messaging are added.

Failures use existing `safeLogger` fields only: request ID, method, route template,
status, broad category. No raw body, error text, comment, complaint, or note logs.

## Tests and future client integration

`npm run test:feedback` runs the focused module; `npm test` includes it. Use
`NODE_ENV=test` and an explicitly isolated `MONGO_DB_NAME`. The focused module
cleans only its own fixtures; external integrations are not invoked. The full
suite's existing HTTP checks require a local API using the same test database.
Never point tests at `sarabo-db` or production.

Future private cache namespaces (recommendations only):
`repair-feedback`, `technician-reviews`, `admin-technician-reviews`,
`admin-technician-reports`. Include account identity, repair ID or page/filter
arguments where relevant. All must join the existing account-change/private-cache
cleanup. Creation invalidates the owner's repair feedback; moderation invalidates
appropriate Admin lists/detail and visible Technician list/aggregate. Do not cache
Admin notes in Customer or Technician query namespaces. No client files are
changed in this backend phase.
