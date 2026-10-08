import { threeDartAverage, winPercentage, type StatTotals } from "./stats";

/**
 * Leaderboards: rank players on one statistic. Ratio categories (average,
 * win %) only include players with at least `minGames` games, so one lucky
 * game can't top the board; count/record categories include everyone with a
 * value. Equal values share a position (1, 2, 2, 4) and are then listed by name.
 */

export type LeaderboardCategory =
  | { kind: "average" }
  | { kind: "winPct" }
  | { kind: "band"; key: string }
  | { kind: "highestCheckout" }
  | { kind: "bestLeg" };

export interface LeaderboardInput {
  playerId: string;
  name: string;
  totals: StatTotals;
}

export interface LeaderboardRow<T extends LeaderboardInput> {
  position: number;
  value: number;
  entry: T;
}

/** The value a category ranks on, or null if the player has none. */
export function categoryValue(c: LeaderboardCategory, t: StatTotals): number | null {
  switch (c.kind) {
    case "average":
      return threeDartAverage(t);
    case "winPct":
      return winPercentage(t);
    case "band": {
      const n = t.bands[c.key] ?? 0;
      return n > 0 ? n : null;
    }
    case "highestCheckout":
      return t.highestCheckout;
    case "bestLeg":
      return t.bestLegDarts;
  }
}

/** Fewest darts is best; for everything else higher is better. */
const lowerIsBetter = (c: LeaderboardCategory) => c.kind === "bestLeg";
const needsMinGames = (c: LeaderboardCategory) => c.kind === "average" || c.kind === "winPct";

export function rankLeaderboard<T extends LeaderboardInput>(
  entries: T[],
  category: LeaderboardCategory,
  opts: { minGames: number; limit?: number },
): LeaderboardRow<T>[] {
  const scored: { value: number; entry: T }[] = [];
  for (const entry of entries) {
    if (needsMinGames(category) && entry.totals.gamesPlayed < opts.minGames) continue;
    const value = categoryValue(category, entry.totals);
    if (value !== null) scored.push({ value, entry });
  }
  const dir = lowerIsBetter(category) ? 1 : -1;
  scored.sort((a, b) => dir * (a.value - b.value) || a.entry.name.localeCompare(b.entry.name));

  const rows: LeaderboardRow<T>[] = [];
  scored.forEach((s, i) => {
    const position = i > 0 && s.value === scored[i - 1].value ? rows[i - 1].position : i + 1;
    rows.push({ position, value: s.value, entry: s.entry });
  });
  // A limit never splits a tie: everyone sharing the last shown position is kept.
  if (opts.limit === undefined || rows.length <= opts.limit) return rows;
  const cutoff = rows[opts.limit - 1].position;
  return rows.filter((r, i) => i < opts.limit! || r.position === cutoff);
}
