import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  competitions,
  divisions,
  fixtureOutcomes,
  fixtures,
  gamePlayers,
  games,
  leagues,
  playerGameStats,
  playerRegistrations,
  players,
  seasons,
  teamEntries,
  teams,
  venues,
} from "@/db/schema";
import { localDateInZone, zonedTimeToUtc } from "@/domain/dates";
import { DEFAULT_BANDS, type ScoreBand } from "@/domain/rules";
import { periodFor } from "@/domain/rule-periods";
import type { Side } from "@/domain/scoring";
import type { StatTotals } from "@/domain/stats";
import { loadRulePeriods, type LoadedPeriod } from "./context";
import { notFound } from "./errors";
import { liveSnapshot } from "./live-service";
import { getTables, type Table } from "./standings-service";
import { playerStats, rowTotals, statsCountFixture } from "./stats-service";

/**
 * Read models for the public site. No login: everything here is public league
 * information. Draft seasons are hidden until their fixtures are published;
 * archived leagues are not listed.
 * Ids from the URL are checked for shape first so a bad link is a 404, not a
 * database error.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

export const playerName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`;

/**
 * A season is public once it is no longer a draft, or as soon as its fixtures
 * are published (fixtures only exist after publishing), whichever comes first.
 */
const seasonIsPublic = () =>
  or(
    ne(seasons.status, "DRAFT"),
    sql`exists (select 1 from ${competitions} c join ${fixtures} f on f.competition_id = c.id where c.season_id = ${seasons.id})`,
  )!;

export type League = typeof leagues.$inferSelect;
export type Season = typeof seasons.$inferSelect;

export async function publicLeague(db: Db, slug: string) {
  const [league] = await db.select().from(leagues).where(and(eq(leagues.slug, slug), isNull(leagues.archivedAt)));
  if (!league) throw notFound("league");
  const seasonRows = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.leagueId, league.id), seasonIsPublic()))
    .orderBy(desc(seasons.startsOn));
  return { league, seasons: seasonRows };
}

/** The season asked for, else the active one, else the most recent. */
export const pickSeason = (seasonRows: Season[], param: unknown): Season | null =>
  seasonRows.find((s) => s.id === param) ?? seasonRows.find((s) => s.status === "ACTIVE") ?? seasonRows[0] ?? null;

/** A season's competitions: divisions top first, then cups by name. */
export async function seasonCompetitions(db: Db, seasonId: string) {
  const rows = await db
    .select({ competition: competitions, division: divisions })
    .from(competitions)
    .leftJoin(divisions, eq(divisions.id, competitions.divisionId))
    .where(eq(competitions.seasonId, seasonId));
  return rows.sort(
    (a, b) =>
      (a.competition.kind === b.competition.kind ? 0 : a.competition.kind === "LEAGUE" ? -1 : 1) ||
      (a.division?.rank ?? 0) - (b.division?.rank ?? 0) ||
      a.competition.name.localeCompare(b.competition.name),
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface PublicTeamRef {
  entryId: string;
  teamId: string;
  name: string;
  slug: string;
}

export interface PublicFixture {
  id: string;
  competitionId: string;
  competitionName: string;
  roundNumber: number | null;
  /** Cups: the tie's place in its round. */
  bracketSlot: number | null;
  scheduledAt: Date;
  status: (typeof fixtures.$inferSelect)["status"];
  home: PublicTeamRef;
  /** null = bye. */
  away: PublicTeamRef | null;
  venue: string | null;
  /** Official result of the first result group, once completed. */
  score: { home: number; away: number; winner: "HOME" | "AWAY" | "DRAW" } | null;
  /** Further result groups, e.g. a pairs game counting for a separate table. */
  otherScores: { name: string; home: number; away: number }[];
  awarded: boolean;
  /** Running score of the first result group while live. */
  liveScore: { home: number; away: number } | null;
}

const rulesCache = async (db: Db, ids: string[]) => {
  const out = new Map<string, LoadedPeriod[]>();
  for (const id of ids) out.set(id, await loadRulePeriods(db, id).catch(() => []));
  return out;
};

export async function loadFixtures(db: Db, where: SQL, opts: { order?: "asc" | "desc"; limit?: number } = {}): Promise<PublicFixture[]> {
  const order = opts.order === "desc" ? [desc(fixtures.scheduledAt), asc(fixtures.id)] : [asc(fixtures.scheduledAt), asc(fixtures.id)];
  const base = db.select().from(fixtures).where(where).orderBy(...order);
  const rows = opts.limit ? await base.limit(opts.limit) : await base;
  if (!rows.length) return [];

  const ids = rows.map((f) => f.id);
  const compIds = [...new Set(rows.map((f) => f.competitionId))];
  const entryIds = [...new Set(rows.flatMap((f) => (f.awayEntryId ? [f.homeEntryId, f.awayEntryId] : [f.homeEntryId])))];
  const [compRows, entryRows, outcomeRows, [league]] = await Promise.all([
    db.select().from(competitions).where(inArray(competitions.id, compIds)),
    db
      .select({ entry: teamEntries, slug: teams.slug, homeVenueId: teams.homeVenueId })
      .from(teamEntries)
      .innerJoin(teams, eq(teams.id, teamEntries.teamId))
      .where(inArray(teamEntries.id, entryIds)),
    db.select().from(fixtureOutcomes).where(inArray(fixtureOutcomes.fixtureId, ids)),
    db.select().from(leagues).where(eq(leagues.id, rows[0].leagueId)),
  ]);
  // A fixture is played at its own venue if one was set, else the home team's venue that season.
  const entryVenue = new Map(entryRows.map((e) => [e.entry.id, e.entry.venueId ?? e.homeVenueId]));
  const venueOf = (f: (typeof rows)[number]) => f.venueId ?? entryVenue.get(f.homeEntryId) ?? null;
  const venueIds = [...new Set(rows.flatMap((f) => venueOf(f) ?? []))];
  const venueRows = venueIds.length ? await db.select().from(venues).where(inArray(venues.id, venueIds)) : [];
  const periods = await rulesCache(db, compIds);
  const compName = new Map(compRows.map((c) => [c.id, c.name]));
  const venueName = new Map(venueRows.map((v) => [v.id, v.name]));
  const ref = new Map<string, PublicTeamRef>(
    entryRows.map(({ entry, slug }) => [entry.id, { entryId: entry.id, teamId: entry.teamId, name: entry.displayName, slug }]),
  );

  const live = new Map<string, { home: number; away: number }>();
  for (const f of rows.filter((r) => r.status === "LIVE")) {
    const snap = await liveSnapshot(db, f.id).catch(() => null);
    if (snap?.groups[0]) live.set(f.id, { home: snap.groups[0].homeGames, away: snap.groups[0].awayGames });
  }

  return rows.map((f) => {
    const ps = periods.get(f.competitionId) ?? [];
    const groups = ps.length ? periodFor(ps, localDateInZone(f.scheduledAt, league.timezone)).rules.match.groups : [];
    const outcomes = f.status === "COMPLETED" ? outcomeRows.filter((o) => o.fixtureId === f.id) : [];
    const rank = (key: string) => {
      const i = groups.findIndex((g) => g.key === key);
      return i < 0 ? groups.length : i;
    };
    outcomes.sort((a, b) => rank(a.groupKey) - rank(b.groupKey));
    const [primary, ...rest] = outcomes;
    return {
      id: f.id,
      competitionId: f.competitionId,
      competitionName: compName.get(f.competitionId) ?? "",
      roundNumber: f.roundNumber,
      bracketSlot: f.bracketSlot,
      scheduledAt: f.scheduledAt,
      status: f.status,
      home: ref.get(f.homeEntryId)!,
      away: f.awayEntryId ? ref.get(f.awayEntryId)! : null,
      venue: venueName.get(venueOf(f) ?? "") ?? null,
      score: primary ? { home: primary.homeGames, away: primary.awayGames, winner: primary.winner } : null,
      otherScores: rest.map((o) => ({ name: groups.find((g) => g.key === o.groupKey)?.name ?? o.groupKey, home: o.homeGames, away: o.awayGames })),
      awarded: outcomes.some((o) => o.source === "AWARDED"),
      liveScore: live.get(f.id) ?? null,
    };
  });
}

const UPCOMING = ["SCHEDULED", "REARRANGEMENT_REQUESTED", "POSTPONED", "LIVE"] as const;
const RESULTS = ["COMPLETED", "VOID"] as const;

export type FixtureView = "upcoming" | "results";

/** Fixtures for a season, optionally one competition and/or one team. Upcoming soonest first, results latest first. */
export async function fixtureList(
  db: Db,
  seasonId: string,
  opts: { view: FixtureView; competitionId?: string | null; teamId?: string | null; limit?: number },
): Promise<PublicFixture[]> {
  let compIds = (await seasonCompetitions(db, seasonId)).map((c) => c.competition.id);
  if (opts.competitionId) compIds = compIds.filter((id) => id === opts.competitionId);
  if (!compIds.length) return [];
  // Cup byes are decided without a match, so they only appear in the bracket.
  const where: SQL[] = [inArray(fixtures.competitionId, compIds), inArray(fixtures.status, opts.view === "upcoming" ? [...UPCOMING] : [...RESULTS]), isNotNull(fixtures.awayEntryId)];
  if (opts.teamId) {
    const entryIds = (await db.select({ id: teamEntries.id }).from(teamEntries).where(and(eq(teamEntries.teamId, opts.teamId), inArray(teamEntries.competitionId, compIds)))).map((e) => e.id);
    if (!entryIds.length) return [];
    where.push(or(inArray(fixtures.homeEntryId, entryIds), inArray(fixtures.awayEntryId, entryIds))!);
  }
  return loadFixtures(db, and(...where)!, { order: opts.view === "upcoming" ? "asc" : "desc", limit: opts.limit });
}

// ---------------------------------------------------------------------------
// League overview & divisions
// ---------------------------------------------------------------------------

export async function leagueOverview(db: Db, league: League, seasonId: string, now = new Date()) {
  const comps = await seasonCompetitions(db, seasonId);
  const tables = [];
  for (const c of comps.filter((c) => c.competition.kind === "LEAGUE")) {
    const t = await getTables(db, c.competition.id, now).catch(() => null);
    tables.push({ competition: c.competition, division: c.division, table: t?.[0] ?? null });
  }
  const compIds = comps.map((c) => c.competition.id);
  if (!compIds.length) return { tables, live: [], upcoming: [], results: [], cups: [] };
  const startOfToday = zonedTimeToUtc(localDateInZone(now, league.timezone), "00:00", league.timezone);
  const inSeason = inArray(fixtures.competitionId, compIds);
  const [live, upcoming, results] = await Promise.all([
    loadFixtures(db, and(inSeason, eq(fixtures.status, "LIVE"))!),
    loadFixtures(db, and(inSeason, inArray(fixtures.status, ["SCHEDULED", "REARRANGEMENT_REQUESTED"]), gte(fixtures.scheduledAt, startOfToday))!, { limit: 12 }),
    loadFixtures(db, and(inSeason, eq(fixtures.status, "COMPLETED"), isNotNull(fixtures.awayEntryId))!, { order: "desc", limit: 12 }),
  ]);
  const cups = comps.filter((c) => c.competition.kind === "CUP").map((c) => c.competition);
  return { tables, live, upcoming, results, cups };
}

/** A competition in a league, with every one of its tables (main, pairs, …). */
export async function competitionPage(db: Db, leagueId: string, competitionId: string) {
  if (!isUuid(competitionId)) throw notFound("competition");
  const [row] = await db
    .select({ competition: competitions, division: divisions, season: seasons })
    .from(competitions)
    .innerJoin(seasons, eq(seasons.id, competitions.seasonId))
    .leftJoin(divisions, eq(divisions.id, competitions.divisionId))
    .where(and(eq(competitions.id, competitionId), eq(competitions.leagueId, leagueId), seasonIsPublic()));
  if (!row) throw notFound("competition");
  const tables: Table[] = row.competition.kind === "LEAGUE" ? await getTables(db, competitionId).catch(() => []) : [];
  return { ...row, tables };
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/** Teams entered in a season, grouped by competition (divisions first). */
export async function seasonTeams(db: Db, seasonId: string) {
  const comps = (await seasonCompetitions(db, seasonId)).filter((c) => c.competition.kind === "LEAGUE");
  if (!comps.length) return [];
  const entryRows = await db
    .select({ entry: teamEntries, slug: teams.slug })
    .from(teamEntries)
    .innerJoin(teams, eq(teams.id, teamEntries.teamId))
    .where(inArray(teamEntries.competitionId, comps.map((c) => c.competition.id)))
    .orderBy(asc(teamEntries.displayName));
  return comps.map((c) => ({ ...c, entries: entryRows.filter((e) => e.entry.competitionId === c.competition.id) }));
}

/** entry id → team slug for the given competitions, for linking table rows. */
export async function entrySlugs(db: Db, competitionIds: string[]): Promise<Map<string, string>> {
  if (!competitionIds.length) return new Map();
  const rows = await db
    .select({ id: teamEntries.id, slug: teams.slug })
    .from(teamEntries)
    .innerJoin(teams, eq(teams.id, teamEntries.teamId))
    .where(inArray(teamEntries.competitionId, competitionIds));
  return new Map(rows.map((r) => [r.id, r.slug]));
}

export async function teamProfile(db: Db, leagueId: string, slug: string, seasonId: string | null) {
  const [team] = await db.select().from(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.slug, slug)));
  if (!team) throw notFound("team");
  const [venue] = team.homeVenueId ? await db.select().from(venues).where(eq(venues.id, team.homeVenueId)) : [];
  if (!seasonId) return { team, venue: venue ?? null, standings: [], squad: [], upcoming: [], results: [], bands: DEFAULT_BANDS };

  const comps = await seasonCompetitions(db, seasonId);
  const entries = comps.length
    ? await db.select().from(teamEntries).where(and(eq(teamEntries.teamId, team.id), inArray(teamEntries.competitionId, comps.map((c) => c.competition.id))))
    : [];
  const standings = [];
  for (const e of entries) {
    const c = comps.find((c) => c.competition.id === e.competitionId)!;
    if (c.competition.kind !== "LEAGUE") continue;
    const tables = await getTables(db, c.competition.id).catch(() => []);
    const row = tables[0]?.rows.find((r) => r.entryId === e.id) ?? null;
    standings.push({ competition: c.competition, entry: e, row, teams: tables[0]?.rows.length ?? 0 });
  }

  const regs = await db
    .select({ registration: playerRegistrations, player: players })
    .from(playerRegistrations)
    .innerJoin(players, eq(players.id, playerRegistrations.playerId))
    .where(and(eq(playerRegistrations.teamId, team.id), eq(playerRegistrations.seasonId, seasonId)))
    .orderBy(asc(players.firstName), asc(players.lastName));
  const stats = await playerStats(db, { leagueId, seasonId, teamId: team.id });
  // A player registered twice for the team in one season (left and came back) is listed once.
  const seen = new Set<string>();
  const squad = regs
    .filter((r) => !seen.has(r.player.id) && seen.add(r.player.id))
    .map((r) => ({
      playerId: r.player.id,
      name: playerName(r.player),
      current: regs.some((x) => x.player.id === r.player.id && x.registration.status === "ACTIVE"),
      totals: stats.get(r.player.id) ?? null,
    }));

  const [upcoming, results] = await Promise.all([
    fixtureList(db, seasonId, { view: "upcoming", teamId: team.id }),
    fixtureList(db, seasonId, { view: "results", teamId: team.id }),
  ]);
  const { bands } = await statsRules(db, leagueId, entries.map((e) => e.competitionId));
  return { team, venue: venue ?? null, standings, squad, upcoming, results, bands };
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface GameLogRow {
  gameId: string;
  fixtureId: string;
  scheduledAt: Date;
  seasonId: string;
  competitionName: string;
  competitionKind: "LEAGUE" | "CUP";
  gameKind: "SINGLES" | "PAIRS";
  isWalkover: boolean;
  team: { name: string; slug: string };
  opponentTeam: { name: string; slug: string } | null;
  partners: { id: string; name: string }[];
  opponents: { id: string; name: string }[];
  result: "WIN" | "LOSS" | "DRAW" | null;
  legsFor: number;
  legsAgainst: number;
  totals: StatTotals;
}

/** A player's public profile: registrations and every counted game, newest first. */
export async function playerProfile(db: Db, leagueId: string, playerId: string) {
  if (!isUuid(playerId)) throw notFound("player");
  const [player] = await db.select().from(players).where(and(eq(players.id, playerId), eq(players.leagueId, leagueId)));
  if (!player) throw notFound("player");

  const registrations = await db
    .select({ registration: playerRegistrations, season: seasons, team: teams })
    .from(playerRegistrations)
    .innerJoin(seasons, eq(seasons.id, playerRegistrations.seasonId))
    .innerJoin(teams, eq(teams.id, playerRegistrations.teamId))
    .where(and(eq(playerRegistrations.playerId, playerId), seasonIsPublic()))
    .orderBy(desc(seasons.startsOn), desc(playerRegistrations.registeredAt));

  const rows = await db
    .select({ s: playerGameStats, game: games, fixture: fixtures, competition: competitions })
    .from(playerGameStats)
    .innerJoin(games, eq(games.id, playerGameStats.gameId))
    .innerJoin(fixtures, eq(fixtures.id, games.fixtureId))
    .innerJoin(competitions, eq(competitions.id, fixtures.competitionId))
    .where(and(eq(playerGameStats.playerId, playerId), eq(fixtures.leagueId, leagueId), statsCountFixture()))
    .orderBy(desc(fixtures.scheduledAt), desc(games.ordinal));
  if (!rows.length) return { player, name: playerName(player), registrations, games: [] as GameLogRow[], bands: DEFAULT_BANDS };

  const gameIds = rows.map((r) => r.game.id);
  const entryIds = [...new Set(rows.flatMap((r) => (r.fixture.awayEntryId ? [r.fixture.homeEntryId, r.fixture.awayEntryId] : [r.fixture.homeEntryId])))];
  const [lineups, entryRows] = await Promise.all([
    db
      .select({ gp: gamePlayers, player: players })
      .from(gamePlayers)
      .innerJoin(players, eq(players.id, gamePlayers.playerId))
      .where(inArray(gamePlayers.gameId, gameIds))
      .orderBy(asc(gamePlayers.position)),
    db.select({ entry: teamEntries, slug: teams.slug }).from(teamEntries).innerJoin(teams, eq(teams.id, teamEntries.teamId)).where(inArray(teamEntries.id, entryIds)),
  ]);
  const teamOf = new Map(entryRows.map(({ entry, slug }) => [entry.id, { name: entry.displayName, slug }]));
  const other = (s: Side): Side => (s === "HOME" ? "AWAY" : "HOME");

  const log: GameLogRow[] = rows.map(({ s, game, fixture, competition }) => {
    const entryOf = (side: Side) => (side === "HOME" ? fixture.homeEntryId : fixture.awayEntryId);
    const opponentEntry = entryOf(other(s.side));
    const inGame = lineups.filter((l) => l.gp.gameId === game.id);
    const names = (side: Side) => inGame.filter((l) => l.gp.side === side).map((l) => ({ id: l.player.id, name: playerName(l.player) }));
    return {
      gameId: game.id,
      fixtureId: fixture.id,
      scheduledAt: fixture.scheduledAt,
      seasonId: competition.seasonId,
      competitionName: competition.name,
      competitionKind: competition.kind,
      gameKind: s.gameKind,
      isWalkover: s.isWalkover,
      team: teamOf.get(entryOf(s.side)!)!,
      opponentTeam: opponentEntry ? (teamOf.get(opponentEntry) ?? null) : null,
      partners: names(s.side).filter((p) => p.id !== playerId),
      opponents: names(other(s.side)),
      result: !game.winner ? null : game.winner === "DRAW" ? "DRAW" : game.winner === s.side ? "WIN" : "LOSS",
      legsFor: s.side === "HOME" ? game.homeLegs : game.awayLegs,
      legsAgainst: s.side === "HOME" ? game.awayLegs : game.homeLegs,
      totals: rowTotals(s),
    };
  });
  const { bands } = await statsRules(db, leagueId, [...new Set(rows.map((r) => r.competition.id))]);
  return { player, name: playerName(player), registrations, games: log, bands };
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

/**
 * The statistics settings in force today across some competitions: the
 * strictest leaderboard minimum, and every score band (first definition of
 * each key wins). Falls back to the default bands.
 */
export async function statsRules(db: Db, leagueId: string, competitionIds: string[]) {
  const tz = (await db.select({ tz: leagues.timezone }).from(leagues).where(eq(leagues.id, leagueId)))[0]?.tz ?? "Europe/London";
  const today = localDateInZone(new Date(), tz);
  let minGames = 0;
  const bands: ScoreBand[] = [];
  for (const id of competitionIds) {
    const ps = await loadRulePeriods(db, id).catch(() => []);
    if (!ps.length) continue;
    const rules = periodFor(ps, today).rules;
    minGames = Math.max(minGames, rules.stats.leaderboardMinGames);
    for (const b of rules.stats.bands) if (!bands.some((x) => x.key === b.key)) bands.push(b);
  }
  return { minGames, bands: bands.length ? bands : DEFAULT_BANDS };
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  team: { name: string; slug: string } | null;
  totals: StatTotals;
}

/**
 * Season statistics for every player who has played in scope, plus the
 * scope's minimum-games threshold (the strictest in force across the
 * competitions in scope) and score bands.
 */
export async function leaderboardData(
  db: Db,
  leagueId: string,
  seasonId: string,
  f: { competitionId?: string | null; gameKind?: "SINGLES" | "PAIRS" | null; competitionKind?: "LEAGUE" | "CUP" | null },
) {
  const comps = (await seasonCompetitions(db, seasonId)).filter(
    (c) => (!f.competitionId || c.competition.id === f.competitionId) && (!f.competitionKind || c.competition.kind === f.competitionKind),
  );
  const { minGames, bands } = await statsRules(db, leagueId, comps.map((c) => c.competition.id));
  if (!comps.length) return { entries: [] as LeaderboardEntry[], minGames, bands };

  const stats = await playerStats(db, {
    leagueId,
    seasonId,
    competitionId: f.competitionId ?? undefined,
    gameKind: f.gameKind ?? undefined,
    competitionKind: f.competitionKind ?? undefined,
  });
  const ids = [...stats.keys()];
  if (!ids.length) return { entries: [] as LeaderboardEntry[], minGames, bands };
  const [playerRows, regs] = await Promise.all([
    db.select().from(players).where(inArray(players.id, ids)),
    db
      .select({ registration: playerRegistrations, team: teams })
      .from(playerRegistrations)
      .innerJoin(teams, eq(teams.id, playerRegistrations.teamId))
      .where(and(inArray(playerRegistrations.playerId, ids), eq(playerRegistrations.seasonId, seasonId)))
      .orderBy(desc(playerRegistrations.registeredAt)),
  ]);
  // Shown with their current team this season (or the last one they played for).
  const teamFor = (pid: string) => {
    const mine = regs.filter((r) => r.registration.playerId === pid);
    const pick = mine.find((r) => r.registration.status === "ACTIVE") ?? mine[0];
    return pick ? { name: pick.team.name, slug: pick.team.slug } : null;
  };
  const entries = playerRows.map((p) => ({ playerId: p.id, name: playerName(p), team: teamFor(p.id), totals: stats.get(p.id)! }));
  return { entries, minGames, bands };
}
