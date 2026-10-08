import Link from "next/link";
import { Card, EmptyState, Page } from "@/components/ui";
import { FixtureList, StandingsTable } from "@/components/public";
import { cupBracket } from "@/server/cup-service";
import { entrySlugs, leagueOverview } from "@/server/public-service";
import { loadLeagueSeason } from "./load";
import { SeasonPills } from "./season-pills";

/** League home: live matches, every division's table, the next fixtures and the latest results. */
export default async function LeagueHome(props: PageProps<"/leagues/[league]">) {
  const { league: slug } = await props.params;
  const { db, league, seasons, season, href, base, seasonQuery } = await loadLeagueSeason(slug, props.searchParams);
  if (!season) {
    return (
      <Page>
        <EmptyState>The first season hasn&apos;t started yet. Check back soon.</EmptyState>
      </Page>
    );
  }
  const o = await leagueOverview(db, league, season.id);
  const slugs = await entrySlugs(db, o.tables.map((t) => t.competition.id));
  const tz = league.timezone;
  // Where each cup has got to: the winner, or the earliest round still to finish.
  const cups = await Promise.all(
    o.cups.map(async (c) => {
      const b = await cupBracket(db, c.id);
      const current = b.rounds.find((r) => r.ties.some((t) => !t?.winnerEntryId));
      const stage = b.champion ? `Won by ${b.champion.name}` : !b.drawn ? "Draw to come" : current ? current.name : "";
      return { id: c.id, name: c.name, stage };
    }),
  );

  return (
    <Page>
      <SeasonPills seasons={seasons} season={season} path={base} />
      <div className="space-y-4">
        {o.live.length > 0 && (
          <Card title="Live now" className="border-live/40">
            <FixtureList fixtures={o.live} tz={tz} empty="" />
          </Card>
        )}

        {o.tables.length === 0 ? (
          <EmptyState>No divisions have been set up for {season.name} yet.</EmptyState>
        ) : (
          <div className={o.tables.length > 1 ? "grid gap-4 md:grid-cols-2" : ""}>
            {o.tables.map((t) => (
              <Card
                key={t.competition.id}
                title={t.competition.name}
                actions={
                  <Link href={href(`/divisions/${t.competition.id}`)} className="shrink-0 text-sm font-medium text-accent-strong hover:underline">
                    Full table ›
                  </Link>
                }
              >
                {t.table ? <StandingsTable rows={t.table.rows} leagueSlug={league.slug} slugs={slugs} compact seasonQuery={seasonQuery} /> : <EmptyState>No table yet.</EmptyState>}
              </Card>
            ))}
          </div>
        )}

        {cups.length > 0 && (
          <Card title="Cups">
            <ul className="-mx-1 divide-y divide-border">
              {cups.map((c) => (
                <li key={c.id}>
                  <Link href={href(`/divisions/${c.id}`)} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2.5 hover:bg-surface-muted">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-sm text-muted">{c.stage} ›</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <Card
            title="Coming up"
            actions={
              <Link href={href("/fixtures")} className="shrink-0 text-sm font-medium text-accent-strong hover:underline">
                All fixtures ›
              </Link>
            }
          >
            <FixtureList fixtures={o.upcoming} tz={tz} empty="No fixtures scheduled." />
          </Card>
          <Card
            title="Latest results"
            actions={
              <Link href={href("/results")} className="shrink-0 text-sm font-medium text-accent-strong hover:underline">
                All results ›
              </Link>
            }
          >
            <FixtureList fixtures={o.results} tz={tz} empty="No results yet." />
          </Card>
        </div>
      </div>
    </Page>
  );
}
