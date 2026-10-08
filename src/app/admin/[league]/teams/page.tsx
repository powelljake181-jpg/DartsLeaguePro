import type { Metadata } from "next";
import { ActionForm } from "@/components/form";
import { Card, EmptyState, Field, Input, List, Page, PageHeader, RowLink, Select } from "@/components/ui";
import { leagueSetup } from "@/server/queries";
import { createTeamAction } from "../../actions";
import { loadLeagueAdminOnly } from "../load";

export const metadata: Metadata = { title: "Teams" };

export default async function TeamsPage(props: PageProps<"/admin/[league]/teams">) {
  const { league: slug } = await props.params;
  const { db, league } = await loadLeagueAdminOnly(slug);
  const { teams, venues } = await leagueSetup(db, league.id);
  const venueName = new Map(venues.map((v) => [v.id, v.name]));

  return (
    <Page>
      <PageHeader title="Teams" subtitle="Add teams here, then place them in a division for each season." />
      <div className="grid gap-4 sm:grid-cols-[1fr_20rem]">
        <Card>
          {teams.length ? (
            <List>
              {teams.map((t) => (
                <RowLink
                  key={t.id}
                  href={`/admin/${league.slug}/teams/${t.id}`}
                  title={t.name}
                  meta={t.homeVenueId ? venueName.get(t.homeVenueId) : "No home venue set"}
                />
              ))}
            </List>
          ) : (
            <EmptyState>No teams yet.</EmptyState>
          )}
        </Card>
        <Card title="Add a team">
          <ActionForm action={createTeamAction} submitLabel="Add team" resetOnSuccess>
            <input type="hidden" name="leagueId" value={league.id} />
            <Field label="Team name" htmlFor="team-name">
              <Input id="team-name" name="name" placeholder="Melville B" required />
            </Field>
            <Field label="Home venue" htmlFor="team-venue" hint={venues.length ? undefined : "Add venues under Divisions & venues."}>
              <Select id="team-venue" name="venueId" defaultValue="">
                <option value="">Not set</option>
                {venues.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          </ActionForm>
        </Card>
      </div>
    </Page>
  );
}
