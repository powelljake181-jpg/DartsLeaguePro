import { majorityOf, ordinalsInGroup, type LeagueRules, type ResultGroup } from "./rules";
import type { Side } from "./scoring";

/**
 * Turning a fixture's individual games into official results — one result per
 * result group (e.g. the main league result and a separate pairs result).
 */

export type GameStatus = "PENDING" | "LIVE" | "COMPLETED" | "WALKOVER" | "NOT_REQUIRED" | "VOID";

export interface GameSummary {
  status: GameStatus;
  /** COMPLETED: the winner (or DRAW). WALKOVER: the side awarded the game. */
  winner: Side | "DRAW" | null;
  homeLegs: number;
  awayLegs: number;
}

export interface FixtureOutcome {
  homeGames: number;
  awayGames: number;
  /** Games that earn per-game league points (walkovers may be excluded by rules). */
  homePointGames: number;
  awayPointGames: number;
  homeLegs: number;
  awayLegs: number;
  winner: Side | "DRAW";
}

/** Outcomes keyed by result group. */
export type FixtureOutcomes = Record<string, FixtureOutcome>;

export interface GroupProgress {
  homeGames: number;
  awayGames: number;
  decided: boolean;
  complete: boolean;
}

export interface FixtureProgress {
  groups: Record<string, GroupProgress>;
  /** Every group complete: the fixture can be finalised. */
  complete: boolean;
  /** Ordinals (1-based) of games no longer required because their group is decided. */
  notRequired: number[];
}

const RESOLVED: GameStatus[] = ["COMPLETED", "WALKOVER", "NOT_REQUIRED", "VOID"];

function tally(games: GameSummary[], rules: LeagueRules) {
  const t = { homeGames: 0, awayGames: 0, homePointGames: 0, awayPointGames: 0, homeLegs: 0, awayLegs: 0 };
  for (const g of games) {
    if (g.status === "COMPLETED") {
      t.homeLegs += g.homeLegs;
      t.awayLegs += g.awayLegs;
      if (g.winner === "HOME") {
        t.homeGames++;
        t.homePointGames++;
      } else if (g.winner === "AWAY") {
        t.awayGames++;
        t.awayPointGames++;
      }
    } else if (g.status === "WALKOVER" && (g.winner === "HOME" || g.winner === "AWAY")) {
      const side = g.winner === "HOME" ? "home" : "away";
      if (rules.walkover.countsAsGameWon) t[`${side}Games`]++;
      if (rules.walkover.earnsGamePoints) t[`${side}PointGames`]++;
      // Walkovers never count toward leg difference.
    }
  }
  return t;
}

function gamesOf(all: GameSummary[], rules: LeagueRules, group: ResultGroup) {
  return ordinalsInGroup(rules, group.key).map((o) => ({ ordinal: o, game: all[o - 1] }));
}

/** Live progress of a fixture, used to decide when it can be finalised. */
export function fixtureProgress(games: GameSummary[], rules: LeagueRules): FixtureProgress {
  if (games.length !== rules.match.slots.length) {
    throw new Error(`fixture has ${games.length} games but rules require ${rules.match.slots.length}`);
  }
  const groups: Record<string, GroupProgress> = {};
  const notRequired: number[] = [];

  for (const group of rules.match.groups) {
    const mine = gamesOf(games, rules, group);
    const t = tally(mine.map((m) => m.game), rules);
    const allResolved = mine.every((m) => RESOLVED.includes(m.game.status));

    if (group.format === "BEST_OF") {
      const target = majorityOf(mine.length);
      const decided = t.homeGames >= target || t.awayGames >= target;
      if (decided && group.deadRubbers === "SKIP") {
        notRequired.push(...mine.filter((m) => m.game.status === "PENDING").map((m) => m.ordinal));
        const stillLive = mine.some((m) => m.game.status === "LIVE");
        groups[group.key] = { homeGames: t.homeGames, awayGames: t.awayGames, decided, complete: !stillLive };
        continue;
      }
      groups[group.key] = { homeGames: t.homeGames, awayGames: t.awayGames, decided: decided || allResolved, complete: allResolved };
      continue;
    }
    groups[group.key] = { homeGames: t.homeGames, awayGames: t.awayGames, decided: allResolved, complete: allResolved };
  }
  return { groups, complete: Object.values(groups).every((g) => g.complete), notRequired };
}

/**
 * The official outcome of each result group of a completed fixture. Throws if
 * the fixture is not complete or a result is not permitted by the rules (e.g. a
 * level result where draws are not allowed): finalising must never produce an
 * invalid result.
 */
export function fixtureOutcomes(games: GameSummary[], rules: LeagueRules): FixtureOutcomes {
  const progress = fixtureProgress(games, rules);
  if (!progress.complete) throw new Error("fixture is not complete");
  const out: FixtureOutcomes = {};
  for (const group of rules.match.groups) {
    const t = tally(gamesOf(games, rules, group).map((m) => m.game), rules);
    const winner = t.homeGames > t.awayGames ? "HOME" : t.awayGames > t.homeGames ? "AWAY" : "DRAW";
    if (winner === "DRAW" && !group.allowDraw) {
      throw new Error(`"${group.name}" ended level but draws are not allowed; correct a game result`);
    }
    out[group.key] = { ...t, winner };
  }
  return out;
}

/**
 * An awarded result with no games played, e.g. a folded team's maximum loss
 * (0–7 in a 7-game league). Every game in every group goes to the winner.
 */
export function awardedOutcomes(winner: Side, rules: LeagueRules): FixtureOutcomes {
  const out: FixtureOutcomes = {};
  for (const group of rules.match.groups) {
    const n = ordinalsInGroup(rules, group.key).length;
    out[group.key] = {
      homeGames: winner === "HOME" ? n : 0,
      awayGames: winner === "AWAY" ? n : 0,
      homePointGames: winner === "HOME" ? n : 0,
      awayPointGames: winner === "AWAY" ? n : 0,
      homeLegs: 0,
      awayLegs: 0,
      winner,
    };
  }
  return out;
}
