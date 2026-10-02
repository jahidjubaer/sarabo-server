# AI request helper ("Describe your problem")

On the create-request form a customer can describe the problem in their own
words - Bangla, English or Banglish - and AI fills in the form: device, repair,
brand, model and a clear English description. The customer checks and edits
everything before submitting; Undo puts back what was there.

## Endpoints

| Method | Path | Who | Returns |
| --- | --- | --- | --- |
| GET | `/ai/status` | anyone | `{ requestHelper: boolean }` - the form hides the helper when false |
| POST | `/ai/request-draft` | signed-in user | `{ draft }` - see below |

Body: `{ text }`, 5-1500 characters. Text with a card number, password, token
or tracking code is refused (400) before any AI call.

`draft`: `productCategorySlug`, `serviceDefinitionId`, `productBrand`,
`productModel`, `damageDescription`, `confidence` (`high|medium|low`),
`followUpQuestion`. Any field may be null when the AI could not tell.

## Safety

- The model only sees the live, active catalogue and must answer with its ids
  (JSON schema enum). The server checks them again: unknown or inactive ids,
  and a repair that belongs to another device, are dropped.
- No prices come from the AI. The estimate shown is the catalogue's.
- The customer's text is marked untrusted in the prompt.
- Errors: 503 `AI_HELPER_UNAVAILABLE`, 504 `AI_HELPER_TIMEOUT`, 502
  `AI_HELPER_INVALID_RESPONSE`, 429 when a limit is reached.

## Settings

Shares `GEMINI_API_KEY` and `AI_SUPPORT_MODEL` with AI support, with its own
switch and budget, so it can never use up the support chat's daily calls.

| Variable | Default |
| --- | --- |
| `AI_REQUEST_HELPER_ENABLED` | `false` (needs `true` **and** a Gemini key) |
| `AI_REQUEST_HELPER_TIMEOUT_MS` | 20000 |
| `AI_REQUEST_HELPER_USER_10M_LIMIT` | 10 per customer per 10 minutes |
| `AI_REQUEST_HELPER_USER_DAILY_LIMIT` | 30 per customer per day |
| `AI_REQUEST_HELPER_GLOBAL_DAILY_LIMIT` | 200 per day for the whole site |

Limits are counted in MongoDB under the `request-helper` prefix.

Tests: `tests/aiRequestDraftTests.js` (fake provider, in `npm run test:support`
and `npm test`).
