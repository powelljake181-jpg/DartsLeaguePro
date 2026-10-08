import { and, eq, max } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import {
  competitionRulePeriods,
  competitions,
  divisions,
  leagueMemberships,
  leagues,
  playerRegistrations,
  players,
  rulesets,
  seasons,
  teamEntries,
  teams,
  venues,
  fixtures,
} from "@/db/schema";
import { endOfDayInZone } from "@/domain/dates";
import { assertCan, type Actor } from "@/domain/permissions";
import { rulesSchema } from "@/domain/rules";
import { audit } from "./context";
import { AppError, notFound } from "./errors";

/**
 * League set-up: leagues, seasons, divisions, venues, teams and the
 * competitions teams play in. Every write checks permissions against the
 * league resolved from the database and is audit logged.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "enter a date");
const name = (what: string) => z.string().trim().min(1, `enter the ${what}`).max(120);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new AppError("INVALID_INPUT", r.error.issues.map((i) => i.message).join("; "), 422, r.error.issues);
  return r.data;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['’]/g, "") // Bull's Head → bulls-head
    .replace(/&/g, " and ") // Crown & Anchor → crown-and-anchor
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "team";

async function leagueOf(db: Db, leagueId: string) {
  const [league] = await db.select().from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw notFound("league");
  return league;
}

// ---------------------------------------------------------------------------
// Leagues
// ---------------------------------------------------------------------------

const leagueInput = z.object({
  name: name("league name"),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase letters, numbers and dashes").max(60),
  timezone: z.string().refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz) || tz === "UTC", "unknown timezone"),
});

/** Platform admins create leagues; the creator may name a first league admin. */
export async function createLeague(db: Db, actor: Actor, input: z.input<typeof leagueInput> & { firstAdminUserId?: string }) {
  assertCan(actor, { action: "league.create" });
  const data = parse(leagueInput, input);
  return db.transaction(async (tx) => {
    const [clash] = await tx.select().from(leagues).where(eq(leagues.slug, data.slug));
    if (clash) throw new AppError("SLUG_TAKEN", "that web address is already used by another league", 409);
    const [league] = await tx.insert(leagues).values(data).returning();
    if (input.firstAdminUserId) {
      await tx.insert(leagueMemberships).values({ leagueId: league.id, userId: input.firstAdminUserId, role: "LEAGUE_ADMIN" });
    }
    await audit(tx, { leagueId: league.id, actor, action: "league.created", entityType: "league", entityId: league.id, after: data });
    return league;
  });
}

export async function updateLeague(db: Db, actor: Actor, leagueId: string, input: { name: string; timezone: string }) {
  const data = parse(leagueInput.pick({ name: true, timezone: true }), input);
  return db.transaction(async (tx) => {
    const before = await leagueOf(tx, leagueId);
    assertCan(actor, { action: "league.configure", leagueId });
    await tx.update(leagues).set(data).where(eq(leagues.id, leagueId));
    await audit(tx, { leagueId, actor, action: "league.updated", entityType: "league", entityId: leagueId, before: { name: before.name, timezone: before.timezone }, after: data });
  });
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

const seasonInput = z
  .object({
    name: name("season name"),
    startsOn: isoDate,
    endsOn: isoDate.optional().or(z.literal("").transform(() => undefined)),
    /** Last day team admins may register players (league-local date); empty = no deadline. */
    registrationDeadline: isoDate.optional().or(z.literal("").transform(() => undefined)),
    maxSquadSize: z.coerce.number().int().min(1).max(100).optional().or(z.literal("").transform(() => undefined)),
  })
  .refine((s) => !s.endsOn || s.endsOn >= s.startsOn, { message: "the season must end after it starts", path: ["endsOn"] });
export type SeasonInput = z.input<typeof seasonInput>;

export async function createSeason(db: Db, actor: Actor, leagueId: string, input: SeasonInput) {
  const data = parse(seasonInput, input);
  return db.transaction(async (tx) => {
    const league = await leagueOf(tx, leagueId);
    assertCan(actor, { action: "league.configure", leagueId });
    const [clash] = await tx.select().from(seasons).where(and(eq(seasons.leagueId, leagueId), eq(seasons.name, data.name)));
    if (clash) throw new AppError("SEASON_EXISTS", `there is already a season called ${data.name}`, 409);
    const [season] = await tx
      .insert(seasons)
      .values({
        leagueId,
        name: data.name,
        startsOn: data.startsOn,
        endsOn: data.endsOn ?? null,
        registrationClosesAt: data.registrationDeadline ? endOfDayInZone(data.registrationDeadline, league.timezone) : null,
        maxSquadSize: data.maxSquadSize ?? null,
      })
      .returning();
    await audit(tx, { leagueId, actor, action: "season.created", entityType: "season", entityId: season.id, after: data });
    return season;
  });
}

export async function updateSeason(db: Db, actor: Actor, seasonId: string, input: SeasonInput & { status?: "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED" }) {
  const data = parse(seasonInput, input);
  return db.transaction(async (tx) => {
    const [season] = await tx.select().from(seasons).where(eq(seasons.id, seasonId));
    if (!season) throw notFound("season");
    const league = await leagueOf(tx, season.leagueId);
    assertCan(actor, { action: "league.configure", leagueId: league.id });
    const patch = {
      name: data.name,
      startsOn: data.startsOn,
      endsOn: data.endsOn ?? null,
      registrationClosesAt: data.registrationDeadline ? endOfDayInZone(data.registrationDeadline, league.timezone) : null,
      maxSquadSize: data.maxSquadSize ?? null,
      ...(input.status ? { status: input.status } : {}),
    };
    await tx.update(seasons).set(patch).where(eq(seasons.id, seasonId));
    await audit(tx, {
      leagueId: league.id,
      actor,
      action: "season.updated",
      entityType: "season",
      entityId: seasonId,
      before: { name: season.name, startsOn: season.startsOn, endsOn: season.endsOn, registrationClosesAt: season.registrationClosesAt, maxSquadSize: season.maxSquadSize, status: season.status },
      after: patch,
    });
  });
}

// ---------------------------------------------------------------------------
// Divisions, venues, teams
// ---------------------------------------------------------------------------

export async function createDivision(db: Db, actor: Actor, leagueId: string, input: { name: string }) {
  const data = parse(z.object({ name: name("division name") }), input);
  return db.transaction(async (tx) => {
    await leagueOf(tx, leagueId);
    assertCan(actor, { action: "league.configure", leagueId });
    const [clash] = await tx.select().from(divisions).where(and(eq(divisions.leagueId, leagueId), eq(divisions.name, data.name)));
    if (clash) throw new AppError("DIVISION_EXISTS", `there is already a division called ${data.name}`, 409);
    const [{ top }] = await tx.select({ top: max(divisions.rank) }).from(divisions).where(eq(divisions.leagueId, leagueId));
    const [division] = await tx.insert(divisions).values({ leagueId, name: data.name, rank: (top ?? 0) + 1 }).returning();
    await audit(tx, { leagueId, actor, action: "division.created", entityType: "division", entityId: division.id, after: data });
    return division;
  });
}

export async function createVenue(db: Db, actor: Actor, leagueId: string, input: { name: string; address?: string }) {
  const data = parse(z.object({ name: name("venue name"), address: z.string().trim().max(300).optional() }), input);
  return db.transaction(async (tx) => {
    await leagueOf(tx, leagueId);
    assertCan(actor, { action: "league.configure", leagueId });
    const [venue] = await tx.insert(venues).values({ leagueId, name: data.name, address: data.address || null }).returning();
    await audit(tx, { leagueId, actor, action: "venue.created", entityType: "venue", entityId: venue.id, after: data });
    return venue;
  });
}

export async function createTeam(db: Db, actor: Actor, leagueId: string, input: { name: string; venueId?: string }) {
  const data = parse(z.object({ name: name("team name"), venueId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)) }), input);
  return db.transaction(async (tx) => {
    await leagueOf(tx, leagueId);
    assertCan(actor, { action: "league.configure", leagueId });
    if (data.venueId) {
      const [venue] = await tx.select().from(venues).where(eq(venues.id, data.venueId));
      if (!venue || venue.leagueId !== leagueId) throw notFound("venue");
    }
    const base = slugify(data.name);
    let slug = base;
    for (let i = 2; (await tx.select().from(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.slug, slug)))).length; i++) {
      slug = `${base}-${i}`;
    }
    const [team] = await tx.insert(teams).values({ leagueId, name: data.name, slug, homeVenueId: data.venueId ?? null }).returning();
    await audit(tx, { leagueId, actor, action: "team.created", entityType: "team", entityId: team.id, after: { ...data, slug } });
    return team;
  });
}

export async function updateTeam(db: Db, actor: Actor, teamId: string, input: { name: string; venueId?: string }) {
  const data = parse(z.object({ name: name("team name"), venueId: z.string().uuid().optional().or(z.literal("").transform(() => undefined)) }), input);
  return db.transaction(async (tx) => {
    const [team] = await tx.select().from(teams).where(eq(teams.id, teamId));
    if (!team) throw notFound("team");
    assertCan(actor, { action: "league.configure", leagueId: team.leagueId });
    if (data.venueId) {
      const [venue] = await tx.select().from(venues).where(eq(venues.id, data.venueId));
      if (!venue || venue.leagueId !== team.leagueId) throw notFound("venue");
    }
    // Renaming a team does not rewrite history: past seasons keep their team_entry display name.
    await tx.update(teams).set({ name: data.name, homeVenueId: data.venueId ?? null }).where(eq(teams.id, teamId));
    await audit(tx, { leagueId: team.leagueId, actor, action: "team.updated", entityType: "team", entityId: teamId, before: { name: team.name, venueId: team.homeVenueId }, after: data });
  });
}

// ---------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------

/** Create a division's league competition for a season, with its starting rules. */
export async function createLeagueCompetition(
  db: Db,
  actor: Actor,
  input: { seasonId: string; divisionId: string; rules: unknown; matchWeekday?: number | null },
) {
  const parsed = rulesSchema.safeParse(input.rules);
  if (!parsed.success) throw new AppError("INVALID_RULES", parsed.error.issues.map((i) => i.message).join("; "), 422, parsed.error.issues);
  return db.transaction(async (tx) => {
    const [season] = await tx.select().from(seasons).where(eq(seasons.id, input.seasonId));
    const [division] = await tx.select().from(divisions).where(eq(divisions.id, input.divisionId));
    if (!season || !division || season.leagueId !== division.leagueId) throw notFound("season or division");
    assertCan(actor, { action: "league.configure", leagueId: season.leagueId });
    const [clash] = await tx
      .select()
      .from(competitions)
      .where(and(eq(competitions.seasonId, season.id), eq(competitions.divisionId, division.id), eq(competitions.kind, "LEAGUE")));
    if (clash) throw new AppError("COMPETITION_EXISTS", `${division.name} is already set up for ${season.name}`, 409);

    const [{ latest }] = await tx
      .select({ latest: max(rulesets.version) })
      .from(rulesets)
      .where(and(eq(rulesets.leagueId, season.leagueId), eq(rulesets.name, division.name)));
    const [ruleset] = await tx
      .insert(rulesets)
      .values({ leagueId: season.leagueId, name: division.name, version: (latest ?? 0) + 1, config: parsed.data, createdBy: actor.userId })
      .returning();
    const [competition] = await tx
      .insert(competitions)
      .values({
        leagueId: season.leagueId,
        seasonId: season.id,
        kind: "LEAGUE",
        divisionId: division.id,
        name: division.name,
        matchWeekday: input.matchWeekday ?? null,
      })
      .returning();
    await tx
      .insert(competitionRulePeriods)
      .values({ competitionId: competition.id, rulesetId: ruleset.id, effectiveFrom: season.startsOn, reason: "initial rules", createdBy: actor.userId });
    await audit(tx, {
      leagueId: season.leagueId,
      actor,
      action: "competition.created",
      entityType: "competition",
      entityId: competition.id,
      after: { season: season.name, division: division.name, rules: parsed.data },
    });
    return competition;
  });
}

/** Enter a team into a competition. A team plays in one division per season. */
export async function addTeamToCompetition(db: Db, actor: Actor, input: { competitionId: string; teamId: string }) {
  return db.transaction(async (tx) => {
    const [competition] = await tx.select().from(competitions).where(eq(competitions.id, input.competitionId));
    const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId));
    if (!competition || !team || competition.leagueId !== team.leagueId) throw notFound("competition or team");
    assertCan(actor, { action: "league.configure", leagueId: competition.leagueId });
    if (competition.kind === "LEAGUE") {
      const already = await tx
        .select({ name: competitions.name })
        .from(teamEntries)
        .innerJoin(competitions, eq(competitions.id, teamEntries.competitionId))
        .where(and(eq(teamEntries.teamId, team.id), eq(competitions.seasonId, competition.seasonId), eq(competitions.kind, "LEAGUE")));
      if (already.length) throw new AppError("ALREADY_ENTERED", `${team.name} is already in ${already[0].name} this season`, 409);
    }
    const [entry] = await tx
      .insert(teamEntries)
      .values({ competitionId: competition.id, teamId: team.id, displayName: team.name, venueId: team.homeVenueId })
      .returning();
    await audit(tx, { leagueId: competition.leagueId, actor, action: "team.entered", entityType: "competition", entityId: competition.id, after: { teamId: team.id, team: team.name } });
    return entry;
  });
}

/** Take a team out of a competition before any fixtures exist. Afterwards, use the fold tools instead. */
export async function removeTeamFromCompetition(db: Db, actor: Actor, entryId: string) {
  await db.transaction(async (tx) => {
    const [entry] = await tx.select().from(teamEntries).where(eq(teamEntries.id, entryId));
    if (!entry) throw notFound("entry");
    const [competition] = await tx.select().from(competitions).where(eq(competitions.id, entry.competitionId));
    assertCan(actor, { action: "league.configure", leagueId: competition.leagueId });
    const home = await tx.select({ id: fixtures.id }).from(fixtures).where(eq(fixtures.homeEntryId, entryId)).limit(1);
    const away = await tx.select({ id: fixtures.id }).from(fixtures).where(eq(fixtures.awayEntryId, entryId)).limit(1);
    if (home.length || away.length) {
      throw new AppError("HAS_FIXTURES", "this team already has fixtures; withdraw it with the fold tools instead", 409);
    }
    await tx.delete(teamEntries).where(eq(teamEntries.id, entryId));
    await audit(tx, { leagueId: competition.leagueId, actor, action: "team.removed_from_competition", entityType: "competition", entityId: competition.id, before: { teamId: entry.teamId } });
  });
}

/** Correct a player's name (league admins). Players are never deleted. */
export async function renamePlayer(db: Db, actor: Actor, playerId: string, input: { firstName: string; lastName: string }) {
  const data = parse(z.object({ firstName: name("first name"), lastName: name("last name") }), input);
  await db.transaction(async (tx) => {
    const [player] = await tx.select().from(players).where(eq(players.id, playerId));
    if (!player) throw notFound("player");
    assertCan(actor, { action: "player.setStatus", leagueId: player.leagueId });
    await tx.update(players).set(data).where(eq(players.id, playerId));
    await audit(tx, { leagueId: player.leagueId, actor, action: "player.renamed", entityType: "player", entityId: playerId, before: { firstName: player.firstName, lastName: player.lastName }, after: data });
  });
}

/** End a registration (player leaves the team). History is kept. */
export async function endRegistration(db: Db, actor: Actor, registrationId: string, reason: string, now = new Date()) {
  await db.transaction(async (tx) => {
    const [reg] = await tx.select().from(playerRegistrations).where(eq(playerRegistrations.id, registrationId));
    if (!reg) throw notFound("registration");
    assertCan(actor, { action: "player.setStatus", leagueId: reg.leagueId });
    if (reg.status !== "ACTIVE") return;
    await tx.update(playerRegistrations).set({ status: "ENDED", endedAt: now, endedReason: reason || null }).where(eq(playerRegistrations.id, reg.id));
    await audit(tx, { leagueId: reg.leagueId, actor, action: "player.registration_ended", entityType: "player_registration", entityId: reg.id, reason });
  });
}
