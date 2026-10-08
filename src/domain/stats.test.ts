import { describe, expect, it } from "vitest";
import { DEFAULT_BANDS } from "./rules";
import {
  aggregate,
  gameTotals,
  legTotalsForPlayer,
  perGame,
  round2,
  threeDartAverage,
  type StatTotals,
  walkoverTotals,
  winPercentage,
} from "./stats";
import { LEG_501, playLeg } from "./test-helpers";

// HOME checks out 501 in exactly 18 darts (6 visits); AWAY scores 375 in 15 darts.
const eighteenDarter = playLeg(LEG_501, [
  ["HOME", 100], ["AWAY", 60],
  ["HOME", 100], ["AWAY", 100],
  ["HOME", 100], ["AWAY", 45],
  ["HOME", 100], ["AWAY", 140],
  ["HOME", 60], ["AWAY", 30],
  ["HOME", 41, 3],
]);
const legs = [{ visits: eighteenDarter.visits, winner: eighteenDarter.winner }];

describe("3-dart average", () => {
  it("501 in 18 darts is 83.50", () => {
    const t = legTotalsForPlayer("H", legs, DEFAULT_BANDS);
    expect(t.points).toBe(501);
    expect(t.darts).toBe(18);
    expect(round2(threeDartAverage(t))).toBe(83.5);
  });

  it("a losing player's average uses what they actually scored", () => {
    const t = legTotalsForPlayer("A", legs, DEFAULT_BANDS);
    expect(t.points).toBe(375);
    expect(t.darts).toBe(15);
    expect(threeDartAverage(t)).toBe(75);
  });

  it("aggregates from total points and darts, not by averaging averages", () => {
    // Game 1: 501 in 15 darts (100.2). Game 2: 301 points in 30 darts (30.1).
    const g1 = { ...gameTotals("H", [], "WIN", DEFAULT_BANDS), points: 501, darts: 15 };
    const g2 = { ...gameTotals("H", [], "LOSS", DEFAULT_BANDS), points: 301, darts: 30 };
    const season = aggregate([g1, g2]);
    expect(round2(threeDartAverage(season))).toBe(53.47); // 802 / 45 × 3
    const naive = ((threeDartAverage(g1) ?? 0) + (threeDartAverage(g2) ?? 0)) / 2;
    expect(round2(naive)).toBe(65.15);
    expect(threeDartAverage(season)).not.toBeCloseTo(naive);
  });

  it("counts bust darts with zero points", () => {
    const leg = playLeg({ ...LEG_501, startingScore: 101 }, [["HOME", 60], ["AWAY", 0], ["HOME", 60], ["AWAY", 0]]);
    const t = legTotalsForPlayer("H", [{ visits: leg.visits, winner: null }], DEFAULT_BANDS);
    expect(t).toMatchObject({ points: 60, darts: 6 });
  });

  it("is null when no darts were thrown", () => {
    expect(threeDartAverage(walkoverTotals(true))).toBeNull();
  });
});

describe("count statistics", () => {
  it("puts each visit in exactly one band", () => {
    const leg = playLeg(LEG_501, [
      ["HOME", 180], ["AWAY", 0],
      ["HOME", 140], ["AWAY", 0],
      ["HOME", 139], ["AWAY", 0],
      ["HOME", 42, 3],
    ]);
    const t = legTotalsForPlayer("H", [{ visits: leg.visits, winner: leg.winner }], DEFAULT_BANDS);
    expect(t.bands).toEqual({ "180": 1, "140": 1, "100": 1 });
  });

  it("supports overlapping bands when a league explicitly defines them", () => {
    const cumulative = [
      { key: "180", label: "180s", min: 180, max: 180 },
      { key: "140", label: "140+", min: 140, max: 180 },
    ];
    // bandFor takes the first match, so overlapping ranges still count once per visit;
    // a league wanting "140+ includes 180s" lists 140 first.
    const leg = playLeg(LEG_501, [["HOME", 180], ["AWAY", 0]]);
    const t = legTotalsForPlayer("H", [{ visits: leg.visits, winner: null }], [cumulative[1], cumulative[0]]);
    expect(t.bands).toEqual({ "140": 1 });
  });

  it("tracks highest checkout and least darts from won legs only", () => {
    const t = legTotalsForPlayer("H", legs, DEFAULT_BANDS);
    expect(t.highestCheckout).toBe(41);
    expect(t.bestLegDarts).toBe(18);
    const loser = legTotalsForPlayer("A", legs, DEFAULT_BANDS);
    expect(loser.highestCheckout).toBeNull();
    expect(loser.bestLegDarts).toBeNull();
  });

  it("reports totals and per-game rates", () => {
    const games: StatTotals[] = [
      { ...gameTotals("H", [], "WIN", DEFAULT_BANDS), bands: { "180": 2 } },
      { ...gameTotals("H", [], "LOSS", DEFAULT_BANDS), bands: { "180": 1 } },
      { ...gameTotals("H", [], "WIN", DEFAULT_BANDS), bands: {} },
      { ...gameTotals("H", [], "DRAW", DEFAULT_BANDS), bands: {} },
    ];
    const t = aggregate(games);
    expect(t.bands["180"]).toBe(3);
    expect(perGame(t, "180")).toBe(0.75);
    expect(winPercentage(t)).toBe(50);
    expect(t).toMatchObject({ gamesPlayed: 4, wins: 2, losses: 1, draws: 1 });
  });
});

describe("walkovers", () => {
  it("never produce darts statistics", () => {
    for (const recordWin of [true, false]) {
      const t = walkoverTotals(recordWin);
      expect(t).toMatchObject({ points: 0, darts: 0, bands: {}, highestCheckout: null, bestLegDarts: null });
    }
  });

  it("do not dilute a season average", () => {
    const played = { ...gameTotals("H", legs, "WIN", DEFAULT_BANDS) };
    const season = aggregate([played, walkoverTotals(true)]);
    expect(round2(threeDartAverage(season))).toBe(83.5);
    expect(season.gamesPlayed).toBe(2);
    expect(season.wins).toBe(2);
  });
});
