import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { getDb } from "@/db/client";
import { currentUser } from "@/lib/session";
import { unreadCount } from "@/server/notification-service";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Darts League", template: "%s · Darts League" },
  description: "Fixtures, results, tables, live scores and player statistics for local darts leagues.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1411" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}

async function SiteHeader() {
  const user = await currentUser();
  const unread = user ? await unreadCount(await getDb(), user.id) : 0;
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-full bg-accent text-sm text-on-accent">
            ◎
          </span>
          Darts League
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {user ? (
            <>
              <Link
                href="/notifications"
                className="relative rounded-lg px-3 py-2 font-medium hover:bg-surface-muted"
                aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
              >
                <span aria-hidden>🔔</span>
                {unread > 0 && (
                  <span aria-hidden className="absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full bg-live px-1 text-[10px] font-bold leading-4 text-white">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </Link>
              <Link href="/admin" className="rounded-lg px-3 py-2 font-medium hover:bg-surface-muted">
                Admin
              </Link>
              <form action="/logout" method="post">
                <button className="rounded-lg px-3 py-2 text-muted hover:bg-surface-muted hover:text-foreground">Sign out</button>
              </form>
            </>
          ) : (
            <Link href="/login" className="rounded-lg px-3 py-2 font-medium hover:bg-surface-muted">
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
