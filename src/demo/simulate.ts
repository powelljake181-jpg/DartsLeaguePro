import { isPossibleCheckout, isPossibleVisit, type Side } from "@/domain/scoring";

/**
 * A plausible pub-darts simulator for demo data. Each thrower has a 3-dart
 * average; visits scatter around it, finishes are attempted once a checkout
 * is on (more often by better players and for smaller finishes), doubles are
 * missed, and the occasional bust happens. Every visit it produces is a legal
 * entry for the scoring engine.
 */

export type Rng = () => number;

export interface Thrower {
  playerId: string;
  /** 3-dart average, e.g. 45 for a social player, 75 for a county player. */
  average: number;
}

export interface SimVisit {
  side: Side;
  playerId: string;
  scored: number;
  darts?: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Box–Muller normal sample. */
function normal(rng: Rng, mean: number, sd: number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Nearest score at or below `n` that three darts can make. */
function possibleAtMost(n: number): number {
  for (let s = clamp(Math.floor(n), 0, 180); s > 0; s--) if (isPossibleVisit(s)) return s;
  return 0;
}

/** Fewest darts that can check out `remaining` (double-out), or null if it can't be done in one visit. */
export function checkoutDarts(remaining: number): number | null {
  for (let d = 1; d <= 3; d++) if (isPossibleCheckout(remaining, d, true)) return d;
  return null;
}

/** One visit for a thrower facing `remaining`. */
export function simulateVisit(rng: Rng, t: Thrower, remaining: number): { scored: number; darts?: number } {
  const minDarts = remaining <= 170 ? checkoutDarts(remaining) : null;
  if (minDarts !== null) {
    // Chance to finish this visit: better players and smaller finishes go in more often.
    const skill = clamp((t.average - 30) / 60, 0.05, 1);
    const size = remaining <= 40 ? 1 : remaining <= 60 ? 0.75 : remaining <= 100 ? 0.4 : 0.15;
    if (rng() < 0.55 * skill * size + 0.04) {
      const darts = clamp(minDarts + (rng() < 0.4 ? 1 : 0), minDarts, 3);
      return { scored: remaining, darts: isPossibleCheckout(remaining, darts, true) ? darts : minDarts };
    }
    // Missed: either bust (overshoot or leave 1) or leave a smaller finish.
    if (remaining <= 60 && rng() < 0.18) return { scored: remaining - 1 >= 0 && isPossibleVisit(remaining - 1) ? remaining - 1 : 0, darts: 3 };
    const setup = possibleAtMost(clamp(normal(rng, remaining * 0.45, remaining * 0.2), 0, remaining - 2));
    return { scored: remaining - setup === 1 ? possibleAtMost(setup - 1) : setup };
  }
  // Scoring visit. 180s are rare, more so for weaker players.
  let s = rng() < Math.max(0, (t.average - 40) / 2500) ? 180 : Math.round(normal(rng, t.average, 22));
  s = possibleAtMost(clamp(s, 0, 180));
  // Don't go below 2 (that's a bust or an impossible leave); just score less.
  if (remaining - s < 2) s = possibleAtMost(remaining - 2);
  if (remaining - s === 1) s = possibleAtMost(s - 1);
  return { scored: s };
}

/**
 * A whole leg. `sides` lists the throwers on each side in throwing order
 * (two for pairs, who alternate). Returns visits in throw order; the last one
 * is the checkout.
 */
export function simulateLeg(rng: Rng, sides: Record<Side, Thrower[]>, startingSide: Side, startingScore = 501): SimVisit[] {
  const remaining: Record<Side, number> = { HOME: startingScore, AWAY: startingScore };
  const turn: Record<Side, number> = { HOME: 0, AWAY: 0 };
  const out: SimVisit[] = [];
  let side = startingSide;
  for (let i = 0; i < 400; i++) {
    const thrower = sides[side][turn[side]++ % sides[side].length];
    const v = simulateVisit(rng, thrower, remaining[side]);
    out.push({ side, playerId: thrower.playerId, ...v });
    const after = remaining[side] - v.scored;
    if (after === 0) return out;
    if (after >= 2) remaining[side] = after; // otherwise a bust: score unchanged
    side = side === "HOME" ? "AWAY" : "HOME";
  }
  throw new Error("simulated leg did not finish");
}
