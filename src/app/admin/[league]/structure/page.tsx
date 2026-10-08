import type { Metadata } from "next";
import { ActionForm } from "@/components/form";
import { Card, EmptyState, Field, Input, Page, PageHeader } from "@/components/ui";
import { leagueSetup } from "@/server/queries";
import { createDivisionAction, createVenueAction } from "../../actions";
import { loadLeagueAdminOnly } from "../load";

export const metadata: Metadata = { title: "Divisions & venues" };

export default async function StructurePage(props: PageProps<"/admin/[league]/structure">) {
  const { league: slug } = await props.params;
  const { db, league } = await loadLeagueAdminOnly(slug);
  const { divisions, venues } = await leagueSetup(db, league.id);

  return (
    <Page>
      <PageHeader title="Divisions & venues" subtitle="These carry over from season to season." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Divisions" description="Top division first.">
          {divisions.length ? (
            <ol className="mb-4 space-y-1">
              {divisions.map((d) => (
                <li key={d.id} className="flex items-center gap-3 rounded-lg bg-surface-muted px-3 py-2">
                  <span className="w-5 text-sm text-muted">{d.rank}</span>
                  <span className="font-medium">{d.name}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="mb-4">
              <EmptyState>No divisions yet.</EmptyState>
            </div>
          )}
          <ActionForm action={createDivisionAction} submitLabel="Add division" submitVariant="secondary" resetOnSuccess>
            <input type="hidden" name="leagueId" value={league.id} />
            <Field label="Division name" htmlFor="division-name">
              <Input id="division-name" name="name" placeholder={`Division ${divisions.length + 1}`} required />
            </Field>
          </ActionForm>
        </Card>

        <Card title="Venues" description="Pubs and clubs where teams play at home.">
          {venues.length ? (
            <ul className="mb-4 space-y-1">
              {venues.map((v) => (
                <li key={v.id} className="rounded-lg bg-surface-muted px-3 py-2">
                  <div className="font-medium">{v.name}</div>
                  {v.address && <div className="text-sm text-muted">{v.address}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <div className="mb-4">
              <EmptyState>No venues yet.</EmptyState>
            </div>
          )}
          <ActionForm action={createVenueAction} submitLabel="Add venue" submitVariant="secondary" resetOnSuccess>
            <input type="hidden" name="leagueId" value={league.id} />
            <Field label="Venue name" htmlFor="venue-name">
              <Input id="venue-name" name="name" placeholder="The Melville" required />
            </Field>
            <Field label="Address (optional)" htmlFor="venue-address">
              <Input id="venue-address" name="address" />
            </Field>
          </ActionForm>
        </Card>
      </div>
    </Page>
  );
}
