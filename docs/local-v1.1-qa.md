# Sarabo v1.1 — Local Manual QA Guide

A repeatable, local-only manual test guide for Sarabo v1.1. Nothing here touches
production, sends real payments, or uses live credentials. It covers the QA
identities, the deterministic seed, a full click-through checklist, an exact
end-to-end runbook, and Stripe/Firebase-Storage local test notes.

> **Scope:** local development only. Do not run any of this against a production
> database, a live Stripe account, or a production Firebase project.

---

## 1. Prerequisites

- **Server** running locally: `npm run dev` in `sarabo-server` (default `http://localhost:3000`).
- **Client** running locally: `npm run dev` in `sarabo-client` (Vite dev server).
- **MongoDB** reachable via the server's `MONGO_URI` in `sarabo-server/.env`,
  with a **development** database name (never one containing `production` — the
  seed refuses to run there).
- **Firebase**: a **development** Firebase project/bucket configured in both the
  client env and the server Admin credentials.
- **Stripe**: **test mode** keys only (see §7).

---

## 2. QA Identities

Manual testing uses four fixed identities. Their **roles** are seeded into Mongo
by the QA seed (§3); their **Firebase Auth accounts must be created manually**
(the seed never creates Firebase users). Use the same email for the Firebase
account and the seeded role row so the app resolves the role after login.

| Role         | Email (seeded role row)     | Firebase account | Password           |
| ------------ | --------------------------- | ---------------- | ------------------ |
| Customer     | `qa.customer@sarabo.local`  | create manually  | `<set locally>`    |
| Technician A | `qa.tech-a@sarabo.local`    | create manually  | `<set locally>`    |
| Technician B | `qa.tech-b@sarabo.local`    | create manually  | `<set locally>`    |
| Admin        | `qa.admin@sarabo.local`     | create manually  | `<set locally>`    |

> **Never commit real passwords or secrets.** The password column stays
> `<set locally>` in the repo. Keep your own values only in your local notes.

### Required Firebase-side setup (do once, manually)

1. In the **development** Firebase project → Authentication → Users, create an
   Email/Password user for each email above. Choose your own local passwords.
2. **Verify** the customer and technician emails as needed for your test:
   - To test the *unverified* path, leave the customer unverified.
   - To test the *verified* path, mark the customer verified (or verify via the
     in-app flow — see the AUTH checklist).
3. The **role** each account has in the app comes from the seeded Mongo `users`
   row (the QA seed sets `qa.customer` → `user`, `qa.tech-a`/`qa.tech-b` →
   `rider`, `qa.admin` → `admin`). If you create the Firebase accounts before
   seeding, just run the seed afterwards.

---

## 3. Deterministic QA Seed

The seed lives at `scripts/seed-qa-repair-requests.js` (server) and is exposed as an npm
script. It is **development-only, deterministic, idempotent, and strictly
namespaced** — every document it touches has a `QA-` tracking prefix or a
`@sarabo.local` email, so it never affects real data.

```bash
# From sarabo-server/

# Dry run (default) — prints what it WOULD do, writes nothing:
npm run seed:qa-repair-requests

# Write / refresh the QA users + parcels (safe to re-run; idempotent upserts):
npm run seed:qa-repair-requests -- --confirm-seed

# Delete the QA namespace, then reseed fresh (a clean slate for a new pass):
npm run seed:qa-repair-requests -- --reset --confirm-seed

# Preview the namespaced cleanup without deleting:
npm run seed:qa-repair-requests -- --reset
```

**Safety controls** (identical belt-and-suspenders design to
`seed-service-definitions.js`, whose `isSafeToSeed` it reuses):

- Refuses to run if `isProductionEnvironment()` is true.
- Independently refuses if the resolved database name looks like production.
- Every read/write/delete is scoped to the `QA-` / `@sarabo.local` namespace.
- No Stripe calls, no Firebase Storage access, no Firebase user creation.
- Never prints `MONGO_URI` or any secret — only the database name and counts.

### Seeded scenarios (12 requests, all owned by the QA Customer)

| Tracking | Status                | What it exercises                                  |
| -------- | --------------------- | -------------------------------------------------- |
| `QA-01`  | `pending-pickup`      | Brand-new request; deletable; ready to assign      |
| `QA-02`  | `assignment_pending`  | Offered to Technician B; awaiting accept/reject    |
| `QA-03`  | `driver_assigned`     | Accepted assignment                                |
| `QA-04`  | `parcel_picked_up`    | Picked up, pre-inspection                          |
| `QA-05`  | `inspection_completed`| Inspection submitted                               |
| `QA-06`  | `quote_submitted`     | Quote awaiting customer decision                   |
| `QA-07`  | `quote_approved`      | Approved quote; payment eligible                   |
| `QA-08`  | `payment_completed`   | Paid                                               |
| `QA-09`  | `repair_in_progress`  | Repair started, one progress update                |
| `QA-10`  | `repair_completed`    | Completed with evidence                            |
| `QA-11`  | `pending-pickup`      | Carries a **rejected** assignment-history entry    |
| `QA-12`  | `quote_rejected`      | Customer rejected the quote                        |

> The `assignment_pending` (`QA-02`) offer is made to **Technician B**, so log in
> as Technician B to accept/reject it. `QA-11` shows the reassignment path after a
> rejection.

---

## 4. Local QA Checklist

Copy this block into your test log and tick as you go.

### AUTH
- [ ] Register a new account
- [ ] Login
- [ ] Email verification screen appears for an unverified account
- [ ] Resend verification email (respects the resend cooldown)
- [ ] "Check again" re-reads verified status after verifying in Firebase
- [ ] Logout

### CUSTOMER
- [ ] Create request
- [ ] Optional damage image upload (1–3 images, preview/remove)
- [ ] View request detail
- [ ] Quote approve / reject
- [ ] Payment (Stripe test mode)
- [ ] Progress tracking updates as status advances
- [ ] Completion visible to customer
- [ ] Cancellation (while still cancellable)
- [ ] Safe deletion (only on a brand-new pending-pickup request)

### ADMIN
- [ ] Approve technician
- [ ] Eligible-technician search for a request
- [ ] Assign technician
- [ ] See assignment pending after assigning
- [ ] Reassign after a rejection
- [ ] User management

### TECHNICIAN
- [ ] See a pending assignment offer
- [ ] Reject with a reason
- [ ] Accept an assignment
- [ ] Pickup progression
- [ ] Inspection submission
- [ ] Submit quote
- [ ] Start repair
- [ ] Add a progress update
- [ ] Complete repair with completion evidence

### PUBLIC
- [ ] Home
- [ ] Services
- [ ] Service Areas
- [ ] Track Request (by tracking id)
- [ ] About
- [ ] Theme switcher (light/dark)
- [ ] Mobile navbar

### SECURITY
- [ ] Unverified customer is blocked from a protected mutation (server returns 403 `EMAIL_NOT_VERIFIED`)
- [ ] Cross-user request access is denied (a customer cannot open another customer's request)
- [ ] A technician cannot act on another technician's job
- [ ] Customer cannot see an assignment **rejection reason**
- [ ] General reads expose **no** storage metadata (no `storageKey`/signed URL)
- [ ] Public tracking exposes **no** private data (only tracking id, status, timeline)

---

## 5. Full Manual Runbook (end-to-end)

A single repeatable script that walks one repair from creation to completion.
Start from a clean seed (`--reset --confirm-seed`) or create a fresh request.

1. **Customer** creates a repair request.
2. **Customer** uploads damage images (1–3).
3. **Admin** assigns **Technician A**.
4. **Technician A** rejects the assignment (with a reason).
5. **Admin** reassigns to **Technician B**.
6. **Technician B** accepts the assignment.
7. **Technician B** advances pickup.
8. **Technician B** submits the inspection.
9. **Technician B** submits the quote.
10. **Customer** approves the quote.
11. **Customer** pays using **Stripe test mode**.
12. **Technician B** starts the repair.
13. **Technician B** adds a progress update.
14. **Technician B** uploads completion evidence.
15. **Technician B** completes the repair.
16. **Customer** verifies the completed state.
17. Confirm **Technician B** is available again (workload released).

---

## 6. Stripe Local-Test Notes

- Use **Stripe test mode only**. Test publishable/secret keys and the test
  webhook signing secret — **never** live keys or a real card.
- The payable amount must equal the **approved quote total**; verify the amount
  shown at checkout matches the quote.
- Test a **successful** checkout (Stripe test card, e.g. the standard test PAN)
  and confirm the request moves to `payment_completed` and `paymentStatus: paid`.
- Test **cancel/return** from the Stripe page and confirm the request stays
  unpaid and re-payable.
- Test **replay/idempotency**: re-deliver the same webhook event (or return to
  the success URL twice) and confirm exactly **one** payment and **one**
  notification — no duplicates.
- Do not change the Stripe architecture; this is a test-mode walkthrough only.

---

## 7. Firebase Storage Local-Test Notes

Use the **development** Firebase project/bucket. Do not point Storage at a
production bucket.

**Damage images (customer, at request creation):**

1. Start an upload session → 2. receive a signed **PUT** target → 3. upload →
4. **finalize** the image → 5. read it back via a signed read → 6. **remove** it
   and confirm it disappears.

**Completion evidence (technician, at repair completion):**

1. Upload evidence → 2. **complete** the repair with that evidence →
3. **Customer** reads the completion evidence on the finished request.

Confirm that general request reads never expose `storageKey` or signed URLs —
images are only ever served through their dedicated, authorized endpoints. Do not
change the storage architecture; this is a manual verification sequence only.
