import { describe, expect, it } from "vitest";
import { bracketSize, CupError, drawFirstRound, nextRoundPairs, roundCount, roundName, seedOrder, validateManualDraw } from "./cups";

const teams = (n: number) => Array.from({ length: n }, (_, i) => ({ entryId: `t${i + 1}` }));

describe("cup brackets", () => {
  it("rounds up to a power of two and names rounds from the final back", () => {
    expect([2, 3, 8, 11, 16, 17].map(bracketSize)).toEqual([2, 4, 8, 16, 16, 32]);
    expect(roundCount(11)).toBe(4);
    expect([1, 2, 3, 4].map((r) => roundName(r, 4))).toEqual(["Last 16", "Quarter-finals", "Semi-finals", "Final"]);
    expect(roundName(1, 7)).toBe("Round 1");
    expect(() => bracketSize(1)).toThrow(CupError);
  });

  it("uses standard seeding order", () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("gives byes to the top seeds and never pairs two byes", () => {
    const entrants = teams(11).map((t, i) => ({ ...t, seed: i + 1 }));
    const ties = drawFirstRound(entrants, "SEEDED", 42);
    expect(ties).toHaveLength(8);
    const byes = ties.filter((t) => t.away === null).map((t) => t.home);
    expect(byes.sort()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    const all = ties.flatMap((t) => [t.home, t.away]).filter(Boolean);
    expect(new Set(all).size).toBe(11);
    // Seeds 1 and 2 are in opposite halves, so they can only meet in the final.
    const slotOf = (id: string) => ties.findIndex((t) => t.home === id || t.away === id);
    expect(slotOf("t1") < 4).not.toBe(slotOf("t2") < 4);
  });

  it("is reproducible for a given seed (preview = saved draw) and differs between seeds", () => {
    expect(drawFirstRound(teams(9), "RANDOM", 7)).toEqual(drawFirstRound(teams(9), "RANDOM", 7));
    expect(drawFirstRound(teams(9), "RANDOM", 7)).not.toEqual(drawFirstRound(teams(9), "RANDOM", 8));
  });

  it("spreads byes in a random draw too", () => {
    for (let seed = 1; seed < 30; seed++) {
      const ties = drawFirstRound(teams(5), "RANDOM", seed);
      expect(ties.filter((t) => t.away === null)).toHaveLength(3);
      expect(ties.every((t) => t.home)).toBe(true);
    }
  });

  it("refuses duplicate seeds", () => {
    expect(() => drawFirstRound([{ entryId: "a", seed: 1 }, { entryId: "b", seed: 1 }], "SEEDED", 1)).toThrow("same seed");
  });

  it("validates a manual draw", () => {
    const ids = ["a", "b", "c"];
    expect(validateManualDraw(ids, [{ home: "a", away: "b" }, { home: null, away: "c" }])).toEqual([
      { home: "a", away: "b" },
      { home: "c", away: null },
    ]);
    expect(() => validateManualDraw(ids, [{ home: "a", away: "b" }])).toThrow("2 first-round ties");
    expect(() => validateManualDraw(ids, [{ home: "a", away: "a" }, { home: "c", away: null }])).toThrow("drawn twice");
    expect(() => validateManualDraw(ids, [{ home: "a", away: "b" }, { home: null, away: null }])).toThrow("no teams");
    expect(() => validateManualDraw(["a", "b", "c", "d"], [{ home: "a", away: "b" }, { home: "c", away: null }])).toThrow("hasn't been drawn");
  });

  it("pairs winners of adjacent ties", () => {
    expect(nextRoundPairs(["a", null, "c", "d"])).toEqual([
      { home: "a", away: null },
      { home: "c", away: "d" },
    ]);
  });
});
