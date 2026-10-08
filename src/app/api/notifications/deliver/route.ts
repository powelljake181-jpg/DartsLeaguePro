import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/db/client";
import { deliverPending } from "@/server/notification-service";

/**
 * Sends queued external notifications (email, WhatsApp…). Deliveries are also
 * attempted straight after each change; a scheduler (e.g. a Render cron job)
 * should call this every few minutes to retry failures:
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://…/api/notifications/deliver
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  return Response.json(await deliverPending(await getDb()));
}
