import type { FixtureStatus } from "./fixture-state";
import type { Side } from "./scoring";

/**
 * Folding a team (it withdraws mid-season). Nothing is subtracted from the
 * table: the fold only changes fixture statuses and writes awarded results,
 * and the table is recomputed from results as always. See ARCHITECTURE §9.
 *
 * - VOID_ALL: every fixture involving the team is voided, played ones included.
 * - MAX_LOSS_REMAINING: unplayed fixtures are awarded to the opponent as a
 *   maximum win; played results stand.
 * - MAX_LOSS_ALL: played results are also replaced by an awarded maximum loss.
 *
 * Player statistics (KEEP / EXCLUDE) apply to every match already played
 * that the fold changes: voided ones, and (MAX_LOSS_ALL) played ones whose
 * result is replaced by an award. KEEP: the darts thrown and each player's own
 * game results still count; EXCLUDE: they are left out of every statistic.
 * Played results that stand (MAX_LOSS_REMAINING) always keep their statistics.
 */

export type FoldResults = "VOID_ALL" | "MAX_LOSS_REMAINING" | "MAX_LOSS_ALL";

export interface FoldFixture {
  id: string;
  status: FixtureStatus;
  /** Which side the folding team is on. */
  side: Side;
  /** A bye (no opponent). */
  bye?: boolean;
}

export type FoldAction = { fixtureId: string; action: "VOID" } | { fixtureId: string; action: "AWARD"; winner: Side } | { fixtureId: string; action: "KEEP" };

export class FoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FoldError";
  }
}

const UNPLAYED: FixtureStatus[] = ["SCHEDULED", "POSTPONED", "REARRANGEMENT_REQUESTED"];

export function planFold(fixtures: FoldFixture[], results: FoldResults): FoldAction[] {
  const live = fixtures.filter((f) => f.status === "LIVE");
  if (live.length) throw new FoldError("one of this team's matches is being played; finish or abandon it first");
  return fixtures.map((f): FoldAction => {
    if (f.status === "VOID" || f.status === "CANCELLED") return { fixtureId: f.id, action: "KEEP" };
    const opponent: Side = f.side === "HOME" ? "AWAY" : "HOME";
    // A cup bye already won stands (the team went through) unless everything is voided.
    if (f.bye) return { fixtureId: f.id, action: f.status === "COMPLETED" && results !== "VOID_ALL" ? "KEEP" : "VOID" };
    if (results === "VOID_ALL") return { fixtureId: f.id, action: "VOID" };
    if (UNPLAYED.includes(f.status)) return { fixtureId: f.id, action: "AWARD", winner: opponent };
    // COMPLETED
    return results === "MAX_LOSS_ALL" ? { fixtureId: f.id, action: "AWARD", winner: opponent } : { fixtureId: f.id, action: "KEEP" };
  });
}
