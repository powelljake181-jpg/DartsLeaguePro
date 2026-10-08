import { describe, expect, it } from "vitest";
import { applyVisit, initialLegState, resolveVisit } from "@/domain/scoring";
import { mulberry32 } from "@/domain/scheduling";
import { aggregate, legTotalsForPlayer, threeDartAverage } from "@/domain/stats";
import { DEFAULT_BANDS } from "@/domain/rules";
import { simulateLeg } from "./simulate";

/** Replay a simulated leg through the real scoring engine; throws on any illegal visit. */
function replay(visits: ReturnType<typeof simulateLeg>, starting: "HOME" | "AWAY", pairs = false) {
  const cfg = { startingScore: 501, doubleOut: true, startingSide: starting, alternatePartners: pairs };
  let state = initialLegState(cfg);
  for (const v of visits) state = applyVisit(state, resolveVisit(state, cfg, v));
  return state;
}

describe("demo darts simulator", () => {
  it("produces only legal legs that finish on a checkout", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 300; i++) {
      const starting = i % 2 ? "HOME" : "AWAY";
      const visits = simulateLeg(rng, { HOME: [{ playerId: "h", average: 30 + (i % 50) }], AWAY: [{ playerId: "a", average: 75 - (i % 40) }] }, starting);
      const state = replay(visits, starting);
      expect(state.winner).not.toBeNull();
    }
  });

  it("alternates partners in pairs legs", () => {
    const rng = mulberry32(2);
    for (let i = 0; i < 100; i++) {
      const visits = simulateLeg(rng, { HOME: [{ playerId: "h1", average: 50 }, { playerId: "h2", average: 55 }], AWAY: [{ playerId: "a1", average: 45 }, { playerId: "a2", average: 60 }] }, "HOME");
      expect(replay(visits, "HOME", true).winner).not.toBeNull();
    }
  });

  it("lands near the thrower's average and the better player usually wins", () => {
    const rng = mulberry32(3);
    const legs = Array.from({ length: 400 }, () => simulateLeg(rng, { HOME: [{ playerId: "good", average: 70 }], AWAY: [{ playerId: "weak", average: 40 }] }, "HOME"));
    const records = legs.map((visits) => ({ visits: replay(visits, "HOME").visits, winner: replay(visits, "HOME").winner }));
    const avg = (id: string) => threeDartAverage(aggregate(records.map((r) => legTotalsForPlayer(id, [r], DEFAULT_BANDS))))!;
    expect(avg("good")).toBeGreaterThan(55);
    expect(avg("good")).toBeLessThan(80);
    expect(avg("weak")).toBeGreaterThan(28);
    expect(avg("weak")).toBeLessThan(50);
    expect(records.filter((r) => r.winner === "HOME").length / records.length).toBeGreaterThan(0.75);
  });
});
