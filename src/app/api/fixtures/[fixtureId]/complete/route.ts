import { z } from "zod";
import { fixtureCommand } from "@/lib/api";
import { completeFixture } from "@/server/match-service";

/** The scorer confirms the final result; the league table updates at this moment. */
export async function POST(request: Request, ctx: RouteContext<"/api/fixtures/[fixtureId]/complete">) {
  const { fixtureId } = await ctx.params;
  return fixtureCommand(request, fixtureId, z.object({}), ({ db, actor }) => completeFixture(db, actor, fixtureId));
}
