# Darts League Platform

Runs amateur/pub darts leagues: league administration, fixtures, live scoring,
league tables, cups and player statistics. Multiple independent leagues can use one
installation, each with its own rules.

Design and decisions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Getting started

```bash
npm install
npm test          # domain unit tests + database integration tests
npm run typecheck
npm run dev       # http://localhost:3000
```

No database install is needed for development or tests. Without `DATABASE_URL`
the app runs [PGlite](https://pglite.dev) (Postgres compiled to WASM) in-process,
persisted to `.data/pglite`. Tests use a fresh in-memory database each.
Set `DATABASE_URL` to use a real PostgreSQL server (production).

### Demo league

```bash
npm run demo      # seeds .data/demo on first run, then starts the app on it
```

The Manchester Darts League 2026/27: two divisions, a cup, squads, and every
match before today played visit by visit (through the real scoring service),
plus a live match, a postponement and a pending date change. Demo logins are
printed by the seed and saved to `.data/demo-accounts.json`. Re-seed with
`npm run seed:demo`. Your normal dev data in `.data/pglite` is untouched.

### Tests

- `npm test` — domain unit tests, database integration tests, and an end-to-end
  season test (`src/demo/season.e2e.test.ts`) that builds a league from nothing,
  plays four match nights and checks every derived number against the raw data.
- `npm run e2e` — HTTP smoke test against a running server (see docs/DEPLOYMENT.md).
- `npx tsx scripts/pg-wire-check.ts` — the production database path (pg driver,
  SQL migrations) over the Postgres wire protocol, then the smoke test against it.

Deploying: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) (Render blueprint in `render.yaml`).

First run: open http://localhost:3000. With an empty database you are sent to
`/setup` to create the platform administrator, who creates leagues. League and
team admins join through invitation links (People / team pages).

Migrations live in `drizzle/` and are applied automatically on startup.
After changing `src/db/schema.ts`, run `npm run db:generate` and commit the new SQL.

## Layout

| Path | What lives there |
|---|---|
| `src/domain/` | Pure league logic (rules config, scoring engine, statistics, points & standings, fixture state machine, registration & permission policy). No I/O. |
| `src/db/` | Drizzle schema and database client |
| `src/server/` | Services: authorise → validate via domain → write in a transaction → audit |
| `src/app/` | Next.js pages and routes (UI arrives in later phases) |
| `drizzle/` | Generated SQL migrations |

## Status

Phases 1 (foundation, core match services) and 2 (auth, invitations, admin area) are done. See the phase plan in
`docs/ARCHITECTURE.md` §11.
