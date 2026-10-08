import { z } from "zod";
import { fixtureCommand } from "@/lib/api";
import { setFirstThrower } from "@/server/match-service";

const body = z.object({ gameOrdinal: z.number().int().min(1), side: z.enum(["HOME", "AWAY"]) });

export async function POST(request: Request, ctx: RouteContext<"/api/fixtures/[fixtureId]/first-thrower">) {
  const { fixtureId } = await ctx.params;
  return fixtureCommand(request, fixtureId, body, ({ db, actor, body }) => setFirstThrower(db, actor, { fixtureId, ...body }));
}
