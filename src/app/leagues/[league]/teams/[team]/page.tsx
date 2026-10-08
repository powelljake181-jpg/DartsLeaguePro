import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, Page, PageHeader } from "@/components/ui";
import { FixtureList, StatTile, fmtAvg } from "@/components/public";
import { threeDartAverage } from "@/domain/stats";
import { teamProfile } from "@/server/public-service";
import { loadLeagueSeason, loadPublicLeague, or404 } from "../../load";
import { SeasonPills } from "../../season-pills";

export async function generateMetadata(props: PageProps<"/leagues/[league]/teams/[team]">): Promise<Metadata> {
  const { league: slug, team } = await props.params;
  const { db, league } = await loadPublicLeague(slug);
  const t = await or404(teamProfile(db, league.id, team, null));
  return { title: t.team.name };
}

/** A team's season: league position, squad with statistics, results and fixtures. */
export default async function TeamPage(props: PageProps<"/leagues/[league]/teams/[team]">) {
  const { league: slug, team: teamSlug } = await props.params;
  const { db, league, seasons, season, href, base } = await loadLeagueSeason(slug, props.searchParams);
  const t = await or404(teamProfile(db, league.id, teamSlug, season?.id ?? null));
  const tz = league.timezone;
  const squad = [...t.squad].sort((a, b) => (b.totals?.gamesPlayed ?? 0) - (a.totals?.gamesPlayed ?? 0) || a.name.localeCompare(b.name));

  return (
    <Page>
      <PageHeader title={t.team.name} subtitle={t.venue ? `Home venue: ${t.venue.name}` : undefined} back={{ href: href("/teams"), label: "Teams" }} />
      <SeasonPills seasons={seasons} season={season} path={`${base}/teams/${t.team.slug}`} />

      {t.standings.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {t.standings.map((s) => (
            <Link key={s.competition.id} href={href(`/divisions/${s.competition.id}`)} className="contents">
              <StatTile label={s.competition.name} value={s.row && s.row.played > 0 ? `${ordinal(s.row.position)} of ${s.teams}` : "–"} hint={s.row ? `${s.row.points} pts · P${s.row.played}` : undefined} />
            </Link>
          ))}
        </div>
      )}

      <div className="space-y-4">
        <Card title="Squad" description={season ? `${season.name} statistics` : undefined}>
          {squad.length === 0 ? (
            <EmptyState>No players registered.</EmptyState>
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full text-right text-sm tabular-nums">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-border">
                    <th className="px-1.5 py-2 text-left font-medium">Player</th>
                    <th className="px-1.5 py-2 font-medium">P</th>
                    <th className="px-1.5 py-2 font-medium">W</th>
                    <th className="px-1.5 py-2 font-medium">Avg</th>
                    <th className="px-1.5 py-2 font-medium">{t.bands[0].label}</th>
                    <th className="px-1.5 py-2 font-medium">HC</th>
                  </tr>
                </thead>
                <tbody>
                  {squad.map((p) => (
                    <tr key={p.playerId} className="border-b border-border last:border-0">
                      <td className="max-w-44 truncate px-1.5 py-2 text-left font-medium">
                        <Link href={`/leagues/${league.slug}/players/${p.playerId}`} className="hover:underline">
                          {p.name}
                        </Link>
                        {!p.current && <span className="ml-1 text-xs font-normal text-muted">(left)</span>}
                      </td>
                      <td className="px-1.5 py-2">{p.totals?.gamesPlayed ?? 0}</td>
                      <td className="px-1.5 py-2">{p.totals?.wins ?? 0}</td>
                      <td className="px-1.5 py-2">{fmtAvg(p.totals ? threeDartAverage(p.totals) : null)}</td>
                      <td className="px-1.5 py-2">{p.totals?.bands[t.bands[0].key] ?? 0}</td>
                      <td className="px-1.5 py-2">{p.totals?.highestCheckout ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Results">
            <FixtureList fixtures={t.results} tz={tz} teamId={t.team.id} empty="No results yet." />
          </Card>
          <Card title="Fixtures">
            <FixtureList fixtures={t.upcoming} tz={tz} teamId={t.team.id} empty="No fixtures left to play." />
          </Card>
        </div>
      </div>
    </Page>
  );
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
