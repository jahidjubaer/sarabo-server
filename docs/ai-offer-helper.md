# Offer helper (technicians, jobs board)

Two aids in the technician's offer form on `/jobs`. The technician still
decides every number and every word before sending.

## Price guide (no AI)

`GET /repair-requests/:id/applications/price-guide` - an approved technician
the job is open to (same rule as applying; others get 403/409).

```json
{ "guide": {
  "basis": "offers",            // or "catalogue" when there are fewer than 3 offers
  "sampleSize": 12,
  "currency": "BDT",
  "estimate": { "low": 1150, "high": 2450 },
  "inspectionFee": { "low": 175, "high": 225 },   // null on the catalogue basis
  "catalogueEstimate": { "min": 1000, "max": 3000 },
  "maxInspectionFee": 300
} }
```

Built from offers on requests for the **same service** created in the last 180
days (`services/offerPriceGuide.js`). Only pending, accepted and not-chosen
offers count - rejected and withdrawn ones are not prices anyone agreed to.
The range is the middle half: the 25th percentile of "from" estimates to the
75th percentile of "to" estimates, and the same for the inspection fee.

The form warns (advice only) when the estimate starts 30% above the usual top,
ends 30% below the usual bottom, the range is more than 3x wide, or the fee is
above the usual fee range. The server's own limits are unchanged.

## AI offer note

`POST /repair-requests/:id/applications/ai-note` - same access rule, plus
the AI rate limit.

Body: `{ language?: "en" | "bn", technicianNotes?: string }` (notes at most
300 characters - the form sends what the technician already typed in the note
box). Returns `{ note }`, at most 500 characters, which replaces the note box;
Undo puts the technician's text back.

The AI sees only the job facts the technician already sees: device, brand,
model, repair, the customer's problem text and whether there are photos -
never the customer's name, email or address. It writes as the technician
("I will check..."), names the likely problem only as a possibility, says the
final price comes after inspection, and writes no numbers. Phone numbers
(also in Bangla digits), emails, links and @handles are removed from the
answer so contact stays on Sarabo.

## Settings

| Variable | Default |
| --- | --- |
| `AI_OFFER_HELPER_ENABLED` | `false` (needs `true` **and** `GEMINI_API_KEY`) |
| `AI_OFFER_HELPER_TIMEOUT_MS` | 15000 |
| `AI_OFFER_HELPER_USER_10M_LIMIT` | 10 per technician per 10 minutes |
| `AI_OFFER_HELPER_USER_DAILY_LIMIT` | 40 per technician per day |
| `AI_OFFER_HELPER_GLOBAL_DAILY_LIMIT` | 200 per day for the whole site |

`GET /ai/status` returns `offerHelper` so the form shows the button only when
it can work. The price guide does not depend on this switch.

Tests: `tests/aiOfferHelperTests.js` (fake provider).
