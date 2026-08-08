# ClearPathFBA MVP

A lightweight React/Vite + Express + SQLite foundation for clinician-facing Functional Behavior Assessments. The first slice provides persistent client profile CRUD.

## Run
Requirements: Node.js 18+ and npm.

```bash
npm install
npm run install:all
npm run dev
```
Open http://localhost:5173. The API runs on http://localhost:4000 and Vite proxies `/api` to it. SQLite data is stored in `server/data/clearpathfba.sqlite` (override with `DATABASE_PATH`).

For production-style checks: `npm run start --prefix server` and `npm run build --prefix client`.

## Layout
- `client/`: Vite React UI
- `server/`: Express REST API, database initialization/migrations, SQLite persistence

## API
`GET/POST /api/clients`, `GET/PUT/DELETE /api/clients/:id`.

The schema includes the next-phase assessment, target behavior, and ABC/data-point tables. Authentication, authorization, audit history, formal report export, BIP/crisis plans, and PostgreSQL deployment remain future phases.

## Security
Security and audit policies, plus a code-grounded encryption-at-rest review, are in [`docs/`](docs/):
- [Security Policy](docs/security-policy.md)
- [Audit Policy](docs/audit-policy.md)
- [Encryption-at-Rest Review](docs/encryption-at-rest-review.md)

## Subscription billing (Stripe, test mode)
Server-side recurring subscription billing (Solo $49 / Practice $39 /
Organization $29 per clinician/month) with Checkout, signed webhooks, and a
`subscriptions` table. Admin-only `/api/billing/*` routes plus
`POST /api/stripe/webhook`. Requires `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` env vars (test keys for now). See
[`docs/billing.md`](docs/billing.md) for the API, env vars, and the live-key
swap procedure at pilot conversion.
