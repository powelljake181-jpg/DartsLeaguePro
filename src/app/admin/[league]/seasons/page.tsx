import type { Metadata } from "next";
import { ActionForm } from "@/components/form";
import { SeasonFields } from "@/components/season-fields";
import { Badge, Card, EmptyState, List, Page, PageHeader, RowLink, formatDate } from "@/components/ui";
import { leagueSetup } from "@/server/queries";
import { createSeasonAction } from "../../actions";
import { loadLeagueAdminOnly } from "../load";

export const metadata: Metadata = { title: "Seasons" };

export default async function SeasonsPage(props: PageProps<"/admin/[league]/seasons">) {
  const { league: slug } = await props.params;
  const { db, league } = await loadLeagueAdminOnly(slug);
  const { seasons } = await leagueSetup(db, league.id);

  return (
    <Page>
      <PageHeader title="Seasons" />
      <div className="grid gap-4 sm:grid-cols-[1fr_20rem]">
        <Card>
          {seasons.length ? (
            <List>
              {seasons.map((s) => (
                <RowLink
                  key={s.id}
                  href={`/admin/${league.slug}/seasons/${s.id}`}
                  title={s.name}
                  meta={`Starts ${formatDate(s.startsOn)}`}
                  right={<Badge tone={s.status === "ACTIVE" ? "accent" : "neutral"}>{s.status.toLowerCase()}</Badge>}
                />
              ))}
            </List>
          ) : (
            <EmptyState>No seasons yet.</EmptyState>
          )}
        </Card>
        <Card title="New season">
          <ActionForm action={createSeasonAction} submitLabel="Create season">
            <input type="hidden" name="leagueId" value={league.id} />
            <input type="hidden" name="leagueSlug" value={league.slug} />
            <SeasonFields />
          </ActionForm>
        </Card>
      </div>
    </Page>
  );
}
