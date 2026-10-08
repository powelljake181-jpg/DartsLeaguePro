import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { fixtures, gamePlayers, games, leagues, teamEntries } from "@/db/schema";
import { localDateInZone } from "@/domain/dates";
import type { FixturePayload } from "@/domain/notifications";
import { structuralChanges } from "@/domain/rule-periods";
import type { FixtureContext } from "./context";
import { rulesOn } from "./context";
import { AppError } from "./errors";

/** Names, league slug and timezone for a fixture, as notifications and audit entries need them. */
export async function fixtureInfo(db: Db, ctx: FixtureContext): Promise<FixturePayload & { leagueId: string }> {
  const [league] = await db.select().from(leagues).where(eq(leagues.id, ctx.fixture.leagueId));
  const ids = [ctx.fixture.homeEntryId, ...(ctx.fixture.awayEntryId ? [ctx.fixture.awayEntryId] : [])];
  const entries = await db.select().from(teamEntries).where(inArray(teamEntries.id, ids));
  const name = (id: string | null) => entries.find((e) => e.id === id)?.displayName ?? "Bye";
  return {
    leagueId: league.id,
    fixtureId: ctx.fixture.id,
    leagueSlug: league.slug,
    home: name(ctx.fixture.homeEntryId),
    away: name(ctx.fixture.awayEntryId),
    tz: league.timezone,
  };
}

/**
 * Move a fixture to a new time. If the new date falls under rules with a
 * different match format, lineups entered for the old format are cleared (they
 * must be re-entered); a match that has already started cannot move into a
 * different format at all. Returns whether lineups were cleared. The caller
 * sets the status and bumps the version.
 */
export async function moveFixtureDate(db: Db, ctx: FixtureContext, at: Date): Promise<{ lineupsReset: boolean }> {
  const [league] = await db.select({ tz: leagues.timezone }).from(leagues).where(eq(leagues.id, ctx.fixture.leagueId));
  const newRules = await rulesOn(db, ctx.competition.id, localDateInZone(at, league.tz));
  const changes = structuralChanges(ctx.rules, newRules);
  let lineupsReset = false;
  if (changes.length) {
    const gameRows = await db.select().from(games).where(eq(games.fixtureId, ctx.fixture.id));
    if (ctx.fixture.startedAt || gameRows.some((g) => g.status !== "PENDING")) {
      throw new AppError("FORMAT_CHANGES", `that date is played under different rules (${changes.join(", ")}) and this match has already started`);
    }
    if (gameRows.length) {
      const ids = gameRows.map((g) => g.id);
      await db.delete(gamePlayers).where(inArray(gamePlayers.gameId, ids));
      await db.delete(games).where(and(eq(games.fixtureId, ctx.fixture.id), inArray(games.id, ids)));
      await db.update(fixtures).set({ homeLineupConfirmedAt: null, awayLineupConfirmedAt: null }).where(eq(fixtures.id, ctx.fixture.id));
      lineupsReset = true;
    }
  }
  await db.update(fixtures).set({ scheduledAt: at }).where(eq(fixtures.id, ctx.fixture.id));
  return { lineupsReset };
}
