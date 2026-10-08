import { Pills, seasonHref } from "@/components/public";
import { pickSeason, type Season } from "@/server/public-service";

/** Season switcher, shown only when a league has more than one public season. */
export function SeasonPills({ seasons, season, path, extra = {} }: { seasons: Season[]; season: Season | null; path: string; extra?: Record<string, string | null> }) {
  if (seasons.length < 2) return null;
  const defaultId = pickSeason(seasons, undefined)?.id ?? null;
  return (
    <Pills
      label="Season"
      items={seasons.map((s) => ({ href: seasonHref(path, s.id, defaultId, extra), label: s.name, active: s.id === season?.id }))}
    />
  );
}
