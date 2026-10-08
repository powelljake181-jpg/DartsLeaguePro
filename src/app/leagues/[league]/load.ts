import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db/client";
import { seasonHref } from "@/components/public";
import { AppError } from "@/server/errors";
import { pickSeason, publicLeague } from "@/server/public-service";

/** Turn a not-found from a read model into the 404 page. */
export function or404<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
}

/** The public league and its visible seasons. Memoised per request. */
export const loadPublicLeague = cache(async (slug: string) => {
  const db = await getDb();
  const data = await or404(publicLeague(db, slug));
  return { db, ...data };
});

/**
 * League + the season chosen by `?season=` (default: the active one), and a
 * link helper that keeps the chosen season.
 */
export async function loadLeagueSeason(slug: string, searchParams: Promise<Record<string, string | string[] | undefined>>) {
  const ctx = await loadPublicLeague(slug);
  const params = await searchParams;
  const season = pickSeason(ctx.seasons, params.season);
  const defaultSeasonId = pickSeason(ctx.seasons, undefined)?.id ?? null;
  const base = `/leagues/${ctx.league.slug}`;
  const href = (path: string, extra: Record<string, string | null | undefined> = {}) => seasonHref(`${base}${path}`, season?.id ?? null, defaultSeasonId, extra);
  const param = (k: string) => (typeof params[k] === "string" ? (params[k] as string) : null);
  return { ...ctx, season, href, param, base, seasonQuery: href("").slice(base.length) };
}
