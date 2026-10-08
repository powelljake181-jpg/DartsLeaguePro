"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, Field, Input, Notice, Select } from "@/components/ui";
import { scheduleAction, type ScheduleActionResult } from "@/app/admin/actions";

type Division = { id: string; name: string; teamCount: number; weekday: number | null; fixtureCount: number; played: boolean };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const nice = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`));

/**
 * Choose divisions and options, preview the generated fixtures (nothing is
 * saved), try other arrangements, then publish exactly what was previewed.
 */
export function ScheduleGenerator({ seasonId, seasonStart, divisions }: { seasonId: string; seasonStart: string; divisions: Division[] }) {
  const schedulable = divisions.filter((d) => d.teamCount >= 2 && d.weekday !== null && !d.played);
  const [selected, setSelected] = useState<string[]>(schedulable.filter((d) => d.fixtureCount === 0).map((d) => d.id));
  const [startDate, setStartDate] = useState(seasonStart);
  const [meetings, setMeetings] = useState(2);
  const [kickoff, setKickoff] = useState("19:30");
  const [seed, setSeed] = useState(1);
  const [replace, setReplace] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [result, setResult] = useState<ScheduleActionResult | null>(null);
  const [openDivision, setOpenDivision] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const base = { seasonId, competitionIds: selected, startDate, meetings, kickoff };
  const preview = (nextSeed = seed) =>
    start(async () => {
      setSeed(nextSeed);
      setAcknowledge(false);
      setResult(await scheduleAction({ ...base, seed: nextSeed, publish: false, replaceExisting: false, acknowledgeConflicts: false }));
    });
  const publish = () =>
    start(async () => setResult(await scheduleAction({ ...base, seed, publish: true, replaceExisting: replace, acknowledgeConflicts: acknowledge })));
  const reset = () => setResult(null);

  const p = result?.ok && "preview" in result ? result.preview : null;
  const needsReplace = p?.existing.some((e) => e.count > 0) ?? false;

  return (
    <Card title="Generate fixtures" description="Nothing is saved until you publish.">
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Divisions</legend>
          <div className="space-y-1">
            {divisions.map((d) => {
              const disabled = !schedulable.includes(d);
              return (
                <label key={d.id} className={`flex min-h-11 items-center gap-3 rounded-lg px-2 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-surface-muted"}`}>
                  <input
                    type="checkbox"
                    className="h-5 w-5 accent-[var(--accent)]"
                    disabled={disabled}
                    checked={selected.includes(d.id)}
                    onChange={(e) => (reset(), setSelected((s) => (e.target.checked ? [...s, d.id] : s.filter((x) => x !== d.id))))}
                  />
                  <span className="flex-1">
                    <span className="font-medium">{d.name}</span>{" "}
                    <span className="text-sm text-muted">
                      {d.teamCount} teams{d.weekday !== null ? ` · ${WEEKDAYS[d.weekday]}` : ""}
                    </span>
                  </span>
                  {d.played ? <Badge tone="warning">in progress</Badge> : d.fixtureCount > 0 ? <Badge>{d.fixtureCount} fixtures</Badge> : null}
                  {d.weekday === null && <Badge tone="warning">no match night</Badge>}
                  {d.teamCount < 2 && <Badge tone="warning">needs teams</Badge>}
                </label>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-muted">Divisions sharing a night are generated together so shared venues are respected.</p>
        </fieldset>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="First match night on or after" htmlFor="sched-start">
            <Input id="sched-start" type="date" value={startDate} onChange={(e) => (reset(), setStartDate(e.target.value))} />
          </Field>
          <Field label="Teams play each other" htmlFor="sched-meet">
            <Select id="sched-meet" value={meetings} onChange={(e) => (reset(), setMeetings(Number(e.target.value)))}>
              <option value={1}>Once</option>
              <option value={2}>Twice (home and away)</option>
              <option value={3}>Three times</option>
              <option value={4}>Four times</option>
            </Select>
          </Field>
          <Field label="Kick-off" htmlFor="sched-ko">
            <Input id="sched-ko" type="time" value={kickoff} onChange={(e) => (reset(), setKickoff(e.target.value))} />
          </Field>
        </div>

        {!p && (
          <Button type="button" disabled={pending || selected.length === 0} onClick={() => preview(seed)}>
            {pending ? "Working…" : "Preview fixtures"}
          </Button>
        )}

        {result && !result.ok && (
          <div role="alert">
            <Notice tone="danger">{result.error}</Notice>
          </div>
        )}

        {result?.ok && "published" in result && (
          <Notice tone="accent">
            Published {result.published.fixtures} fixtures{result.published.replaced ? ` (replacing ${result.published.replaced})` : ""}. They&apos;re listed under Fixtures.
          </Notice>
        )}

        {p && (
          <div className="space-y-4">
            {p.result.conflicts.length === 0 ? (
              <Notice tone="accent">
                No venue clashes.{" "}
                {p.longRuns === 0 ? "No team plays more than two home or two away games in a row." : `${p.longRuns} time(s) a team plays three or more home or away games in a row.`}
              </Notice>
            ) : (
              <Notice tone="danger">
                <p className="font-semibold">
                  {p.result.conflicts.length} venue clash{p.result.conflicts.length === 1 ? "" : "es"} couldn&apos;t be avoided:
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {p.result.conflicts.slice(0, 10).map((c, i) => (
                    <li key={i}>
                      {nice(c.date)}: {c.homeTeams.map((t) => p.teamNames[t]).join(" and ")} all at home ({c.constraintName}, limit {c.maxHome})
                    </li>
                  ))}
                </ul>
                <p className="mt-1">Try another arrangement, change the dates, or relax the constraint.</p>
              </Notice>
            )}

            <div className="divide-y divide-border rounded-lg border border-border">
              {p.divisions.map((d) => {
                const mine = p.result.fixtures.filter((f) => f.divisionId === d.id);
                const byes = p.result.byes.filter((b) => b.divisionId === d.id);
                const rounds = [...new Set(mine.map((f) => f.round))].sort((a, b) => a - b);
                return (
                  <div key={d.id} className="p-3">
                    <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpenDivision(openDivision === d.id ? null : d.id)}>
                      <span>
                        <span className="font-semibold">{d.name}</span>
                        <span className="block text-sm text-muted">
                          {mine.length} fixtures · {d.rounds} weeks · {nice(d.firstDate)} to {nice(d.lastDate)}
                        </span>
                      </span>
                      <span aria-hidden className="text-muted">
                        {openDivision === d.id ? "▾" : "▸"}
                      </span>
                    </button>
                    {openDivision === d.id && (
                      <ol className="mt-3 space-y-3">
                        {rounds.map((r) => {
                          const fs = mine.filter((f) => f.round === r);
                          const bye = byes.find((b) => b.round === r);
                          return (
                            <li key={r}>
                              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                                Week {r} · {nice(fs[0]?.date ?? bye!.date)}
                              </div>
                              <ul className="mt-1 text-sm">
                                {fs.map((f, i) => (
                                  <li key={i} className="flex justify-between gap-2 py-0.5">
                                    <span className="flex-1 truncate text-right">{p.teamNames[f.home]}</span>
                                    <span className="text-muted">v</span>
                                    <span className="flex-1 truncate">{p.teamNames[f.away]}</span>
                                  </li>
                                ))}
                                {bye && <li className="text-center text-muted">{p.teamNames[bye.team]} has a bye</li>}
                              </ul>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                );
              })}
            </div>

            {needsReplace && (
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[var(--accent)]" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                Replace the existing fixtures in these divisions (none have been played).
              </label>
            )}
            {p.result.conflicts.length > 0 && (
              <label className="flex min-h-11 items-start gap-3 text-sm">
                <input type="checkbox" className="mt-0.5 h-5 w-5 accent-[var(--accent)]" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
                Publish anyway. I&apos;ll rearrange the clashing fixtures. (This is recorded in the activity log.)
              </label>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={pending || (needsReplace && !replace) || (p.result.conflicts.length > 0 && !acknowledge)}
                onClick={publish}
              >
                {pending ? "Working…" : "Publish fixtures"}
              </Button>
              <Button type="button" variant="secondary" disabled={pending} onClick={() => preview(seed + 1)}>
                Try another arrangement
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
