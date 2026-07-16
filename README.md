# Usage Billing Service

A multi-tenant usage tracking and billing backend for an AI SaaS. Tenants authenticate with API keys, record metered usage (API calls and tokens), get quota-limited by plan, and upgrade from Free to Pro through Stripe Checkout — with subscription state kept in sync via webhooks.

## Features

- **API-key authentication** — every tenant gets a key; requests are scoped to their data
- **Idempotent usage recording** — retries with the same `Idempotency-Key` never double-count, guaranteed by a database unique constraint (not application logic)
- **Plan quotas** — Free (1k calls / 100k tokens per month) and Pro (100k calls / 10M tokens); exceeding returns `429`
- **Usage summaries with cost** — monthly totals priced from fixed configuration constants
- **Stripe subscriptions** — hosted Checkout for upgrades, webhooks for plan changes, signature verification, and duplicate-event deduplication

## Tech stack

Node.js · TypeScript · Express 5 · Prisma 7 (with `@prisma/adapter-pg`) · PostgreSQL 16 (Docker) · Stripe · Zod · Vitest + Supertest

## Quick start

### Prerequisites

- Node.js 22+
- Docker Desktop
- A [Stripe](https://stripe.com) account (test mode — no activation needed) and the [Stripe CLI](https://docs.stripe.com/stripe-cli)

### Setup

```powershell
# 1. Install dependencies
npm install

# 2. Start Postgres
docker compose up -d

# 3. Configure environment
#    Copy .env.example to .env and fill in the Stripe values (see "Stripe setup" below)

# 4. Create tables and generate the Prisma client
npx prisma migrate dev

# 5. Seed plans (Free, Pro) and a test tenant (apiKey: test-key-123)
npx prisma db seed

# 6. Run
npm run dev
```

Server starts on `http://localhost:3000`.

### Stripe setup

1. **Secret key**: [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys) → copy `sk_test_...` → `STRIPE_SECRET_KEY`
2. **Pro price**: Product catalog → Add product → "Pro", recurring $29/month → copy the `price_...` ID → `STRIPE_PRO_PRICE_ID`
3. **Webhook secret**: run `stripe listen --forward-to localhost:3000/webhooks/stripe` → copy the printed `whsec_...` → `STRIPE_WEBHOOK_SECRET` (keep `stripe listen` running while developing)

Test the full upgrade flow with card `4242 4242 4242 4242`, any future expiry, any CVC.

## API

All authenticated endpoints expect `Authorization: Bearer <apiKey>`.

| Method | Path                | Auth | Description |
| ------ | ------------------- | ---- | ----------- |
| GET    | `/health`           | no   | Liveness check |
| GET    | `/me`               | yes  | Current tenant + plan |
| POST   | `/usage/record`     | yes  | Record usage (requires `Idempotency-Key` header) |
| GET    | `/usage`            | yes  | Current month's totals + cost |
| POST   | `/billing/checkout` | yes  | Create a Stripe Checkout session for Pro |
| POST   | `/webhooks/stripe`  | signature | Stripe event receiver |

### `POST /usage/record`

```
Authorization: Bearer test-key-123
Idempotency-Key: req-abc-123
Content-Type: application/json

{ "usageType": "api_call", "quantity": 1 }
```

- `usageType`: `"api_call"` or `"tokens"`
- Responses: `201` recorded · `200` duplicate (already recorded, not counted again) · `400` invalid body or missing key · `429` monthly quota exceeded (body includes `usage` and `limit`)

### `GET /usage`

```json
{ "apiCalls": 500, "tokens": 50000, "cost": 1.5 }
```

Cost comes from constants in `src/pricing.ts`: $0.001 per API call, $0.02 per 1k tokens, rounded to cents at the end.

### `POST /billing/checkout`

Returns `{ "url": "https://checkout.stripe.com/..." }` — open it in a browser to subscribe. On completion, Stripe sends `checkout.session.completed` to the webhook, which flips the tenant to Pro.

## Testing

```powershell
npm test            # watch mode
npx vitest run      # single pass
```

38 tests across 4 files (Postgres must be running; no Stripe credentials required — webhook tests sign payloads with a local dummy secret):

- **`tests/pricing.test.ts`** — cost calculation (pure unit tests)
- **`tests/auth.test.ts`** — health check, API-key auth (missing/malformed/unknown/valid)
- **`tests/usage.test.ts`** — request validation, idempotent recording (incl. per-tenant key scoping and a 5-way concurrent race), quota boundaries, api_call/token quota independence, monthly summaries, previous-month exclusion
- **`tests/webhooks.test.ts`** — signature rejection, duplicate-event dedupe, and the full subscription lifecycle (upgrade → status sync → downgrade) with database side effects asserted

## Design decisions

- **Idempotency via unique constraint, not check-then-insert.** The handler does check for an existing event first (fast path), but the real guarantee is `@@unique([tenantId, idempotencyKey])` — concurrent duplicates lose the insert race, surface as Prisma error `P2002`, and are converted to a "duplicate" response. The same pattern deduplicates webhook events (`ProcessedWebhook.stripeEventId`).
- **Webhook route mounted before `express.json()`.** Stripe signature verification needs the raw request bytes; the JSON body parser would consume them. The webhook router uses `express.raw()` and is registered first in `src/app.ts`.
- **Quota check is best-effort under concurrency.** Racing requests with *different* idempotency keys can slightly overshoot a limit (check and insert are not in one serializable transaction). Acceptable for this use case; tighten with a transaction if hard caps are ever required.
- **Prisma 7 driver adapters.** `PrismaClient` requires an explicit adapter (`@prisma/adapter-pg`); there is no implicit `DATABASE_URL` pickup. One shared client instance lives in `src/db.ts` — never construct per-request.
- **Pricing as pure constants.** `src/pricing.ts` has no I/O, making cost calculation trivially unit-testable and keeping price changes reviewable in one place.
- **Plan limits on the `Plan` row.** Quotas are data, not code — changing Free's limit is an `UPDATE`, not a deploy.

## Project structure

```
prisma/
  schema.prisma      # Tenant, Plan, UsageEvent, Subscription, ProcessedWebhook
  seed.ts            # Free/Pro plans + test tenant
src/
  index.ts           # entrypoint (listen)
  app.ts             # Express app + router mounting order
  db.ts              # shared PrismaClient (pg adapter)
  stripe.ts          # Stripe client
  pricing.ts         # cost constants + calculateCost()
  middleware/auth.ts # Bearer apiKey -> tenant (with plan) on res.locals
  routes/usage.ts    # POST /usage/record, GET /usage
  routes/billing.ts  # POST /billing/checkout
  routes/webhooks.ts # POST /webhooks/stripe
tests/               # vitest + supertest suites
```

## Troubleshooting

- **`P1000: Authentication failed` but credentials look right** — another Postgres may own port 5432 (common with a native Windows install). Check `netstat -ano | findstr :5432`; stop the `postgresql-*` Windows service or remap the container to `5433:5432`.
- **`ECONNREFUSED` from Prisma** — the container isn't running: `docker compose up -d`.
- **`Cannot find ../generated/prisma/client`** — run `npx prisma generate`.
- **Env changes not taking effect** — `tsx watch` reloads on code changes only; restart `npm run dev` after editing `.env`.
- **Webhooks not arriving locally** — `stripe listen --forward-to localhost:3000/webhooks/stripe` must be running, and `STRIPE_WEBHOOK_SECRET` must match the secret it printed.
