import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { competitions, fixtureOutcomes, fixtures, foldEvents, leagues, teamEntries } from "@/db/schema";
import { localDateInZone } from "@/domain/dates";
import { transition, type FixtureStatus } from "@/domain/fixture-state";
import { FoldError, planFold, type FoldResults } from "@/domain/folds";
import { awardedOutcomes } from "@/domain/match";
import { assertCan, type Actor } from "@/domain/permissions";
import { audit, loadFixtureContext } from "./context";
import { AppError, notFound } from "./errors";
import { advanceCup } from "./cup-service";
import { bumpVersion, writeOutcome } from "./match-service";
import { notify } from "./notification-service";
import { overridePendingRearrangement } from "./rearrangement-service";
import { getTables, type Table } from "./standings-service";

/**
 * Folding a team (ARCHITECTURE §9). Applied in one transaction: fixture
 * statuses change and awarded results are written; nothing is subtracted from
 * the table, which is recomputed from results. The previous state of every
 * changed fixture is stored on the fold event so the fold can be reversed
 * exactly — as long as nobody has changed those fixtures since.
 */

export interface FoldInput {
  entryId: string;
  results: FoldResults;
  playerStats: "KEEP" | "EXCLUDE";
  reason: string;
}

export interface FoldChange {
  fixtureId: string;
  date: string;
  home: string;
  away: string;
  from: FixtureStatus;
  to: FixtureStatus;
  /** For awarded results: who gets the win. */
  awardedTo: string | null;
  /** Darts were thrown in this match (it had been played). */
  played: boolean;
  /** For played matches: whether the players' statistics still count after the fold. */
  statsKept: boolean;
}

export interface FoldPreview {
  team: string;
  competition: string;
  changes: FoldChange[];
  tablesBefore: Table[];
  tablesAfter: Table[];
  foldEventId: string;
}

interface Snapshot {
  id: string;
  status: FixtureStatus;
  voidReason: string | null;
  keepStatsWhenVoid: boolean;
  /** Absent in folds recorded before this flag existed (treated as false). */
  statsExcluded?: boolean;
  completedAt: string | null;
  outcomes: (typeof fixtureOutcomes.$inferSelect)[];
  /** The fixture's version right after the fold; a different version on revert means someone changed it since. */
  versionAfter: number;
}

class PreviewRollback extends Error {
  constructor(public readonly preview: FoldPreview) {
    super("preview");
  }
}

export async function previewFold(db: Db, actor: Actor, input: FoldInput): Promise<FoldPreview> {
  try {
    await db.transaction(async (tx) => {
      throw new PreviewRollback(await apply(tx, actor, input, { preview: true }));
    });
  } catch (e) {
    if (e instanceof PreviewRollback) return e.preview;
    throw e;
  }
  throw new Error("unreachable");
}

export async function foldTeam(db: Db, actor: Actor, input: FoldInput): Promise<FoldPreview> {
  return db.transaction((tx) => apply(tx, actor, input, { preview: false }));
}

async function apply(tx: Db, actor: Actor, input: FoldInput, opts: { preview: boolean }): Promise<FoldPreview> {
  const reason = input.reason.trim().slice(0, 500);
  if (!reason && !opts.preview) throw new AppError("REASON_REQUIRED", "give a reason; every team in the division will see it");
  const [entry] = await tx.select().from(teamEntries).where(eq(teamEntries.id, input.entryId));
  if (!entry) throw notFound("team entry");
  const [competition] = await tx.select().from(competitions).where(eq(competitions.id, entry.competitionId));
  assertCan(actor, { action: "result.correct", leagueId: competition.leagueId });
  if (entry.status !== "ACTIVE") throw new AppError("ALREADY_FOLDED", `${entry.displayName} have already been withdrawn from ${competition.name}`);
  const [league] = await tx.select().from(leagues).where(eq(leagues.id, competition.leagueId));

  const rows = await tx
    .select()
    .from(fixtures)
    .where(and(eq(fixtures.competitionId, competition.id), or(eq(fixtures.homeEntryId, entry.id), eq(fixtures.awayEntryId, entry.id))))
    .orderBy(fixtures.scheduledAt);
  // In a cup the bracket must keep moving: a withdrawn team's remaining ties go to their opponents and results already played stand.
  const results = competition.kind === "CUP" ? "MAX_LOSS_REMAINING" : input.results;
  let plan;
  try {
    plan = planFold(
      rows.map((f) => ({ id: f.id, status: f.status, side: f.homeEntryId === entry.id ? "HOME" : "AWAY", bye: !f.awayEntryId })),
      results,
    );
  } catch (e) {
    if (e instanceof FoldError) throw new AppError("FOLD_BLOCKED", e.message);
    throw e;
  }

  const allEntries = await tx.select().from(teamEntries).where(eq(teamEntries.competitionId, competition.id));
  const name = (id: string | null) => allEntries.find((e) => e.id === id)?.displayName ?? "Bye";
  const tablesBefore = await getTables(tx, competition.id);

  const [event] = await tx
    .insert(foldEvents)
    .values({ teamEntryId: entry.id, resultsTreatment: input.results, playerStatsTreatment: input.playerStats, previousState: [], createdBy: actor.userId })
    .returning();

  const snapshots: Snapshot[] = [];
  const changes: FoldChange[] = [];
  const now = new Date();
  for (const action of plan) {
    if (action.action === "KEEP") continue;
    const f = rows.find((r) => r.id === action.fixtureId)!;
    const outcomes = await tx.select().from(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, f.id));
    await overridePendingRearrangement(tx, actor, f.id, `${entry.displayName} folded`);
    let to: FixtureStatus;
    if (action.action === "VOID") {
      to = transition(f.status, "VOID");
      await bumpVersion(tx, f.id, { status: to, voidReason: `${entry.displayName} folded: ${reason}`, keepStatsWhenVoid: input.playerStats === "KEEP", foldEventId: event.id });
    } else {
      const ctx = await loadFixtureContext(tx, f.id);
      to = transition(f.status, f.status === "COMPLETED" ? "CORRECT" : "AWARD");
      await tx.delete(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, f.id));
      for (const [groupKey, o] of Object.entries(awardedOutcomes(action.winner, ctx.rules))) await writeOutcome(tx, f.id, groupKey, o, "AWARDED", actor);
      // A played result replaced by an award: its darts count only if the league keeps them.
      const statsExcluded = f.status === "COMPLETED" && input.playerStats === "EXCLUDE";
      await bumpVersion(tx, f.id, { status: to, completedAt: f.completedAt ?? now, foldEventId: event.id, statsExcluded });
    }
    const [after] = await tx.select({ version: fixtures.version }).from(fixtures).where(eq(fixtures.id, f.id));
    snapshots.push({
      id: f.id,
      status: f.status,
      voidReason: f.voidReason,
      keepStatsWhenVoid: f.keepStatsWhenVoid,
      statsExcluded: f.statsExcluded,
      completedAt: f.completedAt?.toISOString() ?? null,
      outcomes,
      versionAfter: after.version,
    });
    changes.push({
      fixtureId: f.id,
      date: localDateInZone(f.scheduledAt, league.timezone),
      home: name(f.homeEntryId),
      away: name(f.awayEntryId),
      from: f.status,
      to,
      awardedTo: action.action === "AWARD" ? name(action.winner === "HOME" ? f.homeEntryId : f.awayEntryId) : null,
      played: f.status === "COMPLETED",
      statsKept: f.status === "COMPLETED" && input.playerStats === "KEEP",
    });
  }
  await tx.update(foldEvents).set({ previousState: snapshots }).where(eq(foldEvents.id, event.id));
  await tx.update(teamEntries).set({ status: "FOLDED" }).where(eq(teamEntries.id, entry.id));
  if (competition.kind === "CUP") await advanceCup(tx, competition.id, actor);
  const tablesAfter = await getTables(tx, competition.id);

  if (!opts.preview) {
    await audit(tx, {
      leagueId: competition.leagueId,
      actor,
      action: "team.folded",
      entityType: "team_entry",
      entityId: entry.id,
      after: { foldEventId: event.id, results: input.results, playerStats: input.playerStats, fixtures: changes.length },
      reason,
    });
    await notify(tx, {
      leagueId: competition.leagueId,
      actor,
      to: { leagueAdmins: true, teamIds: [...new Set(allEntries.map((e) => e.teamId))] },
      event: { type: "team.folded", payload: { leagueSlug: league.slug, team: entry.displayName, competition: competition.name, fixtures: changes.length } },
    });
  }
  return { team: entry.displayName, competition: competition.name, changes, tablesBefore, tablesAfter, foldEventId: event.id };
}

/** Reverse a fold exactly. Refused if any fixture it changed has been changed again since. */
export async function revertFold(db: Db, actor: Actor, input: { foldEventId: string; reason: string }): Promise<void> {
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) throw new AppError("REASON_REQUIRED", "give a reason; every team in the division will see it");
  await db.transaction(async (tx) => {
    const [event] = await tx.select().from(foldEvents).where(eq(foldEvents.id, input.foldEventId));
    if (!event) throw notFound("fold");
    const [entry] = await tx.select().from(teamEntries).where(eq(teamEntries.id, event.teamEntryId));
    const [competition] = await tx.select().from(competitions).where(eq(competitions.id, entry.competitionId));
    assertCan(actor, { action: "result.correct", leagueId: competition.leagueId });
    if (event.revertedAt) throw new AppError("ALREADY_REVERTED", "this fold has already been reversed");
    const snapshots = event.previousState as Snapshot[];
    const ids = snapshots.map((s) => s.id);
    const current = ids.length ? await tx.select().from(fixtures).where(inArray(fixtures.id, ids)).for("update") : [];
    const changedSince = snapshots.filter((s) => {
      const f = current.find((c) => c.id === s.id);
      return !f || f.foldEventId !== event.id || f.version !== s.versionAfter;
    });
    if (changedSince.length) {
      throw new AppError("FOLD_CHANGED_SINCE", `${changedSince.length} of the fixtures this fold changed have been changed again since, so it can't be reversed automatically`, 409);
    }
    for (const s of snapshots) {
      await tx.delete(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, s.id));
      if (s.outcomes.length) {
        await tx.insert(fixtureOutcomes).values(s.outcomes.map((o) => ({ ...o, finalisedAt: new Date(o.finalisedAt) })));
      }
      await bumpVersion(tx, s.id, {
        status: s.status,
        voidReason: s.voidReason,
        keepStatsWhenVoid: s.keepStatsWhenVoid,
        statsExcluded: s.statsExcluded ?? false,
        completedAt: s.completedAt ? new Date(s.completedAt) : null,
        foldEventId: null,
      });
    }
    await tx.update(foldEvents).set({ revertedAt: new Date() }).where(eq(foldEvents.id, event.id));
    await tx.update(teamEntries).set({ status: "ACTIVE" }).where(eq(teamEntries.id, entry.id));
    if (competition.kind === "CUP") await advanceCup(tx, competition.id, actor);
    const [league] = await tx.select().from(leagues).where(eq(leagues.id, competition.leagueId));
    const allEntries = await tx.select().from(teamEntries).where(eq(teamEntries.competitionId, competition.id));
    await audit(tx, {
      leagueId: competition.leagueId,
      actor,
      action: "team.fold_reverted",
      entityType: "team_entry",
      entityId: entry.id,
      after: { foldEventId: event.id, fixtures: snapshots.length },
      reason,
    });
    await notify(tx, {
      leagueId: competition.leagueId,
      actor,
      to: { leagueAdmins: true, teamIds: [...new Set(allEntries.map((e) => e.teamId))] },
      event: { type: "team.fold_reverted", payload: { leagueSlug: league.slug, team: entry.displayName, competition: competition.name } },
    });
  });
}

/** The current (un-reverted) fold of each folded entry in a season, for the admin season page. */
export async function activeFolds(db: Db, seasonId: string) {
  return db
    .select({ event: foldEvents, entry: teamEntries, competition: competitions })
    .from(foldEvents)
    .innerJoin(teamEntries, eq(teamEntries.id, foldEvents.teamEntryId))
    .innerJoin(competitions, eq(competitions.id, teamEntries.competitionId))
    .where(and(eq(competitions.seasonId, seasonId), isNull(foldEvents.revertedAt)));
}
