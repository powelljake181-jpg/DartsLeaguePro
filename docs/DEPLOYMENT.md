# Deploying

The app is one Node server plus one PostgreSQL database (ARCHITECTURE §1). Live
scoring uses Server-Sent Events, which need a long-running server — not
serverless functions — and a single instance (the realtime bus is in-process;
see §5 before running more than one).

## Render (blueprint included)

`render.yaml` describes a **Starter** web service and a **Basic 256 MB** Postgres
database in Frankfurt. Both are paid plans; Render's free web services sleep
after inactivity (spectators would lose live scores) and free databases expire.

1. Put the project in a Git repository on GitHub/GitLab/Bitbucket.
2. In Render: **New → Blueprint**, pick the repository. Render creates the
   database and the web service and wires `DATABASE_URL` between them.
3. Set `SITE_URL` to the public address (e.g. `https://darts-league.onrender.com`).
4. Deploy. Migrations run automatically when the server starts; `/api/health`
   reports when the app can reach the database.
5. Open the site. With an empty database you are sent to `/setup` to create the
   platform administrator, who then creates leagues and invites secretaries.

### Cheaper alternative: PGlite on a persistent disk

For a single small league, the web service can run without a managed database:
leave `DATABASE_URL` unset, attach a Render **disk** (1 GB is plenty) mounted at
`/opt/render/project/src/.data`, and set `PGLITE_DIR=/opt/render/project/src/.data/pglite`.
(In production the app refuses to start with neither `DATABASE_URL` nor
`PGLITE_DIR`, so data can never end up on a temporary disk by accident.) Trade-offs: no managed backups or point-in-time
restore (take your own copies of the disk), and the service can't scale beyond
one instance (it can't anyway while realtime is in-process). Moving to Postgres
later is a dump and restore.

### Optional: the demo league

To show the platform with a season already under way, seed an **empty**
database with the Manchester Darts League 2026/27 demo (from your machine,
using the database's *external* connection string from the Render dashboard):

```bash
DATABASE_URL="postgres://…external…" DEMO_PASSWORD="choose-one" npm run seed:demo
```

The seed refuses to run if a league called `manchester` already exists. Demo
accounts are listed at the end (all `@demo.darts.test`, password `DEMO_PASSWORD`).
Don't seed a database you intend to use for a real league.

### Notifications by email / WhatsApp (later)

In-app notifications need nothing. External channels implement
`NotificationChannel` (`src/server/notification-service.ts`) and are enabled
with `NOTIFY_CHANNELS`. Deliveries are attempted straight after each change;
to retry failures, add a Render cron job every few minutes:

```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$SITE_URL/api/notifications/deliver"
```

## Any other host

Requirements: Node 24, PostgreSQL 14+, a process that stays running.

```bash
npm ci && npm run build
DATABASE_URL=postgres://… SITE_URL=https://… CRON_SECRET=… npm start
```

| Variable | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | yes (or `PGLITE_DIR`) | PostgreSQL connection string |
| `PGLITE_DIR` | only without Postgres | In-process database directory on a persistent disk |
| `SITE_URL` | recommended | Public address for links in external notifications |
| `CRON_SECRET` | if using the delivery endpoint | Bearer token for `POST /api/notifications/deliver` |
| `NOTIFY_CHANNELS` | no | External notification channels, comma-separated |
| `DATABASE_POOL_MAX` | no | Connection pool size (default 10) |

## Checking a build before deploying

```bash
npm test                          # unit, integration and the end-to-end season test
npm run build
npm run demo -- prod              # production build on the local demo data (.data/demo)
npm run e2e                       # HTTP smoke test against http://localhost:3000
npx tsx scripts/pg-wire-check.ts  # the same, but over the Postgres wire protocol (pg driver + SQL migrations)
```
