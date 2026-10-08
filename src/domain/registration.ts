import type { GameKind } from "./rules";

/**
 * Player registration and match-day eligibility rules.
 * These run on the server for every registration and lineup submission.
 */

export type PlayerStatus = "ACTIVE" | "INACTIVE" | "SUSPENDED";
export type RegistrationStatus = "ACTIVE" | "ENDED";

export interface RegistrationPolicyInput {
  now: Date;
  /** Season registration cut-off; null = no deadline. */
  closesAt: Date | null;
  actingAs: "TEAM_ADMIN" | "LEAGUE_ADMIN";
  /** Does the player already hold an active registration in this league-season? */
  alreadyRegisteredThisSeason: boolean;
  squadSize: number;
  maxSquadSize: number | null;
}

export type PolicyResult = { ok: true; override: boolean } | { ok: false; code: string; message: string };

export function canRegisterPlayer(i: RegistrationPolicyInput): PolicyResult {
  if (i.alreadyRegisteredThisSeason) {
    return { ok: false, code: "ALREADY_REGISTERED", message: "player is already registered with a team this season" };
  }
  const pastDeadline = i.closesAt !== null && i.now.getTime() > i.closesAt.getTime();
  const squadFull = i.maxSquadSize !== null && i.squadSize >= i.maxSquadSize;

  if (i.actingAs === "TEAM_ADMIN") {
    if (pastDeadline) {
      return { ok: false, code: "DEADLINE_PASSED", message: "the registration deadline has passed; contact the league" };
    }
    if (squadFull) return { ok: false, code: "SQUAD_FULL", message: `squads are limited to ${i.maxSquadSize} players` };
    return { ok: true, override: false };
  }
  // League admins may register after the deadline or beyond the squad limit; it is recorded as an override.
  return { ok: true, override: pastDeadline || squadFull };
}

// ---------------------------------------------------------------------------
// Match-day lineup
// ---------------------------------------------------------------------------

export interface EligibleRegistration {
  registrationId: string;
  playerId: string;
  teamId: string;
  registrationStatus: RegistrationStatus;
  playerStatus: PlayerStatus;
  registeredAt: Date;
}

export interface LineupSlot {
  gameOrdinal: number;
  /** One registration for singles, two for pairs; empty = no players available → walkover to the opponent. */
  registrationIds: string[];
}

export interface LineupInput {
  teamId: string;
  fixtureStartsAt: Date;
  /** Kind of each game in order, from the rules' match slots. */
  slotKinds: GameKind[];
  maxSinglesPerPlayer: number;
  maxPairsPerPlayer: number;
  slots: LineupSlot[];
  /** Registrations looked up server-side by the ids in `slots` (unknown ids are simply absent). */
  registrations: Map<string, EligibleRegistration>;
}

export interface LineupProblem {
  gameOrdinal: number | null;
  code:
    | "WRONG_SLOT_COUNT"
    | "DUPLICATE_SLOT"
    | "WRONG_PLAYER_COUNT"
    | "SAME_PLAYER_TWICE"
    | "UNKNOWN_PLAYER"
    | "OTHER_TEAM"
    | "REGISTRATION_ENDED"
    | "PLAYER_NOT_ACTIVE"
    | "REGISTERED_AFTER_FIXTURE"
    | "TOO_MANY_GAMES";
  message: string;
}

export function validateLineup(i: LineupInput): LineupProblem[] {
  const problems: LineupProblem[] = [];
  const games = i.slotKinds.length;
  const ordinals = i.slots.map((s) => s.gameOrdinal);
  const expected = Array.from({ length: games }, (_, k) => k + 1);
  if (i.slots.length !== games || !expected.every((o) => ordinals.includes(o))) {
    problems.push({
      gameOrdinal: null,
      code: "WRONG_SLOT_COUNT",
      message: `a lineup needs exactly one entry for each of games 1–${games}`,
    });
  }
  if (new Set(ordinals).size !== ordinals.length) {
    problems.push({ gameOrdinal: null, code: "DUPLICATE_SLOT", message: "a game appears twice in the lineup" });
  }

  const played = { SINGLES: new Map<string, number>(), PAIRS: new Map<string, number>() };
  const limit = { SINGLES: i.maxSinglesPerPlayer, PAIRS: i.maxPairsPerPlayer };
  for (const slot of i.slots) {
    const at = slot.gameOrdinal;
    const kind = i.slotKinds[at - 1];
    if (!kind) continue;
    const ids = slot.registrationIds;
    const needed = kind === "PAIRS" ? 2 : 1;
    if (ids.length !== 0 && ids.length !== needed) {
      problems.push({
        gameOrdinal: at,
        code: "WRONG_PLAYER_COUNT",
        message: kind === "PAIRS" ? "a pairs game needs two players (or none for a walkover)" : "a singles game needs one player",
      });
      continue;
    }
    if (new Set(ids).size !== ids.length) {
      problems.push({ gameOrdinal: at, code: "SAME_PLAYER_TWICE", message: "the same player is listed twice in one pair" });
      continue;
    }
    for (const id of ids) {
      const reg = i.registrations.get(id);
      if (!reg) {
        problems.push({ gameOrdinal: at, code: "UNKNOWN_PLAYER", message: "player is not registered" });
        continue;
      }
      if (reg.teamId !== i.teamId) {
        problems.push({ gameOrdinal: at, code: "OTHER_TEAM", message: "player is registered to another team" });
        continue;
      }
      if (reg.registrationStatus !== "ACTIVE") {
        problems.push({ gameOrdinal: at, code: "REGISTRATION_ENDED", message: "player's registration has ended" });
      }
      if (reg.playerStatus !== "ACTIVE") {
        problems.push({
          gameOrdinal: at,
          code: "PLAYER_NOT_ACTIVE",
          message: `player is ${reg.playerStatus.toLowerCase()}`,
        });
      }
      if (reg.registeredAt.getTime() > i.fixtureStartsAt.getTime()) {
        problems.push({
          gameOrdinal: at,
          code: "REGISTERED_AFTER_FIXTURE",
          message: "player was registered after this fixture's date",
        });
      }
      const n = (played[kind].get(reg.playerId) ?? 0) + 1;
      played[kind].set(reg.playerId, n);
      if (n > limit[kind]) {
        const what = kind === "PAIRS" ? "pairs" : "singles";
        problems.push({
          gameOrdinal: at,
          code: "TOO_MANY_GAMES",
          message: `a player may play at most ${limit[kind]} ${what} game${limit[kind] === 1 ? "" : "s"} per fixture`,
        });
      }
    }
  }
  return problems;
}
