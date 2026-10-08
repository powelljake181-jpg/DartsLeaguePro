"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function AdminTabs({ tabs }: { tabs: { href: string; label: string; exact?: boolean }[] }) {
  const path = usePathname();
  return (
    <nav className="-mx-4 overflow-x-auto px-4" aria-label="League admin">
      <ul className="flex gap-1 border-b border-border">
        {tabs.map((t) => {
          const active = t.exact ? path === t.href : path === t.href || path.startsWith(`${t.href}/`);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
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
