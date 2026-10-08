import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openTestDatabase } from "@/db/client";
import { games } from "@/db/schema";
import { ForbiddenError } from "@/domain/permissions";
import { defineRules, type LeagueRules } from "@/domain/rules";
import type { Side } from "@/domain/scoring";
import { round2 } from "@/domain/stats";
import { liveSnapshot } from "./live-service";
import { completeFixture, recordVisit, setFirstThrower, setLineup, startFixture, undoVisit } from "./match-service";
import { getStandings } from "./standings-service";
import { playerStats } from "./stats-service";
import { buildScenario, DIV1_RULES, playGame } from "./testing/scenario";

async function setup(rules: LeagueRules = DIV1_RULES) {
  const db = await openTestDatabase();
  const s = await buildScenario(db, { rules });
  const fixtureId = s.fixtures.melvilleVRedLion.id;
  const slots = (ids: (string | null)[]) => ids.map((r, i) => ({ gameOrdinal: i + 1, registrationIds: r ? [r] : [] }));
  await setLineup(db, s.actors.melville, { fixtureId, side: "HOME", slots: slots(s.team.Melville.registrationIds), confirm: true });
  await setLineup(db, s.actors.redLion, { fixtureId, side: "AWAY", slots: slots([...s.team["Red Lion"].registrationIds, null]), confirm: true });
  await startFixture(db, s.actors.melville, fixtureId);
  const visit = (gameOrdinal: number, side: Side, scored: number, darts?: number, clientEventId: string = randomUUID()) =>
    recordVisit(db, s.actors.melville, { fixtureId, gameOrdinal, clientEventId, side, scored, darts }).then((r) => ({ ...r, clientEventId }));
  return { db, s, fixtureId, visit };
}

/** One leg: `starter` throws first; `winner` checks out 501 in 18 darts, the other scores 60s. */
async function playLeg(visit: Awaited<ReturnType<typeof setup>>["visit"], game: number, starter: Side, winner: Side) {
  const scores = [100, 100, 100, 100, 60];
  let w = 0;
  for (let turn = 0; ; turn++) {
    const side: Side = turn % 2 === 0 ? starter : starter === "HOME" ? "AWAY" : "HOME";
    if (side !== winner) await visit(game, side, 60);
    else if (w < scores.length) await visit(game, side, scores[w++]);
    else return visit(game, side, 41, 3);
  }
}

describe("undo", () => {
  it("undoes the latest visit once, even if the request is retried", async () => {
    const { db, s, fixtureId, visit } = await setup();
    await visit(1, "HOME", 100);
    const second = await visit(1, "AWAY", 140);
    await undoVisit(db, s.actors.melville, { fixtureId, visitClientEventId: second.clientEventId });
    await undoVisit(db, s.actors.melville, { fixtureId, visitClientEventId: second.clientEventId }); // retry: no-op
    const leg = (await liveSnapshot(db, fixtureId)).games[0].currentLeg!;
    expect(leg.remaining).toEqual({ HOME: 401, AWAY: 501 });
    expect(leg.nextToThrow).toBe("AWAY");
  });

  it("only undoes the most recent visit, and only for the scoring team", async () => {
    const { db, s, fixtureId, visit } = await setup();
    const first = await visit(1, "HOME", 100);
    const second = await visit(1, "AWAY", 60);
    await expect(undoVisit(db, s.actors.melville, { fixtureId, visitClientEventId: first.clientEventId })).rejects.toMatchObject({ code: "NOT_LAST_VISIT" });
    await expect(undoVisit(db, s.actors.redLion, { fixtureId, visitClientEventId: second.clientEventId })).rejects.toThrow(ForbiddenError);
  });

  it("reopens a game when the winning checkout is undone", async () => {
    const { db, s, fixtureId, visit } = await setup();
    const checkout = await playLeg(visit, 1, "HOME", "HOME");
    expect(checkout.gameStatus).toBe("COMPLETED");
    await undoVisit(db, s.actors.melville, { fixtureId, visitClientEventId: checkout.clientEventId });
    const game = (await liveSnapshot(db, fixtureId)).games[0];
    expect(game).toMatchObject({ status: "LIVE", winner: null, homeLegs: 0 });
    expect(game.currentLeg).toMatchObject({ ordinal: 1, remaining: { HOME: 41, AWAY: 201 }, nextToThrow: "HOME" });
    // The corrected checkout goes back into the same leg.
    await visit(1, "HOME", 41, 2);
    expect((await liveSnapshot(db, fixtureId)).games[0]).toMatchObject({ status: "COMPLETED", homeLegs: 1 });
    expect((await playerStats(db, { playerIds: [s.team.Melville.playerIds[0]] })).get(s.team.Melville.playerIds[0])?.darts).toBe(17);
  });
});

describe("the throw and multi-leg games", () => {
  it("lets the scorer record the bull-up winner before the first dart only", async () => {
    const { db, s, fixtureId, visit } = await setup();
    await setFirstThrower(db, s.actors.melville, { fixtureId, gameOrdinal: 1, side: "AWAY" });
    await expect(visit(1, "HOME", 60)).rejects.toThrow(/AWAY's turn/);
    await visit(1, "AWAY", 60);
    await expect(setFirstThrower(db, s.actors.melville, { fixtureId, gameOrdinal: 1, side: "HOME" })).rejects.toMatchObject({ code: "GAME_STARTED" });
  });

  it("plays 7 games of best of 3 legs, alternating the throw and averaging across legs", async () => {
    const bestOf3 = defineRules({ ...DIV1_RULES, game: { ...DIV1_RULES.game, singles: { ...DIV1_RULES.game.singles, legsFormat: "BEST_OF", legs: 3 } } });
    const { db, s, fixtureId, visit } = await setup(bestOf3);
    await playLeg(visit, 1, "HOME", "HOME");
    const afterOne = (await liveSnapshot(db, fixtureId)).games[0];
    expect(afterOne).toMatchObject({ status: "LIVE", homeLegs: 1, awayLegs: 0 });
    expect(afterOne.currentLeg).toMatchObject({ ordinal: 2, startingSide: "AWAY", remaining: { HOME: 501, AWAY: 501 } });
    await playLeg(visit, 1, "AWAY", "AWAY");
    const decider = await playLeg(visit, 1, "HOME", "HOME");
    expect(decider.gameStatus).toBe("COMPLETED");

    const g1 = (await db.select().from(games).where(and(eq(games.fixtureId, fixtureId), eq(games.ordinal, 1))))[0];
    expect(g1).toMatchObject({ winner: "HOME", homeLegs: 2, awayLegs: 1 });
    // Melville's player: 501 + 501 in 36 darts winning, plus 5 or 6 visits of 60 losing leg 2.
    const p = (await playerStats(db, { playerIds: [s.team.Melville.playerIds[0]] })).get(s.team.Melville.playerIds[0])!;
    expect(p).toMatchObject({ legsPlayed: 3, legsWon: 2, wins: 1, bestLegDarts: 18 });
    expect(round2((p.points / p.darts) * 3)).toBe(round2(((501 * 2 + 300) / (36 + 15)) * 3));
  });

  it("does not start games that are no longer needed in a best-of match", async () => {
    const bestOf7 = defineRules({ ...DIV1_RULES, match: { ...DIV1_RULES.match, groups: [{ ...DIV1_RULES.match.groups[0], format: "BEST_OF" }] } });
    const { db, s, fixtureId, visit } = await setup(bestOf7);
    // Game 7 is a walkover to Melville; three more wins make four.
    for (const g of [1, 2, 3]) await playLeg(visit, g, "HOME", "HOME");
    await expect(visit(4, "HOME", 60)).rejects.toMatchObject({ code: "GAME_NOT_REQUIRED" });
    const snap = await liveSnapshot(db, fixtureId);
    expect(snap.readyToComplete).toBe(true);
    expect(snap.games.filter((g) => g.notRequired).map((g) => g.ordinal)).toEqual([4, 5, 6]);
    await completeFixture(db, s.actors.melville, fixtureId);
    const after = await liveSnapshot(db, fixtureId);
    expect(after.games.slice(3, 6).every((g) => g.status === "NOT_REQUIRED")).toBe(true);
    expect(after.groups[0]).toMatchObject({ homeGames: 4, awayGames: 0, complete: true });
  });
});

describe("live state and completion", () => {
  it("shows remaining scores, whose throw it is and live averages", async () => {
    const { db, fixtureId, visit, s } = await setup();
    await visit(1, "HOME", 180);
    await visit(1, "AWAY", 45);
    const snap = await liveSnapshot(db, fixtureId);
    expect(snap).toMatchObject({ status: "LIVE", home: { name: "Melville" }, away: { name: "Red Lion" }, readyToComplete: false });
    const g1 = snap.games[0];
    expect(g1.currentLeg).toMatchObject({ remaining: { HOME: 321, AWAY: 456 }, nextToThrow: "HOME" });
    expect(g1.stats[s.team.Melville.playerIds[0]]).toMatchObject({ average: 180, bands: { "180": 1 } });
    expect(snap.games[6]).toMatchObject({ status: "WALKOVER", winner: "HOME" });
  });

  it("will not confirm a result until every game is finished", async () => {
    const { db, s, fixtureId } = await setup();
    await expect(completeFixture(db, s.actors.melville, fixtureId)).rejects.toMatchObject({ code: "FIXTURE_INCOMPLETE" });
    for (const g of [1, 2, 3]) await playGame(db, s, fixtureId, g, "HOME");
    for (const g of [4, 5, 6]) await playGame(db, s, fixtureId, g, "AWAY");
    expect((await liveSnapshot(db, fixtureId)).readyToComplete).toBe(true);
    expect((await getStandings(db, s.competition.id)).find((r) => r.name === "Melville")!.played).toBe(0);
    await completeFixture(db, s.actors.melville, fixtureId);
    expect((await getStandings(db, s.competition.id)).find((r) => r.name === "Melville")!.points).toBe(11);
    expect((await liveSnapshot(db, fixtureId)).groups[0]).toMatchObject({ homeGames: 4, awayGames: 3, complete: true });
  });
});

