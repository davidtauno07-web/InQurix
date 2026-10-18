# Plans, credits and billing

## Plans

Defined in `apps/server/src/plans.ts`. The prices are what the UI shows; the actual charge is configured in Paddle.

| | Free | Pro | Business |
|---|---|---|---|
| Account needed | No | Yes | Yes |
| Local search, Quick Search, previews, history | Unlimited | Unlimited | Unlimited |
| Meaning-based search, investigations, exports | Yes | Yes | Yes |
| Credits per billing period | 25 | 500 | 2,000 |
| Company workspace, shared sources, invitations | No | No | Yes (up to 100 sources) |
| Activity (audit) log | No | No | Yes |
| Seats | 1 | 1 | Per seat, up to 250 |
| Shown price (USD/month) | 0 | 12 | 29 per seat |

**Credits are only used for resource-intensive operations** (`OPERATION_COSTS`): server-side investigations (1–3 credits each, depending on type), OCR per page, and indexing a document into a company source. Search, previews, opening files and local indexing never use credits.

## Credits ledger

`CreditEntry` is append-only: every entry stores `delta`, `balanceAfter`, a reason, the operation, the user and an optional unique `idempotencyKey`. Postings lock the organisation row, so concurrent spends cannot overdraw the balance. Retrying a spend with the same key returns the original entry instead of charging twice. `GET /api/billing/orgs/:orgId/credits` returns the balance and history.

## Entitlements

`GET /api/billing/orgs/:orgId/entitlement` returns the plan, features, seats and credit balance as an **Ed25519-signed JWT** (valid 7 days). The desktop app can verify it offline with the public key from `/api/billing/entitlement/public-key`. Generate the key pair with `npm run keys -w @inqurix/server` and put both lines in `.env`.

## Paddle setup

Paddle Billing was chosen because it acts as merchant of record and is available to Namibian businesses (to be confirmed by the business owner). It sits behind the `BillingProvider` interface in `billing.ts`, so it can be replaced.

1. Create a sandbox account at https://sandbox-vendors.paddle.com.
2. Create two products with monthly prices (Pro; Business per seat) and copy the price ids into `PADDLE_PRICE_PRO_MONTHLY` and `PADDLE_PRICE_BUSINESS_MONTHLY`.
3. Create an API key → `PADDLE_API_KEY`.
4. Add a notification destination for `https://<your-server>/api/webhooks/paddle` with the events `subscription.created`, `subscription.updated`, `subscription.canceled` and `transaction.completed`. Copy its secret key → `PADDLE_WEBHOOK_SECRET`.
5. For production, set `PADDLE_ENV=production` and use live keys.

`POST /api/billing/orgs/:orgId/checkout` (owners only) creates a Paddle transaction and returns its checkout URL. Without configuration it returns `503 not_configured`; it never pretends a payment happened.

## Webhook processing

- The `Paddle-Signature` header (`ts=…;h1=…`) is verified with HMAC-SHA256 over `ts:rawBody`, and timestamps older than 5 minutes are rejected.
- Each `event_id` is stored once. Redelivered events return `duplicate: true` without being applied again; failed events keep their error and are retried by Paddle.
- Subscription events older than the last one applied are ignored (`stale`), so a late `canceled` cannot overwrite a newer `active`.
- Plan access follows the subscription status: `active`, `trialing` and `past_due` keep the plan; anything else drops to Free.
- `transaction.completed` adds the plan's credits once per transaction id, even if Paddle sends it under several event ids.

Tested in `apps/server/test/server.test.ts` with signed synthetic events. **A real Paddle sandbox account has not been connected yet**; that needs the credentials above.
