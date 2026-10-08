import { randomUUID } from "node:crypto";
import type { Db } from "@/db/client";
import {
  competitionRulePeriods,
  competitions,
  divisions,
  fixtures,
  leagueMemberships,
  leagues,
  playerRegistrations,
  players,
  rulesets,
  seasons,
  teamEntries,
  teamMemberships,
  teams,
  users,
  venues,
} from "@/db/schema";
import { endOfDayInZone } from "@/domain/dates";
import { defineRules, singles, type LeagueRules } from "@/domain/rules";
import type { Actor } from "@/domain/permissions";
import type { Side } from "@/domain/scoring";
import { loadActor } from "../context";
import { recordVisit } from "../match-service";

/** Manchester Division 1 rules: 7 games all played, no draws, 7 per win + 1 per game won. */
export const DIV1_RULES = defineRules({
  match: {
    slots: singles(7),
    groups: [
      {
        key: "main",
        name: "League",
        format: "FIXED",
        allowDraw: false,
        deadRubbers: "SKIP",
        points: { win: 7, draw: 0, loss: 0, perGameWon: 1 },
        tieBreakers: ["POINTS", "GAME_DIFFERENCE", "GAMES_WON", "HEAD_TO_HEAD"],
      },
    ],
  },
});

const TEAM_NAMES = ["Melville", "Red Lion", "Crown", "Swan"] as const;
type TeamName = (typeof TEAM_NAMES)[number];

/**
 * A small but realistic league for service tests: one division of four teams,
 * Red Lion short of a seventh player, two fixtures on the opening night, and
 * a second league to prove tenant isolation.
 */
export async function buildScenario(db: Db, opts: { rules?: LeagueRules } = {}) {
  const rules = opts.rules ?? DIV1_RULES;
  const u = (id: string, isPlatformAdmin = false) => ({ id, email: `${id}@example.test`, name: id, isPlatformAdmin });
  await db.insert(users).values([
    u("platform", true),
    u("secretary"),
    u("melville-captain"),
    u("redlion-captain"),
    u("crown-captain"),
    u("other-secretary"),
  ]);

  const [league, otherLeague] = await db
    .insert(leagues)
    .values([
      { slug: "manchester", name: "Manchester Darts League" },
      { slug: "salford", name: "Salford Darts League" },
    ])
    .returning();
  await db.insert(leagueMemberships).values([
    { leagueId: league.id, userId: "secretary", role: "LEAGUE_ADMIN" },
    { leagueId: otherLeague.id, userId: "other-secretary", role: "LEAGUE_ADMIN" },
  ]);

  const [ruleset] = await db.insert(rulesets).values({ leagueId: league.id, name: "Division 1", config: rules }).returning();
  const [season] = await db
    .insert(seasons)
    .values({
      leagueId: league.id,
      name: "2026/27",
      startsOn: "2026-09-02",
      status: "ACTIVE",
      registrationClosesAt: endOfDayInZone("2027-01-31", "Europe/London"),
      maxSquadSize: 15,
    })
    .returning();
  const [division] = await db.insert(divisions).values({ leagueId: league.id, name: "Division 1", rank: 1 }).returning();
  const [competition] = await db
    .insert(competitions)
    .values({
      leagueId: league.id,
      seasonId: season.id,
      kind: "LEAGUE",
      divisionId: division.id,
      name: "Division 1",
      matchWeekday: 3,
    })
    .returning();
  await db.insert(competitionRulePeriods).values({ competitionId: competition.id, rulesetId: ruleset.id, effectiveFrom: season.startsOn });

  const team = {} as Record<TeamName, { teamId: string; entryId: string; registrationIds: string[]; playerIds: string[] }>;
  for (const name of TEAM_NAMES) {
    const [venue] = await db.insert(venues).values({ leagueId: league.id, name }).returning();
    const [t] = await db
      .insert(teams)
      .values({ leagueId: league.id, name, slug: name.toLowerCase().replace(/ /g, "-"), homeVenueId: venue.id })
      .returning();
    const [entry] = await db
      .insert(teamEntries)
      .values({ competitionId: competition.id, teamId: t.id, displayName: name, venueId: venue.id })
      .returning();
    const squad = name === "Red Lion" ? 6 : 7;
    const ps = await db
      .insert(players)
      .values(Array.from({ length: squad }, (_, i) => ({ leagueId: league.id, firstName: `${name}`, lastName: `Player ${i + 1}` })))
      .returning();
    const regs = await db
      .insert(playerRegistrations)
      .values(
        ps.map((p) => ({
          leagueId: league.id,
          playerId: p.id,
          teamId: t.id,
          seasonId: season.id,
          registeredAt: new Date("2026-08-01T12:00:00Z"),
        })),
      )
      .returning();
    team[name] = { teamId: t.id, entryId: entry.id, registrationIds: regs.map((r) => r.id), playerIds: ps.map((p) => p.id) };
  }
  await db.insert(teamMemberships).values([
    { teamId: team.Melville.teamId, userId: "melville-captain", role: "TEAM_ADMIN" },
    { teamId: team["Red Lion"].teamId, userId: "redlion-captain", role: "TEAM_ADMIN" },
    { teamId: team.Crown.teamId, userId: "crown-captain", role: "TEAM_ADMIN" },
  ]);

  const fixture = async (home: TeamName, away: TeamName, at: string) =>
    (
      await db
        .insert(fixtures)
        .values({
          leagueId: league.id,
          competitionId: competition.id,
          homeEntryId: team[home].entryId,
          awayEntryId: team[away].entryId,
          scheduledAt: new Date(at),
          roundNumber: 1,
        })
        .returning()
    )[0];

  const melvilleVRedLion = await fixture("Melville", "Red Lion", "2026-09-02T18:30:00Z");
  const crownVSwan = await fixture("Crown", "Swan", "2026-10-14T18:30:00Z");

  return {
    league,
    otherLeague,
    season,
    competition,
    rules,
    team,
    fixtures: { melvilleVRedLion, crownVSwan },
    actors: {
      platform: await loadActor(db, "platform"),
      secretary: await loadActor(db, "secretary"),
      melville: await loadActor(db, "melville-captain"),
      redLion: await loadActor(db, "redlion-captain"),
      crown: await loadActor(db, "crown-captain"),
      otherSecretary: await loadActor(db, "other-secretary"),
    },
  };
}

export type Scenario = Awaited<ReturnType<typeof buildScenario>>;

/**
 * Play a single-leg 501 game through the scoring service (home team scores).
 * The winner checks out in exactly 18 darts (100, 100, 100, 100, 60, 41);
 * the loser scores 60 per visit. For pairs, pass each side's two players:
 * partners alternate visits.
 */
export async function playGame(
  db: Db,
  s: Scenario,
  fixtureId: string,
  ordinal: number,
  winner: Side,
  opts: { pairs?: Record<Side, [string, string]>; actor?: Actor } = {},
) {
  const actor = opts.actor ?? s.actors.melville;
  const winnerScores = [100, 100, 100, 100, 60];
  const thrown = { HOME: 0, AWAY: 0 };
  let w = 0;
  for (let turn = 0; ; turn++) {
    const side: Side = turn % 2 === 0 ? "HOME" : "AWAY";
    const playerId = opts.pairs?.[side][thrown[side]++ % 2];
    const visit = (scored: number, darts?: number) =>
      recordVisit(db, actor, { fixtureId, gameOrdinal: ordinal, clientEventId: randomUUID(), side, scored, darts, playerId });
    if (side !== winner) await visit(60);
    else if (w < winnerScores.length) await visit(winnerScores[w++]);
    else return visit(41, 3);
  }
}
