import { describe, expect, it } from "vitest";
import {
  gameProgress,
  isPossibleCheckout,
  isPossibleVisit,
  replayLeg,
  ScoringError,
  startingSideForLeg,
} from "./scoring";
import { LEG_501, playLeg } from "./test-helpers";

describe("possible scores", () => {
  it("rejects the impossible three-dart totals", () => {
    for (const s of [179, 178, 176, 175, 173, 172, 169, 166, 163]) expect(isPossibleVisit(s)).toBe(false);
    for (const s of [0, 26, 41, 100, 140, 171, 174, 177, 180]) expect(isPossibleVisit(s)).toBe(true);
    expect(isPossibleVisit(181)).toBe(false);
    expect(isPossibleVisit(-1)).toBe(false);
    expect(isPossibleVisit(60.5)).toBe(false);
  });

  it("knows double-out checkouts", () => {
    expect(isPossibleCheckout(170, 3, true)).toBe(true);
    expect(isPossibleCheckout(170, 2, true)).toBe(false);
    for (const bogey of [169, 168, 166, 165, 163, 162, 159]) expect(isPossibleCheckout(bogey, 3, true)).toBe(false);
    expect(isPossibleCheckout(50, 1, true)).toBe(true); // bull
    expect(isPossibleCheckout(40, 1, true)).toBe(true);
    expect(isPossibleCheckout(41, 1, true)).toBe(false);
    expect(isPossibleCheckout(110, 2, true)).toBe(true); // T20, bull
    expect(isPossibleCheckout(99, 2, true)).toBe(false);
    expect(isPossibleCheckout(1, 1, true)).toBe(false);
    expect(isPossibleCheckout(41, 1, false)).toBe(false); // no single dart scores 41
    expect(isPossibleCheckout(57, 1, false)).toBe(true); // T19 straight out
  });
});

describe("leg engine", () => {
  it("plays a leg to a checkout and alternates throws", () => {
    const leg = playLeg(LEG_501, [
      ["HOME", 100], ["AWAY", 60],
      ["HOME", 140], ["AWAY", 45],
      ["HOME", 180], ["AWAY", 85],
      ["HOME", 81, 3],
    ]);
    expect(leg.winner).toBe("HOME");
    expect(leg.remaining).toEqual({ HOME: 0, AWAY: 311 });
  });

  it("busts when the score goes below zero or leaves 1, keeping the darts", () => {
    const leg = playLeg({ ...LEG_501, startingScore: 101 }, [
      ["HOME", 60], ["AWAY", 0],
      ["HOME", 60], // 41 left → 60 is a bust
      ["AWAY", 100], // 1 left → bust under double-out
    ]);
    const [, , homeBust, awayBust] = leg.visits;
    expect(homeBust).toMatchObject({ isBust: true, score: 0, darts: 3, entered: 60 });
    expect(awayBust).toMatchObject({ isBust: true, score: 0, darts: 3 });
    expect(leg.remaining).toEqual({ HOME: 41, AWAY: 101 });
  });

  it("records darts actually used on a bust and on a checkout", () => {
    const leg = playLeg({ ...LEG_501, startingScore: 40 }, [
      ["HOME", 60, 1], // bust on the first dart
      ["AWAY", 0],
      ["HOME", 40, 1],
    ]);
    expect(leg.visits[0].darts).toBe(1);
    expect(leg.visits[2]).toMatchObject({ isCheckout: true, darts: 1, score: 40 });
  });

  it("rejects out-of-turn, impossible and post-finish visits", () => {
    expect(() => playLeg(LEG_501, [["AWAY", 60]])).toThrow(ScoringError);
    expect(() => playLeg(LEG_501, [["HOME", 179]])).toThrow(/not a possible/);
    expect(() => playLeg({ ...LEG_501, startingScore: 40 }, [["HOME", 40]])).toThrow(/darts used is required/);
    expect(() => playLeg({ ...LEG_501, startingScore: 168 }, [["HOME", 168, 3]])).toThrow(/cannot be checked out/);
    expect(() => playLeg({ ...LEG_501, startingScore: 40 }, [["HOME", 40, 1], ["AWAY", 20]])).toThrow(/already finished/);
    expect(() => playLeg(LEG_501, [["HOME", 60, 2]])).toThrow(/uses all 3 darts/);
  });

  it("replays stored visits to the same state and rejects tampered ones", () => {
    const leg = playLeg({ ...LEG_501, startingScore: 101 }, [["HOME", 60], ["AWAY", 41], ["HOME", 60], ["AWAY", 60, 3]]);
    expect(replayLeg({ ...LEG_501, startingScore: 101 }, leg.visits)).toEqual(leg);
    const tampered = leg.visits.map((v, i) => (i === 2 ? { ...v, isBust: false, score: 60 } : v));
    expect(() => replayLeg({ ...LEG_501, startingScore: 101 }, tampered)).toThrow(/inconsistent/);
  });
});

describe("game progress", () => {
  it("best of 3 legs ends at 2", () => {
    expect(gameProgress({ legsFormat: "BEST_OF", legs: 3 }, ["HOME"])).toMatchObject({ finished: false });
    expect(gameProgress({ legsFormat: "BEST_OF", legs: 3 }, ["HOME", "AWAY", "AWAY"])).toMatchObject({
      finished: true,
      winner: "AWAY",
      legsWon: { HOME: 1, AWAY: 2 },
    });
  });

  it("fixed legs can be drawn", () => {
    expect(gameProgress({ legsFormat: "FIXED", legs: 2 }, ["HOME", "AWAY"])).toMatchObject({ finished: true, winner: "DRAW" });
  });

  it("alternates the starting thrower each leg", () => {
    expect([0, 1, 2].map((i) => startingSideForLeg("AWAY", i))).toEqual(["AWAY", "HOME", "AWAY"]);
  });
});
