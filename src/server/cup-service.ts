import { and, asc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  competitionRulePeriods,
  competitions,
  cupRounds,
  fixtureOutcomes,
  fixtureRearrangements,
  fixtures,
  gamePlayers,
  games,
  leagues,
  rulesets,
  seasons,
  teamEntries,
  teams,
} from "@/db/schema";
import { CupError, drawFirstRound, roundCount, roundName, validateManualDraw, type DrawMode, type Tie } from "@/domain/cups";
import { localDateInZone, zonedTimeToUtc } from "@/domain/dates";
import { awardedOutcomes } from "@/domain/match";
import { assertCan, type Actor } from "@/domain/permissions";
import { periodFor } from "@/domain/rule-periods";
import { rulesSchema } from "@/domain/rules";
import { audit, loadFixtureContext, loadRulePeriods, type LoadedPeriod } from "./context";
import { AppError, notFound } from "./errors";
import { fixtureInfo } from "./fixture-ops";
import { bumpVersion, writeOutcome } from "./match-service";
import { notify } from "./notification-service";
import { loadFixtures } from "./public-service";

/**
 * Knockout cups (ARCHITECTURE §10c). A cup is a competition of kind CUP with
 * one team entry per entrant, one `cup_round` per bracket round (dated cup
 * nights), and fixtures placed by (round, bracket slot). The domain decides
 * the bracket (`domain/cups.ts`); this service persists it and advances
 * winners whenever a cup result changes.
 */

type FixtureRow = typeof fixtures.$inferSelect;
const UNPLAYED = ["SCHEDULED", "POSTPONED", "REARRANGEMENT_REQUESTED"] as const;

async function loadCup(db: Db, competitionId: string) {
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, competitionId));
  if (!competition || competition.kind !== "CUP") throw notFound("cup");
  const [league] = await db.select().from(leagues).where(eq(leagues.id, competition.leagueId));
  const [season] = await db.select().from(seasons).where(eq(seasons.id, competition.seasonId));
  return { competition, league, season };
}

function assertNoDraws(rules: unknown) {
  const parsed = rulesSchema.safeParse(rules);
  if (!parsed.success) throw new AppError("INVALID_RULES", parsed.error.issues.map((i) => i.message).join("; "), 422);
  if (parsed.data.match.groups[0].allowDraw) {
    throw new AppError("CUP_DRAWS", "a cup match must have a winner: use an odd number of games or a best-of format, without draws", 422);
  }
  return parsed.data;
}

const cupFixtures = (db: Db, competitionId: string) =>
  db.select().from(fixtures).where(eq(fixtures.competitionId, competitionId)).orderBy(asc(fixtures.roundNumber), asc(fixtures.bracketSlot));

const isDrawn = async (db: Db, competitionId: string) => (await cupFixtures(db, competitionId)).length > 0;

/**
 * Rounds follow the number of entrants until the draw. When the bracket grows
 * or shrinks, rounds keep their dates by distance from the final (the final's
 * date stays the final's date).
 */
async function syncRounds(db: Db, competitionId: string) {
  const entrants = (await db.select().from(teamEntries).where(eq(teamEntries.competitionId, competitionId))).length;
  const want = entrants >= 2 ? roundCount(entrants) : 0;
  const existing = await db.select().from(cupRounds).where(eq(cupRounds.competitionId, competitionId)).orderBy(asc(cupRounds.ordinal));
  if (existing.length === want && existing.every((r, i) => r.name === roundName(i + 1, want))) return;
  const fromFinal = (i: number, n: number) => n - 1 - i;
  const keep = (d: number) => existing.find((_, i) => fromFinal(i, existing.length) === d);
  await db.delete(cupRounds).where(eq(cupRounds.competitionId, competitionId));
  if (!want) return;
  await db.insert(cupRounds).values(
    Array.from({ length: want }, (_, i) => {
      const old = keep(fromFinal(i, want));
      return { competitionId, ordinal: i + 1, name: roundName(i + 1, want), scheduledOn: old?.scheduledOn ?? null, kickOff: old?.kickOff ?? "19:30" };
    }),
  );
}

// ---------------------------------------------------------------------------
// Setting up
// ---------------------------------------------------------------------------

export async function createCup(db: Db, actor: Actor, input: { seasonId: string; name: string; rules: unknown; teamIds: string[] }) {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AppError("INVALID_NAME", "give the cup a name (up to 80 characters)", 422);
  const rules = assertNoDraws(input.rules);
  return db.transaction(async (tx) => {
    const [season] = await tx.select().from(seasons).where(eq(seasons.id, input.seasonId));
    if (!season) throw notFound("season");
    assertCan(actor, { action: "league.configure", leagueId: season.leagueId });
    const [clash] = await tx.select().from(competitions).where(and(eq(competitions.seasonId, season.id), eq(competitions.kind, "CUP"), eq(competitions.name, name)));
    if (clash) throw new AppError("COMPETITION_EXISTS", `${season.name} already has a cup called ${name}`, 409);
    const teamIds = [...new Set(input.teamIds)];
    const teamRows = teamIds.length ? await tx.select().from(teams).where(and(inArray(teams.id, teamIds), eq(teams.leagueId, season.leagueId))) : [];
    if (teamRows.length !== teamIds.length) throw notFound("team");

    const [{ latest }] = await tx.select({ latest: max(rulesets.version) }).from(rulesets).where(and(eq(rulesets.leagueId, season.leagueId), eq(rulesets.name, name)));
    const [ruleset] = await tx
      .insert(rulesets)
      .values({ leagueId: season.leagueId, name, version: (latest ?? 0) + 1, config: rules, createdBy: actor.userId })
      .returning();
    const [competition] = await tx.insert(competitions).values({ leagueId: season.leagueId, seasonId: season.id, kind: "CUP", name }).returning();
    await tx.insert(competitionRulePeriods).values({ competitionId: competition.id, rulesetId: ruleset.id, effectiveFrom: season.startsOn, reason: "initial rules", createdBy: actor.userId });
    if (teamRows.length) {
      await tx.insert(teamEntries).values(teamRows.map((t) => ({ competitionId: competition.id, teamId: t.id, displayName: t.name, venueId: t.homeVenueId })));
    }
    await syncRounds(tx, competition.id);
    await audit(tx, { leagueId: season.leagueId, actor, action: "cup.created", entityType: "competition", entityId: competition.id, after: { name, teams: teamRows.map((t) => t.name) } });
    return competition;
  });
}

async function beforeDraw(db: Db, actor: Actor, competitionId: string) {
  const cup = await loadCup(db, competitionId);
  assertCan(actor, { action: "league.configure", leagueId: cup.competition.leagueId });
  if (await isDrawn(db, competitionId)) throw new AppError("CUP_DRAWN", "the draw has been made; withdraw a team with the fold tools instead", 409);
  return cup;
}

export async function addCupEntrant(db: Db, actor: Actor, input: { competitionId: string; teamId: string }) {
  await db.transaction(async (tx) => {
    const { competition } = await beforeDraw(tx, actor, input.competitionId);
    const [team] = await tx.select().from(teams).where(and(eq(teams.id, input.teamId), eq(teams.leagueId, competition.leagueId)));
    if (!team) throw notFound("team");
    const [already] = await tx.select().from(teamEntries).where(and(eq(teamEntries.competitionId, competition.id), eq(teamEntries.teamId, team.id)));
    if (already) throw new AppError("ALREADY_ENTERED", `${team.name} are already in the cup`, 409);
    await tx.insert(teamEntries).values({ competitionId: competition.id, teamId: team.id, displayName: team.name, venueId: team.homeVenueId });
    await syncRounds(tx, competition.id);
    await audit(tx, { leagueId: competition.leagueId, actor, action: "cup.entrant_added", entityType: "competition", entityId: competition.id, after: { team: team.name } });
  });
}

export async function removeCupEntrant(db: Db, actor: Actor, input: { entryId: string }) {
  await db.transaction(async (tx) => {
    const [entry] = await tx.select().from(teamEntries).where(eq(teamEntries.id, input.entryId));
    if (!entry) throw notFound("entry");
    const { competition } = await beforeDraw(tx, actor, entry.competitionId);
    await tx.delete(teamEntries).where(eq(teamEntries.id, entry.id));
    await syncRounds(tx, competition.id);
    await audit(tx, { leagueId: competition.leagueId, actor, action: "cup.entrant_removed", entityType: "competition", entityId: competition.id, before: { team: entry.displayName } });
  });
}

/** Seeds for a seeded draw: 1 = top seed; null = unseeded (drawn at random). */
export async function setCupSeeds(db: Db, actor: Actor, input: { competitionId: string; seeds: Record<string, number | null> }) {
  await db.transaction(async (tx) => {
    const { competition } = await beforeDraw(tx, actor, input.competitionId);
    const entries = await tx.select().from(teamEntries).where(eq(teamEntries.competitionId, competition.id));
    // Check the seeds as they will be after saving, including ones not being changed.
    const values = entries.map((e) => (e.id in input.seeds ? input.seeds[e.id] : e.seed)).filter((v): v is number => v !== null);
    if (values.some((v) => !Number.isInteger(v) || v < 1 || v > entries.length)) throw new AppError("BAD_SEED", `seeds run from 1 to ${entries.length}`, 422);
    if (new Set(values).size !== values.length) throw new AppError("BAD_SEED", "two teams have the same seed", 422);
    for (const e of entries) {
      if (e.id in input.seeds) await tx.update(teamEntries).set({ seed: input.seeds[e.id] }).where(eq(teamEntries.id, e.id));
    }
    await audit(tx, { leagueId: competition.leagueId, actor, action: "cup.seeds_set", entityType: "competition", entityId: competition.id, after: input.seeds });
  });
}

/**
 * Date a round (a cup night). Unplayed ties already in the round move with it.
 * Returns warnings, e.g. league fixtures already arranged that night.
 */
export async function setCupRoundDate(db: Db, actor: Actor, input: { roundId: string; date: string; kickOff: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.kickOff)) throw new AppError("BAD_DATE", "choose a date and a time", 422);
  return db.transaction(async (tx) => {
    const [round] = await tx.select().from(cupRounds).where(eq(cupRounds.id, input.roundId));
    if (!round) throw notFound("round");
    const { competition, league } = await loadCup(tx, round.competitionId);
    assertCan(actor, { action: "league.configure", leagueId: competition.leagueId });
    await tx.update(cupRounds).set({ scheduledOn: input.date, kickOff: input.kickOff }).where(eq(cupRounds.id, round.id));
    const at = zonedTimeToUtc(input.date, input.kickOff, league.timezone);
    const inRound = await tx.select().from(fixtures).where(eq(fixtures.cupRoundId, round.id));
    let moved = 0;
    for (const f of inRound.filter((f) => f.awayEntryId && (UNPLAYED as readonly string[]).includes(f.status) && f.scheduledAt.getTime() !== at.getTime())) {
      await bumpVersion(tx, f.id, { scheduledAt: at });
      moved++;
    }
    const sameNight = (await tx.select().from(fixtures).innerJoin(competitions, eq(competitions.id, fixtures.competitionId)).where(and(eq(competitions.seasonId, competition.seasonId), eq(competitions.kind, "LEAGUE"))))
      .filter(({ fixtures: f }) => !["VOID", "CANCELLED"].includes(f.status) && localDateInZone(f.scheduledAt, league.timezone) === input.date).length;
    await audit(tx, { leagueId: competition.leagueId, actor, action: "cup.round_dated", entityType: "cup_round", entityId: round.id, before: { scheduledOn: round.scheduledOn, kickOff: round.kickOff }, after: { scheduledOn: input.date, kickOff: input.kickOff, moved } });
    await advanceCup(tx, competition.id, actor);
    const warnings = sameNight ? [`${sameNight} league fixture${sameNight === 1 ? " is" : "s are"} already arranged that night`] : [];
    return { moved, warnings };
  });
}

// ---------------------------------------------------------------------------
// The draw
// ---------------------------------------------------------------------------

export interface DrawInput {
  competitionId: string;
  mode: DrawMode;
  /** Random/seeded: the seed the preview used, so the saved draw is the one shown. */
  rngSeed?: number;
  /** Manual: first-round ties in bracket order (null = bye). */
  manual?: { home: string | null; away: string | null }[];
}

export interface DrawResult {
  ties: { home: string; away: string | null }[];
  rngSeed: number | null;
}

async function computeDraw(db: Db, competitionId: string, input: DrawInput): Promise<{ ties: Tie[]; rngSeed: number | null; names: Map<string, string> }> {
  const entries = (await db.select().from(teamEntries).where(eq(teamEntries.competitionId, competitionId))).filter((e) => e.status === "ACTIVE");
  const names = new Map(entries.map((e) => [e.id, e.displayName]));
  try {
    if (input.mode === "MANUAL") return { ties: validateManualDraw(entries.map((e) => e.id), input.manual ?? []), rngSeed: null, names };
    const rngSeed = input.rngSeed ?? Math.floor(Math.random() * 2 ** 31);
    const ties = drawFirstRound(entries.map((e) => ({ entryId: e.id, seed: input.mode === "SEEDED" ? e.seed : null })), input.mode, rngSeed);
    return { ties, rngSeed, names };
  } catch (e) {
    if (e instanceof CupError) throw new AppError("BAD_DRAW", e.message, 422);
    throw e;
  }
}

/** What the draw would be, without saving anything. */
export async function previewDraw(db: Db, actor: Actor, input: DrawInput): Promise<DrawResult> {
  const { competition } = await loadCup(db, input.competitionId);
  assertCan(actor, { action: "league.configure", leagueId: competition.leagueId });
  const { ties, rngSeed, names } = await computeDraw(db, competition.id, input);
  return { ties: ties.map((t) => ({ home: names.get(t.home)!, away: t.away ? names.get(t.away)! : null })), rngSeed };
}

/** True while nothing in the cup has been played or arranged, so the draw can be made again. */
async function canRedraw(db: Db, competitionId: string): Promise<boolean> {
  const fs = await cupFixtures(db, competitionId);
  if (!fs.length) return true;
  const ids = fs.map((f) => f.id);
  const [g] = await db.select({ id: games.id }).from(games).where(inArray(games.fixtureId, ids)).limit(1);
  const [r] = await db.select({ id: fixtureRearrangements.id }).from(fixtureRearrangements).where(inArray(fixtureRearrangements.fixtureId, ids)).limit(1);
  return !g && !r && fs.every((f) => (f.awayEntryId ? f.status === "SCHEDULED" : true) && (f.roundNumber ?? 1) === 1);
}

/** Make (or, while nothing has been played, remake) the draw and create round 1. */
export async function makeDraw(db: Db, actor: Actor, input: DrawInput): Promise<DrawResult> {
  return db.transaction(async (tx) => {
    const { competition, league } = await loadCup(tx, input.competitionId);
    assertCan(actor, { action: "league.configure", leagueId: competition.leagueId });
    if (!(await canRedraw(tx, competition.id))) throw new AppError("CUP_STARTED", "cup matches have already been arranged or played, so the draw can't be made again", 409);
    await syncRounds(tx, competition.id);
    const [first] = await tx.select().from(cupRounds).where(and(eq(cupRounds.competitionId, competition.id), eq(cupRounds.ordinal, 1)));
    if (!first?.scheduledOn) throw new AppError("NO_ROUND_DATE", "set the date of the first round before the draw", 422);
    const { ties, rngSeed, names } = await computeDraw(tx, competition.id, input);

    const old = await cupFixtures(tx, competition.id);
    if (old.length) {
      await tx.delete(fixtureOutcomes).where(inArray(fixtureOutcomes.fixtureId, old.map((f) => f.id)));
      await tx.delete(fixtures).where(inArray(fixtures.id, old.map((f) => f.id)));
    }
    const at = zonedTimeToUtc(first.scheduledOn, first.kickOff, league.timezone);
    const now = new Date();
    await tx.insert(fixtures).values(
      ties.map((t, slot) => ({
        leagueId: competition.leagueId,
        competitionId: competition.id,
        cupRoundId: first.id,
        roundNumber: 1,
        bracketSlot: slot,
        homeEntryId: t.home,
        awayEntryId: t.away,
        scheduledAt: at,
        // A bye is decided the moment it is drawn.
        ...(t.away ? {} : { status: "COMPLETED" as const, completedAt: now }),
      })),
    );
    const readable = ties.map((t) => ({ home: names.get(t.home)!, away: t.away ? names.get(t.away)! : null }));
    await audit(tx, { leagueId: competition.leagueId, actor, action: old.length ? "cup.redrawn" : "cup.drawn", entityType: "competition", entityId: competition.id, after: { mode: input.mode, rngSeed, ties: readable } });
    const entrants = await tx.select().from(teamEntries).where(eq(teamEntries.competitionId, competition.id));
    await notify(tx, {
      leagueId: competition.leagueId,
      actor,
      to: { leagueAdmins: true, teamIds: entrants.map((e) => e.teamId) },
      event: { type: "cup.drawn", payload: { leagueSlug: league.slug, cup: competition.name, competitionId: competition.id } },
    });
    await advanceCup(tx, competition.id, actor);
    return { ties: readable, rngSeed };
  });
}

// ---------------------------------------------------------------------------
// Advancing winners
// ---------------------------------------------------------------------------

interface Winners {
  periods: LoadedPeriod[];
  tz: string;
  outcomes: (typeof fixtureOutcomes.$inferSelect)[];
}

/** The entry that goes through from a tie, or null while undecided. */
function winnerOf(f: FixtureRow | undefined, w: Winners): string | null {
  if (!f || f.status !== "COMPLETED") return null;
  if (!f.awayEntryId) return f.homeEntryId; // bye
  const key = w.periods.length ? periodFor(w.periods, localDateInZone(f.scheduledAt, w.tz)).rules.match.groups[0].key : "main";
  const o = w.outcomes.find((x) => x.fixtureId === f.id && x.groupKey === key);
  if (!o || o.winner === "DRAW") return null;
  return o.winner === "HOME" ? f.homeEntryId : f.awayEntryId;
}

async function unstarted(db: Db, f: FixtureRow): Promise<boolean> {
  if (!(UNPLAYED as readonly string[]).includes(f.status) || f.startedAt) return false;
  const gs = await db.select().from(games).where(eq(games.fixtureId, f.id));
  return gs.every((g) => g.status === "PENDING");
}

async function clearLineups(db: Db, f: FixtureRow) {
  const ids = (await db.select({ id: games.id }).from(games).where(eq(games.fixtureId, f.id))).map((g) => g.id);
  if (ids.length) {
    await db.delete(gamePlayers).where(inArray(gamePlayers.gameId, ids));
    await db.delete(games).where(inArray(games.id, ids));
  }
}

/** A tie involving a withdrawn team is awarded straight away to the other team. */
async function awardIfWithdrawn(db: Db, f: FixtureRow, status: Map<string, string>, actor: Actor | null): Promise<boolean> {
  if (!f.awayEntryId) return false;
  const homeOut = status.get(f.homeEntryId) !== "ACTIVE";
  const awayOut = status.get(f.awayEntryId) !== "ACTIVE";
  if (homeOut === awayOut) return false;
  const ctx = await loadFixtureContext(db, f.id);
  await db.delete(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, f.id));
  for (const [key, o] of Object.entries(awardedOutcomes(homeOut ? "AWAY" : "HOME", ctx.rules))) await writeOutcome(db, f.id, key, o, "AWARDED", actor);
  await bumpVersion(db, f.id, { status: "COMPLETED", completedAt: new Date() });
  return true;
}

/**
 * Bring the bracket up to date: create each tie once both earlier ties are
 * decided (and its round has a date), re-point unstarted ties whose earlier
 * result changed, and remove unstarted ties whose earlier result is no longer
 * decided. Ties already under way are never changed; they are reported back.
 */
export async function advanceCup(db: Db, competitionId: string, actor: Actor | null): Promise<{ created: number; updated: number; removed: number; conflicts: string[] }> {
  const { competition, league } = await loadCup(db, competitionId);
  const rounds = await db.select().from(cupRounds).where(eq(cupRounds.competitionId, competitionId)).orderBy(asc(cupRounds.ordinal));
  const all = await cupFixtures(db, competitionId);
  if (!all.length) return { created: 0, updated: 0, removed: 0, conflicts: [] };
  const entries = await db.select().from(teamEntries).where(eq(teamEntries.competitionId, competitionId));
  const status = new Map(entries.map((e) => [e.id, e.status as string]));
  const name = (id: string | null) => entries.find((e) => e.id === id)?.displayName ?? "?";
  const w: Winners = {
    periods: await loadRulePeriods(db, competitionId).catch(() => []),
    tz: league.timezone,
    outcomes: await db.select().from(fixtureOutcomes).where(inArray(fixtureOutcomes.fixtureId, all.map((f) => f.id))),
  };
  const bySlot = new Map<string, FixtureRow>(all.map((f) => [`${f.roundNumber}:${f.bracketSlot}`, f]));
  const at = (r: number, i: number) => bySlot.get(`${r}:${i}`);
  const refreshOutcomes = async (id: string) => {
    w.outcomes = [...w.outcomes.filter((o) => o.fixtureId !== id), ...(await db.select().from(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, id)))];
  };

  // Withdrawn teams in round 1 lose their ties.
  for (const f of all.filter((f) => f.roundNumber === 1 && (UNPLAYED as readonly string[]).includes(f.status))) {
    if (await awardIfWithdrawn(db, f, status, actor)) {
      const [fresh] = await db.select().from(fixtures).where(eq(fixtures.id, f.id));
      bySlot.set(`1:${f.bracketSlot}`, fresh);
      await refreshOutcomes(f.id);
    }
  }

  let created = 0;
  let updated = 0;
  let removed = 0;
  const conflicts: string[] = [];
  const newTies: FixtureRow[] = [];
  for (const round of rounds.filter((r) => r.ordinal > 1)) {
    const ties = 2 ** (rounds.length - round.ordinal);
    for (let i = 0; i < ties; i++) {
      const home = winnerOf(at(round.ordinal - 1, 2 * i), w);
      const away = winnerOf(at(round.ordinal - 1, 2 * i + 1), w);
      const existing = at(round.ordinal, i);
      const label = `${round.name} tie ${i + 1}`;

      if (home && away) {
        if (!existing) {
          if (!round.scheduledOn) continue; // created once the round has a date
          const [f] = await db
            .insert(fixtures)
            .values({
              leagueId: competition.leagueId,
              competitionId,
              cupRoundId: round.id,
              roundNumber: round.ordinal,
              bracketSlot: i,
              homeEntryId: home,
              awayEntryId: away,
              scheduledAt: zonedTimeToUtc(round.scheduledOn, round.kickOff, league.timezone),
            })
            .returning();
          created++;
          if (await awardIfWithdrawn(db, f, status, actor)) await refreshOutcomes(f.id);
          else newTies.push(f);
          bySlot.set(`${round.ordinal}:${i}`, (await db.select().from(fixtures).where(eq(fixtures.id, f.id)))[0]);
        } else if (existing.homeEntryId !== home || existing.awayEntryId !== away) {
          if (await unstarted(db, existing)) {
            await clearLineups(db, existing);
            await db.update(fixtureRearrangements).set({ status: "OVERRIDDEN", respondedAt: new Date(), responseNote: "cup tie changed" }).where(and(eq(fixtureRearrangements.fixtureId, existing.id), eq(fixtureRearrangements.status, "PENDING")));
            await bumpVersion(db, existing.id, { homeEntryId: home, awayEntryId: away, status: "SCHEDULED", homeLineupConfirmedAt: null, awayLineupConfirmedAt: null });
            const [fresh] = await db.select().from(fixtures).where(eq(fixtures.id, existing.id));
            updated++;
            if (await awardIfWithdrawn(db, fresh, status, actor)) await refreshOutcomes(fresh.id);
            else newTies.push(fresh);
            bySlot.set(`${round.ordinal}:${i}`, (await db.select().from(fixtures).where(eq(fixtures.id, existing.id)))[0]);
          } else {
            conflicts.push(`${label} (${name(existing.homeEntryId)} v ${name(existing.awayEntryId)}) has already started, but an earlier result now sends ${name(home)} v ${name(away)} through`);
          }
        }
      } else if (existing) {
        const [hasRequest] = await db.select({ id: fixtureRearrangements.id }).from(fixtureRearrangements).where(eq(fixtureRearrangements.fixtureId, existing.id)).limit(1);
        if ((await unstarted(db, existing)) && !hasRequest) {
          await clearLineups(db, existing);
          await db.delete(fixtures).where(eq(fixtures.id, existing.id));
          bySlot.delete(`${round.ordinal}:${i}`);
          removed++;
        } else {
          conflicts.push(`${label} (${name(existing.homeEntryId)} v ${name(existing.awayEntryId)}) depends on an earlier tie that is no longer decided`);
        }
      }
    }
  }

  for (const f of newTies) {
    const ctx = await loadFixtureContext(db, f.id);
    const info = await fixtureInfo(db, ctx);
    const round = rounds.find((r) => r.ordinal === f.roundNumber)!;
    await notify(db, {
      leagueId: competition.leagueId,
      actor,
      to: { teamIds: [ctx.homeTeamId, ctx.awayTeamId] },
      event: { type: "cup.tie", payload: { ...info, cup: competition.name, round: round.name, scheduledAt: f.scheduledAt.toISOString() } },
    });
  }
  if (created || updated || removed || conflicts.length) {
    await audit(db, { leagueId: competition.leagueId, actor, action: "cup.advanced", entityType: "competition", entityId: competitionId, after: { created, updated, removed, conflicts } });
  }
  return { created, updated, removed, conflicts };
}

/** Call after any change to a fixture's result: in a cup, winners move on. */
export async function afterResultChange(db: Db, fixtureId: string, actor: Actor | null): Promise<void> {
  const [f] = await db.select({ competitionId: fixtures.competitionId, kind: competitions.kind }).from(fixtures).innerJoin(competitions, eq(competitions.id, fixtures.competitionId)).where(eq(fixtures.id, fixtureId));
  if (f?.kind === "CUP") await advanceCup(db, f.competitionId, actor);
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** The whole bracket, round by round, with each tie's winner, and the cup winner once the final is decided. */
export async function cupBracket(db: Db, competitionId: string) {
  const { competition, league, season } = await loadCup(db, competitionId);
  const rounds = await db.select().from(cupRounds).where(eq(cupRounds.competitionId, competitionId)).orderBy(asc(cupRounds.ordinal));
  const raw = await cupFixtures(db, competitionId);
  const list = raw.length ? await loadFixtures(db, eq(fixtures.competitionId, competitionId)) : [];
  const w: Winners = {
    periods: await loadRulePeriods(db, competitionId).catch(() => []),
    tz: league.timezone,
    outcomes: raw.length ? await db.select().from(fixtureOutcomes).where(inArray(fixtureOutcomes.fixtureId, raw.map((f) => f.id))) : [],
  };
  const out = rounds.map((r) => {
    const ties = Array.from({ length: 2 ** (rounds.length - r.ordinal) }, (_, i) => {
      const f = list.find((x) => x.roundNumber === r.ordinal && x.bracketSlot === i);
      const row = raw.find((x) => x.id === f?.id);
      return f ? { ...f, winnerEntryId: winnerOf(row, w) } : null;
    });
    return { id: r.id, ordinal: r.ordinal, name: r.name, scheduledOn: r.scheduledOn, kickOff: r.kickOff, ties };
  });
  const final = out.at(-1)?.ties[0];
  const champion = final?.winnerEntryId ? (final.home.entryId === final.winnerEntryId ? final.home : final.away) : null;
  return { competition, league, season, rounds: out, drawn: raw.length > 0, champion };
}

/** Everything the cup admin page needs. */
export async function cupAdmin(db: Db, actor: Actor, competitionId: string) {
  const bracket = await cupBracket(db, competitionId);
  assertCan(actor, { action: "league.configure", leagueId: bracket.competition.leagueId });
  const entries = await db
    .select({ entry: teamEntries, team: teams })
    .from(teamEntries)
    .innerJoin(teams, eq(teams.id, teamEntries.teamId))
    .where(eq(teamEntries.competitionId, competitionId))
    .orderBy(asc(teamEntries.displayName));
  const leagueTeams = await db.select().from(teams).where(eq(teams.leagueId, bracket.competition.leagueId)).orderBy(asc(teams.name));
  return {
    ...bracket,
    entries,
    otherTeams: leagueTeams.filter((t) => !t.archivedAt && !entries.some((e) => e.team.id === t.id)),
    canRedraw: await canRedraw(db, competitionId),
  };
}

/** Cup nights in a season, for the league fixture generator and date-change warnings. */
export async function seasonCupNights(db: Db, seasonId: string) {
  return db
    .select({ round: cupRounds, competition: competitions })
    .from(cupRounds)
    .innerJoin(competitions, eq(competitions.id, cupRounds.competitionId))
    .where(eq(competitions.seasonId, seasonId));
}
