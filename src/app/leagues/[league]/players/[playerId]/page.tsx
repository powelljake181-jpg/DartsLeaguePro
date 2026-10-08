import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, EmptyState, Page, PageHeader, formatDate } from "@/components/ui";
import { StatTile, fmtAvg, fmtPct } from "@/components/public";
import { aggregate, threeDartAverage, winPercentage, type StatTotals } from "@/domain/stats";
import { playerProfile, type GameLogRow } from "@/server/public-service";
import { loadPublicLeague, or404 } from "../../load";

const load = async (slug: string, playerId: string) => {
  const { db, league } = await loadPublicLeague(slug);
  return { league, profile: await or404(playerProfile(db, league.id, playerId)) };
};

export async function generateMetadata(props: PageProps<"/leagues/[league]/players/[playerId]">): Promise<Metadata> {
  const { league, playerId } = await props.params;
  const { profile } = await load(league, playerId);
  return { title: profile.name };
}

const total = (games: GameLogRow[]) => aggregate(games.map((g) => g.totals));

/** A player's career: headline numbers, a row per season (singles and pairs apart) and every game. */
export default async function PlayerPage(props: PageProps<"/leagues/[league]/players/[playerId]">) {
  const { league: slug, playerId } = await props.params;
  const { league, profile } = await load(slug, playerId);
  const { games, registrations, bands } = profile;
  const base = `/leagues/${league.slug}`;
  const career = total(games);
  const current = registrations.find((r) => r.registration.status === "ACTIVE" && r.season.status === "ACTIVE");
  const hasPairs = games.some((g) => g.gameKind === "PAIRS");

  // One row per season the player was registered (newest first), split by game kind when they've played pairs.
  const seasonIds = [...new Set(registrations.map((r) => r.season.id))];
  const seasonRows = seasonIds.flatMap((id) => {
    const reg = registrations.filter((r) => r.season.id === id);
    const inSeason = games.filter((g) => g.seasonId === id);
    const teamNames = [...new Set(reg.map((r) => r.team.name))].join(", ");
    const kinds: { label: string; totals: StatTotals }[] = hasPairs
      ? (["SINGLES", "PAIRS"] as const).map((k) => ({ label: k === "SINGLES" ? "Singles" : "Pairs", totals: total(inSeason.filter((g) => g.gameKind === k)) }))
      : [{ label: "", totals: total(inSeason) }];
    return kinds.map((k) => ({ key: `${id}-${k.label}`, season: reg[0].season.name, teams: teamNames, kind: k.label, totals: k.totals }));
  });

  return (
    <Page>
      <PageHeader
        title={profile.name}
        subtitle={
          current ? (
            <Link href={`${base}/teams/${current.team.slug}`} className="hover:underline">
              {current.team.name}
            </Link>
          ) : undefined
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Games" value={career.gamesPlayed} hint={`${career.wins} won`} />
        <StatTile label="Win %" value={fmtPct(winPercentage(career))} />
        <StatTile label="Average" value={fmtAvg(threeDartAverage(career))} hint="3-dart" />
        <StatTile label={bands[0].label} value={career.bands[bands[0].key] ?? 0} />
        <StatTile label="High checkout" value={career.highestCheckout ?? "–"} />
        <StatTile label="Best leg" value={career.bestLegDarts ? `${career.bestLegDarts} darts` : "–"} />
      </div>

      <div className="space-y-4">
        <Card title="By season">
          {seasonRows.length === 0 ? (
            <EmptyState>No seasons yet.</EmptyState>
          ) : (
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full text-right text-sm tabular-nums">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-border">
                    <th className="px-1.5 py-2 text-left font-medium">Season</th>
                    <th className="px-1.5 py-2 font-medium">P</th>
                    <th className="px-1.5 py-2 font-medium">W</th>
                    <th className="px-1.5 py-2 font-medium">Avg</th>
                    {bands.map((b) => (
                      <th key={b.key} className="px-1.5 py-2 font-medium">
                        {b.label}
                      </th>
                    ))}
                    <th className="px-1.5 py-2 font-medium">HC</th>
                    <th className="px-1.5 py-2 font-medium">Best</th>
                  </tr>
                </thead>
                <tbody>
                  {seasonRows.map((r) => (
                    <tr key={r.key} className="border-b border-border last:border-0">
                      <td className="px-1.5 py-2 text-left">
                        <div className="font-medium">
                          {r.season}
                          {r.kind && <span className="ml-1 text-xs font-normal text-muted">{r.kind}</span>}
                        </div>
                        <div className="text-xs text-muted">{r.teams}</div>
                      </td>
                      <td className="px-1.5 py-2">{r.totals.gamesPlayed}</td>
                      <td className="px-1.5 py-2">{r.totals.wins}</td>
                      <td className="px-1.5 py-2">{fmtAvg(threeDartAverage(r.totals))}</td>
                      {bands.map((b) => (
                        <td key={b.key} className="px-1.5 py-2">
                          {r.totals.bands[b.key] ?? 0}
                        </td>
                      ))}
                      <td className="px-1.5 py-2">{r.totals.highestCheckout ?? "–"}</td>
                      <td className="px-1.5 py-2">{r.totals.bestLegDarts ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Games">
          {games.length === 0 ? (
            <EmptyState>No games played yet.</EmptyState>
          ) : (
            <ul className="-mx-1 divide-y divide-border">
              {games.slice(0, 100).map((g) => (
                <li key={g.gameId}>
                  <GameRow g={g} base={base} tz={league.timezone} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Page>
  );
}

function GameRow({ g, base, tz }: { g: GameLogRow; base: string; tz: string }) {
  const avg = threeDartAverage(g.totals);
  const tone = g.result === "WIN" ? "accent" : g.result === "LOSS" ? "danger" : "neutral";
  const people = (list: { id: string; name: string }[]) =>
    list.map((p, i) => (
      <span key={p.id}>
        {i > 0 && " & "}
        <Link href={`${base}/players/${p.id}`} className="hover:underline">
          {p.name}
        </Link>
      </span>
    ));
  return (
    <div className="flex items-start justify-between gap-3 px-1 py-2.5">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {g.partners.length > 0 && <>with {people(g.partners)} </>}
          v {g.opponents.length ? people(g.opponents) : <span className="text-muted">no opponent</span>}
        </div>
        <div className="truncate text-xs text-muted">
          <Link href={`/fixtures/${g.fixtureId}`} className="hover:underline">
            {formatDate(g.scheduledAt, tz)} · {g.team.name} v {g.opponentTeam?.name ?? "bye"}
          </Link>
          {" · "}
          {g.competitionName}
          {g.gameKind === "PAIRS" && " · Pairs"}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="flex items-center justify-end gap-1.5">
          {g.isWalkover ? <Badge>Walkover</Badge> : <span className="text-sm tabular-nums">{g.legsFor}–{g.legsAgainst}</span>}
          {g.result && <Badge tone={tone}>{g.result === "WIN" ? "W" : g.result === "LOSS" ? "L" : "D"}</Badge>}
        </div>
        {!g.isWalkover && <div className="text-xs tabular-nums text-muted">avg {fmtAvg(avg)}</div>}
      </div>
    </div>
  );
}
