"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button, Notice, inputStyles } from "@/components/ui";
import { drawAction, type DrawFormState } from "@/app/admin/cup-actions";
import type { DrawMode } from "@/domain/cups";

const MODES: { value: DrawMode; label: string; hint: string }[] = [
  { value: "RANDOM", label: "Random", hint: "Every team drawn out of the hat." },
  { value: "SEEDED", label: "Seeded", hint: "Seeded teams are kept apart (1 and 2 can only meet in the final) and get any byes first; the rest are drawn at random." },
  { value: "MANUAL", label: "Set it myself", hint: "For a draw made on the night: enter each tie in order." },
];

/** Choose how to draw, preview it, then confirm exactly that draw. */
export function DrawForm({ competitionId, entrants, firstRoundTies, redraw }: { competitionId: string; entrants: { id: string; name: string }[]; firstRoundTies: number; redraw: boolean }) {
  const [state, action] = useActionState<DrawFormState, FormData>(drawAction, {});
  const [mode, setMode] = useState<DrawMode>("RANDOM");
  const [ties, setTies] = useState<{ home: string; away: string }[]>(() => Array.from({ length: firstRoundTies }, () => ({ home: "", away: "" })));
  if (state.ok) return <Notice tone="accent">{state.message}</Notice>;
  const picked = new Set(ties.flatMap((t) => [t.home, t.away]).filter(Boolean));
  const setTie = (i: number, side: "home" | "away", v: string) => setTies((x) => x.map((t, j) => (j === i ? { ...t, [side]: v } : t)));
  const previewMatches = state.preview && state.mode === mode;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="competitionId" value={competitionId} />
      {redraw && <Notice tone="warning">Nothing has been played yet, so you can make the draw again. The current ties will be replaced.</Notice>}
      <div className="space-y-2">
        {MODES.map((m) => (
          <label key={m.value} className="flex gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} className="mt-1" />
            <span>
              <span className="block font-medium">{m.label}</span>
              <span className="text-sm text-muted">{m.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === "MANUAL" && (
        <ol className="space-y-2">
          {ties.map((t, i) => (
            <li key={i} className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-2 text-sm">
              <span className="w-6 text-right text-muted tabular-nums">{i + 1}.</span>
              {(["home", "away"] as const).map((side, k) => (
                <span key={side} className="contents">
                  {k === 1 && <span className="text-muted">v</span>}
                  <select
                    name={`${side}:${i}`}
                    aria-label={`Tie ${i + 1} ${side}`}
                    className={`${inputStyles} min-h-10 py-0 text-sm`}
                    value={t[side]}
                    onChange={(e) => setTie(i, side, e.target.value)}
                  >
                    <option value="">{side === "away" ? "Bye" : "Choose…"}</option>
                    {entrants.map((e) => (
                      <option key={e.id} value={e.id} disabled={picked.has(e.id) && t[side] !== e.id}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                </span>
              ))}
            </li>
          ))}
        </ol>
      )}

      {state.error && (
        <div role="alert">
          <Notice tone="danger">{state.error}</Notice>
        </div>
      )}

      {previewMatches && state.preview && (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-sm font-medium">First round{mode !== "MANUAL" && " (nothing saved yet — preview again for a different draw)"}</p>
          <ol className="space-y-1 text-sm">
            {state.preview.ties.map((t, i) => (
              <li key={i}>
                <span className="text-muted tabular-nums">{i + 1}.</span> <strong>{t.home}</strong> {t.away ? <>v <strong>{t.away}</strong></> : <span className="text-muted">— bye to the next round</span>}
              </li>
            ))}
          </ol>
          {state.preview.rngSeed !== null && <input type="hidden" name="rngSeed" value={state.preview.rngSeed} />}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Submit intent="preview" variant={previewMatches ? "secondary" : "primary"}>
          {previewMatches ? (mode === "MANUAL" ? "Check again" : "Draw again") : "Preview the draw"}
        </Submit>
        {previewMatches && <Submit intent="apply" variant="primary">Confirm this draw</Submit>}
      </div>
    </form>
  );
}

function Submit({ intent, variant, children }: { intent: string; variant: "primary" | "secondary"; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" name="intent" value={intent} variant={variant} disabled={pending}>
      {pending ? "Working…" : children}
    </Button>
  );
}
