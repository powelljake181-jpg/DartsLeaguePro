import type { Side } from "./scoring";

/**
 * Role-based access control. `can` is pure: callers must resolve the
 * resource's league/team ids from the database (never from request input)
 * and pass them in. See docs/ARCHITECTURE.md §3.
 */

export interface Actor {
  userId: string;
  isPlatformAdmin: boolean;
  /** League ids where the user is a league admin. */
  leagueAdminOf: ReadonlySet<string>;
  /** Team ids where the user is a team admin. */
  teamAdminOf: ReadonlySet<string>;
}

export const PUBLIC: Actor | null = null;

export type Permission =
  | { action: "league.create" }
  | { action: "league.configure"; leagueId: string } // settings, rules, seasons, divisions, venues, teams, fixtures, cups
  | { action: "result.correct"; leagueId: string } // corrections, voids, folds, awards
  | { action: "player.register"; leagueId: string; teamId: string }
  | { action: "player.setStatus"; leagueId: string }
  | { action: "player.delete"; leagueId: string }
  | { action: "team.manage"; leagueId: string; teamId: string }
  | { action: "lineup.set"; leagueId: string; teamId: string; fixture: FixtureSides }
  | { action: "scoring.submit"; leagueId: string; fixture: FixtureSides & { responsibleSide: Side } }
  | { action: "rearrangement.request"; leagueId: string; teamId: string; fixture: FixtureSides }
  | { action: "rearrangement.respond"; leagueId: string; teamId: string; fixture: FixtureSides; requestedByTeamId: string }
  | { action: "public.view" };

export interface FixtureSides {
  homeTeamId: string;
  awayTeamId: string;
}

const isLeagueAdmin = (a: Actor, leagueId: string) => a.isPlatformAdmin || a.leagueAdminOf.has(leagueId);
const inFixture = (f: FixtureSides, teamId: string) => f.homeTeamId === teamId || f.awayTeamId === teamId;

export function can(actor: Actor | null, p: Permission): boolean {
  if (p.action === "public.view") return true;
  if (!actor) return false;

  switch (p.action) {
    case "league.create":
      return actor.isPlatformAdmin;

    case "league.configure":
    case "result.correct":
    case "player.setStatus":
      return isLeagueAdmin(actor, p.leagueId);

    case "player.delete":
      // Registered players are never deleted; they are archived or anonymised.
      return false;

    case "player.register":
    case "team.manage":
      return isLeagueAdmin(actor, p.leagueId) || actor.teamAdminOf.has(p.teamId);

    case "lineup.set":
      if (isLeagueAdmin(actor, p.leagueId)) return true;
      return inFixture(p.fixture, p.teamId) && actor.teamAdminOf.has(p.teamId);

    case "scoring.submit": {
      if (isLeagueAdmin(actor, p.leagueId)) return true;
      const scorer = p.fixture.responsibleSide === "HOME" ? p.fixture.homeTeamId : p.fixture.awayTeamId;
      return actor.teamAdminOf.has(scorer);
    }

    case "rearrangement.request":
      if (isLeagueAdmin(actor, p.leagueId)) return true;
      return inFixture(p.fixture, p.teamId) && actor.teamAdminOf.has(p.teamId);

    case "rearrangement.respond":
      if (isLeagueAdmin(actor, p.leagueId)) return true;
      // Only the *other* team in the fixture can accept or reject.
      return (
        inFixture(p.fixture, p.teamId) &&
        p.teamId !== p.requestedByTeamId &&
        actor.teamAdminOf.has(p.teamId)
      );
  }
}

export class ForbiddenError extends Error {
  constructor(message = "you do not have permission to do that") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function assertCan(actor: Actor | null, p: Permission): void {
  if (!can(actor, p)) throw new ForbiddenError();
}
