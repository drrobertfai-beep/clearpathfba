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
