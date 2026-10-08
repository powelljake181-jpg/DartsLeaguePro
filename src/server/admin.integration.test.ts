import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase, type Db } from "@/db/client";
import { auditLog, competitionRulePeriods, sessions } from "@/db/schema";
import { ForbiddenError } from "@/domain/permissions";
import { DEFAULT_RULES, RULE_TEMPLATES } from "@/domain/rules";
import {
  authenticate,
  createAccount,
  createFirstPlatformAdmin,
  createSession,
  endSession,
  hashPassword,
  resolveSession,
  verifyPassword,
} from "./auth-service";
import { loadActor } from "./context";
import { acceptInvitation, createInvitation, lookupInvitation, revokeInvitation, revokeMembership } from "./invitation-service";
import { adminLeague, leaguePeople, teamSquad } from "./queries";
import {
  addTeamToCompetition,
  createDivision,
  createLeague,
  createLeagueCompetition,
  createSeason,
  createTeam,
  removeTeamFromCompetition,
  updateSeason,
} from "./setup-service";
import { buildScenario, type Scenario } from "./testing/scenario";

let db: Db;
beforeEach(async () => {
  db = await openTestDatabase();
});

const account = { email: "Sec@Example.com ", name: "Sue Secretary", password: "correct horse battery" };

describe("accounts and sessions", () => {
  it("hashes passwords with a salt and verifies them", async () => {
    const [a, b] = [await hashPassword("pint of mild"), await hashPassword("pint of mild")];
    expect(a).not.toBe(b);
    expect(await verifyPassword("pint of mild", a)).toBe(true);
    expect(await verifyPassword("pint of bitter", a)).toBe(false);
  });

  it("sets up the first platform admin once", async () => {
    const admin = await createFirstPlatformAdmin(db, account);
    expect(admin).toMatchObject({ email: "sec@example.com", isPlatformAdmin: true });
    await expect(createFirstPlatformAdmin(db, { ...account, email: "x@example.com" })).rejects.toMatchObject({ code: "ALREADY_SET_UP" });
  });

  it("validates new accounts and rejects duplicate emails", async () => {
    await expect(createAccount(db, { ...account, password: "short" })).rejects.toMatchObject({ code: "INVALID_ACCOUNT" });
    await createAccount(db, account);
    await expect(createAccount(db, { ...account, email: "sec@example.com" })).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
  });

  it("signs in case-insensitively and rejects wrong passwords", async () => {
    await createAccount(db, account);
    await expect(authenticate(db, "SEC@example.com", account.password)).resolves.toMatchObject({ name: "Sue Secretary" });
    await expect(authenticate(db, "sec@example.com", "wrong password!")).rejects.toMatchObject({ code: "BAD_CREDENTIALS", status: 401 });
    await expect(authenticate(db, "nobody@example.com", "whatever123")).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
  });

  it("locks out an email after repeated failures, then lets it try again later", async () => {
    await createAccount(db, account);
    const t0 = new Date("2026-10-07T20:00:00Z");
    for (let i = 0; i < 8; i++) await expect(authenticate(db, account.email, "guess-" + i, t0)).rejects.toMatchObject({ code: "BAD_CREDENTIALS" });
    await expect(authenticate(db, account.email, account.password, t0)).rejects.toMatchObject({ code: "TOO_MANY_ATTEMPTS", status: 429 });
    const later = new Date(t0.getTime() + 16 * 60 * 1000);
    await expect(authenticate(db, account.email, account.password, later)).resolves.toBeTruthy();
  });

  it("stores only a hash of the session token and expires sessions", async () => {
    const user = await createAccount(db, account);
    const t0 = new Date("2026-10-07T20:00:00Z");
    const { token } = await createSession(db, user.id, "test", t0);
    const [row] = await db.select().from(sessions);
    expect(row.id).not.toBe(token);
    expect(await resolveSession(db, token, t0)).toMatchObject({ id: user.id });
    expect(await resolveSession(db, "forged-token", t0)).toBeNull();
    expect(await resolveSession(db, token, new Date(t0.getTime() + 31 * 24 * 3600 * 1000))).toBeNull();
    const second = await createSession(db, user.id, "test", t0);
    await endSession(db, second.token);
    expect(await resolveSession(db, second.token, t0)).toBeNull();
  });
});

describe("invitations", () => {
  let s: Scenario;
  beforeEach(async () => {
    s = await buildScenario(db);
  });
  const newUser = async (email: string) => (await createAccount(db, { email, name: email, password: "darts darts darts" })).id;

  it("turns a league admin's invitation into a team admin role", async () => {
    const { token } = await createInvitation(db, s.actors.secretary, { leagueId: s.league.id, role: "TEAM_ADMIN", teamId: s.team.Swan.teamId, note: "Swan captain" });
    expect(await lookupInvitation(db, token)).toMatchObject({ state: "VALID", role: "TEAM_ADMIN", teamName: "Swan", leagueName: "Manchester Darts League" });

    const userId = await newUser("swan@example.com");
    await acceptInvitation(db, userId, token);
    expect((await loadActor(db, userId)).teamAdminOf.has(s.team.Swan.teamId)).toBe(true);
    expect(await lookupInvitation(db, token)).toMatchObject({ state: "USED" });
    await expect(acceptInvitation(db, await newUser("someone@example.com"), token)).rejects.toMatchObject({ code: "INVITATION_USED" });
  });

  it("grants league admin, and expired or revoked links do nothing", async () => {
    const t0 = new Date("2026-10-07T20:00:00Z");
    const a = await createInvitation(db, s.actors.secretary, { leagueId: s.league.id, role: "LEAGUE_ADMIN" }, t0);
    const userId = await newUser("fixtures@example.com");
    await expect(acceptInvitation(db, userId, a.token, new Date(t0.getTime() + 15 * 24 * 3600 * 1000))).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
    await acceptInvitation(db, userId, a.token, t0);
    expect((await loadActor(db, userId)).leagueAdminOf.has(s.league.id)).toBe(true);

    const b = await createInvitation(db, s.actors.secretary, { leagueId: s.league.id, role: "LEAGUE_ADMIN" });
    await revokeInvitation(db, s.actors.secretary, b.invitation.id);
    await expect(acceptInvitation(db, await newUser("x@example.com"), b.token)).rejects.toMatchObject({ code: "INVITATION_REVOKED" });
  });

  it("lets team admins invite a co-admin for their own team only", async () => {
    await expect(
      createInvitation(db, s.actors.melville, { leagueId: s.league.id, role: "TEAM_ADMIN", teamId: s.team.Melville.teamId }),
    ).resolves.toBeTruthy();
    await expect(
      createInvitation(db, s.actors.melville, { leagueId: s.league.id, role: "TEAM_ADMIN", teamId: s.team["Red Lion"].teamId }),
    ).rejects.toThrow(ForbiddenError);
    await expect(createInvitation(db, s.actors.melville, { leagueId: s.league.id, role: "LEAGUE_ADMIN" })).rejects.toThrow(ForbiddenError);
    await expect(
      createInvitation(db, s.actors.otherSecretary, { leagueId: s.league.id, role: "TEAM_ADMIN", teamId: s.team.Melville.teamId }),
    ).rejects.toThrow(ForbiddenError);
    // A team from another league can't be smuggled in.
    await expect(
      createInvitation(db, s.actors.otherSecretary, { leagueId: s.otherLeague.id, role: "TEAM_ADMIN", teamId: s.team.Melville.teamId }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("never removes a league's last league admin, and team admins cannot remove each other", async () => {
    const { leagueAdmins, teamAdmins } = await leaguePeople(db, s.league.id);
    expect(leagueAdmins).toHaveLength(1);
    await expect(revokeMembership(db, s.actors.secretary, { kind: "league", membershipId: leagueAdmins[0].membership.id })).rejects.toMatchObject({
      code: "LAST_LEAGUE_ADMIN",
    });
    const melvilleAdmin = teamAdmins.find((t) => t.team.name === "Melville")!;
    await expect(revokeMembership(db, s.actors.redLion, { kind: "team", membershipId: melvilleAdmin.membership.id })).rejects.toThrow(ForbiddenError);
    await revokeMembership(db, s.actors.secretary, { kind: "team", membershipId: melvilleAdmin.membership.id });
    expect((await loadActor(db, "melville-captain")).teamAdminOf.size).toBe(0);
  });
});

describe("league set-up", () => {
  let s: Scenario;
  beforeEach(async () => {
    s = await buildScenario(db);
  });

  it("only platform admins create leagues, with unique addresses", async () => {
    const input = { name: "Stockport League", slug: "stockport", timezone: "Europe/London" };
    await expect(createLeague(db, s.actors.secretary, input)).rejects.toThrow(ForbiddenError);
    const league = await createLeague(db, s.actors.platform, { ...input, firstAdminUserId: "secretary" });
    expect((await loadActor(db, "secretary")).leagueAdminOf.has(league.id)).toBe(true);
    await expect(createLeague(db, s.actors.platform, input)).rejects.toMatchObject({ code: "SLUG_TAKEN" });
    await expect(createLeague(db, s.actors.platform, { ...input, slug: "Bad Slug!" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("creates a season whose registration deadline ends at midnight league time, and audits changes", async () => {
    const season = await createSeason(db, s.actors.secretary, s.league.id, {
      name: "2027/28",
      startsOn: "2027-09-01",
      registrationDeadline: "2028-01-31",
      maxSquadSize: "12",
    });
    expect(season.registrationClosesAt?.toISOString()).toBe("2028-01-31T23:59:59.999Z");
    expect(season.maxSquadSize).toBe(12);
    await expect(createSeason(db, s.actors.melville, s.league.id, { name: "x", startsOn: "2027-09-01" })).rejects.toThrow(ForbiddenError);
    await expect(createSeason(db, s.actors.otherSecretary, s.league.id, { name: "x", startsOn: "2027-09-01" })).rejects.toThrow(ForbiddenError);
    await expect(createSeason(db, s.actors.secretary, s.league.id, { name: "bad", startsOn: "2027-09-01", endsOn: "2027-01-01" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    await updateSeason(db, s.actors.secretary, season.id, { name: "2027/28", startsOn: "2027-09-01", registrationDeadline: "2028-02-28" });
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "season.updated"));
    expect(log.entityId).toBe(season.id);
  });

  it("sets up a division competition with starting rules and enters teams once per season", async () => {
    const division = await createDivision(db, s.actors.secretary, s.league.id, { name: "Division 2" });
    expect(division.rank).toBe(2);
    const pairsTemplate = RULE_TEMPLATES.find((t) => t.key === "pairs-table-singles-7")!.rules;
    const competition = await createLeagueCompetition(db, s.actors.secretary, { seasonId: s.season.id, divisionId: division.id, rules: pairsTemplate, matchWeekday: 3 });
    const [period] = await db.select().from(competitionRulePeriods).where(eq(competitionRulePeriods.competitionId, competition.id));
    expect(period.effectiveFrom).toBe(s.season.startsOn);
    await expect(
      createLeagueCompetition(db, s.actors.secretary, { seasonId: s.season.id, divisionId: division.id, rules: DEFAULT_RULES }),
    ).rejects.toMatchObject({ code: "COMPETITION_EXISTS" });
    await expect(
      createLeagueCompetition(db, s.actors.secretary, { seasonId: s.season.id, divisionId: division.id, rules: { nonsense: true } }),
    ).rejects.toMatchObject({ code: "INVALID_RULES" });

    const newTeam = await createTeam(db, s.actors.secretary, s.league.id, { name: "Melville" }); // a second "Melville" gets its own address
    expect(newTeam.slug).toBe("melville-2");
    await addTeamToCompetition(db, s.actors.secretary, { competitionId: competition.id, teamId: newTeam.id });
    // Melville already play in Division 1 this season.
    await expect(addTeamToCompetition(db, s.actors.secretary, { competitionId: competition.id, teamId: s.team.Melville.teamId })).rejects.toMatchObject({
      code: "ALREADY_ENTERED",
    });
  });

  it("will not remove a team that already has fixtures", async () => {
    await expect(removeTeamFromCompetition(db, s.actors.secretary, s.team.Melville.entryId)).rejects.toMatchObject({ code: "HAS_FIXTURES" });
  });
});

describe("admin page access", () => {
  let s: Scenario;
  beforeEach(async () => {
    s = await buildScenario(db);
  });

  it("shows a league to its admins and its team admins only", async () => {
    await expect(adminLeague(db, s.actors.secretary, "manchester")).resolves.toMatchObject({ leagueAdmin: true });
    const asCaptain = await adminLeague(db, s.actors.melville, "manchester");
    expect(asCaptain.leagueAdmin).toBe(false);
    expect(asCaptain.myTeams.map((t) => t.name)).toEqual(["Melville"]);
    await expect(adminLeague(db, s.actors.otherSecretary, "manchester")).rejects.toThrow(ForbiddenError);
  });

  it("shows a squad to that team's admins and league admins only", async () => {
    const squad = await teamSquad(db, s.actors.melville, s.team.Melville.teamId, null);
    expect(squad.squad).toHaveLength(7);
    expect(squad.season?.name).toBe("2026/27");
    await expect(teamSquad(db, s.actors.redLion, s.team.Melville.teamId, null)).rejects.toThrow(ForbiddenError);
    await expect(teamSquad(db, s.actors.secretary, s.team.Melville.teamId, null)).resolves.toBeTruthy();
  });
});
