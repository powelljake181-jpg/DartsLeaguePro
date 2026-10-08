import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, EmptyState, Notice, Page, PageHeader } from "@/components/ui";
import { ForbiddenError } from "@/domain/permissions";
import { AppError } from "@/server/errors";
import { fixtureInfo } from "@/server/fixture-ops";
import { fixtureCorrections } from "@/server/queries";
import { loadAdminLeague } from "../../../load";
import { LegEditor } from "./leg-editor";

export const metadata: Metadata = { title: "Correct scores" };

/** League admins correct mis-entered visits, leg by leg. The result, table and statistics follow automatically. */
export default async function CorrectionsPage(props: PageProps<"/admin/[league]/fixtures/[fixtureId]/corrections">) {
  const { league: slug, fixtureId } = await props.params;
  const { db, actor, league } = await loadAdminLeague(slug);
  const data = await fixtureCorrections(db, actor, fixtureId).catch((e) => {
    if (e instanceof ForbiddenError || (e instanceof AppError && e.status === 404)) notFound();
    throw e;
  });
  if (data.ctx.fixture.leagueId !== league.id) notFound();
  const info = await fixtureInfo(db, data.ctx);
  const names = { HOME: info.home, AWAY: info.away };

  return (
    <Page>
      <PageHeader title="Correct scores" subtitle={`${info.home} v ${info.away}`} back={{ href: `/admin/${league.slug}/fixtures/${fixtureId}`, label: "Match" }} />
      <div className="space-y-4">
        <Notice>
          Fix the visits of a leg as they should have been entered. The old entries are kept in the audit log. Leave darts as &ldquo;–&rdquo; except for a checkout or a bust.
          {data.ctx.fixture.status === "COMPLETED" && " Each corrected leg must still finish with a checkout."}
        </Notice>
        {data.games.length === 0 ? (
          <EmptyState>No games have been played yet.</EmptyState>
        ) : (
          data.games.map((g) => (
            <Card
              key={g.game.id}
              title={`Game ${g.game.ordinal}${g.game.kind === "PAIRS" ? " · Pairs" : ""}`}
              description={`${g.players.filter((p) => p.side === "HOME").map((p) => p.name).join(" & ")} ${g.game.homeLegs}–${g.game.awayLegs} ${g.players.filter((p) => p.side === "AWAY").map((p) => p.name).join(" & ")}`}
            >
              <div className="space-y-2">
                {g.legs.map((l) => (
                  <details key={l.leg.id} className="rounded-lg border border-border p-3">
                    <summary className="cursor-pointer font-medium">
                      Leg {l.leg.ordinal} · {l.visits.length} visits{l.leg.winner && ` · won by ${names[l.leg.winner]}`}
                    </summary>
                    <div className="mt-3">
                      <LegEditor fixtureId={fixtureId} gameOrdinal={g.game.ordinal} legOrdinal={l.leg.ordinal} players={g.players} initial={l.visits} names={names} />
                    </div>
                  </details>
                ))}
              </div>
            </Card>
          ))
        )}
      </div>
    </Page>
  );
}
