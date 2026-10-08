"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { Badge, Button, Card, Field, Input, Notice, Select } from "@/components/ui";
import { TIE_BREAKERS, resultGroup, rulesSchema, type GameKind, type LeagueRules, type TieBreaker } from "@/domain/rules";
import { ruleChangeAction, type RuleChangeResult } from "../../../../actions";

const TB_LABEL: Record<TieBreaker, string> = {
  POINTS: "Points",
  GAME_DIFFERENCE: "Game difference",
  GAMES_WON: "Games won",
  MATCHES_WON: "Matches won",
  HEAD_TO_HEAD: "Head-to-head",
  LEG_DIFFERENCE: "Leg difference",
};

const num = (v: string, fallback = 0) => (v === "" || Number.isNaN(Number(v)) ? fallback : Number(v));

/**
 * Edits a competition's rules as a structured form, then previews and applies
 * the change from a chosen effective date. Validation runs here for instant
 * feedback and again on the server.
 */
export function RulesEditor({
  competitionId,
  current,
  seasonStart,
  today,
}: {
  competitionId: string;
  current: LeagueRules;
  seasonStart: string;
  today: string;
}) {
  const [rules, setRules] = useState<LeagueRules>(current);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<RuleChangeResult | null>(null);
  const [pending, startTransition] = useTransition();

  const update = (fn: (draft: LeagueRules) => void) => {
    setResult(null);
    setRules((r) => {
      const draft = structuredClone(r);
      fn(draft);
      return draft;
    });
  };

  const validation = useMemo(() => rulesSchema.safeParse(rules), [rules]);
  const changed = JSON.stringify(rules) !== JSON.stringify(current);
  const hasPairs = rules.match.slots.some((s) => s.kind === "PAIRS");
  const groups = rules.match.groups;

  const submit = (apply: boolean) =>
    startTransition(async () => {
      setResult(await ruleChangeAction({ competitionId, rules, effectiveFrom, reason, apply }));
    });

  return (
    <div className="space-y-4">
      {/* Games ------------------------------------------------------------ */}
      <Card
        title="Games in a match"
        description={`${rules.match.slots.length} games: ${rules.match.slots.filter((s) => s.kind === "SINGLES").length} singles, ${rules.match.slots.filter((s) => s.kind === "PAIRS").length} pairs`}
      >
        <ol className="space-y-2">
          {rules.match.slots.map((slot, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-muted p-2">
              <span className="w-16 text-sm font-semibold">Game {i + 1}</span>
              <Select
                aria-label={`Game ${i + 1} type`}
                className="w-auto flex-1"
                value={slot.kind}
                onChange={(e) => update((d) => void (d.match.slots[i].kind = e.target.value as GameKind))}
              >
                <option value="SINGLES">Singles</option>
                <option value="PAIRS">Pairs</option>
              </Select>
              {groups.length > 1 && (
                <Select
                  aria-label={`Game ${i + 1} counts towards`}
                  className="w-auto flex-1"
                  value={slot.group}
                  onChange={(e) => update((d) => void (d.match.slots[i].group = e.target.value))}
                >
                  {groups.map((g) => (
                    <option key={g.key} value={g.key}>
                      Counts for: {g.name}
                    </option>
                  ))}
                </Select>
              )}
              <div className="flex gap-1">
                <IconButton label="Move up" disabled={i === 0} onClick={() => update((d) => swap(d.match.slots, i, i - 1))}>
                  ↑
                </IconButton>
                <IconButton label="Move down" disabled={i === rules.match.slots.length - 1} onClick={() => update((d) => swap(d.match.slots, i, i + 1))}>
                  ↓
                </IconButton>
                <IconButton label="Remove game" disabled={rules.match.slots.length === 1} onClick={() => update((d) => void d.match.slots.splice(i, 1))}>
                  ✕
                </IconButton>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" type="button" onClick={() => update((d) => void d.match.slots.push({ kind: "SINGLES", group: d.match.groups[0].key }))}>
            + Singles game
          </Button>
          <Button variant="secondary" type="button" onClick={() => update((d) => void d.match.slots.push({ kind: "PAIRS", group: d.match.groups[0].key }))}>
            + Pairs game
          </Button>
        </div>
      </Card>

      {/* Results & tables -------------------------------------------------- */}
      {groups.map((g, gi) => {
        const games = rules.match.slots.filter((s) => s.group === g.key).length;
        const unused = TIE_BREAKERS.filter((t) => !g.tieBreakers.includes(t));
        return (
          <Card
            key={g.key}
            title={gi === 0 ? `Main result: ${g.name}` : `Separate table: ${g.name}`}
            description={`${games} game${games === 1 ? "" : "s"} count towards this table.`}
            actions={
              gi > 0 && (
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() =>
                    update((d) => {
                      d.match.slots.forEach((s) => s.group === g.key && (s.group = d.match.groups[0].key));
                      d.match.groups.splice(gi, 1);
                    })
                  }
                >
                  Remove table
                </Button>
              )
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Table name" htmlFor={`g-name-${g.key}`}>
                <Input id={`g-name-${g.key}`} value={g.name} onChange={(e) => update((d) => void (d.match.groups[gi].name = e.target.value))} />
              </Field>
              <Field label="How the result is decided" htmlFor={`g-format-${g.key}`}>
                <Select
                  id={`g-format-${g.key}`}
                  value={g.format}
                  onChange={(e) =>
                    update((d) => {
                      d.match.groups[gi].format = e.target.value as "FIXED" | "BEST_OF";
                      if (e.target.value === "BEST_OF") d.match.groups[gi].allowDraw = false;
                    })
                  }
                >
                  <option value="FIXED">Every game is played</option>
                  <option value="BEST_OF">Best of: stop once it&apos;s decided</option>
                </Select>
              </Field>
              {g.format === "FIXED" ? (
                <Checkbox label="A match can be drawn" checked={g.allowDraw} onChange={(v) => update((d) => void (d.match.groups[gi].allowDraw = v))} />
              ) : (
                <Field label="Once decided" htmlFor={`g-dead-${g.key}`}>
                  <Select id={`g-dead-${g.key}`} value={g.deadRubbers} onChange={(e) => update((d) => void (d.match.groups[gi].deadRubbers = e.target.value as "SKIP" | "PLAY_FOR_STATS"))}>
                    <option value="SKIP">Remaining games aren&apos;t played</option>
                    <option value="PLAY_FOR_STATS">Remaining games are played for statistics only</option>
                  </Select>
                </Field>
              )}
            </div>

            <h3 className="mt-5 mb-2 text-sm font-semibold">Points</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ["win", "For a win"],
                  ["draw", "For a draw"],
                  ["loss", "For a loss"],
                  ["perGameWon", "Per game won"],
                ] as const
              ).map(([k, label]) => (
                <Field key={k} label={label} htmlFor={`g-${k}-${g.key}`}>
                  <Input
                    id={`g-${k}-${g.key}`}
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={g.points[k]}
                    disabled={k === "draw" && !g.allowDraw}
                    onChange={(e) => update((d) => void (d.match.groups[gi].points[k] = num(e.target.value)))}
                  />
                </Field>
              ))}
            </div>
            {games > 0 && <PointsExample games={games} points={g.points} />}

            <h3 className="mt-5 mb-2 text-sm font-semibold">When teams are level on points</h3>
            <ol className="space-y-1">
              {g.tieBreakers.map((t, ti) => (
                <li key={t} className="flex items-center gap-2 rounded-lg bg-surface-muted px-3 py-1.5">
                  <span className="w-5 text-sm text-muted">{ti + 1}</span>
                  <span className="flex-1 text-sm font-medium">{TB_LABEL[t]}</span>
                  {ti > 0 && (
                    <div className="flex gap-1">
                      <IconButton label="Move up" disabled={ti === 1} onClick={() => update((d) => swap(d.match.groups[gi].tieBreakers, ti, ti - 1))}>
                        ↑
                      </IconButton>
                      <IconButton label="Move down" disabled={ti === g.tieBreakers.length - 1} onClick={() => update((d) => swap(d.match.groups[gi].tieBreakers, ti, ti + 1))}>
                        ↓
                      </IconButton>
                      <IconButton label="Remove" onClick={() => update((d) => void d.match.groups[gi].tieBreakers.splice(ti, 1))}>
                        ✕
                      </IconButton>
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {unused.length > 0 && (
              <Select
                aria-label="Add a tie-breaker"
                className="mt-2"
                value=""
                onChange={(e) => e.target.value && update((d) => void d.match.groups[gi].tieBreakers.push(e.target.value as TieBreaker))}
              >
                <option value="">+ Add a tie-breaker…</option>
                {unused.map((t) => (
                  <option key={t} value={t}>
                    {TB_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Card>
        );
      })}
      <Button
        variant="secondary"
        type="button"
        onClick={() =>
          update((d) => {
            let n = d.match.groups.length + 1;
            while (d.match.groups.some((x) => x.key === `table-${n}`)) n++;
            d.match.groups.push(resultGroup({ key: `table-${n}`, name: hasPairs ? "Pairs" : `Table ${n}`, points: { win: 1, draw: 0, loss: 0, perGameWon: 0 } }));
          })
        }
      >
        + Add a separate table (e.g. a pairs table)
      </Button>

      {/* Game format ------------------------------------------------------- */}
      <Card title="Game format">
        <div className={`grid gap-4 ${hasPairs ? "sm:grid-cols-2" : ""}`}>
          {(hasPairs ? (["singles", "pairs"] as const) : (["singles"] as const)).map((kind) => {
            const gc = rules.game[kind];
            return (
              <div key={kind} className="space-y-3">
                {hasPairs && <h3 className="text-sm font-semibold capitalize">{kind}</h3>}
                <Field label="Starting score" htmlFor={`gc-start-${kind}`}>
                  <Select id={`gc-start-${kind}`} value={gc.startingScore} onChange={(e) => update((d) => void (d.game[kind].startingScore = num(e.target.value, 501)))}>
                    {[301, 501, 701, 1001].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Legs" htmlFor={`gc-legsfmt-${kind}`}>
                    <Select id={`gc-legsfmt-${kind}`} value={gc.legsFormat} onChange={(e) => update((d) => void (d.game[kind].legsFormat = e.target.value as "BEST_OF" | "FIXED"))}>
                      <option value="BEST_OF">Best of</option>
                      <option value="FIXED">Exactly</option>
                    </Select>
                  </Field>
                  <Field label="Number" htmlFor={`gc-legs-${kind}`}>
                    <Input id={`gc-legs-${kind}`} type="number" min={1} max={21} inputMode="numeric" value={gc.legs} onChange={(e) => update((d) => void (d.game[kind].legs = num(e.target.value, 1)))} />
                  </Field>
                </div>
                <Checkbox label="Finish on a double" checked={gc.doubleOut} onChange={(v) => update((d) => void (d.game[kind].doubleOut = v))} />
              </div>
            );
          })}
        </div>
      </Card>

      {/* Players, walkovers, scoring, stats --------------------------------- */}
      <Card title="Players and walkovers">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Singles games per player per match" htmlFor="max-singles">
            <Input id="max-singles" type="number" min={1} max={30} inputMode="numeric" value={rules.match.maxSinglesPerPlayer} onChange={(e) => update((d) => void (d.match.maxSinglesPerPlayer = num(e.target.value, 1)))} />
          </Field>
          {hasPairs && (
            <Field label="Pairs games per player per match" htmlFor="max-pairs">
              <Input id="max-pairs" type="number" min={1} max={30} inputMode="numeric" value={rules.match.maxPairsPerPlayer} onChange={(e) => update((d) => void (d.match.maxPairsPerPlayer = num(e.target.value, 1)))} />
            </Field>
          )}
        </div>
        <div className="mt-4 space-y-2">
          <p className="text-sm text-muted">When a team can&apos;t field a player and the game is given to the other team:</p>
          <Checkbox label="It counts as a game won" checked={rules.walkover.countsAsGameWon} onChange={(v) => update((d) => void (d.walkover.countsAsGameWon = v))} />
          <Checkbox label="It earns the per-game point" checked={rules.walkover.earnsGamePoints} onChange={(v) => update((d) => void (d.walkover.earnsGamePoints = v))} />
          <Checkbox
            label="The player who turned up gets a win on their record"
            checked={rules.walkover.playerRecord === "WIN_FOR_PRESENT_PLAYER"}
            onChange={(v) => update((d) => void (d.walkover.playerRecord = v ? "WIN_FOR_PRESENT_PLAYER" : "NONE"))}
          />
          <p className="text-xs text-muted">Walkovers never affect averages, 180s or checkouts.</p>
        </div>
      </Card>

      <Card title="Scoring and statistics">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Who enters the official score" htmlFor="scorer">
            <Select id="scorer" value={rules.scoring.responsibleSide} onChange={(e) => update((d) => void (d.scoring.responsibleSide = e.target.value as "HOME" | "AWAY"))}>
              <option value="HOME">Home team</option>
              <option value="AWAY">Away team</option>
            </Select>
          </Field>
          <Field label="Games needed to appear in leaderboards" htmlFor="min-games">
            <Input id="min-games" type="number" min={0} inputMode="numeric" value={rules.stats.leaderboardMinGames} onChange={(e) => update((d) => void (d.stats.leaderboardMinGames = num(e.target.value)))} />
          </Field>
        </div>
      </Card>

      {/* Apply -------------------------------------------------------------- */}
      <Card title="Save these rules" className="border-accent/40">
        {!validation.success && (
          <div className="mb-4">
            <Notice tone="danger">
              <p className="font-semibold">Fix these first:</p>
              <ul className="mt-1 list-disc pl-5">
                {[...new Set(validation.error.issues.map((i) => i.message))].map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Notice>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="These rules apply from" htmlFor="effective" hint="Fixtures before this date keep the rules they were played under. A past date re-scores fixtures since then.">
            <Input id="effective" type="date" value={effectiveFrom} onChange={(e) => (setResult(null), setEffectiveFrom(e.target.value))} />
            <div className="mt-2 flex gap-2">
              <button type="button" className="text-sm text-accent underline" onClick={() => (setResult(null), setEffectiveFrom(today))}>
                Today
              </button>
              <button type="button" className="text-sm text-accent underline" onClick={() => (setResult(null), setEffectiveFrom(seasonStart))}>
                Start of season
              </button>
            </div>
          </Field>
          <Field label="Reason" htmlFor="reason" hint="Recorded in the activity log, e.g. 'Agreed at the AGM'.">
            <Input id="reason" value={reason} onChange={(e) => (setResult(null), setReason(e.target.value))} />
          </Field>
        </div>

        {result && !result.ok && (
          <div className="mt-4" role="alert">
            <Notice tone="danger">{result.error}</Notice>
          </div>
        )}
        {result?.ok && <PreviewSummary result={result} />}

        <div className="mt-4 flex flex-wrap gap-2">
          {result?.ok && !result.applied && result.preview.blockingFixtures.length === 0 ? (
            <>
              <Button type="button" disabled={pending} onClick={() => submit(true)}>
                {pending ? "Saving…" : "Confirm and apply"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setResult(null)}>
                Back to editing
              </Button>
            </>
          ) : (
            !result?.ok || !result.applied ? (
              <Button type="button" disabled={pending || !validation.success || !changed || !effectiveFrom || !reason.trim()} onClick={() => submit(false)}>
                {pending ? "Checking…" : "Preview the effect"}
              </Button>
            ) : null
          )}
        </div>
        {!changed && <p className="mt-2 text-sm text-muted">Make a change above to save new rules.</p>}
      </Card>
    </div>
  );
}

function PreviewSummary({ result }: { result: Extract<RuleChangeResult, { ok: true }> }) {
  const p = result.preview;
  const range = `from ${longDate(p.effectiveFrom)}${p.until ? ` until ${longDate(p.until)} (when a later change takes over)` : " for the rest of the season"}`;
  if (result.applied) {
    return (
      <div className="mt-4">
        <Notice tone="accent">
          Saved. These rules apply {range}. {p.recalculatedFixtures.length > 0 && `${p.recalculatedFixtures.length} completed fixture(s) were re-scored.`}
        </Notice>
      </div>
    );
  }
  const before = p.tables.before[0]?.rows ?? [];
  const after = p.tables.after[0]?.rows ?? [];
  const moved = after
    .map((a) => ({ a, b: before.find((b) => b.entryId === a.entryId) }))
    .filter(({ a, b }) => b && (a.points !== b.points || a.position !== b.position));
  return (
    <div className="mt-4 space-y-3">
      {p.blockingFixtures.length > 0 ? (
        <Notice tone="danger">
          This changes how matches are played ({p.structural.join(", ")}), so it can&apos;t cover the {p.blockingFixtures.length} fixture(s) already played from{" "}
          {longDate(p.effectiveFrom)}. Choose a date after {longDate(p.blockingFixtures.map((f) => f.date).sort().at(-1)!)}.
        </Notice>
      ) : (
        <Notice tone={p.retrospective ? "warning" : "accent"}>
          These rules will apply {range}.{p.retrospective && " This date is in the past, so fixtures since then are recalculated."}
        </Notice>
      )}
      <Section title="What changes">{p.changes.length ? p.changes.join(", ") : "Nothing that affects results."}</Section>
      {p.recalculatedFixtures.length > 0 && <Section title="Re-scored">{p.recalculatedFixtures.length} completed fixture(s).</Section>}
      {p.lineupsReset.length > 0 && <Section title="Lineups to re-enter">{p.lineupsReset.length} upcoming fixture(s) had team selections under the old format; captains will need to pick again.</Section>}
      {moved.length > 0 && (
        <Section title="Table changes">
          <ul className="space-y-1">
            {moved.map(({ a, b }) => (
              <li key={a.entryId} className="flex items-center justify-between gap-2">
                <span>{a.name}</span>
                <span className="tabular-nums text-muted">
                  {b!.points} → <strong className="text-foreground">{a.points}</strong> pts
                  {a.position !== b!.position && <Badge tone="warning">{`${ordinal(b!.position)} → ${ordinal(a.position)}`}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ordinal(n: number) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** "a 4–3 win earns 11; the losers earn 3", using this table's own number of games. */
function PointsExample({ games, points }: { games: number; points: LeagueRules["match"]["groups"][number]["points"] }) {
  const w = Math.floor(games / 2) + 1;
  const l = games - w;
  return (
    <p className="mt-2 text-xs text-muted">
      Example: a {w}–{l} win earns {points.win + w * points.perGameWon}; the losers earn {points.loss + l * points.perGameWon}.
    </p>
  );
}

const longDate = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="text-sm">
      <div className="font-semibold">{title}</div>
      <div className="text-muted">{children}</div>
    </div>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
      <input type="checkbox" className="h-5 w-5 accent-[var(--accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function IconButton({ label, children, ...props }: { label: string; children: ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} className="grid h-9 w-9 place-items-center rounded-md border border-border bg-surface text-sm disabled:opacity-30" {...props}>
      {children}
    </button>
  );
}

function swap<T>(arr: T[], i: number, j: number) {
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
