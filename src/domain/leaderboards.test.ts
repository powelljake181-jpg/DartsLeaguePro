import { describe, expect, it } from "vitest";
import { rankLeaderboard, type LeaderboardInput } from "./leaderboards";
import { emptyTotals, type StatTotals } from "./stats";

const player = (name: string, t: Partial<StatTotals>): LeaderboardInput => ({ playerId: name, name, totals: { ...emptyTotals(), ...t } });

describe("rankLeaderboard", () => {
  it("ranks averages from summed points and darts, and drops players below the minimum games", () => {
    const rows = rankLeaderboard(
      [
        player("Ann", { points: 1002, darts: 36, gamesPlayed: 2 }), // 83.5
        player("Bob", { points: 1503, darts: 45, gamesPlayed: 3 }), // 100.2
        player("Cat", { points: 501, darts: 9, gamesPlayed: 1 }), // 167, but only one game
      ],
      { kind: "average" },
      { minGames: 2 },
    );
    expect(rows.map((r) => [r.position, r.entry.name])).toEqual([
      [1, "Bob"],
      [2, "Ann"],
    ]);
    expect(rows[0].value).toBeCloseTo(100.2);
  });

  it("shares positions on equal values and lists tied players by name", () => {
    const rows = rankLeaderboard(
      [player("Zed", { bands: { "180": 2 } }), player("Amy", { bands: { "180": 2 } }), player("Max", { bands: { "180": 3 } }), player("Nil", { bands: {} })],
      { kind: "band", key: "180" },
      { minGames: 5 },
    );
    expect(rows.map((r) => [r.position, r.entry.name, r.value])).toEqual([
      [1, "Max", 3],
      [2, "Amy", 2],
      [2, "Zed", 2],
    ]);
  });

  it("ranks fewest darts first for best leg and ignores players who never won a leg", () => {
    const rows = rankLeaderboard(
      [player("A", { bestLegDarts: 18 }), player("B", { bestLegDarts: 15 }), player("C", { bestLegDarts: null })],
      { kind: "bestLeg" },
      { minGames: 0 },
    );
    expect(rows.map((r) => r.entry.name)).toEqual(["B", "A"]);
  });

  it("keeps everyone tied at the cut-off when limiting", () => {
    const rows = rankLeaderboard(
      [player("A", { highestCheckout: 170 }), player("B", { highestCheckout: 120 }), player("C", { highestCheckout: 120 }), player("D", { highestCheckout: 40 })],
      { kind: "highestCheckout" },
      { minGames: 0, limit: 2 },
    );
    expect(rows.map((r) => r.entry.name)).toEqual(["A", "B", "C"]);
  });

  it("win percentage counts walkover wins only through the games they add", () => {
    const rows = rankLeaderboard(
      [player("A", { gamesPlayed: 4, wins: 3 }), player("B", { gamesPlayed: 5, wins: 4 })],
      { kind: "winPct" },
      { minGames: 4 },
    );
    expect(rows.map((r) => [r.entry.name, r.value])).toEqual([
      ["B", 80],
      ["A", 75],
    ]);
  });
});
