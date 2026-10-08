import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BracketView } from "@/components/bracket";
import { ActionForm } from "@/components/form";
import { Badge, Card, EmptyState, Field, Input, LinkButton, Notice, Page, PageHeader, Select } from "@/components/ui";
import { bracketSize } from "@/domain/cups";
import { ForbiddenError } from "@/domain/permissions";
import { cupAdmin } from "@/server/cup-service";
import { AppError } from "@/server/errors";
import { isUuid } from "@/server/public-service";
import { addCupEntrantAction, removeCupEntrantAction, setCupRoundDateAction, setCupSeedsAction } from "../../../cup-actions";
import { loadLeagueAdminOnly } from "../../load";
import { DrawForm } from "./draw-form";

export const metadata: Metadata = { title: "Cup" };

/** Running a cup: entrants and seeds, round dates (cup nights), the draw, and the bracket. */
export default async function CupAdminPage(props: PageProps<"/admin/[league]/cups/[competitionId]">) {
  const { league: slug, competitionId } = await props.params;
  const { db, actor, league } = await loadLeagueAdminOnly(slug);
  if (!isUuid(competitionId)) notFound();
  const cup = await cupAdmin(db, actor, competitionId).catch((e) => {
    if (e instanceof ForbiddenError || (e instanceof AppError && e.status === 404)) notFound();
    throw e;
  });
  if (cup.competition.leagueId !== league.id) notFound();
  const base = `/admin/${league.slug}`;
  const active = cup.entries.filter((e) => e.entry.status === "ACTIVE");
  const size = active.length >= 2 ? bracketSize(active.length) : 0;

  return (
    <Page>
      <PageHeader
        title={cup.competition.name}
        subtitle={`${cup.season.name} · ${cup.entries.length} teams${size ? ` · ${size - active.length} bye${size - active.length === 1 ? "" : "s"}` : ""}`}
        back={{ href: `${base}/seasons/${cup.season.id}`, label: "Season" }}
        actions={
          <>
            <LinkButton variant="secondary" href={`${base}/competitions/${competitionId}/rules`}>
              Rules
            </LinkButton>
            <LinkButton variant="secondary" href={`/leagues/${league.slug}/divisions/${competitionId}`}>
              Public page
            </LinkButton>
          </>
        }
      />
      <div className="space-y-4">
        {cup.champion && <Notice tone="accent">🏆 {cup.champion.name} won the {cup.competition.name}.</Notice>}

        {cup.drawn && (
          <Card title="Bracket" description="Tap a tie to manage it: teams, date changes, results.">
            <BracketView bracket={cup} tieHref={(id) => `${base}/fixtures/${id}`} />
          </Card>
        )}

        <Card title="Cup nights" description="League fixtures aren't generated on these dates. Ties are created as soon as both teams are known and their round has a date.">
          {cup.rounds.length === 0 ? (
            <EmptyState>Add at least two teams first.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {cup.rounds.map((r) => (
                <li key={r.id} className="py-3">
                  <ActionForm action={setCupRoundDateAction} submitLabel="Save" submitVariant="secondary" className="flex flex-col gap-2 sm:flex-row sm:items-end">
                    <input type="hidden" name="roundId" value={r.id} />
                    <span className="w-36 shrink-0 font-medium sm:pb-3">{r.name}</span>
                    <Field label="Date" htmlFor={`d-${r.id}`}>
                      <Input id={`d-${r.id}`} name="date" type="date" defaultValue={r.scheduledOn ?? ""} required />
                    </Field>
                    <Field label="Start" htmlFor={`t-${r.id}`}>
                      <Input id={`t-${r.id}`} name="time" type="time" defaultValue={r.kickOff} required />
                    </Field>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Teams" description={cup.drawn ? "To withdraw a team now, fold it: its remaining tie goes to the opponent." : "Seeds are only used for a seeded draw. Leave blank for unseeded."}>
          {cup.entries.length === 0 ? (
            <EmptyState>No teams yet.</EmptyState>
          ) : cup.drawn ? (
            <ul className="divide-y divide-border">
              {cup.entries.map((e) => (
                <li key={e.entry.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="font-medium">
                    {e.entry.displayName} {e.entry.status !== "ACTIVE" && <Badge tone="danger">withdrawn</Badge>}
                  </span>
                  <LinkButton variant="ghost" href={`${base}/seasons/${cup.season.id}/fold/${e.entry.id}`}>
                    {e.entry.status === "ACTIVE" ? "Withdraw" : "Reverse"}
                  </LinkButton>
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-4">
              <ActionForm action={setCupSeedsAction} submitLabel="Save seeds" submitVariant="secondary">
                <input type="hidden" name="competitionId" value={competitionId} />
                <ul className="divide-y divide-border">
                  {cup.entries.map((e) => (
                    <li key={e.entry.id} className="flex items-center justify-between gap-3 py-2">
                      <span className="font-medium">{e.entry.displayName}</span>
                      <span className="flex items-center gap-2">
                        <label className="sr-only" htmlFor={`seed-${e.entry.id}`}>
                          Seed for {e.entry.displayName}
                        </label>
                        <Input id={`seed-${e.entry.id}`} name={`seed:${e.entry.id}`} inputMode="numeric" placeholder="Seed" defaultValue={e.entry.seed ?? ""} className="w-20" />
                      </span>
                    </li>
                  ))}
                </ul>
              </ActionForm>
              <div className="flex flex-wrap gap-2">
                {cup.entries.map((e) => (
                  <ActionForm key={e.entry.id} action={removeCupEntrantAction} submitLabel={`Remove ${e.entry.displayName}`} submitVariant="secondary" className="contents">
                    <input type="hidden" name="entryId" value={e.entry.id} />
                  </ActionForm>
                ))}
              </div>
              {cup.otherTeams.length > 0 && (
                <ActionForm action={addCupEntrantAction} submitLabel="Add team" submitVariant="secondary" className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <input type="hidden" name="competitionId" value={competitionId} />
                  <div className="flex-1">
                    <Field label="Add a team" htmlFor="cup-add">
                      <Select id="cup-add" name="teamId" required defaultValue="">
                        <option value="" disabled>
                          Choose a team…
                        </option>
                        {cup.otherTeams.map((t) => (
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
          )}
        </Card>

        {(!cup.drawn || cup.canRedraw) && active.length >= 2 && (
          <Card title={cup.drawn ? "Redo the draw" : "The draw"}>
            {!cup.rounds[0]?.scheduledOn ? (
              <Notice tone="warning">Set the date of the {cup.rounds[0]?.name.toLowerCase()} first.</Notice>
            ) : (
              <DrawForm competitionId={competitionId} entrants={active.map((e) => ({ id: e.entry.id, name: e.entry.displayName }))} firstRoundTies={size / 2} redraw={cup.drawn} />
            )}
          </Card>
        )}
      </div>
    </Page>
  );
}
