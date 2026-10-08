import type { Metadata } from "next";
import Link from "next/link";
import { loadPublicLeague } from "./load";
import { LeagueTabs } from "./nav";

export async function generateMetadata(props: LayoutProps<"/leagues/[league]">): Promise<Metadata> {
  const { league: slug } = await props.params;
  const { league } = await loadPublicLeague(slug);
  return { title: { default: league.name, template: `%s · ${league.name}` } };
}

export default async function LeagueLayout(props: LayoutProps<"/leagues/[league]">) {
  const { league: slug } = await props.params;
  const { league } = await loadPublicLeague(slug);
  const base = `/leagues/${league.slug}`;
  const tabs = [
    { href: base, label: "Overview", exact: true },
    { href: `${base}/tables`, label: "Tables" },
    { href: `${base}/fixtures`, label: "Fixtures" },
    { href: `${base}/results`, label: "Results" },
    { href: `${base}/leaderboards`, label: "Leaderboards" },
    { href: `${base}/teams`, label: "Teams" },
  ];
  return (
    <div>
      <div className="border-b border-border bg-surface">
        <div className="mx-auto max-w-4xl px-4 pt-4">
          <Link href={base} className="mb-2 block text-lg font-bold">
            {league.name}
          </Link>
          <LeagueTabs tabs={tabs} />
        </div>
      </div>
      {props.children}
    </div>
  );
}
