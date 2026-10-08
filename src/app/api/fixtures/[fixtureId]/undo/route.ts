import { z } from "zod";
import { fixtureCommand } from "@/lib/api";
import { undoVisit } from "@/server/match-service";

const body = z.object({ visitClientEventId: z.string().uuid() });

/** Undo the most recent visit of a game. Idempotent. */
export async function POST(request: Request, ctx: RouteContext<"/api/fixtures/[fixtureId]/undo">) {
  const { fixtureId } = await ctx.params;
  return fixtureCommand(request, fixtureId, body, ({ db, actor, body }) => undoVisit(db, actor, { fixtureId, ...body }));
}
