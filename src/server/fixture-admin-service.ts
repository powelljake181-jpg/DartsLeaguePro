import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { fixtureOutcomes, foldEvents, games } from "@/db/schema";
import { transition, type FixtureStatus } from "@/domain/fixture-state";
import { awardedOutcomes } from "@/domain/match";
import type { FixturePayload, NotificationEvent } from "@/domain/notifications";
import { assertCan, type Actor } from "@/domain/permissions";
import type { Side } from "@/domain/scoring";
import { audit, loadFixtureContext, type FixtureContext } from "./context";
import { AppError } from "./errors";
import { fixtureInfo, moveFixtureDate } from "./fixture-ops";
import { afterResultChange } from "./cup-service";
import { bumpVersion, writeOutcome } from "./match-service";
import { notify } from "./notification-service";
import { overridePendingRearrangement } from "./rearrangement-service";

/**
 * League-admin changes to a single fixture outside the normal flow. Each one
 * is a state-machine transition, closes any pending rearrangement request
 * (as OVERRIDDEN), is audit-logged with a reason, and tells both teams.
 * Fixtures changed by a team fold can only be changed back by reverting the fold.
 */

type Info = FixturePayload & { reason: string };
interface Change {
  action: string;
  after: Record<string, unknown>;
  event: (info: Info) => NotificationEvent;
}

async function adminChange(db: Db, actor: Actor, fixtureId: string, reason: string, apply: (tx: Db, ctx: FixtureContext) => Promise<Change>): Promise<void> {
  const why = reason.trim().slice(0, 500);
  if (!why) throw new AppError("REASON_REQUIRED", "give a reason; both teams will see it");
  await db.transaction(async (tx) => {
    const ctx = await loadFixtureContext(tx, fixtureId, { lock: true });
    assertCan(actor, { action: "result.correct", leagueId: ctx.fixture.leagueId });
    if (ctx.fixture.foldEventId) {
      const [fold] = await tx.select().from(foldEvents).where(eq(foldEvents.id, ctx.fixture.foldEventId));
      if (fold && !fold.revertedAt) throw new AppError("FOLDED", "this fixture was changed by a team fold; revert the fold instead");
    }
    const overridden = await overridePendingRearrangement(tx, actor, fixtureId, why);
    const change = await apply(tx, ctx);
    await afterResultChange(tx, fixtureId, actor);
    const info = await fixtureInfo(tx, ctx);
    await audit(tx, {
      leagueId: ctx.fixture.leagueId,
      actor,
      action: change.action,
      entityType: "fixture",
      entityId: fixtureId,
      before: { status: ctx.fixture.status, scheduledAt: ctx.fixture.scheduledAt },
      after: { ...change.after, rearrangementOverridden: overridden },
      reason: why,
    });
    await notify(tx, {
      leagueId: info.leagueId,
      actor,
      to: { leagueAdmins: true, teamIds: [ctx.homeTeamId, ctx.awayTeamId].filter(Boolean) },
      event: change.event({ ...info, reason: why }),
    });
  });
}

/** Status a pending request would have returned the fixture to (a request on a postponed fixture keeps it postponed). */
const unrequested = (s: FixtureStatus): FixtureStatus => (s === "REARRANGEMENT_REQUESTED" ? "SCHEDULED" : s);

export async function postponeFixture(db: Db, actor: Actor, input: { fixtureId: string; reason: string }) {
  await adminChange(db, actor, input.fixtureId, input.reason, async (tx, ctx) => {
    const status = transition(ctx.fixture.status, "POSTPONE");
    await bumpVersion(tx, ctx.fixture.id, { status });
    return { action: "fixture.postponed", after: { status }, event: (p) => ({ type: "fixture.postponed", payload: p }) };
  });
}

/** Set a new date. Works for scheduled, postponed and requested fixtures (the request is overridden). */
export async function rescheduleFixture(db: Db, actor: Actor, input: { fixtureId: string; scheduledAt: Date; reason: string }, now = new Date()) {
  let lineupsReset = false;
  await adminChange(db, actor, input.fixtureId, input.reason, async (tx, ctx) => {
    if (input.scheduledAt <= now) throw new AppError("PROPOSED_IN_PAST", "choose a date and time in the future");
    const status = transition(unrequested(ctx.fixture.status), "RESCHEDULE");
    ({ lineupsReset } = await moveFixtureDate(tx, ctx, input.scheduledAt));
    await bumpVersion(tx, ctx.fixture.id, { status });
    return {
      action: "fixture.rescheduled",
      after: { status, scheduledAt: input.scheduledAt, lineupsReset },
      event: (p) => ({ type: "fixture.rescheduled", payload: { ...p, scheduledAt: input.scheduledAt.toISOString() } }),
    };
  });
  return { lineupsReset };
}

export async function cancelFixture(db: Db, actor: Actor, input: { fixtureId: string; reason: string }) {
  await adminChange(db, actor, input.fixtureId, input.reason, async (tx, ctx) => {
    const status = transition(ctx.fixture.status, "CANCEL");
    await bumpVersion(tx, ctx.fixture.id, { status });
    return { action: "fixture.cancelled", after: { status }, event: (p) => ({ type: "fixture.cancelled", payload: p }) };
  });
}

/**
 * Bring back a cancelled or void fixture: to COMPLETED if it has an official
 * result, POSTPONED if play had started (games resume where they stopped),
 * otherwise SCHEDULED.
 */
export async function restoreFixture(db: Db, actor: Actor, input: { fixtureId: string; reason: string }) {
  await adminChange(db, actor, input.fixtureId, input.reason, async (tx, ctx) => {
    const outcomes = await tx.select().from(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, ctx.fixture.id));
    const restoreTo: FixtureStatus = outcomes.length ? "COMPLETED" : ctx.fixture.startedAt ? "POSTPONED" : "SCHEDULED";
    const status = transition(ctx.fixture.status, "RESTORE", { restoreTo });
    await bumpVersion(tx, ctx.fixture.id, { status, voidReason: null, keepStatsWhenVoid: false });
    return { action: "fixture.restored", after: { status }, event: (p) => ({ type: "fixture.restored", payload: p }) };
  });
}

/**
 * Award the result without (further) play, e.g. a no-show: every game in every
 * result group goes to the winner. Games already played keep their statistics.
 */
export async function awardFixture(db: Db, actor: Actor, input: { fixtureId: string; winner: Side; reason: string }) {
  await adminChange(db, actor, input.fixtureId, input.reason, async (tx, ctx) => {
    if (!ctx.fixture.awayEntryId) throw new AppError("BYE", "a bye has no result to award");
    const status = transition(ctx.fixture.status, "AWARD");
    const outcomes = awardedOutcomes(input.winner, ctx.rules);
    await tx.delete(fixtureOutcomes).where(eq(fixtureOutcomes.fixtureId, ctx.fixture.id));
    for (const [groupKey, o] of Object.entries(outcomes)) await writeOutcome(tx, ctx.fixture.id, groupKey, o, "ADMIN", actor);
    await bumpVersion(tx, ctx.fixture.id, { status, completedAt: new Date() });
    const info = await fixtureInfo(tx, ctx);
    const winner = input.winner === "HOME" ? info.home : info.away;
    return { action: "fixture.awarded", after: { status, winner: input.winner, outcomes }, event: (p) => ({ type: "fixture.awarded", payload: { ...p, winner } }) };
  });
}

/**
 * Stop a live match (pub closed, power cut…). Games finished so far are kept;
 * the fixture is postponed and, once rescheduled, play resumes where it
 * stopped with the same lineups. To replay from scratch, void it instead and
 * agree a new fixture; to settle it, award it.
 */
export async function abandonFixture(db: Db, actor: Actor, input: { fixtureId: string; reason: string }) {
  await adminChange(db, actor, input.fixtureId, input.reason, async (tx, ctx) => {
    const status = transition(ctx.fixture.status, "ABANDON");
    const played = (await tx.select().from(games).where(eq(games.fixtureId, ctx.fixture.id))).filter((g) => g.status === "COMPLETED" || g.status === "WALKOVER").length;
    await bumpVersion(tx, ctx.fixture.id, { status });
    return { action: "fixture.abandoned", after: { status, gamesKept: played }, event: (p) => ({ type: "fixture.abandoned", payload: p }) };
  });
}
