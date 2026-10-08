"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

type Tab = { href: string; label: string; exact?: boolean };

/** League tabs. Keeps the chosen season (`?season=`) when switching tabs. */
export function LeagueTabs({ tabs }: { tabs: Tab[] }) {
  return (
    <Suspense fallback={<Tabs tabs={tabs} season={null} />}>
      <TabsWithSeason tabs={tabs} />
    </Suspense>
  );
}

function TabsWithSeason({ tabs }: { tabs: Tab[] }) {
  return <Tabs tabs={tabs} season={useSearchParams().get("season")} />;
}

function Tabs({ tabs, season }: { tabs: Tab[]; season: string | null }) {
  const path = usePathname();
  const q = season ? `?season=${encodeURIComponent(season)}` : "";
  return (
    <nav className="-mx-4 overflow-x-auto px-4" aria-label="League">
      <ul className="flex gap-1 border-b border-border">
        {tabs.map((t) => {
          const active = t.exact ? path === t.href : path === t.href || path.startsWith(`${t.href}/`);
          return (
            <li key={t.href}>
              <Link
                href={`${t.href}${q}`}
                aria-current={active ? "page" : undefined}
                className={`block whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${
                  active ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
