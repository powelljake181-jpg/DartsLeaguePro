import type { Metadata } from "next";
import { Card, EmptyState, List, Page, PageHeader, RowLink } from "@/components/ui";
import { seasonTeams } from "@/server/public-service";
import { loadLeagueSeason } from "../load";
import { SeasonPills } from "../season-pills";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsPage(props: PageProps<"/leagues/[league]/teams">) {
  const { league: slug } = await props.params;
  const { db, seasons, season, href, base } = await loadLeagueSeason(slug, props.searchParams);
  const divisions = season ? await seasonTeams(db, season.id) : [];

  return (
    <Page>
      <PageHeader title="Teams" subtitle={season?.name} />
      <SeasonPills seasons={seasons} season={season} path={`${base}/teams`} />
      {divisions.length === 0 ? (
        <EmptyState>No teams entered yet.</EmptyState>
      ) : (
        <div className={divisions.length > 1 ? "grid gap-4 md:grid-cols-2" : ""}>
          {divisions.map((d) => (
            <Card key={d.competition.id} title={d.competition.name}>
              {d.entries.length ? (
                <List>
                  {d.entries.map((e) => (
                    <RowLink key={e.entry.id} href={href(`/teams/${e.slug}`)} title={e.entry.displayName} meta={e.entry.status !== "ACTIVE" ? "Withdrawn" : undefined} />
                  ))}
                </List>
              ) : (
                <EmptyState>No teams yet.</EmptyState>
              )}
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
