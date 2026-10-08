import {
  applyVisit,
  initialLegState,
  resolveVisit,
  type LegConfig,
  type LegState,
  type Side,
} from "./scoring";

/** A scripted visit: [side, scored] or [side, scored, darts]. */
export type Throw = [Side, number] | [Side, number, number];

/** Play a leg through the real engine. Player ids are "H" / "A" unless overridden. */
export function playLeg(cfg: LegConfig, throws: Throw[], players: Record<Side, string> = { HOME: "H", AWAY: "A" }): LegState {
  let state = initialLegState(cfg);
  for (const [side, scored, darts] of throws) {
    const visit = resolveVisit(state, cfg, { side, playerId: players[side], scored, darts });
    state = applyVisit(state, visit);
  }
  return state;
}

export const LEG_501: LegConfig = { startingScore: 501, doubleOut: true, startingSide: "HOME" };
