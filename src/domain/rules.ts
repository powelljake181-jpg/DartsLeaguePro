import { z } from "zod";

/**
 * League rule configuration. Stored as versioned JSON on `ruleset.config` and
 * validated with this schema on every read and write. Nothing in the codebase
 * should hard-code a value that appears here.
 *
 * A fixture is an ordered list of game slots (singles or pairs). Each slot
 * feeds a result group; each group produces its own fixture result and its
 * own league table. The first group is the primary result ("the score").
 * Examples:
 *   - 7 singles → one group.
 *   - 6 singles + 1 pairs, all counting → one group of 7 games.
 *   - 1 pairs into a separate pairs table + 7 singles → two groups.
 */

export const TIE_BREAKERS = [
  "POINTS",
  "GAME_DIFFERENCE",
  "GAMES_WON",
  "MATCHES_WON",
  "HEAD_TO_HEAD",
  "LEG_DIFFERENCE",
] as const;
export type TieBreaker = (typeof TIE_BREAKERS)[number];

export const GAME_KINDS = ["SINGLES", "PAIRS"] as const;
export type GameKind = (typeof GAME_KINDS)[number];

const scoreBand = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    min: z.number().int().min(0).max(180),
    max: z.number().int().min(0).max(180),
  })
  .refine((b) => b.min <= b.max, { message: "band min must be <= max" });
export type ScoreBand = z.infer<typeof scoreBand>;

const pointsSchema = z.object({
  win: z.number().min(0),
  draw: z.number().min(0),
  loss: z.number().min(0),
  /** Points awarded to each team per individual game won in this group (0 to disable). */
  perGameWon: z.number().min(0),
});
export type PointsConfig = z.infer<typeof pointsSchema>;

const groupSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/, "use lowercase letters, numbers and dashes"),
  /** Shown as the table name, e.g. "League" or "Pairs". */
  name: z.string().min(1),
  /** FIXED: all games are played. BEST_OF: stop once one side has a majority of this group's games. */
  format: z.enum(["FIXED", "BEST_OF"]),
  /** Whether this group's result can be level (only possible in FIXED format). */
  allowDraw: z.boolean(),
  /** BEST_OF only: what happens to games after the group is decided. */
  deadRubbers: z.enum(["SKIP", "PLAY_FOR_STATS"]),
  points: pointsSchema,
  tieBreakers: z.array(z.enum(TIE_BREAKERS)).min(1),
});
export type ResultGroup = z.infer<typeof groupSchema>;

const gameSchema = z.object({
  startingScore: z.number().int().min(101).max(1001),
  doubleOut: z.boolean(),
  /** BEST_OF: first to a majority of `legs`. FIXED: all `legs` are played (draws possible). */
  legsFormat: z.enum(["BEST_OF", "FIXED"]),
  legs: z.number().int().min(1).max(21),
});
export type GameConfig = z.infer<typeof gameSchema>;

export const rulesSchema = z
  .object({
    version: z.literal(1),

    match: z.object({
      /** Games in playing order. */
      slots: z
        .array(z.object({ kind: z.enum(GAME_KINDS), group: z.string() }))
        .min(1)
        .max(30),
      groups: z.array(groupSchema).min(1),
      /** How many singles / pairs games one player may play in a single fixture. */
      maxSinglesPerPlayer: z.number().int().min(0).max(30),
      maxPairsPerPlayer: z.number().int().min(0).max(30),
    }),

    /** Game settings per kind, e.g. singles 501 best of 1, pairs 701 best of 3. */
    game: z.object({ singles: gameSchema, pairs: gameSchema }),

    walkover: z.object({
      /** Does a walkover count as a game won for the team score? */
      countsAsGameWon: z.boolean(),
      /** Does the walkover game earn per-game league points? */
      earnsGamePoints: z.boolean(),
      /** Does the present player get a game played / win on their record? */
      playerRecord: z.enum(["NONE", "WIN_FOR_PRESENT_PLAYER"]),
    }),

    scoring: z.object({
      /** Which team's admins enter the official live score. */
      responsibleSide: z.enum(["HOME", "AWAY"]),
    }),

    stats: z.object({
      /** Non-overlapping by default: a 180 is not also a 140+. */
      bands: z.array(scoreBand).min(1),
      leaderboardMinGames: z.number().int().min(0),
    }),
  })
  .superRefine((r, ctx) => {
    const keys = r.match.groups.map((g) => g.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", path: ["match", "groups"], message: "result group keys must be unique" });
    }
    r.match.slots.forEach((s, i) => {
      if (!keys.includes(s.group)) {
        ctx.addIssue({ code: "custom", path: ["match", "slots", i, "group"], message: `unknown result group "${s.group}"` });
      }
    });
    r.match.groups.forEach((g, gi) => {
      const path = ["match", "groups", gi];
      const n = r.match.slots.filter((s) => s.group === g.key).length;
      if (n === 0) ctx.addIssue({ code: "custom", path, message: `result group "${g.name}" has no games` });
      if (g.allowDraw && g.format === "BEST_OF") {
        ctx.addIssue({ code: "custom", path: [...path, "allowDraw"], message: "a best-of result cannot be drawn" });
      }
      if (n > 0 && n % 2 === 0 && !g.allowDraw) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `"${g.name}" has an even number of games (${n}) so it can end level; allow draws or use an odd number`,
        });
      }
      if (g.tieBreakers[0] !== "POINTS") {
        ctx.addIssue({ code: "custom", path: [...path, "tieBreakers"], message: "the table must be ordered by points first" });
      }
      if (new Set(g.tieBreakers).size !== g.tieBreakers.length) {
        ctx.addIssue({ code: "custom", path: [...path, "tieBreakers"], message: "tie-breakers must be unique" });
      }
    });
    for (const kind of ["singles", "pairs"] as const) {
      const gc = r.game[kind];
      if (gc.legsFormat === "BEST_OF" && gc.legs % 2 === 0) {
        ctx.addIssue({ code: "custom", path: ["game", kind, "legs"], message: "best-of legs requires an odd number" });
      }
    }
    const bandKeys = r.stats.bands.map((b) => b.key);
    if (new Set(bandKeys).size !== bandKeys.length) {
      ctx.addIssue({ code: "custom", path: ["stats", "bands"], message: "band keys must be unique" });
    }
  });

export type LeagueRules = z.infer<typeof rulesSchema>;

export const DEFAULT_BANDS: ScoreBand[] = [
  { key: "180", label: "180s", min: 180, max: 180 },
  { key: "140", label: "140+", min: 140, max: 179 },
  { key: "100", label: "100+", min: 100, max: 139 },
];

export const DEFAULT_GROUP: ResultGroup = {
  key: "main",
  name: "League",
  format: "FIXED",
  allowDraw: false,
  deadRubbers: "SKIP",
  points: { win: 2, draw: 1, loss: 0, perGameWon: 0 },
  tieBreakers: ["POINTS", "GAME_DIFFERENCE", "GAMES_WON", "HEAD_TO_HEAD"],
};

const STANDARD_GAME: GameConfig = { startingScore: 501, doubleOut: true, legsFormat: "BEST_OF", legs: 1 };

export const DEFAULT_RULES: LeagueRules = {
  version: 1,
  match: {
    slots: singles(7),
    groups: [DEFAULT_GROUP],
    maxSinglesPerPlayer: 1,
    maxPairsPerPlayer: 1,
  },
  game: { singles: STANDARD_GAME, pairs: STANDARD_GAME },
  walkover: { countsAsGameWon: true, earnsGamePoints: true, playerRecord: "NONE" },
  scoring: { responsibleSide: "HOME" },
  stats: { bands: DEFAULT_BANDS, leaderboardMinGames: 5 },
};

/** `n` singles slots feeding `group`. */
export function singles(n: number, group = "main"): LeagueRules["match"]["slots"] {
  return Array.from({ length: n }, () => ({ kind: "SINGLES" as const, group }));
}
/** `n` pairs slots feeding `group`. */
export function pairs(n: number, group = "main"): LeagueRules["match"]["slots"] {
  return Array.from({ length: n }, () => ({ kind: "PAIRS" as const, group }));
}

/** A result group with default settings, e.g. `resultGroup({ key: "pairs", name: "Pairs" })`. */
export function resultGroup(g: Partial<ResultGroup> & { key: string }): ResultGroup {
  return { ...DEFAULT_GROUP, name: g.key, ...g };
}

/** Starting points for a new competition; everything remains editable. */
export const RULE_TEMPLATES: { key: string; name: string; description: string; rules: LeagueRules }[] = [
  {
    key: "singles-7",
    name: "7 singles",
    description: "Seven singles games, all played. 2 points for a win.",
    rules: DEFAULT_RULES,
  },
  {
    key: "singles-6-pairs-1",
    name: "6 singles + 1 pairs",
    description: "Six singles and a pairs game, all counting towards the result.",
    rules: { ...DEFAULT_RULES, match: { ...DEFAULT_RULES.match, slots: [...singles(6), ...pairs(1)] } },
  },
  {
    key: "pairs-table-singles-7",
    name: "Pairs table + 7 singles",
    description: "A pairs game for a separate pairs table, then seven singles for the league.",
    rules: {
      ...DEFAULT_RULES,
      match: {
        ...DEFAULT_RULES.match,
        slots: [...pairs(1, "pairs"), ...singles(7)],
        groups: [
          DEFAULT_GROUP,
          { ...DEFAULT_GROUP, key: "pairs", name: "Pairs", points: { win: 1, draw: 0, loss: 0, perGameWon: 0 } },
        ],
      },
    },
  },
  {
    key: "best-of-9",
    name: "Best of 9 singles",
    description: "First to five games wins; remaining games are not played.",
    rules: {
      ...DEFAULT_RULES,
      match: { ...DEFAULT_RULES.match, slots: singles(9), groups: [{ ...DEFAULT_GROUP, format: "BEST_OF" }] },
    },
  },
];

/** Deep-merge a partial config over the defaults and validate. Arrays replace. Throws on invalid rules. */
export function defineRules(overrides: DeepPartial<LeagueRules> = {}): LeagueRules {
  return rulesSchema.parse(deepMerge(DEFAULT_RULES, overrides));
}

export function parseRules(json: unknown): LeagueRules {
  return rulesSchema.parse(json);
}

export const primaryGroup = (rules: LeagueRules): ResultGroup => rules.match.groups[0];

export function groupByKey(rules: LeagueRules, key: string): ResultGroup {
  const g = rules.match.groups.find((x) => x.key === key);
  if (!g) throw new Error(`unknown result group "${key}"`);
  return g;
}

/** Ordinals (1-based) of the games feeding a group. */
export function ordinalsInGroup(rules: LeagueRules, key: string): number[] {
  return rules.match.slots.flatMap((s, i) => (s.group === key ? [i + 1] : []));
}

export const gameConfigFor = (rules: LeagueRules, kind: GameKind): GameConfig =>
  kind === "PAIRS" ? rules.game.pairs : rules.game.singles;

export const playersPerSide = (kind: GameKind) => (kind === "PAIRS" ? 2 : 1);

/** Games a side needs to win a BEST_OF group of `n` games. */
export const majorityOf = (n: number) => Math.floor(n / 2) + 1;

export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (Array.isArray(over) || typeof over !== "object" || over === null) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}
