import { and, asc, eq, inArray, isNull, max, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "@/db/client";
import {
  fixtureOutcomes,
  fixtures,
  gamePlayers,
  games,
  legs,
  playerRegistrations,
  players,
  visits,
} from "@/db/schema";
import { fixtureOutcomes as computeOutcomes, fixtureProgress, type FixtureOutcome, type GameSummary } from "@/domain/match";
import { assertCan, type Actor } from "@/domain/permissions";
import { validateLineup, type EligibleRegistration, type LineupSlot } from "@/domain/registration";
import { gameConfigFor, type GameKind } from "@/domain/rules";
import {
  applyVisit,
  gameProgress,
  initialLegState,
  replayLeg,
  resolveVisit,
  startingSideForLeg,
  type LegConfig,
  type Side,
  type VisitInput,
} from "@/domain/scoring";
import { transition } from "@/domain/fixture-state";
import { audit, loadFixtureContext, type FixtureContext } from "./context";
import { AppError, conflict, notFound } from "./errors";
import { afterResultChange } from "./cup-service";
import { fixtureInfo } from "./fixture-ops";
import { notify } from "./notification-service";
import { overridePendingRearrangement } from "./rearrangement-service";
import { loadLegRecords, rebuildGameStats, toVisit } from "./stats-service";

const legConfig = (ctx: FixtureContext, kind: GameKind, startingSide: Side): LegConfig => ({
  startingScore: gameConfigFor(ctx.rules, kind).startingScore,
  doubleOut: gameConfigFor(ctx.rules, kind).doubleOut,
  startingSide,
  alternatePartners: kind === "PAIRS",
});

export async function bumpVersion(db: Db, fixtureId: string, patch: Partial<typeof fixtures.$inferInsert> = {}) {
  await db
    .update(fixtures)
    .set({ ...patch, version: sql`${fixtures.version} + 1`, updatedAt: new Date() })
    .where(eq(fixtures.id, fixtureId));
}

// ---------------------------------------------------------------------------
// Lineups
// ---------------------------------------------------------------------------

export interface SetLineupInput {
  fixtureId: string;
  side: Side;
  slots: LineupSlot[];
  confirm: boolean;
}

export async function setLineup(db: Db, actor: Actor, input: SetLineupInput): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, input.fixtureId, { lock: true });
    const teamId = input.side === "HOME" ? ctx.homeTeamId : ctx.awayTeamId;
    assertCan(actor, {
      action: "lineup.set",
      leagueId: ctx.fixture.leagueId,
      teamId,
      fixture: { homeTeamId: ctx.homeTeamId, awayTeamId: ctx.awayTeamId },
    });
    if (ctx.fixture.status !== "SCHEDULED") {
      throw new AppError("FIXTURE_NOT_SCHEDULED", "lineups can only be set before the fixture starts");
    }

    // Only registrations from this competition's season are eligible.
    const ids = input.slots.flatMap((s) => s.registrationIds);
    const regRows = ids.length
      ? await tx
          .select({ reg: playerRegistrations, playerStatus: players.status })
          .from(playerRegistrations)
          .innerJoin(players, eq(players.id, playerRegistrations.playerId))
          .where(and(inArray(playerRegistrations.id, ids), eq(playerRegistrations.seasonId, ctx.competition.seasonId)))
      : [];
    const registrations = new Map<string, EligibleRegistration>(
      regRows.map(({ reg, playerStatus }) => [
        reg.id,
        {
          registrationId: reg.id,
          playerId: reg.playerId,
          teamId: reg.teamId,
          registrationStatus: reg.status,
          playerStatus,
          registeredAt: reg.registeredAt,
        },
      ]),
    );
    const problems = validateLineup({
      teamId,
      fixtureStartsAt: ctx.fixture.scheduledAt,
      slotKinds: ctx.rules.match.slots.map((s) => s.kind),
      maxSinglesPerPlayer: ctx.rules.match.maxSinglesPerPlayer,
      maxPairsPerPlayer: ctx.rules.match.maxPairsPerPlayer,
      slots: input.slots,
      registrations,
    });
    if (problems.length) throw new AppError("INVALID_LINEUP", problems.map((p) => p.message).join("; "), 422, problems);

    let gameRows = await tx.select().from(games).where(eq(games.fixtureId, ctx.fixture.id));
    if (gameRows.length === 0) {
      gameRows = await tx
        .insert(games)
        .values(
          ctx.rules.match.slots.map((slot, i) => ({
            fixtureId: ctx.fixture.id,
            ordinal: i + 1,
            kind: slot.kind,
            groupKey: slot.group,
          })),
        )
        .returning();
    }
    const gameIdByOrdinal = new Map(gameRows.map((g) => [g.ordinal, g.id]));

    // Pre-start lineup rows are not yet history, so replacing them is safe.
    await tx
      .delete(gamePlayers)
      .where(and(inArray(gamePlayers.gameId, gameRows.map((g) => g.id)), eq(gamePlayers.side, input.side)));
    const rows = input.slots.flatMap((s) =>
      s.registrationIds.map((regId, i) => {
        const reg = registrations.get(regId)!;
        return {
          gameId: gameIdByOrdinal.get(s.gameOrdinal)!,
          side: input.side,
          position: i + 1,
          registrationId: reg.registrationId,
          playerId: reg.playerId,
        };
      }),
    );
    if (rows.length) await tx.insert(gamePlayers).values(rows);

    const confirmedCol = input.side === "HOME" ? "homeLineupConfirmedAt" : "awayLineupConfirmedAt";
    await bumpVersion(tx, ctx.fixture.id, { [confirmedCol]: input.confirm ? new Date() : null });
  });
}

// ---------------------------------------------------------------------------
// Starting a fixture
// ---------------------------------------------------------------------------

/** Start scoring. Games with a player missing on one side become walkovers. */
export async function startFixture(db: Db, actor: Actor, fixtureId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, fixtureId, { lock: true });
    assertScorer(actor, ctx);
    const next = transition(ctx.fixture.status, "START", {
      lineupsConfirmed: !!ctx.fixture.homeLineupConfirmedAt && !!ctx.fixture.awayLineupConfirmedAt,
    });

    const gameRows = await tx.select().from(games).where(eq(games.fixtureId, fixtureId)).orderBy(asc(games.ordinal));
    const lineup = await tx.select().from(gamePlayers).where(inArray(gamePlayers.gameId, gameRows.map((g) => g.id)));
    for (const g of gameRows) {
      const home = lineup.some((p) => p.gameId === g.id && p.side === "HOME");
      const away = lineup.some((p) => p.gameId === g.id && p.side === "AWAY");
      if (home && away) continue;
      if (!home && !away) {
        await tx.update(games).set({ status: "VOID" }).where(eq(games.id, g.id));
        continue;
      }
      const winner: Side = home ? "HOME" : "AWAY";
      await tx.update(games).set({ status: "WALKOVER", winner, completedAt: new Date() }).where(eq(games.id, g.id));
      await rebuildGameStats(tx, g.id);
      await audit(tx, {
        leagueId: ctx.fixture.leagueId,
        actor,
        action: "game.walkover_applied",
        entityType: "game",
        entityId: g.id,
        after: { fixtureId, ordinal: g.ordinal, winner },
      });
    }
    await bumpVersion(tx, fixtureId, { status: next, startedAt: new Date() });
  });
}

function assertScorer(actor: Actor, ctx: FixtureContext) {
  assertCan(actor, {
    action: "scoring.submit",
    leagueId: ctx.fixture.leagueId,
    fixture: { homeTeamId: ctx.homeTeamId, awayTeamId: ctx.awayTeamId, responsibleSide: ctx.responsibleSide },
  });
}

// ---------------------------------------------------------------------------
// Live scoring
// ---------------------------------------------------------------------------

export interface RecordVisitInput {
  fixtureId: string;
  gameOrdinal: number;
  /** Generated on the scoring device; resubmitting the same id is a no-op. */
  clientEventId: string;
  side: Side;
  scored: number;
  darts?: number;
  /** Who threw. Required for pairs games; defaults to the side's only player in singles. */
  playerId?: string;
  /** The seq the device believes comes next; mismatches are rejected so devices cannot fork a leg. */
  expectedSeq?: number;
}

export interface RecordVisitResult {
  duplicate: boolean;
  seq: number;
  remaining: Record<Side, number>;
  legWinner: Side | null;
  gameStatus: string;
  fixtureStatus: string;
  fixtureVersion: number;
}

export async function recordVisit(db: Db, actor: Actor, input: RecordVisitInput): Promise<RecordVisitResult> {
  return db.transaction(async (tx) => {
    // Lock first so a concurrent retry of the same event waits and then sees it as a duplicate.
    const ctx = await loadFixtureContext(tx, input.fixtureId, { lock: true });
    assertScorer(actor, ctx);

    const [existing] = await tx.select().from(visits).where(eq(visits.clientEventId, input.clientEventId));
    if (existing) return snapshot(tx, input.fixtureId, existing.legId, existing.seq, true);

    if (ctx.fixture.status !== "LIVE") throw new AppError("FIXTURE_NOT_LIVE", "this fixture is not live");
    const [game] = await tx
      .select()
      .from(games)
      .where(and(eq(games.fixtureId, input.fixtureId), eq(games.ordinal, input.gameOrdinal)));
    if (!game) throw notFound("game");
    if (game.status !== "PENDING" && game.status !== "LIVE") {
      throw new AppError("GAME_NOT_IN_PLAY", `game ${game.ordinal} is ${game.status.toLowerCase()}`);
    }
    if (game.status === "PENDING" && fixtureProgress(await gameSummaries(tx, input.fixtureId), ctx.rules).notRequired.includes(game.ordinal)) {
      throw new AppError("GAME_NOT_REQUIRED", `the result is already decided, so game ${game.ordinal} isn't played`);
    }

    const lineup = await tx.select().from(gamePlayers).where(eq(gamePlayers.gameId, game.id));
    const sidePlayers = lineup.filter((p) => p.side === input.side).map((p) => p.playerId);
    const playerId = input.playerId ?? (sidePlayers.length === 1 ? sidePlayers[0] : undefined);
    if (!playerId || !sidePlayers.includes(playerId)) {
      throw new AppError("PLAYER_NOT_IN_GAME", "that player is not playing this game for that side");
    }

    const firstThrower = game.firstThrower ?? "HOME";
    if (game.status === "PENDING") {
      await tx.update(games).set({ status: "LIVE", startedAt: new Date(), firstThrower }).where(eq(games.id, game.id));
    }

    // Current leg: the earliest unfinished one (an undone checkout reopens its leg), or a new one.
    const legRows = await tx.select().from(legs).where(eq(legs.gameId, game.id)).orderBy(asc(legs.ordinal));
    let leg = legRows.find((l) => !l.winner);
    if (!leg) {
      const ordinal = legRows.length + 1;
      [leg] = await tx
        .insert(legs)
        .values({ gameId: game.id, ordinal, startingSide: startingSideForLeg(firstThrower, ordinal - 1) })
        .returning();
    }
    const cfg = legConfig(ctx, game.kind, leg.startingSide);

    const allVisits = await tx.select().from(visits).where(eq(visits.legId, leg.id)).orderBy(asc(visits.seq));
    const nextSeq = (allVisits.at(-1)?.seq ?? 0) + 1;
    if (input.expectedSeq !== undefined && input.expectedSeq !== nextSeq) {
      throw conflict("SEQ_MISMATCH", "the scoresheet changed on another device; reloading", { nextSeq });
    }
    const state = replayLeg(cfg, allVisits.filter((v) => !v.voidedAt).map(toVisit));
    const visitInput: VisitInput = { side: input.side, playerId, scored: input.scored, darts: input.darts };
    const resolved = resolveVisit(state, cfg, visitInput);

    await tx.insert(visits).values({
      legId: leg.id,
      seq: nextSeq,
      ...resolved,
      clientEventId: input.clientEventId,
      createdBy: actor.userId,
    });

    if (resolved.isCheckout) {
      await tx.update(legs).set({ winner: resolved.side }).where(eq(legs.id, leg.id));
      await settleGame(tx, ctx, game.id);
    }
    await bumpVersion(tx, input.fixtureId);
    return snapshot(tx, input.fixtureId, leg.id, nextSeq, false);
  });
}

/** Recompute a game's legs/winner/status from its legs; rebuild its stats. */
async function settleGame(db: Db, ctx: FixtureContext, gameId: string): Promise<void> {
  const legRows = await db.select().from(legs).where(eq(legs.gameId, gameId)).orderBy(asc(legs.ordinal));
  const winners = legRows.map((l) => l.winner).filter((w): w is Side => !!w);
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  const progress = gameProgress(gameConfigFor(ctx.rules, game.kind), winners);
  await db
    .update(games)
    .set({
      homeLegs: progress.legsWon.HOME,
      awayLegs: progress.legsWon.AWAY,
      status: progress.finished ? "COMPLETED" : legRows.length ? "LIVE" : "PENDING",
      winner: progress.winner,
      completedAt: progress.finished ? new Date() : null,
    })
    .where(eq(games.id, gameId));
  await rebuildGameStats(db, gameId);
}

async function snapshot(db: Db, fixtureId: string, legId: string, seq: number, duplicate: boolean): Promise<RecordVisitResult> {
  const [leg] = await db.select().from(legs).where(eq(legs.id, legId));
  const [game] = await db.select().from(games).where(eq(games.id, leg.gameId));
  const [fixture] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  const ctx = await loadFixtureContext(db, fixtureId);
  const records = await loadLegRecords(db, leg.gameId);
  const record = records.find((r) => r.legId === legId)!;
  let state = initialLegState(legConfig(ctx, game.kind, leg.startingSide));
  for (const v of record.visits) state = applyVisit(state, v);
  return {
    duplicate,
    seq,
    remaining: state.remaining,
    legWinner: leg.winner,
    gameStatus: game.status,
    fixtureStatus: fixture.status,
    fixtureVersion: fixture.version,
  };
}

/**
 * Undo a visit while the fixture is live. Only the most recent visit of a game
 * can be undone. Identified by the visit's client event id, so a retried undo
 * is a no-op instead of removing a second visit.
 */
export async function undoVisit(db: Db, actor: Actor, input: { fixtureId: string; visitClientEventId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, input.fixtureId, { lock: true });
    assertScorer(actor, ctx);
    if (ctx.fixture.status !== "LIVE") {
      throw new AppError("FIXTURE_NOT_LIVE", "only a live match can be undone; ask the league to correct a finished one");
    }
    const [visit] = await tx.select().from(visits).where(eq(visits.clientEventId, input.visitClientEventId));
    if (!visit) throw notFound("visit");
    if (visit.voidedAt) return;
    const [leg] = await tx.select().from(legs).where(eq(legs.id, visit.legId));
    const [game] = await tx.select().from(games).where(eq(games.id, leg.gameId));
    if (game.fixtureId !== input.fixtureId) throw notFound("visit");

    const legRows = await tx.select().from(legs).where(eq(legs.gameId, game.id));
    const active = await tx
      .select({ id: visits.id, legId: visits.legId, seq: visits.seq })
      .from(visits)
      .where(and(inArray(visits.legId, legRows.map((l) => l.id)), isNull(visits.voidedAt)));
    const ordinalOf = new Map(legRows.map((l) => [l.id, l.ordinal]));
    const last = active.sort((a, b) => ordinalOf.get(a.legId)! - ordinalOf.get(b.legId)! || a.seq - b.seq).at(-1);
    if (last?.id !== visit.id) throw conflict("NOT_LAST_VISIT", "only the most recent visit in a game can be undone");

    await tx.update(visits).set({ voidedAt: new Date(), voidedBy: actor.userId }).where(eq(visits.id, visit.id));
    if (visit.isCheckout) {
      await tx.update(legs).set({ winner: null }).where(eq(legs.id, leg.id));
      await settleGame(tx, ctx, game.id);
    }
    await bumpVersion(tx, input.fixtureId);
  });
}

/** Record who throws first in a game (after the bull-up). Only before the first dart. */
export async function setFirstThrower(db: Db, actor: Actor, input: { fixtureId: string; gameOrdinal: number; side: Side }): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, input.fixtureId, { lock: true });
    assertScorer(actor, ctx);
    const [game] = await tx.select().from(games).where(and(eq(games.fixtureId, input.fixtureId), eq(games.ordinal, input.gameOrdinal)));
    if (!game) throw notFound("game");
    const started = await tx.select({ id: legs.id }).from(legs).where(eq(legs.gameId, game.id)).limit(1);
    if (started.length || game.status !== "PENDING") throw new AppError("GAME_STARTED", "the throw can only be chosen before the first dart");
    await tx.update(games).set({ firstThrower: input.side }).where(eq(games.id, game.id));
    await bumpVersion(tx, input.fixtureId);
  });
}

/**
 * The scorer confirms the result once every required game is finished. The
 * outcome and the COMPLETED status are written in one transaction, so the
 * table changes at that moment and never mid-match.
 */
export async function completeFixture(db: Db, actor: Actor, fixtureId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, fixtureId, { lock: true });
    assertScorer(actor, ctx);
    if (ctx.fixture.status !== "LIVE") throw new AppError("FIXTURE_NOT_LIVE", "this match isn't live");
    if (!(await finaliseIfComplete(tx, actor, fixtureId))) {
      throw new AppError("FIXTURE_INCOMPLETE", "finish every game before confirming the result");
    }
  });
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

async function gameSummaries(db: Db, fixtureId: string): Promise<(GameSummary & { id: string })[]> {
  const rows = await db.select().from(games).where(eq(games.fixtureId, fixtureId)).orderBy(asc(games.ordinal));
  return rows.map((g) => ({ id: g.id, status: g.status, winner: g.winner, homeLegs: g.homeLegs, awayLegs: g.awayLegs }));
}

/**
 * Finalise as soon as every required game is resolved. The outcome row and the
 * COMPLETED status are written in the caller's transaction, so the league
 * table (which reads only completed outcomes) changes atomically and never
 * mid-match.
 */
async function finaliseIfComplete(db: Db, actor: Actor | null, fixtureId: string): Promise<boolean> {
  const ctx = await loadFixtureContext(db, fixtureId);
  const summaries = await gameSummaries(db, fixtureId);
  const progress = fixtureProgress(summaries, ctx.rules);
  if (!progress.complete) return false;

  for (const ordinal of progress.notRequired) {
    await db.update(games).set({ status: "NOT_REQUIRED" }).where(eq(games.id, summaries[ordinal - 1].id));
  }
  const outcomes = computeOutcomes(await gameSummaries(db, fixtureId), ctx.rules);
  const event = ctx.fixture.status === "COMPLETED" ? "CORRECT" : "FINALISE";
  const status = transition(ctx.fixture.status, event, { allGamesResolved: true });

  const before = await db.select().from(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, fixtureId));
  await db.delete(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, fixtureId));
  for (const [groupKey, outcome] of Object.entries(outcomes)) {
    await writeOutcome(db, fixtureId, groupKey, outcome, "PLAYED", actor);
  }
  await bumpVersion(db, fixtureId, { status, completedAt: ctx.fixture.completedAt ?? new Date() });
  await audit(db, {
    leagueId: ctx.fixture.leagueId,
    actor,
    action: event === "CORRECT" ? "fixture.result_corrected" : "fixture.completed",
    entityType: "fixture",
    entityId: fixtureId,
    before: before.length ? before : null,
    after: outcomes,
  });
  await afterResultChange(db, fixtureId, actor);
  return true;
}

/** Recompute a completed fixture's result (e.g. after a rule change). */
export async function refinaliseFixture(db: Db, actor: Actor | null, fixtureId: string): Promise<void> {
  if (!(await finaliseIfComplete(db, actor, fixtureId))) {
    throw new AppError("FIXTURE_INCOMPLETE", "fixture can no longer be finalised under these rules");
  }
}

export async function writeOutcome(
  db: Db,
  fixtureId: string,
  groupKey: string,
  o: FixtureOutcome,
  source: "PLAYED" | "AWARDED" | "ADMIN",
  actor: Actor | null,
) {
  const values = {
    fixtureId,
    groupKey,
    homeGames: o.homeGames,
    awayGames: o.awayGames,
    homePointGames: o.homePointGames,
    awayPointGames: o.awayPointGames,
    homeLegs: o.homeLegs,
    awayLegs: o.awayLegs,
    winner: o.winner,
    source,
    finalisedAt: new Date(),
    finalisedBy: actor?.userId ?? null,
  };
  await db
    .insert(fixtureOutcomes)
    .values(values)
    .onConflictDoUpdate({ target: [fixtureOutcomes.fixtureId, fixtureOutcomes.groupKey], set: values });
}

// ---------------------------------------------------------------------------
// Admin corrections
// ---------------------------------------------------------------------------

export interface CorrectLegInput {
  fixtureId: string;
  gameOrdinal: number;
  legOrdinal: number;
  /** The full, corrected list of visits for the leg, in throw order. `playerId` is required in pairs games. */
  visits: (Omit<VisitInput, "playerId"> & { playerId?: string })[];
  reason: string;
}

/**
 * Replace a leg's visits with a corrected list. Old visits are voided (kept
 * for audit), the corrected ones are re-validated through the scoring engine,
 * and the game, its statistics and — if completed — the fixture result are
 * recomputed in one transaction.
 */
export async function correctLeg(db: Db, actor: Actor, input: CorrectLegInput): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, input.fixtureId, { lock: true });
    assertCan(actor, { action: "result.correct", leagueId: ctx.fixture.leagueId });
    if (ctx.fixture.status !== "LIVE" && ctx.fixture.status !== "COMPLETED") {
      throw new AppError("FIXTURE_NOT_PLAYED", "only live or completed fixtures can be corrected");
    }
    const [game] = await tx
      .select()
      .from(games)
      .where(and(eq(games.fixtureId, input.fixtureId), eq(games.ordinal, input.gameOrdinal)));
    if (!game) throw notFound("game");
    const [leg] = await tx
      .select()
      .from(legs)
      .where(and(eq(legs.gameId, game.id), eq(legs.ordinal, input.legOrdinal)));
    if (!leg) throw notFound("leg");

    const lineup = await tx.select().from(gamePlayers).where(eq(gamePlayers.gameId, game.id));
    const cfg = legConfig(ctx, game.kind, leg.startingSide);
    let state = initialLegState(cfg);
    for (const v of input.visits) {
      const sidePlayers = lineup.filter((p) => p.side === v.side).map((p) => p.playerId);
      const playerId = v.playerId ?? (sidePlayers.length === 1 ? sidePlayers[0] : undefined);
      if (!playerId || !sidePlayers.includes(playerId)) {
        throw new AppError("PLAYER_NOT_IN_GAME", `say which ${v.side.toLowerCase()} player threw each visit`);
      }
      state = applyVisit(state, resolveVisit(state, cfg, { ...v, playerId }));
    }
    if (ctx.fixture.status === "COMPLETED" && !state.winner) {
      throw new AppError("LEG_INCOMPLETE", "a completed fixture's corrected leg must still finish with a checkout");
    }

    const old = await tx.select().from(visits).where(eq(visits.legId, leg.id)).orderBy(asc(visits.seq));
    const now = new Date();
    await tx.update(visits).set({ voidedAt: now, voidedBy: actor.userId }).where(eq(visits.legId, leg.id));
    const [{ maxSeq }] = await tx.select({ maxSeq: max(visits.seq) }).from(visits).where(eq(visits.legId, leg.id));
    if (state.visits.length) {
      await tx.insert(visits).values(
        state.visits.map((v, i) => ({
          legId: leg.id,
          seq: (maxSeq ?? 0) + i + 1,
          ...v,
          clientEventId: randomUUID(),
          createdBy: actor.userId,
        })),
      );
    }
    await tx.update(legs).set({ winner: state.winner }).where(eq(legs.id, leg.id));
    await settleGame(tx, ctx, game.id);

    const [updated] = await tx.select().from(games).where(eq(games.id, game.id));
    if (ctx.fixture.status === "COMPLETED") {
      if (updated.status !== "COMPLETED") {
        throw new AppError("GAME_INCOMPLETE", "the correction leaves the game unfinished");
      }
      await finaliseIfComplete(tx, actor, input.fixtureId);
      const info = await fixtureInfo(tx, ctx);
      await notify(tx, {
        leagueId: info.leagueId,
        actor,
        to: { leagueAdmins: true, teamIds: [ctx.homeTeamId, ctx.awayTeamId] },
        event: { type: "result.corrected", payload: { ...info, reason: input.reason } },
      });
    } else {
      await bumpVersion(tx, input.fixtureId);
    }
    await audit(tx, {
      leagueId: ctx.fixture.leagueId,
      actor,
      action: "scoring.corrected",
      entityType: "leg",
      entityId: leg.id,
      before: old.filter((v) => !v.voidedAt).map(toVisit),
      after: state.visits,
      reason: input.reason,
    });
  });
}

export async function voidFixture(
  db: Db,
  actor: Actor,
  input: { fixtureId: string; reason: string; keepPlayerStats: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, input.fixtureId, { lock: true });
    assertCan(actor, { action: "result.correct", leagueId: ctx.fixture.leagueId });
    const status = transition(ctx.fixture.status, "VOID");
    const overridden = await overridePendingRearrangement(tx, actor, input.fixtureId, input.reason);
    await bumpVersion(tx, input.fixtureId, {
      status,
      voidReason: input.reason,
      keepStatsWhenVoid: input.keepPlayerStats,
    });
    const info = await fixtureInfo(tx, ctx);
    await notify(tx, {
      leagueId: info.leagueId,
      actor,
      to: { leagueAdmins: true, teamIds: [ctx.homeTeamId, ctx.awayTeamId].filter(Boolean) },
      event: { type: "fixture.voided", payload: { ...info, reason: input.reason } },
    });
    await afterResultChange(tx, input.fixtureId, actor);
    await audit(tx, {
      leagueId: ctx.fixture.leagueId,
      actor,
      action: "fixture.voided",
      entityType: "fixture",
      entityId: input.fixtureId,
      before: { status: ctx.fixture.status },
      after: { status, keepPlayerStats: input.keepPlayerStats, rearrangementOverridden: overridden },
      reason: input.reason,
    });
  });
}
