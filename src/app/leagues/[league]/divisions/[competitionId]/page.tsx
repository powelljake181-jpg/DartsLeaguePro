import type { Metadata } from "next";
import Link from "next/link";
import { Card, Notice, Page, PageHeader } from "@/components/ui";
import { FixtureList, StandingsTable } from "@/components/public";
import { competitionPage, entrySlugs, fixtureList } from "@/server/public-service";
import { getDb } from "@/db/client";
import { BracketView } from "@/components/bracket";
import { cupBracket } from "@/server/cup-service";
import { loadLeagueSeason, loadPublicLeague, or404 } from "../../load";

const load = async (slug: string, competitionId: string) => {
  const { db, league } = await loadPublicLeague(slug);
  return or404(competitionPage(db, league.id, competitionId));
};

export async function generateMetadata(props: PageProps<"/leagues/[league]/divisions/[competitionId]">): Promise<Metadata> {
  const { league, competitionId } = await props.params;
  const p = await load(league, competitionId);
  return { title: `${p.competition.name} ${p.season.name}` };
}

/** One division (or cup): its table(s), results and fixtures. */
export default async function DivisionPage(props: PageProps<"/leagues/[league]/divisions/[competitionId]">) {
  const { league: slug, competitionId } = await props.params;
  const { league, href, seasonQuery } = await loadLeagueSeason(slug, props.searchParams);
  const p = await load(slug, competitionId);
  const db = await getDb();
  const [slugs, upcoming, results] = await Promise.all([
    entrySlugs(db, [p.competition.id]),
    fixtureList(db, p.season.id, { view: "upcoming", competitionId: p.competition.id }),
    fixtureList(db, p.season.id, { view: "results", competitionId: p.competition.id }),
  ]);
  const bracket = p.competition.kind === "CUP" ? await cupBracket(db, p.competition.id) : null;
  const showLegs = p.tables.some((t) => t.rows.some((r) => r.legsFor > 0 || r.legsAgainst > 0));
  const tz = league.timezone;

  return (
    <Page>
      <PageHeader
        title={p.competition.name}
        subtitle={p.season.name}
        back={p.competition.kind === "CUP" ? { href: href(""), label: "Overview" } : { href: href("/tables"), label: "Tables" }}
        actions={
          <Link href={href("/leaderboards", { competition: p.competition.id })} className="text-sm font-medium text-accent-strong hover:underline">
            Player stats ›
          </Link>
        }
      />
      <div className="space-y-4">
        {bracket?.champion && <Notice tone="accent">🏆 {bracket.champion.name} won the {p.competition.name}.</Notice>}
        {bracket && (
          <Card title="Draw">
            {bracket.drawn ? <BracketView bracket={bracket} tieHref={(id) => `/fixtures/${id}`} /> : <p className="text-sm text-muted">The draw hasn&apos;t been made yet.</p>}
          </Card>
        )}
        {p.tables.map((t, i) => (
          <Card key={t.groupKey} title={p.tables.length > 1 || i > 0 ? t.name : "Table"}>
            <StandingsTable rows={t.rows} leagueSlug={league.slug} slugs={slugs} showLegs={showLegs} seasonQuery={seasonQuery} />
          </Card>
        ))}
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Results">
            <FixtureList fixtures={results} tz={tz} showCompetition={false} empty="No results yet." />
          </Card>
          <Card title="Fixtures">
            <FixtureList fixtures={upcoming} tz={tz} showCompetition={false} empty="No fixtures left to play." />
          </Card>
        </div>
      </div>
    </Page>
  );
}
