import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase, type Db } from "@/db/client";
import {
  blackoutDates,
  competitionRulePeriods,
  fixtureOutcomes,
  fixtureRearrangements,
  fixtures,
  foldEvents,
  games,
  notificationDeliveries,
  notifications,
  rulesets,
  teamEntries,
} from "@/db/schema";
import { ForbiddenError } from "@/domain/permissions";
import { defineRules, singles } from "@/domain/rules";
import { AppError } from "./errors";
import { abandonFixture, awardFixture, cancelFixture, postponeFixture, rescheduleFixture, restoreFixture } from "./fixture-admin-service";
import { foldTeam, previewFold, revertFold } from "./fold-service";
import { completeFixture, setLineup, startFixture, voidFixture } from "./match-service";
import { deliverPending, inbox, markRead, MAX_ATTEMPTS, notify, unreadCount, type NotificationChannel } from "./notification-service";
import {
  expireRearrangements,
  fixtureRearrangementState,
  pendingRearrangements,
  requestRearrangement,
  respondToRearrangement,
  withdrawRearrangement,
} from "./rearrangement-service";
import { getStandings } from "./standings-service";
import { playerStats } from "./stats-service";
import { buildScenario, playGame, type Scenario } from "./testing/scenario";

let db: Db;
let s: Scenario;

beforeEach(async () => {
  db = await openTestDatabase();
  s = await buildScenario(db);
});

/** Melville v Red Lion is on 2 Sep 2026 at 18:30Z; "now" is a fortnight before. */
const NOW = new Date("2026-08-20T12:00:00Z");
const fixtureId = () => s.fixtures.melvilleVRedLion.id;
const fixtureRow = async (id = fixtureId()) => (await db.select().from(fixtures).where(eq(fixtures.id, id)))[0];
const types = async (userId: string) => (await db.select().from(notifications).where(eq(notifications.userId, userId))).map((n) => n.type);
const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;
const slots = (regIds: (string | null)[]) => regIds.map((r, i) => ({ gameOrdinal: i + 1, registrationIds: r ? [r] : [] }));

async function lineups() {
  await setLineup(db, s.actors.melville, { fixtureId: fixtureId(), side: "HOME", slots: slots(s.team.Melville.registrationIds), confirm: true });
  await setLineup(db, s.actors.redLion, { fixtureId: fixtureId(), side: "AWAY", slots: slots([...s.team["Red Lion"].registrationIds, null]), confirm: true });
}
const request = (proposedAt = "2026-09-09T18:30:00Z", actor = s.actors.redLion, side: "HOME" | "AWAY" = "AWAY") =>
  requestRearrangement(db, actor, { fixtureId: fixtureId(), side, proposedAt: new Date(proposedAt), note: "Pub quiz night" }, NOW);

describe("rearrangements", () => {
  it("the other team accepts: the fixture moves and both sides are told", async () => {
    const { id, warnings } = await request();
    expect(warnings).toEqual([]);
    expect((await fixtureRow()).status).toBe("REARRANGEMENT_REQUESTED");
    expect(await types("melville-captain")).toEqual(["rearrangement.requested"]);
    expect(await types("secretary")).toEqual(["rearrangement.requested"]);
    expect(await types("redlion-captain")).toEqual([]); // never notify the person who acted
    expect(await types("crown-captain")).toEqual([]);

    await respondToRearrangement(db, s.actors.melville, { rearrangementId: id, accept: true }, NOW);
    const f = await fixtureRow();
    expect(f.status).toBe("SCHEDULED");
    expect(f.scheduledAt.toISOString()).toBe("2026-09-09T18:30:00.000Z");
    expect(await types("redlion-captain")).toEqual(["rearrangement.accepted"]);
    const [n] = await inbox(db, "redlion-captain");
    expect(n.title).toBe("New date agreed: Melville v Red Lion");
    expect(n.body).toBe("Melville accepted. Now Wed 9 Sept, 19:30.");
  });

  it("only the other team or a league admin can answer, and only teams in the fixture can ask", async () => {
    const { id } = await request();
    await expect(respondToRearrangement(db, s.actors.redLion, { rearrangementId: id, accept: true }, NOW)).rejects.toThrow(ForbiddenError);
    await expect(respondToRearrangement(db, s.actors.otherSecretary, { rearrangementId: id, accept: true }, NOW)).rejects.toThrow(ForbiddenError);
    await withdrawRearrangement(db, s.actors.redLion, { rearrangementId: id });
    await expect(request(undefined, s.actors.crown, "HOME")).rejects.toThrow(ForbiddenError);
    await expect(request(undefined, s.actors.redLion, "HOME")).rejects.toThrow(ForbiddenError); // Red Lion are away
  });

  it("allows one pending request at a time; withdrawing puts the fixture back", async () => {
    const { id } = await request();
    await expect(request("2026-09-16T18:30:00Z", s.actors.melville, "HOME")).rejects.toSatisfy(code("REARRANGEMENT_PENDING"));
    await withdrawRearrangement(db, s.actors.redLion, { rearrangementId: id });
    expect((await fixtureRow()).status).toBe("SCHEDULED");
    await expect(respondToRearrangement(db, s.actors.melville, { rearrangementId: id, accept: true }, NOW)).rejects.toSatisfy(code("REARRANGEMENT_CLOSED"));
    await request("2026-09-16T18:30:00Z", s.actors.melville, "HOME"); // a new request is fine now
  });

  it("a declined request on a postponed fixture leaves it postponed", async () => {
    await postponeFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "Venue flooded" });
    const { id } = await request();
    await respondToRearrangement(db, s.actors.melville, { rearrangementId: id, accept: false, note: "Half our team are away" }, NOW);
    expect((await fixtureRow()).status).toBe("POSTPONED");
    const [n] = await inbox(db, "redlion-captain");
    expect(n.body).toContain('"Half our team are away"');
  });

  it("refuses dates in the past and the current date", async () => {
    await expect(request("2026-08-01T18:30:00Z")).rejects.toSatisfy(code("PROPOSED_IN_PAST"));
    await expect(request("2026-09-02T18:30:00Z")).rejects.toSatisfy(code("SAME_TIME"));
  });

  it("warns about clashes with the teams' other fixtures, blackouts and venue limits", async () => {
    const [crownEntry, melvilleEntry] = [s.team.Crown.entryId, s.team.Melville.entryId];
    await db.insert(fixtures).values({ leagueId: s.league.id, competitionId: s.competition.id, homeEntryId: crownEntry, awayEntryId: melvilleEntry, scheduledAt: new Date("2026-09-09T18:30:00Z") });
    await db.insert(blackoutDates).values({ seasonId: s.season.id, date: "2026-09-09", kind: "CUP", reason: "Cup round 1" });
    const { warnings } = await request();
    expect(warnings.map((w) => w.message)).toEqual(["Melville already play Crown that night", "no league fixtures are planned that night (Cup round 1)"]);
    // Shown again (recomputed) to whoever looks at the request, and in the other team's notification.
    expect((await fixtureRearrangementState(db, fixtureId(), NOW)).pending?.warnings).toHaveLength(2);
    expect((await inbox(db, "melville-captain"))[0].body).toContain("Note: Melville already play Crown that night");
  });

  it("lapses unanswered once the original date passes, and the fixture keeps its date", async () => {
    await request();
    expect(await pendingRearrangements(db, s.league.id, NOW)).toHaveLength(1);
    expect(await expireRearrangements(db, { leagueId: s.league.id }, new Date("2026-09-02T19:00:00Z"))).toBe(1);
    const [r] = await db.select().from(fixtureRearrangements);
    expect(r.status).toBe("EXPIRED");
    const f = await fixtureRow();
    expect([f.status, f.scheduledAt.toISOString()]).toEqual(["SCHEDULED", "2026-09-02T18:30:00.000Z"]);
    expect(await types("redlion-captain")).toEqual(["rearrangement.expired"]);
  });

  it("a league admin's direct reschedule overrides a pending request", async () => {
    await request();
    await rescheduleFixture(db, s.actors.secretary, { fixtureId: fixtureId(), scheduledAt: new Date("2026-09-23T18:30:00Z"), reason: "Agreed by phone" }, NOW);
    const [r] = await db.select().from(fixtureRearrangements);
    expect(r.status).toBe("OVERRIDDEN");
    const f = await fixtureRow();
    expect([f.status, f.scheduledAt.toISOString()]).toEqual(["SCHEDULED", "2026-09-23T18:30:00.000Z"]);
  });

  it("moving into a period with a different match format clears unstarted lineups, and refuses once started", async () => {
    const five = defineRules({ match: { slots: singles(5), groups: s.rules.match.groups } });
    const [rs] = await db.insert(rulesets).values({ leagueId: s.league.id, name: "Division 1", version: 2, config: five }).returning();
    await db.insert(competitionRulePeriods).values({ competitionId: s.competition.id, rulesetId: rs.id, effectiveFrom: "2026-10-01" });
    await lineups();
    const { lineupsReset } = await rescheduleFixture(db, s.actors.secretary, { fixtureId: fixtureId(), scheduledAt: new Date("2026-10-07T18:30:00Z"), reason: "Moved" }, NOW);
    expect(lineupsReset).toBe(true);
    expect(await db.select().from(games).where(eq(games.fixtureId, fixtureId()))).toEqual([]);
    expect((await fixtureRow()).homeLineupConfirmedAt).toBeNull();

    // Back to September rules, start it, then try to move it into October again.
    await rescheduleFixture(db, s.actors.secretary, { fixtureId: fixtureId(), scheduledAt: new Date("2026-09-02T18:30:00Z"), reason: "Back" }, NOW);
    await lineups();
    await startFixture(db, s.actors.melville, fixtureId());
    await playGame(db, s, fixtureId(), 1, "HOME");
    await abandonFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "Pub closed" });
    await expect(
      rescheduleFixture(db, s.actors.secretary, { fixtureId: fixtureId(), scheduledAt: new Date("2026-10-07T18:30:00Z"), reason: "x" }, NOW),
    ).rejects.toSatisfy(code("FORMAT_CHANGES"));
  });
});

describe("league admin fixture changes", () => {
  it("need a reason, are league-admin only, and notify both teams", async () => {
    await expect(postponeFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "  " })).rejects.toSatisfy(code("REASON_REQUIRED"));
    await expect(postponeFixture(db, s.actors.melville, { fixtureId: fixtureId(), reason: "x" })).rejects.toThrow(ForbiddenError);
    await expect(postponeFixture(db, s.actors.otherSecretary, { fixtureId: fixtureId(), reason: "x" })).rejects.toThrow(ForbiddenError);
    await postponeFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "Snow" });
    expect(await types("melville-captain")).toEqual(["fixture.postponed"]);
    expect(await types("redlion-captain")).toEqual(["fixture.postponed"]);
    expect(await types("secretary")).toEqual([]);
  });

  it("cancel and restore", async () => {
    await cancelFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "Duplicate fixture" });
    expect((await fixtureRow()).status).toBe("CANCELLED");
    await restoreFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "Wasn't a duplicate" });
    expect((await fixtureRow()).status).toBe("SCHEDULED");
  });

  it("awards a no-show as a maximum win that counts in the table", async () => {
    await awardFixture(db, s.actors.secretary, { fixtureId: fixtureId(), winner: "HOME", reason: "Red Lion didn't turn up" });
    expect((await fixtureRow()).status).toBe("COMPLETED");
    const melville = (await getStandings(db, s.competition.id)).find((r) => r.name === "Melville")!;
    expect([melville.played, melville.won, melville.gamesFor, melville.points]).toEqual([1, 1, 7, 14]);
    const [o] = await db.select().from(fixtureOutcomes);
    expect(o.source).toBe("ADMIN");
    expect((await inbox(db, "redlion-captain"))[0].body).toBe("Awarded to Melville. Reason: Red Lion didn't turn up");
  });

  it("an abandoned match keeps its finished games and resumes on the new date", async () => {
    await lineups();
    await startFixture(db, s.actors.melville, fixtureId());
    await playGame(db, s, fixtureId(), 1, "HOME");
    await abandonFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "Pub closed early" });
    expect((await fixtureRow()).status).toBe("POSTPONED");
    await rescheduleFixture(db, s.actors.secretary, { fixtureId: fixtureId(), scheduledAt: new Date("2026-09-09T18:30:00Z"), reason: "Resume" }, NOW);
    await startFixture(db, s.actors.melville, fixtureId());
    const [g1] = await db.select().from(games).where(and(eq(games.fixtureId, fixtureId()), eq(games.ordinal, 1)));
    expect([g1.status, g1.winner]).toEqual(["COMPLETED", "HOME"]);
    expect((await fixtureRow()).status).toBe("LIVE");
  });

  it("voiding notifies and overrides a pending request", async () => {
    await request();
    await voidFixture(db, s.actors.secretary, { fixtureId: fixtureId(), reason: "Ineligible player", keepPlayerStats: false });
    expect((await db.select().from(fixtureRearrangements))[0].status).toBe("OVERRIDDEN");
    expect(await types("redlion-captain")).toEqual(["fixture.voided"]);
  });
});

describe("folding a team", () => {
  /** Melville 4–3 Red Lion played; Crown v Red Lion and Red Lion v Swan still to play. */
  async function seasonWithRedLionFixtures() {
    await lineups();
    await startFixture(db, s.actors.melville, fixtureId());
    for (const g of [1, 2, 3]) await playGame(db, s, fixtureId(), g, "HOME");
    for (const g of [4, 5, 6]) await playGame(db, s, fixtureId(), g, "AWAY");
    await completeFixture(db, s.actors.melville, fixtureId());
    const add = (home: string, away: string, at: string) =>
      db.insert(fixtures).values({ leagueId: s.league.id, competitionId: s.competition.id, homeEntryId: home, awayEntryId: away, scheduledAt: new Date(at) }).returning();
    const [[crownVRedLion], [redLionVSwan]] = await Promise.all([
      add(s.team.Crown.entryId, s.team["Red Lion"].entryId, "2026-10-21T18:30:00Z"),
      add(s.team["Red Lion"].entryId, s.team.Swan.entryId, "2026-10-28T18:30:00Z"),
    ]);
    return { crownVRedLion, redLionVSwan };
  }
  const fold = (results: "VOID_ALL" | "MAX_LOSS_REMAINING" | "MAX_LOSS_ALL", playerStats: "KEEP" | "EXCLUDE" = "KEEP") => ({
    entryId: s.team["Red Lion"].entryId,
    results,
    playerStats,
    reason: "Pub closed down",
  });
  const points = async () => Object.fromEntries((await getStandings(db, s.competition.id)).map((r) => [r.name, r.points]));

  it("previews without changing anything", async () => {
    const { crownVRedLion } = await seasonWithRedLionFixtures();
    const before = await points();
    const p = await previewFold(db, s.actors.secretary, fold("MAX_LOSS_REMAINING"));
    expect(p.changes.map((c) => [c.home, c.away, c.from, c.to, c.awardedTo])).toEqual([
      ["Crown", "Red Lion", "SCHEDULED", "COMPLETED", "Crown"],
      ["Red Lion", "Swan", "SCHEDULED", "COMPLETED", "Swan"],
    ]);
    const after = Object.fromEntries(p.tablesAfter[0].rows.map((r) => [r.name, r.points]));
    expect([after.Crown, after.Swan]).toEqual([14, 14]);
    expect(await points()).toEqual(before);
    expect((await fixtureRow(crownVRedLion.id)).status).toBe("SCHEDULED");
    expect(await db.select().from(foldEvents)).toEqual([]);
    expect((await db.select().from(teamEntries).where(eq(teamEntries.id, s.team["Red Lion"].entryId)))[0].status).toBe("ACTIVE");
  });

  it("awards the remaining fixtures, keeps the played result, and reverses exactly", async () => {
    const { crownVRedLion } = await seasonWithRedLionFixtures();
    const before = await points();
    const p = await foldTeam(db, s.actors.secretary, fold("MAX_LOSS_REMAINING"));
    const table = await getStandings(db, s.competition.id);
    expect(table.at(-1)).toMatchObject({ name: "Red Lion", withdrawn: true });
    expect((await points()).Melville).toBe(before.Melville); // played result stands
    expect([(await points()).Crown, (await points()).Swan]).toEqual([14, 14]);
    expect(await types("crown-captain")).toEqual(["team.folded"]);

    // Fixtures changed by the fold can't be edited one by one…
    await expect(restoreFixture(db, s.actors.secretary, { fixtureId: crownVRedLion.id, reason: "x" })).rejects.toSatisfy(code("FOLDED"));
    // …but the whole fold reverses exactly.
    await revertFold(db, s.actors.secretary, { foldEventId: p.foldEventId, reason: "Found a new pub" });
    expect(await points()).toEqual(before);
    const f = await fixtureRow(crownVRedLion.id);
    expect([f.status, f.foldEventId]).toEqual(["SCHEDULED", null]);
    expect(await db.select().from(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, crownVRedLion.id))).toEqual([]);
    expect((await db.select().from(teamEntries).where(eq(teamEntries.id, s.team["Red Lion"].entryId)))[0].status).toBe("ACTIVE");
    await expect(revertFold(db, s.actors.secretary, { foldEventId: p.foldEventId, reason: "again" })).rejects.toSatisfy(code("ALREADY_REVERTED"));
  });

  it("voiding everything can exclude the voided games from player statistics", async () => {
    await seasonWithRedLionFixtures();
    const melvilleOne = s.team.Melville.playerIds[0];
    expect((await playerStats(db, { playerIds: [melvilleOne] })).get(melvilleOne)?.gamesPlayed).toBe(1);
    await foldTeam(db, s.actors.secretary, fold("VOID_ALL", "EXCLUDE"));
    expect((await fixtureRow()).status).toBe("VOID");
    expect((await playerStats(db, { playerIds: [melvilleOne] })).get(melvilleOne)).toBeUndefined();
    expect((await points()).Melville).toBe(0);
  });

  it("max loss on everything replaces the played result too, keeping the players' stats if asked", async () => {
    await seasonWithRedLionFixtures();
    const p = await foldTeam(db, s.actors.secretary, fold("MAX_LOSS_ALL", "KEEP"));
    const [main] = await db.select().from(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, fixtureId()));
    expect([main.homeGames, main.awayGames, main.source]).toEqual([7, 0, "AWARDED"]);
    expect((await points()).Melville).toBe(14);
    expect(p.changes.find((c) => c.fixtureId === fixtureId())).toMatchObject({ played: true, statsKept: true });
    // Each player's own game still counts: Red Lion's player 4 won game 4 and keeps that win.
    const redLionFour = s.team["Red Lion"].playerIds[3];
    expect((await playerStats(db, { playerIds: [redLionFour] })).get(redLionFour)).toMatchObject({ gamesPlayed: 1, wins: 1 });
  });

  it("max loss on everything can void the played match's player stats, for both teams, and reversing brings them back", async () => {
    await seasonWithRedLionFixtures();
    const [melvilleOne, redLionFour] = [s.team.Melville.playerIds[0], s.team["Red Lion"].playerIds[3]];
    const p = await foldTeam(db, s.actors.secretary, fold("MAX_LOSS_ALL", "EXCLUDE"));
    expect(p.changes.find((c) => c.fixtureId === fixtureId())).toMatchObject({ played: true, statsKept: false });
    expect((await fixtureRow()).status).toBe("COMPLETED"); // the awarded result still counts in the table…
    expect((await points()).Melville).toBe(14);
    const stats = await playerStats(db, { playerIds: [melvilleOne, redLionFour] }); // …but its darts don't
    expect([stats.get(melvilleOne), stats.get(redLionFour)]).toEqual([undefined, undefined]);

    await revertFold(db, s.actors.secretary, { foldEventId: p.foldEventId, reason: "Mistake" });
    expect((await playerStats(db, { playerIds: [melvilleOne] })).get(melvilleOne)?.gamesPlayed).toBe(1);
    expect((await fixtureRow()).statsExcluded).toBe(false);
  });

  it("refuses to revert if a fixture changed since, to fold twice, or to fold mid-match", async () => {
    await seasonWithRedLionFixtures();
    const p = await foldTeam(db, s.actors.secretary, fold("MAX_LOSS_REMAINING"));
    await expect(foldTeam(db, s.actors.secretary, fold("VOID_ALL"))).rejects.toSatisfy(code("ALREADY_FOLDED"));
    const changed = p.changes[0].fixtureId;
    const f = await fixtureRow(changed);
    await db.update(fixtures).set({ version: f.version + 1 }).where(eq(fixtures.id, changed));
    await expect(revertFold(db, s.actors.secretary, { foldEventId: p.foldEventId, reason: "x" })).rejects.toSatisfy(code("FOLD_CHANGED_SINCE"));

    // Another team mid-match.
    const crownVSwan = s.fixtures.crownVSwan.id;
    await db.update(fixtures).set({ status: "LIVE" }).where(eq(fixtures.id, crownVSwan));
    await expect(foldTeam(db, s.actors.secretary, { ...fold("VOID_ALL"), entryId: s.team.Swan.entryId })).rejects.toSatisfy(code("FOLD_BLOCKED"));
    await expect(foldTeam(db, s.actors.melville, { ...fold("VOID_ALL"), entryId: s.team.Crown.entryId })).rejects.toThrow(ForbiddenError);
  });
});

describe("notifications", () => {
  const event = {
    type: "fixture.postponed" as const,
    payload: { fixtureId: "f", leagueSlug: "manchester", home: "Melville", away: "Red Lion", tz: "Europe/London", reason: "Snow" },
  };

  it("queues one delivery per external channel and retries failures up to a limit", async () => {
    const sent: string[] = [];
    const ok: NotificationChannel = { name: "ok", send: async (m) => void sent.push(`${m.to.email}: ${m.title} ${m.url}`) };
    const broken: NotificationChannel = { name: "broken", send: async () => { throw new Error("provider down"); } };
    await notify(db, { leagueId: s.league.id, event, to: { teamIds: [s.team.Melville.teamId] } }, [ok, broken]);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(2);

    expect(await deliverPending(db, [ok, broken], { siteUrl: "https://darts.example" })).toEqual({ sent: 1, failed: 1 });
    expect(sent).toEqual(["melville-captain@example.test: Postponed: Melville v Red Lion https://darts.example/admin/manchester/fixtures/f"]);
    for (let i = 1; i < MAX_ATTEMPTS; i++) await deliverPending(db, [ok, broken]);
    const rows = await db.select().from(notificationDeliveries);
    expect(rows.map((r) => [r.channel, r.status, r.attempts]).sort()).toEqual([
      ["broken", "FAILED", MAX_ATTEMPTS],
      ["ok", "SENT", 1],
    ]);
    expect(await deliverPending(db, [ok, broken])).toEqual({ sent: 0, failed: 0 });
  });

  it("has an inbox with unread counts that only its owner can mark read", async () => {
    await notify(db, { leagueId: s.league.id, event, to: { teamIds: [s.team.Melville.teamId, s.team["Red Lion"].teamId] } }, []);
    const [mine] = await inbox(db, "melville-captain");
    await markRead(db, "redlion-captain", [mine.id]); // someone else's id: no effect
    expect(await unreadCount(db, "melville-captain")).toBe(1);
    await markRead(db, "melville-captain");
    expect(await unreadCount(db, "melville-captain")).toBe(0);
    expect(await unreadCount(db, "redlion-captain")).toBe(1);
  });
});
