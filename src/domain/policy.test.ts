import { describe, expect, it } from "vitest";
import { countsTowardStandings, transition, TransitionError } from "./fixture-state";
import { can, type Actor } from "./permissions";
import { endOfDayInZone, localDateInZone } from "./dates";
import { canRegisterPlayer, validateLineup, type EligibleRegistration } from "./registration";
import { describeChanges, nextPeriodAfter, periodFor, structuralChanges } from "./rule-periods";
import { defineRules, pairs, resultGroup, rulesSchema, singles, DEFAULT_RULES, type GameKind } from "./rules";

describe("rules config", () => {
  it("accepts the defaults and the demo Division 1 rules", () => {
    expect(rulesSchema.safeParse(DEFAULT_RULES).success).toBe(true);
    expect(() =>
      defineRules({
        match: { slots: singles(7), groups: [resultGroup({ key: "main", points: { win: 7, draw: 0, loss: 0, perGameWon: 1 } })] },
      }),
    ).not.toThrow();
  });

  it("allows different settings for singles and pairs games", () => {
    const r = defineRules({ game: { pairs: { startingScore: 701, legsFormat: "BEST_OF", legs: 3 } } });
    expect(r.game.singles).toMatchObject({ startingScore: 501, legs: 1 });
    expect(r.game.pairs).toMatchObject({ startingScore: 701, legs: 3, doubleOut: true });
  });

  it("rejects contradictory formats", () => {
    const withGroup = (n: number, g: Parameters<typeof resultGroup>[0]) => defineRules({ match: { slots: singles(n), groups: [resultGroup(g)] } });
    expect(() => withGroup(8, { key: "main", allowDraw: false })).toThrow(/can end level/);
    expect(() => withGroup(7, { key: "main", format: "BEST_OF", allowDraw: true })).toThrow(/cannot be drawn/);
    expect(() => defineRules({ game: { singles: { legsFormat: "BEST_OF", legs: 4 } } })).toThrow(/odd number/);
    expect(() => withGroup(7, { key: "main", tieBreakers: ["GAME_DIFFERENCE", "POINTS"] })).toThrow(/points first/);
    expect(() => withGroup(7, { key: "main", tieBreakers: ["POINTS", "POINTS"] })).toThrow(/unique/);
    expect(() =>
      defineRules({ match: { slots: singles(7), groups: [resultGroup({ key: "main" }), resultGroup({ key: "pairs" })] } }),
    ).toThrow(/has no games/);
  });
});

describe("rules timeline", () => {
  const periods = [
    { effectiveFrom: "2026-09-02", name: "original" },
    { effectiveFrom: "2027-01-01", name: "new year" },
  ];

  it("picks the period in force on a date", () => {
    expect(periodFor(periods, "2026-12-31").name).toBe("original");
    expect(periodFor(periods, "2027-01-01").name).toBe("new year");
    expect(periodFor(periods, "2026-08-01").name).toBe("original");
    expect(nextPeriodAfter(periods, "2026-11-01")?.name).toBe("new year");
    expect(nextPeriodAfter(periods, "2027-02-01")).toBeNull();
  });

  it("separates changes that alter how matches are played from ones that only re-score", () => {
    const base = DEFAULT_RULES;
    const newPoints = defineRules({ match: { ...base.match, groups: [resultGroup({ key: "main", name: "League", points: { win: 3, draw: 1, loss: 0, perGameWon: 1 } })] } });
    expect(structuralChanges(base, newPoints)).toEqual([]);
    expect(describeChanges(base, newPoints)).toEqual(["League points"]);

    const withPairs = defineRules({ match: { ...base.match, slots: [...singles(6), ...pairs(1)] } });
    expect(structuralChanges(base, withPairs)).toHaveLength(1);
    const longerPairs = defineRules({ game: { pairs: { legs: 3 } } });
    expect(structuralChanges(base, longerPairs)).toEqual(["pairs game format (starting score, legs or finish)"]);
  });

  it("uses the league's local date", () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Paris.
    expect(localDateInZone(new Date("2026-12-31T23:30:00Z"), "Europe/London")).toBe("2026-12-31");
    expect(localDateInZone(new Date("2026-12-31T23:30:00Z"), "Europe/Paris")).toBe("2027-01-01");
  });
});

describe("fixture state machine", () => {
  it("only starts with lineups and only finalises when all games resolved", () => {
    expect(() => transition("SCHEDULED", "START")).toThrow(/lineups/);
    expect(transition("SCHEDULED", "START", { lineupsConfirmed: true })).toBe("LIVE");
    expect(() => transition("LIVE", "FINALISE")).toThrow(/not all required games/);
    expect(transition("LIVE", "FINALISE", { allGamesResolved: true })).toBe("COMPLETED");
  });

  it("rejects transitions that are not allowed", () => {
    expect(() => transition("COMPLETED", "START", { lineupsConfirmed: true })).toThrow(TransitionError);
    expect(() => transition("VOID", "FINALISE", { allGamesResolved: true })).toThrow(TransitionError);
    expect(() => transition("LIVE", "REQUEST_REARRANGEMENT")).toThrow(TransitionError);
    expect(() => transition("SCHEDULED", "RESTORE")).toThrow(TransitionError);
  });

  it("handles rearrangements, voids and restores", () => {
    expect(transition("SCHEDULED", "REQUEST_REARRANGEMENT")).toBe("REARRANGEMENT_REQUESTED");
    expect(transition("REARRANGEMENT_REQUESTED", "RESOLVE_REARRANGEMENT")).toBe("SCHEDULED");
    // A rejected request on a postponed fixture leaves it postponed.
    expect(transition("REARRANGEMENT_REQUESTED", "RESOLVE_REARRANGEMENT", { restoreTo: "POSTPONED" })).toBe("POSTPONED");
    expect(() => transition("REARRANGEMENT_REQUESTED", "RESOLVE_REARRANGEMENT", { restoreTo: "COMPLETED" })).toThrow(TransitionError);
    expect(() => transition("SCHEDULED", "RESOLVE_REARRANGEMENT")).toThrow(TransitionError);
    expect(transition("COMPLETED", "VOID")).toBe("VOID");
    expect(transition("VOID", "RESTORE", { restoreTo: "COMPLETED" })).toBe("COMPLETED");
  });

  it("only completed fixtures count toward standings", () => {
    expect(countsTowardStandings("COMPLETED")).toBe(true);
    for (const s of ["LIVE", "VOID", "SCHEDULED", "CANCELLED", "POSTPONED"] as const) {
      expect(countsTowardStandings(s)).toBe(false);
    }
  });
});

describe("registration deadline", () => {
  const closesAt = endOfDayInZone("2027-01-31", "Europe/London");
  const base = { closesAt, alreadyRegisteredThisSeason: false, squadSize: 5, maxSquadSize: 15 };

  it("ends at midnight London time, DST-aware", () => {
    expect(closesAt.toISOString()).toBe("2027-01-31T23:59:59.999Z");
    expect(endOfDayInZone("2026-09-02", "Europe/London").toISOString()).toBe("2026-09-02T22:59:59.999Z");
  });

  it("lets team admins register before the cut-off", () => {
    expect(canRegisterPlayer({ ...base, now: new Date("2027-01-31T22:00:00Z"), actingAs: "TEAM_ADMIN" })).toEqual({ ok: true, override: false });
  });

  it("blocks team admins after the cut-off", () => {
    expect(canRegisterPlayer({ ...base, now: new Date("2027-02-01T00:00:00Z"), actingAs: "TEAM_ADMIN" })).toMatchObject({
      ok: false,
      code: "DEADLINE_PASSED",
    });
  });

  it("lets league admins override, flagged as an override", () => {
    expect(canRegisterPlayer({ ...base, now: new Date("2027-02-10T12:00:00Z"), actingAs: "LEAGUE_ADMIN" })).toEqual({ ok: true, override: true });
  });

  it("blocks double registration and full squads", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    expect(canRegisterPlayer({ ...base, now, actingAs: "LEAGUE_ADMIN", alreadyRegisteredThisSeason: true })).toMatchObject({ ok: false });
    expect(canRegisterPlayer({ ...base, now, actingAs: "TEAM_ADMIN", squadSize: 15 })).toMatchObject({ code: "SQUAD_FULL" });
  });
});

describe("match-day lineup", () => {
  const reg = (id: string, over: Partial<EligibleRegistration> = {}): EligibleRegistration => ({
    registrationId: id,
    playerId: `p-${id}`,
    teamId: "melville",
    registrationStatus: "ACTIVE",
    playerStatus: "ACTIVE",
    registeredAt: new Date("2026-08-01T00:00:00Z"),
    ...over,
  });
  const registrations = new Map(
    [
      reg("1"), reg("2"), reg("3"), reg("4"), reg("5"), reg("6"),
      reg("other", { teamId: "red-lion" }),
      reg("inactive", { playerStatus: "INACTIVE" }),
      reg("suspended", { playerStatus: "SUSPENDED" }),
      reg("late", { registeredAt: new Date("2026-12-01T00:00:00Z") }),
    ].map((r) => [r.registrationId, r]),
  );
  const lineup = (ids: (string | null)[], kinds: GameKind[] = Array(7).fill("SINGLES")) => ({
    teamId: "melville",
    fixtureStartsAt: new Date("2026-10-07T19:30:00Z"),
    slotKinds: kinds,
    maxSinglesPerPlayer: 1,
    maxPairsPerPlayer: 1,
    slots: ids.map((id, i) => ({ gameOrdinal: i + 1, registrationIds: id === null ? [] : id.split("+") })),
    registrations,
  });
  const SIX_AND_PAIRS: GameKind[] = [...Array(6).fill("SINGLES"), "PAIRS"];

  it("accepts six players and an empty slot (walkover)", () => {
    expect(validateLineup(lineup(["1", "2", "3", "4", "5", "6", null]))).toEqual([]);
  });

  it("rejects other-team, inactive, suspended, late and unknown players", () => {
    const codes = validateLineup(lineup(["other", "inactive", "suspended", "late", "ghost", "1", "2"])).map((p) => p.code);
    expect(codes).toEqual(["OTHER_TEAM", "PLAYER_NOT_ACTIVE", "PLAYER_NOT_ACTIVE", "REGISTERED_AFTER_FIXTURE", "UNKNOWN_PLAYER"]);
  });

  it("enforces games per player and slot count", () => {
    expect(validateLineup(lineup(["1", "1", "3", "4", "5", "6", null])).map((p) => p.code)).toEqual(["TOO_MANY_GAMES"]);
    expect(validateLineup(lineup(["1", "2"])).map((p) => p.code)).toEqual(["WRONG_SLOT_COUNT"]);
  });

  it("takes two players for a pairs game, who may also play singles", () => {
    expect(validateLineup(lineup(["1", "2", "3", "4", "5", "6", "1+2"], SIX_AND_PAIRS))).toEqual([]);
    expect(validateLineup(lineup(["1", "2", "3", "4", "5", "6", null], SIX_AND_PAIRS))).toEqual([]); // walkover
  });

  it("rejects incomplete or repeated pairs, and pairs limits are separate from singles", () => {
    const code = (ids: (string | null)[], kinds = SIX_AND_PAIRS) => validateLineup(lineup(ids, kinds)).map((p) => p.code);
    expect(code(["1", "2", "3", "4", "5", "6", "1"])).toEqual(["WRONG_PLAYER_COUNT"]);
    expect(code(["1", "2", "3", "4", "5", "6", "1+1"])).toEqual(["SAME_PLAYER_TWICE"]);
    expect(code(["1+2", "3", "4"], ["PAIRS", "SINGLES", "PAIRS"])).toEqual(["WRONG_PLAYER_COUNT"]);
    expect(code(["1+2", "3", "1+4"], ["PAIRS", "SINGLES", "PAIRS"])).toEqual(["TOO_MANY_GAMES"]);
    expect(code(["1+other", "3", "4"], ["PAIRS", "SINGLES", "SINGLES"])).toEqual(["OTHER_TEAM"]);
  });
});

describe("permissions", () => {
  const actor = (over: Partial<Actor> = {}): Actor => ({
    userId: "u",
    isPlatformAdmin: false,
    leagueAdminOf: new Set(),
    teamAdminOf: new Set(),
    ...over,
  });
  const leagueAdminA = actor({ leagueAdminOf: new Set(["A"]) });
  const melvilleAdmin = actor({ teamAdminOf: new Set(["melville"]) });
  const redLionAdmin = actor({ teamAdminOf: new Set(["red-lion"]) });
  const fixture = { homeTeamId: "melville", awayTeamId: "red-lion" };

  it("keeps league admins inside their own league", () => {
    expect(can(leagueAdminA, { action: "league.configure", leagueId: "A" })).toBe(true);
    expect(can(leagueAdminA, { action: "league.configure", leagueId: "B" })).toBe(false);
    expect(can(leagueAdminA, { action: "result.correct", leagueId: "B" })).toBe(false);
  });

  it("keeps team admins to their own team", () => {
    expect(can(melvilleAdmin, { action: "player.register", leagueId: "A", teamId: "melville" })).toBe(true);
    expect(can(melvilleAdmin, { action: "player.register", leagueId: "A", teamId: "red-lion" })).toBe(false);
    expect(can(melvilleAdmin, { action: "lineup.set", leagueId: "A", teamId: "red-lion", fixture })).toBe(false);
    expect(can(melvilleAdmin, { action: "league.configure", leagueId: "A" })).toBe(false);
  });

  it("never lets anyone delete a player", () => {
    for (const a of [melvilleAdmin, leagueAdminA, actor({ isPlatformAdmin: true })]) {
      expect(can(a, { action: "player.delete", leagueId: "A" })).toBe(false);
    }
  });

  it("only the responsible side's admins can submit scores", () => {
    const homeScores = { ...fixture, responsibleSide: "HOME" as const };
    expect(can(melvilleAdmin, { action: "scoring.submit", leagueId: "A", fixture: homeScores })).toBe(true);
    expect(can(redLionAdmin, { action: "scoring.submit", leagueId: "A", fixture: homeScores })).toBe(false);
    expect(can(redLionAdmin, { action: "scoring.submit", leagueId: "A", fixture: { ...fixture, responsibleSide: "AWAY" } })).toBe(true);
    expect(can(leagueAdminA, { action: "scoring.submit", leagueId: "A", fixture: homeScores })).toBe(true);
  });

  it("only the other team responds to a rearrangement", () => {
    const req = { leagueId: "A", fixture, requestedByTeamId: "melville" };
    expect(can(redLionAdmin, { action: "rearrangement.respond", teamId: "red-lion", ...req })).toBe(true);
    expect(can(melvilleAdmin, { action: "rearrangement.respond", teamId: "melville", ...req })).toBe(false);
    expect(can(actor({ teamAdminOf: new Set(["crown"]) }), { action: "rearrangement.respond", teamId: "crown", ...req })).toBe(false);
  });

  it("public users can only view", () => {
    expect(can(null, { action: "public.view" })).toBe(true);
    expect(can(null, { action: "player.register", leagueId: "A", teamId: "melville" })).toBe(false);
  });
});
