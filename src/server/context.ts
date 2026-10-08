import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  auditLog,
  competitionRulePeriods,
  competitions,
  fixtures,
  leagueMemberships,
  leagues,
  rulesets,
  teamEntries,
  teamMemberships,
  users,
} from "@/db/schema";
import { localDateInZone } from "@/domain/dates";
import type { Actor } from "@/domain/permissions";
import { periodFor } from "@/domain/rule-periods";
import { parseRules, type LeagueRules } from "@/domain/rules";
import type { Side } from "@/domain/scoring";
import { notFound } from "./errors";

/** Build the acting user's grants from the database. */
export async function loadActor(db: Db, userId: string): Promise<Actor> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw notFound("user");
  const leagueRows = await db
    .select({ leagueId: leagueMemberships.leagueId })
    .from(leagueMemberships)
    .where(and(eq(leagueMemberships.userId, userId), isNull(leagueMemberships.revokedAt)));
  const teamRows = await db
    .select({ teamId: teamMemberships.teamId })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.userId, userId), isNull(teamMemberships.revokedAt)));
  return {
    userId,
    isPlatformAdmin: user.isPlatformAdmin,
    leagueAdminOf: new Set(leagueRows.map((r) => r.leagueId)),
    teamAdminOf: new Set(teamRows.map((r) => r.teamId)),
  };
}

export async function loadRules(db: Db, rulesetId: string): Promise<LeagueRules> {
  const [row] = await db.select().from(rulesets).where(eq(rulesets.id, rulesetId));
  if (!row) throw notFound("ruleset");
  return parseRules(row.config);
}

export interface LoadedPeriod {
  id: string;
  effectiveFrom: string;
  rulesetId: string;
  rules: LeagueRules;
}

/** A competition's rules timeline, oldest first. */
export async function loadRulePeriods(db: Db, competitionId: string): Promise<LoadedPeriod[]> {
  const rows = await db
    .select({ period: competitionRulePeriods, config: rulesets.config })
    .from(competitionRulePeriods)
    .innerJoin(rulesets, eq(rulesets.id, competitionRulePeriods.rulesetId))
    .where(eq(competitionRulePeriods.competitionId, competitionId));
  if (rows.length === 0) throw notFound("rules for competition");
  return rows
    .map(({ period, config }) => ({
      id: period.id,
      effectiveFrom: period.effectiveFrom,
      rulesetId: period.rulesetId,
      rules: parseRules(config),
    }))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

export async function leagueTimezone(db: Db, leagueId: string): Promise<string> {
  const [league] = await db.select({ tz: leagues.timezone }).from(leagues).where(eq(leagues.id, leagueId));
  if (!league) throw notFound("league");
  return league.tz;
}

/** The rules in force for a competition on a league-local date. */
export async function rulesOn(db: Db, competitionId: string, date: string): Promise<LeagueRules> {
  return periodFor(await loadRulePeriods(db, competitionId), date).rules;
}

export interface FixtureContext {
  fixture: typeof fixtures.$inferSelect;
  competition: typeof competitions.$inferSelect;
  /** The rules in force on the fixture's date. */
  rules: LeagueRules;
  /** The fixture's league-local date (YYYY-MM-DD). */
  fixtureDate: string;
  homeTeamId: string;
  awayTeamId: string;
  /** Who enters the official score: per-fixture override, else the ruleset. */
  responsibleSide: Side;
}

/**
 * Load a fixture with everything needed to authorise and apply a change.
 * `lock` takes a row lock so concurrent writers to one fixture serialise.
 * The league and team ids come from the database, never from the request.
 */
export async function loadFixtureContext(db: Db, fixtureId: string, opts: { lock?: boolean } = {}): Promise<FixtureContext> {
  const q = db.select().from(fixtures).where(eq(fixtures.id, fixtureId));
  const [fixture] = opts.lock ? await q.for("update") : await q;
  if (!fixture) throw notFound("fixture");
  const [competition] = await db.select().from(competitions).where(eq(competitions.id, fixture.competitionId));
  const entries = await db
    .select({ id: teamEntries.id, teamId: teamEntries.teamId })
    .from(teamEntries)
    .where(eq(teamEntries.competitionId, fixture.competitionId));
  const teamOf = (entryId: string | null) => entries.find((e) => e.id === entryId)?.teamId ?? "";
  const fixtureDate = localDateInZone(fixture.scheduledAt, await leagueTimezone(db, fixture.leagueId));
  const rules = await rulesOn(db, competition.id, fixtureDate);
  return {
    fixture,
    competition,
    rules,
    fixtureDate,
    homeTeamId: teamOf(fixture.homeEntryId),
    awayTeamId: teamOf(fixture.awayEntryId),
    responsibleSide: fixture.responsibleSide ?? rules.scoring.responsibleSide,
  };
}

export interface AuditEntry {
  leagueId: string | null;
  actor: Actor | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    leagueId: e.leagueId,
    actorUserId: e.actor?.userId ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    before: e.before ?? null,
    after: e.after ?? null,
    reason: e.reason ?? null,
  });
}
