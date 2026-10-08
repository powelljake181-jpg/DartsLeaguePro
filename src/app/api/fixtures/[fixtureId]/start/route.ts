import { z } from "zod";
import { fixtureCommand } from "@/lib/api";
import { startFixture } from "@/server/match-service";

export async function POST(request: Request, ctx: RouteContext<"/api/fixtures/[fixtureId]/start">) {
  const { fixtureId } = await ctx.params;
  return fixtureCommand(request, fixtureId, z.object({}), ({ db, actor }) => startFixture(db, actor, fixtureId));
}
