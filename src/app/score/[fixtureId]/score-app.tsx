"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectGame, type ProjectedGame } from "@/domain/projection";
import { isPossibleCheckout, ScoringError, type Side, type VisitInput } from "@/domain/scoring";
import type { LiveGame, LiveSnapshot } from "@/server/live-service";

/**
 * The scorer's phone. Visits are queued locally (surviving refreshes and lost
 * signal), shown immediately using the same scoring engine as the server, and
 * sent in order when there's a connection. Each visit carries a unique id, so
 * a resend after a dropped connection can never be counted twice.
 */

type Pending = VisitInput & { id: string; gameOrdinal: number };

const QUICK = [26, 41, 45, 60, 81, 85, 100, 140, 180];
const storageKey = (fixtureId: string) => `dl-outbox:${fixtureId}`;

function loadOutbox(fixtureId: string): Pending[] {
  try {
    return JSON.parse(localStorage.getItem(storageKey(fixtureId)) ?? "[]");
  } catch {
    return [];
  }
}
function saveOutbox(fixtureId: string, items: Pending[]) {
  try {
    localStorage.setItem(storageKey(fixtureId), JSON.stringify(items));
  } catch {
    // Storage unavailable (private mode): the queue still works in memory.
  }
}

type PostResult = { ok: true; snapshot: LiveSnapshot } | { ok: false; status: number; error: string; code?: string };

async function post(path: string, body: unknown): Promise<PostResult> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, snapshot: data.snapshot } : { ok: false, status: res.status, error: data.error ?? "Something went wrong.", code: data.code };
}

const serverState = (g: LiveGame) => ({
  ...g,
  players: { HOME: g.players.HOME.map((p) => p.playerId), AWAY: g.players.AWAY.map((p) => p.playerId) },
});

export function ScoreApp({ initial }: { initial: LiveSnapshot }) {
  const fixtureId = initial.fixtureId;
  const [snap, setSnap] = useState(initial);
  // Rendered only in the browser (see loader.tsx), so the saved queue can be read up front.
  const [outbox, setOutbox] = useState<Pending[]>(() => loadOutbox(fixtureId));
  const outboxRef = useRef<Pending[]>(outbox);
  const [online, setOnline] = useState(true);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [entry, setEntry] = useState("");
  const [checkout, setCheckout] = useState<{ score: number } | null>(null);
  const [thrower, setThrower] = useState<Record<Side, string | null>>({ HOME: null, AWAY: null });
  const [busy, setBusy] = useState(false);
  const flushing = useRef(false);

  const [selected, setSelected] = useState<number>(() => firstOpenGame(initial));
  const game = snap.games.find((g) => g.ordinal === selected) ?? snap.games[0];

  // ---- outbox -------------------------------------------------------------

  const setQueue = useCallback(
    (items: Pending[]) => {
      outboxRef.current = items;
      setOutbox(items);
      saveOutbox(fixtureId, items);
    },
    [fixtureId],
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/fixtures/${fixtureId}/live`, { cache: "no-store" });
      if (res.ok) setSnap(await res.json());
    } catch {}
  }, [fixtureId]);

  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      while (outboxRef.current.length) {
        const item = outboxRef.current[0];
        let r: PostResult;
        try {
          r = await post(`/api/fixtures/${fixtureId}/visits`, {
            clientEventId: item.id,
            gameOrdinal: item.gameOrdinal,
            side: item.side,
            scored: item.scored,
            darts: item.darts,
            playerId: item.playerId,
          });
        } catch {
          setOnline(false);
          setTimeout(() => void flush(), 4000);
          return;
        }
        setOnline(true);
        if (r.ok) {
          setSnap(r.snapshot);
          setQueue(outboxRef.current.slice(1));
        } else if (r.status === 401) {
          setMessage({ tone: "error", text: "You've been signed out. Sign in again in another tab — your scores are saved on this phone." });
          return;
        } else if (r.status >= 500) {
          setTimeout(() => void flush(), 4000);
          return;
        } else {
          // Rejected: drop it and anything entered after it in the same game, then resync.
          const dropped = outboxRef.current.filter((p) => p.gameOrdinal === item.gameOrdinal);
          setQueue(outboxRef.current.filter((p) => p.gameOrdinal !== item.gameOrdinal));
          setMessage({ tone: "error", text: `${r.error} ${dropped.length > 1 ? `${dropped.length} entries for game ${item.gameOrdinal} need re-entering.` : "Please re-enter it."}` });
          await refresh();
        }
      }
    } finally {
      flushing.current = false;
    }
  }, [fixtureId, refresh, setQueue]);

  useEffect(() => {
    // Send anything saved on this phone from before a refresh or lost signal.
    void flush();
    const goOnline = () => (setOnline(true), void flush());
    const goOffline = () => setOnline(false);
    // Phones throttle timers while the screen is off; resend as soon as the app is visible again.
    const onVisible = () => document.visibilityState === "visible" && void flush();
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fixtureId, flush]);

  useEffect(() => {
    // Live updates (e.g. a league admin correction). Ignored while our own entries are still sending.
    const es = new EventSource(`/api/fixtures/${fixtureId}/stream`);
    es.addEventListener("snapshot", (e) => {
      if (outboxRef.current.length === 0) setSnap(JSON.parse((e as MessageEvent).data));
    });
    return () => es.close();
  }, [fixtureId]);

  // ---- projection ------------------------------------------------------------

  const pendingFor = (ordinal: number) => outbox.filter((p) => p.gameOrdinal === ordinal);
  const projected: ProjectedGame | null = useMemo(() => {
    try {
      return projectGame(serverState(game), pendingFor(game.ordinal));
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, outbox]);

  const side: Side = projected?.nextToThrow ?? "HOME";
  const sidePlayers = game.players[side];
  const throwingId = thrower[side] ?? projected?.nextPlayer[side] ?? sidePlayers[0]?.playerId ?? null;
  const remaining = projected?.remaining[side] ?? 0;

  // ---- actions ---------------------------------------------------------------

  function enqueue(scored: number, darts?: number) {
    if (!projected || projected.finished || !throwingId) return;
    const item: Pending = { id: crypto.randomUUID(), gameOrdinal: game.ordinal, side, scored, darts, playerId: throwingId };
    try {
      projectGame(serverState(game), [...pendingFor(game.ordinal), item]);
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof ScoringError ? sentence(e.message) : "That score can't be entered." });
      return;
    }
    setMessage(null);
    setEntry("");
    setCheckout(null);
    setThrower((t) => ({ ...t, [side]: null }));
    setQueue([...outboxRef.current, item]);
    void flush();
  }

  function submit(value: number) {
    if (Number.isNaN(value)) return;
    if (value === remaining) {
      const options = [1, 2, 3].filter((d) => isPossibleCheckout(value, d, game.doubleOut));
      if (!options.length) {
        setMessage({ tone: "error", text: `${value} can't be checked out.` });
        return;
      }
      setCheckout({ score: value });
      return;
    }
    enqueue(value);
  }

  async function undo() {
    setMessage(null);
    const mine = pendingFor(game.ordinal);
    if (mine.length) {
      const last = mine.at(-1)!;
      setQueue(outboxRef.current.filter((p) => p.id !== last.id));
      return;
    }
    if (!game.lastVisitId) return;
    if (!online) {
      setMessage({ tone: "info", text: "You're offline. Undo of a score that's already sent needs a connection." });
      return;
    }
    await command(`/api/fixtures/${fixtureId}/undo`, { visitClientEventId: game.lastVisitId });
  }

  async function command(path: string, body: unknown) {
    setBusy(true);
    try {
      const r = await post(path, body);
      if (r.ok) setSnap(r.snapshot);
      else setMessage({ tone: "error", text: r.error });
    } catch {
      setMessage({ tone: "error", text: "No connection. Try again when you have signal." });
    } finally {
      setBusy(false);
    }
  }

  // ---- rendering --------------------------------------------------------------

  const primary = snap.groups[0];
  const gameStarted = !!game.lastVisitId || pendingFor(game.ordinal).length > 0;
  const everyGameDone = snap.games.every((g) => {
    if (g.notRequired || ["COMPLETED", "WALKOVER", "VOID", "NOT_REQUIRED"].includes(g.status)) return true;
    try {
      return projectGame(serverState(g), pendingFor(g.ordinal)).finished;
    } catch {
      return false;
    }
  });

  if (snap.status === "COMPLETED") {
    return (
      <Shell snap={snap} online={online} pending={outbox.length}>
        <div className="space-y-4 p-4 text-center">
          <p className="text-2xl font-bold">Result confirmed</p>
          <p className="text-muted">
            {snap.home.name} {primary.homeGames} – {primary.awayGames} {snap.away.name}
          </p>
          <Link className="inline-block rounded-lg bg-accent px-4 py-3 font-semibold text-on-accent" href={`/fixtures/${fixtureId}`}>
            View match page
          </Link>
        </div>
      </Shell>
    );
  }

  if (snap.status !== "LIVE") {
    return (
      <Shell snap={snap} online={online} pending={outbox.length}>
        <div className="space-y-3 p-4 text-center">
          <p className="font-semibold">This match hasn&apos;t started.</p>
          <p className="text-sm text-muted">Both captains confirm their teams on the match page, then start it from there.</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell snap={snap} online={online} pending={outbox.length}>
      {/* Game picker */}
      <nav className="flex gap-1 overflow-x-auto border-b border-border px-2 py-2" aria-label="Games">
        {snap.games.map((g) => {
          const done = ["COMPLETED", "WALKOVER", "VOID", "NOT_REQUIRED"].includes(g.status) || g.notRequired;
          return (
            <button
              key={g.ordinal}
              onClick={() => (setSelected(g.ordinal), setMessage(null), setEntry(""), setCheckout(null))}
              className={`min-w-11 shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ${g.ordinal === selected ? "bg-accent text-on-accent" : done ? "bg-surface-muted text-muted" : "bg-surface border border-border"}`}
            >
              {g.kind === "PAIRS" ? "P" : "G"}
              {g.ordinal}
              {g.status === "WALKOVER" ? " w/o" : done && g.status === "COMPLETED" ? " ✓" : ""}
            </button>
          );
        })}
      </nav>

      {game.status === "WALKOVER" || game.notRequired || game.status === "VOID" ? (
        <p className="p-6 text-center text-muted">
          {game.status === "WALKOVER"
            ? `Walkover to ${game.winner === "HOME" ? snap.home.name : snap.away.name}.`
            : game.status === "VOID"
              ? "No players on either side; this game isn't played."
              : "The result is already decided, so this game isn't played."}
        </p>
      ) : (
        <>
          {/* Players */}
          <div className="grid grid-cols-2 gap-2 p-2">
            {(["HOME", "AWAY"] as const).map((s) => {
              const active = !projected?.finished && side === s;
              return (
                <div key={s} className={`rounded-xl border-2 p-3 ${active ? "border-accent bg-accent-soft" : "border-transparent bg-surface"}`}>
                  <div className="truncate text-sm font-semibold">{game.players[s].map((p) => p.name).join(" & ") || "—"}</div>
                  <div className="text-5xl font-bold tabular-nums leading-tight">{projected?.remaining[s] ?? "–"}</div>
                  <div className="flex justify-between text-xs text-muted">
                    <span>Legs {projected?.legsWon[s] ?? 0}</span>
                    <span>Avg {fmt(avgOf(game, s))}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="px-3 text-center text-xs text-muted">
            {game.legs > 1 ? `Leg ${projected?.legOrdinal ?? 1} · ${game.legsFormat === "BEST_OF" ? `best of ${game.legs}` : `${game.legs} legs`} · ` : ""}
            {game.startingScore}
            {game.doubleOut ? ", double out" : ""}
          </p>

          {projected?.finished ? (
            <div className="space-y-3 p-4 text-center">
              <p className="text-xl font-bold">
                {projected.winner === "DRAW"
                  ? "Game drawn"
                  : projected.winner
                    ? `${projected.winner === "HOME" ? snap.home.name : snap.away.name} win game ${game.ordinal}`
                    : `Game ${game.ordinal} finished`}
              </p>
              <p className="text-muted">
                Legs {projected.legsWon.HOME} – {projected.legsWon.AWAY}
              </p>
              <div className="flex justify-center gap-2">
                <button className="rounded-lg border border-border px-4 py-3 font-semibold" onClick={undo}>
                  Undo last score
                </button>
                {!everyGameDone && (
                  <button className="rounded-lg bg-accent px-4 py-3 font-semibold text-on-accent" onClick={() => setSelected(nextOpenGame(snap, game.ordinal))}>
                    Next game
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {!gameStarted && (
                <div className="mx-2 mb-2 rounded-lg bg-surface p-2 text-center text-sm">
                  <span className="text-muted">Throwing first: </span>
                  {(["HOME", "AWAY"] as const).map((s) => (
                    <button
                      key={s}
                      disabled={busy}
                      onClick={() => command(`/api/fixtures/${fixtureId}/first-thrower`, { gameOrdinal: game.ordinal, side: s })}
                      className={`mx-1 rounded-md px-3 py-1.5 font-semibold ${game.firstThrower === s ? "bg-accent text-on-accent" : "border border-border"}`}
                    >
                      {s === "HOME" ? snap.home.name : snap.away.name}
                    </button>
                  ))}
                </div>
              )}

              {sidePlayers.length === 2 && (
                <div className="mx-2 mb-2 flex items-center justify-center gap-2 text-sm">
                  <span className="text-muted">Throwing:</span>
                  {sidePlayers.map((p) => (
                    <button
                      key={p.playerId}
                      onClick={() => setThrower((t) => ({ ...t, [side]: p.playerId }))}
                      className={`rounded-md px-3 py-1.5 font-semibold ${throwingId === p.playerId ? "bg-accent text-on-accent" : "border border-border"}`}
                    >
                      {p.name.split(" ")[0]}
                    </button>
                  ))}
                </div>
              )}

              {message && (
                <p role="alert" className={`mx-2 mb-2 rounded-lg px-3 py-2 text-sm ${message.tone === "error" ? "bg-danger-soft text-danger" : "bg-surface-muted"}`}>
                  {message.text}
                </p>
              )}

              {checkout ? (
                <div className="space-y-3 p-3 text-center">
                  <p className="text-lg font-semibold">
                    Checkout {checkout.score}! How many darts?
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {[1, 2, 3].map((d) => (
                      <button
                        key={d}
                        disabled={!isPossibleCheckout(checkout.score, d, game.doubleOut)}
                        onClick={() => enqueue(checkout.score, d)}
                        className="rounded-xl bg-accent py-5 text-2xl font-bold text-on-accent disabled:opacity-30"
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  <button className="text-sm text-muted underline" onClick={() => setCheckout(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <Keypad
                  label={`${game.players[side].find((p) => p.playerId === throwingId)?.name ?? (side === "HOME" ? snap.home.name : snap.away.name)} to throw`}
                  entry={entry}
                  remaining={remaining}
                  onDigit={(d) => setEntry((e) => (e.length >= 3 ? e : e === "0" ? d : e + d))}
                  onBack={() => setEntry((e) => e.slice(0, -1))}
                  onSubmit={() => entry !== "" && submit(Number(entry))}
                  onQuick={submit}
                  onUndo={undo}
                />
              )}
            </>
          )}
        </>
      )}

      {everyGameDone && (
        <div className="m-2 rounded-xl border-2 border-accent bg-surface p-4 text-center">
          <p className="font-semibold">All games finished</p>
          <p className="my-1 text-2xl font-bold">
            {snap.home.name} {primary.homeGames} – {primary.awayGames} {snap.away.name}
          </p>
          {snap.groups.slice(1).map((g) => (
            <p key={g.key} className="text-sm text-muted">
              {g.name}: {g.homeGames} – {g.awayGames}
            </p>
          ))}
          <button
            disabled={busy || outbox.length > 0 || !snap.readyToComplete}
            onClick={() => command(`/api/fixtures/${fixtureId}/complete`, {})}
            className="mt-3 w-full rounded-lg bg-accent px-4 py-3 font-semibold text-on-accent disabled:opacity-50"
          >
            {outbox.length > 0 ? "Sending scores…" : "Confirm result"}
          </button>
          <p className="mt-2 text-xs text-muted">The league table updates when you confirm. Check the scoresheet first.</p>
        </div>
      )}
    </Shell>
  );
}

function Keypad(props: {
  label: string;
  entry: string;
  remaining: number;
  onDigit: (d: string) => void;
  onBack: () => void;
  onSubmit: () => void;
  onQuick: (n: number) => void;
  onUndo: () => void;
}) {
  return (
    <div className="space-y-2 p-2">
      <div className="flex items-center justify-between rounded-xl bg-surface px-4 py-2">
        <span className="truncate text-sm text-muted">{props.label}</span>
        <span className="text-4xl font-bold tabular-nums">{props.entry || "0"}</span>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {QUICK.map((n) => (
          <button key={n} onClick={() => props.onQuick(n)} className="rounded-lg bg-surface-muted py-2.5 text-sm font-semibold">
            {n}
          </button>
        ))}
        <button onClick={() => props.onQuick(props.remaining)} className="rounded-lg bg-accent-soft py-2.5 text-sm font-semibold text-accent-strong">
          Out
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} onClick={() => props.onDigit(d)} className="rounded-xl bg-surface py-4 text-2xl font-semibold shadow-sm active:bg-surface-muted">
            {d}
          </button>
        ))}
        <button onClick={props.onBack} className="rounded-xl bg-surface py-4 text-xl shadow-sm" aria-label="Delete">
          ⌫
        </button>
        <button onClick={() => props.onDigit("0")} className="rounded-xl bg-surface py-4 text-2xl font-semibold shadow-sm">
          0
        </button>
        <button onClick={props.onSubmit} className="rounded-xl bg-accent py-4 text-xl font-bold text-on-accent">
          Enter
        </button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <button onClick={() => props.onQuick(0)} className="rounded-lg border border-border py-3 text-sm font-semibold">
          No score
        </button>
        <button onClick={props.onUndo} className="rounded-lg border border-border py-3 text-sm font-semibold">
          Undo
        </button>
      </div>
    </div>
  );
}

function Shell({ snap, online, pending, children }: { snap: LiveSnapshot; online: boolean; pending: number; children: React.ReactNode }) {
  const primary = snap.groups[0];
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-md flex-col bg-background">
      <header className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
        <div className="min-w-0 text-sm">
          <div className="truncate font-semibold">
            {snap.home.name} <span className="tabular-nums">{primary?.homeGames ?? 0}–{primary?.awayGames ?? 0}</span> {snap.away.name}
          </div>
          <Link href={`/fixtures/${snap.fixtureId}`} className="text-xs text-muted underline">
            Match page
          </Link>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${!online ? "bg-warning-soft text-warning" : pending ? "bg-surface-muted text-muted" : "bg-accent-soft text-accent-strong"}`}>
          {!online ? `Offline · ${pending} saved` : pending ? `Sending ${pending}…` : "All saved"}
        </span>
      </header>
      {children}
    </div>
  );
}

function firstOpenGame(s: LiveSnapshot) {
  return (s.games.find((g) => g.status === "LIVE") ?? s.games.find((g) => g.status === "PENDING" && !g.notRequired) ?? s.games[0])?.ordinal ?? 1;
}
function nextOpenGame(s: LiveSnapshot, after: number) {
  const open = s.games.filter((g) => g.status === "PENDING" && !g.notRequired);
  return (open.find((g) => g.ordinal > after) ?? open[0] ?? s.games[0]).ordinal;
}
function avgOf(g: LiveGame, side: Side) {
  const ids = g.players[side].map((p) => p.playerId);
  const points = ids.reduce((n, id) => n + (g.stats[id]?.points ?? 0), 0);
  const darts = ids.reduce((n, id) => n + (g.stats[id]?.darts ?? 0), 0);
  return darts ? (points / darts) * 3 : null;
}
const fmt = (n: number | null) => (n === null ? "–" : n.toFixed(2));
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1) + ".";
