# Darts League Platform — Architecture & Design

Status: Phases 1–8 implemented. This document is the source of truth for
design decisions; update it when a decision changes.

---

## 1. Architecture

**Shape:** one Next.js (App Router, TypeScript) application + one PostgreSQL database.
No Redis, no queue, no separate realtime server. A pub league produces small data
volumes (a large league is ~500k scoring visits per season), so a single Postgres
comfortably handles reads, writes, aggregation and realtime fan-out.

```
src/
  domain/      Pure TypeScript. No I/O, no framework. All league rules live here:
               rules config, scoring engine, statistics, points & standings,
               fixture state machine, scheduling, registration & permission policy.
               Exhaustively unit tested.
  db/          Drizzle schema, migrations, client (pg in production, PGlite locally).
  server/      Services: load data -> authorise -> call domain -> write in a
               transaction -> audit log -> publish realtime event.
  app/         Next.js routes. Public pages are server components; mutations go
               through server actions / route handlers that call services.
```

Rule of thumb: **the domain layer decides, the service layer persists.** Nothing in
`app/` computes points, averages or eligibility.

| Concern | Choice | Why |
|---|---|---|
| Framework | Next.js 16, React 19 | Requested; SSR public pages are fast and SEO-friendly for league sites |
| Database | PostgreSQL | Relational integrity, transactions, `LISTEN/NOTIFY` for realtime |
| ORM | Drizzle | SQL-first, typed, transparent transactions, committed SQL migrations |
| Local DB / tests | PGlite (Postgres compiled to WASM, in-process) | Real Postgres semantics with zero install; each test gets a fresh DB in ms |
| Validation | Zod | Same schemas validate API input and stored rule configs |
| Auth | Small in-house module (`src/server/auth-service.ts`): scrypt passwords, database sessions (random token in an httpOnly SameSite=Lax cookie, only its SHA-256 stored), lockout after 8 failures in 15 min. Accounts are invite-only; the first user is created at `/setup` | Better Auth was planned, but its table conventions clash with our `users` table and invite-only accounts need very little. Roles live in our tables. Server actions also reject cross-site POSTs (Origin check) |
| Caching | Next.js Cache Components **off** | Admin pages are per-user and live. Public pages (Phase 5) are also rendered per request: tables and results change the moment a result is confirmed, and pub-league traffic is small. Revisit only if traffic needs it |
| Realtime | Server-Sent Events + Postgres `LISTEN/NOTIFY` | One-way spectator updates; works through pub Wi-Fi proxies; scales to multiple app instances without Redis |
| Tests | Vitest | Fast; domain tests are pure, service tests run against PGlite |
| Hosting | One Node server (e.g. Render web service) + managed Postgres | SSE needs long-lived connections, so a persistent server rather than short-lived serverless functions |

---

## 2. Entity model

Principles: every row that history references is **never hard-deleted** (status /
`archived_at` instead); everything is scoped to a `league_id`; things that change
between seasons are modelled as *per-season* rows so history is not rewritten.

```
league ──< season ──< competition (LEAGUE per division, or CUP) ──< fixture ──< game ──< leg ──< visit
   │          │              │                                         │          │
   │          │              └──< team_entry (team in competition)     │          └──< game_player (lineup)
   │          └──< blackout_date, scheduling_constraint ──< member     ├──< fixture_outcome (official result)
   ├──< division (persists across seasons)                             └──< fixture_rearrangement
   ├──< venue
   ├──< team (club identity, persists across seasons)
   ├──< player ──< player_registration (player → team for a season)
   ├──< ruleset (immutable versioned config) ──< competition_rule_period (competition × effective date)
   └──< league_membership (user → league role), team_membership (user → team role)
audit_log, notification (+ notification_delivery), fold_event, player_game_stat (derived cache)
```

Key decisions:

- **`competition`** unifies league divisions and cups. A season's Division 1 *is* a
  competition of kind `LEAGUE` with `division_id`. A cup is kind `CUP`. Fixtures,
  rules and statistics filters all hang off competition, so "league only / cup only /
  all" filtering is one column.
- **`team_entry`** (team × competition) replaces a `TeamSeason` table. It holds
  status (`ACTIVE`, `FOLDED`, `WITHDRAWN`), a display-name snapshot and venue for that
  season. Folding is per competition.
- **`player_registration`** (player × team × season) is the history of who played for
  whom. `game_player` references the **registration**, so a player's 2026/27 games
  stay attributed to the team they played for even after a transfer.
- **`ruleset`** holds a versioned JSON config validated by Zod (`src/domain/rules.ts`).
  Rules are a document that is read as a whole and grows new options over time; JSON
  with schema validation avoids a migration per new option while staying type-safe.
  Ruleset rows are immutable versions. A competition's rules are a **timeline** of
  `competition_rule_period` rows (ruleset + effective date); see §7a.
- **Match format = game slots + result groups.** The rules list the games in order,
  each `SINGLES` or `PAIRS` and each feeding a *result group*. Each group has its own
  format (fixed / best-of, draws), points and tie-breakers, and produces its own
  fixture result and its own table. The first group is the primary result. This
  covers "7 singles", "6 singles + 1 pairs all counting", and "1 pairs game into a
  separate pairs table + 7 singles". Singles and pairs have separate game settings
  (e.g. pairs 701 best of 3) and separate per-player limits. `game.kind` and
  `game.group_key` are copied from the rules when a fixture's games are created.
- **`visit`** (one 3-dart turn) is the atomic source of truth for darts statistics.
  Visits are append-only; "undo" sets `voided_at`, admin corrections void and append.
- **`fixture_outcome`** is the official result, one row per result group (games won per side, source
  `PLAYED | AWARDED | ADMIN`). It is written *only* by the finalise function, from the
  games (or from an award), in the same transaction that marks the fixture completed,
  and rewritten by the same function on any correction. Standings never read games
  directly.
- **`player_game_stat`** is a derived cache (one row per player per game) rebuilt
  deterministically from visits whenever a game completes or is corrected. It can
  be dropped and rebuilt from visits at any time (`rebuildGameStats`).

Full column-level schema: `src/db/schema.ts`.

---

## 3. Permission model

Roles are scoped grants, not global flags:

| Role | Stored as | Scope |
|---|---|---|
| Platform admin | `user.is_platform_admin` | everything |
| League admin | `league_membership(role='LEAGUE_ADMIN')` | one league |
| Team admin | `team_membership(role='TEAM_ADMIN')` | one team (all seasons) |
| Public | no session | read-only public pages |

Authorisation is a pure function, `can(actor, action, resource)` in
`src/domain/permissions.ts`. The **resource's league and team are always resolved
from the database**, never taken from request input, so a League A admin who submits
a League B fixture id is rejected because the fixture's league is B.

| Action | Platform | League admin (own league) | Team admin (own team) | Public |
|---|---|---|---|---|
| Create league | ✓ | – | – | – |
| Configure league, rules, seasons, divisions | ✓ | ✓ | – | – |
| Generate / edit fixtures, cups | ✓ | ✓ | – | – |
| Register player | ✓ | ✓ (ignores deadline, audited as override) | ✓ before deadline | – |
| Change player status | ✓ | ✓ | – | – |
| Delete player | – | – (never; archive only) | – | – |
| Select lineup | ✓ | ✓ | ✓ own side of own fixture | – |
| Submit scoring | ✓ | ✓ (audited) | ✓ only if own side is the responsible scorer | – |
| Request rearrangement | ✓ | ✓ | ✓ own fixture | – |
| Respond to rearrangement | ✓ | ✓ (override) | ✓ only as the *other* team | – |
| Correct result / void / fold | ✓ | ✓ (audited) | – | – |
| View anything public | ✓ | ✓ | ✓ | ✓ |

---

## 4. Fixture state machine

```
             request ┌─────────────────────────┐ accept (date changes) / reject / withdraw
          ┌─────────►│ REARRANGEMENT_REQUESTED  ├──────────┐
          │          └─────────────────────────┘          ▼
   ┌──────┴────┐   start (lineups confirmed)   ┌──────┐  finalise (all required   ┌───────────┐
   │ SCHEDULED ├──────────────────────────────►│ LIVE ├──games resolved)─────────►│ COMPLETED │
   └─┬───┬───┬─┘◄──────────── abandon ─────────┴──┬───┘                           └─────┬─────┘
     │   │   │                                    │                                     │ correct (re-finalise)
     │   │   └─ award (fold max-loss / admin) ────┼────────────────────────────────────►│
     │   ▼                                        ▼                                     ▼
     │ POSTPONED ── reschedule ──► SCHEDULED    CANCELLED                              VOID
     └──────────────────────────────────────────► CANCELLED  (VOID / CANCELLED restorable by league admin)
```

Implemented as an explicit transition table (`src/domain/fixture-state.ts`); any
transition not in the table is rejected server-side. `FINALISE` is never automatic:
when every required game is finished the scorer presses **Confirm result** (so a
mis-entered final checkout can still be undone on the night). The standings rule is simply:
**only `COMPLETED` fixtures in `LEAGUE` competitions contribute.** Live fixtures can't
leak into the table because standings never read games, only `fixture_outcome` rows
of completed fixtures, and the outcome is written in the same transaction that sets
`COMPLETED`.

Game states: `PENDING → LIVE → COMPLETED`, `PENDING → WALKOVER`,
`PENDING → NOT_REQUIRED` (best-of format already decided), `* → VOID` (admin).

---

## 5. Live-scoring data flow

```
Scorer phone                         Server                                    Spectators
───────────                          ──────                                    ──────────
tap score ─► local engine validates
            (bust/checkout) and
            updates UI instantly
          ─► outbox (localStorage):
             {clientEventId (uuid),
              legId, seq, score,
              darts, checkout}
          ─► POST /api/scoring/visit ─► authorise (responsible side)
             (retries w/ backoff)       domain engine re-validates against
                                        authoritative leg state
                                        INSERT visit … ON CONFLICT
                                         (client_event_id) DO NOTHING  ◄─ idempotent
                                        unique (leg_id, seq)            ◄─ no forks
                                        if leg/game decided → update rows
                                        NOTIFY fixture_<id>, version ──────► SSE stream
          ◄── ack {seq, version} ──────                                     EventSource
                                                                            re-renders scores
                                                                            and live averages
```

- **Idempotency:** each visit carries a client-generated UUID. A retried request
  after a dropped connection inserts nothing and returns the original ack.
- **Ordering / no conflicting scorers:** the server re-validates every visit against
  the authoritative leg (whose turn, possible score, bust/checkout) and accepts an
  optional `expectedSeq`; a rejected visit is dropped on the phone along with later
  queued visits for that game, and the phone resyncs and asks for them again.
- **Offline:** the scorer keeps scoring against the local engine; the outbox drains
  in order when signal returns. The screen shows "3 visits waiting to sync".
- **Spectators:** SSE sends a fixture `version` with each event. On reconnect the
  client fetches the snapshot if it missed versions, so no events are lost.
- **Undo:** an unsent visit is simply removed from the phone's queue; a sent one is
  undone by its client id (idempotent; only the game's most recent visit). Undoing a
  checkout reopens the leg/game.
- **Realtime fan-out:** an in-process event bus (`src/server/events.ts`) drives the SSE
  stream; swap it for Postgres `LISTEN/NOTIFY` before running more than one instance.
- **Screens:** `/admin/[league]/fixtures/[id]` (lineups, start), `/score/[id]` (phone
  scoring, client-only), `/fixtures/[id]` (public live page).

---

## 6. Statistics & 3-dart averages

Source of truth: `visit` rows (`score`, `darts`, `is_bust`, `is_checkout`, thrower).

- Per leg, per player: `points = Σ score of non-bust visits`, `darts = Σ darts`.
  Bust visits count their darts and score 0 points. A checkout visit counts only
  the darts actually used (1–3).
- **Every average at every level = 3 × Σpoints ÷ Σdarts** over the visits in scope.
  Never a mean of averages. `aggregate()` in `src/domain/stats.ts` sums *raw totals*
  and derives ratios last.
- Losing players: their points are what they actually scored (e.g. 461 of 501), never
  assumed.
- Bands (default, configurable per ruleset, non-overlapping by default):
  `180` = exactly 180, `140+` = 140–179, `100+` = 100–139. A 180 is counted once.
- Highest checkout = max score of a checkout visit. Least darts = fewest darts in a
  **won leg** (for single-leg games this equals darts to win the game).
- **Pairs:** every visit is attributed to the partner who threw it (partners must
  alternate), so each player's average uses only their own darts. A leg/game is won
  by the *side*, so both partners get the win; the checkout belongs to whoever hit
  it; least darts counts the pair's combined darts. Singles and pairs records are
  stored with their game kind and can be shown separately or together.
- Walkovers have no visits, so they cannot affect any darts statistic. Whether a
  walkover gives a player a W/L record is a separate ruleset option.
- Scope filters (fixture, season, competition kind, division, team, career) are
  just `WHERE` clauses over `player_game_stat` rows, then `aggregate()`.
- Corrections void/append visits → the game's `player_game_stat` rows are rebuilt in
  the same transaction → every rollup is automatically correct.
- Leaderboards apply `stats.leaderboardMinGames`; profiles show everything.

---

## 7. League table

`computeStandings(entries, results, tieBreakers)` — one table per result group — a pure function of:
1. team entries in the competition,
2. that group's `fixture_outcome` rows of `COMPLETED` fixtures, each carrying the
   points system **in force on that fixture's date**,
3. the tie-breakers currently in force.

Points per fixture = match points (win/draw/loss) + `perGameWon × gamesWon` (both
teams receive game points, so a 4–3 defeat earns 3). Tie-breakers are an ordered,
configurable list: `POINTS, GAME_DIFFERENCE, GAMES_WON, MATCHES_WON, HEAD_TO_HEAD,
LEG_DIFFERENCE`. Head-to-head is computed as a mini-table *among only the tied teams*,
then later tie-breakers apply. Because the table is always recomputed from results,
voiding, correcting, folding or changing rules can never leave stale numbers.

---

## 7a. Changing rules (dated, possibly retrospective)

Every rule change requires an **effective date** (no default) and a reason. The
new rules govern fixtures dated from then until the next existing change (or the end
of the season); earlier fixtures keep the rules they were played under. A date before
the season's first rules period means "from the start".

- **Re-scoring changes** (points, tie-breakers, walkover treatment, stat bands) may
  be backdated freely: completed fixtures in range are re-finalised and their stats
  rebuilt in one transaction, so the table and averages update immediately.
- **Format changes** (games, singles/pairs, which result a game counts towards, legs,
  starting score, best-of/fixed) cannot cover fixtures already played, because the
  recorded games would not fit. The change is refused with the list of blocking
  fixtures and the earliest date that would work. Unstarted fixtures that already
  had lineups have their games cleared and lineups must be re-entered (listed).
- **Preview first:** the change is applied in a transaction that is rolled back,
  returning the before/after tables, fixtures recalculated, blocking fixtures and
  lineups to re-enter. The admin confirms, then it is applied for real and audit
  logged.

---

## 8. Fixture-generation algorithm

1. **Calendar:** for each division, list candidate dates: every match-night weekday
   from the start date, minus season blackouts, cup dates and division-specific
   exclusions, minus requested free weeks.
2. **Rounds:** circle method (Berger tables) per division → `n−1` rounds (a dummy
   "bye" team is added for odd `n`). Home/away alternates per slot so no team has
   long home or away runs. For `k` meetings, repeat with home/away mirrored each
   time.
3. **Assign rounds to dates** in order (round *r* → *r*-th available date).
4. **Shared-venue constraints across divisions:** each slot in a Berger table has a
   fixed home/away pattern, so the problem reduces to choosing *which team occupies
   which slot* in each division so constrained teams have compatible patterns on
   dates they share. A seeded local search swaps slot assignments (and, as a second
   move, round order per meeting; third, mirroring a division) to minimise "too many
   home teams at venue V on date D" violations, then, as a secondary goal, runs of
   three or more home or away games in a row. It is deterministic for a given seed.
5. **Result:** a *draft* (nothing is written) with a conflict list. Zero conflicts →
   the admin can publish. Remaining conflicts are shown explicitly (date, venue,
   teams); the generator never silently publishes an invalid schedule.

---

## 9. Folded teams

A fold is a recorded `fold_event` on a `team_entry`, with a chosen treatment:

- **Results:** `VOID_ALL` (every fixture involving the team becomes `VOID`, completed
  ones included), `MAX_LOSS_REMAINING` (unplayed fixtures are awarded as a maximum
  loss, e.g. 0–7), or `MAX_LOSS_ALL`.
- **Player stats:** `KEEP` or `EXCLUDE` individual statistics from played fixtures the fold voids or replaces with an award.

Applying a fold runs in one transaction: change fixture statuses / write `AWARDED`
outcomes, store the previous state in the fold event (so it can be reversed), audit
log. **Nothing is subtracted from the table.** The table is recomputed from results,
so it is correct by construction. The admin sees a preview ("these 9 fixtures will be
voided, the table will change like this") before confirming.

---

## 10. Edge cases (and default decisions)

Decisions marked ⚑ have architectural impact and are flagged for confirmation.

1. ⚑ **Scoring granularity:** visit-level (score of each 3-dart visit, plus darts used
   on checkout/bust), not per-dart. This is enough for every requested stat and is
   much faster to enter on a phone. Per-dart (doubles hit %, etc.) would need a
   different input UI and table.
2. ✔ **Pairs games (confirmed):** configurable per league as game slots feeding
   result groups (§2): pairs in their own table, or combined with singles in one
   result. Statistics per thrower; singles/pairs records kept separately.
3. ✔ **Rules mid-season (confirmed):** every change takes an effective date, which
   may be retrospective (§7a).
4. **Best-of format dead rubbers:** once a best-of-7 is decided (4 games), remaining
   games are `NOT_REQUIRED` by default; option to play them for stats only.
5. **Short-handed teams:** an empty lineup slot becomes a walkover to the opponent.
   Options `maxSinglesPerPlayer` / `maxPairsPerPlayer` (default 1 each) for leagues
   that allow playing more. A pair with only one player available is a walkover.
6. **One active registration per player per league-season** by default; a transfer
   ends the old registration and starts a new one (history kept).
7. **Odd team counts** → byes. A fold mid-season creates byes for opponents.
8. **Abandoned fixtures** (pub closes mid-match): admin chooses replay (games reset,
   visits kept for audit but excluded), award, or accept partial result.
9. **Scorer unavailable:** league admin can temporarily delegate scoring authority
   to the other team for one fixture (audited).
10. **Invalid scores:** reject > 180, impossible visit totals (179, 178, 176, 175, 173,
    172, 169, 166, 163), checkouts > 170 or the bogey checkouts (169, 168, 166, 165,
    163, 162, 159) under double-out, finishing on 1, or visits that would leave 1.
11. **Timezones:** all timestamps `timestamptz`; deadlines and match nights are
    interpreted in the league's timezone (default Europe/London, DST-safe).
12. **Rearrangements:** only one pending request per fixture; proposed date warned if
    it clashes with a team's other fixture, a venue constraint or a blackout date;
    requests auto-expire if the original date passes.
13. **Team renames between seasons:** `team_entry.display_name` snapshots the name
    used that season, so old tables show the old name.
14. **GDPR erasure vs history:** players are anonymised ("Player #123"), never deleted.
15. **Duplicate player identities** (same person entered twice): a later admin "merge
    players" tool; the registration model makes this safe.
16. **Cup draws:** a cup match cannot end as a draw; the cup's ruleset must use an odd
    game count or a decider game. Byes fill to the next power of two.

---

## 10a. Public site (Phase 5)

Routes under `/leagues/[league]`: overview, `tables`, `divisions/[competitionId]`, `fixtures`, `results`,
`teams`, `teams/[team]` (team slug), `players/[playerId]`, `leaderboards`; matches link to `/fixtures/[id]`
(live page). Read models live in `src/server/public-service.ts`; ranking rules in `src/domain/leaderboards.ts`.

- **Season shown:** `?season=` if given, else the ACTIVE season, else the latest. A DRAFT season is public as
  soon as its fixtures are published (fixtures only exist after publishing), so admins need not remember to
  flip the status. Archived leagues are hidden.
- **Venue shown:** the fixture's own venue if set, else the home entry's venue that season, else the team's home venue.
- **Leaderboards:** average and win % require the strictest `leaderboardMinGames` in force across the
  competitions in scope; counts/records include everyone. Ties share a position; a top-10 cut never splits a tie.
  Band columns everywhere come from the rules' configured bands, not hard-coded 180/140/100.
- Bad ids in URLs (non-UUID, other league's ids) are 404s, never database errors.

## 10b. Rearrangements, notifications, folds, corrections (Phase 6)

- **Rearrangements** (`rearrangement-service.ts`, `domain/rearrangements.ts`): one pending request per fixture. The request
  stores the fixture's previous status, so a declined/withdrawn/lapsed request on a POSTPONED fixture leaves it postponed.
  Clashes (either team's other fixture that night, blackout dates, shared-venue limits) are warnings shown to both teams and
  recomputed whenever the request is viewed — never refusals. Requests lapse once the original or proposed time passes; this
  runs lazily before any rearrangement action and when requests are listed, so no scheduler is needed. A league admin may
  answer for the other team (audited as on-behalf); any direct admin change closes a pending request as OVERRIDDEN.
- **Moving a fixture** (`fixture-ops.ts`): if the new date falls under rules with a different match format, unstarted
  lineups are cleared (captains re-pick); a started match cannot move into a different format.
- **Admin fixture changes** (`fixture-admin-service.ts`): every one needs a reason, is audited and notifies both teams.
  *Abandon* keeps finished games and postpones; once rescheduled and restarted, play resumes where it stopped (replay from
  scratch = void + new fixture). *Restore* returns a void/cancelled fixture to COMPLETED if it has a result, POSTPONED if play
  had started, else SCHEDULED. Fixtures changed by a fold can only be changed back by reversing the fold.
- **Folds** (`fold-service.ts`, `domain/folds.ts`): previewed in a rolled-back transaction (exact changes + table before/after).
  Player-stats KEEP/EXCLUDE applies to every *played* match the fold changes: voided ones, and played ones whose result is
  replaced by a maximum-score award (MAX_LOSS_ALL; flagged `fixtures.stats_excluded`, which every stats query honours).
  Played results that stand always keep their statistics. The fold stores
  each changed fixture's previous state and post-fold version; reversing is refused if any of them changed since.
- **Notifications** (`notification-service.ts`, `domain/notifications.ts`): rows store type + payload; wording is rendered at
  read time so every channel says the same thing. Recipients are resolved from current memberships; the actor is never
  notified of their own action. External channels (`NOTIFY_CHANNELS`, built-in `console`) get delivery rows queued in the same
  transaction (outbox); sending happens after commit, retried up to 5 times, plus `POST /api/notifications/deliver`
  (Bearer `CRON_SECRET`) for a cron job. Adding email/WhatsApp = implement `NotificationChannel` and register it.

## 10c. Cups (Phase 7)

- A cup is a `competition` of kind CUP: team entries, one `cup_round` per bracket round (a dated cup night with a kick-off
  time), and fixtures placed by `(round, bracket_slot)`. Bracket size is the next power of two; round r tie i is fed by
  round r-1 ties 2i and 2i+1 (the upper tie's winner at home). Rounds follow the entrant count until the draw, keeping dates
  by distance from the final.
- **Draw** (`domain/cups.ts`): entrants are placed in standard seeding order (1 v 16, 8 v 9…), so byes fall to the top seeds
  and never meet. Random = shuffle into seed order; seeded = explicit seeds then the rest at random, home side drawn;
  manual = ties entered by hand and validated. Random/seeded draws are deterministic for a seed: the preview returns its seed
  and the confirm reuses it, so the saved draw is the one shown. A bye is a fixture with no away team, COMPLETED at the draw.
  The draw can be remade until any tie has lineups, a request, or a result.
- **Advancing** (`advanceCup`, called from `afterResultChange` wherever a result can change: finalise/correct, void,
  admin changes, folds): a tie is created once both feeders are decided and its round has a date; an unstarted tie whose
  feeder result changed is re-pointed (lineups cleared); an unstarted tie whose feeder is no longer decided is removed. Ties
  already under way are never touched; conflicts are audit-logged. A tie involving a withdrawn team is awarded at once.
  Winner = the first result group's winner (cups can't draw); a bye's winner is its home team.
- **Withdrawal** from a cup uses the fold tools but always awards remaining ties (results already won stand).
- **Calendar:** cup round dates are excluded dates for the league fixture generator and appear as blackout warnings in
  rearrangement requests; dating a round warns about league fixtures already that night and moves unplayed ties.

## 11. Phased implementation plan

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation: project, full DB schema + migrations, DB client (pg/PGlite), rules config, domain engines (scoring, statistics/averages, match result, points, standings incl. head-to-head, fixture state machine, registration and permission policy). Core services: player registration (server-side deadline), lineups, walkovers, idempotent visit scoring, atomic fixture completion, leg corrections, voids, stats rebuild, standings, audit log. 76 tests | **done** |
| 2 | Auth, invitations (shareable links, WhatsApp-friendly), admin UI: setup, leagues, seasons (deadline, squad size), divisions, venues, teams, division set-up from format templates, rules editor with dated preview/apply, squads and player registration, player status, people, activity log. Browser-tested end to end | **done** |
| 3 | Fixture generator (circle method + seeded search across divisions): blackout/cup/break dates, shared-venue constraints with suggestions from home venues, no 3-in-a-row home/away runs, preview, "try another arrangement", publish (refuses played fixtures; clashes need explicit acknowledgement, audited), admin fixture list. Browser-tested | **done** |
| 4 | Lineup picking (singles/pairs, eligibility, walkovers), start match, phone scoring with offline queue + idempotent JSON API, undo, bull-up, multi-leg games, best-of skipping, explicit result confirmation, SSE live updates, public live match page with live stats. Browser-tested incl. offline/reload | **done** |
| 5 | Public site (no login): league overview (live now, every division's table, coming up, latest results), tables, division pages (all result-group tables + fixtures/results), fixtures and results filterable by division, teams, team pages (position, squad stats, results/fixtures), player profiles (career tiles, per-season singles/pairs split, game log), leaderboards (average/win % with min-games, score bands, high checkout, best leg; by competition and singles/pairs). `?season=` on every page. 13 more tests | **done** |
| 6 | Rearrangements (request / accept / decline / withdraw, lapse when unanswered, clash warnings, league-admin override), notifications (in-app inbox + bell, outbox for external channels with retries, cron endpoint), league-admin fixture changes (move, postpone, cancel, void, restore, award, abandon-and-resume), score corrections UI (leg editor), folded teams (preview, apply, exact reverse). 29 more tests | **done** |
| 7 | Cups: create with entrants (any teams), format must produce a winner (also enforced on rule changes), cup nights per round (excluded from league fixture generation, flagged in date-change requests, warn about league fixtures already that night), random / seeded / manual draw with preview = saved draw, byes to top seeds and never two byes together, fixed bracket that advances on every result change (incl. corrections, voids, restores, awards), withdrawals award remaining ties, public bracket + overview card. 21 more tests | **done** |
| 8 | Demo seed (Manchester Darts League 2026/27, built through the services, matches simulated visit by visit with a tested darts simulator), end-to-end season test, HTTP smoke test, Postgres wire-protocol check of the production driver path, health endpoint, Render blueprint + deployment guide | **done** |
