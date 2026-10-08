import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db/client";
import { ForbiddenError } from "@/domain/permissions";
import { requireActor } from "@/lib/session";
import { AppError } from "@/server/errors";
import { adminLeague } from "@/server/queries";

/**
 * The league for an admin page. Leagues the user cannot manage show the 404
 * page, which also avoids revealing which leagues exist. Memoised per request.
 */
export const loadAdminLeague = cache(async (slug: string) => {
  const { user, actor } = await requireActor();
  const db = await getDb();
  try {
    const scope = await adminLeague(db, actor, slug);
    return { db, user, actor, ...scope };
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
});

/** Like loadAdminLeague, but league admins only. */
export async function loadLeagueAdminOnly(slug: string) {
  const ctx = await loadAdminLeague(slug);
  if (!ctx.leagueAdmin) notFound();
  return ctx;
}
