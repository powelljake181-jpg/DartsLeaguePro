import { and, eq, inArray, max } from "drizzle-orm";
import type { Db } from "@/db/client";
import { competitionRulePeriods, competitions, fixtures, gamePlayers, games, rulesets } from "@/db/schema";
import { localDateInZone } from "@/domain/dates";
import { assertCan, type Actor } from "@/domain/permissions";
import { describeChanges, nextPeriodAfter, periodFor, structuralChanges } from "@/domain/rule-periods";
import { rulesSchema, type LeagueRules } from "@/domain/rules";
import { audit, leagueTimezone, loadRulePeriods } from "./context";
import { AppError, notFound } from "./errors";
import { refinaliseFixture } from "./match-service";
import { getTables, type Table } from "./standings-service";
import { rebuildGameStats } from "./stats-service";

/**
 * Changing a competition's rules. Every change has an explicit effective date
 * (it may be in the past). Fixtures dated before it keep the old rules;
 * fixtures from it until the next scheduled change are recalculated. A change
 * that alters how matches are played cannot cover fixtures already played.
 */

export interface RuleChangeInput {
  competitionId: string;
  /** Unvalidated config from the editor. */
  rules: unknown;
  /** YYYY-MM-DD, league-local. Required: there is no default. */
  effectiveFrom: string;
  reason: string;
}

export interface FixtureRef {
  fixtureId: string;
  date: string;
  status: string;
}

export interface RuleChangePreview {
  effectiveFrom: string;
  /** The new rules apply until this date (an existing later change), or null for the rest of the season. */
  until: string | null;
  retrospective: boolean;
  changes: string[];
  structural: string[];
  /** Already-played fixtures a structural change would have to rewrite — the change is refused while any exist. */
  blockingFixtures: FixtureRef[];
  /** Completed fixtures whose result, points and statistics will be recalculated. */
  recalculatedFixtures: FixtureRef[];
  /** Fixtures not yet started whose lineups must be re-entered (structural change only). */
  lineupsReset: FixtureRef[];
  tables: { before: Table[]; after: Table[] };
}

class PreviewRollback extends Error {
  constructor(public readonly preview: RuleChangePreview) {
    super("preview");
  }
}

/** What the change would do, computed by applying it in a transaction that is then rolled back. */
export async function previewRuleChange(db: Db, actor: Actor, input: RuleChangeInput, now = new Date()): Promise<RuleChangePreview> {
  try {
    await db.transaction(async (tx) => {
      const preview = await apply(tx, actor, input, now, { allowBlocked: true });
      throw new PreviewRollback(preview);
    });
  } catch (e) {
    if (e instanceof PreviewRollback) return e.preview;
    throw e;
  }
  throw new Error("unreachable");
}

export async function applyRuleChange(db: Db, actor: Actor, input: RuleChangeInput, now = new Date()): Promise<RuleChangePreview> {
  return db.transaction((tx) => apply(tx, actor, input, now, { allowBlocked: false }));
}

async function apply(
  tx: Db,
  actor: Actor,
  input: RuleChangeInput,
  now: Date,
  opts: { allowBlocked: boolean },
): Promise<RuleChangePreview> {
  const [competition] = await tx.select().from(competitions).where(eq(competitions.id, input.competitionId));
  if (!competition) throw notFound("competition");
  assertCan(actor, { action: "league.configure", leagueId: competition.leagueId });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom ?? "")) {
    throw new AppError("EFFECTIVE_DATE_REQUIRED", "choose the date these rules take effect from", 422);
  }
  if (!input.reason?.trim()) throw new AppError("REASON_REQUIRED", "give a reason for the rule change", 422);
  const parsed = rulesSchema.safeParse(input.rules);
  if (!parsed.success) throw new AppError("INVALID_RULES", parsed.error.issues.map((i) => i.message).join("; "), 422, parsed.error.issues);
  const after: LeagueRules = parsed.data;
  if (competition.kind === "CUP" && after.match.groups[0].allowDraw) {
    throw new AppError("CUP_DRAWS", "a cup match must have a winner: use an odd number of games or a best-of format, without draws", 422);
  }

  const tz = await leagueTimezone(tx, competition.leagueId);
  const periods = await loadRulePeriods(tx, competition.id);
  // A date before the competition's first rules period means "from the very start": it replaces that period.
  const effectiveFrom = input.effectiveFrom < periods[0].effectiveFrom ? periods[0].effectiveFrom : input.effectiveFrom;
  input = { ...input, effectiveFrom };
  const before = periodFor(periods, input.effectiveFrom).rules;
  const next = nextPeriodAfter(periods, input.effectiveFrom);
  const until = next?.effectiveFrom ?? null;
  const today = localDateInZone(now, tz);

  // Fixtures governed by the new period.
  const all = await tx.select().from(fixtures).where(eq(fixtures.competitionId, competition.id));
  const covered = all
    .map((f) => ({ f, date: localDateInZone(f.scheduledAt, tz) }))
    .filter(({ date }) => date >= input.effectiveFrom && (!until || date < until));
  const ref = ({ f, date }: (typeof covered)[number]): FixtureRef => ({ fixtureId: f.id, date, status: f.status });

  const structural = structuralChanges(before, after);
  const coveredIds = covered.map((c) => c.f.id);
  const createdGames = coveredIds.length
    ? await tx.select({ fixtureId: games.fixtureId, id: games.id }).from(games).where(inArray(games.fixtureId, coveredIds))
    : [];
  const hasGames = new Set(createdGames.map((g) => g.fixtureId));
  const played = covered.filter(({ f }) => f.status === "LIVE" || f.status === "COMPLETED" || (f.status === "VOID" && hasGames.has(f.id) && f.startedAt));
  const blockingFixtures = structural.length ? played.map(ref) : [];
  const lineupsReset = structural.length
    ? covered.filter(({ f }) => !played.some((p) => p.f.id === f.id) && hasGames.has(f.id)).map(ref)
    : [];
  const recalculated = covered.filter(({ f }) => f.status === "COMPLETED");

  const tablesBefore = await getTables(tx, competition.id, now);

  if (blockingFixtures.length && !opts.allowBlocked) {
    const last = blockingFixtures.map((b) => b.date).sort().at(-1);
    throw new AppError(
      "RULE_CHANGE_BLOCKED",
      `this changes how matches are played (${structural.join(", ")}), so it cannot cover the ${blockingFixtures.length} ` +
        `fixture(s) already played from ${input.effectiveFrom}; choose a date after ${last}`,
      409,
      { blockingFixtures },
    );
  }

  // New immutable ruleset version + a period starting on the effective date (replacing one on the same date).
  const [{ latest }] = await tx
    .select({ latest: max(rulesets.version) })
    .from(rulesets)
    .where(and(eq(rulesets.leagueId, competition.leagueId), eq(rulesets.name, competition.name)));
  const [ruleset] = await tx
    .insert(rulesets)
    .values({ leagueId: competition.leagueId, name: competition.name, version: (latest ?? 0) + 1, config: after, createdBy: actor.userId })
    .returning();
  await tx
    .insert(competitionRulePeriods)
    .values({ competitionId: competition.id, rulesetId: ruleset.id, effectiveFrom: input.effectiveFrom, reason: input.reason, createdBy: actor.userId })
    .onConflictDoUpdate({
      target: [competitionRulePeriods.competitionId, competitionRulePeriods.effectiveFrom],
      set: { rulesetId: ruleset.id, reason: input.reason, createdBy: actor.userId, createdAt: now },
    });

  if (!blockingFixtures.length) {
    // Unstarted fixtures with lineups under the old format: games are recreated when lineups are re-entered.
    for (const { fixtureId } of lineupsReset) {
      const ids = createdGames.filter((g) => g.fixtureId === fixtureId).map((g) => g.id);
      await tx.delete(gamePlayers).where(inArray(gamePlayers.gameId, ids));
      await tx.delete(games).where(inArray(games.id, ids));
      await tx.update(fixtures).set({ homeLineupConfirmedAt: null, awayLineupConfirmedAt: null }).where(eq(fixtures.id, fixtureId));
    }
    // Played fixtures: statistics (bands, walkover records) and results (walkover counting) under the new rules.
    for (const { f } of covered.filter(({ f }) => f.status === "LIVE" || f.status === "COMPLETED")) {
      for (const g of createdGames.filter((x) => x.fixtureId === f.id)) await rebuildGameStats(tx, g.id);
    }
    for (const { f } of recalculated) await refinaliseFixture(tx, actor, f.id);
  }

  const preview: RuleChangePreview = {
    effectiveFrom: input.effectiveFrom,
    until,
    retrospective: input.effectiveFrom <= today,
    changes: describeChanges(before, after),
    structural,
    blockingFixtures,
    recalculatedFixtures: blockingFixtures.length ? [] : recalculated.map(ref),
    lineupsReset,
    tables: { before: tablesBefore, after: blockingFixtures.length ? tablesBefore : await getTables(tx, competition.id, now) },
  };

  await audit(tx, {
    leagueId: competition.leagueId,
    actor,
    action: "rules.changed",
    entityType: "competition",
    entityId: competition.id,
    before,
    after: { rules: after, effectiveFrom: input.effectiveFrom, until, recalculatedFixtures: preview.recalculatedFixtures.length },
    reason: input.reason,
  });
  return preview;
}
