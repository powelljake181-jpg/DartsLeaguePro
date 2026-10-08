import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { competitions, fixtureOutcomes, fixtures, teamEntries } from "@/db/schema";
import { localDateInZone } from "@/domain/dates";
import { periodFor } from "@/domain/rule-periods";
import { computeStandings, type ResultRow, type StandingRow } from "@/domain/standings";
import { leagueTimezone, loadRulePeriods } from "./context";
import { notFound } from "./errors";

export interface Table {
  groupKey: string;
  name: string;
  rows: StandingRow[];
}

/**
 * The league table(s) for a competition — one per result group (e.g. the main
 * table and a separate pairs table) — computed from completed fixture
 * outcomes. Each fixture is scored with the rules in force on its date; the
 * table is ordered with the tie-breakers in force on `asOf`.
 */
export async function getTables(db: Db, competitionId: string, asOf = new Date()): Promise<Table[]> {
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, competitionId));
  if (!competition) throw notFound("competition");
  const tz = await leagueTimezone(db, competition.leagueId);
  const periods = await loadRulePeriods(db, competitionId);
  const current = periodFor(periods, localDateInZone(asOf, tz)).rules;

  const entries = await db.select().from(teamEntries).where(eq(teamEntries.competitionId, competitionId));
  const results = await db
    .select({ fixture: fixtures, outcome: fixtureOutcomes })
    .from(fixtures)
    .innerJoin(fixtureOutcomes, eq(fixtureOutcomes.fixtureId, fixtures.id))
    .where(and(eq(fixtures.competitionId, competitionId), eq(fixtures.status, "COMPLETED")));
  const tableEntries = entries.map((e) => ({ entryId: e.id, name: e.displayName, withdrawn: e.status !== "ACTIVE" }));

  return current.match.groups.map((group) => {
    const rows: ResultRow[] = [];
    for (const { fixture, outcome } of results) {
      if (outcome.groupKey !== group.key || !fixture.awayEntryId) continue;
      const rules = periodFor(periods, localDateInZone(fixture.scheduledAt, tz)).rules;
      const groupThen = rules.match.groups.find((g) => g.key === group.key);
      if (!groupThen) continue;
      rows.push({
        fixtureId: fixture.id,
        homeEntryId: fixture.homeEntryId,
        awayEntryId: fixture.awayEntryId,
        outcome: {
          homeGames: outcome.homeGames,
          awayGames: outcome.awayGames,
          homePointGames: outcome.homePointGames,
          awayPointGames: outcome.awayPointGames,
          homeLegs: outcome.homeLegs,
          awayLegs: outcome.awayLegs,
          winner: outcome.winner,
        },
        points: groupThen.points,
      });
    }
    return { groupKey: group.key, name: group.name, rows: computeStandings(tableEntries, rows, group.tieBreakers) };
  });
}

/** The primary table (the first result group). */
export async function getStandings(db: Db, competitionId: string, asOf = new Date()): Promise<StandingRow[]> {
  const tables = await getTables(db, competitionId, asOf);
  return tables[0].rows;
}
