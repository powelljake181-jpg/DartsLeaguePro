/**
 * Leg / game scoring engine. Pure and deterministic: the same visits always
 * produce the same state, so the server can rebuild authoritative state from
 * stored visits and the scoring phone can run the identical engine offline.
 */

export type Side = "HOME" | "AWAY";
export const otherSide = (s: Side): Side => (s === "HOME" ? "AWAY" : "HOME");

// ---------------------------------------------------------------------------
// What is physically possible with darts
// ---------------------------------------------------------------------------

const SEGMENTS = Array.from({ length: 20 }, (_, i) => i + 1);
/** Every score a single dart can make, including a miss. */
const DART_VALUES = [...new Set([0, ...SEGMENTS, ...SEGMENTS.map((n) => n * 2), ...SEGMENTS.map((n) => n * 3), 25, 50])];
/** Every finishing double, including the bull. */
const DOUBLES = [...SEGMENTS.map((n) => n * 2), 50];

const sumsOf = (count: number): Set<number> => {
  let acc = new Set([0]);
  for (let i = 0; i < count; i++) {
    const next = new Set<number>();
    for (const a of acc) for (const d of DART_VALUES) next.add(a + d);
    acc = next;
  }
  return acc;
};

const ANY_THREE = sumsOf(3);
const ANY_BY_COUNT = [sumsOf(0), sumsOf(1), sumsOf(2)];

/** Is `score` a total three darts can make? (Rules out 179, 178, 176, 175, 173, 172, 169, 166, 163.) */
export function isPossibleVisit(score: number): boolean {
  return Number.isInteger(score) && score >= 0 && score <= 180 && ANY_THREE.has(score);
}

/** Can `score` be checked out using exactly `darts` darts, finishing on a double when required? */
export function isPossibleCheckout(score: number, darts: number, doubleOut: boolean): boolean {
  if (!Number.isInteger(score) || darts < 1 || darts > 3 || score < 1) return false;
  const finals = doubleOut ? DOUBLES : DART_VALUES.filter((v) => v > 0);
  for (const last of finals) {
    const rest = score - last;
    if (rest >= 0 && ANY_BY_COUNT[darts - 1].has(rest)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Leg engine
// ---------------------------------------------------------------------------

export interface LegConfig {
  startingScore: number;
  doubleOut: boolean;
  startingSide: Side;
  /** Pairs: the two partners on a side must alternate visits within a leg. */
  alternatePartners?: boolean;
}

/** A visit as stored: the authoritative, normalised record. */
export interface Visit {
  side: Side;
  playerId: string;
  /** What the scorer entered (kept for audit; differs from score only on a bust). */
  entered: number;
  /** Points actually scored (0 for a bust). */
  score: number;
  /** Darts actually thrown in this visit (1–3). */
  darts: number;
  isBust: boolean;
  isCheckout: boolean;
}

/** What a scorer submits: "player X scored N", plus darts when finishing or busting early. */
export interface VisitInput {
  side: Side;
  playerId: string;
  /** Total of the darts thrown, as the scorer reads it off the board. */
  scored: number;
  /** Required for a checkout (1–3); optional for a bust (defaults to 3). */
  darts?: number;
}

export interface LegState {
  remaining: Record<Side, number>;
  nextToThrow: Side;
  winner: Side | null;
  visits: Visit[];
}

export class ScoringError extends Error {
  constructor(
    public readonly code:
      | "LEG_FINISHED"
      | "WRONG_TURN"
      | "WRONG_PLAYER"
      | "IMPOSSIBLE_SCORE"
      | "INVALID_DARTS"
      | "IMPOSSIBLE_CHECKOUT",
    message: string,
  ) {
    super(message);
    this.name = "ScoringError";
  }
}

export function initialLegState(cfg: LegConfig): LegState {
  return {
    remaining: { HOME: cfg.startingScore, AWAY: cfg.startingScore },
    nextToThrow: cfg.startingSide,
    winner: null,
    visits: [],
  };
}

/**
 * Validate a submitted visit against the current leg state and turn it into a
 * normalised Visit. Busts are decided here, never by the client.
 */
export function resolveVisit(state: LegState, cfg: LegConfig, input: VisitInput): Visit {
  if (state.winner) throw new ScoringError("LEG_FINISHED", "this leg is already finished");
  if (input.side !== state.nextToThrow) {
    throw new ScoringError("WRONG_TURN", `it is ${state.nextToThrow}'s turn to throw`);
  }
  if (cfg.alternatePartners) {
    const previous = state.visits.findLast((v) => v.side === input.side);
    if (previous && previous.playerId === input.playerId) {
      throw new ScoringError("WRONG_PLAYER", "partners take turns: the other player in this pair throws next");
    }
  }
  if (!isPossibleVisit(input.scored)) {
    throw new ScoringError("IMPOSSIBLE_SCORE", `${input.scored} is not a possible three-dart score`);
  }
  if (input.darts !== undefined && (!Number.isInteger(input.darts) || input.darts < 1 || input.darts > 3)) {
    throw new ScoringError("INVALID_DARTS", "darts must be 1, 2 or 3");
  }

  const remaining = state.remaining[input.side];
  const after = remaining - input.scored;
  const bust = (darts: number): Visit => ({
    side: input.side,
    playerId: input.playerId,
    entered: input.scored,
    score: 0,
    darts,
    isBust: true,
    isCheckout: false,
  });

  if (after < 0 || (cfg.doubleOut && after === 1)) return bust(input.darts ?? 3);

  if (after === 0) {
    const darts = input.darts;
    if (darts === undefined) {
      throw new ScoringError("INVALID_DARTS", "darts used is required for a checkout");
    }
    if (!isPossibleCheckout(input.scored, darts, cfg.doubleOut)) {
      throw new ScoringError(
        "IMPOSSIBLE_CHECKOUT",
        `${input.scored} cannot be checked out with ${darts} dart${darts === 1 ? "" : "s"}`,
      );
    }
    return { side: input.side, playerId: input.playerId, entered: input.scored, score: input.scored, darts, isBust: false, isCheckout: true };
  }

  if (input.darts !== undefined && input.darts !== 3) {
    throw new ScoringError("INVALID_DARTS", "a visit that does not finish or bust uses all 3 darts");
  }
  return { side: input.side, playerId: input.playerId, entered: input.scored, score: input.scored, darts: 3, isBust: false, isCheckout: false };
}

/** Apply an already-normalised visit. */
export function applyVisit(state: LegState, visit: Visit): LegState {
  const remaining = { ...state.remaining, [visit.side]: state.remaining[visit.side] - visit.score };
  return {
    remaining,
    nextToThrow: otherSide(visit.side),
    winner: visit.isCheckout ? visit.side : null,
    visits: [...state.visits, visit],
  };
}

/** Rebuild a leg's state from its stored visits, re-validating each one. */
export function replayLeg(cfg: LegConfig, visits: Visit[]): LegState {
  let state = initialLegState(cfg);
  for (const v of visits) {
    const resolved = resolveVisit(state, cfg, {
      side: v.side,
      playerId: v.playerId,
      scored: v.entered,
      darts: v.darts,
    });
    if (resolved.isBust !== v.isBust || resolved.isCheckout !== v.isCheckout || resolved.score !== v.score) {
      throw new ScoringError("IMPOSSIBLE_SCORE", "stored visit is inconsistent with the leg state");
    }
    state = applyVisit(state, resolved);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Game (a set of legs between two players)
// ---------------------------------------------------------------------------

export interface GameFormat {
  legsFormat: "BEST_OF" | "FIXED";
  legs: number;
}

export interface GameProgress {
  legsWon: Record<Side, number>;
  legsPlayed: number;
  finished: boolean;
  /** DRAW is only possible with FIXED legs. */
  winner: Side | "DRAW" | null;
}

export function gameProgress(format: GameFormat, legWinners: Side[]): GameProgress {
  const legsWon = { HOME: 0, AWAY: 0 };
  for (const w of legWinners) legsWon[w]++;
  const legsPlayed = legWinners.length;

  if (format.legsFormat === "BEST_OF") {
    const target = Math.floor(format.legs / 2) + 1;
    const winner = legsWon.HOME >= target ? "HOME" : legsWon.AWAY >= target ? "AWAY" : null;
    return { legsWon, legsPlayed, finished: winner !== null, winner };
  }
  const finished = legsPlayed >= format.legs;
  const winner = !finished
    ? null
    : legsWon.HOME > legsWon.AWAY
      ? "HOME"
      : legsWon.AWAY > legsWon.HOME
        ? "AWAY"
        : "DRAW";
  return { legsWon, legsPlayed, finished, winner };
}

/** Throw alternates each leg: leg 1 the given side, leg 2 the other, and so on. */
export function startingSideForLeg(firstLegStarter: Side, legIndex: number): Side {
  return legIndex % 2 === 0 ? firstLegStarter : otherSide(firstLegStarter);
}
