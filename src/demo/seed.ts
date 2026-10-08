import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { Db } from "@/db/client";
import { competitions, cupRounds, fixtures, gamePlayers, games, leagues, playerRegistrations, teamEntries, teamMemberships } from "@/db/schema";
import { addDays, localDateInZone, zonedTimeToUtc } from "@/domain/dates";
import { RULE_TEMPLATES, gameConfigFor } from "@/domain/rules";
import { mulberry32 } from "@/domain/scheduling";
import { startingSideForLeg, type Side } from "@/domain/scoring";
import { createAccount } from "@/server/auth-service";
import { loadActor, loadFixtureContext } from "@/server/context";
import { createCup, makeDraw, setCupRoundDate, setCupSeeds } from "@/server/cup-service";
import { postponeFixture, rescheduleFixture } from "@/server/fixture-admin-service";
import { completeFixture, recordVisit, setFirstThrower, setLineup, startFixture } from "@/server/match-service";
import { requestRearrangement } from "@/server/rearrangement-service";
import { registerPlayer } from "@/server/registration-service";
import { addBlackoutDate, createConstraint, publishSchedule } from "@/server/schedule-service";
import {
  addTeamToCompetition,
  createDivision,
  createLeague,
  createLeagueCompetition,
  createSeason,
  createTeam,
  createVenue,
  updateSeason,
} from "@/server/setup-service";
import { simulateLeg, type Rng, type Thrower } from "./simulate";

/**
 * Demo data: the Manchester Darts League, 2026/27 (ARCHITECTURE §11, phase 8).
 * Built entirely through the application's services — the same permission
 * checks, rules, audit log and notifications as real use — and played visit
 * by visit with the darts simulator, so every table, average and bracket is
 * genuine. Deterministic for a given `seed` and `now`.
 *
 * Every name is invented. Pubs are generic pub names placed in Manchester
 * districts, not real businesses.
 */

export interface SeedOptions {
  /** "Today": fixtures before this are played, one is left live. */
  now?: Date;
  seed?: number;
  /** Password for every demo account; random if omitted. */
  password?: string;
  /** Play at most this many match nights (for fast tests). */
  maxNights?: number;
  log?: (msg: string) => void;
}

export interface SeedResult {
  leagueSlug: string;
  accounts: { role: string; name: string; email: string; password: string }[];
  played: number;
  visits: number;
}

const DIV1 = ["Crown & Anchor", "Red Lion", "Swan", "Bull's Head", "Railway", "Rose & Crown", "White Hart", "Kings Arms"];
const DIV2 = ["Crown & Anchor B", "Red Lion B", "Plough", "Black Horse", "Royal Oak", "George", "Grapes", "Star"];
const AREAS = ["Didsbury", "Chorlton", "Levenshulme", "Prestwich", "Stretford", "Withington", "Ancoats", "Heaton Moor", "Fallowfield", "Salford Quays", "Eccles", "Sale", "Urmston", "Gorton"];
const FIRST = ["Gary", "Steve", "Dave", "Paul", "Mark", "Andy", "Lee", "Chris", "Tony", "Phil", "Sean", "Ian", "Kev", "Rob", "Darren", "Jason", "Karen", "Lisa", "Michelle", "Sue", "Jo", "Dawn", "Nicola", "Tracey", "Wayne", "Craig", "Neil", "Carl", "Jamie", "Ryan", "Liam", "Danny", "Becky", "Sam", "Alex", "Jordan"];
const LAST = ["Taylor", "Walsh", "Hughes", "Brennan", "Kelly", "Shaw", "Doyle", "Murphy", "Pearson", "Holt", "Ashworth", "Barlow", "Clegg", "Fletcher", "Hartley", "Lomax", "Nuttall", "Ogden", "Pickering", "Ramsbottom", "Schofield", "Tattersall", "Whittaker", "Yates", "Kenyon", "Haworth", "Greenhalgh", "Entwistle", "Duckworth", "Crompton"];

const SEASON_START = "2026-09-02"; // a Wednesday
const CUP_NIGHTS = ["2026-09-23", "2026-11-25", "2027-02-17", "2027-03-24"]; // last 16, QF, SF, final

export async function seedDemo(db: Db, opts: SeedOptions = {}): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  const rng: Rng = mulberry32(opts.seed ?? 2026);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rng() * xs.length)];
  const log = opts.log ?? (() => {});
  const password = opts.password ?? `demo-${randomBytes(9).toString("base64url")}`;
  const tz = "Europe/London";

  const [existing] = await db.select().from(leagues).where(eq(leagues.slug, "manchester"));
  if (existing) throw new Error('this database already has a league called "manchester"; seed an empty database');

  // --- people -------------------------------------------------------------
  log("Accounts…");
  const mk = (name: string, email: string, platformAdmin = false) => createAccount(db, { name, email, password }, { platformAdmin });
  const platform = await mk("Pat Platform", "admin@demo.darts.test", true);
  const secretary = await mk("Sam Secretary", "secretary@demo.darts.test");
  const redCaptain = await mk("Rob Captain", "redlion@demo.darts.test");
  const swanCaptain = await mk("Sue Captain", "swan@demo.darts.test");
  const platformActor = await loadActor(db, platform.id);

  const league = await createLeague(db, platformActor, { name: "Manchester Darts League", slug: "manchester", timezone: tz, firstAdminUserId: secretary.id });
  const sec = await loadActor(db, secretary.id);

  // --- structure ----------------------------------------------------------
  log("League structure…");
  const season = await createSeason(db, sec, league.id, { name: "2026/27", startsOn: SEASON_START, endsOn: "2027-05-26", registrationDeadline: "2027-01-31", maxSquadSize: 12 });
  const div1 = await createDivision(db, sec, league.id, { name: "Division 1" });
  const div2 = await createDivision(db, sec, league.id, { name: "Division 2" });

  // A and B teams share their pub.
  const pubs = [...new Set([...DIV1, ...DIV2].map((t) => t.replace(/ B$/, "")))];
  const venueOf = new Map<string, string>();
  for (const [i, p] of pubs.entries()) venueOf.set(p, (await createVenue(db, sec, league.id, { name: `The ${p}`, address: AREAS[i % AREAS.length] })).id);
  const teamOf = new Map<string, string>();
  for (const t of [...DIV1, ...DIV2]) teamOf.set(t, (await createTeam(db, sec, league.id, { name: t, venueId: venueOf.get(t.replace(/ B$/, "")) })).id);

  const tpl = (key: string) => RULE_TEMPLATES.find((t) => t.key === key)!.rules;
  const comp1 = await createLeagueCompetition(db, sec, { seasonId: season.id, divisionId: div1.id, rules: tpl("singles-6-pairs-1"), matchWeekday: 3 });
  const comp2 = await createLeagueCompetition(db, sec, { seasonId: season.id, divisionId: div2.id, rules: tpl("singles-7"), matchWeekday: 3 });
  for (const t of DIV1) await addTeamToCompetition(db, sec, { competitionId: comp1.id, teamId: teamOf.get(t)! });
  for (const t of DIV2) await addTeamToCompetition(db, sec, { competitionId: comp2.id, teamId: teamOf.get(t)! });

  await addBlackoutDate(db, sec, { seasonId: season.id, date: "2026-12-23", kind: "BREAK", reason: "Christmas" });
  await addBlackoutDate(db, sec, { seasonId: season.id, date: "2026-12-30", kind: "BREAK", reason: "New Year" });
  for (const p of ["Crown & Anchor", "Red Lion"]) {
    await createConstraint(db, sec, { seasonId: season.id, name: `The ${p}`, teamIds: [teamOf.get(p)!, teamOf.get(`${p} B`)!], maxHome: 1, venueId: venueOf.get(p) });
  }
  await db.insert(teamMemberships).values([
    { teamId: teamOf.get("Red Lion")!, userId: redCaptain.id, role: "TEAM_ADMIN" },
    { teamId: teamOf.get("Swan")!, userId: swanCaptain.id, role: "TEAM_ADMIN" },
  ]);
  const redActor = await loadActor(db, redCaptain.id);

  // --- squads ---------------------------------------------------------------
  log("Squads…");
  const registeredBefore = zonedTimeToUtc(addDays(SEASON_START, -14), "12:00", tz);
  const skill = new Map<string, number>(); // playerId → 3-dart average
  const used = new Set<string>();
  for (const [i, t] of [...DIV1, ...DIV2].entries()) {
    const strength = i < DIV1.length ? 62 - i * 1.5 : 50 - (i - DIV1.length) * 1.2;
    const size = 8 + Math.floor(rng() * 3);
    for (let n = 0; n < size; n++) {
      let first: string, last: string;
      do {
        first = pick(FIRST);
        last = pick(LAST);
      } while (used.has(`${first} ${last}`));
      used.add(`${first} ${last}`);
      const r = await registerPlayer(db, sec, { seasonId: season.id, teamId: teamOf.get(t)!, player: { firstName: first, lastName: last } }, registeredBefore);
      skill.set(r.playerId, Math.round(Math.max(30, Math.min(85, strength + (rng() - 0.5) * 24))));
    }
  }

  // --- cup (before the league fixtures, so cup nights are kept free) ----------
  log("Manchester Cup…");
  const cup = await createCup(db, sec, { seasonId: season.id, name: "Manchester Cup", rules: tpl("singles-7"), teamIds: [...DIV1, ...DIV2].map((t) => teamOf.get(t)!) });
  const rounds = await db.select().from(cupRounds).where(eq(cupRounds.competitionId, cup.id)).orderBy(asc(cupRounds.ordinal));
  for (const [i, r] of rounds.entries()) await setCupRoundDate(db, sec, { roundId: r.id, date: CUP_NIGHTS[i], kickOff: "19:45" });
  const cupEntries = await db.select().from(teamEntries).where(eq(teamEntries.competitionId, cup.id));
  const seeds: Record<string, number> = {};
  DIV1.slice(0, 4).forEach((t, i) => (seeds[cupEntries.find((e) => e.teamId === teamOf.get(t))!.id] = i + 1));
  await setCupSeeds(db, sec, { competitionId: cup.id, seeds });
  await makeDraw(db, sec, { competitionId: cup.id, mode: "SEEDED", rngSeed: 11 });

  // --- league fixtures ----------------------------------------------------------
  log("Fixtures…");
  await publishSchedule(db, sec, { seasonId: season.id, competitionIds: [comp1.id, comp2.id], startDate: SEASON_START, meetings: 2, kickoff: "19:30", seed: 7, replaceExisting: false, acknowledgeConflicts: true });
  await updateSeason(db, sec, season.id, { name: "2026/27", startsOn: SEASON_START, endsOn: "2027-05-26", registrationDeadline: "2027-01-31", maxSquadSize: 12, status: "ACTIVE" });

  // --- play everything before today ------------------------------------------------
  const seasonComps = (await db.select({ id: competitions.id }).from(competitions).where(eq(competitions.seasonId, season.id))).map((c) => c.id);
  const today = localDateInZone(now, tz);
  const startOfToday = zonedTimeToUtc(today, "00:00", tz);
  let played = 0;
  let visits = 0;
  const nights = new Set<string>();
  for (;;) {
    // Re-query each time: playing cup ties creates the next round's ties.
    const [next] = await db
      .select()
      .from(fixtures)
      .where(and(inArray(fixtures.competitionId, seasonComps), eq(fixtures.status, "SCHEDULED"), isNotNull(fixtures.awayEntryId), lt(fixtures.scheduledAt, startOfToday)))
      .orderBy(asc(fixtures.scheduledAt), asc(fixtures.id))
      .limit(1);
    if (!next) break;
    const night = localDateInZone(next.scheduledAt, tz);
    if (!nights.has(night)) {
      if (opts.maxNights !== undefined && nights.size >= opts.maxNights) break;
      nights.add(night);
      log(`Playing ${night}…`);
    }
    visits += await playFixture(db, sec, next.id, rng, skill);
    played++;
  }

  // --- tonight and the near future --------------------------------------------------
  const upcoming = await db
    .select()
    .from(fixtures)
    .where(and(inArray(fixtures.competitionId, [comp1.id, comp2.id]), eq(fixtures.status, "SCHEDULED"), isNotNull(fixtures.awayEntryId)))
    .orderBy(asc(fixtures.scheduledAt), asc(fixtures.id))
    .limit(6);
  if (upcoming.length >= 3) {
    log("A live match, a postponement and a date-change request…");
    const live = upcoming[0];
    const tonight = zonedTimeToUtc(today, "19:30", tz);
    if (tonight > now) await rescheduleFixture(db, sec, { fixtureId: live.id, scheduledAt: tonight, reason: "Moved to tonight for the demo" }, now);
    visits += await playFixture(db, sec, live.id, rng, skill, { stopAfterGames: 3 });

    await postponeFixture(db, sec, { fixtureId: upcoming[1].id, reason: "The venue is double-booked" });

    // Red Lion ask to move one of their own matches by a week.
    const redEntries = (await db.select().from(teamEntries).where(eq(teamEntries.teamId, teamOf.get("Red Lion")!))).map((e) => e.id);
    const theirs = await db
      .select()
      .from(fixtures)
      .where(and(eq(fixtures.status, "SCHEDULED"), inArray(fixtures.homeEntryId, redEntries)))
      .orderBy(asc(fixtures.scheduledAt))
      .limit(1);
    if (theirs[0] && theirs[0].scheduledAt > now) {
      await requestRearrangement(
        db,
        redActor,
        { fixtureId: theirs[0].id, side: "HOME", proposedAt: new Date(theirs[0].scheduledAt.getTime() + 7 * 864e5), note: "Half the team are at a wedding" },
        now,
      );
    }
  }

  log(`Done: ${played} matches, ${visits} visits.`);
  return {
    leagueSlug: league.slug,
    played,
    visits,
    accounts: [
      { role: "Platform admin", name: platform.name, email: platform.email, password },
      { role: "League secretary", name: secretary.name, email: secretary.email, password },
      { role: "Red Lion captain", name: redCaptain.name, email: redCaptain.email, password },
      { role: "Swan captain", name: swanCaptain.name, email: swanCaptain.email, password },
    ],
  };
}

/**
 * Pick both teams, start the match and play it visit by visit through the
 * scoring service, then confirm the result. Returns the number of visits.
 */
async function playFixture(db: Db, actor: Awaited<ReturnType<typeof loadActor>>, fixtureId: string, rng: Rng, skill: Map<string, number>, opts: { stopAfterGames?: number } = {}): Promise<number> {
  const ctx = await loadFixtureContext(db, fixtureId);
  const slots = ctx.rules.match.slots;
  const squad = async (teamId: string) =>
    (
      await db
        .select()
        .from(playerRegistrations)
        .where(and(eq(playerRegistrations.teamId, teamId), eq(playerRegistrations.seasonId, ctx.competition.seasonId), eq(playerRegistrations.status, "ACTIVE")))
    ).map((r) => ({ registrationId: r.id, playerId: r.playerId }));
  const lineupFor = (members: { registrationId: string; playerId: string }[]) => {
    const shuffled = [...members].sort(() => rng() - 0.5);
    const singles = shuffled.slice(0, slots.filter((s) => s.kind === "SINGLES").length);
    const pairsPool = [...members].sort(() => rng() - 0.5);
    let s = 0;
    let p = 0;
    return slots.map((slot, i) => ({
      gameOrdinal: i + 1,
      registrationIds: slot.kind === "SINGLES" ? [singles[s++].registrationId] : [pairsPool[p++].registrationId, pairsPool[p++].registrationId],
    }));
  };
  const home = await squad(ctx.homeTeamId);
  const away = await squad(ctx.awayTeamId);
  if (ctx.fixture.status === "SCHEDULED" && !ctx.fixture.homeLineupConfirmedAt) {
    await setLineup(db, actor, { fixtureId, side: "HOME", slots: lineupFor(home), confirm: true });
    await setLineup(db, actor, { fixtureId, side: "AWAY", slots: lineupFor(away), confirm: true });
  }
  await startFixture(db, actor, fixtureId);

  const byReg = new Map([...home, ...away].map((m) => [m.registrationId, m.playerId]));
  const gameRows = await db.select().from(games).where(eq(games.fixtureId, fixtureId)).orderBy(asc(games.ordinal));
  const lineup = await db.select().from(gamePlayers).where(inArray(gamePlayers.gameId, gameRows.map((g) => g.id)));
  let count = 0;
  let gamesPlayed = 0;
  for (const g of gameRows) {
    if (opts.stopAfterGames !== undefined && gamesPlayed >= opts.stopAfterGames) break;
    const [fresh] = await db.select().from(games).where(eq(games.id, g.id));
    if (fresh.status !== "PENDING") continue; // walkover / not required
    const throwers = (side: Side): Thrower[] =>
      lineup
        .filter((l) => l.gameId === g.id && l.side === side)
        .sort((a, b) => a.position - b.position)
        .map((l) => ({ playerId: byReg.get(l.registrationId) ?? l.playerId, average: skill.get(l.playerId) ?? 45 }));
    const first: Side = rng() < 0.5 ? "HOME" : "AWAY";
    await setFirstThrower(db, actor, { fixtureId, gameOrdinal: g.ordinal, side: first });
    const cfg = gameConfigFor(ctx.rules, g.kind);
    for (let leg = 0; ; leg++) {
      const sim = simulateLeg(rng, { HOME: throwers("HOME"), AWAY: throwers("AWAY") }, startingSideForLeg(first, leg), cfg.startingScore);
      let result;
      for (const v of sim) {
        result = await recordVisit(db, actor, { fixtureId, gameOrdinal: g.ordinal, clientEventId: randomUUID(), side: v.side, scored: v.scored, darts: v.darts, playerId: v.playerId });
        count++;
      }
      if (result?.gameStatus !== "LIVE") break; // game decided
    }
    gamesPlayed++;
  }
  const [after] = await db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  if (opts.stopAfterGames === undefined && after.status === "LIVE") await completeFixture(db, actor, fixtureId);
  return count;
}
