import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase, type Db } from "@/db/client";
import { cupRounds, fixtures, notifications } from "@/db/schema";
import { ForbiddenError } from "@/domain/permissions";
import { defineRules, resultGroup, singles } from "@/domain/rules";
import { AppError } from "./errors";
import { awardFixture, restoreFixture } from "./fixture-admin-service";
import { foldTeam } from "./fold-service";
import { completeFixture, setLineup, startFixture, voidFixture } from "./match-service";
import { addCupEntrant, createCup, cupBracket, makeDraw, previewDraw, removeCupEntrant, setCupRoundDate, setCupSeeds } from "./cup-service";
import { requestRearrangement } from "./rearrangement-service";
import { applyRuleChange } from "./rules-service";
import { buildScenario, DIV1_RULES, playGame, type Scenario } from "./testing/scenario";

let db: Db;
let s: Scenario;

beforeEach(async () => {
  db = await openTestDatabase();
  s = await buildScenario(db);
});

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;
const teamIds = (...names: (keyof Scenario["team"])[]) => names.map((n) => s.team[n].teamId);

async function cup(...names: (keyof Scenario["team"])[]) {
  const c = await createCup(db, s.actors.secretary, { seasonId: s.season.id, name: "Charity Cup", rules: DIV1_RULES, teamIds: teamIds(...names) });
  const rounds = await db.select().from(cupRounds).where(eq(cupRounds.competitionId, c.id)).orderBy(cupRounds.ordinal);
  return { c, rounds };
}
async function dateRounds(competitionId: string, dates: string[]) {
  const rounds = await db.select().from(cupRounds).where(eq(cupRounds.competitionId, competitionId)).orderBy(cupRounds.ordinal);
  for (const [i, r] of rounds.entries()) if (dates[i]) await setCupRoundDate(db, s.actors.secretary, { roundId: r.id, date: dates[i], kickOff: "19:30" });
}
const entryOf = async (competitionId: string, name: keyof Scenario["team"]) => {
  const b = await cupBracket(db, competitionId);
  return b.rounds.flatMap((r) => r.ties).flatMap((t) => (t ? [t.home, t.away] : [])).find((x) => x?.name === name)!.entryId;
};
const manual = async (competitionId: string, ties: [keyof Scenario["team"], keyof Scenario["team"] | null][]) => {
  const { entries } = await import("./cup-service").then((m) => m.cupAdmin(db, s.actors.secretary, competitionId));
  const id = (n: string | null) => (n ? entries.find((e) => e.entry.displayName === n)!.entry.id : null);
  return makeDraw(db, s.actors.secretary, { competitionId, mode: "MANUAL", manual: ties.map(([h, a]) => ({ home: id(h), away: id(a) })) });
};
const tie = async (competitionId: string, round: number, slot: number) =>
  (await db.select().from(fixtures).where(and(eq(fixtures.competitionId, competitionId), eq(fixtures.roundNumber, round), eq(fixtures.bracketSlot, slot))))[0];
const award = (fixtureId: string, winner: "HOME" | "AWAY") => awardFixture(db, s.actors.secretary, { fixtureId, winner, reason: "Test result" });

describe("setting up a cup", () => {
  it("needs a format that can't end level, and names rounds from the entrants", async () => {
    const drawable = defineRules({ match: { slots: singles(6), groups: [resultGroup({ key: "main", name: "Cup", allowDraw: true })] } });
    await expect(createCup(db, s.actors.secretary, { seasonId: s.season.id, name: "X", rules: drawable, teamIds: [] })).rejects.toSatisfy(code("CUP_DRAWS"));
    await expect(createCup(db, s.actors.melville, { seasonId: s.season.id, name: "X", rules: DIV1_RULES, teamIds: [] })).rejects.toThrow(ForbiddenError);

    const { c, rounds } = await cup("Melville", "Crown", "Swan");
    expect(rounds.map((r) => r.name)).toEqual(["Semi-finals", "Final"]);
    await addCupEntrant(db, s.actors.secretary, { competitionId: c.id, teamId: s.team["Red Lion"].teamId });
    await dateRounds(c.id, ["2026-11-04", "2026-11-18"]);
    // A fifth team makes it an 8-team bracket; the existing dates stay with the semis and the final.
    const other = await createCup(db, s.actors.secretary, { seasonId: s.season.id, name: "Other", rules: DIV1_RULES, teamIds: [] });
    await addCupEntrant(db, s.actors.secretary, { competitionId: other.id, teamId: s.team.Crown.teamId });
    const { entries } = await import("./cup-service").then((m) => m.cupAdmin(db, s.actors.secretary, c.id));
    await removeCupEntrant(db, s.actors.secretary, { entryId: entries.find((e) => e.entry.displayName === "Red Lion")!.entry.id });
    const after = await db.select().from(cupRounds).where(eq(cupRounds.competitionId, c.id)).orderBy(cupRounds.ordinal);
    expect(after.map((r) => [r.name, r.scheduledOn])).toEqual([
      ["Semi-finals", "2026-11-04"],
      ["Final", "2026-11-18"],
    ]);
  });

  it("refuses a rule change that would allow cup draws", async () => {
    const { c } = await cup("Melville", "Crown");
    const drawable = defineRules({ match: { slots: singles(6), groups: [resultGroup({ key: "main", name: "Cup", allowDraw: true })] } });
    await expect(applyRuleChange(db, s.actors.secretary, { competitionId: c.id, rules: drawable, effectiveFrom: "2026-09-02", reason: "x" })).rejects.toSatisfy(code("CUP_DRAWS"));
  });
});

describe("the draw", () => {
  it("needs a first-round date, and saves exactly the draw that was previewed", async () => {
    const { c } = await cup("Melville", "Crown", "Swan");
    await expect(makeDraw(db, s.actors.secretary, { competitionId: c.id, mode: "RANDOM", rngSeed: 5 })).rejects.toSatisfy(code("NO_ROUND_DATE"));
    await dateRounds(c.id, ["2026-11-04", "2026-11-18"]);
    const preview = await previewDraw(db, s.actors.secretary, { competitionId: c.id, mode: "RANDOM" });
    expect(await db.select().from(fixtures).where(eq(fixtures.competitionId, c.id))).toEqual([]);
    const saved = await makeDraw(db, s.actors.secretary, { competitionId: c.id, mode: "RANDOM", rngSeed: preview.rngSeed! });
    expect(saved.ties).toEqual(preview.ties);
    expect(saved.ties.filter((t) => t.away === null)).toHaveLength(1);

    const rows = await db.select().from(fixtures).where(eq(fixtures.competitionId, c.id));
    const bye = rows.find((f) => !f.awayEntryId)!;
    expect(bye.status).toBe("COMPLETED");
    const real = rows.find((f) => f.awayEntryId)!;
    expect(real.scheduledAt.toISOString()).toBe("2026-11-04T19:30:00.000Z");
    expect((await db.select().from(notifications).where(eq(notifications.userId, "melville-captain"))).map((n) => n.type)).toContain("cup.drawn");
  });

  it("seeds keep the top two apart until the final", async () => {
    const { c } = await cup("Melville", "Crown", "Swan", "Red Lion");
    await dateRounds(c.id, ["2026-11-04"]);
    const { entries } = await import("./cup-service").then((m) => m.cupAdmin(db, s.actors.secretary, c.id));
    const id = (n: string) => entries.find((e) => e.entry.displayName === n)!.entry.id;
    await setCupSeeds(db, s.actors.secretary, { competitionId: c.id, seeds: { [id("Melville")]: 1, [id("Crown")]: 2 } });
    await expect(setCupSeeds(db, s.actors.secretary, { competitionId: c.id, seeds: { [id("Swan")]: 1 } })).rejects.toSatisfy(code("BAD_SEED"));
    for (let seed = 1; seed < 6; seed++) {
      const { ties } = await previewDraw(db, s.actors.secretary, { competitionId: c.id, mode: "SEEDED", rngSeed: seed });
      const half = (n: string) => ties.findIndex((t) => t.home === n || t.away === n);
      expect(half("Melville")).not.toBe(half("Crown"));
    }
  });

  it("can be remade until something is played, not after", async () => {
    const { c } = await cup("Melville", "Crown", "Swan", "Red Lion");
    await dateRounds(c.id, ["2026-11-04", "2026-11-18"]);
    await manual(c.id, [["Melville", "Red Lion"], ["Crown", "Swan"]]);
    await manual(c.id, [["Melville", "Crown"], ["Red Lion", "Swan"]]);
    expect((await db.select().from(fixtures).where(eq(fixtures.competitionId, c.id))).length).toBe(2);
    await award((await tie(c.id, 1, 0)).id, "HOME");
    await expect(manual(c.id, [["Melville", "Red Lion"], ["Crown", "Swan"]])).rejects.toSatisfy(code("CUP_STARTED"));
  });
});

describe("winners go through", () => {
  it("creates the final when both semis are decided, from a played match and an awarded one", async () => {
    const { c } = await cup("Melville", "Crown", "Swan", "Red Lion");
    await dateRounds(c.id, ["2026-11-04", "2026-11-18"]);
    await manual(c.id, [["Melville", "Red Lion"], ["Crown", "Swan"]]);
    const semi1 = await tie(c.id, 1, 0);

    // Semi 1 played properly: Melville 4–3 (Red Lion are a player short, so game 7 is a walkover).
    const slots = (ids: (string | null)[]) => ids.map((r, i) => ({ gameOrdinal: i + 1, registrationIds: r ? [r] : [] }));
    await setLineup(db, s.actors.melville, { fixtureId: semi1.id, side: "HOME", slots: slots(s.team.Melville.registrationIds), confirm: true });
    await setLineup(db, s.actors.redLion, { fixtureId: semi1.id, side: "AWAY", slots: slots([...s.team["Red Lion"].registrationIds, null]), confirm: true });
    await startFixture(db, s.actors.melville, semi1.id);
    for (const g of [1, 2, 3]) await playGame(db, s, semi1.id, g, "HOME");
    for (const g of [4, 5, 6]) await playGame(db, s, semi1.id, g, "AWAY");
    await completeFixture(db, s.actors.melville, semi1.id);
    expect(await tie(c.id, 2, 0)).toBeUndefined(); // the other semi isn't decided yet

    await award((await tie(c.id, 1, 1)).id, "AWAY"); // Swan beat Crown
    const final = await tie(c.id, 2, 0);
    const b = await cupBracket(db, c.id);
    expect([b.rounds[1].ties[0]?.home.name, b.rounds[1].ties[0]?.away?.name]).toEqual(["Melville", "Swan"]);
    expect(final.scheduledAt.toISOString()).toBe("2026-11-18T19:30:00.000Z");
    expect((await db.select().from(notifications).where(eq(notifications.userId, "melville-captain"))).map((n) => n.type)).toContain("cup.tie");

    await award(final.id, "AWAY");
    expect((await cupBracket(db, c.id)).champion?.name).toBe("Swan");
  });

  it("waits for the round's date, then creates the tie", async () => {
    const { c } = await cup("Melville", "Crown", "Swan", "Red Lion");
    await dateRounds(c.id, ["2026-11-04"]);
    await manual(c.id, [["Melville", "Red Lion"], ["Crown", "Swan"]]);
    await award((await tie(c.id, 1, 0)).id, "HOME");
    await award((await tie(c.id, 1, 1)).id, "HOME");
    expect(await tie(c.id, 2, 0)).toBeUndefined();
    await dateRounds(c.id, ["", "2026-11-25"]);
    expect((await tie(c.id, 2, 0)).scheduledAt.toISOString()).toBe("2026-11-25T19:30:00.000Z");
  });

  it("a voided semi takes the unstarted final away; restoring it brings the final back", async () => {
    const { c } = await cup("Melville", "Crown", "Swan", "Red Lion");
    await dateRounds(c.id, ["2026-11-04", "2026-11-18"]);
    await manual(c.id, [["Melville", "Red Lion"], ["Crown", "Swan"]]);
    await award((await tie(c.id, 1, 0)).id, "HOME");
    await award((await tie(c.id, 1, 1)).id, "HOME");
    expect(await tie(c.id, 2, 0)).toBeDefined();
    const semi2 = await tie(c.id, 1, 1);
    await voidFixture(db, s.actors.secretary, { fixtureId: semi2.id, reason: "Ineligible player", keepPlayerStats: false });
    expect(await tie(c.id, 2, 0)).toBeUndefined();
    await restoreFixture(db, s.actors.secretary, { fixtureId: semi2.id, reason: "Appeal upheld" });
    expect(await tie(c.id, 2, 0)).toBeDefined();
  });

  it("moves unplayed ties with their round and warns about league fixtures that night", async () => {
    const { c } = await cup("Melville", "Crown", "Swan", "Red Lion");
    await dateRounds(c.id, ["2026-11-04", "2026-11-18"]);
    await manual(c.id, [["Melville", "Red Lion"], ["Crown", "Swan"]]);
    const [first] = await db.select().from(cupRounds).where(and(eq(cupRounds.competitionId, c.id), eq(cupRounds.ordinal, 1)));
    const r = await setCupRoundDate(db, s.actors.secretary, { roundId: first.id, date: "2026-10-14", kickOff: "20:00" });
    expect(r.moved).toBe(2);
    expect(r.warnings).toEqual(["1 league fixture is already arranged that night"]);
    expect((await tie(c.id, 1, 0)).scheduledAt.toISOString()).toBe("2026-10-14T19:00:00.000Z"); // 20:00 BST
  });

  it("cup nights are flagged when a league fixture is asked to move onto one", async () => {
    const { c } = await cup("Melville", "Crown");
    await dateRounds(c.id, ["2026-09-09"]);
    const { warnings } = await requestRearrangement(
      db,
      s.actors.redLion,
      { fixtureId: s.fixtures.melvilleVRedLion.id, side: "AWAY", proposedAt: new Date("2026-09-09T18:30:00Z") },
      new Date("2026-08-20T12:00:00Z"),
    );
    expect(warnings.map((w) => w.message)).toEqual(["no league fixtures are planned that night (Charity Cup final)"]);
  });
});

describe("withdrawals from a cup", () => {
  it("a folding team's tie goes to the opponent, and a later tie is awarded as soon as it is known", async () => {
    const { c } = await cup("Melville", "Crown", "Swan", "Red Lion");
    await dateRounds(c.id, ["2026-11-04", "2026-11-18"]);
    await manual(c.id, [["Melville", "Red Lion"], ["Crown", "Swan"]]);
    await award((await tie(c.id, 1, 0)).id, "HOME"); // Melville through to the final

    // Melville withdraw before the other semi is played (the fold choice is irrelevant for a cup).
    await foldTeam(db, s.actors.secretary, { entryId: await entryOf(c.id, "Melville"), results: "VOID_ALL", playerStats: "KEEP", reason: "Pub closed" });
    expect((await tie(c.id, 1, 0)).status).toBe("COMPLETED"); // their won semi stands

    await award((await tie(c.id, 1, 1)).id, "AWAY"); // Swan win the other semi…
    const final = await tie(c.id, 2, 0);
    expect(final.status).toBe("COMPLETED"); // …and the final is theirs straight away
    expect((await cupBracket(db, c.id)).champion?.name).toBe("Swan");
  });

  it("a team withdrawing from an unplayed tie hands it to the opponent", async () => {
    const { c } = await cup("Melville", "Crown", "Swan", "Red Lion");
    await dateRounds(c.id, ["2026-11-04", "2026-11-18"]);
    await manual(c.id, [["Melville", "Red Lion"], ["Crown", "Swan"]]);
    await foldTeam(db, s.actors.secretary, { entryId: await entryOf(c.id, "Swan"), results: "VOID_ALL", playerStats: "KEEP", reason: "x" });
    const semi2 = await tie(c.id, 1, 1);
    expect(semi2.status).toBe("COMPLETED");
    const b = await cupBracket(db, c.id);
    expect(b.rounds[0].ties[1]?.winnerEntryId).toBe(await entryOf(c.id, "Crown"));
  });
});
