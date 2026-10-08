import { describe, expect, it } from "vitest";
import { awardedOutcomes, fixtureOutcomes, fixtureProgress, type GameSummary } from "./match";
import { defineRules, pairs, resultGroup, singles, type LeagueRules, type PointsConfig } from "./rules";
import { computeStandings, fixturePoints, type ResultRow } from "./standings";

const won = (winner: "HOME" | "AWAY"): GameSummary => ({
  status: "COMPLETED",
  winner,
  homeLegs: winner === "HOME" ? 1 : 0,
  awayLegs: winner === "AWAY" ? 1 : 0,
});
const pending: GameSummary = { status: "PENDING", winner: null, homeLegs: 0, awayLegs: 0 };
const games = (home: number, away: number): GameSummary[] => [
  ...Array.from({ length: home }, () => won("HOME")),
  ...Array.from({ length: away }, () => won("AWAY")),
];
const oneGroup = (n: number, g: Parameters<typeof resultGroup>[0] = { key: "main" }): LeagueRules =>
  defineRules({ match: { slots: singles(n), groups: [resultGroup(g)] } });

/** Manchester Division 1: 7 games, all played, no draws, 7 for a win + 1 per game. */
const DIV1_POINTS: PointsConfig = { win: 7, draw: 0, loss: 0, perGameWon: 1 };
const div1 = oneGroup(7, { key: "main", points: DIV1_POINTS });
const SIMPLE2: PointsConfig = { win: 2, draw: 1, loss: 0, perGameWon: 0 };
const SIMPLE3: PointsConfig = { win: 3, draw: 1, loss: 0, perGameWon: 0 };
const main = (rules: LeagueRules, g: GameSummary[]) => fixtureOutcomes(g, rules).main;

describe("league points", () => {
  it("7 for a match win + 1 per game: a 4–3 win gives 11 and 3", () => {
    expect(fixturePoints(main(div1, games(4, 3)), DIV1_POINTS)).toEqual({ home: 11, away: 3 });
  });

  it("simple 2/1/0 and 3/1/0 systems", () => {
    expect(fixturePoints(main(div1, games(4, 3)), SIMPLE2)).toEqual({ home: 2, away: 0 });
    expect(fixturePoints(main(div1, games(2, 5)), SIMPLE3)).toEqual({ home: 0, away: 3 });
  });

  it("draws when allowed", () => {
    const eight = oneGroup(8, { key: "main", allowDraw: true });
    const o = main(eight, games(4, 4));
    expect(o.winner).toBe("DRAW");
    expect(fixturePoints(o, SIMPLE2)).toEqual({ home: 1, away: 1 });
  });

  it("refuses to finalise a level result when draws are not allowed", () => {
    const level: GameSummary[] = [...games(3, 3), { status: "VOID", winner: null, homeLegs: 0, awayLegs: 0 }];
    expect(() => fixtureOutcomes(level, div1)).toThrow(/draws are not allowed/);
  });
});

describe("match format", () => {
  const bestOf7 = oneGroup(7, { key: "main", format: "BEST_OF", deadRubbers: "SKIP" });

  it("best of 7 is complete at 4 wins and the rest are not required", () => {
    const g = [...games(4, 1), pending, pending];
    expect(fixtureProgress(g, bestOf7)).toMatchObject({ complete: true, notRequired: [6, 7] });
    expect(main(bestOf7, g)).toMatchObject({ homeGames: 4, awayGames: 1, winner: "HOME" });
  });

  it("fixed 7 games is not complete until all are played", () => {
    const g = [...games(4, 1), pending, pending];
    expect(fixtureProgress(g, div1)).toMatchObject({ complete: false });
    expect(() => fixtureOutcomes(g, div1)).toThrow(/not complete/);
  });
});

describe("pairs and result groups", () => {
  it("6 singles + 1 pairs all count towards one overall result", () => {
    const rules = defineRules({ match: { slots: [...singles(6), ...pairs(1)], groups: [resultGroup({ key: "main", points: DIV1_POINTS })] } });
    const o = fixtureOutcomes([...games(3, 3), won("HOME")], rules);
    expect(Object.keys(o)).toEqual(["main"]);
    expect(o.main).toMatchObject({ homeGames: 4, awayGames: 3, winner: "HOME" });
  });

  it("a pairs game can feed a separate pairs table", () => {
    const rules = defineRules({
      match: {
        slots: [...pairs(1, "pairs"), ...singles(7, "main")],
        groups: [
          resultGroup({ key: "main", name: "League", points: DIV1_POINTS }),
          resultGroup({ key: "pairs", name: "Pairs", points: { win: 1, draw: 0, loss: 0, perGameWon: 0 } }),
        ],
      },
    });
    // Away win the pairs; home win the singles 5–2.
    const o = fixtureOutcomes([won("AWAY"), ...games(5, 2)], rules);
    expect(o.main).toMatchObject({ homeGames: 5, awayGames: 2, winner: "HOME" });
    expect(o.pairs).toMatchObject({ homeGames: 0, awayGames: 1, winner: "AWAY" });
  });

  it("the fixture is only complete when every group is", () => {
    const rules = defineRules({
      match: { slots: [...singles(3), ...pairs(1, "pairs")], groups: [resultGroup({ key: "main" }), resultGroup({ key: "pairs" })] },
    });
    expect(fixtureProgress([...games(2, 1), pending], rules).complete).toBe(false);
    expect(fixtureProgress([...games(2, 1), won("HOME")], rules).complete).toBe(true);
  });

  it("validates each group's format separately", () => {
    // 2 pairs games in their own group can be level, so draws must be allowed there.
    expect(() =>
      defineRules({ match: { slots: [...singles(7), ...pairs(2, "pairs")], groups: [resultGroup({ key: "main" }), resultGroup({ key: "pairs" })] } }),
    ).toThrow(/even number of games/);
    expect(() => defineRules({ match: { slots: singles(7, "nope"), groups: [resultGroup({ key: "main" })] } })).toThrow(/unknown result group/);
  });

  it("a maximum-loss award covers every group", () => {
    const rules = defineRules({
      match: { slots: [...pairs(1, "pairs"), ...singles(7)], groups: [resultGroup({ key: "main" }), resultGroup({ key: "pairs" })] },
    });
    const o = awardedOutcomes("AWAY", rules);
    expect(o.main).toMatchObject({ homeGames: 0, awayGames: 7, winner: "AWAY" });
    expect(o.pairs).toMatchObject({ homeGames: 0, awayGames: 1, winner: "AWAY" });
  });
});

describe("walkovers in the team score", () => {
  const wo: GameSummary = { status: "WALKOVER", winner: "HOME", homeLegs: 0, awayLegs: 0 };

  it("count as a game won and earn game points by default", () => {
    const o = main(div1, [...games(3, 3), wo]);
    expect(o).toMatchObject({ homeGames: 4, awayGames: 3, homePointGames: 4, homeLegs: 3 });
    expect(fixturePoints(o, DIV1_POINTS)).toEqual({ home: 11, away: 3 });
  });

  it("can count for the result but not earn game points", () => {
    const rules = { ...div1, walkover: { ...div1.walkover, earnsGamePoints: false } };
    expect(fixturePoints(main(rules, [...games(3, 3), wo]), DIV1_POINTS)).toEqual({ home: 10, away: 3 });
  });
});

describe("league table", () => {
  const entries = ["Melville", "Red Lion", "Crown", "Swan"].map((name) => ({ entryId: name, name }));
  const r = (id: string, home: string, away: string, h: number, a: number, points = DIV1_POINTS): ResultRow => ({
    fixtureId: id,
    homeEntryId: home,
    awayEntryId: away,
    outcome: main(div1, games(h, a)),
    points,
  });
  const TB = div1.match.groups[0].tieBreakers;

  it("builds P W D L, games and points from results", () => {
    const table = computeStandings(entries, [r("1", "Melville", "Red Lion", 4, 3), r("2", "Crown", "Swan", 1, 6)], TB);
    expect(table.find((t) => t.entryId === "Melville")).toMatchObject({
      played: 1, won: 1, lost: 0, gamesFor: 4, gamesAgainst: 3, gameDifference: 1, points: 11,
    });
    expect(table.map((t) => t.entryId)).toEqual(["Swan", "Melville", "Red Lion", "Crown"]);
    expect(table.find((t) => t.entryId === "Crown")!.points).toBe(1);
  });

  it("scores each fixture with its own points system (rules changed mid-season)", () => {
    const table = computeStandings(entries, [r("1", "Melville", "Red Lion", 4, 3, DIV1_POINTS), r("2", "Melville", "Crown", 4, 3, SIMPLE2)], TB);
    expect(table.find((t) => t.entryId === "Melville")!.points).toBe(11 + 2);
  });

  it("is empty but complete with no results", () => {
    const table = computeStandings(entries, [], TB);
    expect(table).toHaveLength(4);
    expect(table.every((t) => t.position === 1 && t.points === 0)).toBe(true);
  });

  it("applies tie-breakers in the configured order", () => {
    // Melville, Crown and Swan all on 2 points.
    // Game difference: Melville +7, Crown +1, Swan 0. Games won: Melville 7, Swan 7, Crown 4.
    const results = [
      r("1", "Melville", "Red Lion", 7, 0, SIMPLE2),
      r("2", "Crown", "Swan", 4, 3, SIMPLE2),
      r("3", "Swan", "Red Lion", 4, 3, SIMPLE2),
    ];
    const order = (tb: typeof TB) => computeStandings(entries, results, tb).map((t) => t.entryId);
    expect(order(["POINTS", "GAME_DIFFERENCE", "GAMES_WON"])).toEqual(["Melville", "Crown", "Swan", "Red Lion"]);
    expect(order(["POINTS", "GAMES_WON", "GAME_DIFFERENCE"])).toEqual(["Melville", "Swan", "Crown", "Red Lion"]);
  });

  it("shares a position when teams are level on every tie-breaker", () => {
    const table = computeStandings(entries, [r("1", "Melville", "Red Lion", 4, 3, SIMPLE2), r("2", "Crown", "Swan", 4, 3, SIMPLE2)], TB);
    expect(table.slice(0, 2).map((t) => [t.entryId, t.position])).toEqual([["Crown", 1], ["Melville", 1]]);
    expect(table[2].position).toBe(3);
  });

  it("resolves head-to-head among only the tied teams", () => {
    // Melville and Crown both win 2 matches. Crown beat Melville, so Crown is above despite worse GD.
    const results = [
      r("1", "Crown", "Melville", 4, 3, SIMPLE2),
      r("2", "Melville", "Red Lion", 7, 0, SIMPLE2),
      r("3", "Melville", "Swan", 7, 0, SIMPLE2),
      r("4", "Crown", "Swan", 4, 3, SIMPLE2),
      r("5", "Red Lion", "Crown", 4, 3, SIMPLE2),
    ];
    const table = computeStandings(entries, results, ["POINTS", "HEAD_TO_HEAD", "GAME_DIFFERENCE"]);
    expect(table[0].entryId).toBe("Crown");
    expect(table[1].entryId).toBe("Melville");
    expect(table[1].gameDifference).toBeGreaterThan(table[0].gameDifference);
  });

  it("places withdrawn teams at the bottom", () => {
    const withFolded = entries.map((e) => (e.entryId === "Swan" ? { ...e, withdrawn: true } : e));
    const table = computeStandings(withFolded, [r("1", "Swan", "Crown", 7, 0)], TB);
    expect(table.at(-1)!.entryId).toBe("Swan");
  });
});
