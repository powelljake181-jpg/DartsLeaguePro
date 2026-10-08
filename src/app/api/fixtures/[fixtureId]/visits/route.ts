import { z } from "zod";
import { fixtureCommand } from "@/lib/api";
import { recordVisit } from "@/server/match-service";

const body = z.object({
  clientEventId: z.string().uuid(),
  gameOrdinal: z.number().int().min(1),
  side: z.enum(["HOME", "AWAY"]),
  scored: z.number().int().min(0).max(180),
  darts: z.number().int().min(1).max(3).optional(),
  playerId: z.string().uuid().optional(),
  expectedSeq: z.number().int().min(1).optional(),
});

/** Record a visit. Idempotent by clientEventId, so retries from a flaky connection are safe. */
export async function POST(request: Request, ctx: RouteContext<"/api/fixtures/[fixtureId]/visits">) {
  const { fixtureId } = await ctx.params;
  return fixtureCommand(request, fixtureId, body, ({ db, actor, body }) => recordVisit(db, actor, { fixtureId, ...body }));
}
