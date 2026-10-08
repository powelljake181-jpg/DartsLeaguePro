import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, Page, PageHeader } from "@/components/ui";
import { Pills, fmtAvg, fmtPct } from "@/components/public";
import { rankLeaderboard, type LeaderboardCategory } from "@/domain/leaderboards";
import { leaderboardData, seasonCompetitions, type LeaderboardEntry } from "@/server/public-service";
import { loadLeagueSeason } from "../load";
import { SeasonPills } from "../season-pills";

export const metadata: Metadata = { title: "Leaderboards" };

const KINDS = { singles: "SINGLES", pairs: "PAIRS" } as const;

/** Season leaderboards, filterable by division/cup and singles/pairs. */
export default async function LeaderboardsPage(props: PageProps<"/leagues/[league]/leaderboards">) {
  const { league: slug } = await props.params;
  const { db, league, seasons, season, href, base, param } = await loadLeagueSeason(slug, props.searchParams);
  if (!season) {
    return (
      <Page>
        <PageHeader title="Leaderboards" />
        <EmptyState>No statistics yet.</EmptyState>
      </Page>
    );
  }
  const comps = await seasonCompetitions(db, season.id);
  const competition = comps.find((c) => c.competition.id === param("competition"))?.competition ?? null;
  const kindKey = param("kind") === "singles" || param("kind") === "pairs" ? (param("kind") as keyof typeof KINDS) : null;
  const data = await leaderboardData(db, league.id, season.id, { competitionId: competition?.id ?? null, gameKind: kindKey ? KINDS[kindKey] : null });
  const link = (extra: { competition?: string | null; kind?: string | null }) =>
    href("/leaderboards", { competition: "competition" in extra ? extra.competition : competition?.id, kind: "kind" in extra ? extra.kind : kindKey });

  const boards: { title: string; category: LeaderboardCategory; format: (n: number) => string; note?: string }[] = [
    { title: "Average", category: { kind: "average" }, format: (n) => fmtAvg(n), note: data.minGames > 0 ? `Minimum ${data.minGames} games` : undefined },
    ...data.bands.map((b) => ({ title: b.label, category: { kind: "band", key: b.key } as LeaderboardCategory, format: String })),
    { title: "Highest checkout", category: { kind: "highestCheckout" }, format: String },
    { title: "Best leg", category: { kind: "bestLeg" }, format: (n) => `${n} darts` },
    { title: "Win %", category: { kind: "winPct" }, format: (n) => fmtPct(n), note: data.minGames > 0 ? `Minimum ${data.minGames} games` : undefined },
  ];

  return (
    <Page>
      <PageHeader title="Leaderboards" subtitle={competition ? `${competition.name} · ${season.name}` : season.name} />
      <SeasonPills seasons={seasons} season={season} path={`${base}/leaderboards`} />
      {comps.length > 1 && (
        <Pills
          label="Competition"
          items={[
            { href: link({ competition: null }), label: "All", active: !competition },
            ...comps.map((c) => ({ href: link({ competition: c.competition.id }), label: c.competition.name, active: c.competition.id === competition?.id })),
          ]}
        />
      )}
      <Pills
        label="Game type"
        items={[
          { href: link({ kind: null }), label: "All games", active: !kindKey },
          { href: link({ kind: "singles" }), label: "Singles", active: kindKey === "singles" },
          { href: link({ kind: "pairs" }), label: "Pairs", active: kindKey === "pairs" },
        ]}
      />
      {data.entries.length === 0 ? (
        <EmptyState>No games played yet.</EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {boards.map((b) => (
            <Board key={b.title} {...b} entries={data.entries} minGames={data.minGames} playerHref={(id) => `${base}/players/${id}`} teamHref={(s) => href(`/teams/${s}`)} />
          ))}
        </div>
      )}
    </Page>
  );
}

function Board({
  title,
  note,
  category,
  format,
  entries,
  minGames,
  playerHref,
  teamHref,
}: {
  title: string;
  note?: string;
  category: LeaderboardCategory;
  format: (n: number) => string;
  entries: LeaderboardEntry[];
  minGames: number;
  playerHref: (id: string) => string;
  teamHref: (slug: string) => string;
}) {
  const rows = rankLeaderboard(entries, category, { minGames, limit: 10 });
  return (
    <Card title={title} description={note}>
      {rows.length === 0 ? (
        <EmptyState>{note ? "Nobody has played enough games yet." : "None yet."}</EmptyState>
      ) : (
        <ol className="-mx-1 divide-y divide-border">
          {rows.map((r) => (
            <li key={r.entry.playerId} className="flex items-center gap-3 px-1 py-2">
              <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted">{r.position}</span>
              <div className="min-w-0 flex-1">
                <Link href={playerHref(r.entry.playerId)} className="block truncate font-medium hover:underline">
                  {r.entry.name}
                </Link>
                {r.entry.team && (
                  <Link href={teamHref(r.entry.team.slug)} className="block truncate text-xs text-muted hover:underline">
                    {r.entry.team.name}
                  </Link>
                )}
              </div>
              <span className="shrink-0 font-bold tabular-nums">{format(r.value)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
