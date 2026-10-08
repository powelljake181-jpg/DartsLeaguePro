import type { FixtureOutcome } from "./match";
import type { PointsConfig, TieBreaker } from "./rules";

/**
 * League table for one result group. Always recomputed from completed fixture
 * outcomes, so it can never drift from the underlying results. Each result
 * carries the points system in force on that fixture's date, so a dated rule
 * change re-scores exactly the fixtures it covers.
 */

export interface FixturePoints {
  home: number;
  away: number;
}

/** League points for one fixture: match points + points per game won, for both teams. */
export function fixturePoints(o: FixtureOutcome, p: PointsConfig): FixturePoints {
  const match =
    o.winner === "HOME"
      ? { home: p.win, away: p.loss }
      : o.winner === "AWAY"
        ? { home: p.loss, away: p.win }
        : { home: p.draw, away: p.draw };
  return {
    home: match.home + p.perGameWon * o.homePointGames,
    away: match.away + p.perGameWon * o.awayPointGames,
  };
}

export interface TableEntry {
  entryId: string;
  name: string;
  /** Folded/withdrawn teams are listed after active teams. */
  withdrawn?: boolean;
}

export interface ResultRow {
  fixtureId: string;
  homeEntryId: string;
  awayEntryId: string;
  outcome: FixtureOutcome;
  /** The points system that applies to this fixture. */
  points: PointsConfig;
}

export interface StandingRow {
  position: number;
  entryId: string;
  name: string;
  withdrawn: boolean;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gamesFor: number;
  gamesAgainst: number;
  gameDifference: number;
  legsFor: number;
  legsAgainst: number;
  legDifference: number;
  points: number;
}

function blankRow(e: TableEntry): StandingRow {
  return {
    position: 0,
    entryId: e.entryId,
    name: e.name,
    withdrawn: !!e.withdrawn,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    gamesFor: 0,
    gamesAgainst: 0,
    gameDifference: 0,
    legsFor: 0,
    legsAgainst: 0,
    legDifference: 0,
    points: 0,
  };
}

function tabulate(entries: TableEntry[], results: ResultRow[]): Map<string, StandingRow> {
  const rows = new Map(entries.map((e) => [e.entryId, blankRow(e)]));
  for (const r of results) {
    const home = rows.get(r.homeEntryId);
    const away = rows.get(r.awayEntryId);
    if (!home || !away) continue; // result involves a team outside this table (not counted)
    const o = r.outcome;
    const pts = fixturePoints(o, r.points);
    home.played++;
    away.played++;
    if (o.winner === "HOME") {
      home.won++;
      away.lost++;
    } else if (o.winner === "AWAY") {
      away.won++;
      home.lost++;
    } else {
      home.drawn++;
      away.drawn++;
    }
    home.gamesFor += o.homeGames;
    home.gamesAgainst += o.awayGames;
    away.gamesFor += o.awayGames;
    away.gamesAgainst += o.homeGames;
    home.legsFor += o.homeLegs;
    home.legsAgainst += o.awayLegs;
    away.legsFor += o.awayLegs;
    away.legsAgainst += o.homeLegs;
    home.points += pts.home;
    away.points += pts.away;
  }
  for (const row of rows.values()) {
    row.gameDifference = row.gamesFor - row.gamesAgainst;
    row.legDifference = row.legsFor - row.legsAgainst;
  }
  return rows;
}

const metric: Record<Exclude<TieBreaker, "HEAD_TO_HEAD">, (r: StandingRow) => number> = {
  POINTS: (r) => r.points,
  GAME_DIFFERENCE: (r) => r.gameDifference,
  GAMES_WON: (r) => r.gamesFor,
  MATCHES_WON: (r) => r.won,
  LEG_DIFFERENCE: (r) => r.legDifference,
};

/**
 * Order a group of rows by the tie-breakers starting at index `from`.
 * HEAD_TO_HEAD builds a mini-table from results among only the tied teams and
 * ranks them by points within it, then continues with the remaining tie-breakers.
 */
function rankGroup(
  group: StandingRow[],
  breakers: TieBreaker[],
  from: number,
  results: ResultRow[],
): StandingRow[][] {
  if (group.length <= 1 || from >= breakers.length) return [group];
  const tb = breakers[from];

  let score: (r: StandingRow) => number;
  if (tb === "HEAD_TO_HEAD") {
    const ids = new Set(group.map((r) => r.entryId));
    const mini = tabulate(
      group.map((r) => ({ entryId: r.entryId, name: r.name })),
      results.filter((r) => ids.has(r.homeEntryId) && ids.has(r.awayEntryId)),
    );
    score = (r) => mini.get(r.entryId)!.points;
  } else {
    score = metric[tb];
  }

  const buckets = new Map<number, StandingRow[]>();
  for (const r of group) {
    const k = score(r);
    buckets.set(k, [...(buckets.get(k) ?? []), r]);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .flatMap(([, rows]) => rankGroup(rows, breakers, from + 1, results));
}

/**
 * Compute the table. Teams still level after every tie-breaker share a
 * position and are listed alphabetically. Withdrawn teams go to the bottom.
 */
export function computeStandings(entries: TableEntry[], results: ResultRow[], tieBreakers: TieBreaker[]): StandingRow[] {
  const rows = [...tabulate(entries, results).values()];
  const out: StandingRow[] = [];
  for (const withdrawn of [false, true]) {
    const groups = rankGroup(
      rows.filter((r) => r.withdrawn === withdrawn),
      tieBreakers,
      0,
      results,
    );
    for (const g of groups) {
      const position = out.length + 1;
      for (const r of [...g].sort((a, b) => a.name.localeCompare(b.name))) {
        out.push({ ...r, position });
      }
    }
  }
  return out;
}
