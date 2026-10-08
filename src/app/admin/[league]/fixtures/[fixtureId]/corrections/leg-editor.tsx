"use client";

import { useState } from "react";
import { ActionForm } from "@/components/form";
import { Field, Input, inputStyles } from "@/components/ui";
import { correctLegAction } from "@/app/admin/fixture-actions";

type Side = "HOME" | "AWAY";
export interface EditableVisit {
  side: Side;
  playerId: string;
  scored: number | "";
  darts: number | null | "";
  isBust?: boolean;
  isCheckout?: boolean;
}

/**
 * Edit one leg's visits in throw order. The server re-checks the whole leg
 * through the scoring engine (busts, checkouts, finishing on a double), so
 * anything impossible is refused with a message rather than saved.
 */
export function LegEditor({
  fixtureId,
  gameOrdinal,
  legOrdinal,
  players,
  initial,
  names,
}: {
  fixtureId: string;
  gameOrdinal: number;
  legOrdinal: number;
  players: { side: Side; playerId: string; name: string }[];
  initial: EditableVisit[];
  names: Record<Side, string>;
}) {
  const [rows, setRows] = useState<EditableVisit[]>(initial);
  const pairs = players.filter((p) => p.side === "HOME").length > 1 || players.filter((p) => p.side === "AWAY").length > 1;
  const firstOf = (side: Side) => players.find((p) => p.side === side)?.playerId ?? "";
  const update = (i: number, patch: Partial<EditableVisit>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addRow = () =>
    setRows((r) => {
      const side: Side = r.length ? (r[r.length - 1].side === "HOME" ? "AWAY" : "HOME") : "HOME";
      return [...r, { side, playerId: firstOf(side), scored: "", darts: "" }];
    });
  const totals = { HOME: 0, AWAY: 0 };

  return (
    <ActionForm action={correctLegAction} submitLabel={`Save leg ${legOrdinal}`} className="space-y-3">
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <input type="hidden" name="gameOrdinal" value={gameOrdinal} />
      <input type="hidden" name="legOrdinal" value={legOrdinal} />
      <input type="hidden" name="visits" value={JSON.stringify(rows.map((r) => ({ side: r.side, playerId: r.playerId, scored: r.scored, darts: r.darts ?? "" })))} />
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="px-1 py-1 text-left font-medium">#</th>
              <th className="px-1 py-1 text-left font-medium">Team</th>
              {pairs && <th className="px-1 py-1 text-left font-medium">Thrower</th>}
              <th className="px-1 py-1 text-left font-medium">Scored</th>
              <th className="px-1 py-1 text-left font-medium" title="Only needed for a checkout or a bust">
                Darts
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              totals[r.side] += Number(r.scored) || 0;
              return (
                <tr key={i} className="border-t border-border">
                  <td className="px-1 py-1 text-muted tabular-nums">{i + 1}</td>
                  <td className="px-1 py-1">
                    <select
                      aria-label={`Visit ${i + 1} team`}
                      className={`${inputStyles} min-h-9 py-0 text-sm`}
                      value={r.side}
                      onChange={(e) => update(i, { side: e.target.value as Side, playerId: firstOf(e.target.value as Side) })}
                    >
                      <option value="HOME">{names.HOME}</option>
                      <option value="AWAY">{names.AWAY}</option>
                    </select>
                  </td>
                  {pairs && (
                    <td className="px-1 py-1">
                      <select aria-label={`Visit ${i + 1} thrower`} className={`${inputStyles} min-h-9 py-0 text-sm`} value={r.playerId} onChange={(e) => update(i, { playerId: e.target.value })}>
                        {players
                          .filter((p) => p.side === r.side)
                          .map((p) => (
                            <option key={p.playerId} value={p.playerId}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </td>
                  )}
                  <td className="px-1 py-1">
                    <input
                      aria-label={`Visit ${i + 1} scored`}
                      className={`${inputStyles} min-h-9 w-20 text-sm tabular-nums`}
                      inputMode="numeric"
                      value={r.scored}
                      onChange={(e) => update(i, { scored: e.target.value === "" ? "" : Number(e.target.value.replace(/\D/g, "")) })}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <select aria-label={`Visit ${i + 1} darts`} className={`${inputStyles} min-h-9 w-16 py-0 text-sm`} value={r.darts ?? ""} onChange={(e) => update(i, { darts: e.target.value === "" ? "" : Number(e.target.value) })}>
                      <option value="">–</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                    </select>
                  </td>
                  <td className="px-1 py-1 text-right">
                    <button type="button" className="rounded px-2 py-1 text-muted hover:text-danger" aria-label={`Remove visit ${i + 1}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground" onClick={addRow}>
          + Add visit
        </button>
        <span className="tabular-nums">
          Entered: {names.HOME} {totals.HOME} · {names.AWAY} {totals.AWAY}
        </span>
      </div>
      <Field label="Reason" htmlFor={`reason-${gameOrdinal}-${legOrdinal}`} hint="Both teams will see this.">
        <Input id={`reason-${gameOrdinal}-${legOrdinal}`} name="reason" required maxLength={500} placeholder="e.g. 140 was entered as 104" />
      </Field>
    </ActionForm>
  );
}
