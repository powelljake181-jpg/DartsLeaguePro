import type { Metadata } from "next";
import { Button, Card, EmptyState, Page, PageHeader, formatDate } from "@/components/ui";
import { getDb } from "@/db/client";
import { requireActor } from "@/lib/session";
import { inbox } from "@/server/notification-service";
import { markAllReadAction, openNotificationAction } from "./actions";

export const metadata: Metadata = { title: "Notifications" };

/** The signed-in user's inbox: rearrangements, date changes, results and folds that involve them. */
export default async function NotificationsPage() {
  const { user } = await requireActor();
  const items = await inbox(await getDb(), user.id, 100);
  const unread = items.filter((n) => !n.read).length;

  return (
    <Page>
      <PageHeader
        title="Notifications"
        subtitle={unread ? `${unread} unread` : "You're all caught up."}
        actions={
          unread > 0 && (
            <form action={markAllReadAction}>
              <Button variant="secondary">Mark all read</Button>
            </form>
          )
        }
      />
      <Card>
        {items.length === 0 ? (
          <EmptyState>Nothing yet. You&apos;ll hear here about date changes, results and anything else involving your teams.</EmptyState>
        ) : (
          <ul className="-mx-1 divide-y divide-border">
            {items.map((n) => (
              <li key={n.id}>
                <form action={openNotificationAction}>
                  <input type="hidden" name="id" value={n.id} />
                  <input type="hidden" name="href" value={n.href} />
                  <button className="flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left hover:bg-surface-muted">
                    <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? "bg-transparent" : "bg-accent"}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block ${n.read ? "font-medium" : "font-semibold"}`}>
                        {n.title}
                        {!n.read && <span className="sr-only"> (unread)</span>}
                      </span>
                      {n.body && <span className="block text-sm text-muted">{n.body}</span>}
                      <span className="mt-0.5 block text-xs text-muted">{formatDate(n.createdAt, "Europe/London", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                    </span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
