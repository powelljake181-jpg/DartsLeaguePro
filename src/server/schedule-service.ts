import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  blackoutDates,
  competitions,
  fixtureRearrangements,
  fixtures,
  games,
  leagues,
  schedulingConstraints,
  schedulingConstraintTeams,
  seasons,
  teamEntries,
  teams,
  venues,
} from "@/db/schema";
import { zonedTimeToUtc } from "@/domain/dates";
import { assertCan, type Actor } from "@/domain/permissions";
import { generateSchedule, longRuns, SchedulingError, type ConstraintInput, type DivisionInput, type ScheduleResult } from "@/domain/scheduling";
import { audit } from "./context";
import { seasonCupNights } from "./cup-service";
import { AppError, notFound } from "./errors";

/**
 * Season calendar (blackout dates), venue constraints, and generating /
 * publishing league fixtures. Generation is previewed first and nothing is
 * written until the admin publishes.
 */

async function seasonFor(db: Db, actor: Actor, seasonId: string) {
  const [season] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
  if (!season) throw notFound("season");
  assertCan(actor, { action: "league.configure", leagueId: season.leagueId });
  const [league] = await db.select().from(leagues).where(eq(leagues.id, season.leagueId));
  return { season, league };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "choose a date");

// ---------------------------------------------------------------------------
// Blackout dates
// ---------------------------------------------------------------------------

export async function addBlackoutDate(
  db: Db,
  actor: Actor,
  input: { seasonId: string; date: string; kind: "CUP" | "BREAK" | "OTHER"; reason: string; competitionId?: string },
) {
  const data = z
    .object({ date: isoDate, kind: z.enum(["CUP", "BREAK", "OTHER"]), reason: z.string().trim().min(1, "say why, e.g. 'Christmas'").max(120) })
    .safeParse(input);
  if (!data.success) throw new AppError("INVALID_INPUT", data.error.issues[0].message, 422);
  return db.transaction(async (tx) => {
    const { season } = await seasonFor(tx, actor, input.seasonId);
    if (input.competitionId) {
      const [c] = await tx.select().from(competitions).where(eq(competitions.id, input.competitionId));
      if (!c || c.seasonId !== season.id) throw notFound("division");
    }
    const [row] = await tx
      .insert(blackoutDates)
      .values({ seasonId: season.id, competitionId: input.competitionId || null, ...data.data })
      .returning();
    await audit(tx, { leagueId: season.leagueId, actor, action: "calendar.blackout_added", entityType: "season", entityId: season.id, after: row });
    return row;
  });
}

export async function removeBlackoutDate(db: Db, actor: Actor, blackoutId: string) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(blackoutDates).where(eq(blackoutDates.id, blackoutId));
    if (!row) throw notFound("date");
    const { season } = await seasonFor(tx, actor, row.seasonId);
    await tx.delete(blackoutDates).where(eq(blackoutDates.id, blackoutId));
    await audit(tx, { leagueId: season.leagueId, actor, action: "calendar.blackout_removed", entityType: "season", entityId: season.id, before: row });
  });
}

// ---------------------------------------------------------------------------
// Venue constraints
// ---------------------------------------------------------------------------

export async function createConstraint(
  db: Db,
  actor: Actor,
  input: { seasonId: string; name: string; teamIds: string[]; maxHome: number; venueId?: string },
) {
  const data = z
    .object({
      name: z.string().trim().min(1, "name the constraint, e.g. the pub").max(120),
      teamIds: z.array(z.string().uuid()).min(2, "choose at least two teams"),
      maxHome: z.coerce.number().int().min(1, "at least one team must be allowed at home"),
    })
    .safeParse(input);
  if (!data.success) throw new AppError("INVALID_INPUT", data.error.issues[0].message, 422);
  if (data.data.maxHome >= new Set(data.data.teamIds).size) {
    throw new AppError("INVALID_INPUT", "the limit must be lower than the number of teams, or there's nothing to constrain", 422);
  }
  return db.transaction(async (tx) => {
    const { season } = await seasonFor(tx, actor, input.seasonId);
    const teamRows = await tx.select().from(teams).where(inArray(teams.id, [...new Set(data.data.teamIds)]));
    if (teamRows.length !== new Set(data.data.teamIds).size || teamRows.some((t) => t.leagueId !== season.leagueId)) throw notFound("team");
    const [constraint] = await tx
      .insert(schedulingConstraints)
      .values({ seasonId: season.id, name: data.data.name, maxHomePerDate: data.data.maxHome, venueId: input.venueId || null })
      .returning();
    await tx.insert(schedulingConstraintTeams).values(teamRows.map((t) => ({ constraintId: constraint.id, teamId: t.id })));
    await audit(tx, {
      leagueId: season.leagueId,
      actor,
      action: "calendar.constraint_added",
      entityType: "season",
      entityId: season.id,
      after: { name: constraint.name, teams: teamRows.map((t) => t.name), maxHome: constraint.maxHomePerDate },
    });
    return constraint;
  });
}

export async function deleteConstraint(db: Db, actor: Actor, constraintId: string) {
  await db.transaction(async (tx) => {
    const [c] = await tx.select().from(schedulingConstraints).where(eq(schedulingConstraints.id, constraintId));
    if (!c) throw notFound("constraint");
    const { season } = await seasonFor(tx, actor, c.seasonId);
    await tx.delete(schedulingConstraintTeams).where(eq(schedulingConstraintTeams.constraintId, c.id));
    await tx.delete(schedulingConstraints).where(eq(schedulingConstraints.id, c.id));
    await audit(tx, { leagueId: season.leagueId, actor, action: "calendar.constraint_removed", entityType: "season", entityId: season.id, before: { name: c.name } });
  });
}

/** The season's calendar settings, for the schedule page. */
export async function seasonCalendar(db: Db, seasonId: string) {
  const blackouts = await db.select().from(blackoutDates).where(eq(blackoutDates.seasonId, seasonId)).orderBy(asc(blackoutDates.date));
  const constraintRows = await db.select().from(schedulingConstraints).where(eq(schedulingConstraints.seasonId, seasonId));
  const members = constraintRows.length
    ? await db
        .select({ constraintId: schedulingConstraintTeams.constraintId, team: teams })
        .from(schedulingConstraintTeams)
        .innerJoin(teams, eq(teams.id, schedulingConstraintTeams.teamId))
        .where(inArray(schedulingConstraintTeams.constraintId, constraintRows.map((c) => c.id)))
    : [];
  return {
    blackouts,
    constraints: constraintRows.map((c) => ({ ...c, teams: members.filter((m) => m.constraintId === c.id).map((m) => m.team) })),
  };
}

/**
 * Suggested constraints: teams entered this season that share a home venue
 * and aren't already covered by a constraint together.
 */
export async function suggestVenueConstraints(db: Db, seasonId: string) {
  const entries = await db
    .select({ entry: teamEntries, venue: venues })
    .from(teamEntries)
    .innerJoin(competitions, eq(competitions.id, teamEntries.competitionId))
    .innerJoin(venues, eq(venues.id, teamEntries.venueId))
    .where(and(eq(competitions.seasonId, seasonId), eq(competitions.kind, "LEAGUE")));
  const { constraints } = await seasonCalendar(db, seasonId);
  const byVenue = new Map<string, { venue: typeof venues.$inferSelect; teams: { id: string; name: string }[] }>();
  for (const { entry, venue } of entries) {
    const g = byVenue.get(venue.id) ?? { venue, teams: [] };
    g.teams.push({ id: entry.teamId, name: entry.displayName });
    byVenue.set(venue.id, g);
  }
  return [...byVenue.values()]
    .filter((g) => g.teams.length >= 2)
    .filter((g) => !constraints.some((c) => g.teams.every((t) => c.teams.some((ct) => ct.id === t.id))));
}

// ---------------------------------------------------------------------------
// Generating fixtures
// ---------------------------------------------------------------------------

export interface ScheduleRequest {
  seasonId: string;
  competitionIds: string[];
  startDate: string;
  meetings: number;
  /** Local kick-off time, HH:MM. */
  kickoff: string;
  seed: number;
}

const requestSchema = z.object({
  seasonId: z.string().uuid(),
  competitionIds: z.array(z.string().uuid()).min(1, "choose at least one division"),
  startDate: isoDate,
  meetings: z.coerce.number().int().min(1).max(6),
  kickoff: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "enter a kick-off time like 19:30"),
  seed: z.coerce.number().int(),
});

export interface SchedulePreview {
  result: ScheduleResult;
  divisions: { id: string; name: string; teamCount: number; rounds: number; firstDate: string; lastDate: string }[];
  teamNames: Record<string, string>;
  /** Home games per team (by entry id), to show balance. */
  homeCounts: Record<string, number>;
  /** Times a team plays a third (or more) home or away game in a row. */
  longRuns: number;
  /** Divisions that already have fixtures, and whether any have been played. */
  existing: { competitionId: string; count: number; played: boolean }[];
}

async function buildInputs(db: Db, actor: Actor, raw: ScheduleRequest) {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("INVALID_INPUT", parsed.error.issues[0].message, 422);
  const req = parsed.data;
  const { season, league } = await seasonFor(db, actor, req.seasonId);

  const comps = await db.select().from(competitions).where(inArray(competitions.id, req.competitionIds));
  if (comps.length !== new Set(req.competitionIds).size || comps.some((c) => c.seasonId !== season.id || c.kind !== "LEAGUE")) {
    throw notFound("division");
  }
  const entries = await db
    .select()
    .from(teamEntries)
    .where(and(inArray(teamEntries.competitionId, comps.map((c) => c.id)), eq(teamEntries.status, "ACTIVE")));
  const blackouts = await db
    .select()
    .from(blackoutDates)
    .where(and(eq(blackoutDates.seasonId, season.id), or(isNull(blackoutDates.competitionId), inArray(blackoutDates.competitionId, comps.map((c) => c.id)))));

  // Cup nights are kept free of league fixtures, like any other blackout date.
  const cupNights = (await seasonCupNights(db, season.id)).flatMap((n) => (n.round.scheduledOn ? [n.round.scheduledOn] : []));
  const divisions: DivisionInput[] = comps.map((c) => {
    if (c.matchWeekday === null) throw new AppError("NO_MATCH_NIGHT", `set a match night for ${c.name} first`, 422);
    return {
      id: c.id,
      name: c.name,
      teams: entries.filter((e) => e.competitionId === c.id).map((e) => e.id),
      weekday: c.matchWeekday,
      startDate: req.startDate,
      meetings: req.meetings,
      excludedDates: [...blackouts.filter((b) => !b.competitionId || b.competitionId === c.id).map((b) => b.date), ...cupNights],
    };
  });

  // Constraints are stored by team; the generator works with entries.
  const { constraints } = await seasonCalendar(db, season.id);
  const entryOfTeam = new Map(entries.map((e) => [e.teamId, e.id]));
  const constraintInputs: ConstraintInput[] = constraints.map((c) => ({
    id: c.id,
    name: c.name,
    maxHome: c.maxHomePerDate,
    teams: c.teams.map((t) => entryOfTeam.get(t.id)).filter((x): x is string => !!x),
  }));
  return { req, season, league, comps, entries, divisions, constraintInputs };
}

function run(divisions: DivisionInput[], constraints: ConstraintInput[], seed: number) {
  try {
    return generateSchedule(divisions, constraints, { seed });
  } catch (e) {
    if (e instanceof SchedulingError) throw new AppError("CANNOT_SCHEDULE", e.message, 422);
    throw e;
  }
}

async function existingFixtures(db: Db, competitionIds: string[]) {
  const rows = await db.select().from(fixtures).where(inArray(fixtures.competitionId, competitionIds));
  const withGames = rows.length
    ? new Set((await db.select({ fixtureId: games.fixtureId }).from(games).where(inArray(games.fixtureId, rows.map((r) => r.id)))).map((g) => g.fixtureId))
    : new Set<string>();
  return competitionIds
    .map((competitionId) => {
      const mine = rows.filter((r) => r.competitionId === competitionId);
      const played = mine.some((f) => !["SCHEDULED", "POSTPONED", "REARRANGEMENT_REQUESTED"].includes(f.status) || withGames.has(f.id));
      return { competitionId, count: mine.length, played, ids: mine.map((f) => f.id) };
    })
    .filter((e) => e.count > 0);
}

/** Generate fixtures without saving anything. */
export async function previewSchedule(db: Db, actor: Actor, raw: ScheduleRequest): Promise<SchedulePreview> {
  const { req, comps, entries, divisions, constraintInputs } = await buildInputs(db, actor, raw);
  const result = run(divisions, constraintInputs, req.seed);
  const homeCounts: Record<string, number> = {};
  for (const f of result.fixtures) homeCounts[f.home] = (homeCounts[f.home] ?? 0) + 1;
  return {
    result,
    divisions: divisions.map((d) => ({
      id: d.id,
      name: comps.find((c) => c.id === d.id)!.name,
      teamCount: d.teams.length,
      rounds: result.dates[d.id].length,
      firstDate: result.dates[d.id][0],
      lastDate: result.dates[d.id].at(-1)!,
    })),
    teamNames: Object.fromEntries(entries.map((e) => [e.id, e.displayName])),
    homeCounts,
    longRuns: longRuns(result.fixtures),
    existing: (await existingFixtures(db, comps.map((c) => c.id))).map((e) => ({ competitionId: e.competitionId, count: e.count, played: e.played })),
  };
}

/**
 * Save a generated schedule. The same request and seed reproduce exactly the
 * previewed fixtures. Refuses to overwrite played fixtures, and requires an
 * explicit acknowledgement to publish with venue clashes.
 */
export async function publishSchedule(
  db: Db,
  actor: Actor,
  raw: ScheduleRequest & { replaceExisting: boolean; acknowledgeConflicts: boolean },
) {
  return db.transaction(async (tx) => {
    const { req, season, league, comps, entries, divisions, constraintInputs } = await buildInputs(tx, actor, raw);
    const result = run(divisions, constraintInputs, req.seed);
    if (result.conflicts.length && !raw.acknowledgeConflicts) {
      throw new AppError("SCHEDULE_HAS_CLASHES", `this schedule has ${result.conflicts.length} venue clash(es); fix them or confirm you'll rearrange those fixtures`, 409, result.conflicts);
    }

    const existing = await existingFixtures(tx, comps.map((c) => c.id));
    if (existing.some((e) => e.played)) {
      throw new AppError("FIXTURES_PLAYED", "a division already has fixtures that have started; its schedule can't be regenerated", 409);
    }
    if (existing.length && !raw.replaceExisting) {
      throw new AppError("FIXTURES_EXIST", "these divisions already have fixtures; choose to replace them", 409);
    }
    const oldIds = existing.flatMap((e) => e.ids);
    if (oldIds.length) {
      const requests = await tx.select({ id: fixtureRearrangements.id }).from(fixtureRearrangements).where(inArray(fixtureRearrangements.fixtureId, oldIds));
      if (requests.length) throw new AppError("FIXTURES_IN_USE", "some fixtures have rearrangement requests; resolve those first", 409);
      await tx.delete(fixtures).where(inArray(fixtures.id, oldIds));
    }

    const venueOf = new Map(entries.map((e) => [e.id, e.venueId]));
    const rows = result.fixtures.map((f) => ({
      leagueId: league.id,
      competitionId: f.divisionId,
      roundNumber: f.round,
      homeEntryId: f.home,
      awayEntryId: f.away,
      scheduledAt: zonedTimeToUtc(f.date, req.kickoff, league.timezone),
      venueId: venueOf.get(f.home) ?? null,
    }));
    for (let i = 0; i < rows.length; i += 500) await tx.insert(fixtures).values(rows.slice(i, i + 500));

    await audit(tx, {
      leagueId: league.id,
      actor,
      action: "schedule.published",
      entityType: "season",
      entityId: season.id,
      after: {
        divisions: comps.map((c) => c.name),
        fixtures: rows.length,
        replaced: oldIds.length,
        startDate: req.startDate,
        meetings: req.meetings,
        kickoff: req.kickoff,
        seed: req.seed,
        clashesAccepted: result.conflicts,
      },
    });
    return { fixtures: rows.length, replaced: oldIds.length, conflicts: result.conflicts };
  });
}

/** Fixtures for a season's league divisions, for the admin fixture list. */
export async function seasonFixtures(db: Db, seasonId: string) {
  const comps = await db.select().from(competitions).where(and(eq(competitions.seasonId, seasonId), eq(competitions.kind, "LEAGUE")));
  if (!comps.length) return { competitions: comps, fixtures: [], names: {} as Record<string, string>, venues: {} as Record<string, string> };
  const rows = await db.select().from(fixtures).where(inArray(fixtures.competitionId, comps.map((c) => c.id))).orderBy(asc(fixtures.scheduledAt), asc(fixtures.roundNumber));
  const entryRows = await db.select().from(teamEntries).where(inArray(teamEntries.competitionId, comps.map((c) => c.id)));
  const venueRows = await db.select().from(venues).where(eq(venues.leagueId, comps[0].leagueId));
  return {
    competitions: comps,
    fixtures: rows,
    names: Object.fromEntries(entryRows.map((e) => [e.id, e.displayName])) as Record<string, string>,
    venues: Object.fromEntries(venueRows.map((v) => [v.id, v.name])) as Record<string, string>,
  };
}
