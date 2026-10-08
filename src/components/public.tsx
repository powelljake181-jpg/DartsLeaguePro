import Link from "next/link";
import type { ReactNode } from "react";
import { localDateInZone } from "@/domain/dates";
import type { StandingRow } from "@/domain/standings";
import type { PublicFixture } from "@/server/public-service";
import { Badge, EmptyState, formatDate } from "./ui";

/** Building blocks for the public league site. Server-safe (no hooks). */

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export const fmtAvg = (n: number | null) => (n === null ? "–" : n.toFixed(2));
export const fmtPct = (n: number | null) => (n === null ? "–" : `${Math.round(n)}%`);

/** Append `?season=` only when it isn't the default season, so shared links stay short. */
export function seasonHref(href: string, seasonId: string | null, defaultSeasonId: string | null, extra: Record<string, string | null | undefined> = {}) {
  const q = new URLSearchParams();
  if (seasonId && seasonId !== defaultSeasonId) q.set("season", seasonId);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${href}?${s}` : href;
}

export function Pills({ label, items }: { label: string; items: { href: string; label: string; active: boolean }[] }) {
  return (
    <nav className="mb-4 flex flex-wrap gap-2" aria-label={label}>
      {items.map((i) => (
        <Link
          key={i.href + i.label}
          href={i.href}
          aria-current={i.active ? "true" : undefined}
          className={cx("rounded-full border px-3 py-1 text-sm", i.active ? "border-accent bg-accent-soft font-semibold" : "border-border text-muted hover:text-foreground")}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

const STATUS_LABEL: Partial<Record<PublicFixture["status"], { text: string; tone: "warning" | "danger" | "neutral" }>> = {
  POSTPONED: { text: "Postponed", tone: "warning" },
  VOID: { text: "Void", tone: "danger" },
  CANCELLED: { text: "Cancelled", tone: "danger" },
};

/** Fixtures grouped under a date heading per match night. */
export function FixtureList({
  fixtures,
  tz,
  teamId,
  empty,
  showCompetition = true,
}: {
  fixtures: PublicFixture[];
  tz: string;
  /** Show results from this team's point of view (W/L/D marker). */
  teamId?: string;
  empty: ReactNode;
  showCompetition?: boolean;
}) {
  if (!fixtures.length) return <EmptyState>{empty}</EmptyState>;
  const byDate = new Map<string, PublicFixture[]>();
  for (const f of fixtures) {
    const d = localDateInZone(f.scheduledAt, tz);
    byDate.set(d, [...(byDate.get(d) ?? []), f]);
  }
  return (
    <div className="space-y-4">
      {[...byDate].map(([date, list]) => (
        <section key={date}>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{formatDate(date, tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</h3>
          <ul className="-mx-1 divide-y divide-border">
            {list.map((f) => (
              <li key={f.id}>
                <FixtureRow f={f} tz={tz} teamId={teamId} showCompetition={showCompetition} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FixtureRow({ f, tz, teamId, showCompetition }: { f: PublicFixture; tz: string; teamId?: string; showCompetition: boolean }) {
  const time = formatDate(f.scheduledAt, tz, { hour: "2-digit", minute: "2-digit" });
  const centre = f.score ? `${f.score.home}–${f.score.away}` : f.liveScore ? `${f.liveScore.home}–${f.liveScore.away}` : f.status === "VOID" || f.status === "CANCELLED" ? "–" : time;
  const won = (side: "HOME" | "AWAY") => f.score?.winner === side;
  const mine = teamId ? (f.home.teamId === teamId ? "HOME" : f.away?.teamId === teamId ? "AWAY" : null) : null;
  const outcome = mine && f.score ? (f.score.winner === "DRAW" ? "D" : f.score.winner === mine ? "W" : "L") : null;
  const status = STATUS_LABEL[f.status];
  const meta = [showCompetition && f.competitionName, f.venue, f.otherScores.map((o) => `${o.name} ${o.home}–${o.away}`).join(", "), f.awarded && "Awarded"].filter(Boolean).join(" · ");
  return (
    <Link href={`/fixtures/${f.id}`} className="block rounded-lg px-2 py-2.5 hover:bg-surface-muted" aria-label={`${f.home.name} ${f.score ? centre : "v"} ${f.away?.name ?? "bye"}`}>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-3">
        <span className={cx("truncate text-right", won("HOME") ? "font-bold" : "font-medium")}>{f.home.name}</span>
        <span
          className={cx(
            "min-w-16 rounded-md px-2 py-0.5 text-center tabular-nums",
            f.status === "LIVE" ? "bg-live font-bold text-white" : f.score ? "bg-foreground font-bold text-background" : "bg-surface-muted text-sm text-muted",
          )}
        >
          {centre}
        </span>
        <span className={cx("truncate", won("AWAY") ? "font-bold" : "font-medium", !f.away && "text-muted")}>{f.away?.name ?? "Bye"}</span>
      </div>
      {(meta || status || f.status === "LIVE" || outcome) && (
        <div className="mt-1 flex items-center justify-center gap-2 text-xs text-muted">
          {f.status === "LIVE" && <Badge tone="live">Live</Badge>}
          {status && <Badge tone={status.tone}>{status.text}</Badge>}
          {outcome && <Badge tone={outcome === "W" ? "accent" : outcome === "L" ? "danger" : "neutral"}>{outcome}</Badge>}
          {meta && <span className="truncate">{meta}</span>}
        </div>
      )}
    </Link>
  );
}

/** A league table. Compact drops the game/leg columns for the overview. */
export function StandingsTable({
  rows,
  leagueSlug,
  slugs,
  compact,
  showLegs,
  highlight,
  seasonQuery = "",
}: {
  rows: StandingRow[];
  leagueSlug: string;
  /** entryId → team slug, for links. */
  slugs: Map<string, string>;
  compact?: boolean;
  showLegs?: boolean;
  highlight?: string;
  seasonQuery?: string;
}) {
  if (!rows.length) return <EmptyState>No teams in this division yet.</EmptyState>;
  const th = "px-1.5 py-2 font-medium";
  const td = "px-1.5 py-2";
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-right text-sm tabular-nums">
        <thead className="text-xs text-muted">
          <tr className="border-b border-border">
            <th className={cx(th, "w-8 text-left")}>
              <abbr title="Position" className="no-underline">
                #
              </abbr>
            </th>
            <th className={cx(th, "text-left")}>Team</th>
            <th className={th}>
              <abbr title="Played" className="no-underline">P</abbr>
            </th>
            <th className={th}>
              <abbr title="Won" className="no-underline">W</abbr>
            </th>
            {!compact && (
              <th className={th}>
                <abbr title="Drawn" className="no-underline">D</abbr>
              </th>
            )}
            <th className={th}>
              <abbr title="Lost" className="no-underline">L</abbr>
            </th>
            {!compact && (
              <>
                <th className={th}>
                  <abbr title="Games won" className="no-underline">GF</abbr>
                </th>
                <th className={th}>
                  <abbr title="Games lost" className="no-underline">GA</abbr>
                </th>
              </>
            )}
            <th className={th}>
              <abbr title="Game difference" className="no-underline">+/-</abbr>
            </th>
            {showLegs && !compact && (
              <th className={th}>
                <abbr title="Leg difference" className="no-underline">Legs</abbr>
              </th>
            )}
            <th className={cx(th, "pr-2")}>Pts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entryId} className={cx("border-b border-border last:border-0", r.entryId === highlight && "bg-accent-soft", r.withdrawn && "text-muted")}>
              <td className={cx(td, "text-left text-muted")}>{r.withdrawn ? "–" : r.position}</td>
              <td className={cx(td, "max-w-40 truncate text-left font-medium")}>
                {slugs.get(r.entryId) ? (
                  <Link href={`/leagues/${leagueSlug}/teams/${slugs.get(r.entryId)}${seasonQuery}`} className="hover:underline">
                    {r.name}
                  </Link>
                ) : (
                  r.name
                )}
                {r.withdrawn && <span className="ml-1 text-xs">(withdrawn)</span>}
              </td>
              <td className={td}>{r.played}</td>
              <td className={td}>{r.won}</td>
              {!compact && <td className={td}>{r.drawn}</td>}
              <td className={td}>{r.lost}</td>
              {!compact && (
                <>
                  <td className={td}>{r.gamesFor}</td>
                  <td className={td}>{r.gamesAgainst}</td>
                </>
              )}
              <td className={td}>{r.gameDifference > 0 ? `+${r.gameDifference}` : r.gameDifference}</td>
              {showLegs && !compact && <td className={td}>{r.legDifference > 0 ? `+${r.legDifference}` : r.legDifference}</td>}
              <td className={cx(td, "pr-2 font-bold")}>{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
