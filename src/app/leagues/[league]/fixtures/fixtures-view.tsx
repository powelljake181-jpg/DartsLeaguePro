import { Card, EmptyState, Page, PageHeader } from "@/components/ui";
import { FixtureList, Pills } from "@/components/public";
import { fixtureList, seasonCompetitions, type FixtureView } from "@/server/public-service";
import { loadLeagueSeason } from "../load";
import { SeasonPills } from "../season-pills";

/** Shared body of the Fixtures and Results pages, filterable by division. */
export async function FixturesView({ slug, searchParams, view }: { slug: string; searchParams: Promise<Record<string, string | string[] | undefined>>; view: FixtureView }) {
  const { db, league, seasons, season, href, base, param } = await loadLeagueSeason(slug, searchParams);
  const path = view === "upcoming" ? "/fixtures" : "/results";
  const title = view === "upcoming" ? "Fixtures" : "Results";
  if (!season) {
    return (
      <Page>
        <PageHeader title={title} />
        <EmptyState>Nothing here yet.</EmptyState>
      </Page>
    );
  }
  const comps = await seasonCompetitions(db, season.id);
  const division = comps.find((c) => c.competition.id === param("division")) ?? null;
  const list = await fixtureList(db, season.id, { view, competitionId: division?.competition.id ?? null });

  return (
    <Page>
      <PageHeader title={title} subtitle={season.name} />
      <SeasonPills seasons={seasons} season={season} path={`${base}${path}`} />
      {comps.length > 1 && (
        <Pills
          label="Division"
          items={[
            { href: href(path), label: "All", active: !division },
            ...comps.map((c) => ({ href: href(path, { division: c.competition.id }), label: c.competition.name, active: c.competition.id === division?.competition.id })),
          ]}
        />
      )}
      <Card>
        <FixtureList
          fixtures={list}
          tz={league.timezone}
          showCompetition={!division && comps.length > 1}
          empty={view === "upcoming" ? "No fixtures left to play." : "No results yet."}
        />
      </Card>
    </Page>
  );
}
