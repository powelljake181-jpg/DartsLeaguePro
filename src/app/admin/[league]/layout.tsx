import Link from "next/link";
import { loadAdminLeague } from "./load";
import { AdminTabs } from "./nav";

export default async function LeagueAdminLayout(props: LayoutProps<"/admin/[league]">) {
  const { league: slug } = await props.params;
  const { league, leagueAdmin, myTeams } = await loadAdminLeague(slug);
  const base = `/admin/${league.slug}`;
  const tabs = leagueAdmin
    ? [
        { href: base, label: "Overview", exact: true },
        { href: `${base}/seasons`, label: "Seasons" },
        { href: `${base}/teams`, label: "Teams" },
        { href: `${base}/structure`, label: "Divisions & venues" },
        { href: `${base}/people`, label: "People" },
        { href: `${base}/activity`, label: "Activity" },
      ]
    : myTeams.map((t) => ({ href: `${base}/teams/${t.id}`, label: t.name }));

  return (
    <div>
      <div className="border-b border-border bg-surface">
        <div className="mx-auto max-w-4xl px-4 pt-4">
          <Link href="/admin" className="text-xs font-medium uppercase tracking-wide text-muted hover:text-foreground">
            Admin
          </Link>
          <p className="mb-2 text-lg font-bold">{league.name}</p>
          <AdminTabs tabs={tabs} />
        </div>
      </div>
      {props.children}
    </div>
  );
}
