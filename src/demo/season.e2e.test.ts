import { and, eq, inArray, lt } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, type Db } from "@/db/client";
import { auditLog, competitions, fixtureOutcomes, fixtureRearrangements, fixtures, leagues, notifications, seasons } from "@/db/schema";
import { fixturePoints } from "@/domain/standings";
import { threeDartAverage } from "@/domain/stats";
import { authenticate } from "@/server/auth-service";
import { cupBracket } from "@/server/cup-service";
import { fixtureList, leaderboardData, leagueOverview, playerProfile, publicLeague, teamProfile } from "@/server/public-service";
import { getTables } from "@/server/standings-service";
import { playerStats, rebuildAllStats } from "@/server/stats-service";
import { seedDemo, type SeedResult } from "./seed";

/**
 * End to end, through every layer below the UI: build a league from nothing,
 * generate the fixtures, draw a cup, play four match nights visit by visit,
 * and check that every derived number agrees with the raw data.
 */

const NOW = new Date("2026-10-01T12:00:00Z"); // after 2, 9, 16 (league) and 23 (cup) September; before the 30th
let db: Db;
let seeded: SeedResult;
let seasonId: string;
let comps: (typeof competitions.$inferSelect)[];

beforeAll(async () => {
  db = await openTestDatabase();
  seeded = await seedDemo(db, { now: NOW, seed: 1, password: "demo-password-123", maxNights: 4 });
  const [league] = await db.select().from(leagues).where(eq(leagues.slug, "manchester"));
  [{ id: seasonId }] = await db.select().from(seasons).where(eq(seasons.leagueId, league.id));
  comps = await db.select().from(competitions).where(eq(competitions.seasonId, seasonId));
}, 600_000);

describe("a demo season, end to end", () => {
  it("played every fixture before today and nothing after it, except tonight's live match", async () => {
    const before = await db.select().from(fixtures).where(lt(fixtures.scheduledAt, new Date("2026-09-30T00:00:00Z")));
    const real = before.filter((f) => f.awayEntryId);
    expect(real.length).toBe(32); // 3 league nights × 8 + the 16-team cup's first round (8 ties)
    expect(real.every((f) => f.status === "COMPLETED")).toBe(true);
    expect(seeded.played).toBe(32);
    const all = await db.select().from(fixtures);
    expect(all.filter((f) => f.status === "LIVE")).toHaveLength(1);
    expect(all.filter((f) => f.status === "POSTPONED")).toHaveLength(1);
    expect(await db.select().from(fixtureRearrangements).where(eq(fixtureRearrangements.status, "PENDING"))).toHaveLength(1);
  });

  it("league tables agree with the results they are built from", async () => {
    for (const c of comps.filter((c) => c.kind === "LEAGUE")) {
      const [table] = await getTables(db, c.id, NOW);
      const done = await db.select().from(fixtures).where(and(eq(fixtures.competitionId, c.id), eq(fixtures.status, "COMPLETED")));
      const outcomes = await db.select().from(fixtureOutcomes).where(and(inArray(fixtureOutcomes.fixtureId, done.map((f) => f.id)), eq(fixtureOutcomes.groupKey, "main")));
      expect(table.rows.reduce((n, r) => n + r.played, 0)).toBe(done.length * 2);
      expect(table.rows.reduce((n, r) => n + r.won, 0)).toBe(outcomes.filter((o) => o.winner !== "DRAW").length);
      expect(table.rows.reduce((n, r) => n + r.gameDifference, 0)).toBe(0);
      // Points add up to the points every result was worth.
      const points = { win: 2, draw: 1, loss: 0, perGameWon: 0 };
      const expected = outcomes.reduce((n, o) => n + fixturePoints(o, points).home + fixturePoints(o, points).away, 0);
      expect(table.rows.reduce((n, r) => n + r.points, 0)).toBe(expected);
      expect(table.rows.map((r) => r.position)[0]).toBe(1);
    }
  });

  it("player statistics rebuild from raw visits to exactly the same numbers", async () => {
    const before = await playerStats(db, { seasonId });
    await rebuildAllStats(db);
    const after = await playerStats(db, { seasonId });
    expect(after).toEqual(before);
    const averages = [...after.values()].map((t) => threeDartAverage(t)).filter((a): a is number => a !== null);
    expect(averages.length).toBeGreaterThan(100);
    expect(Math.min(...averages)).toBeGreaterThan(15);
    expect(Math.max(...averages)).toBeLessThan(110);
  });

  it("the cup's first round is played and the quarter-finals are drawn from the winners", async () => {
    const cup = comps.find((c) => c.kind === "CUP")!;
    const b = await cupBracket(db, cup.id);
    expect(b.rounds.map((r) => r.name)).toEqual(["Last 16", "Quarter-finals", "Semi-finals", "Final"]);
    expect(b.rounds[0].ties.every((t) => t?.winnerEntryId)).toBe(true);
    const qf = b.rounds[1].ties;
    expect(qf.every((t) => t && t.status === "SCHEDULED")).toBe(true);
    const winners = new Set(b.rounds[0].ties.map((t) => t!.winnerEntryId));
    expect(qf.flatMap((t) => [t!.home.entryId, t!.away!.entryId]).every((id) => winners.has(id))).toBe(true);
  });

  it("serves the public site's read models", async () => {
    const { league, seasons: visible } = await publicLeague(db, "manchester");
    expect(visible.map((s) => s.status)).toEqual(["ACTIVE"]);
    const o = await leagueOverview(db, league, seasonId, NOW);
    expect(o.tables).toHaveLength(2);
    expect(o.live).toHaveLength(1);
    expect(o.live[0].liveScore!.home + o.live[0].liveScore!.away).toBeGreaterThan(0);
    expect(o.results.length).toBeGreaterThan(0);
    expect(o.cups.map((c) => c.name)).toEqual(["Manchester Cup"]);

    const team = await teamProfile(db, league.id, "red-lion", seasonId);
    expect(team.squad.length).toBeGreaterThanOrEqual(8);
    expect(team.results.length).toBeGreaterThanOrEqual(3);
    const regular = team.squad.find((p) => (p.totals?.gamesPlayed ?? 0) > 0)!;
    const profile = await playerProfile(db, league.id, regular.playerId);
    expect(profile.games.length).toBe(regular.totals!.gamesPlayed);

    const boards = await leaderboardData(db, league.id, seasonId, {});
    expect(boards.entries.length).toBeGreaterThan(100);
    expect((await fixtureList(db, seasonId, { view: "upcoming" })).length).toBeGreaterThan(50);
  });

  it("left a trail: audit log, notifications and working demo logins", async () => {
    const actions = new Set((await db.select({ a: auditLog.action }).from(auditLog)).map((r) => r.a));
    for (const a of ["league.created", "cup.drawn", "fixture.completed", "rearrangement.requested", "fixture.postponed"]) expect(actions).toContain(a);
    const swanCaptain = seeded.accounts.find((a) => a.role === "Swan captain")!;
    const user = await authenticate(db, swanCaptain.email, "demo-password-123");
    expect((await db.select().from(notifications).where(eq(notifications.userId, user.id))).length).toBeGreaterThan(0);
  });
});
