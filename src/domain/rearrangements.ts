/**
 * Rearrangement requests: a team proposes a new date for a fixture and the
 * other team accepts or rejects it. Only one request can be pending per
 * fixture. A proposed date is never refused for clashing with something, but
 * the clashes are shown to both teams (and the league admin) as warnings.
 */

export type RearrangementStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN" | "OVERRIDDEN" | "EXPIRED";

export interface ProposalContext {
  /** League-local date (YYYY-MM-DD) of the proposed new time. */
  proposedDate: string;
  /** Other fixtures (not this one) either team already has on the proposed date. */
  teamClashes: { teamName: string; opponentName: string }[];
  /** Blackout dates covering the proposed date (cup nights, breaks…). */
  blackouts: { reason: string }[];
  /**
   * Shared-venue limits the home team belongs to, with how many of the
   * limit's teams are already at home on that date (excluding this fixture).
   */
  venueLimits: { name: string; maxHomePerDate: number; homeAlready: number }[];
}

export interface RearrangementWarning {
  code: "TEAM_CLASH" | "BLACKOUT" | "VENUE_LIMIT";
  message: string;
}

export function proposalWarnings(c: ProposalContext): RearrangementWarning[] {
  const out: RearrangementWarning[] = [];
  for (const t of c.teamClashes) {
    out.push({ code: "TEAM_CLASH", message: `${t.teamName} already play ${t.opponentName} that night` });
  }
  for (const b of c.blackouts) out.push({ code: "BLACKOUT", message: `no league fixtures are planned that night (${b.reason})` });
  for (const v of c.venueLimits) {
    if (v.homeAlready + 1 > v.maxHomePerDate) {
      out.push({
        code: "VENUE_LIMIT",
        message: `${v.name}: ${v.homeAlready} home ${v.homeAlready === 1 ? "match" : "matches"} already that night (limit ${v.maxHomePerDate})`,
      });
    }
  }
  return out;
}

/**
 * A pending request lapses once the fixture's original time or the proposed
 * time has passed without an answer: the fixture keeps (or goes back to) its
 * original date and the league admin decides.
 */
export const hasExpired = (r: { originalAt: Date; proposedAt: Date }, now: Date): boolean =>
  r.originalAt.getTime() <= now.getTime() || r.proposedAt.getTime() <= now.getTime();
