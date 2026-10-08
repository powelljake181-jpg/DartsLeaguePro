import { getDb } from "@/db/client";
import { errorResponse, json } from "@/lib/api";
import { liveSnapshot } from "@/server/live-service";

/** Public: the current state of a fixture. */
export async function GET(_: Request, ctx: RouteContext<"/api/fixtures/[fixtureId]/live">) {
  const { fixtureId } = await ctx.params;
  try {
    return json(await liveSnapshot(await getDb(), fixtureId));
  } catch (e) {
    return errorResponse(e);
  }
}
