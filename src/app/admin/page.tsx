import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { ActionForm } from "@/components/form";
import { Card, EmptyState, Field, Input, List, Page, PageHeader, RowLink } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { adminScope } from "@/server/queries";
import { createLeagueAction } from "./actions";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminHome() {
  const { user, actor } = await requireActor();
  const scope = await adminScope(await getDb(), actor);

  return (
    <Page>
      <PageHeader title={`Hello, ${user.name.split(" ")[0]}`} subtitle="Choose what you want to manage." />
      <div className="space-y-4">
        {scope.leagues.length > 0 && (
          <Card title="Your leagues">
            <List>
              {scope.leagues.map((l) => (
                <RowLink key={l.id} href={`/admin/${l.slug}`} title={l.name} meta="League admin" />
              ))}
            </List>
          </Card>
        )}
        {scope.teams.length > 0 && (
          <Card title="Your teams">
            <List>
              {scope.teams.map(({ team, league }) => (
                <RowLink key={team.id} href={`/admin/${league.slug}/teams/${team.id}`} title={team.name} meta={league.name} />
              ))}
            </List>
          </Card>
        )}
        {scope.leagues.length === 0 && scope.teams.length === 0 && (
          <EmptyState>
            {actor.isPlatformAdmin
              ? "No leagues yet. Create the first one below."
              : "You don't manage any leagues or teams yet. Ask your league secretary for an invitation link."}
          </EmptyState>
        )}
        {actor.isPlatformAdmin && (
          <Card title="Create a league" description="You'll be its first league admin and can invite the secretary afterwards.">
            <ActionForm action={createLeagueAction} submitLabel="Create league">
              <Field label="League name" htmlFor="name">
                <Input id="name" name="name" placeholder="Manchester Darts League" required />
              </Field>
              <Field label="Web address" htmlFor="slug" hint="Lowercase letters, numbers and dashes, e.g. manchester.">
                <Input id="slug" name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="manchester" required />
              </Field>
              <input type="hidden" name="timezone" value="Europe/London" />
            </ActionForm>
          </Card>
        )}
      </div>
    </Page>
  );
}
