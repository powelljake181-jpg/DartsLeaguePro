import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  auditLog,
  competitionRulePeriods,
  competitions,
  divisions,
  fixtures,
  gamePlayers,
  games,
  leagueMemberships,
  legs,
  leagues,
  playerRegistrations,
  players,
  rulesets,
  seasons,
  teamEntries,
  teamMemberships,
  teams,
  users,
  venues,
  visits,
} from "@/db/schema";
import { ForbiddenError, type Actor } from "@/domain/permissions";
import { parseRules } from "@/domain/rules";
import { loadFixtureContext } from "./context";
import { notFound } from "./errors";

/** Read models for the admin pages. Each checks the actor can see the league. */

export const isLeagueAdmin = (actor: Actor, leagueId: string) => actor.isPlatformAdmin || actor.leagueAdminOf.has(leagueId);

/** Leagues and teams the actor administers. */
export async function adminScope(db: Db, actor: Actor) {
  const leagueRows = actor.isPlatformAdmin
    ? await db.select().from(leagues).orderBy(asc(leagues.name))
    : actor.leagueAdminOf.size
      ? await db.select().from(leagues).where(inArray(leagues.id, [...actor.leagueAdminOf])).orderBy(asc(leagues.name))
      : [];
  const teamRows = actor.teamAdminOf.size
    ? await db
        .select({ team: teams, league: leagues })
        .from(teams)
        .innerJoin(leagues, eq(leagues.id, teams.leagueId))
        .where(inArray(teams.id, [...actor.teamAdminOf]))
        .orderBy(asc(teams.name))
    : [];
  return { leagues: leagueRows, teams: teamRows };
}

/** A league by slug, if the actor administers it or one of its teams. */
export async function adminLeague(db: Db, actor: Actor, slug: string) {
  const [league] = await db.select().from(leagues).where(eq(leagues.slug, slug));
  if (!league) throw notFound("league");
  const leagueAdmin = isLeagueAdmin(actor, league.id);
  const myTeams = leagueAdmin
    ? []
    : await db
        .select()
        .from(teams)
        .where(and(eq(teams.leagueId, league.id), inArray(teams.id, actor.teamAdminOf.size ? [...actor.teamAdminOf] : ["00000000-0000-0000-0000-000000000000"])));
  if (!leagueAdmin && myTeams.length === 0) throw new ForbiddenError();
  return { league, leagueAdmin, myTeams };
}

export async function leagueSetup(db: Db, leagueId: string) {
  const [seasonRows, divisionRows, venueRows, teamRows] = await Promise.all([
    db.select().from(seasons).where(eq(seasons.leagueId, leagueId)).orderBy(desc(seasons.startsOn)),
    db.select().from(divisions).where(eq(divisions.leagueId, leagueId)).orderBy(asc(divisions.rank)),
    db.select().from(venues).where(eq(venues.leagueId, leagueId)).orderBy(asc(venues.name)),
    db.select().from(teams).where(eq(teams.leagueId, leagueId)).orderBy(asc(teams.name)),
  ]);
  return { seasons: seasonRows, divisions: divisionRows, venues: venueRows, teams: teamRows };
}

/** A season's divisions, their competitions, entered teams and teams not yet placed. */
export async function seasonSetup(db: Db, leagueId: string, seasonId: string) {
  const [season] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
  if (!season || season.leagueId !== leagueId) throw notFound("season");
  const { divisions: divisionRows, teams: teamRows } = await leagueSetup(db, leagueId);
  const comps = await db
    .select()
    .from(competitions)
    .where(and(eq(competitions.seasonId, seasonId), eq(competitions.kind, "LEAGUE")));
  const entries = comps.length
    ? await db.select().from(teamEntries).where(inArray(teamEntries.competitionId, comps.map((c) => c.id)))
    : [];
  const placed = new Set(entries.map((e) => e.teamId));
  return {
    season,
    divisions: divisionRows.map((d) => {
      const competition = comps.find((c) => c.divisionId === d.id) ?? null;
      return {
        division: d,
        competition,
        entries: competition ? entries.filter((e) => e.competitionId === competition.id).sort((a, b) => a.displayName.localeCompare(b.displayName)) : [],
      };
    }),
    unplacedTeams: teamRows.filter((t) => !placed.has(t.id) && !t.archivedAt),
  };
}

/** A competition's rules timeline, newest last. */
export async function competitionRules(db: Db, leagueId: string, competitionId: string) {
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, competitionId));
  if (!competition || competition.leagueId !== leagueId) throw notFound("competition");
  const [season] = await db.select().from(seasons).where(eq(seasons.id, competition.seasonId));
  const rows = await db
    .select({ period: competitionRulePeriods, ruleset: rulesets, by: users.name })
    .from(competitionRulePeriods)
    .innerJoin(rulesets, eq(rulesets.id, competitionRulePeriods.rulesetId))
    .leftJoin(users, eq(users.id, competitionRulePeriods.createdBy))
    .where(eq(competitionRulePeriods.competitionId, competitionId))
    .orderBy(asc(competitionRulePeriods.effectiveFrom));
  return {
    competition,
    season,
    periods: rows.map((r) => ({
      effectiveFrom: r.period.effectiveFrom,
      reason: r.period.reason,
      by: r.by,
      createdAt: r.period.createdAt,
      version: r.ruleset.version,
      rules: parseRules(r.ruleset.config),
    })),
  };
}

/** A team's squad for a season, with the team and the season's registration settings. */
export async function teamSquad(db: Db, actor: Actor, teamId: string, seasonId: string | null) {
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) throw notFound("team");
  if (!isLeagueAdmin(actor, team.leagueId) && !actor.teamAdminOf.has(team.id)) throw new ForbiddenError();
  const seasonRows = await db.select().from(seasons).where(eq(seasons.leagueId, team.leagueId)).orderBy(desc(seasons.startsOn));
  const season = seasonRows.find((s) => s.id === seasonId) ?? seasonRows.find((s) => s.status === "ACTIVE") ?? seasonRows[0] ?? null;
  const squad = season
    ? await db
        .select({ registration: playerRegistrations, player: players })
        .from(playerRegistrations)
        .innerJoin(players, eq(players.id, playerRegistrations.playerId))
        .where(and(eq(playerRegistrations.teamId, teamId), eq(playerRegistrations.seasonId, season.id)))
        .orderBy(asc(players.lastName), asc(players.firstName))
    : [];
  const [venue] = team.homeVenueId ? await db.select().from(venues).where(eq(venues.id, team.homeVenueId)) : [];
  return { team, venue: venue ?? null, seasons: seasonRows, season, squad };
}

/** League admins, team admins (by team) for a league. */
export async function leaguePeople(db: Db, leagueId: string) {
  const leagueAdmins = await db
    .select({ membership: leagueMemberships, user: { id: users.id, name: users.name, email: users.email } })
    .from(leagueMemberships)
    .innerJoin(users, eq(users.id, leagueMemberships.userId))
    .where(and(eq(leagueMemberships.leagueId, leagueId), isNull(leagueMemberships.revokedAt)))
    .orderBy(asc(users.name));
  const teamAdmins = await db
    .select({ membership: teamMemberships, team: { id: teams.id, name: teams.name }, user: { id: users.id, name: users.name, email: users.email } })
    .from(teamMemberships)
    .innerJoin(teams, eq(teams.id, teamMemberships.teamId))
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(and(eq(teams.leagueId, leagueId), isNull(teamMemberships.revokedAt)))
    .orderBy(asc(teams.name), asc(users.name));
  return { leagueAdmins, teamAdmins };
}

export async function teamAdmins(db: Db, teamId: string) {
  return db
    .select({ membership: teamMemberships, user: { id: users.id, name: users.name, email: users.email } })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(and(eq(teamMemberships.teamId, teamId), isNull(teamMemberships.revokedAt)))
    .orderBy(asc(users.name));
}

export async function recentAudit(db: Db, leagueId: string, limit = 50) {
  return db
    .select({ entry: auditLog, actorName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(eq(auditLog.leagueId, leagueId))
    .orderBy(desc(auditLog.id))
    .limit(limit);
}

/**
 * Everything the fixture admin page needs: both squads, the current lineup
 * selections, and which sides the actor may edit. A team admin sees the
 * opponent's lineup only once both lineups are confirmed.
 */
export async function fixtureAdmin(db: Db, actor: Actor, fixtureId: string) {
  const ctx = await loadFixtureContext(db, fixtureId);
  const leagueAdmin = isLeagueAdmin(actor, ctx.fixture.leagueId);
  const canEdit = {
    HOME: leagueAdmin || actor.teamAdminOf.has(ctx.homeTeamId),
    AWAY: leagueAdmin || actor.teamAdminOf.has(ctx.awayTeamId),
  };
  if (!canEdit.HOME && !canEdit.AWAY) throw new ForbiddenError();
  const scorerTeamId = ctx.responsibleSide === "HOME" ? ctx.homeTeamId : ctx.awayTeamId;
  const canScore = leagueAdmin || actor.teamAdminOf.has(scorerTeamId);

  const squad = async (teamId: string) =>
    db
      .select({ registrationId: playerRegistrations.id, player: players })
      .from(playerRegistrations)
      .innerJoin(players, eq(players.id, playerRegistrations.playerId))
      .where(and(eq(playerRegistrations.teamId, teamId), eq(playerRegistrations.seasonId, ctx.competition.seasonId), eq(playerRegistrations.status, "ACTIVE")))
      .orderBy(asc(players.firstName), asc(players.lastName));
  const [homeSquad, awaySquad] = await Promise.all([squad(ctx.homeTeamId), squad(ctx.awayTeamId)]);

  const gameRows = await db.select().from(games).where(eq(games.fixtureId, fixtureId)).orderBy(asc(games.ordinal));
  const picks = gameRows.length
    ? await db.select().from(gamePlayers).where(inArray(gamePlayers.gameId, gameRows.map((g) => g.id))).orderBy(asc(gamePlayers.position))
    : [];
  const bothConfirmed = !!ctx.fixture.homeLineupConfirmedAt && !!ctx.fixture.awayLineupConfirmedAt;
  const lineup = (side: "HOME" | "AWAY") =>
    ctx.rules.match.slots.map((_, i) => {
      const game = gameRows.find((g) => g.ordinal === i + 1);
      return game ? picks.filter((p) => p.gameId === game.id && p.side === side).map((p) => p.registrationId) : [];
    });
  const visible = (side: "HOME" | "AWAY") => canEdit[side] || bothConfirmed || leagueAdmin;

  return {
    ctx,
    canEdit,
    canScore,
    leagueAdmin,
    slots: ctx.rules.match.slots,
    groups: ctx.rules.match.groups,
    squads: { HOME: homeSquad, AWAY: awaySquad },
    lineups: { HOME: visible("HOME") ? lineup("HOME") : null, AWAY: visible("AWAY") ? lineup("AWAY") : null },
    confirmed: { HOME: !!ctx.fixture.homeLineupConfirmedAt, AWAY: !!ctx.fixture.awayLineupConfirmedAt },
  };
}

/** A team's fixtures this season (for captains): upcoming first, then recent results. */
export async function teamFixtures(db: Db, teamId: string, seasonId: string) {
  const entryRows = await db
    .select({ entry: teamEntries })
    .from(teamEntries)
    .innerJoin(competitions, eq(competitions.id, teamEntries.competitionId))
    .where(and(eq(teamEntries.teamId, teamId), eq(competitions.seasonId, seasonId)));
  const entryIds = entryRows.map((e) => e.entry.id);
  if (!entryIds.length) return [];
  const rows = await db
    .select()
    .from(fixtures)
    .where(or(inArray(fixtures.homeEntryId, entryIds), inArray(fixtures.awayEntryId, entryIds)))
    .orderBy(asc(fixtures.scheduledAt));
  const allEntries = await db.select().from(teamEntries).where(inArray(teamEntries.competitionId, [...new Set(rows.map((r) => r.competitionId))]));
  const name = new Map(allEntries.map((e) => [e.id, e.displayName]));
  return rows.map((f) => ({
    fixture: f,
    home: entryIds.includes(f.homeEntryId),
    opponent: entryIds.includes(f.homeEntryId) ? (f.awayEntryId ? name.get(f.awayEntryId) : "Bye") : name.get(f.homeEntryId),
  }));
}

/**
 * Everything the score-correction page needs: each played game with its
 * players and every leg's current (non-voided) visits. League admins only.
 */
export async function fixtureCorrections(db: Db, actor: Actor, fixtureId: string) {
  const ctx = await loadFixtureContext(db, fixtureId);
  if (!isLeagueAdmin(actor, ctx.fixture.leagueId)) throw new ForbiddenError();
  const gameRows = (await db.select().from(games).where(eq(games.fixtureId, fixtureId)).orderBy(asc(games.ordinal))).filter(
    (g) => g.status === "COMPLETED" || g.status === "LIVE",
  );
  if (!gameRows.length) return { ctx, games: [] };
  const gameIds = gameRows.map((g) => g.id);
  const [lineup, legRows] = await Promise.all([
    db
      .select({ gp: gamePlayers, player: players })
      .from(gamePlayers)
      .innerJoin(players, eq(players.id, gamePlayers.playerId))
      .where(inArray(gamePlayers.gameId, gameIds))
      .orderBy(asc(gamePlayers.position)),
    db.select().from(legs).where(inArray(legs.gameId, gameIds)).orderBy(asc(legs.ordinal)),
  ]);
  const visitRows = legRows.length
    ? await db
        .select()
        .from(visits)
        .where(and(inArray(visits.legId, legRows.map((l) => l.id)), isNull(visits.voidedAt)))
        .orderBy(asc(visits.seq))
    : [];
  return {
    ctx,
    games: gameRows.map((g) => ({
      game: g,
      players: lineup
        .filter((l) => l.gp.gameId === g.id)
        .map((l) => ({ side: l.gp.side, playerId: l.player.id, name: `${l.player.firstName} ${l.player.lastName}` })),
      legs: legRows
        .filter((l) => l.gameId === g.id)
        .map((l) => ({
          leg: l,
          visits: visitRows
            .filter((v) => v.legId === l.id)
            .map((v) => ({ side: v.side, playerId: v.playerId, scored: v.entered, darts: v.isCheckout || v.isBust ? v.darts : null, isBust: v.isBust, isCheckout: v.isCheckout })),
        })),
    })),
  };
}
