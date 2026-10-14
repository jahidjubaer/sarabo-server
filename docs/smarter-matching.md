# Smarter matching (offer ranking)

When technicians send offers on a repair request, the customer sees them ranked
"Best match" first, with a short list of reasons for each offer. The customer still
chooses; nothing is booked automatically.

Code: `services/offerRanking.js` (pure scoring), `JobPortalController.listForRequest`
and `matchHistory` (data), tests in `tests/offerRankingTests.js`.

## What it uses

Only data Sarabo already stores. No paid service, no maps API, no AI.

| Factor | Weight | Source | No history |
|---|---|---|---|
| Rating | 30% | visible reviews, smoothed toward 3★ with a weight of 2 reviews | 0.5 |
| Reliability | 25% | repairs completed vs. pickups missed (`no_show`), Laplace-smoothed | 0.5 |
| Price | 20% | estimate midpoint vs. the other waiting offers (fee breaks ties) | 0.5 (one offer) |
| Distance | 15% | same district as the customer = 1, other district in the region = 0.4 | 0.5 |
| Response | 10% | median minutes from posting (or repost) to the offer, last 20 offers, at least 3 | 0.5 |

Response time: 30 minutes or faster scores 1, 24 hours or slower scores 0, on a log
scale between. Distance is district-level only, because technicians and requests have no
map coordinates.

## What the customer gets

Each `pending` application in `GET /repair-requests/:id/applications` has:

```json
"match": { "score": 77, "rank": 1, "recommended": true,
           "reasons": [{ "code": "top_rated", "value": 4.9 }, { "code": "same_district" }] }
```

- `recommended` is set only when there are two or more waiting offers.
- Equal scores go to the offer sent first.
- Reason codes, shown only when true: `top_rated` (≥ 4.5★ from ≥ 3 reviews),
  `reliable` (≥ 5 repairs, no missed pickup), `lowest_price` (strictly lowest estimate),
  `same_district`, `fast_reply` (median ≤ 60 minutes).
- Rejected, withdrawn and closed offers carry no `match`.

The client sorts by "Best match" by default, and the customer can switch to "Lowest price"
or "Newest".
