/**
 * Fixture lifecycle. Every status change goes through `transition`, which
 * rejects anything not listed here. See docs/ARCHITECTURE.md §4.
 */

export const FIXTURE_STATUSES = [
  "SCHEDULED",
  "REARRANGEMENT_REQUESTED",
  "POSTPONED",
  "LIVE",
  "COMPLETED",
  "CANCELLED",
  "VOID",
] as const;
export type FixtureStatus = (typeof FIXTURE_STATUSES)[number];

export type FixtureEvent =
  | "START" // lineups confirmed, scoring begins
  | "FINALISE" // all required games resolved
  | "AWARD" // result awarded without play (fold max-loss, admin)
  | "CORRECT" // admin re-finalises a completed fixture after a correction
  | "ABANDON" // live match stopped (pub closed, etc.)
  | "POSTPONE"
  | "RESCHEDULE"
  | "REQUEST_REARRANGEMENT"
  | "RESOLVE_REARRANGEMENT" // accepted, rejected, withdrawn or overridden
  | "CANCEL"
  | "VOID"
  | "RESTORE"; // undo CANCELLED / VOID (league admin)

export interface TransitionContext {
  /** Both lineups confirmed (required to START). */
  lineupsConfirmed?: boolean;
  /** Every required game resolved (required to FINALISE). */
  allGamesResolved?: boolean;
  /** Status to return to when restoring a cancelled/void fixture, or when a rearrangement request ends without a new date. */
  restoreTo?: FixtureStatus;
}

const TABLE: Record<FixtureEvent, Partial<Record<FixtureStatus, FixtureStatus>>> = {
  START: { SCHEDULED: "LIVE" },
  FINALISE: { LIVE: "COMPLETED" },
  AWARD: { SCHEDULED: "COMPLETED", POSTPONED: "COMPLETED", REARRANGEMENT_REQUESTED: "COMPLETED", LIVE: "COMPLETED" },
  CORRECT: { COMPLETED: "COMPLETED" },
  ABANDON: { LIVE: "POSTPONED" },
  POSTPONE: { SCHEDULED: "POSTPONED", REARRANGEMENT_REQUESTED: "POSTPONED" },
  RESCHEDULE: { POSTPONED: "SCHEDULED", SCHEDULED: "SCHEDULED" },
  REQUEST_REARRANGEMENT: { SCHEDULED: "REARRANGEMENT_REQUESTED", POSTPONED: "REARRANGEMENT_REQUESTED" },
  RESOLVE_REARRANGEMENT: { REARRANGEMENT_REQUESTED: "SCHEDULED" },
  CANCEL: { SCHEDULED: "CANCELLED", POSTPONED: "CANCELLED", REARRANGEMENT_REQUESTED: "CANCELLED", LIVE: "CANCELLED" },
  VOID: {
    SCHEDULED: "VOID",
    POSTPONED: "VOID",
    REARRANGEMENT_REQUESTED: "VOID",
    LIVE: "VOID",
    COMPLETED: "VOID",
    CANCELLED: "VOID",
  },
  RESTORE: {},
};

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

export function transition(from: FixtureStatus, event: FixtureEvent, ctx: TransitionContext = {}): FixtureStatus {
  if (event === "RESTORE") {
    if (from !== "CANCELLED" && from !== "VOID") throw new TransitionError(`cannot restore a ${from} fixture`);
    const to = ctx.restoreTo ?? "SCHEDULED";
    if (to === "LIVE" || to === "CANCELLED" || to === "VOID" || to === "REARRANGEMENT_REQUESTED") {
      throw new TransitionError(`cannot restore to ${to}`);
    }
    return to;
  }
  if (event === "RESOLVE_REARRANGEMENT") {
    if (from !== "REARRANGEMENT_REQUESTED") throw new TransitionError(`cannot resolve a rearrangement on a ${from} fixture`);
    const to = ctx.restoreTo ?? "SCHEDULED";
    if (to !== "SCHEDULED" && to !== "POSTPONED") throw new TransitionError(`cannot resolve a rearrangement to ${to}`);
    return to;
  }
  const to = TABLE[event][from];
  if (!to) throw new TransitionError(`cannot ${event.toLowerCase().replace(/_/g, " ")} a ${from} fixture`);
  if (event === "START" && !ctx.lineupsConfirmed) throw new TransitionError("both lineups must be confirmed first");
  if (event === "FINALISE" && !ctx.allGamesResolved) throw new TransitionError("not all required games are finished");
  return to;
}

/** Only completed fixtures count toward standings. LIVE / VOID / CANCELLED never do. */
export const countsTowardStandings = (s: FixtureStatus): boolean => s === "COMPLETED";
