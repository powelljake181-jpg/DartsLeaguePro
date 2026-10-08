"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Button, Card, Field, Input, Notice } from "@/components/ui";
import { foldAction, type FoldFormState } from "@/app/admin/fixture-actions";
import type { Table } from "@/server/standings-service";

const RESULTS = [
  { value: "MAX_LOSS_REMAINING", label: "Award their remaining fixtures to the opponents", hint: "Results already played stand. Opponents get a maximum win for each unplayed fixture." },
  { value: "VOID_ALL", label: "Void all their fixtures", hint: "Every match involving them stops counting, played ones included." },
  { value: "MAX_LOSS_ALL", label: "Award every fixture to the opponents", hint: "Matches already played are replaced by a maximum win for the opponents too (e.g. 7–0)." },
] as const;

/** Choose a treatment, preview the exact changes and the table, then confirm. */
export function FoldForm({ entryId, team, dateFmt, cup }: { entryId: string; team: string; dateFmt: Record<string, string>; cup?: boolean }) {
  const [state, action] = useActionState<FoldFormState, FormData>(foldAction, {});
  const input = state.input;
  if (state.ok) return <Notice tone="accent">{state.message}</Notice>;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="entryId" value={entryId} />
      {cup ? (
        <Card title="What happens">
          <p className="text-sm">
            Their next tie goes to the opponent, who goes through. Ties they have already won stand. If their next opponent isn&apos;t known yet, the tie is awarded as soon as it is.
          </p>
          <input type="hidden" name="results" value="MAX_LOSS_REMAINING" />
        </Card>
      ) : (
      <Card title="What happens to their fixtures">
        <div className="space-y-2">
          {RESULTS.map((r) => (
            <label key={r.value} className="flex gap-3 rounded-lg border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
              <input type="radio" name="results" value={r.value} defaultChecked={(input?.results ?? "MAX_LOSS_REMAINING") === r.value} className="mt-1" />
              <span>
                <span className="block font-medium">{r.label}</span>
                <span className="text-sm text-muted">{r.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </Card>
      )}
      <Card
        title="Players' statistics from matches already played"
        description="For matches that were played and are now voided or awarded. Played results that stand always keep their statistics."
      >
        <div className="space-y-2 text-sm">
          <label className="flex items-start gap-2">
            <input type="radio" name="playerStats" value="KEEP" className="mt-1" defaultChecked={(input?.playerStats ?? "KEEP") === "KEEP"} />
            <span>
              <span className="font-medium">Keep them.</span> Averages, 180s, checkouts and each player&apos;s own game wins and losses from those matches still count.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="playerStats" value="EXCLUDE" className="mt-1" defaultChecked={input?.playerStats === "EXCLUDE"} />
            <span>
              <span className="font-medium">Void them.</span> Those matches are left out of every player&apos;s statistics, for both teams.
            </span>
          </label>
        </div>
      </Card>
      <Field label="Reason" htmlFor="fold-reason" hint="Every team in the division will see this.">
        <Input id="fold-reason" name="reason" maxLength={500} defaultValue={input?.reason} placeholder="e.g. The pub has closed" />
      </Field>
      {state.error && (
        <div role="alert">
          <Notice tone="danger">{state.error}</Notice>
        </div>
      )}
      {state.preview && (
        <Card title="This will change" description={`${state.preview.changes.length} fixture(s). Nothing has been changed yet.`}>
          {state.preview.changes.length === 0 ? (
            <p className="text-sm text-muted">No fixtures need changing.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {state.preview.changes.map((c) => (
                <li key={c.fixtureId} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    <span className="text-muted">{dateFmt[c.date] ?? c.date}</span> · {c.home} v {c.away}
                  </span>
                  <span className="text-right">
                    <span className="font-medium">{c.awardedTo ? `awarded to ${c.awardedTo}` : c.to === "VOID" ? "void" : c.to.toLowerCase()}</span>
                    {c.played && <span className="block text-xs text-muted">played · player stats {c.statsKept ? "kept" : "voided"}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!cup && (
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <MiniTable title="Table now" table={state.preview.tablesBefore[0]} />
              <MiniTable title="After the fold" table={state.preview.tablesAfter[0]} highlight={team} />
            </div>
          )}
        </Card>
      )}
      <div className="flex flex-wrap gap-2">
        <Submit intent="preview" variant={state.preview ? "secondary" : "primary"}>
          {state.preview ? "Preview again" : "Preview"}
        </Submit>
        {state.preview && (
          <Submit intent="apply" variant="danger">
            {cup ? `Withdraw ${team}` : `Fold ${team}`}
          </Submit>
        )}
      </div>
    </form>
  );
}

function Submit({ intent, variant, children }: { intent: string; variant: "primary" | "secondary" | "danger"; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" name="intent" value={intent} variant={variant} disabled={pending}>
      {pending ? "Working…" : children}
    </Button>
  );
}

function MiniTable({ title, table, highlight }: { title: string; table?: Table; highlight?: string }) {
  if (!table) return null;
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      <table className="w-full text-right text-sm tabular-nums">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1 text-left font-medium">Team</th>
            <th className="font-medium">P</th>
            <th className="font-medium">Pts</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.entryId} className={`border-t border-border ${r.name === highlight ? "text-muted" : ""}`}>
              <td className="py-1 text-left">
                {r.withdrawn ? "–" : r.position}. {r.name}
              </td>
              <td>{r.played}</td>
              <td className="font-semibold">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
