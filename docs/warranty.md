# Repair warranty and returns

Code: `utils/warranty.js` (policy and rules), `controllers/warrantyController.js`,
`routes/warranty.js`, `services/warrantyRefunds.js`, tests in `tests/warrantyTests.js`.

## Policy

Agreed with the project owner on 2026-10-14.

- **Length:** 30 days, counted from when the customer confirms they received the repaired
  device (`customerReceiptConfirmation.confirmedAt`).
- **Covered:** the repaired fault comes back, or a part the technician fitted fails.
  Not new damage, water damage or a drop.
- **Re-inspection:** the same technician, free of charge.
- **Covered claim:** a free re-repair. If that is not possible, or the customer says it
  is still broken, an admin refunds the repair amount.
- **Not covered:** the customer may ask an admin to review it within 7 days. The admin
  upholds or overturns the decision.
- **Limits:** one open claim per repair at a time, and at most 2 claims per repair.

## Claim lifecycle

```
submitted ──schedule──▶ inspection_scheduled ──decide──▶ covered ──rerepair: fixed──▶ fixed_pending_confirmation ──confirm: fixed──▶ resolved
                                              │                 │                                                  └─confirm: not fixed──┐
                                              │                 └──rerepair: cannot_fix──────────────────────────────────────────────────▶ refund_pending ──admin refund──▶ refunded
                                              └──decide──▶ not_covered ──review-request (≤ 7 days)──▶ review_requested ──uphold──▶ rejected
                                                                                                                         └─overturn──▶ covered
```

Every step is a guarded update on the claim's current status: two people acting at once
can never both win, and no step can be skipped.

## Endpoints

| Who | Method and path | Body |
|---|---|---|
| owner, technician, admin | `GET /repair-requests/:id/warranty` | – |
| owner | `POST /repair-requests/:id/warranty/photos` | `{ fileName, mimeType, size }` |
| owner (verified email) | `POST /repair-requests/:id/warranty-claims` | `{ kind: same_fault \| part_failed, description, photoIds? }` |
| owner | `POST /warranty-claims/:claimId/confirm` | `{ fixed, note? }` |
| owner | `POST /warranty-claims/:claimId/review-request` | `{ note? }` |
| technician | `GET /technician/warranty-claims` | – |
| technician | `POST /warranty-claims/:claimId/schedule` | `{ visitAt, note? }` (within 14 days) |
| technician | `POST /warranty-claims/:claimId/decision` | `{ covered, reason?, note }` |
| technician | `POST /warranty-claims/:claimId/rerepair` | `{ outcome: fixed \| cannot_fix, note? }` |
| admin | `GET /admin/warranty-claims?status=needs_action\|all\|<status>` | – |
| admin | `POST /admin/warranty-claims/:claimId/review` | `{ decision: uphold \| overturn, note }` |
| admin | `POST /admin/warranty-claims/:claimId/refund` | – |

## Photos

Up to 4 photos per claim, and they are optional. Upload works the same way as damage
photos: a signed upload link, and the server checks the object exists before attaching it.
Photos are stored under `repair-requests/<id>/warranty/`. An upload that is never attached
expires after 20 minutes (TTL index). Read links are short-lived, and the storage key is
never sent to the client.

## Refunds and the technician's wallet

The refund is the whole quote total: the repair payment plus the inspection fee credited
toward it (`refundPlan`). Both are refunded through Stripe (test mode), the same way as
inspection-fee refunds. Each refund uses an idempotency key per claim and part
(`warranty-refund-<claimId>-<purpose>`), so a retry can never refund twice. If Stripe
fails, the claim stays `refund_pending` and the admin presses refund again.

In the same transaction that approves the refund, the technician's settlement for that
repair is marked `reversed` (`utils/settlement.js`). A reversed settlement counts toward
no balance. If the technician had already withdrawn it, the wallet shows the amount as
`owedBalance`, and it is netted from future earnings before anything else can be withdrawn.

## Notifications

There are three types, one per audience: `warranty_update` (customer),
`warranty_update_technician`, and `warranty_admin_action` (sent to every admin for a review
or a refund). The `step` metadata says what happened. Messages never include amounts or
notes.
