import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase, type Db } from "@/db/client";
import { auditLog, fixtures, playerRegistrations, users } from "@/db/schema";
import { localDateInZone, weekdayOf } from "@/domain/dates";
import { ForbiddenError, type Actor } from "@/domain/permissions";
import { DEFAULT_RULES } from "@/domain/rules";
import { createAccount } from "./auth-service";
import { loadActor } from "./context";
import { setLineup } from "./match-service";
import { registerPlayer } from "./registration-service";
import {
  addBlackoutDate,
  createConstraint,
  previewSchedule,
  publishSchedule,
  removeBlackoutDate,
  suggestVenueConstraints,
} from "./schedule-service";
import {
  addTeamToCompetition,
  createDivision,
  createLeague,
  createLeagueCompetition,
  createSeason,
  createTeam,
  createVenue,
} from "./setup-service";
import { createInvitation, acceptInvitation } from "./invitation-service";

let db: Db;
let admin: Actor;
let captain: Actor;
let league: { id: string };
let seasonId: string;
let div1: string;
let div3: string;
const team: Record<string, { teamId: string; entryId: string }> = {};

/** Division 1: Melville + 9 others. Division 3: Melville B + 7 others. Both Wednesdays. */
beforeEach(async () => {
  db = await openTestDatabase();
  await db.insert(users).values({ id: "root", email: "root@example.test", name: "Root", isPlatformAdmin: true });
  const root = await loadActor(db, "root");
  league = await createLeague(db, root, { name: "Manchester", slug: "manchester", timezone: "Europe/London", firstAdminUserId: "root" });
  admin = await loadActor(db, "root");
  const season = await createSeason(db, admin, league.id, { name: "2026/27", startsOn: "2026-09-02" });
  seasonId = season.id;
  const melvilleVenue = await createVenue(db, admin, league.id, { name: "The Melville" });
  const d1 = await createDivision(db, admin, league.id, { name: "Division 1" });
  const d3 = await createDivision(db, admin, league.id, { name: "Division 3" });
  div1 = (await createLeagueCompetition(db, admin, { seasonId, divisionId: d1.id, rules: DEFAULT_RULES, matchWeekday: 3 })).id;
  div3 = (await createLeagueCompetition(db, admin, { seasonId, divisionId: d3.id, rules: DEFAULT_RULES, matchWeekday: 3 })).id;
  const add = async (name: string, competitionId: string, venueId?: string) => {
    const t = await createTeam(db, admin, league.id, { name, venueId });
    const e = await addTeamToCompetition(db, admin, { competitionId, teamId: t.id });
    team[name] = { teamId: t.id, entryId: e.id };
  };
  await add("Melville", div1, melvilleVenue.id);
  for (let i = 2; i <= 10; i++) await add(`D1 Team ${i}`, div1);
  await add("Melville B", div3, melvilleVenue.id);
  for (let i = 2; i <= 8; i++) await add(`D3 Team ${i}`, div3);

  const user = await createAccount(db, { email: "cap@example.test", name: "Cap", password: "darts darts darts" });
  const { token } = await createInvitation(db, admin, { leagueId: league.id, role: "TEAM_ADMIN", teamId: team.Melville.teamId });
  await acceptInvitation(db, user.id, token);
  captain = await loadActor(db, user.id);
});

const request = (over: Partial<Parameters<typeof previewSchedule>[2]> = {}) => ({
  seasonId,
  competitionIds: [div1, div3],
  startDate: "2026-09-02",
  meetings: 2,
  kickoff: "19:30",
  seed: 1,
  ...over,
});

async function brief() {
  for (const [date, reason, kind] of [
    ["2026-10-28", "Cup", "CUP"],
    ["2026-12-23", "Christmas break", "BREAK"],
    ["2026-12-30", "Christmas break", "BREAK"],
    ["2027-02-17", "Cup", "CUP"],
  ] as const) {
    await addBlackoutDate(db, admin, { seasonId, date, reason, kind });
  }
}

describe("venue constraints", () => {
  it("suggests a constraint for teams sharing a home venue, then stops suggesting it", async () => {
    const [suggestion] = await suggestVenueConstraints(db, seasonId);
    expect(suggestion.venue.name).toBe("The Melville");
    expect(suggestion.teams.map((t) => t.name).sort()).toEqual(["Melville", "Melville B"]);
    await createConstraint(db, admin, { seasonId, name: "The Melville", teamIds: suggestion.teams.map((t) => t.id), maxHome: 1 });
    expect(await suggestVenueConstraints(db, seasonId)).toEqual([]);
  });

  it("rejects pointless or foreign constraints and team admins", async () => {
    const ids = [team.Melville.teamId, team["Melville B"].teamId];
    await expect(createConstraint(db, admin, { seasonId, name: "x", teamIds: ids, maxHome: 2 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(createConstraint(db, admin, { seasonId, name: "x", teamIds: [ids[0]], maxHome: 1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(createConstraint(db, captain, { seasonId, name: "x", teamIds: ids, maxHome: 1 })).rejects.toThrow(ForbiddenError);
    await expect(addBlackoutDate(db, captain, { seasonId, date: "2026-12-23", reason: "x", kind: "BREAK" })).rejects.toThrow(ForbiddenError);
  });
});

describe("generating fixtures", () => {
  it("previews the brief's season around cup and Christmas dates, writing nothing", async () => {
    await brief();
    await createConstraint(db, admin, { seasonId, name: "The Melville", teamIds: [team.Melville.teamId, team["Melville B"].teamId], maxHome: 1 });
    const preview = await previewSchedule(db, admin, request());

    expect(preview.result.conflicts).toEqual([]);
    expect(preview.divisions.find((d) => d.id === div1)).toMatchObject({ teamCount: 10, rounds: 18, firstDate: "2026-09-02" });
    expect(preview.divisions.find((d) => d.id === div3)).toMatchObject({ teamCount: 8, rounds: 14 });
    for (const x of ["2026-10-28", "2026-12-23", "2026-12-30", "2027-02-17"]) {
      expect(preview.result.fixtures.some((f) => f.date === x)).toBe(false);
    }
    expect(preview.homeCounts[team.Melville.entryId]).toBe(9);
    expect(await db.select().from(fixtures)).toHaveLength(0);
  });

  it("publishes exactly the previewed fixtures at 19:30 local time, with home venues", async () => {
    await brief();
    await createConstraint(db, admin, { seasonId, name: "The Melville", teamIds: [team.Melville.teamId, team["Melville B"].teamId], maxHome: 1 });
    const preview = await previewSchedule(db, admin, request({ seed: 99 }));
    const published = await publishSchedule(db, admin, { ...request({ seed: 99 }), replaceExisting: false, acknowledgeConflicts: false });
    expect(published.fixtures).toBe(preview.result.fixtures.length);

    const rows = await db.select().from(fixtures);
    expect(rows).toHaveLength(90 + 56);
    for (const f of rows) {
      expect(weekdayOf(localDateInZone(f.scheduledAt, "Europe/London"))).toBe(3);
      expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(f.scheduledAt)).toBe("19:30");
    }
    // Melville and Melville B are never both at home on the same night.
    const homeNights = (entryId: string) => new Set(rows.filter((f) => f.homeEntryId === entryId).map((f) => localDateInZone(f.scheduledAt, "Europe/London")));
    const b = homeNights(team["Melville B"].entryId);
    expect([...homeNights(team.Melville.entryId)].some((d) => b.has(d))).toBe(false);
    // Home venue is recorded.
    expect(rows.find((f) => f.homeEntryId === team.Melville.entryId)?.venueId).toBeTruthy();
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "schedule.published"));
    expect(log.after).toMatchObject({ fixtures: 146, seed: 99 });
  });

  it("will not silently publish clashes", async () => {
    // Four teams sharing one pub, at most one at home: impossible across two divisions on the same night.
    const ids = [team.Melville, team["D1 Team 2"], team["Melville B"], team["D3 Team 2"]].map((t) => t.teamId);
    await createConstraint(db, admin, { seasonId, name: "Tiny pub", teamIds: ids, maxHome: 1 });
    const preview = await previewSchedule(db, admin, request());
    expect(preview.result.conflicts.length).toBeGreaterThan(0);
    await expect(publishSchedule(db, admin, { ...request(), replaceExisting: false, acknowledgeConflicts: false })).rejects.toMatchObject({
      code: "SCHEDULE_HAS_CLASHES",
    });
    const accepted = await publishSchedule(db, admin, { ...request(), replaceExisting: false, acknowledgeConflicts: true });
    expect(accepted.conflicts.length).toBe(preview.result.conflicts.length);
  });

  it("replaces unplayed fixtures only when asked, and never once lineups exist", async () => {
    const go = (replaceExisting: boolean) => publishSchedule(db, admin, { ...request(), replaceExisting, acknowledgeConflicts: false });
    await go(false);
    await expect(go(false)).rejects.toMatchObject({ code: "FIXTURES_EXIST" });
    await expect(go(true)).resolves.toMatchObject({ replaced: 146 });

    // Once a captain has picked a lineup, the schedule is in use.
    const [first] = await db.select().from(fixtures).where(eq(fixtures.homeEntryId, team.Melville.entryId)).limit(1);
    const regs = [];
    for (let i = 0; i < 7; i++) regs.push(await registerPlayer(db, admin, { seasonId, teamId: team.Melville.teamId, player: { firstName: "P", lastName: `${i}` } }, new Date("2026-08-01")));
    expect(regs).toHaveLength(7);
    await setLineup(db, captain, { fixtureId: first.id, side: "HOME", slots: regs.map((r, i) => ({ gameOrdinal: i + 1, registrationIds: [r.id] })), confirm: false });
    await expect(go(true)).rejects.toMatchObject({ code: "FIXTURES_PLAYED" });
    expect((await db.select().from(playerRegistrations).where(inArray(playerRegistrations.id, regs.map((r) => r.id)))).length).toBe(7);
  });

  it("only league admins can generate, and dates can be removed", async () => {
    await expect(previewSchedule(db, captain, request())).rejects.toThrow(ForbiddenError);
    const blackout = await addBlackoutDate(db, admin, { seasonId, date: "2026-09-02", reason: "Season launch", kind: "OTHER" });
    expect((await previewSchedule(db, admin, request())).divisions[0].firstDate).toBe("2026-09-09");
    await removeBlackoutDate(db, admin, blackout.id);
    expect((await previewSchedule(db, admin, request())).divisions[0].firstDate).toBe("2026-09-02");
  });
});
