import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase, type Db } from "@/db/client";
import { leagues, seasons } from "@/db/schema";
import { rankLeaderboard } from "@/domain/leaderboards";
import { AppError } from "./errors";
import { completeFixture, setLineup, startFixture } from "./match-service";
import {
  competitionPage,
  fixtureList,
  leaderboardData,
  leagueOverview,
  pickSeason,
  playerProfile,
  publicLeague,
  seasonTeams,
  teamProfile,
} from "./public-service";
import { buildScenario, playGame, type Scenario } from "./testing/scenario";

let db: Db;
let s: Scenario;

beforeEach(async () => {
  db = await openTestDatabase();
  s = await buildScenario(db);
});

const fixtureId = () => s.fixtures.melvilleVRedLion.id;
const slots = (regIds: (string | null)[]) => regIds.map((r, i) => ({ gameOrdinal: i + 1, registrationIds: r ? [r] : [] }));
const beforeCrownVSwan = new Date("2026-10-01T12:00:00Z");

/** Melville win games 1–3, Red Lion 4–6, game 7 is a walkover to Melville (Red Lion are a player short). */
async function startAndPlay(games: { ordinal: number; winner: "HOME" | "AWAY" }[], complete: boolean) {
  await setLineup(db, s.actors.melville, { fixtureId: fixtureId(), side: "HOME", slots: slots(s.team.Melville.registrationIds), confirm: true });
  await setLineup(db, s.actors.redLion, { fixtureId: fixtureId(), side: "AWAY", slots: slots([...s.team["Red Lion"].registrationIds, null]), confirm: true });
  await startFixture(db, s.actors.melville, fixtureId());
  for (const g of games) await playGame(db, s, fixtureId(), g.ordinal, g.winner);
  if (complete) await completeFixture(db, s.actors.melville, fixtureId());
}
const melville4RedLion3 = () =>
  startAndPlay(
    [1, 2, 3, 4, 5, 6].map((ordinal) => ({ ordinal, winner: ordinal <= 3 ? "HOME" : "AWAY" })),
    true,
  );

const expectNotFound = (p: Promise<unknown>) => expect(p).rejects.toSatisfy((e) => e instanceof AppError && e.status === 404);

describe("public league", () => {
  it("hides draft seasons and archived leagues, and defaults to the active season", async () => {
    await db.insert(seasons).values({ leagueId: s.league.id, name: "2027/28", startsOn: "2027-09-01", status: "DRAFT" });
    const [old] = await db.insert(seasons).values({ leagueId: s.league.id, name: "2025/26", startsOn: "2025-09-01", status: "COMPLETED" }).returning();
    const { seasons: visible } = await publicLeague(db, "manchester");
    expect(visible.map((x) => x.name)).toEqual(["2026/27", "2025/26"]);
    expect(pickSeason(visible, undefined)?.id).toBe(s.season.id);
    expect(pickSeason(visible, old.id)?.id).toBe(old.id);
    expect(pickSeason(visible, "not-a-season")?.id).toBe(s.season.id);

    // A season left in draft becomes public once its fixtures are published.
    await db.update(seasons).set({ status: "DRAFT" }).where(eq(seasons.id, s.season.id));
    expect((await publicLeague(db, "manchester")).seasons.map((x) => x.name)).toEqual(["2026/27", "2025/26"]);

    await db.update(leagues).set({ archivedAt: new Date() }).where(eq(leagues.id, s.otherLeague.id));
    await expectNotFound(publicLeague(db, "salford"));
    await expectNotFound(publicLeague(db, "nowhere"));
  });
});

describe("league overview and fixtures", () => {
  it("shows the table, latest results and upcoming fixtures", async () => {
    await melville4RedLion3();
    const o = await leagueOverview(db, s.league, s.season.id, beforeCrownVSwan);
    expect(o.tables).toHaveLength(1);
    expect(o.tables[0].table!.rows.slice(0, 2).map((r) => [r.name, r.points])).toEqual([
      ["Melville", 11],
      ["Red Lion", 3],
    ]);
    expect(o.results).toHaveLength(1);
    expect(o.results[0]).toMatchObject({ home: { name: "Melville", slug: "melville" }, away: { name: "Red Lion" }, score: { home: 4, away: 3, winner: "HOME" } });
    expect(o.upcoming.map((f) => `${f.home.name} v ${f.away?.name}`)).toEqual(["Crown v Swan"]);
    expect(o.live).toEqual([]);

    // Fixtures before today are not "upcoming", even if still scheduled.
    const later = await leagueOverview(db, s.league, s.season.id, new Date("2026-11-01T12:00:00Z"));
    expect(later.upcoming).toEqual([]);
  });

  it("shows a live fixture with its running score, and keeps it out of the table until confirmed", async () => {
    await startAndPlay(
      [
        { ordinal: 1, winner: "HOME" },
        { ordinal: 2, winner: "HOME" },
      ],
      false,
    );
    const o = await leagueOverview(db, s.league, s.season.id, beforeCrownVSwan);
    expect(o.live).toHaveLength(1);
    // Two games won plus game 7, a walkover to Melville from the start.
    expect(o.live[0].liveScore).toEqual({ home: 3, away: 0 });
    expect(o.live[0].score).toBeNull();
    expect(o.tables[0].table!.rows.every((r) => r.played === 0)).toBe(true);
  });

  it("filters fixtures by team and competition", async () => {
    await melville4RedLion3();
    const redLion = await fixtureList(db, s.season.id, { view: "results", teamId: s.team["Red Lion"].teamId });
    expect(redLion.map((f) => f.id)).toEqual([fixtureId()]);
    expect(await fixtureList(db, s.season.id, { view: "results", teamId: s.team.Swan.teamId })).toEqual([]);
    expect((await fixtureList(db, s.season.id, { view: "upcoming", teamId: s.team.Swan.teamId })).map((f) => f.home.name)).toEqual(["Crown"]);
    expect(await fixtureList(db, s.season.id, { view: "upcoming", competitionId: "00000000-0000-0000-0000-000000000000" })).toEqual([]);
  });

  it("lists teams by division and serves a division's tables", async () => {
    const divisions = await seasonTeams(db, s.season.id);
    expect(divisions.map((d) => [d.competition.name, d.entries.map((e) => e.entry.displayName)])).toEqual([
      ["Division 1", ["Crown", "Melville", "Red Lion", "Swan"]],
    ]);
    const page = await competitionPage(db, s.league.id, s.competition.id);
    expect(page.tables.map((t) => t.name)).toEqual(["League"]);
    await expectNotFound(competitionPage(db, s.otherLeague.id, s.competition.id));
    await expectNotFound(competitionPage(db, s.league.id, "nope"));
  });
});

describe("team and player pages", () => {
  it("shows a team's position, squad statistics and results", async () => {
    await melville4RedLion3();
    const t = await teamProfile(db, s.league.id, "melville", s.season.id);
    expect(t.standings.map((x) => [x.competition.name, x.row?.position, x.teams])).toEqual([["Division 1", 1, 4]]);
    expect(t.squad).toHaveLength(7);
    const first = t.squad.find((p) => p.playerId === s.team.Melville.playerIds[0])!;
    expect(first.totals).toMatchObject({ gamesPlayed: 1, wins: 1, points: 501, darts: 18 });
    expect(t.results.map((f) => f.id)).toEqual([fixtureId()]);
    await expectNotFound(teamProfile(db, s.otherLeague.id, "melville", s.season.id));
  });

  it("shows a player's game log with opponents, never across leagues", async () => {
    await melville4RedLion3();
    const p = await playerProfile(db, s.league.id, s.team.Melville.playerIds[3]);
    expect(p.registrations.map((r) => r.team.name)).toEqual(["Melville"]);
    expect(p.games).toHaveLength(1);
    expect(p.games[0]).toMatchObject({
      result: "LOSS",
      legsFor: 0,
      legsAgainst: 1,
      gameKind: "SINGLES",
      team: { name: "Melville" },
      opponentTeam: { name: "Red Lion" },
      opponents: [{ id: s.team["Red Lion"].playerIds[3], name: "Red Lion Player 4" }],
      partners: [],
    });
    await expectNotFound(playerProfile(db, s.otherLeague.id, s.team.Melville.playerIds[0]));
    await expectNotFound(playerProfile(db, s.league.id, "123"));
  });
});

describe("leaderboards", () => {
  it("ranks the season's players with their team and the scope's minimum games", async () => {
    await melville4RedLion3();
    const data = await leaderboardData(db, s.league.id, s.season.id, {});
    expect(data.minGames).toBe(5);
    expect(data.bands.map((b) => b.key)).toEqual(["180", "140", "100"]);
    const averages = rankLeaderboard(data.entries, { kind: "average" }, { minGames: 0 });
    // Six games were played; every winner checked out 501 in 18 darts (83.5).
    expect(averages.filter((r) => r.position === 1)).toHaveLength(6);
    expect(averages[0].value).toBeCloseTo(83.5);
    const melvilleOne = data.entries.find((e) => e.playerId === s.team.Melville.playerIds[0])!;
    expect(melvilleOne.team).toEqual({ name: "Melville", slug: "melville" });
    // Nobody has five games yet, so the average board is empty at the league's threshold.
    expect(rankLeaderboard(data.entries, { kind: "average" }, { minGames: data.minGames })).toEqual([]);

    const pairsOnly = await leaderboardData(db, s.league.id, s.season.id, { gameKind: "PAIRS" });
    expect(pairsOnly.entries).toEqual([]);
  });
});
