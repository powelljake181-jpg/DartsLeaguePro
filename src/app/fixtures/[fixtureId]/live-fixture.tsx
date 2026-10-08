"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { LiveGame, LiveSnapshot } from "@/server/live-service";

/** Public match view. Subscribes to live updates; spectators never need to refresh. */
export function LiveFixture({ initial }: { initial: LiveSnapshot }) {
  const [snap, setSnap] = useState(initial);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    if (initial.status === "COMPLETED" || initial.status === "VOID" || initial.status === "CANCELLED") return;
    const es = new EventSource(`/api/fixtures/${initial.fixtureId}/stream`);
    es.addEventListener("snapshot", (e) => {
      setSnap(JSON.parse((e as MessageEvent).data));
      setConnected(true);
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [initial.fixtureId, initial.status]);

  const primary = snap.groups[0];
  const live = snap.status === "LIVE";
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: snap.league.timezone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(new Date(snap.scheduledAt));
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-border bg-surface p-4 text-center shadow-sm sm:p-6">
        <div className="mb-3 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
          <span>{snap.competitionName}</span>
          {live && (
            <span className="inline-flex items-center gap-1 rounded-full bg-live px-2 py-0.5 text-white">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" /> Live
            </span>
          )}
          {snap.status === "COMPLETED" && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-accent-strong">Full time</span>}
          {!["LIVE", "COMPLETED"].includes(snap.status) && <span className="rounded-full bg-surface-muted px-2 py-0.5">{snap.status.toLowerCase().replace("_", " ")}</span>}
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
          <div className="text-right text-lg font-bold sm:text-2xl">{snap.home.name}</div>
          <div className="rounded-xl bg-foreground px-4 py-2 text-3xl font-bold tabular-nums text-background sm:text-4xl">
            {snap.status === "SCHEDULED" ? "v" : `${primary.homeGames}–${primary.awayGames}`}
          </div>
          <div className="text-left text-lg font-bold sm:text-2xl">{snap.away.name}</div>
        </div>
        {snap.groups.slice(1).map((g) => (
          <p key={g.key} className="mt-2 text-sm text-muted">
            {g.name}: {g.homeGames}–{g.awayGames}
          </p>
        ))}
        <p className="mt-3 text-sm text-muted">
          {when}
          {snap.venue && ` · ${snap.venue}`}
        </p>
        <div className="mt-3 flex items-center justify-center gap-3 text-xs">
          <button
            className="rounded-md border border-border px-2 py-1"
            onClick={async () => {
              const url = window.location.href;
              if (navigator.share) await navigator.share({ title: `${snap.home.name} v ${snap.away.name}`, url }).catch(() => {});
              else {
                await navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            }}
          >
            {copied ? "Link copied" : "Share"}
          </button>
          {live && !connected && <span className="text-warning">Reconnecting…</span>}
        </div>
      </section>

      {snap.games.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">Teams haven&apos;t been announced yet.</p>
      ) : (
        <section className="space-y-2">
          {snap.games.map((g) => (
            <GameCard key={g.ordinal} game={g} snap={snap} />
          ))}
        </section>
      )}
    </div>
  );
}

function GameCard({ game: g, snap }: { game: LiveGame; snap: LiveSnapshot }) {
  const inPlay = g.status === "LIVE" && g.currentLeg && !g.currentLeg.finished;
  const groupName = snap.groups.length > 1 ? snap.groups.find((x) => x.key === g.groupKey)?.name : null;
  const label = g.status === "WALKOVER" ? "Walkover" : g.notRequired ? "Not needed" : g.status === "VOID" ? "Not played" : null;
  return (
    <article className={`rounded-xl border bg-surface p-3 ${inPlay ? "border-live/50" : "border-border"}`}>
      <div className="mb-2 flex items-center justify-between text-xs text-muted">
        <span>
          Game {g.ordinal} · {g.kind === "PAIRS" ? "Pairs" : "Singles"}
          {groupName && ` · ${groupName}`}
          {g.legs > 1 && ` · ${g.legsFormat === "BEST_OF" ? "best of" : ""} ${g.legs} legs`}
        </span>
        {inPlay && <span className="font-semibold text-live">Leg {g.currentLeg!.ordinal}</span>}
        {label && <span>{label}</span>}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <PlayerSide game={g} side="HOME" align="right" leagueSlug={snap.league.slug} />
        <div className="min-w-14 text-center text-xl font-bold tabular-nums">
          {g.status === "PENDING" ? "–" : `${g.homeLegs}–${g.awayLegs}`}
        </div>
        <PlayerSide game={g} side="AWAY" align="left" leagueSlug={snap.league.slug} />
      </div>
      {inPlay && (
        <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg bg-surface-muted px-2 py-1.5 text-center">
          <span className={`text-right text-2xl font-bold tabular-nums ${g.currentLeg!.nextToThrow === "HOME" ? "text-accent-strong" : ""}`}>
            {g.currentLeg!.nextToThrow === "HOME" && "● "}
            {g.currentLeg!.remaining.HOME}
          </span>
          <span className="text-xs text-muted">to go</span>
          <span className={`text-left text-2xl font-bold tabular-nums ${g.currentLeg!.nextToThrow === "AWAY" ? "text-accent-strong" : ""}`}>
            {g.currentLeg!.remaining.AWAY}
            {g.currentLeg!.nextToThrow === "AWAY" && " ●"}
          </span>
        </div>
      )}
      {(g.status === "LIVE" || g.status === "COMPLETED") && <StatsTable game={g} snap={snap} />}
    </article>
  );
}

function PlayerSide({ game, side, align, leagueSlug }: { game: LiveGame; side: "HOME" | "AWAY"; align: "left" | "right"; leagueSlug: string }) {
  const won = game.winner === side;
  return (
    <div className={`min-w-0 ${align === "right" ? "text-right" : "text-left"}`}>
      {game.players[side].length ? (
        game.players[side].map((p) => (
          <Link key={p.playerId} href={`/leagues/${leagueSlug}/players/${p.playerId}`} className={`block truncate hover:underline ${won ? "font-bold" : "font-medium"}`}>
            {p.name}
          </Link>
        ))
      ) : (
        <div className="text-muted">No player</div>
      )}
    </div>
  );
}

function StatsTable({ game, snap }: { game: LiveGame; snap: LiveSnapshot }) {
  const rows = [...game.players.HOME, ...game.players.AWAY];
  return (
    <details className="mt-2 text-sm" open={game.status === "LIVE"}>
      <summary className="cursor-pointer text-xs text-muted">Stats</summary>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full text-right tabular-nums">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 text-left font-medium">Player</th>
              <th className="font-medium">Avg</th>
              {snap.bands.map((b) => (
                <th key={b.key} className="font-medium">
                  {b.label}
                </th>
              ))}
              <th className="font-medium">HC</th>
              <th className="font-medium">Legs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const s = game.stats[p.playerId];
              return (
                <tr key={p.playerId} className="border-t border-border">
                  <td className="max-w-32 truncate py-1 text-left">{p.name}</td>
                  <td>{s?.average === null || !s ? "–" : s.average.toFixed(2)}</td>
                  {snap.bands.map((b) => (
                    <td key={b.key}>{s?.bands[b.key] ?? 0}</td>
                  ))}
                  <td>{s?.highestCheckout ?? "–"}</td>
                  <td>{s?.legsWon ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
