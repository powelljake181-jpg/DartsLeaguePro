import "server-only";
import { z } from "zod";
import { getDb, type Db } from "@/db/client";
import { TransitionError } from "@/domain/fixture-state";
import { ForbiddenError, type Actor } from "@/domain/permissions";
import { ScoringError } from "@/domain/scoring";
import { loadActor } from "@/server/context";
import { AppError } from "@/server/errors";
import { publishFixtureChanged } from "@/server/events";
import { liveSnapshot } from "@/server/live-service";
import { currentUser } from "./session";

/**
 * JSON API helpers for match-day routes. These are plain route handlers (not
 * server actions) so the scoring phone can queue requests offline and replay
 * them later. Same-origin JSON only; the session cookie identifies the user.
 */

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function errorResponse(e: unknown): Response {
  if (e instanceof ForbiddenError) return json({ error: "You don't have permission to do that.", code: "FORBIDDEN" }, 403);
  if (e instanceof AppError) return json({ error: e.message, code: e.code, details: e.details }, e.status);
  if (e instanceof ScoringError) return json({ error: e.message, code: e.code }, 422);
  if (e instanceof TransitionError) return json({ error: e.message, code: "INVALID_STATE" }, 409);
  console.error(e);
  return json({ error: "Something went wrong. Try again.", code: "SERVER_ERROR" }, 500);
}

/**
 * Handle a scoring command for a fixture: check origin and session, validate the
 * body, run the command, notify live viewers, and return the fresh snapshot.
 */
export async function fixtureCommand<S extends z.ZodType>(
  request: Request,
  fixtureId: string,
  schema: S,
  run: (ctx: { db: Db; actor: Actor; body: z.infer<S> }) => Promise<unknown>,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "Cross-site request refused.", code: "BAD_ORIGIN" }, 403);
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "Send JSON.", code: "BAD_REQUEST" }, 415);

  const user = await currentUser();
  if (!user) return json({ error: "Your session has ended. Sign in again.", code: "UNAUTHENTICATED" }, 401);
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "Invalid JSON.", code: "BAD_REQUEST" }, 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return json({ error: parsed.error.issues[0].message, code: "BAD_REQUEST" }, 400);

  try {
    const db = await getDb();
    const actor = await loadActor(db, user.id);
    const result = await run({ db, actor, body: parsed.data });
    publishFixtureChanged(fixtureId);
    return json({ ok: true, result, snapshot: await liveSnapshot(db, fixtureId) });
  } catch (e) {
    return errorResponse(e);
  }
}
