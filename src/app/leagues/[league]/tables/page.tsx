import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState, Page, PageHeader } from "@/components/ui";
import { StandingsTable } from "@/components/public";
import { competitionPage, entrySlugs, seasonCompetitions } from "@/server/public-service";
import { loadLeagueSeason } from "../load";
import { SeasonPills } from "../season-pills";

export const metadata: Metadata = { title: "Tables" };

/** Every division's full table(s) for the season. */
export default async function TablesPage(props: PageProps<"/leagues/[league]/tables">) {
  const { league: slug } = await props.params;
  const { db, league, seasons, season, href, base, seasonQuery } = await loadLeagueSeason(slug, props.searchParams);
  const comps = season ? (await seasonCompetitions(db, season.id)).filter((c) => c.competition.kind === "LEAGUE") : [];
  const pages = await Promise.all(comps.map((c) => competitionPage(db, league.id, c.competition.id)));
  const slugs = await entrySlugs(db, comps.map((c) => c.competition.id));

  return (
    <Page>
      <PageHeader title="Tables" subtitle={season?.name} />
      <SeasonPills seasons={seasons} season={season} path={`${base}/tables`} />
      {pages.length === 0 ? (
        <EmptyState>No league tables yet.</EmptyState>
      ) : (
        <div className="space-y-4">
          {pages.flatMap((p) =>
            p.tables.map((t, i) => (
              <Card
                key={`${p.competition.id}-${t.groupKey}`}
                title={i === 0 ? p.competition.name : `${p.competition.name} · ${t.name}`}
                actions={
                  i === 0 && (
                    <Link href={href(`/divisions/${p.competition.id}`)} className="shrink-0 text-sm font-medium text-accent-strong hover:underline">
                      Fixtures & results ›
                    </Link>
                  )
                }
              >
                <StandingsTable rows={t.rows} leagueSlug={league.slug} slugs={slugs} seasonQuery={seasonQuery} />
              </Card>
            )),
          )}
        </div>
      )}
    </Page>
  );
}
