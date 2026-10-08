import { sql } from "drizzle-orm";
import { getDb } from "@/db/client";

/** For the host's health check: the app is up and can reach its database. */
export async function GET() {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (e) {
    // The response stays generic; the log says why.
    const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
    const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : "";
    console.error(`[health] database check failed: ${message}${cause}`);
    return Response.json({ ok: false }, { status: 503 });
  }
}
