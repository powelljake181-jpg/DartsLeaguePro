import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  competitions,
  fixtures,
  gamePlayers,
  games,
  legs,
  playerGameStats,
  playerRegistrations,
  visits,
} from "@/db/schema";
import type { Visit } from "@/domain/scoring";
import {
  aggregate,
  gameTotals,
  legTotalsForPlayer,
  walkoverTotals,
  type LegRecord,
  type StatTotals,
} from "@/domain/stats";
import { loadFixtureContext } from "./context";
import { notFound } from "./errors";

/** Legs of a game with their non-voided visits in throw order. */
export async function loadLegRecords(db: Db, gameId: string): Promise<(LegRecord & { legId: string })[]> {
  const legRows = await db.select().from(legs).where(eq(legs.gameId, gameId)).orderBy(asc(legs.ordinal));
  if (legRows.length === 0) return [];
  const visitRows = await db
    .select()
    .from(visits)
    .where(and(inArray(visits.legId, legRows.map((l) => l.id)), isNull(visits.voidedAt)))
    .orderBy(asc(visits.seq));
  return legRows.map((l) => ({
    legId: l.id,
    winner: l.winner,
    visits: visitRows.filter((v) => v.legId === l.id).map(toVisit),
  }));
}

export const toVisit = (v: typeof visits.$inferSelect): Visit => ({
  side: v.side,
  playerId: v.playerId,
  entered: v.entered,
  score: v.score,
  darts: v.darts,
  isBust: v.isBust,
  isCheckout: v.isCheckout,
});

/**
 * Rebuild the derived stats rows for one game from its visits. Called in the
 * same transaction as any change to the game, so the cache can never drift.
 * Only finished games (completed or walkover) have rows.
 */
export async function rebuildGameStats(db: Db, gameId: string): Promise<void> {
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  if (!game) throw notFound("game");
  const { rules } = await loadFixtureContext(db, game.fixtureId);
  const bands = rules.stats.bands;

  await db.delete(playerGameStats).where(eq(playerGameStats.gameId, gameId));
  if (game.status !== "COMPLETED" && game.status !== "WALKOVER") return;

  const lineup = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
  const legRecords = game.status === "COMPLETED" ? await loadLegRecords(db, gameId) : [];

  const rows = lineup.flatMap((p) => {
    let totals: StatTotals;
    if (game.status === "WALKOVER") {
      if (p.side !== game.winner) return [];
      totals = walkoverTotals(rules.walkover.playerRecord === "WIN_FOR_PRESENT_PLAYER");
    } else {
      const result = game.winner === "DRAW" ? "DRAW" : game.winner === p.side ? "WIN" : "LOSS";
      totals = gameTotals(p.playerId, legRecords, result, bands);
    }
    return [
      {
        gameId,
        playerId: p.playerId,
        registrationId: p.registrationId,
        side: p.side,
        gameKind: game.kind,
        isWalkover: game.status === "WALKOVER",
        points: totals.points,
        darts: totals.darts,
        bands: totals.bands,
        highestCheckout: totals.highestCheckout,
        bestLegDarts: totals.bestLegDarts,
        legsPlayed: totals.legsPlayed,
        legsWon: totals.legsWon,
        gamesPlayed: totals.gamesPlayed,
        wins: totals.wins,
        losses: totals.losses,
        draws: totals.draws,
      },
    ];
  });
  if (rows.length) await db.insert(playerGameStats).values(rows);
}

/** Rebuild every game's stats from visits; proves the cache is reproducible. */
export async function rebuildAllStats(db: Db): Promise<number> {
  const all = await db.select({ id: games.id }).from(games);
  for (const g of all) await rebuildGameStats(db, g.id);
  return all.length;
}

export interface StatsFilter {
  playerIds?: string[];
  leagueId?: string;
  seasonId?: string;
  competitionId?: string;
  competitionKind?: "LEAGUE" | "CUP";
  divisionId?: string;
  /** The team the player represented at the time (via registration). */
  teamId?: string;
  fixtureId?: string;
  /** Singles and pairs records are kept separately; omit for both. */
  gameKind?: "SINGLES" | "PAIRS";
}

/** Fixtures whose finished games count towards player statistics. */
export const statsCountFixture = () =>
  and(
    eq(fixtures.statsExcluded, false),
    or(inArray(fixtures.status, ["LIVE", "COMPLETED"]), and(eq(fixtures.status, "VOID"), eq(fixtures.keepStatsWhenVoid, true))),
  )!;

/** Raw totals of a stored stats row. */
export const rowTotals = (s: typeof playerGameStats.$inferSelect): StatTotals => ({
  points: s.points,
  darts: s.darts,
  bands: s.bands,
  highestCheckout: s.highestCheckout,
  bestLegDarts: s.bestLegDarts,
  legsPlayed: s.legsPlayed,
  legsWon: s.legsWon,
  gamesPlayed: s.gamesPlayed,
  wins: s.wins,
  losses: s.losses,
  draws: s.draws,
});

/**
 * Aggregated statistics per player for any scope. Games count once finished,
 * including during a live fixture; voided fixtures count only when the void
 * kept player statistics (e.g. a fold with stats retained).
 */
export async function playerStats(db: Db, f: StatsFilter = {}): Promise<Map<string, StatTotals>> {
  const where: SQL[] = [statsCountFixture()];
  if (f.playerIds) where.push(inArray(playerGameStats.playerId, f.playerIds));
  if (f.leagueId) where.push(eq(fixtures.leagueId, f.leagueId));
  if (f.seasonId) where.push(eq(competitions.seasonId, f.seasonId));
  if (f.competitionId) where.push(eq(competitions.id, f.competitionId));
  if (f.competitionKind) where.push(eq(competitions.kind, f.competitionKind));
  if (f.divisionId) where.push(eq(competitions.divisionId, f.divisionId));
  if (f.teamId) where.push(eq(playerRegistrations.teamId, f.teamId));
  if (f.fixtureId) where.push(eq(fixtures.id, f.fixtureId));
  if (f.gameKind) where.push(eq(playerGameStats.gameKind, f.gameKind));

  const rows = await db
    .select({ s: playerGameStats })
    .from(playerGameStats)
    .innerJoin(games, eq(games.id, playerGameStats.gameId))
    .innerJoin(fixtures, eq(fixtures.id, games.fixtureId))
    .innerJoin(competitions, eq(competitions.id, fixtures.competitionId))
    .innerJoin(playerRegistrations, eq(playerRegistrations.id, playerGameStats.registrationId))
    .where(and(...where));

  const byPlayer = new Map<string, StatTotals[]>();
  for (const { s } of rows) {
    const list = byPlayer.get(s.playerId) ?? [];
    list.push(rowTotals(s));
    byPlayer.set(s.playerId, list);
  }
  return new Map([...byPlayer].map(([id, list]) => [id, aggregate(list)]));
}

/** Live statistics for the players in a game in progress, straight from its visits. */
export async function liveGameStats(db: Db, gameId: string): Promise<Map<string, StatTotals>> {
  const [game] = await db.select().from(games).where(eq(games.id, gameId));
  if (!game) throw notFound("game");
  const { rules } = await loadFixtureContext(db, game.fixtureId);
  const lineup = await db.select().from(gamePlayers).where(eq(gamePlayers.gameId, gameId));
  const legRecords = await loadLegRecords(db, gameId);
  return new Map(lineup.map((p) => [p.playerId, legTotalsForPlayer(p.playerId, legRecords, rules.stats.bands)]));
}

/** Used by tests and the rebuild script to compare stored stats against a fresh rebuild. */
export const statsRowCount = async (db: Db) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(playerGameStats))[0].n;
