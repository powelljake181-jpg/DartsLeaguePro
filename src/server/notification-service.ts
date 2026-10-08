import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { leagueMemberships, notificationDeliveries, notifications, teamMemberships, users } from "@/db/schema";
import { renderNotification, type NotificationEvent } from "@/domain/notifications";
import type { Actor } from "@/domain/permissions";

/**
 * Notifications. Every notification is stored for the in-app inbox; for each
 * external channel configured (email, WhatsApp, push…) a delivery row is
 * queued in the same transaction as the change that caused it — an outbox —
 * and sent afterwards by `deliverPending`, so a slow or failing provider can
 * never roll back or hold up a league action.
 */

export interface Recipients {
  /** Every current league admin of the league. */
  leagueAdmins?: boolean;
  /** Every current team admin of these teams. */
  teamIds?: string[];
}

export interface ChannelMessage {
  to: { userId: string; email: string; name: string };
  title: string;
  body: string;
  /** Absolute link when SITE_URL is set, else a path. */
  url: string;
}

/** An external delivery channel. `send` throws on failure; the outbox retries. */
export interface NotificationChannel {
  name: string;
  send(message: ChannelMessage): Promise<void>;
}

/** Logs messages instead of sending them; useful in development (NOTIFY_CHANNELS=console). */
export const consoleChannel: NotificationChannel = {
  name: "console",
  async send(m) {
    console.info(`[notify] to ${m.to.email}: ${m.title} — ${m.body} (${m.url})`);
  },
};

const BUILT_IN: Record<string, NotificationChannel> = { console: consoleChannel };

/** Channels enabled by NOTIFY_CHANNELS (comma-separated). In-app needs no channel. */
export function configuredChannels(env = process.env.NOTIFY_CHANNELS): NotificationChannel[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((name) => (BUILT_IN[name] ? [BUILT_IN[name]] : []));
}

/** Users who should hear about something: resolved from current memberships, deduplicated. */
export async function resolveRecipients(db: Db, leagueId: string, r: Recipients): Promise<string[]> {
  const ids = new Set<string>();
  if (r.leagueAdmins) {
    const rows = await db
      .select({ userId: leagueMemberships.userId })
      .from(leagueMemberships)
      .where(and(eq(leagueMemberships.leagueId, leagueId), isNull(leagueMemberships.revokedAt)));
    rows.forEach((x) => ids.add(x.userId));
  }
  if (r.teamIds?.length) {
    const rows = await db
      .select({ userId: teamMemberships.userId })
      .from(teamMemberships)
      .where(and(inArray(teamMemberships.teamId, r.teamIds), isNull(teamMemberships.revokedAt)));
    rows.forEach((x) => ids.add(x.userId));
  }
  return [...ids];
}

/**
 * Queue a notification for the recipients (never for the person who caused
 * it). Call inside the transaction that makes the change.
 */
export async function notify(
  db: Db,
  input: { leagueId: string; event: NotificationEvent; to: Recipients; actor?: Actor | null },
  channels: NotificationChannel[] = configuredChannels(),
): Promise<number> {
  const userIds = (await resolveRecipients(db, input.leagueId, input.to)).filter((id) => id !== input.actor?.userId);
  if (!userIds.length) return 0;
  const rows = await db
    .insert(notifications)
    .values(userIds.map((userId) => ({ userId, leagueId: input.leagueId, type: input.event.type, payload: input.event.payload })))
    .returning({ id: notifications.id });
  if (channels.length) {
    await db.insert(notificationDeliveries).values(rows.flatMap((n) => channels.map((c) => ({ notificationId: n.id, channel: c.name }))));
  }
  return rows.length;
}

export const MAX_ATTEMPTS = 5;

/**
 * Send queued deliveries. Each is tried up to MAX_ATTEMPTS times (across
 * runs); after that it is marked FAILED. Safe to run concurrently with itself
 * only on one instance — fine for a single-server deployment.
 */
export async function deliverPending(
  db: Db,
  channels: NotificationChannel[] = configuredChannels(),
  opts: { limit?: number; siteUrl?: string } = {},
): Promise<{ sent: number; failed: number }> {
  const byName = new Map(channels.map((c) => [c.name, c]));
  const pending = await db
    .select({ d: notificationDeliveries, n: notifications, user: { id: users.id, email: users.email, name: users.name } })
    .from(notificationDeliveries)
    .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(eq(notificationDeliveries.status, "PENDING"), lt(notificationDeliveries.attempts, MAX_ATTEMPTS)))
    .orderBy(asc(notificationDeliveries.createdAt))
    .limit(opts.limit ?? 100);

  const site = (opts.siteUrl ?? process.env.SITE_URL ?? "").replace(/\/$/, "");
  let sent = 0;
  let failed = 0;
  for (const { d, n, user } of pending) {
    const channel = byName.get(d.channel);
    if (!channel) continue; // channel switched off; leave queued
    const r = renderNotification(n.type, n.payload);
    try {
      await channel.send({ to: { userId: user.id, email: user.email, name: user.name }, title: r.title, body: r.body, url: `${site}${r.href}` });
      await db.update(notificationDeliveries).set({ status: "SENT", sentAt: new Date(), attempts: d.attempts + 1, lastError: null }).where(eq(notificationDeliveries.id, d.id));
      sent++;
    } catch (e) {
      const attempts = d.attempts + 1;
      await db
        .update(notificationDeliveries)
        .set({ attempts, lastError: e instanceof Error ? e.message : String(e), status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING" })
        .where(eq(notificationDeliveries.id, d.id));
      failed++;
    }
  }
  return { sent, failed };
}

/** Fire-and-forget delivery after a change has committed. Errors are logged, never thrown. */
export function kickDelivery(db: Db): void {
  if (!configuredChannels().length) return;
  void deliverPending(db).catch((e) => console.error("[notify] delivery run failed", e));
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export async function inbox(db: Db, userId: string, limit = 50) {
  const rows = await db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(limit);
  return rows.map((n) => ({ id: n.id, type: n.type, createdAt: n.createdAt, read: !!n.readAt, ...renderNotification(n.type, n.payload) }));
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return n;
}

/** Mark some (or, with no ids, all) of a user's notifications read. Only ever touches the user's own rows. */
export async function markRead(db: Db, userId: string, ids?: string[]): Promise<void> {
  const where = [eq(notifications.userId, userId), isNull(notifications.readAt)];
  if (ids) {
    if (!ids.length) return;
    where.push(inArray(notifications.id, ids));
  }
  await db.update(notifications).set({ readAt: new Date() }).where(and(...where));
}
