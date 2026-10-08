import { addDays, weekdayOf } from "./dates";

/**
 * Fixture generation. Pure and deterministic for a given seed.
 * See docs/ARCHITECTURE.md §8.
 *
 * 1. Each division gets a calendar: its match night every week from the start
 *    date, skipping excluded dates (breaks, cup nights, free weeks).
 * 2. Each division gets a round-robin from the circle method. A team's
 *    home/away pattern depends only on which *slot* it occupies, so the slot
 *    assignment is the main thing to choose. Each extra meeting repeats the
 *    rounds with home and away swapped.
 * 3. Venue constraints ("Melville and Melville B can't both be at home on the
 *    same night") are checked across all divisions at once. A seeded local
 *    search swaps slots, reorders rounds and mirrors divisions to remove
 *    clashes. Clashes it cannot remove are reported, never hidden.
 */

export interface DivisionInput {
  id: string;
  name: string;
  /** Team identifiers (e.g. entry ids). */
  teams: string[];
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** First possible date (YYYY-MM-DD); the first match night on or after it is used. */
  startDate: string;
  /** How many times each pair meets (2 = home and away). */
  meetings: number;
  /** Dates with no league fixtures for this division. */
  excludedDates: string[];
}

export interface ConstraintInput {
  id: string;
  name: string;
  /** Team identifiers, possibly in different divisions. */
  teams: string[];
  /** Most of these teams that may be at home on one date. */
  maxHome: number;
}

export interface ScheduledFixture {
  divisionId: string;
  /** 1-based round number within the division. */
  round: number;
  date: string;
  home: string;
  away: string;
}

export interface Bye {
  divisionId: string;
  round: number;
  date: string;
  team: string;
}

export interface Conflict {
  constraintId: string;
  constraintName: string;
  date: string;
  /** The constrained teams at home that date. */
  homeTeams: string[];
  maxHome: number;
}

export interface ScheduleResult {
  fixtures: ScheduledFixture[];
  byes: Bye[];
  conflicts: Conflict[];
  /** Dates actually used, per division. */
  dates: Record<string, string[]>;
  seed: number;
}

export class SchedulingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulingError";
  }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** The first `count` match nights on or after `startDate` on `weekday`, skipping excluded dates. */
export function matchNights(startDate: string, weekday: number, count: number, excluded: Iterable<string>): string[] {
  const skip = new Set(excluded);
  let d = startDate;
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  const out: string[] = [];
  for (let guard = 0; out.length < count; guard++) {
    if (guard > 520) throw new SchedulingError("not enough match nights in the next ten years — check the excluded dates");
    if (!skip.has(d)) out.push(d);
    d = addDays(d, 7);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Round-robin
// ---------------------------------------------------------------------------

/** Pairings by slot for one full round-robin of `n` slots (n even): rounds of [home, away]. */
export function circleRounds(n: number): [number, number][][] {
  if (n % 2 !== 0) throw new Error("circleRounds needs an even number of slots");
  const rounds: [number, number][][] = [];
  const fixed = n - 1;
  for (let r = 0; r < n - 1; r++) {
    const pairs: [number, number][] = [];
    // The fixed slot alternates home and away.
    pairs.push(r % 2 === 0 ? [r, fixed] : [fixed, r]);
    for (let k = 1; k < n / 2; k++) {
      const a = (r + k) % (n - 1);
      const b = (r - k + (n - 1)) % (n - 1);
      pairs.push(k % 2 === 1 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
  }
  return rounds;
}

/** Mutable search state for one division. */
interface DivisionState {
  input: DivisionInput;
  /** slots: slot index → team (null = bye slot for odd team counts). */
  slots: (string | null)[];
  /** Order in which the base rounds are played, per meeting (each meeting may differ). */
  orders: number[][];
  /** Swap home and away throughout. */
  mirrored: boolean;
  base: [number, number][][];
  dates: string[];
}

function roundsPerMeeting(teamCount: number) {
  return teamCount % 2 === 0 ? teamCount - 1 : teamCount;
}

function initialState(d: DivisionInput, rng: () => number): DivisionState {
  if (d.teams.length < 2) throw new SchedulingError(`${d.name} needs at least two teams`);
  if (new Set(d.teams).size !== d.teams.length) throw new SchedulingError(`${d.name} lists a team twice`);
  if (d.meetings < 1 || d.meetings > 6) throw new SchedulingError("teams must meet between 1 and 6 times");
  const slots: (string | null)[] = shuffle([...d.teams], rng);
  if (slots.length % 2 === 1) slots.push(null);
  const base = circleRounds(slots.length);
  const total = roundsPerMeeting(d.teams.length) * d.meetings;
  return {
    input: d,
    slots,
    orders: Array.from({ length: d.meetings }, () => base.map((_, i) => i)),
    mirrored: false,
    base,
    dates: matchNights(d.startDate, d.weekday, total, d.excludedDates),
  };
}

/** Expand a division's state into dated fixtures and byes. */
function expand(s: DivisionState): { fixtures: ScheduledFixture[]; byes: Bye[] } {
  const fixtures: ScheduledFixture[] = [];
  const byes: Bye[] = [];
  const per = s.base.length;
  for (let m = 0; m < s.input.meetings; m++) {
    for (let i = 0; i < per; i++) {
      const roundIndex = m * per + i;
      const date = s.dates[roundIndex];
      // Odd meetings play the same rounds with home and away swapped.
      const flip = (m % 2 === 1) !== s.mirrored;
      for (const [h, a] of s.base[s.orders[m][i]]) {
        const home = s.slots[flip ? a : h];
        const away = s.slots[flip ? h : a];
        if (home === null || away === null) {
          byes.push({ divisionId: s.input.id, round: roundIndex + 1, date, team: (home ?? away)! });
          continue;
        }
        fixtures.push({ divisionId: s.input.id, round: roundIndex + 1, date, home, away });
      }
    }
  }
  return { fixtures, byes };
}

/** Constrained teams at home on each date, keyed by date then team. */
function conflictsOf(fixtures: ScheduledFixture[], constraints: ConstraintInput[]): Conflict[] {
  const homeOn = new Map<string, Set<string>>();
  for (const f of fixtures) {
    const set = homeOn.get(f.date) ?? new Set<string>();
    set.add(f.home);
    homeOn.set(f.date, set);
  }
  const out: Conflict[] = [];
  for (const c of constraints) {
    for (const [date, homes] of homeOn) {
      const mine = c.teams.filter((t) => homes.has(t));
      if (mine.length > c.maxHome) {
        out.push({ constraintId: c.id, constraintName: c.name, date, homeTeams: mine, maxHome: c.maxHome });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.constraintName.localeCompare(b.constraintName));
}

const clashCost = (conflicts: Conflict[]) => conflicts.reduce((n, c) => n + c.homeTeams.length - c.maxHome, 0);

/**
 * Home/away runs longer than two in a row, summed over teams (e.g. H H H counts 1,
 * H H H H counts 2). Byes don't break a run.
 */
export function longRuns(fixtures: ScheduledFixture[]): number {
  const seq = new Map<string, { date: string; home: boolean }[]>();
  for (const f of fixtures) {
    for (const [team, home] of [[f.home, true], [f.away, false]] as const) {
      const list = seq.get(team) ?? [];
      list.push({ date: f.date, home });
      seq.set(team, list);
    }
  }
  let total = 0;
  for (const list of seq.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    let run = 0;
    for (let i = 0; i < list.length; i++) {
      run = i > 0 && list[i].home === list[i - 1].home ? run + 1 : 1;
      if (run > 2) total++;
    }
  }
  return total;
}

/** Clashes dominate; long home/away runs are a tie-breaker between clash-free schedules. */
const CLASH_WEIGHT = 1000;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  seed?: number;
  /** Search effort; the default is plenty for typical pub leagues. */
  iterations?: number;
}

export function generateSchedule(divisions: DivisionInput[], constraints: ConstraintInput[], opts: GenerateOptions = {}): ScheduleResult {
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed);
  const ids = new Set<string>();
  for (const d of divisions) {
    if (ids.has(d.id)) throw new SchedulingError(`division ${d.name} listed twice`);
    ids.add(d.id);
  }
  const allTeams = divisions.flatMap((d) => d.teams);
  if (new Set(allTeams).size !== allTeams.length) throw new SchedulingError("a team appears in more than one division");
  const relevant = constraints
    .map((c) => ({ ...c, teams: c.teams.filter((t) => allTeams.includes(t)) }))
    .filter((c) => c.teams.length > c.maxHome);

  let state = divisions.map((d) => initialState(d, rng));
  const evaluate = (s: DivisionState[]) => {
    const fixtures = s.flatMap((d) => expand(d).fixtures);
    return CLASH_WEIGHT * clashCost(conflictsOf(fixtures, relevant)) + longRuns(fixtures);
  };

  let current = evaluate(state);
  let best = { state: cloneAll(state), cost: current };
  const constrained = new Set(relevant.flatMap((c) => c.teams));
  // Divisions with constrained teams are picked more often; every division can improve its home/away runs.
  const movable = state.flatMap((d, i) => (d.slots.some((t) => t && constrained.has(t)) ? [i, i, i] : [i]));
  const iterations = opts.iterations ?? 30_000;

  for (let it = 0; it < iterations && best.cost > 0; it++) {
    const temperature = 3 * (1 - it / iterations) + 0.05;
    const di = movable[Math.floor(rng() * movable.length)];
    const next = cloneAll(state);
    const d = next[di];
    const move = rng();
    if (move < 0.6) {
      // Swap two slots, preferring ones holding constrained teams.
      const constrainedSlots = d.slots.map((t, k) => (t && constrained.has(t) ? k : -1)).filter((k) => k >= 0);
      const a = constrainedSlots.length && rng() < 0.7 ? constrainedSlots[Math.floor(rng() * constrainedSlots.length)] : Math.floor(rng() * d.slots.length);
      let b = Math.floor(rng() * d.slots.length);
      if (b === a) b = (b + 1) % d.slots.length;
      [d.slots[a], d.slots[b]] = [d.slots[b], d.slots[a]];
    } else if (move < 0.9) {
      const order = d.orders[Math.floor(rng() * d.orders.length)];
      const a = Math.floor(rng() * order.length);
      const b = Math.floor(rng() * order.length);
      [order[a], order[b]] = [order[b], order[a]];
    } else {
      d.mirrored = !d.mirrored;
    }
    const c = evaluate(next);
    if (c <= current || rng() < Math.exp((current - c) / temperature)) {
      state = next;
      current = c;
      if (c < best.cost) best = { state: cloneAll(next), cost: c };
    }
  }

  const expanded = best.state.map(expand);
  const fixtures = expanded.flatMap((e) => e.fixtures);
  return {
    fixtures,
    byes: expanded.flatMap((e) => e.byes),
    conflicts: conflictsOf(fixtures, relevant),
    dates: Object.fromEntries(best.state.map((d) => [d.input.id, d.dates])),
    seed,
  };
}

function cloneAll(s: DivisionState[]): DivisionState[] {
  return s.map((d) => ({ ...d, slots: [...d.slots], orders: d.orders.map((o) => [...o]) }));
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Small, fast, seedable PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
