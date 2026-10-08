import {
  applyVisit,
  gameProgress,
  initialLegState,
  resolveVisit,
  startingSideForLeg,
  type LegState,
  type Side,
  type VisitInput,
} from "./scoring";

/**
 * What the scoring phone shows: the server's last known state of a game plus
 * the visits still waiting to be sent. Uses the same engine as the server, so
 * a visit accepted here is accepted there (the server still re-checks).
 */

export interface ServerGameState {
  status: string;
  /** The server's result for a finished game. */
  winner: Side | "DRAW" | null;
  homeLegs: number;
  awayLegs: number;
  legsFormat: "BEST_OF" | "FIXED";
  legs: number;
  startingScore: number;
  doubleOut: boolean;
  firstThrower: Side;
  /** Player ids per side (one for singles, two for pairs). */
  players: Record<Side, string[]>;
  currentLeg: {
    ordinal: number;
    startingSide: Side;
    remaining: Record<Side, number>;
    nextToThrow: Side;
    nextPlayer: Record<Side, string | null>;
    finished: boolean;
  } | null;
}

export interface ProjectedGame {
  finished: boolean;
  winner: Side | "DRAW" | null;
  legsWon: Record<Side, number>;
  legOrdinal: number;
  startingSide: Side;
  remaining: Record<Side, number>;
  nextToThrow: Side;
  /** Who throws next for each side; null in pairs at the start of a leg (the scorer chooses). */
  nextPlayer: Record<Side, string | null>;
}

const OVER = ["COMPLETED", "WALKOVER", "VOID", "NOT_REQUIRED"];

const freshNextPlayer = (players: Record<Side, string[]>): Record<Side, string | null> => ({
  HOME: players.HOME.length === 1 ? players.HOME[0] : null,
  AWAY: players.AWAY.length === 1 ? players.AWAY[0] : null,
});

/** Project a game forward through pending visits. Throws a ScoringError if a pending visit is invalid. */
export function projectGame(g: ServerGameState, pending: VisitInput[]): ProjectedGame {
  const legsWon = { HOME: g.homeLegs, AWAY: g.awayLegs };
  let finished = OVER.includes(g.status) || !g.currentLeg || g.currentLeg.finished;
  let winner: ProjectedGame["winner"] = finished ? g.winner : null;
  let legOrdinal = g.currentLeg?.ordinal ?? 1;
  let startingSide = g.currentLeg?.startingSide ?? g.firstThrower;
  let state: LegState = {
    remaining: g.currentLeg ? { ...g.currentLeg.remaining } : { HOME: g.startingScore, AWAY: g.startingScore },
    nextToThrow: g.currentLeg?.nextToThrow ?? g.firstThrower,
    winner: null,
    visits: [],
  };
  let nextPlayer = { ...(g.currentLeg?.nextPlayer ?? freshNextPlayer(g.players)) };

  for (const p of pending) {
    if (finished) throw new Error("this game has already finished");
    const v = resolveVisit(state, { startingScore: g.startingScore, doubleOut: g.doubleOut, startingSide }, p);
    state = applyVisit(state, v);
    const side = g.players[v.side];
    nextPlayer[v.side] = side.length === 2 ? (side.find((id) => id !== v.playerId) ?? null) : (side[0] ?? null);
    if (v.isCheckout) {
      legsWon[v.side]++;
      const winners: Side[] = [...Array(legsWon.HOME).fill("HOME"), ...Array(legsWon.AWAY).fill("AWAY")];
      const progress = gameProgress({ legsFormat: g.legsFormat, legs: g.legs }, winners);
      if (progress.finished) {
        finished = true;
        winner = progress.winner;
      } else {
        legOrdinal++;
        startingSide = startingSideForLeg(g.firstThrower, legOrdinal - 1);
        state = initialLegState({ startingScore: g.startingScore, doubleOut: g.doubleOut, startingSide });
        nextPlayer = freshNextPlayer(g.players);
      }
    }
  }
  return { finished, winner, legsWon, legOrdinal, startingSide, remaining: state.remaining, nextToThrow: state.nextToThrow, nextPlayer };
}
