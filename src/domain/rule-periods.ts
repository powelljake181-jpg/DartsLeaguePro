import type { LeagueRules } from "./rules";

/**
 * A competition's rules are a timeline: each period starts on a date (league
 * local) and runs until the next one. A fixture is governed by the period in
 * force on its date. Changing rules always means adding a period with an
 * explicit effective date — which may be in the past.
 */

export interface RulePeriod<R = LeagueRules> {
  /** YYYY-MM-DD in the league's timezone. */
  effectiveFrom: string;
  rules: R;
}

/** The period in force on `date`. Dates before the first period use the first period. */
export function periodFor<P extends { effectiveFrom: string }>(periods: P[], date: string): P {
  if (periods.length === 0) throw new Error("competition has no rules");
  const sorted = [...periods].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  let current = sorted[0];
  for (const p of sorted) if (p.effectiveFrom <= date) current = p;
  return current;
}

/** The next period after `date`, if any (a new period runs until then). */
export function nextPeriodAfter<P extends { effectiveFrom: string }>(periods: P[], date: string): P | null {
  return [...periods].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).find((p) => p.effectiveFrom > date) ?? null;
}

/**
 * Differences that change how a match is *played* (games, formats, legs,
 * starting score). These cannot be applied to fixtures that have already been
 * played, because the games would not match. Everything else (points,
 * tie-breakers, walkover treatment, stat bands, names) can be applied
 * retrospectively by recalculating.
 */
export function structuralChanges(before: LeagueRules, after: LeagueRules): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(before.match.slots, after.match.slots)) out.push("the games in a fixture (number, singles/pairs, or which result they count towards)");
  for (const kind of ["singles", "pairs"] as const) {
    if (!same(before.game[kind], after.game[kind])) out.push(`${kind} game format (starting score, legs or finish)`);
  }
  const shape = (r: LeagueRules) => r.match.groups.map((g) => ({ key: g.key, format: g.format, allowDraw: g.allowDraw, deadRubbers: g.deadRubbers }));
  if (!same(shape(before), shape(after))) out.push("result format (best-of / fixed, draws, dead rubbers)");
  return out;
}

/** Human-readable list of what changed, for previews and the audit log. */
export function describeChanges(before: LeagueRules, after: LeagueRules): string[] {
  const out = structuralChanges(before, after);
  after.match.groups.forEach((g) => {
    const old = before.match.groups.find((x) => x.key === g.key);
    if (!old) return;
    if (JSON.stringify(old.points) !== JSON.stringify(g.points)) out.push(`${g.name} points`);
    if (JSON.stringify(old.tieBreakers) !== JSON.stringify(g.tieBreakers)) out.push(`${g.name} tie-breakers`);
  });
  if (JSON.stringify(before.walkover) !== JSON.stringify(after.walkover)) out.push("walkover treatment");
  if (JSON.stringify(before.stats) !== JSON.stringify(after.stats)) out.push("statistics settings");
  if (before.scoring.responsibleSide !== after.scoring.responsibleSide) out.push("which team enters the score");
  if (before.match.maxSinglesPerPlayer !== after.match.maxSinglesPerPlayer || before.match.maxPairsPerPlayer !== after.match.maxPairsPerPlayer) {
    out.push("games per player");
  }
  return out;
}
