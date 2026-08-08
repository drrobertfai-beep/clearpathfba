# ClearPathFBA — Subscription Billing (Stripe)

Server-side subscription billing built for the owner's Stripe account.
**This milestone runs in TEST MODE only**: the `STRIPE_SECRET_KEY` in use is a
Stripe **test** secret (`sk_test_...`) — no real charges, no live keys anywhere.

## Approved pricing (owner-ratified 2026-08-08, published on the landing page)

| Tier        | Product                  | Price        | Stripe lookup key                |
|-------------|--------------------------|--------------|----------------------------------|
| Solo        | ClearPathFBA Solo        | $49/clinician/mo | `clearpathfba_solo_monthly`    |
| Practice    | ClearPathFBA Practice    | $39/clinician/mo | `clearpathfba_practice_monthly` |
| Organization| ClearPathFBA Organization| $29/clinician/mo | `clearpathfba_organization_monthly` |

Recurring monthly subscriptions only (no per-report billing). Guardian and
staff seats are free. One subscription per account for this milestone; the
admin chooses the tier and the number of clinician seats (quantity) at
checkout. A 3-month free pilot precedes any real billing.

## API surface (all admin-only except the webhook)

- `GET /api/billing/plans` — the three tiers with Stripe `price_id`s.
  Server-side price lookup, so the client never sees the secret key.
- `POST /api/billing/checkout` — body `{plan_key, quantity}`; creates a Stripe
  Checkout Session (`mode: subscription`) and returns `{session_id, url}`.
  The account identity (user id, username, plan) rides in the session and
  subscription metadata so the webhook can reconcile back to the account.
- `GET /api/billing/status` — current subscription row for the account, or
  `null`.
- `POST /api/billing/cancel` — cancels the active subscription.
- `POST /api/stripe/webhook` — Stripe-signed webhook (no auth; signature is
  verified with `STRIPE_WEBHOOK_SECRET`). Handles
  `checkout.session.completed` (record subscription + customer),
  `customer.subscription.updated` (sync status/period), and
  `customer.subscription.deleted` (mark canceled).

## Environment variables

| Variable               | Purpose                                                      | Current value             |
|------------------------|--------------------------------------------------------------|---------------------------|
| `STRIPE_SECRET_KEY`    | Stripe API key (server-side only, never in client code)      | TEST key (`sk_test_...`)  |
| `STRIPE_WEBHOOK_SECRET`| Signing secret for webhook deliveries                        | Test-mode webhook secret  |
| `DATABASE_URL`         | Neon Postgres (the `subscriptions` table lives in this DB)   | Neon URL                  |
| `APP_URL` (optional)   | Override for Checkout success/cancel redirect base           | unset (uses `https://clearpathfba-app.vercel.app`) |

The secret key and webhook secret are stored as Vercel project environment
variables (production/preview/development) and never committed. `server/src/stripe.js`
reads them via `process.env`; the routes return 503 when they are missing.

## The `subscriptions` table

Created by the dual-mode schema in `server/src/db.js` (SQLite dev + Postgres
production, same columns). One row per Stripe subscription, keyed on
`subscription_id` (UNIQUE):

`id, user_id, customer_id, subscription_id, plan_key, plan_label, quantity,
status, current_period_end, cancel_at_period_end, created_at, updated_at`

## Live-key swap procedure (at pilot conversion, ~3 months out)

Done by the owner with the live Stripe account. No code changes required —
everything is configuration:

1. **Create live products/prices** (or rely on `ensurePlans`): the app looks up
   prices by the same `lookup_key`s above and creates them if missing, so
   simply pointing it at the live key provisions them on first call.
2. **Create a live webhook endpoint** in the Stripe dashboard (Developers →
   Webhooks → Add endpoint):
   - URL: `https://clearpathfba-app.vercel.app/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Copy the generated signing secret (`whsec_...`).
3. **Swap the Vercel env vars** (project → Settings → Environment Variables,
   or `bunx vercel env add ...`):
   - `STRIPE_SECRET_KEY` = live secret (`sk_live_...`)
   - `STRIPE_WEBHOOK_SECRET` = live webhook signing secret (`whsec_...`)
   - Redeploy / promote production.
4. **Test with a $1-or-tiny live card**, or run a 3-month-free pilot plan:
   Stripe supports setting `billing_cycle_anchor` / trial days on the
   subscription; for the free pilot, set `trial_period_days: 90` on
   `subscription_data` in `createCheckoutSession` (server/src/stripe.js) before
   go-live, then remove it when the first billing cycle starts.
5. Confirm `/api/billing/status` shows `active` after a live test checkout and
   that the webhook deliveries show 200 in the Stripe dashboard.

## Local development

Run with the test key set (never commit it):

```bash
export STRIPE_SECRET_KEY=sk_test_...          # from the owner's .stripe-test-key
export STRIPE_WEBHOOK_SECRET=whsec_...        # from the test webhook endpoint
cd server && npm install && npm start         # API on :4000 (SQLite dev DB)
```

Without the keys the billing routes return `503 Billing is not configured`,
which is the safe behavior for a keyless local environment.
