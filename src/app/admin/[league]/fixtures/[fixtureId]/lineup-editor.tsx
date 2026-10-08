"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Card, Notice, Select } from "@/components/ui";
import { saveLineupAction } from "@/app/admin/actions";

type Kind = "SINGLES" | "PAIRS";

/**
 * Pick who plays each game. Leave a game empty if no player is available:
 * it becomes a walkover to the other team when the match starts.
 */
export function LineupEditor({
  fixtureId,
  side,
  teamName,
  slots,
  groupNames,
  squad,
  initial,
  confirmed,
  editable,
  maxSingles,
  maxPairs,
}: {
  fixtureId: string;
  side: "HOME" | "AWAY";
  teamName: string;
  slots: { kind: Kind; group: string }[];
  groupNames: Record<string, string>;
  squad: { registrationId: string; name: string }[];
  initial: string[][];
  confirmed: boolean;
  editable: boolean;
  maxSingles: number;
  maxPairs: number;
}) {
  const router = useRouter();
  const [picks, setPicks] = useState<string[][]>(() => slots.map((s, i) => padded(initial[i] ?? [], s.kind)));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const showGroups = new Set(slots.map((s) => s.group)).size > 1;

  const uses = (regId: string, kind: Kind) => picks.filter((p, i) => slots[i].kind === kind && p.includes(regId)).length;
  const half = picks.findIndex((p, i) => slots[i].kind === "PAIRS" && p.filter(Boolean).length === 1);
  const save = (confirm: boolean) =>
    start(async () => {
      setError(null);
      if (half >= 0) {
        setError(`Game ${half + 1}: pick both pairs players, or neither for a walkover.`);
        return;
      }
      const r = await saveLineupAction({
        fixtureId,
        side,
        confirm,
        slots: picks.map((p, i) => ({ gameOrdinal: i + 1, registrationIds: p.filter(Boolean) })),
      });
      if (!r.ok) setError(r.error);
      else router.refresh();
    });

  const empty = picks.filter((p) => p.filter(Boolean).length === 0).length;

  return (
    <Card
      title={teamName}
      description={side === "HOME" ? "Home" : "Away"}
      actions={confirmed ? <Badge tone="accent">Confirmed</Badge> : <Badge tone="warning">Not confirmed</Badge>}
    >
      <ol className="space-y-2">
        {slots.map((slot, i) => (
          <li key={i} className="rounded-lg bg-surface-muted p-2">
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Game {i + 1} · {slot.kind === "PAIRS" ? "Pairs" : "Singles"}
              {showGroups && <span className="normal-case">({groupNames[slot.group]})</span>}
            </div>
            <div className={`grid gap-2 ${slot.kind === "PAIRS" ? "grid-cols-2" : ""}`}>
              {picks[i].map((value, k) => (
                <Select
                  key={k}
                  aria-label={`Game ${i + 1} player ${k + 1}`}
                  value={value}
                  disabled={!editable || pending}
                  onChange={(e) =>
                    setPicks((all) => all.map((p, j) => (j === i ? p.map((v, m) => (m === k ? e.target.value : v)) : p)))
                  }
                >
                  <option value="">{slot.kind === "PAIRS" ? `Player ${k + 1}…` : "Choose player…"}</option>
                  {squad.map((pl) => {
                    const limit = slot.kind === "PAIRS" ? maxPairs : maxSingles;
                    const full = uses(pl.registrationId, slot.kind) >= limit && value !== pl.registrationId;
                    const sameGame = picks[i].includes(pl.registrationId) && value !== pl.registrationId;
                    return (
                      <option key={pl.registrationId} value={pl.registrationId} disabled={full || sameGame}>
                        {pl.name}
                        {full ? " (already playing)" : ""}
                      </option>
                    );
                  })}
                </Select>
              ))}
            </div>
          </li>
        ))}
      </ol>
      {editable && (
        <div className="mt-4 space-y-3">
          {empty > 0 && (
            <Notice tone="warning">
              {empty} game{empty === 1 ? " has" : "s have"} no player{empty === 1 ? "" : "s"}. {empty === 1 ? "It" : "They"} will be given to the other team as a walkover.
            </Notice>
          )}
          {error && (
            <div role="alert">
              <Notice tone="danger">{error}</Notice>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={pending} onClick={() => save(true)}>
              {pending ? "Saving…" : confirmed ? "Save changes" : "Confirm team"}
            </Button>
            {!confirmed && (
              <Button type="button" variant="secondary" disabled={pending} onClick={() => save(false)}>
                Save draft
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function padded(ids: string[], kind: Kind): string[] {
  const n = kind === "PAIRS" ? 2 : 1;
  return Array.from({ length: n }, (_, i) => ids[i] ?? "");
}
