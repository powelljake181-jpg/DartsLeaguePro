import { mulberry32 } from "./scheduling";

/**
 * Knockout cups. A cup is a fixed bracket whose size is the next power of two
 * (ARCHITECTURE §10.16): with 11 teams the bracket has 16 places and 5 byes.
 * Round 1 tie `i` is bracket places 2i and 2i+1; the winners of round r ties
 * 2i and 2i+1 meet in round r+1 tie i, the upper tie's winner at home.
 *
 * Places are filled in standard seeding order (1 v 16, 8 v 9, …), so byes —
 * the "seeds" beyond the number of entrants — fall against the top seeds and
 * two byes never meet. A random draw shuffles the entrants into seed order
 * first, which spreads byes the same way.
 */

export type DrawMode = "RANDOM" | "SEEDED" | "MANUAL";

export interface DrawEntrant {
  entryId: string;
  /** 1 = top seed. Unseeded entrants are drawn at random after the seeds. */
  seed?: number | null;
}

/** One tie: `away` null is a bye (the home team goes through). */
export interface Tie {
  home: string;
  away: string | null;
}

export class CupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CupError";
  }
}

export const MIN_ENTRANTS = 2;

export function bracketSize(entrants: number): number {
  if (entrants < MIN_ENTRANTS) throw new CupError(`a cup needs at least ${MIN_ENTRANTS} teams`);
  let size = 2;
  while (size < entrants) size *= 2;
  return size;
}

export const roundCount = (entrants: number): number => Math.log2(bracketSize(entrants));

/** "Final", "Semi-finals", "Quarter-finals", "Last 16", … , or "Round 1" for very early rounds. */
export function roundName(round: number, rounds: number): string {
  const left = rounds - round; // 0 = final
  if (left === 0) return "Final";
  if (left === 1) return "Semi-finals";
  if (left === 2) return "Quarter-finals";
  if (left <= 4) return `Last ${2 ** (left + 1)}`;
  return `Round ${round}`;
}

/** Standard bracket order of seeds for a bracket of `size` places, e.g. 8 → [1, 8, 4, 5, 2, 7, 3, 6]. */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2 + 1;
    order = order.flatMap((s) => [s, n - s]);
  }
  return order;
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Round 1 of a random or seeded draw. Deterministic for a given `rngSeed`, so
 * the draw an admin previews is exactly the draw that is saved.
 */
export function drawFirstRound(entrants: DrawEntrant[], mode: "RANDOM" | "SEEDED", rngSeed: number): Tie[] {
  const ids = entrants.map((e) => e.entryId);
  if (new Set(ids).size !== ids.length) throw new CupError("a team is entered twice");
  const size = bracketSize(entrants.length);
  const rng = mulberry32(rngSeed);

  let ranked: string[];
  if (mode === "RANDOM") {
    ranked = shuffle(ids, rng);
  } else {
    const seeded = entrants.filter((e) => e.seed != null).sort((a, b) => a.seed! - b.seed!);
    const seeds = seeded.map((e) => e.seed);
    if (new Set(seeds).size !== seeds.length) throw new CupError("two teams have the same seed");
    const unseeded = shuffle(entrants.filter((e) => e.seed == null).map((e) => e.entryId), rng);
    ranked = [...seeded.map((e) => e.entryId), ...unseeded];
  }

  const order = seedOrder(size);
  const ties: Tie[] = [];
  for (let i = 0; i < size; i += 2) {
    const a = ranked[order[i] - 1] ?? null;
    const b = ranked[order[i + 1] - 1] ?? null;
    if (!a && !b) throw new CupError("internal: two byes met"); // impossible with standard seeding
    if (!a || !b) {
      ties.push({ home: (a ?? b)!, away: null });
    } else if (mode === "SEEDED" && rng() < 0.5) {
      // The better seed isn't automatically at home: home is drawn, as in a pub cup draw.
      ties.push({ home: b, away: a });
    } else {
      ties.push({ home: a, away: b });
    }
  }
  return ties;
}

/** Check a draw made by hand: every entrant exactly once, the right number of ties, and the right number of byes. */
export function validateManualDraw(entrantIds: string[], ties: { home: string | null; away: string | null }[]): Tie[] {
  const size = bracketSize(entrantIds.length);
  if (ties.length !== size / 2) throw new CupError(`a ${entrantIds.length}-team cup has ${size / 2} first-round ties`);
  const seen = new Set<string>();
  const out: Tie[] = [];
  for (const [i, t] of ties.entries()) {
    const teams = [t.home, t.away].filter((x): x is string => !!x);
    if (teams.length === 0) throw new CupError(`tie ${i + 1} has no teams; byes must be against a team`);
    for (const id of teams) {
      if (!entrantIds.includes(id)) throw new CupError(`tie ${i + 1} has a team that isn't in the cup`);
      if (seen.has(id)) throw new CupError(`a team is drawn twice`);
      seen.add(id);
    }
    out.push(teams.length === 1 ? { home: teams[0], away: null } : { home: teams[0], away: teams[1] });
  }
  const missing = entrantIds.length - seen.size;
  if (missing) throw new CupError(`${missing} team${missing === 1 ? " hasn't" : "s haven't"} been drawn`);
  return out;
}

/**
 * Who meets whom in the round after: tie i is the winners of ties 2i and 2i+1
 * (null where a tie isn't decided yet).
 */
export function nextRoundPairs(winners: (string | null)[]): { home: string | null; away: string | null }[] {
  const out = [];
  for (let i = 0; i < winners.length; i += 2) out.push({ home: winners[i] ?? null, away: winners[i + 1] ?? null });
  return out;
}

/** A random seed for a draw. */
export const newDrawSeed = () => Math.floor(Math.random() * 2 ** 31);
