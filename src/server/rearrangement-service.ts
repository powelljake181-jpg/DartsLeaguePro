import { and, desc, eq, gte, inArray, isNull, lte, ne, notInArray, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  blackoutDates,
  competitions,
  fixtureRearrangements,
  fixtures,
  schedulingConstraintTeams,
  schedulingConstraints,
  teamEntries,
  teams,
  users,
} from "@/db/schema";
import { endOfDayInZone, localDateInZone, zonedTimeToUtc } from "@/domain/dates";
import { transition } from "@/domain/fixture-state";
import { assertCan, type Actor } from "@/domain/permissions";
import { hasExpired, proposalWarnings, type RearrangementWarning } from "@/domain/rearrangements";
import type { Side } from "@/domain/scoring";
import { audit, loadFixtureContext, type FixtureContext } from "./context";
import { seasonCupNights } from "./cup-service";
import { AppError, notFound } from "./errors";
import { fixtureInfo, moveFixtureDate } from "./fixture-ops";
import { bumpVersion } from "./match-service";
import { notify } from "./notification-service";

/**
 * Rearrangements (ARCHITECTURE §10.12): a team asks to move a fixture, the
 * other team accepts or rejects, the requester can withdraw, and an unanswered
 * request lapses once the original or proposed time passes. League admins can
 * act for either team. One pending request per fixture (enforced by a unique
 * index). Clashes are warnings, never refusals.
 */

type Row = typeof fixtureRearrangements.$inferSelect;

const otherTeam = (ctx: FixtureContext, teamId: string) => (teamId === ctx.homeTeamId ? ctx.awayTeamId : ctx.homeTeamId);

/** What a proposed time would clash with. */
export async function proposalCheck(db: Db, ctx: FixtureContext, at: Date, tz: string): Promise<RearrangementWarning[]> {
  const date = localDateInZone(at, tz);
  const seasonId = ctx.competition.seasonId;
  const comps = await db.select({ id: competitions.id }).from(competitions).where(eq(competitions.seasonId, seasonId));
  const from = zonedTimeToUtc(date, "00:00", tz);
  const to = endOfDayInZone(date, tz);
  const sameNight = await db
    .select()
    .from(fixtures)
    .where(
      and(
        inArray(fixtures.competitionId, comps.map((c) => c.id)),
        gte(fixtures.scheduledAt, from),
        lte(fixtures.scheduledAt, to),
        ne(fixtures.id, ctx.fixture.id),
        notInArray(fixtures.status, ["VOID", "CANCELLED"]),
      ),
    );
  const entryIds = [...new Set(sameNight.flatMap((f) => (f.awayEntryId ? [f.homeEntryId, f.awayEntryId] : [f.homeEntryId])))];
  const entries = entryIds.length ? await db.select().from(teamEntries).where(inArray(teamEntries.id, entryIds)) : [];
  const entry = new Map(entries.map((e) => [e.id, e]));
  const names = (await fixtureInfo(db, ctx));

  const teamClashes = [];
  for (const [teamId, teamName] of [
    [ctx.homeTeamId, names.home],
    [ctx.awayTeamId, names.away],
  ] as const) {
    for (const f of sameNight) {
      const home = entry.get(f.homeEntryId);
      const away = f.awayEntryId ? entry.get(f.awayEntryId) : undefined;
      if (home?.teamId === teamId) teamClashes.push({ teamName, opponentName: away?.displayName ?? "a bye" });
      else if (away?.teamId === teamId) teamClashes.push({ teamName, opponentName: home?.displayName ?? "" });
    }
  }

  const blackouts = await db
    .select({ reason: blackoutDates.reason })
    .from(blackoutDates)
    .where(and(eq(blackoutDates.seasonId, seasonId), eq(blackoutDates.date, date), or(isNull(blackoutDates.competitionId), eq(blackoutDates.competitionId, ctx.competition.id))));

  // Cup nights (of other competitions) are as good as blackout dates for league and cup fixtures alike.
  for (const n of await seasonCupNights(db, seasonId)) {
    if (n.round.scheduledOn === date && n.competition.id !== ctx.competition.id) blackouts.push({ reason: `${n.competition.name} ${n.round.name.toLowerCase()}` });
  }

  const limits = await db
    .select({ c: schedulingConstraints })
    .from(schedulingConstraints)
    .innerJoin(schedulingConstraintTeams, eq(schedulingConstraintTeams.constraintId, schedulingConstraints.id))
    .where(and(eq(schedulingConstraints.seasonId, seasonId), eq(schedulingConstraintTeams.teamId, ctx.homeTeamId)));
  const venueLimits = [];
  for (const { c } of limits) {
    const members = (await db.select().from(schedulingConstraintTeams).where(eq(schedulingConstraintTeams.constraintId, c.id))).map((m) => m.teamId);
    const homeAlready = sameNight.filter((f) => members.includes(entry.get(f.homeEntryId)?.teamId ?? "")).length;
    venueLimits.push({ name: c.name, maxHomePerDate: c.maxHomePerDate, homeAlready });
  }
  return proposalWarnings({ proposedDate: date, teamClashes, blackouts, venueLimits });
}

export interface RequestInput {
  fixtureId: string;
  /** The side asking for the change. */
  side: Side;
  proposedAt: Date;
  note?: string;
}

export async function requestRearrangement(db: Db, actor: Actor, input: RequestInput, now = new Date()): Promise<{ id: string; warnings: RearrangementWarning[] }> {
  await expireRearrangements(db, { fixtureId: input.fixtureId }, now);
  return db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, input.fixtureId, { lock: true });
    if (!ctx.fixture.awayEntryId) throw new AppError("BYE", "a bye has no opponent to rearrange with");
    const teamId = input.side === "HOME" ? ctx.homeTeamId : ctx.awayTeamId;
    assertCan(actor, { action: "rearrangement.request", leagueId: ctx.fixture.leagueId, teamId, fixture: { homeTeamId: ctx.homeTeamId, awayTeamId: ctx.awayTeamId } });
    if (ctx.fixture.status === "REARRANGEMENT_REQUESTED") throw new AppError("REARRANGEMENT_PENDING", "there is already a request waiting for an answer");
    const status = transition(ctx.fixture.status, "REQUEST_REARRANGEMENT");
    if (ctx.fixture.status === "SCHEDULED" && ctx.fixture.scheduledAt <= now) {
      throw new AppError("FIXTURE_DATE_PASSED", "this fixture's date has passed; ask the league admin to reschedule it");
    }
    if (input.proposedAt <= now) throw new AppError("PROPOSED_IN_PAST", "choose a date and time in the future");
    if (input.proposedAt.getTime() === ctx.fixture.scheduledAt.getTime()) throw new AppError("SAME_TIME", "that's the fixture's current date and time");
    const note = input.note?.trim().slice(0, 500) || null;

    const info = await fixtureInfo(tx, ctx);
    const warnings = await proposalCheck(tx, ctx, input.proposedAt, info.tz);
    const [row] = await tx
      .insert(fixtureRearrangements)
      .values({
        fixtureId: ctx.fixture.id,
        requestedByTeamId: teamId,
        requestedBy: actor.userId,
        originalAt: ctx.fixture.scheduledAt,
        previousStatus: ctx.fixture.status,
        proposedAt: input.proposedAt,
        note,
      })
      .returning();
    await bumpVersion(tx, ctx.fixture.id, { status });
    await audit(tx, {
      leagueId: ctx.fixture.leagueId,
      actor,
      action: "rearrangement.requested",
      entityType: "fixture",
      entityId: ctx.fixture.id,
      before: { scheduledAt: ctx.fixture.scheduledAt, status: ctx.fixture.status },
      after: { proposedAt: input.proposedAt, warnings: warnings.map((w) => w.message) },
      reason: note ?? undefined,
    });
    await notify(tx, {
      leagueId: info.leagueId,
      actor,
      to: { leagueAdmins: true, teamIds: [otherTeam(ctx, teamId)] },
      event: {
        type: "rearrangement.requested",
        payload: {
          ...info,
          requestedBy: teamId === ctx.homeTeamId ? info.home : info.away,
          originalAt: ctx.fixture.scheduledAt.toISOString(),
          proposedAt: input.proposedAt.toISOString(),
          note,
          warnings: warnings.map((w) => w.message),
        },
      },
    });
    return { id: row.id, warnings };
  });
}

async function loadPending(db: Db, rearrangementId: string): Promise<Row> {
  const [row] = await db.select().from(fixtureRearrangements).where(eq(fixtureRearrangements.id, rearrangementId));
  if (!row) throw notFound("rearrangement");
  if (row.status !== "PENDING") throw new AppError("REARRANGEMENT_CLOSED", `this request has already been ${row.status.toLowerCase()}`, 409);
  return row;
}

/** The other team (or a league admin) accepts or rejects a pending request. */
export async function respondToRearrangement(
  db: Db,
  actor: Actor,
  input: { rearrangementId: string; accept: boolean; note?: string },
  now = new Date(),
): Promise<{ lineupsReset: boolean }> {
  const [first] = await db.select().from(fixtureRearrangements).where(eq(fixtureRearrangements.id, input.rearrangementId));
  if (!first) throw notFound("rearrangement");
  await expireRearrangements(db, { fixtureId: first.fixtureId }, now);
  return db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, first.fixtureId, { lock: true });
    const row = await loadPending(tx, input.rearrangementId);
    const respondingTeamId = otherTeam(ctx, row.requestedByTeamId);
    assertCan(actor, {
      action: "rearrangement.respond",
      leagueId: ctx.fixture.leagueId,
      teamId: respondingTeamId,
      fixture: { homeTeamId: ctx.homeTeamId, awayTeamId: ctx.awayTeamId },
      requestedByTeamId: row.requestedByTeamId,
    });
    const asTeam = actor.teamAdminOf.has(respondingTeamId);
    const note = input.note?.trim().slice(0, 500) || null;
    let lineupsReset = false;
    let status = transition(ctx.fixture.status, "RESOLVE_REARRANGEMENT", { restoreTo: row.previousStatus });
    if (input.accept) {
      ({ lineupsReset } = await moveFixtureDate(tx, ctx, row.proposedAt));
      status = transition(ctx.fixture.status, "RESOLVE_REARRANGEMENT", { restoreTo: "SCHEDULED" });
    }
    await tx
      .update(fixtureRearrangements)
      .set({ status: input.accept ? "ACCEPTED" : "REJECTED", respondedBy: actor.userId, respondedAt: now, responseNote: note })
      .where(eq(fixtureRearrangements.id, row.id));
    await bumpVersion(tx, ctx.fixture.id, { status });

    const info = await fixtureInfo(tx, ctx);
    const by = asTeam ? (respondingTeamId === ctx.homeTeamId ? info.home : info.away) : "The league";
    await audit(tx, {
      leagueId: ctx.fixture.leagueId,
      actor,
      action: input.accept ? "rearrangement.accepted" : "rearrangement.rejected",
      entityType: "fixture",
      entityId: ctx.fixture.id,
      before: { scheduledAt: ctx.fixture.scheduledAt, status: ctx.fixture.status },
      after: { scheduledAt: input.accept ? row.proposedAt : ctx.fixture.scheduledAt, status, onBehalfOfTeam: !asTeam, lineupsReset },
      reason: note ?? undefined,
    });
    await notify(tx, {
      leagueId: info.leagueId,
      actor,
      to: { leagueAdmins: true, teamIds: [ctx.homeTeamId, ctx.awayTeamId] },
      event: input.accept
        ? { type: "rearrangement.accepted", payload: { ...info, proposedAt: row.proposedAt.toISOString(), by } }
        : { type: "rearrangement.rejected", payload: { ...info, proposedAt: row.proposedAt.toISOString(), by, note } },
    });
    return { lineupsReset };
  });
}

/** The requesting team (or a league admin) withdraws a pending request. */
export async function withdrawRearrangement(db: Db, actor: Actor, input: { rearrangementId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [first] = await tx.select().from(fixtureRearrangements).where(eq(fixtureRearrangements.id, input.rearrangementId));
    if (!first) throw notFound("rearrangement");
    const ctx = await loadFixtureContext(tx, first.fixtureId, { lock: true });
    const row = await loadPending(tx, input.rearrangementId);
    assertCan(actor, {
      action: "rearrangement.request",
      leagueId: ctx.fixture.leagueId,
      teamId: row.requestedByTeamId,
      fixture: { homeTeamId: ctx.homeTeamId, awayTeamId: ctx.awayTeamId },
    });
    const status = transition(ctx.fixture.status, "RESOLVE_REARRANGEMENT", { restoreTo: row.previousStatus });
    await tx.update(fixtureRearrangements).set({ status: "WITHDRAWN", respondedBy: actor.userId, respondedAt: new Date() }).where(eq(fixtureRearrangements.id, row.id));
    await bumpVersion(tx, ctx.fixture.id, { status });
    const info = await fixtureInfo(tx, ctx);
    await audit(tx, { leagueId: ctx.fixture.leagueId, actor, action: "rearrangement.withdrawn", entityType: "fixture", entityId: ctx.fixture.id, after: { status } });
    await notify(tx, {
      leagueId: info.leagueId,
      actor,
      to: { leagueAdmins: true, teamIds: [ctx.homeTeamId, ctx.awayTeamId] },
      event: { type: "rearrangement.withdrawn", payload: { ...info, proposedAt: row.proposedAt.toISOString(), by: row.requestedByTeamId === ctx.homeTeamId ? info.home : info.away } },
    });
  });
}

/**
 * Close a pending request because a league admin changed the fixture directly
 * (rescheduled, postponed, cancelled, voided, awarded, folded). Call inside the
 * admin action's transaction; the caller sets the fixture's new status.
 */
export async function overridePendingRearrangement(db: Db, actor: Actor | null, fixtureId: string, note: string): Promise<boolean> {
  const rows = await db
    .update(fixtureRearrangements)
    .set({ status: "OVERRIDDEN", respondedBy: actor?.userId ?? null, respondedAt: new Date(), responseNote: note })
    .where(and(eq(fixtureRearrangements.fixtureId, fixtureId), eq(fixtureRearrangements.status, "PENDING")))
    .returning();
  return rows.length > 0;
}

/**
 * Lapse pending requests whose original or proposed time has passed. Run
 * before any rearrangement action and when listing requests, so no scheduler
 * is needed.
 */
export async function expireRearrangements(db: Db, scope: { leagueId?: string; fixtureId?: string }, now = new Date()): Promise<number> {
  const where = [eq(fixtureRearrangements.status, "PENDING")];
  if (scope.fixtureId) where.push(eq(fixtureRearrangements.fixtureId, scope.fixtureId));
  if (scope.leagueId) where.push(eq(fixtures.leagueId, scope.leagueId));
  const pending = await db
    .select({ r: fixtureRearrangements })
    .from(fixtureRearrangements)
    .innerJoin(fixtures, eq(fixtures.id, fixtureRearrangements.fixtureId))
    .where(and(...where));
  let n = 0;
  for (const { r } of pending.filter(({ r }) => hasExpired(r, now))) {
    await db.transaction(async (tx) => {
      const ctx = await loadFixtureContext(tx, r.fixtureId, { lock: true });
      const [still] = await tx.select().from(fixtureRearrangements).where(eq(fixtureRearrangements.id, r.id));
      if (still?.status !== "PENDING") return;
      await tx.update(fixtureRearrangements).set({ status: "EXPIRED", respondedAt: now }).where(eq(fixtureRearrangements.id, r.id));
      if (ctx.fixture.status === "REARRANGEMENT_REQUESTED") {
        await bumpVersion(tx, ctx.fixture.id, { status: transition(ctx.fixture.status, "RESOLVE_REARRANGEMENT", { restoreTo: r.previousStatus }) });
      }
      const info = await fixtureInfo(tx, ctx);
      await audit(tx, { leagueId: ctx.fixture.leagueId, actor: null, action: "rearrangement.expired", entityType: "fixture", entityId: ctx.fixture.id, after: { proposedAt: r.proposedAt } });
      await notify(tx, {
        leagueId: info.leagueId,
        to: { leagueAdmins: true, teamIds: [ctx.homeTeamId, ctx.awayTeamId] },
        event: { type: "rearrangement.expired", payload: { ...info, proposedAt: r.proposedAt.toISOString() } },
      });
      n++;
    });
  }
  return n;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** A fixture's pending request (with live clash warnings) and its recent history. */
export async function fixtureRearrangementState(db: Db, fixtureId: string, now = new Date()) {
  await expireRearrangements(db, { fixtureId }, now);
  const ctx = await loadFixtureContext(db, fixtureId);
  const rows = await db
    .select({ r: fixtureRearrangements, team: teams.name, by: users.name })
    .from(fixtureRearrangements)
    .innerJoin(teams, eq(teams.id, fixtureRearrangements.requestedByTeamId))
    .innerJoin(users, eq(users.id, fixtureRearrangements.requestedBy))
    .where(eq(fixtureRearrangements.fixtureId, fixtureId))
    .orderBy(desc(fixtureRearrangements.createdAt))
    .limit(10);
  const pendingRow = rows.find((x) => x.r.status === "PENDING") ?? null;
  const tz = (await fixtureInfo(db, ctx)).tz;
  const pending = pendingRow
    ? {
        ...pendingRow,
        requestingSide: (pendingRow.r.requestedByTeamId === ctx.homeTeamId ? "HOME" : "AWAY") as Side,
        warnings: await proposalCheck(db, ctx, pendingRow.r.proposedAt, tz),
      }
    : null;
  return { pending, history: rows.filter((x) => x.r.status !== "PENDING") };
}

/** Every pending request in a league, soonest original date first. */
export async function pendingRearrangements(db: Db, leagueId: string, now = new Date()) {
  await expireRearrangements(db, { leagueId }, now);
  const rows = await db
    .select({ r: fixtureRearrangements, fixture: fixtures, team: teams.name })
    .from(fixtureRearrangements)
    .innerJoin(fixtures, eq(fixtures.id, fixtureRearrangements.fixtureId))
    .innerJoin(teams, eq(teams.id, fixtureRearrangements.requestedByTeamId))
    .where(and(eq(fixtures.leagueId, leagueId), eq(fixtureRearrangements.status, "PENDING")))
    .orderBy(fixtureRearrangements.originalAt);
  const entryIds = [...new Set(rows.flatMap((x) => (x.fixture.awayEntryId ? [x.fixture.homeEntryId, x.fixture.awayEntryId] : [x.fixture.homeEntryId])))];
  const entries = entryIds.length ? await db.select().from(teamEntries).where(inArray(teamEntries.id, entryIds)) : [];
  const name = (id: string | null) => entries.find((e) => e.id === id)?.displayName ?? "Bye";
  return rows.map((x) => ({ ...x, home: name(x.fixture.homeEntryId), away: name(x.fixture.awayEntryId) }));
}
