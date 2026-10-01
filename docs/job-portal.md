# Job portal and inspection fee

How a repair request finds its technician, and what happens to the money when
the repair does not go ahead. Payments use **Stripe test mode** only.

## 1. Creating a request (gatekeeping)

- A request can only be created if at least one approved technician in the
  customer's **region** can take it (same device, repair and expertise level).
  Otherwise `POST /repair-requests` answers `409 NO_TECHNICIAN_AVAILABLE`, and
  the attempt is counted once per customer, service, region and day in
  `turned_away_requests` (hashed customer, 180-day TTL). The create form checks
  `GET /service-availability` first and explains why it can't submit.
- `SKIP_TECHNICIAN_MATCH_CHECK=true` turns the check off for local development
  only (ignored in production).

## 2. The job portal

- A request is **open** in the portal while it is a v2 request, waiting for
  pickup (`pending-pickup`), has no technician, and has **at least one photo**.
  It counts as published at the time of its first photo.
- **Open jobs board** (`/jobs` on the website, outside the dashboard):
  `GET /jobs` needs no sign-in (rate limited, 60 a minute per address) and
  lists every open request as a safe summary - device, repair, region and
  district, pickup day, the usual price, when it was (re)posted and how many
  offers it has. No problem text, photos, tracking id or address.
- Approved technicians who could take it see the details at
  `GET /technician/job-portal` (shown on the same `/jobs` page when signed in)
  - district, pickup time, problem and photos; never the customer's name, email
  or street address. The newest (re)posted jobs come first.
- A technician applies with an estimate range, an inspection fee (capped by the
  service's catalogue inspection fee) and a note:
  `POST /repair-requests/:id/applications` (withdraw with `.../applications/mine/withdraw`).
- The customer compares applications (`GET /repair-requests/:id/applications`)
  and chooses one: `POST /repair-requests/:id/applications/:applicationId/accept`.
- Or the customer **rejects** an offer they don't agree with:
  `POST /repair-requests/:id/applications/:applicationId/decline`
  `{ reason: 'price' | 'inspection_fee' | 'other', note? }`. The offer becomes
  `declined`, an open fee checkout for it is closed, and the request is
  **reposted** (`repostedAt`, `repostCount`): it goes back to the top of the
  board. The technician is told (`application_declined`, with the customer's
  note) and may send **one** revised offer; if that is rejected too they
  cannot offer again on that request. A payment that still arrives for a
  rejected offer books no one and is refunded.
- When a request is first published (its first photo is attached), every
  approved technician who could take it gets an in-app `job_posted`
  notification, once per request (`services/jobAnnouncements.js`, at most 50).
- After a repost, every other approved technician who could take the job
  (not the rejected one, not anyone with an offer waiting; at most 50) gets an
  in-app `job_reposted` notification linking to `/jobs`.
- Admins can invite a technician to apply (`POST /admin/repair-requests/:id/invite`),
  or still assign directly as an override (no inspection fee).
- The admin is not involved while technicians are replying. Only if **no
  technician has an offer waiting 24 hours** after the request was last
  posted (published, or reposted after a rejection) does it appear on the
  admin attention list (`unchosen`, "No offers in 24h").

Application states: `pending`, `accepted`, `not_chosen` (another was chosen),
`withdrawn` (by the technician), `no_show` (the chosen technician did not come),
`declined` (the customer rejected it; `revisedAfterDecline` marks the one
revised offer).

## 3. Paying the inspection fee (booking)

- Choosing an application with a fee of 0 books the technician at once.
- With a fee, choosing opens a **Stripe Checkout** for exactly that fee
  (metadata `paymentType: 'inspection_fee'`, `applicationId`). Nothing is booked
  yet. Choosing the same application again reuses the open checkout; choosing a
  different one replaces it.
- When Stripe confirms the payment (webhook or the success page), one
  transaction records the payment and books the technician
  (`services/jobBooking.js`): request -> `driver_assigned`, technician busy, the
  chosen application `accepted`, the others `not_chosen`.
- The fee is stored in `request.inspectionPayment`, **never** in the fields that
  mean the repair is paid, so it never blocks the repair payment.
- If the technician can no longer be booked when the payment arrives (busy,
  request cancelled, someone else booked), the payment is recorded and
  **refunded automatically**, and the customer is told to choose again.

## 4. The fee counts toward the price

If the customer approves the final quote, the repair payment is the quote total
**minus the inspection fee already paid** (`utils/inspectionFee.js`
`amountDueForQuote`). If the fee covers the whole quote, the customer just
confirms and pays nothing more. The technician's settlement is still 90% of the
**full** quote.

## 5. When the repair does not go ahead

| Situation | Where | Fee |
|---|---|---|
| Technician does not come (admin: missed pickup -> "Offer to another technician") | `POST /admin/repair-requests/:id/missed-pickup/withdraw` | Full refund; other applicants can be chosen again |
| Customer cancels **2 hours or more** before the pickup time starts | `POST /repair-requests/:id/cancel-booking` | Full refund |
| Customer cancels **less than 2 hours** before | same | Kept, 90/10 |
| Customer declines the final price, then the request ends (see below) | | Kept, 90/10 |

- `GET /repair-requests/:id/booking-cancellation` tells the customer beforehand
  which outcome cancelling now would have. A visit can be cancelled this way
  only while the device has not been collected and a fee was paid.
- After a declined price the request ends one of three ways
  (`services/declinedQuoteClose.js`): the technician closes the job
  (`POST /repair-requests/:id/quote/cancel-request`), the customer ends it
  (`POST /repair-requests/:id/quote/close`), or - if the technician neither
  revises nor closes it within **3 days** - the daily job
  (`GET /cron/pickup-reminders`) closes it. The request records `closedBy`
  (`technician`, `customer` or `auto`). Revising the quote moves the request out
  of the declined state, so a revision is never closed.
- A **kept** fee becomes `request.inspectionFeeSettlement`: 90% to the
  technician (available in their wallet at once, shown as "Inspection fee
  kept"), 10% to Sarabo, whole taka, commission rounded and the technician's
  share by subtraction - the same rule as repairs.

## 6. Refunds

`services/inspectionFeeRefunds.js`, in two steps:

1. Inside the same transaction as the change that causes it, the fee and its
   `payments` row become **refund pending**.
2. After commit, Stripe is asked to refund (idempotency key
   `inspection-refund-<checkout session id>`, so it can never refund twice).

If Stripe fails, the refund **stays pending** - it is never lost. It shows on
the admin home ("Refund waiting") and on the request page, where an admin
presses **Retry refund** (`POST /admin/repair-requests/:id/inspection-fee/retry-refund`).

## 7. Reports and alerts

- `GET /admin/attention`: `feeRefunds` (refunds waiting on Stripe) alongside
  overdue, missed, unmatchable and unchosen requests.
- `GET /admin/reports`: `inspectionFees` - paid, refunded and kept in the
  period, Sarabo's and the technicians' shares, why fees were kept, and refunds
  waiting now; plus `turnedAway` counts.

## 8. Notifications

`job_invitation`, `application_received` (also for a revised offer),
`application_accepted`, `application_not_chosen`, `application_declined`,
`job_posted`, `job_reposted`,
`inspection_fee_refunded` (wording follows the
reason: booking failed, no-show, cancelled in time) and
`booking_cancelled_by_customer` (to the technician; says whether they keep their
share), `declined_request_closed` (to the technician, when the customer or the
daily job ends a declined request) and `declined_request_auto_closed` (to the
customer).

## 9. Testing

- `tests/jobPortalTests.js`, `tests/inspectionFeeTests.js`,
  `tests/inspectionFeeOutcomeTests.js` and `tests/declinedQuoteCloseTests.js`
  run inside `npm test`, with a fake Stripe
  and fake refunds.
- To try it by hand: Stripe test card `4242 4242 4242 4242`, any future date,
  any CVC. Refunds appear in the Stripe test dashboard.

## 10. Dummy jobs for local development

`npm run seed:dev-jobs -- --confirm-seed` (after `scripts/seed-dev-people.js`)
writes 24 open jobs (`SEED-J...`) to the local dev or a test database only:
about 40% that your own approved technician can take, some with offers from
seeded technicians, some reposted, and two over a day old with no offers. Their
placeholder photo has no stored file, so the photo viewer shows none. Remove
them with `-- --reset --confirm-seed`; `--count=N` changes how many.
