import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase, type Db } from "@/db/client";
import { auditLog, fixtures, games, playerGameStats, visits } from "@/db/schema";
import { ForbiddenError } from "@/domain/permissions";
import { round2, threeDartAverage } from "@/domain/stats";
import { AppError } from "./errors";
import { completeFixture, correctLeg, recordVisit, setLineup, startFixture, voidFixture } from "./match-service";
import { registerPlayer, setPlayerStatus } from "./registration-service";
import { getStandings } from "./standings-service";
import { playerStats, rebuildAllStats } from "./stats-service";
import { buildScenario, playGame, type Scenario } from "./testing/scenario";

let db: Db;
let s: Scenario;

beforeEach(async () => {
  db = await openTestDatabase();
  s = await buildScenario(db);
});

const fixtureId = () => s.fixtures.melvilleVRedLion.id;
/** One entry per game: a registration id, "id+id" for a pair, or null for no player (walkover). */
const slots = (regIds: (string | null)[]) =>
  regIds.map((r, i) => ({ gameOrdinal: i + 1, registrationIds: r === null ? [] : r.split("+") }));

/** Melville field 7; Red Lion only have 6, so game 7 is a walkover to Melville. */
async function lineupsAndStart() {
  await setLineup(db, s.actors.melville, { fixtureId: fixtureId(), side: "HOME", slots: slots(s.team.Melville.registrationIds), confirm: true });
  await setLineup(db, s.actors.redLion, {
    fixtureId: fixtureId(),
    side: "AWAY",
    slots: slots([...s.team["Red Lion"].registrationIds, null]),
    confirm: true,
  });
  await startFixture(db, s.actors.melville, fixtureId());
}

/** Melville win games 1–3, Red Lion win 4–6, game 7 walkover → Melville 4–3. */
async function playMelville4RedLion3() {
  await lineupsAndStart();
  for (const g of [1, 2, 3]) await playGame(db, s, fixtureId(), g, "HOME");
  for (const g of [4, 5, 6]) await playGame(db, s, fixtureId(), g, "AWAY");
  await completeFixture(db, s.actors.melville, fixtureId());
}

const row = async (name: string) => (await getStandings(db, s.competition.id)).find((r) => r.name === name)!;
const fixtureRow = async () => (await db.select().from(fixtures).where(eq(fixtures.id, fixtureId())))[0];

describe("fixture lifecycle and league table", () => {
  it("does not touch the table while live, then updates it atomically on completion", async () => {
    await lineupsAndStart();
    expect((await fixtureRow()).status).toBe("LIVE");
    const [game7] = await db.select().from(games).where(and(eq(games.fixtureId, fixtureId()), eq(games.ordinal, 7)));
    expect(game7).toMatchObject({ status: "WALKOVER", winner: "HOME" });

    for (const g of [1, 2, 3]) await playGame(db, s, fixtureId(), g, "HOME");
    for (const g of [4, 5]) await playGame(db, s, fixtureId(), g, "AWAY");
    // 5 of 6 played games finished, Melville already 4–2 up: still live, table untouched.
    expect((await fixtureRow()).status).toBe("LIVE");
    expect((await row("Melville")).played).toBe(0);
    expect((await row("Melville")).points).toBe(0);

    await playGame(db, s, fixtureId(), 6, "AWAY");
    // Every game is finished, but the table only changes when the scorer confirms the result.
    expect((await fixtureRow()).status).toBe("LIVE");
    expect((await row("Melville")).played).toBe(0);
    await expect(completeFixture(db, s.actors.redLion, fixtureId())).rejects.toThrow(ForbiddenError);
    await completeFixture(db, s.actors.melville, fixtureId());
    expect((await fixtureRow()).status).toBe("COMPLETED");
    expect(await row("Melville")).toMatchObject({ played: 1, won: 1, gamesFor: 4, gamesAgainst: 3, points: 11 });
    expect(await row("Red Lion")).toMatchObject({ played: 1, lost: 1, gamesFor: 3, gamesAgainst: 4, points: 3 });
    expect(await row("Crown")).toMatchObject({ played: 0, points: 0 });

    const log = await db.select().from(auditLog).where(eq(auditLog.entityId, fixtureId()));
    expect(log.map((l) => l.action)).toContain("fixture.completed");
  });

  it("will not start until both lineups are confirmed", async () => {
    await setLineup(db, s.actors.melville, { fixtureId: fixtureId(), side: "HOME", slots: slots(s.team.Melville.registrationIds), confirm: true });
    await expect(startFixture(db, s.actors.melville, fixtureId())).rejects.toThrow(/lineups must be confirmed/);
  });
});

describe("player statistics from live scoring", () => {
  it("computes 3-dart averages from actual points and darts for winners and losers", async () => {
    await playMelville4RedLion3();
    const [winner, loser] = [s.team.Melville.playerIds[0], s.team["Red Lion"].playerIds[0]];
    const stats = await playerStats(db, { playerIds: [winner, loser] });

    const w = stats.get(winner)!;
    expect(w).toMatchObject({ points: 501, darts: 18, gamesPlayed: 1, wins: 1, highestCheckout: 41, bestLegDarts: 18 });
    expect(round2(threeDartAverage(w))).toBe(83.5);
    expect(w.bands).toEqual({ "100": 4 });

    // Red Lion's player threw five visits of 60 before Melville checked out.
    const l = stats.get(loser)!;
    expect(l).toMatchObject({ points: 300, darts: 15, gamesPlayed: 1, losses: 1, highestCheckout: null });
    expect(threeDartAverage(l)).toBe(60);
  });

  it("never gives a walkover player darts statistics", async () => {
    await playMelville4RedLion3();
    const walkoverPlayer = s.team.Melville.playerIds[6];
    const t = (await playerStats(db, { playerIds: [walkoverPlayer] })).get(walkoverPlayer)!;
    expect(t).toMatchObject({ points: 0, darts: 0, bands: {}, highestCheckout: null, bestLegDarts: null });
    expect(threeDartAverage(t)).toBeNull();
    // Division 1 rules: walkovers do not go on the player's W/L record.
    expect(t.gamesPlayed).toBe(0);
  });

  it("feeds a completed game into season stats while the fixture is still live", async () => {
    await lineupsAndStart();
    await playGame(db, s, fixtureId(), 1, "HOME");
    const p = s.team.Melville.playerIds[0];
    expect((await playerStats(db, { playerIds: [p], seasonId: s.season.id })).get(p)?.wins).toBe(1);
    expect((await playerStats(db, { playerIds: [p], competitionKind: "CUP" })).size).toBe(0);
  });

  it("rebuilds identical statistics from raw visits", async () => {
    await playMelville4RedLion3();
    const before = await playerStats(db);
    await db.delete(playerGameStats);
    expect((await playerStats(db)).size).toBe(0);
    await rebuildAllStats(db);
    expect(await playerStats(db)).toEqual(before);
  });
});

describe("scoring reliability and authority", () => {
  it("ignores a retried submission with the same client event id", async () => {
    await lineupsAndStart();
    const visit = { fixtureId: fixtureId(), gameOrdinal: 1, clientEventId: randomUUID(), side: "HOME" as const, scored: 140 };
    const first = await recordVisit(db, s.actors.melville, visit);
    const retry = await recordVisit(db, s.actors.melville, visit);
    expect(first).toMatchObject({ duplicate: false, seq: 1, remaining: { HOME: 361, AWAY: 501 } });
    expect(retry).toMatchObject({ duplicate: true, seq: 1, remaining: { HOME: 361, AWAY: 501 } });
    expect(await db.select().from(visits)).toHaveLength(1);
  });

  it("rejects a device that is behind instead of forking the leg", async () => {
    await lineupsAndStart();
    await recordVisit(db, s.actors.melville, { fixtureId: fixtureId(), gameOrdinal: 1, clientEventId: randomUUID(), side: "HOME", scored: 60, expectedSeq: 1 });
    await expect(
      recordVisit(db, s.actors.melville, { fixtureId: fixtureId(), gameOrdinal: 1, clientEventId: randomUUID(), side: "AWAY", scored: 60, expectedSeq: 1 }),
    ).rejects.toMatchObject({ code: "SEQ_MISMATCH", status: 409, details: { nextSeq: 2 } });
  });

  it("only lets the responsible team score", async () => {
    await lineupsAndStart();
    const v = () => ({ fixtureId: fixtureId(), gameOrdinal: 1, clientEventId: randomUUID(), side: "HOME" as const, scored: 60 });
    await expect(recordVisit(db, s.actors.redLion, v())).rejects.toThrow(ForbiddenError);
    await expect(recordVisit(db, s.actors.crown, v())).rejects.toThrow(ForbiddenError);
    await expect(recordVisit(db, s.actors.otherSecretary, v())).rejects.toThrow(ForbiddenError);
    await expect(recordVisit(db, s.actors.secretary, v())).resolves.toMatchObject({ seq: 1 });
  });

  it("rejects invalid scores server-side", async () => {
    await lineupsAndStart();
    await expect(
      recordVisit(db, s.actors.melville, { fixtureId: fixtureId(), gameOrdinal: 1, clientEventId: randomUUID(), side: "HOME", scored: 179 }),
    ).rejects.toThrow(/not a possible/);
    await expect(
      recordVisit(db, s.actors.melville, { fixtureId: fixtureId(), gameOrdinal: 1, clientEventId: randomUUID(), side: "AWAY", scored: 60 }),
    ).rejects.toThrow(/HOME's turn/);
  });
});

describe("lineups", () => {
  it("stops a team admin picking for the other team or picking ineligible players", async () => {
    const f = fixtureId();
    await expect(
      setLineup(db, s.actors.melville, { fixtureId: f, side: "AWAY", slots: slots(s.team["Red Lion"].registrationIds), confirm: true }),
    ).rejects.toThrow(ForbiddenError);

    const withCrownPlayer = [...s.team.Melville.registrationIds.slice(0, 6), s.team.Crown.registrationIds[0]];
    await expect(
      setLineup(db, s.actors.melville, { fixtureId: f, side: "HOME", slots: slots(withCrownPlayer), confirm: true }),
    ).rejects.toMatchObject({ code: "INVALID_LINEUP" });

    await setPlayerStatus(db, s.actors.secretary, s.team.Melville.playerIds[0], "SUSPENDED", "red card");
    await expect(
      setLineup(db, s.actors.melville, { fixtureId: f, side: "HOME", slots: slots(s.team.Melville.registrationIds), confirm: true }),
    ).rejects.toThrow(/suspended/);
  });
});

describe("corrections and voids", () => {
  it("recalculates game, averages, fixture result and table after a correction", async () => {
    await playMelville4RedLion3();
    // Game 1 was actually won by Red Lion's player.
    const corrected = [
      ["HOME", 60], ["AWAY", 100], ["HOME", 60], ["AWAY", 100], ["HOME", 60], ["AWAY", 100],
      ["HOME", 60], ["AWAY", 100], ["HOME", 60], ["AWAY", 60], ["HOME", 60], ["AWAY", 41, 3],
    ] as const;
    const input = {
      fixtureId: fixtureId(),
      gameOrdinal: 1,
      legOrdinal: 1,
      visits: corrected.map(([side, scored, darts]) => ({ side, scored, darts })),
      reason: "scoresheet entered against the wrong player",
    };
    await expect(correctLeg(db, s.actors.melville, input)).rejects.toThrow(ForbiddenError);
    await correctLeg(db, s.actors.secretary, input);

    expect(await row("Red Lion")).toMatchObject({ won: 1, gamesFor: 4, points: 11 });
    expect(await row("Melville")).toMatchObject({ lost: 1, gamesFor: 3, points: 3 });

    const melvilleP1 = s.team.Melville.playerIds[0];
    const t = (await playerStats(db, { playerIds: [melvilleP1] })).get(melvilleP1)!;
    expect(t).toMatchObject({ points: 360, darts: 18, wins: 0, losses: 1, highestCheckout: null });
    expect(threeDartAverage(t)).toBe(60);

    const actions = (await db.select().from(auditLog)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["scoring.corrected", "fixture.result_corrected"]));
    // Original visits are kept (voided) for the audit trail.
    expect((await db.select().from(visits)).filter((v) => v.voidedAt).length).toBe(11);
  });

  it("removes a voided fixture from the table and, unless kept, from player stats", async () => {
    await playMelville4RedLion3();
    const p = s.team.Melville.playerIds[0];
    await voidFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "ineligible player", keepPlayerStats: false });
    expect(await row("Melville")).toMatchObject({ played: 0, points: 0 });
    expect((await playerStats(db, { playerIds: [p] })).size).toBe(0);
  });

  it("can keep individual stats from a voided fixture", async () => {
    await playMelville4RedLion3();
    const p = s.team.Melville.playerIds[0];
    await voidFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "Red Lion folded", keepPlayerStats: true });
    expect((await row("Melville")).points).toBe(0);
    expect(threeDartAverage((await playerStats(db, { playerIds: [p] })).get(p)!)).toBeCloseTo(83.5);
  });
});

describe("player registration", () => {
  const before = new Date("2027-01-31T20:00:00Z");
  const after = new Date("2027-02-01T09:00:00Z");
  const newPlayer = { firstName: "Jo", lastName: "Bloggs" };

  it("lets a team admin register before the deadline but not after", async () => {
    const reg = await registerPlayer(db, s.actors.melville, { seasonId: s.season.id, teamId: s.team.Melville.teamId, player: newPlayer }, before);
    expect(reg.isOverride).toBe(false);
    await expect(
      registerPlayer(db, s.actors.melville, { seasonId: s.season.id, teamId: s.team.Melville.teamId, player: newPlayer }, after),
    ).rejects.toMatchObject({ code: "DEADLINE_PASSED" });
  });

  it("lets a league admin override the deadline, and audits it", async () => {
    const reg = await registerPlayer(db, s.actors.secretary, { seasonId: s.season.id, teamId: s.team.Melville.teamId, player: newPlayer }, after);
    expect(reg.isOverride).toBe(true);
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "player.registration_override"));
    expect(log).toMatchObject({ actorUserId: "secretary", entityId: reg.id });
  });

  it("blocks registering a player already with another team this season", async () => {
    const melvillePlayer = s.team.Melville.playerIds[0];
    await expect(
      registerPlayer(db, s.actors.secretary, { seasonId: s.season.id, teamId: s.team.Crown.teamId, player: { playerId: melvillePlayer } }, before),
    ).rejects.toMatchObject({ code: "ALREADY_REGISTERED" });
  });

  it("keeps teams and leagues apart", async () => {
    const input = { seasonId: s.season.id, teamId: s.team.Melville.teamId, player: newPlayer };
    await expect(registerPlayer(db, s.actors.redLion, input, before)).rejects.toThrow(ForbiddenError);
    await expect(registerPlayer(db, s.actors.otherSecretary, input, before)).rejects.toThrow(ForbiddenError);
    await expect(setPlayerStatus(db, s.actors.melville, s.team.Melville.playerIds[0], "INACTIVE")).rejects.toThrow(ForbiddenError);
  });

  it("enforces one active registration per season in the database itself", async () => {
    const { playerRegistrations } = await import("@/db/schema");
    await expect(
      db.insert(playerRegistrations).values({
        leagueId: s.league.id,
        playerId: s.team.Melville.playerIds[0],
        teamId: s.team.Crown.teamId,
        seasonId: s.season.id,
      }),
    ).rejects.toThrow();
  });
});

it("maps service errors to HTTP statuses", () => {
  expect(new AppError("X", "x", 422).status).toBe(422);
});
