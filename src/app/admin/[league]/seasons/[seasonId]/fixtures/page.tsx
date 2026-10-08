import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, EmptyState, LinkButton, Page, PageHeader, formatDate } from "@/components/ui";
import { localDateInZone } from "@/domain/dates";
import { AppError } from "@/server/errors";
import { seasonSetup } from "@/server/queries";
import { seasonFixtures } from "@/server/schedule-service";
import { loadLeagueAdminOnly } from "../../../load";

export const metadata: Metadata = { title: "Fixtures" };

const STATUS_TONE = { LIVE: "live", COMPLETED: "accent", POSTPONED: "warning", REARRANGEMENT_REQUESTED: "warning", CANCELLED: "danger", VOID: "danger", SCHEDULED: "neutral" } as const;

/** All league fixtures for a season, by date, optionally for one division. */
export default async function FixturesPage(props: PageProps<"/admin/[league]/seasons/[seasonId]/fixtures">) {
  const { league: slug, seasonId } = await props.params;
  const { division } = await props.searchParams;
  const { db, league } = await loadLeagueAdminOnly(slug);
  const setup = await seasonSetup(db, league.id, seasonId).catch((e) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
  const data = await seasonFixtures(db, seasonId);
  const filter = typeof division === "string" ? division : null;
  const list = data.fixtures.filter((f) => !filter || f.competitionId === filter);
  const byDate = new Map<string, typeof list>();
  for (const f of list) {
    const d = localDateInZone(f.scheduledAt, league.timezone);
    byDate.set(d, [...(byDate.get(d) ?? []), f]);
  }
  const compName = new Map(data.competitions.map((c) => [c.id, c.name]));
  // Within a night, group by division (top division first), then by home team.
  const rank = new Map(setup.divisions.map((d, i) => [d.competition?.id, i]));
  for (const fs of byDate.values()) {
    fs.sort((x, y) => (rank.get(x.competitionId) ?? 0) - (rank.get(y.competitionId) ?? 0) || data.names[x.homeEntryId].localeCompare(data.names[y.homeEntryId]));
  }
  const base = `/admin/${league.slug}/seasons/${seasonId}`;

  return (
    <Page>
      <PageHeader
        title="Fixtures"
        subtitle={`${setup.season.name} · ${list.length} fixtures`}
        back={{ href: base, label: setup.season.name }}
        actions={<LinkButton variant="secondary" href={`${base}/schedule`}>Schedule</LinkButton>}
      />
      {data.competitions.length > 1 && (
        <nav className="mb-4 flex flex-wrap gap-2" aria-label="Division">
          {[{ id: null as string | null, name: "All" }, ...data.competitions.map((c) => ({ id: c.id as string | null, name: c.name }))].map((c) => (
            <Link
              key={c.id ?? "all"}
              href={c.id ? `?division=${c.id}` : "?"}
              className={`rounded-full border px-3 py-1 text-sm ${c.id === filter ? "border-accent bg-accent-soft font-semibold" : "border-border text-muted"}`}
            >
              {c.name}
            </Link>
          ))}
        </nav>
      )}
      {list.length === 0 ? (
        <EmptyState>No fixtures yet. Generate them from the Schedule page.</EmptyState>
      ) : (
        <div className="space-y-4">
          {[...byDate].map(([date, fs]) => (
            <Card key={date} title={formatDate(date, "UTC", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}>
              <ul className="divide-y divide-border">
                {fs.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="w-full text-xs text-muted sm:w-28">
                      {compName.get(f.competitionId)} · Wk {f.roundNumber}
                    </span>
                    <Link href={`/admin/${league.slug}/fixtures/${f.id}`} className="flex-1 font-medium hover:underline">
                      {data.names[f.homeEntryId]} <span className="font-normal text-muted">v</span> {f.awayEntryId ? data.names[f.awayEntryId] : "bye"}
                    </Link>
                    <span className="text-sm text-muted">
                      {formatDate(f.scheduledAt, league.timezone, { hour: "2-digit", minute: "2-digit" })}
                      {f.venueId && ` · ${data.venues[f.venueId]}`}
                    </span>
                    {f.status !== "SCHEDULED" && <Badge tone={STATUS_TONE[f.status]}>{f.status.toLowerCase().replace("_", " ")}</Badge>}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
