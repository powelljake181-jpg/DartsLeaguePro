import { describe, expect, it } from "vitest";
import { projectGame, type ServerGameState } from "./projection";
import { ScoringError, type Side, type VisitInput } from "./scoring";

const fresh = (over: Partial<ServerGameState> = {}): ServerGameState => ({
  status: "PENDING",
  winner: null,
  homeLegs: 0,
  awayLegs: 0,
  legsFormat: "BEST_OF",
  legs: 3,
  startingScore: 501,
  doubleOut: true,
  firstThrower: "HOME",
  players: { HOME: ["h"], AWAY: ["a"] },
  currentLeg: { ordinal: 1, startingSide: "HOME", remaining: { HOME: 501, AWAY: 501 }, nextToThrow: "HOME", nextPlayer: { HOME: "h", AWAY: "a" }, finished: false },
  ...over,
});
const v = (side: Side, scored: number, darts?: number, playerId = side === "HOME" ? "h" : "a"): VisitInput => ({ side, scored, darts, playerId });
const leg = (winner: Side, starter: Side): VisitInput[] => {
  const out: VisitInput[] = [];
  const loser: Side = winner === "HOME" ? "AWAY" : "HOME";
  const order = starter === winner ? [winner, loser] : [loser, winner];
  for (let i = 0; i < 5; i++) for (const s of order) out.push(v(s, s === winner ? [100, 100, 100, 100, 60][i] : 60));
  if (starter !== winner) out.push(v(loser, 60));
  out.push(v(winner, 41, 3));
  return out;
};

describe("projecting pending visits", () => {
  it("applies visits on top of the server's state", () => {
    const p = projectGame(fresh(), [v("HOME", 180), v("AWAY", 60)]);
    expect(p).toMatchObject({ remaining: { HOME: 321, AWAY: 441 }, nextToThrow: "HOME", finished: false });
  });

  it("moves to the next leg with the throw alternating, and finishes the game", () => {
    const afterLeg1 = projectGame(fresh(), leg("HOME", "HOME"));
    expect(afterLeg1).toMatchObject({ legOrdinal: 2, startingSide: "AWAY", nextToThrow: "AWAY", legsWon: { HOME: 1, AWAY: 0 }, remaining: { HOME: 501, AWAY: 501 } });
    const done = projectGame(fresh(), [...leg("HOME", "HOME"), ...leg("HOME", "AWAY")]);
    expect(done).toMatchObject({ finished: true, winner: "HOME", legsWon: { HOME: 2, AWAY: 0 } });
    expect(() => projectGame(fresh(), [...leg("HOME", "HOME"), ...leg("HOME", "AWAY"), v("AWAY", 60)])).toThrow(/already finished/);
  });

  it("rejects the same visits the server would", () => {
    expect(() => projectGame(fresh(), [v("AWAY", 60)])).toThrow(ScoringError);
    expect(() => projectGame(fresh(), [v("HOME", 179)])).toThrow(ScoringError);
  });

  it("tracks the next partner in pairs", () => {
    const pairs = fresh({
      players: { HOME: ["h1", "h2"], AWAY: ["a1", "a2"] },
      currentLeg: { ordinal: 1, startingSide: "HOME", remaining: { HOME: 501, AWAY: 501 }, nextToThrow: "HOME", nextPlayer: { HOME: null, AWAY: null }, finished: false },
    });
    expect(projectGame(pairs, []).nextPlayer).toEqual({ HOME: null, AWAY: null });
    const p = projectGame(pairs, [v("HOME", 60, undefined, "h2"), v("AWAY", 60, undefined, "a1")]);
    expect(p.nextPlayer).toEqual({ HOME: "h1", AWAY: "a2" });
  });

  it("keeps the server's winner for a finished game", () => {
    expect(projectGame(fresh({ status: "COMPLETED", winner: "HOME", homeLegs: 2, currentLeg: null }), [])).toMatchObject({ finished: true, winner: "HOME" });
    const lastLegShown = { ordinal: 1, startingSide: "HOME" as const, remaining: { HOME: 0, AWAY: 236 }, nextToThrow: "AWAY" as const, nextPlayer: { HOME: null, AWAY: null }, finished: true };
    expect(projectGame(fresh({ status: "COMPLETED", winner: "HOME", homeLegs: 1, legs: 1, currentLeg: lastLegShown }), [])).toMatchObject({ winner: "HOME" });
  });
});
