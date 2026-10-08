import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { competitions, fixtureOutcomes, gamePlayers, games, leagues, legs, players, teamEntries, venues, visits } from "@/db/schema";
import { fixtureProgress, type GameStatus } from "@/domain/match";
import { gameConfigFor, type GameKind, type ScoreBand } from "@/domain/rules";
import { replayLeg, startingSideForLeg, type Side } from "@/domain/scoring";
import { legTotalsForPlayer, threeDartAverage } from "@/domain/stats";
import { loadFixtureContext } from "./context";
import { toVisit } from "./stats-service";

/**
 * Everything a match screen needs, in one read: the public live page, the
 * scorer's phone and the realtime stream all use this. Derived entirely from
 * stored visits, so it is always consistent with the official record.
 */

export interface LivePlayerStats {
  points: number;
  darts: number;
  average: number | null;
  bands: Record<string, number>;
  highestCheckout: number | null;
  legsWon: number;
}

export interface LiveVisit {
  clientEventId: string;
  side: Side;
  playerId: string;
  score: number;
  entered: number;
  darts: number;
  isBust: boolean;
  isCheckout: boolean;
}

export interface LiveGame {
  ordinal: number;
  kind: GameKind;
  groupKey: string;
  status: GameStatus;
  winner: Side | "DRAW" | null;
  homeLegs: number;
  awayLegs: number;
  legsFormat: "BEST_OF" | "FIXED";
  legs: number;
  startingScore: number;
  doubleOut: boolean;
  firstThrower: Side;
  /** No longer needed because its result group is decided. */
  notRequired: boolean;
  players: Record<Side, { playerId: string; name: string }[]>;
  /** The leg in play (or the last leg once the game is over). */
  currentLeg: {
    ordinal: number;
    startingSide: Side;
    remaining: Record<Side, number>;
    nextToThrow: Side;
    /** Pairs: the partner due to throw next on each side, when known. */
    nextPlayer: Record<Side, string | null>;
    visits: LiveVisit[];
    finished: boolean;
  } | null;
  stats: Record<string, LivePlayerStats>;
  /** The most recent visit in the game (across legs), for undo. */
  lastVisitId: string | null;
}

export interface LiveSnapshot {
  fixtureId: string;
  version: number;
  status: string;
  scheduledAt: string;
  league: { name: string; slug: string; timezone: string };
  competitionName: string;
  venue: string | null;
  home: { entryId: string; teamId: string; name: string };
  away: { entryId: string; teamId: string; name: string };
  responsibleSide: Side;
  lineupsConfirmed: Record<Side, boolean>;
  groups: { key: string; name: string; homeGames: number; awayGames: number; complete: boolean; decided: boolean }[];
  games: LiveGame[];
  /** Every required game is finished and the scorer can confirm the result. */
  readyToComplete: boolean;
  bands: ScoreBand[];
}

const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`;

export async function liveSnapshot(db: Db, fixtureId: string): Promise<LiveSnapshot> {
  const ctx = await loadFixtureContext(db, fixtureId);
  const { fixture, rules } = ctx;
  const [league] = await db.select().from(leagues).where(eq(leagues.id, fixture.leagueId));
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, fixture.competitionId));
  const entries = await db.select().from(teamEntries).where(eq(teamEntries.competitionId, fixture.competitionId));
  const home = entries.find((e) => e.id === fixture.homeEntryId)!;
  const away = entries.find((e) => e.id === fixture.awayEntryId);
  const [venue] = fixture.venueId ? await db.select().from(venues).where(eq(venues.id, fixture.venueId)) : [];

  const gameRows = await db.select().from(games).where(eq(games.fixtureId, fixtureId)).orderBy(asc(games.ordinal));
  const gameIds = gameRows.map((g) => g.id);
  const lineup = gameIds.length
    ? await db
        .select({ gp: gamePlayers, player: players })
        .from(gamePlayers)
        .innerJoin(players, eq(players.id, gamePlayers.playerId))
        .where(inArray(gamePlayers.gameId, gameIds))
        .orderBy(asc(gamePlayers.position))
    : [];
  const legRows = gameIds.length ? await db.select().from(legs).where(inArray(legs.gameId, gameIds)).orderBy(asc(legs.ordinal)) : [];
  const visitRows = legRows.length
    ? await db
        .select()
        .from(visits)
        .where(and(inArray(visits.legId, legRows.map((l) => l.id)), isNull(visits.voidedAt)))
        .orderBy(asc(visits.seq))
    : [];

  const summaries = gameRows.map((g) => ({ status: g.status, winner: g.winner, homeLegs: g.homeLegs, awayLegs: g.awayLegs }));
  const progress = gameRows.length === rules.match.slots.length ? fixtureProgress(summaries, rules) : null;
  const outcomes = fixture.status === "COMPLETED" ? await db.select().from(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, fixtureId)) : [];

  const bands = rules.stats.bands;
  const liveGames: LiveGame[] = gameRows.map((g) => {
    const gc = gameConfigFor(rules, g.kind);
    const firstThrower = g.firstThrower ?? "HOME";
    const mine = lineup.filter((l) => l.gp.gameId === g.id);
    const playersBySide = {
      HOME: mine.filter((l) => l.gp.side === "HOME").map((l) => ({ playerId: l.player.id, name: fullName(l.player) })),
      AWAY: mine.filter((l) => l.gp.side === "AWAY").map((l) => ({ playerId: l.player.id, name: fullName(l.player) })),
    };
    const gameLegs = legRows.filter((l) => l.gameId === g.id);
    const records = gameLegs.map((l) => ({ leg: l, visits: visitRows.filter((v) => v.legId === l.id) }));

    // Current leg: earliest unfinished leg with visits, else a fresh leg if the game continues, else the last leg.
    const open = records.find((r) => !r.leg.winner);
    const gameOver = g.status === "COMPLETED" || g.status === "WALKOVER" || g.status === "VOID" || g.status === "NOT_REQUIRED";
    let currentLeg: LiveGame["currentLeg"] = null;
    if (open || !gameOver) {
      const ordinal = open ? open.leg.ordinal : records.length + 1;
      const startingSide = open ? open.leg.startingSide : startingSideForLeg(firstThrower, ordinal - 1);
      const vs = open ? open.visits : [];
      const state = replayLeg({ startingScore: gc.startingScore, doubleOut: gc.doubleOut, startingSide }, vs.map(toVisit));
      currentLeg = {
        ordinal,
        startingSide,
        remaining: state.remaining,
        nextToThrow: state.nextToThrow,
        nextPlayer: { HOME: nextPartner(playersBySide.HOME, vs, "HOME"), AWAY: nextPartner(playersBySide.AWAY, vs, "AWAY") },
        visits: vs.map(liveVisit),
        finished: false,
      };
    } else if (records.length) {
      const last = records.at(-1)!;
      const state = replayLeg({ startingScore: gc.startingScore, doubleOut: gc.doubleOut, startingSide: last.leg.startingSide }, last.visits.map(toVisit));
      currentLeg = {
        ordinal: last.leg.ordinal,
        startingSide: last.leg.startingSide,
        remaining: state.remaining,
        nextToThrow: state.nextToThrow,
        nextPlayer: { HOME: null, AWAY: null },
        visits: last.visits.map(liveVisit),
        finished: true,
      };
    }

    const legRecords = records.map((r) => ({ visits: r.visits.map(toVisit), winner: r.leg.winner }));
    const stats: Record<string, LivePlayerStats> = {};
    for (const p of [...playersBySide.HOME, ...playersBySide.AWAY]) {
      const t = legTotalsForPlayer(p.playerId, legRecords, bands);
      stats[p.playerId] = { points: t.points, darts: t.darts, average: threeDartAverage(t), bands: t.bands, highestCheckout: t.highestCheckout, legsWon: t.legsWon };
    }

    return {
      ordinal: g.ordinal,
      kind: g.kind,
      groupKey: g.groupKey,
      status: g.status,
      winner: g.winner,
      homeLegs: g.homeLegs,
      awayLegs: g.awayLegs,
      legsFormat: gc.legsFormat,
      legs: gc.legs,
      startingScore: gc.startingScore,
      doubleOut: gc.doubleOut,
      firstThrower,
      notRequired: g.status === "NOT_REQUIRED" || (g.status === "PENDING" && !!progress?.notRequired.includes(g.ordinal)),
      players: playersBySide,
      currentLeg,
      stats,
      lastVisitId: records.flatMap((r) => r.visits).at(-1)?.clientEventId ?? null,
    };
  });

  const groups = rules.match.groups.map((grp) => {
    const outcome = outcomes.find((o) => o.groupKey === grp.key);
    const p = progress?.groups[grp.key];
    return {
      key: grp.key,
      name: grp.name,
      homeGames: outcome?.homeGames ?? p?.homeGames ?? 0,
      awayGames: outcome?.awayGames ?? p?.awayGames ?? 0,
      complete: !!outcome || !!p?.complete,
      decided: !!outcome || !!p?.decided,
    };
  });

  return {
    fixtureId,
    version: fixture.version,
    status: fixture.status,
    scheduledAt: fixture.scheduledAt.toISOString(),
    league: { name: league.name, slug: league.slug, timezone: league.timezone },
    competitionName: competition.name,
    venue: venue?.name ?? null,
    home: { entryId: home.id, teamId: home.teamId, name: home.displayName },
    away: { entryId: away?.id ?? "", teamId: away?.teamId ?? "", name: away?.displayName ?? "Bye" },
    responsibleSide: ctx.responsibleSide,
    lineupsConfirmed: { HOME: !!fixture.homeLineupConfirmedAt, AWAY: !!fixture.awayLineupConfirmedAt },
    groups,
    games: liveGames,
    readyToComplete: fixture.status === "LIVE" && !!progress?.complete,
    bands,
  };
}

const liveVisit = (v: typeof visits.$inferSelect): LiveVisit => ({
  clientEventId: v.clientEventId,
  side: v.side,
  playerId: v.playerId,
  score: v.score,
  entered: v.entered,
  darts: v.darts,
  isBust: v.isBust,
  isCheckout: v.isCheckout,
});

/** Pairs: the partner who didn't throw the side's last visit in this leg. Singles: the only player. */
function nextPartner(sidePlayers: { playerId: string }[], legVisits: (typeof visits.$inferSelect)[], side: Side): string | null {
  if (sidePlayers.length === 1) return sidePlayers[0].playerId;
  const last = legVisits.filter((v) => v.side === side).at(-1);
  if (!last) return null;
  return sidePlayers.find((p) => p.playerId !== last.playerId)?.playerId ?? null;
}

