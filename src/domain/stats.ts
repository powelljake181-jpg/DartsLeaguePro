import type { ScoreBand } from "./rules";
import type { Side, Visit } from "./scoring";

/**
 * Player statistics. Everything is built from raw visit totals; ratios such as
 * the 3-dart average are only ever derived at the end from summed points and
 * darts, so aggregating across games/fixtures/seasons can never be skewed by
 * averaging averages.
 */

export interface StatTotals {
  /** Points scored (busts score 0). */
  points: number;
  /** Darts thrown, including bust darts and only the darts used on a checkout. */
  darts: number;
  /** Count of visits per configured band key, e.g. { "180": 2, "140": 5, "100": 9 }. */
  bands: Record<string, number>;
  /** Highest successful checkout, or null if none. */
  highestCheckout: number | null;
  /** Fewest darts used to win a leg, or null if no leg won. */
  bestLegDarts: number | null;
  legsPlayed: number;
  legsWon: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
}

export const emptyTotals = (): StatTotals => ({
  points: 0,
  darts: 0,
  bands: {},
  highestCheckout: null,
  bestLegDarts: null,
  legsPlayed: 0,
  legsWon: 0,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  draws: 0,
});

/** Which band (if any) a visit score falls into. Bands are checked in order; first match wins. */
export function bandFor(score: number, bands: ScoreBand[]): string | null {
  for (const b of bands) if (score >= b.min && score <= b.max) return b.key;
  return null;
}

/** Combine any number of totals. This is the only way rollups are produced. */
export function aggregate(items: StatTotals[]): StatTotals {
  const out = emptyTotals();
  for (const t of items) {
    out.points += t.points;
    out.darts += t.darts;
    for (const [k, v] of Object.entries(t.bands)) out.bands[k] = (out.bands[k] ?? 0) + v;
    out.highestCheckout = maxNullable(out.highestCheckout, t.highestCheckout);
    out.bestLegDarts = minNullable(out.bestLegDarts, t.bestLegDarts);
    out.legsPlayed += t.legsPlayed;
    out.legsWon += t.legsWon;
    out.gamesPlayed += t.gamesPlayed;
    out.wins += t.wins;
    out.losses += t.losses;
    out.draws += t.draws;
  }
  return out;
}

/** 3-dart average = (total points / total darts) × 3. Null when no darts have been thrown. */
export function threeDartAverage(t: Pick<StatTotals, "points" | "darts">): number | null {
  return t.darts === 0 ? null : (t.points / t.darts) * 3;
}

export function winPercentage(t: Pick<StatTotals, "gamesPlayed" | "wins">): number | null {
  return t.gamesPlayed === 0 ? null : (t.wins / t.gamesPlayed) * 100;
}

/** A count statistic per game played, e.g. 180s per game. */
export function perGame(t: StatTotals, bandKey: string): number | null {
  return t.gamesPlayed === 0 ? null : (t.bands[bandKey] ?? 0) / t.gamesPlayed;
}

/** Round for display only. Never store rounded values. */
export const round2 = (n: number | null): number | null => (n === null ? null : Math.round(n * 100) / 100);

// ---------------------------------------------------------------------------
// From visits
// ---------------------------------------------------------------------------

export interface LegRecord {
  /** Visits in throw order (voided visits already excluded). */
  visits: Visit[];
  winner: Side | null;
}

/**
 * Darts statistics for one player across the given legs, using only that
 * player's own visits. Game W/L is not included; see `gameTotals`.
 */
export function legTotalsForPlayer(playerId: string, legs: LegRecord[], bands: ScoreBand[]): StatTotals {
  const t = emptyTotals();
  for (const leg of legs) {
    const mine = leg.visits.filter((v) => v.playerId === playerId);
    if (mine.length === 0) continue;
    t.legsPlayed++;
    for (const v of mine) {
      t.points += v.score;
      t.darts += v.darts;
      if (!v.isBust) {
        const band = bandFor(v.score, bands);
        if (band) t.bands[band] = (t.bands[band] ?? 0) + 1;
      }
      if (v.isCheckout) t.highestCheckout = maxNullable(t.highestCheckout, v.score);
    }
    // A leg is won by the side: in pairs, both partners won it, whoever hit the double.
    const side = mine[0].side;
    if (leg.winner === side) {
      t.legsWon++;
      // Least darts is the side's darts to win the leg (in pairs, both partners' darts).
      const sideDarts = leg.visits.filter((v) => v.side === side).reduce((n, v) => n + v.darts, 0);
      t.bestLegDarts = minNullable(t.bestLegDarts, sideDarts);
    }
  }
  return t;
}

export type GameResultForPlayer = "WIN" | "LOSS" | "DRAW";

/** Stats for one player in one played game: darts stats + the game result. */
export function gameTotals(
  playerId: string,
  legs: LegRecord[],
  result: GameResultForPlayer | null,
  bands: ScoreBand[],
): StatTotals {
  const t = legTotalsForPlayer(playerId, legs, bands);
  if (result) {
    t.gamesPlayed = 1;
    if (result === "WIN") t.wins = 1;
    else if (result === "LOSS") t.losses = 1;
    else t.draws = 1;
  }
  return t;
}

/**
 * A walkover game: no darts were thrown, so no darts stats exist. Whether the
 * present player gets a game played + win depends on league rules.
 */
export function walkoverTotals(recordWin: boolean): StatTotals {
  const t = emptyTotals();
  if (recordWin) {
    t.gamesPlayed = 1;
    t.wins = 1;
  }
  return t;
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}
function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
