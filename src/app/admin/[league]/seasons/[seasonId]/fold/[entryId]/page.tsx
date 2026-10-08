import type { Metadata } from "next";
import { and, eq, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/form";
import { Card, Field, Input, Notice, Page, PageHeader, formatDate } from "@/components/ui";
import { competitions, fixtures, teamEntries } from "@/db/schema";
import { localDateInZone } from "@/domain/dates";
import { activeFolds } from "@/server/fold-service";
import { isUuid } from "@/server/public-service";
import { revertFoldAction } from "../../../../../fixture-actions";
import { loadLeagueAdminOnly } from "../../../../load";
import { FoldForm } from "./fold-form";

export const metadata: Metadata = { title: "Fold team" };

/** Withdraw a team from a division mid-season, or reverse an earlier fold. */
export default async function FoldPage(props: PageProps<"/admin/[league]/seasons/[seasonId]/fold/[entryId]">) {
  const { league: slug, seasonId, entryId } = await props.params;
  const { db, league } = await loadLeagueAdminOnly(slug);
  if (!isUuid(entryId) || !isUuid(seasonId)) notFound();
  const [row] = await db
    .select({ entry: teamEntries, competition: competitions })
    .from(teamEntries)
    .innerJoin(competitions, eq(competitions.id, teamEntries.competitionId))
    .where(and(eq(teamEntries.id, entryId), eq(competitions.seasonId, seasonId), eq(competitions.leagueId, league.id)));
  if (!row) notFound();
  const back = { href: `/admin/${league.slug}/seasons/${seasonId}`, label: "Season" };
  const fold = (await activeFolds(db, seasonId)).find((f) => f.entry.id === entryId);

  if (row.entry.status !== "ACTIVE") {
    return (
      <Page narrow>
        <PageHeader title={`Reverse fold: ${row.entry.displayName}`} subtitle={row.competition.name} back={back} />
        {fold ? (
          <Card description={`Folded ${formatDate(fold.event.foldedAt, league.timezone)}. Reversing puts every fixture the fold changed back exactly as it was, as long as none has been changed since.`}>
            <ActionForm action={revertFoldAction} submitLabel="Reverse fold">
              <input type="hidden" name="foldEventId" value={fold.event.id} />
              <Field label="Reason" htmlFor="revert-reason" hint="Every team in the division will see this.">
                <Input id="revert-reason" name="reason" required maxLength={500} />
              </Field>
            </ActionForm>
          </Card>
        ) : (
          <Notice>This team was withdrawn without a fold record, so there is nothing to reverse automatically.</Notice>
        )}
      </Page>
    );
  }

  const theirs = await db
    .select({ scheduledAt: fixtures.scheduledAt })
    .from(fixtures)
    .where(and(eq(fixtures.competitionId, row.competition.id), or(eq(fixtures.homeEntryId, entryId), eq(fixtures.awayEntryId, entryId))));
  const dateFmt = Object.fromEntries(
    theirs.map((f) => [localDateInZone(f.scheduledAt, league.timezone), formatDate(f.scheduledAt, league.timezone, { weekday: "short", day: "numeric", month: "short" })]),
  );

  return (
    <Page>
      <PageHeader
        title={`${row.competition.kind === "CUP" ? "Withdraw" : "Fold"} ${row.entry.displayName}`}
        subtitle={`${row.competition.name} · ${row.competition.kind === "CUP" ? "the team is leaving the cup" : "the team has withdrawn mid-season"}`}
        back={back}
      />
      <FoldForm entryId={entryId} team={row.entry.displayName} dateFmt={dateFmt} cup={row.competition.kind === "CUP"} />
    </Page>
  );
}
