# AI summary on the admin Reports page

A short "what happened and what to do" for the period chosen on Reports
(7, 30 or 90 days): a headline, 2-4 highlights and 1-3 actions, written by AI
from the report's own numbers.

## Endpoints (admins only)

| Method | Path | Does |
| --- | --- | --- |
| GET | `/admin/reports/ai-summary?days=7` | The last summary written for that period, or `{ summary: null }`. No AI call. |
| POST | `/admin/reports/ai-summary` `{ days }` | Builds the report and the "needs attention" counts, asks the AI, saves and returns `{ summary }`. |

`summary`: `{ headline, highlights[], actions[], days, generatedAt }`.

The last summary per period is kept in `ai_report_summaries` (`_id`
`days-7` / `days-30` / `days-90`) with the facts it was written from and the
admin who asked, so opening the page costs nothing; "Write again" replaces it.

## What the AI gets

`buildSummaryFacts` in `services/aiReportSummaryService.js`: the same numbers
the page shows - requests made, finished, cancelled, success rate, average
days, turned away (each with the period before), the busiest regions (waiting,
waiting with no technician who can take it, turned away, technicians), top
devices and repairs, technician workload, inspection-fee money, and the
current "needs attention" counts. Counts and places only - no customer or
technician names, emails or ids.

## No invented numbers

Every sentence is checked before it is saved: each number in it must be in
the facts, a change between a period and the one before (difference or
rounded percent), a small count up to 10, or a fixed context number (24 hours,
30/90 days). Sentences that fail are dropped; a headline that fails becomes
"Here is how the last N days went."; if nothing is left the request fails
with 502.

## Settings

| Variable | Default |
| --- | --- |
| `AI_REPORT_SUMMARY_ENABLED` | `false` (needs `true` **and** `GEMINI_API_KEY`) |
| `AI_REPORT_SUMMARY_TIMEOUT_MS` | 25000 |
| `AI_REPORT_SUMMARY_USER_10M_LIMIT` | 5 per admin per 10 minutes |
| `AI_REPORT_SUMMARY_USER_DAILY_LIMIT` | 20 per admin per day |
| `AI_REPORT_SUMMARY_GLOBAL_DAILY_LIMIT` | 50 per day |

`GET /ai/status` returns `reportSummary` so the page shows the card only when
it can work.

Tests: `tests/aiReportSummaryTests.js` (fake provider).
