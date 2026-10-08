import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Badge, Card, LinkButton, List, Page, PageHeader, RowLink, formatDate } from "@/components/ui";
import { leaguePeople, leagueSetup } from "@/server/queries";
import { pendingRearrangements } from "@/server/rearrangement-service";
import { loadAdminLeague } from "./load";

export const metadata: Metadata = { title: "Overview" };

export default async function LeagueOverview(props: PageProps<"/admin/[league]">) {
  const { league: slug } = await props.params;
  const { db, league, leagueAdmin, myTeams } = await loadAdminLeague(slug);
  if (!leagueAdmin) redirect(`/admin/${slug}/teams/${myTeams[0].id}`);

  const [setup, people] = await Promise.all([leagueSetup(db, league.id), leaguePeople(db, league.id)]);
  const requests = await pendingRearrangements(db, league.id);
  const base = `/admin/${league.slug}`;
  const steps = [
    { done: setup.divisions.length > 0, label: "Add your divisions", href: `${base}/structure` },
    { done: setup.venues.length > 0, label: "Add the pubs and clubs teams play at", href: `${base}/structure` },
    { done: setup.teams.length > 0, label: "Add teams", href: `${base}/teams` },
    { done: setup.seasons.length > 0, label: "Create a season and put teams in divisions", href: `${base}/seasons` },
    { done: people.teamAdmins.length > 0, label: "Invite team captains so they can register players", href: `${base}/teams` },
  ];
  const nextStep = steps.find((s) => !s.done);
  const current = setup.seasons.find((s) => s.status === "ACTIVE") ?? setup.seasons[0];

  return (
    <Page>
      <PageHeader title="Overview" />
      <div className="grid gap-4 sm:grid-cols-2">
        {requests.length > 0 && (
          <Card title="Date change requests" description="Waiting for the other team to answer. You can answer for them." className="sm:col-span-2">
            <List>
              {requests.map((r) => (
                <RowLink
                  key={r.r.id}
                  href={`${base}/fixtures/${r.fixture.id}`}
                  title={`${r.home} v ${r.away}`}
                  meta={`${r.team}: ${formatDate(r.r.originalAt, league.timezone, { day: "numeric", month: "short" })} → ${formatDate(r.r.proposedAt, league.timezone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`}
                  right={<Badge tone="warning">pending</Badge>}
                />
              ))}
            </List>
          </Card>
        )}
        <Card title="Getting set up" className="sm:col-span-2">
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${s.done ? "bg-accent text-on-accent" : "border border-border text-muted"}`}
                >
                  {s.done ? "✓" : i + 1}
                </span>
                <a href={s.href} className={s.done ? "text-muted line-through" : "font-medium hover:underline"}>
                  {s.label}
                </a>
              </li>
            ))}
          </ol>
          {nextStep && (
            <div className="mt-4">
              <LinkButton href={nextStep.href}>Next: {nextStep.label.toLowerCase()}</LinkButton>
            </div>
          )}
        </Card>
        <Card title="Current season">
          {current ? (
            <List>
              <RowLink
                href={`${base}/seasons/${current.id}`}
                title={current.name}
                meta={current.registrationClosesAt ? `Registration closes ${formatDate(current.registrationClosesAt, league.timezone)}` : "No registration deadline"}
                right={<Badge tone={current.status === "ACTIVE" ? "accent" : "neutral"}>{current.status.toLowerCase()}</Badge>}
              />
            </List>
          ) : (
            <p className="text-sm text-muted">No seasons yet.</p>
          )}
        </Card>
        <Card title="At a glance">
          <dl className="grid grid-cols-3 gap-2 text-center">
            {[
              ["Divisions", setup.divisions.length],
              ["Teams", setup.teams.length],
              ["Venues", setup.venues.length],
            ].map(([label, n]) => (
              <div key={label} className="rounded-lg bg-surface-muted p-3">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-2xl font-bold">{n}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </Page>
  );
}
