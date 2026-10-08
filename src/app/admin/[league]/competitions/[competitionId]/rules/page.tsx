import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, Page, PageHeader, formatDate } from "@/components/ui";
import { localDateInZone } from "@/domain/dates";
import { periodFor } from "@/domain/rule-periods";
import { AppError } from "@/server/errors";
import { competitionRules } from "@/server/queries";
import { loadLeagueAdminOnly } from "../../../load";
import { RulesEditor } from "./rules-editor";

export const metadata: Metadata = { title: "Rules" };

export default async function RulesPage(props: PageProps<"/admin/[league]/competitions/[competitionId]/rules">) {
  const { league: slug, competitionId } = await props.params;
  const { db, league } = await loadLeagueAdminOnly(slug);
  const data = await competitionRules(db, league.id, competitionId).catch((e) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
  const today = localDateInZone(new Date(), league.timezone);
  const current = periodFor(data.periods, today);

  return (
    <Page>
      <PageHeader
        title={`${data.competition.name} rules`}
        subtitle={data.season.name}
        back={{ href: `/admin/${league.slug}/seasons/${data.season.id}`, label: data.season.name }}
      />
      <div className="space-y-4">
        <Card title="History" description="Each change applies from its date. Fixtures are scored with the rules in force on the day they were played.">
          <ol className="space-y-2">
            {data.periods.map((p) => (
              <li key={p.effectiveFrom} className={`rounded-lg px-3 py-2 ${p === current ? "bg-accent-soft" : "bg-surface-muted"}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <span className="font-medium">From {formatDate(p.effectiveFrom)}</span>
                  {p === current && <span className="text-xs font-semibold text-accent-strong">In force today</span>}
                </div>
                <div className="text-sm text-muted">
                  {p.reason ?? "No reason given"}
                  {p.by && ` · ${p.by}`}
                </div>
              </li>
            ))}
          </ol>
        </Card>
        <RulesEditor competitionId={data.competition.id} current={current.rules} seasonStart={data.season.startsOn} today={today} />
      </div>
    </Page>
  );
}
