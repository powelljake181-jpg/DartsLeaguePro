import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase, type Db } from "@/db/client";
import { auditLog, games } from "@/db/schema";
import { ForbiddenError } from "@/domain/permissions";
import { defineRules, pairs, resultGroup, singles, type LeagueRules, type PointsConfig } from "@/domain/rules";
import { threeDartAverage } from "@/domain/stats";
import { completeFixture, recordVisit, setLineup, startFixture } from "./match-service";
import { applyRuleChange, previewRuleChange } from "./rules-service";
import { getStandings, getTables } from "./standings-service";
import { playerStats } from "./stats-service";
import { buildScenario, DIV1_RULES, playGame, type Scenario } from "./testing/scenario";

const DIV1_POINTS: PointsConfig = { win: 7, draw: 0, loss: 0, perGameWon: 1 };
const ONE_FOR_A_WIN: PointsConfig = { win: 1, draw: 0, loss: 0, perGameWon: 0 };

/** One pairs game into its own "Pairs" table, then 7 singles for the league. */
const PAIRS_SEPARATE = defineRules({
  match: {
    slots: [...pairs(1, "pairs"), ...singles(7)],
    groups: [resultGroup({ key: "main", name: "League", points: DIV1_POINTS }), resultGroup({ key: "pairs", name: "Pairs", points: ONE_FOR_A_WIN })],
  },
});
/** 6 singles and 1 pairs, all counting towards the one result. */
const COMBINED = defineRules({
  match: { slots: [...singles(6), ...pairs(1)], groups: [resultGroup({ key: "main", name: "League", points: DIV1_POINTS })] },
});

let db: Db;
let s: Scenario;
const setup = async (rules: LeagueRules) => {
  db = await openTestDatabase();
  s = await buildScenario(db, { rules });
};

/** One entry per game: a registration id, "id+id" for a pair, or null for no player (walkover). */
const slots = (regIds: (string | null)[]) =>
  regIds.map((r, i) => ({ gameOrdinal: i + 1, registrationIds: r === null ? [] : r.split("+") }));
const fixtureId = () => s.fixtures.melvilleVRedLion.id;

async function lineups(home: (string | null)[], away: (string | null)[]) {
  await setLineup(db, s.actors.melville, { fixtureId: fixtureId(), side: "HOME", slots: slots(home), confirm: true });
  await setLineup(db, s.actors.redLion, { fixtureId: fixtureId(), side: "AWAY", slots: slots(away), confirm: true });
  await startFixture(db, s.actors.melville, fixtureId());
}

describe("a pairs game feeding a separate pairs table", () => {
  beforeEach(() => setup(PAIRS_SEPARATE));

  it("produces a league table and a pairs table from one fixture", async () => {
    const [m, r] = [s.team.Melville.registrationIds, s.team["Red Lion"].registrationIds];
    // Game 1 pairs; games 2–8 singles (Red Lion have six players, so game 8 is a walkover).
    await lineups([`${m[0]}+${m[1]}`, ...m], [`${r[0]}+${r[1]}`, ...r, null]);
    const mp = s.team.Melville.playerIds;
    const rp = s.team["Red Lion"].playerIds;
    await playGame(db, s, fixtureId(), 1, "AWAY", { pairs: { HOME: [mp[0], mp[1]], AWAY: [rp[0], rp[1]] } });
    for (const g of [2, 3, 4]) await playGame(db, s, fixtureId(), g, "HOME");
    for (const g of [5, 6, 7]) await playGame(db, s, fixtureId(), g, "AWAY");
    await completeFixture(db, s.actors.melville, fixtureId());

    const [league, pairsTable] = await getTables(db, s.competition.id);
    expect(league.name).toBe("League");
    expect(league.rows.find((x) => x.name === "Melville")).toMatchObject({ won: 1, gamesFor: 4, gamesAgainst: 3, points: 11 });
    expect(pairsTable.name).toBe("Pairs");
    expect(pairsTable.rows.find((x) => x.name === "Red Lion")).toMatchObject({ won: 1, gamesFor: 1, points: 1 });
    expect(pairsTable.rows.find((x) => x.name === "Melville")).toMatchObject({ lost: 1, points: 0 });
  });

  it("credits each partner with their own darts, and keeps pairs and singles records apart", async () => {
    const [m, r] = [s.team.Melville.registrationIds, s.team["Red Lion"].registrationIds];
    await lineups([`${m[0]}+${m[1]}`, ...m], [`${r[0]}+${r[1]}`, ...r, null]);
    const [mp, rp] = [s.team.Melville.playerIds, s.team["Red Lion"].playerIds];
    await playGame(db, s, fixtureId(), 1, "AWAY", { pairs: { HOME: [mp[0], mp[1]], AWAY: [rp[0], rp[1]] } });
    await playGame(db, s, fixtureId(), 2, "HOME"); // Red Lion player 1 loses their single

    // Partners alternate: player 1 threw 100, 100, 60; player 2 threw 100, 100 and the 41 checkout.
    const pairsStats = await playerStats(db, { playerIds: [rp[0], rp[1]], gameKind: "PAIRS" });
    expect(pairsStats.get(rp[0])).toMatchObject({ points: 260, darts: 9, wins: 1, legsWon: 1, highestCheckout: null, bestLegDarts: 18 });
    expect(pairsStats.get(rp[1])).toMatchObject({ points: 241, darts: 9, wins: 1, highestCheckout: 41, bestLegDarts: 18 });

    const singlesStats = (await playerStats(db, { playerIds: [rp[0]], gameKind: "SINGLES" })).get(rp[0])!;
    expect(singlesStats).toMatchObject({ points: 300, darts: 15, wins: 0, losses: 1 });
    const everything = (await playerStats(db, { playerIds: [rp[0]] })).get(rp[0])!;
    expect(threeDartAverage(everything)).toBe(((260 + 300) / (9 + 15)) * 3);
  });

  it("makes partners alternate and requires the thrower in a pairs game", async () => {
    const [m, r] = [s.team.Melville.registrationIds, s.team["Red Lion"].registrationIds];
    await lineups([`${m[0]}+${m[1]}`, ...m], [`${r[0]}+${r[1]}`, ...r, null]);
    const mp = s.team.Melville.playerIds;
    const visit = (side: "HOME" | "AWAY", playerId?: string) =>
      recordVisit(db, s.actors.melville, { fixtureId: fixtureId(), gameOrdinal: 1, clientEventId: randomUUID(), side, scored: 60, playerId });
    await expect(visit("HOME")).rejects.toMatchObject({ code: "PLAYER_NOT_IN_GAME" });
    await visit("HOME", mp[0]);
    await visit("AWAY", s.team["Red Lion"].playerIds[0]);
    await expect(visit("HOME", mp[0])).rejects.toThrow(/partners take turns/);
    await expect(visit("HOME", mp[1])).resolves.toMatchObject({ seq: 3 });
  });

  it("creates games with their kind and result group", async () => {
    const [m, r] = [s.team.Melville.registrationIds, s.team["Red Lion"].registrationIds];
    await lineups([`${m[0]}+${m[1]}`, ...m], [`${r[0]}+${r[1]}`, ...r, null]);
    const rows = await db.select().from(games).where(eq(games.fixtureId, fixtureId()));
    const byOrdinal = rows.sort((a, b) => a.ordinal - b.ordinal).map((g) => [g.kind, g.groupKey]);
    expect(byOrdinal[0]).toEqual(["PAIRS", "pairs"]);
    expect(byOrdinal.slice(1).every(([k, g]) => k === "SINGLES" && g === "main")).toBe(true);
  });
});

describe("singles and pairs combined into one result", () => {
  beforeEach(() => setup(COMBINED));

  it("counts the pairs game towards the overall score", async () => {
    const [m, r] = [s.team.Melville.registrationIds, s.team["Red Lion"].registrationIds];
    await lineups([...m.slice(0, 6), `${m[0]}+${m[1]}`], [...r, `${r[0]}+${r[1]}`]);
    const [mp, rp] = [s.team.Melville.playerIds, s.team["Red Lion"].playerIds];
    for (const g of [1, 2, 3]) await playGame(db, s, fixtureId(), g, "HOME");
    for (const g of [4, 5, 6]) await playGame(db, s, fixtureId(), g, "AWAY");
    await playGame(db, s, fixtureId(), 7, "HOME", { pairs: { HOME: [mp[0], mp[1]], AWAY: [rp[0], rp[1]] } });
    await completeFixture(db, s.actors.melville, fixtureId());

    const tables = await getTables(db, s.competition.id);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows.find((x) => x.name === "Melville")).toMatchObject({ gamesFor: 4, gamesAgainst: 3, points: 11 });
  });
});

describe("dated rule changes", () => {
  beforeEach(() => setup(DIV1_RULES));

  const SIMPLE3: PointsConfig = { win: 3, draw: 1, loss: 0, perGameWon: 0 };
  const withPoints = (points: PointsConfig) =>
    defineRules({ ...DIV1_RULES, match: { ...DIV1_RULES.match, groups: [{ ...DIV1_RULES.match.groups[0], points }] } });
  const now = new Date("2026-10-20T12:00:00Z");

  /** Sep 2: Melville 4–3 Red Lion. Oct 14: Crown 4–3 Swan. Both 11 points under Division 1 rules. */
  async function playBothFixtures() {
    const [m, r] = [s.team.Melville.registrationIds, s.team["Red Lion"].registrationIds];
    await lineups(m, [...r, null]);
    for (const g of [1, 2, 3]) await playGame(db, s, fixtureId(), g, "HOME");
    for (const g of [4, 5, 6]) await playGame(db, s, fixtureId(), g, "AWAY");
    await completeFixture(db, s.actors.melville, fixtureId());

    const cs = s.fixtures.crownVSwan.id;
    await setLineup(db, s.actors.crown, { fixtureId: cs, side: "HOME", slots: slots(s.team.Crown.registrationIds), confirm: true });
    await setLineup(db, s.actors.secretary, { fixtureId: cs, side: "AWAY", slots: slots(s.team.Swan.registrationIds), confirm: true });
    await startFixture(db, s.actors.crown, cs);
    for (const g of [1, 2, 3, 4]) await playGame(db, s, cs, g, "HOME", { actor: s.actors.crown });
    for (const g of [5, 6, 7]) await playGame(db, s, cs, g, "AWAY", { actor: s.actors.crown });
    await completeFixture(db, s.actors.crown, cs);
  }
  const points = async (name: string) => (await getStandings(db, s.competition.id, now)).find((r) => r.name === name)!.points;

  it("requires an effective date and a reason, and only league admins can change rules", async () => {
    const base = { competitionId: s.competition.id, rules: withPoints(SIMPLE3), reason: "AGM vote" };
    await expect(applyRuleChange(db, s.actors.secretary, { ...base, effectiveFrom: "" }, now)).rejects.toMatchObject({ code: "EFFECTIVE_DATE_REQUIRED" });
    await expect(applyRuleChange(db, s.actors.secretary, { ...base, effectiveFrom: "2026-10-01", reason: " " }, now)).rejects.toMatchObject({
      code: "REASON_REQUIRED",
    });
    await expect(applyRuleChange(db, s.actors.melville, { ...base, effectiveFrom: "2026-10-01" }, now)).rejects.toThrow(ForbiddenError);
    await expect(applyRuleChange(db, s.actors.otherSecretary, { ...base, effectiveFrom: "2026-10-01" }, now)).rejects.toThrow(ForbiddenError);
  });

  it("previews a retrospective change without applying it, then applies it from that date only", async () => {
    await playBothFixtures();
    const change = { competitionId: s.competition.id, rules: withPoints(SIMPLE3), effectiveFrom: "2026-10-01", reason: "AGM vote" };

    const preview = await previewRuleChange(db, s.actors.secretary, change, now);
    expect(preview).toMatchObject({ retrospective: true, until: null, structural: [], changes: ["League points"] });
    expect(preview.recalculatedFixtures.map((f) => f.fixtureId)).toEqual([s.fixtures.crownVSwan.id]);
    const after = (name: string) => preview.tables.after[0].rows.find((r) => r.name === name)!.points;
    expect([after("Melville"), after("Crown")]).toEqual([11, 3]);
    // Nothing changed yet.
    expect([await points("Melville"), await points("Crown")]).toEqual([11, 11]);

    await applyRuleChange(db, s.actors.secretary, change, now);
    // September fixture keeps the old rules; the October one is re-scored.
    expect([await points("Melville"), await points("Crown")]).toEqual([11, 3]);
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "rules.changed"));
    expect(log).toMatchObject({ actorUserId: "secretary", reason: "AGM vote" });

    // Backdating to the start of the season re-scores everything.
    await applyRuleChange(db, s.actors.secretary, { ...change, effectiveFrom: "2026-09-01" }, now);
    expect([await points("Melville"), await points("Crown")]).toEqual([3, 3]);
  });

  it("recalculates results when walkover treatment changes retrospectively", async () => {
    await playBothFixtures(); // Melville's 4–3 included a walkover
    const rules = { ...DIV1_RULES, walkover: { ...DIV1_RULES.walkover, earnsGamePoints: false } };
    await applyRuleChange(db, s.actors.secretary, { competitionId: s.competition.id, rules, effectiveFrom: "2026-09-01", reason: "walkovers earn no bonus" }, now);
    expect(await points("Melville")).toBe(10);
  });

  it("refuses to change the match format over fixtures already played, but allows it from a later date", async () => {
    await playBothFixtures();
    const format = defineRules({ ...DIV1_RULES, match: { ...DIV1_RULES.match, slots: [...singles(6), ...pairs(1)] } });
    const change = { competitionId: s.competition.id, rules: format, effectiveFrom: "2026-09-01", reason: "add a pairs game" };

    const preview = await previewRuleChange(db, s.actors.secretary, change, now);
    expect(preview.structural).toHaveLength(1);
    expect(preview.blockingFixtures).toHaveLength(2);
    await expect(applyRuleChange(db, s.actors.secretary, change, now)).rejects.toMatchObject({ code: "RULE_CHANGE_BLOCKED", status: 409 });

    await expect(applyRuleChange(db, s.actors.secretary, { ...change, effectiveFrom: "2026-10-15" }, now)).resolves.toMatchObject({
      blockingFixtures: [],
      recalculatedFixtures: [],
    });
    expect(await points("Melville")).toBe(11);
  });

  it("asks for lineups again when a format change covers a fixture not yet started", async () => {
    // Crown pick a lineup for 14 October, then the format changes from 1 October.
    const cs = s.fixtures.crownVSwan.id;
    await setLineup(db, s.actors.crown, { fixtureId: cs, side: "HOME", slots: slots(s.team.Crown.registrationIds), confirm: true });
    const format = defineRules({ ...DIV1_RULES, match: { ...DIV1_RULES.match, slots: [...singles(6), ...pairs(1)] } });
    const result = await applyRuleChange(
      db,
      s.actors.secretary,
      { competitionId: s.competition.id, rules: format, effectiveFrom: "2026-10-01", reason: "add a pairs game" },
      now,
    );
    expect(result.lineupsReset.map((f) => f.fixtureId)).toEqual([cs]);
    expect(await db.select().from(games).where(eq(games.fixtureId, cs))).toHaveLength(0);

    // The new lineup follows the new format: 6 singles + a pair.
    const c = s.team.Crown.registrationIds;
    await setLineup(db, s.actors.crown, { fixtureId: cs, side: "HOME", slots: slots([...c.slice(0, 6), `${c[0]}+${c[6]}`]), confirm: true });
    const created = await db.select().from(games).where(eq(games.fixtureId, cs));
    expect(created.find((g) => g.ordinal === 7)?.kind).toBe("PAIRS");
  });
});
