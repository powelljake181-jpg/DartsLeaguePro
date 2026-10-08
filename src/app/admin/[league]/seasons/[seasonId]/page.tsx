import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/form";
import { SeasonFields } from "@/components/season-fields";
import { Badge, Card, EmptyState, Field, Input, LinkButton, Notice, Page, PageHeader, Select } from "@/components/ui";
import { localDateInZone } from "@/domain/dates";
import { RULE_TEMPLATES } from "@/domain/rules";
import { AppError } from "@/server/errors";
import { and, asc, eq, inArray } from "drizzle-orm";
import { competitions, teamEntries } from "@/db/schema";
import { seasonSetup } from "@/server/queries";
import { createCupAction } from "../../../cup-actions";
import { addTeamToCompetitionAction, createCompetitionAction, removeTeamFromCompetitionAction, updateSeasonAction } from "../../../actions";
import { loadLeagueAdminOnly } from "../../load";

export const metadata: Metadata = { title: "Season" };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function SeasonPage(props: PageProps<"/admin/[league]/seasons/[seasonId]">) {
  const { league: slug, seasonId } = await props.params;
  const { db, league } = await loadLeagueAdminOnly(slug);
  const setup = await seasonSetup(db, league.id, seasonId).catch((e) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
  const { season } = setup;
  const base = `/admin/${league.slug}`;
  const cups = await db.select().from(competitions).where(and(eq(competitions.seasonId, season.id), eq(competitions.kind, "CUP"))).orderBy(asc(competitions.name));
  const cupEntrants = cups.length ? await db.select().from(teamEntries).where(inArray(teamEntries.competitionId, cups.map((c) => c.id))) : [];
  const leagueTeamIds = new Set(setup.divisions.flatMap((d) => d.entries.filter((e) => e.status === "ACTIVE").map((e) => e.teamId)));
  const allTeams = [...setup.divisions.flatMap((d) => d.entries.map((e) => ({ id: e.teamId, name: e.displayName, division: d.division.name }))), ...setup.unplacedTeams.map((t) => ({ id: t.id, name: t.name, division: "Not in a division" }))];

  return (
    <Page>
      <PageHeader
        title={season.name}
        back={{ href: `${base}/seasons`, label: "Seasons" }}
        actions={<Badge tone={season.status === "ACTIVE" ? "accent" : "neutral"}>{season.status.toLowerCase()}</Badge>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <LinkButton href={`${base}/seasons/${season.id}/schedule`}>Generate fixtures</LinkButton>
        <LinkButton variant="secondary" href={`${base}/seasons/${season.id}/fixtures`}>
          Fixtures
        </LinkButton>
      </div>
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Divisions this season</h2>
        {setup.divisions.length === 0 && (
          <Notice tone="warning">
            Add divisions first under <a className="underline" href={`${base}/structure`}>Divisions &amp; venues</a>.
          </Notice>
        )}
        {setup.divisions.map(({ division, competition, entries }) => (
          <Card
            key={division.id}
            title={division.name}
            description={
              competition
                ? `${entries.length} team${entries.length === 1 ? "" : "s"}${competition.matchWeekday !== null ? ` · ${WEEKDAYS[competition.matchWeekday]} nights` : ""}`
                : "Not set up for this season yet."
            }
            actions={competition && <LinkButton variant="secondary" href={`${base}/competitions/${competition.id}/rules`}>Rules</LinkButton>}
          >
            {competition ? (
              <div className="space-y-4">
                {entries.length ? (
                  <ul className="divide-y divide-border">
                    {entries.map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-2 py-2">
                        <span className="font-medium">
                          {e.displayName} {e.status !== "ACTIVE" && <Badge tone="danger">{e.status.toLowerCase()}</Badge>}
                        </span>
                        <span className="flex items-center gap-2">
                          <LinkButton variant="ghost" href={`${base}/seasons/${season.id}/fold/${e.id}`}>
                            {e.status === "ACTIVE" ? "Fold" : "Reverse fold"}
                          </LinkButton>
                          {e.status === "ACTIVE" && (
                            <ActionForm action={removeTeamFromCompetitionAction} submitLabel="Remove" submitVariant="secondary" className="flex items-center gap-2">
                              <input type="hidden" name="entryId" value={e.id} />
                            </ActionForm>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState>No teams in this division yet.</EmptyState>
                )}
                {setup.unplacedTeams.length > 0 && (
                  <ActionForm action={addTeamToCompetitionAction} submitLabel="Add team" submitVariant="secondary" className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <input type="hidden" name="competitionId" value={competition.id} />
                    <div className="flex-1">
                      <Field label="Add a team" htmlFor={`add-${division.id}`}>
                        <Select id={`add-${division.id}`} name="teamId" required defaultValue="">
                          <option value="" disabled>
                            Choose a team…
                          </option>
                          {setup.unplacedTeams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                  </ActionForm>
                )}
              </div>
            ) : (
              <ActionForm action={createCompetitionAction} submitLabel={`Set up ${division.name}`}>
                <input type="hidden" name="seasonId" value={season.id} />
                <input type="hidden" name="divisionId" value={division.id} />
                <Field label="Match format" htmlFor={`tpl-${division.id}`} hint="A starting point. You can change every detail on the Rules page.">
                  <Select id={`tpl-${division.id}`} name="template" defaultValue={RULE_TEMPLATES[0].key}>
                    {RULE_TEMPLATES.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.name} — {t.description}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Match night" htmlFor={`night-${division.id}`}>
                  <Select id={`night-${division.id}`} name="matchWeekday" defaultValue="3">
                    <option value="">Varies</option>
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </Select>
                </Field>
              </ActionForm>
            )}
          </Card>
        ))}

        <h2 className="pt-2 text-lg font-semibold">Cups</h2>
        {cups.length > 0 && (
          <Card>
            <ul className="divide-y divide-border">
              {cups.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="font-medium">
                    {c.name} <span className="text-sm font-normal text-muted">· {cupEntrants.filter((e) => e.competitionId === c.id).length} teams</span>
                  </span>
                  <LinkButton variant="secondary" href={`${base}/cups/${c.id}`}>
                    Manage
                  </LinkButton>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card title="Create a cup" description="A knockout competition. Byes are added automatically when the number of teams isn't a power of two.">
          <ActionForm action={createCupAction} submitLabel="Create cup" submitVariant="secondary">
            <input type="hidden" name="seasonId" value={season.id} />
            <input type="hidden" name="leagueSlug" value={league.slug} />
            <Field label="Name" htmlFor="cup-name">
              <Input id="cup-name" name="name" required maxLength={80} placeholder="e.g. League Cup" />
            </Field>
            <Field label="Match format" htmlFor="cup-tpl" hint="Cup matches must produce a winner. You can change details on the Rules page.">
              <Select id="cup-tpl" name="template" defaultValue={RULE_TEMPLATES[0].key}>
                {RULE_TEMPLATES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name} — {t.description}
                  </option>
                ))}
              </Select>
            </Field>
            {allTeams.length > 0 && (
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium">Teams in the cup</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {allTeams.map((t) => (
                    <label key={t.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="teamId" value={t.id} defaultChecked={leagueTeamIds.has(t.id)} className="h-4 w-4" />
                      {t.name} <span className="text-muted">· {t.division}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </ActionForm>
        </Card>

        <Card title="Season details">
          <ActionForm action={updateSeasonAction} submitLabel="Save season" submitVariant="secondary">
            <input type="hidden" name="seasonId" value={season.id} />
            <SeasonFields
              defaults={{
                name: season.name,
                startsOn: season.startsOn,
                endsOn: season.endsOn ?? "",
                registrationDeadline: season.registrationClosesAt ? localDateInZone(season.registrationClosesAt, league.timezone) : "",
                maxSquadSize: season.maxSquadSize?.toString() ?? "",
              }}
            />
            <Field label="Status" htmlFor="season-status" hint="A draft season stays off the public site until its fixtures are published.">
              <Select id="season-status" name="status" defaultValue={season.status}>
                <option value="DRAFT">Draft</option>
                <option value="ACTIVE">Active</option>
                <option value="COMPLETED">Completed</option>
                <option value="ARCHIVED">Archived</option>
              </Select>
            </Field>
          </ActionForm>
        </Card>
      </div>
    </Page>
  );
}
