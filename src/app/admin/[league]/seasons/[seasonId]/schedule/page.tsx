import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/form";
import { Badge, Card, EmptyState, Field, Input, LinkButton, Page, PageHeader, Select, formatDate } from "@/components/ui";
import { AppError } from "@/server/errors";
import { seasonSetup } from "@/server/queries";
import { seasonCalendar, seasonFixtures, suggestVenueConstraints } from "@/server/schedule-service";
import { addBlackoutAction, createConstraintAction, deleteConstraintAction, removeBlackoutAction } from "../../../../actions";
import { loadLeagueAdminOnly } from "../../../load";
import { ScheduleGenerator } from "./generator";

export const metadata: Metadata = { title: "Fixtures schedule" };

const KIND_LABEL = { CUP: "Cup night", BREAK: "Break", OTHER: "No fixtures" } as const;

export default async function SchedulePage(props: PageProps<"/admin/[league]/seasons/[seasonId]/schedule">) {
  const { league: slug, seasonId } = await props.params;
  const { db, league } = await loadLeagueAdminOnly(slug);
  const setup = await seasonSetup(db, league.id, seasonId).catch((e) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
  const [calendar, suggestions, existing] = await Promise.all([seasonCalendar(db, seasonId), suggestVenueConstraints(db, seasonId), seasonFixtures(db, seasonId)]);
  const competitions = setup.divisions.filter((d) => d.competition);
  const enteredTeams = competitions.flatMap((d) => d.entries.map((e) => ({ id: e.teamId, name: e.displayName, division: d.division.name })));
  const base = `/admin/${league.slug}/seasons/${seasonId}`;

  const divisionsForGenerator = competitions.map(({ division, competition, entries }) => {
    const mine = existing.fixtures.filter((f) => f.competitionId === competition!.id);
    return {
      id: competition!.id,
      name: division.name,
      teamCount: entries.length,
      weekday: competition!.matchWeekday,
      fixtureCount: mine.length,
      played: mine.some((f) => !["SCHEDULED", "POSTPONED", "REARRANGEMENT_REQUESTED"].includes(f.status)),
    };
  });

  return (
    <Page>
      <PageHeader
        title="Fixtures schedule"
        subtitle={setup.season.name}
        back={{ href: base, label: setup.season.name }}
        actions={existing.fixtures.length > 0 && <LinkButton variant="secondary" href={`${base}/fixtures`}>View fixtures</LinkButton>}
      />
      <div className="space-y-4">
        <Card title="1. Dates with no league fixtures" description="Cup nights, Christmas and other breaks. Add these before generating.">
          {calendar.blackouts.length ? (
            <ul className="mb-4 divide-y divide-border">
              {calendar.blackouts.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="font-medium">{formatDate(b.date, "UTC", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</div>
                    <div className="text-sm text-muted">
                      {b.reason} · {KIND_LABEL[b.kind]}
                      {b.competitionId && ` · ${competitions.find((c) => c.competition?.id === b.competitionId)?.division.name ?? ""} only`}
                    </div>
                  </div>
                  <ActionForm action={removeBlackoutAction} submitLabel="Remove" submitVariant="secondary" className="shrink-0">
                    <input type="hidden" name="blackoutId" value={b.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mb-4">
              <EmptyState>No dates excluded yet.</EmptyState>
            </div>
          )}
          <ActionForm action={addBlackoutAction} submitLabel="Add date" submitVariant="secondary" resetOnSuccess>
            <input type="hidden" name="seasonId" value={seasonId} />
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Date" htmlFor="bo-date">
                <Input id="bo-date" name="date" type="date" required />
              </Field>
              <Field label="Type" htmlFor="bo-kind">
                <Select id="bo-kind" name="kind" defaultValue="BREAK">
                  <option value="CUP">Cup night</option>
                  <option value="BREAK">Break</option>
                  <option value="OTHER">Other</option>
                </Select>
              </Field>
              <Field label="Reason" htmlFor="bo-reason">
                <Input id="bo-reason" name="reason" placeholder="Christmas" required />
              </Field>
              <Field label="Applies to" htmlFor="bo-comp">
                <Select id="bo-comp" name="competitionId" defaultValue="">
                  <option value="">All divisions</option>
                  {competitions.map(({ division, competition }) => (
                    <option key={competition!.id} value={competition!.id}>
                      {division.name} only
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </ActionForm>
        </Card>

        <Card title="2. Shared venues" description="Teams that can't all be at home on the same night, even in different divisions.">
          {calendar.constraints.length > 0 && (
            <ul className="mb-4 divide-y divide-border">
              {calendar.constraints.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-sm text-muted">
                      {c.teams.map((t) => t.name).join(", ")} · at most {c.maxHomePerDate} at home per night
                    </div>
                  </div>
                  <ActionForm action={deleteConstraintAction} submitLabel="Remove" submitVariant="secondary" className="shrink-0">
                    <input type="hidden" name="constraintId" value={c.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          {suggestions.map((s) => (
            <div key={s.venue.id} className="mb-3 rounded-lg border border-accent/30 bg-accent-soft p-3">
              <p className="text-sm">
                <strong>{s.teams.map((t) => t.name).join(" and ")}</strong> both play at {s.venue.name}.
              </p>
              <ActionForm action={createConstraintAction} submitLabel="Don't let them both be at home" submitVariant="secondary">
                <input type="hidden" name="seasonId" value={seasonId} />
                <input type="hidden" name="name" value={s.venue.name} />
                <input type="hidden" name="venueId" value={s.venue.id} />
                <input type="hidden" name="maxHome" value="1" />
                {s.teams.map((t) => (
                  <input key={t.id} type="hidden" name="teamIds" value={t.id} />
                ))}
              </ActionForm>
            </div>
          ))}
          <details className="rounded-lg bg-surface-muted px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Add a constraint by hand</summary>
            <div className="mt-3">
              <ActionForm action={createConstraintAction} submitLabel="Add constraint" submitVariant="secondary" resetOnSuccess>
                <input type="hidden" name="seasonId" value={seasonId} />
                <Field label="Name" htmlFor="con-name">
                  <Input id="con-name" name="name" placeholder="The Melville" required />
                </Field>
                <fieldset>
                  <legend className="mb-1 text-sm font-medium">Teams</legend>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {enteredTeams.map((t) => (
                      <label key={t.id} className="flex min-h-10 items-center gap-2 text-sm">
                        <input type="checkbox" name="teamIds" value={t.id} className="h-5 w-5 accent-[var(--accent)]" />
                        {t.name} <span className="text-muted">({t.division})</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Field label="Most at home on one night" htmlFor="con-max">
                  <Input id="con-max" name="maxHome" type="number" min={1} defaultValue={1} inputMode="numeric" />
                </Field>
              </ActionForm>
            </div>
          </details>
        </Card>

        {competitions.length ? (
          <ScheduleGenerator seasonId={seasonId} seasonStart={setup.season.startsOn} divisions={divisionsForGenerator} />
        ) : (
          <EmptyState>Set up divisions for this season first.</EmptyState>
        )}
        <p className="text-sm text-muted">
          <Badge>Tip</Badge> Generating divisions that share a night together lets the generator keep shared venues apart across divisions.
        </p>
      </div>
    </Page>
  );
}
