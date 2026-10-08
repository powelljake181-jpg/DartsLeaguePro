import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Card, LinkButton, Notice, Page, PageHeader, formatDate } from "@/components/ui";
import { ForbiddenError } from "@/domain/permissions";
import { AppError } from "@/server/errors";
import { localDateInZone } from "@/domain/dates";
import { liveSnapshot } from "@/server/live-service";
import { fixtureRearrangementState } from "@/server/rearrangement-service";
import { fixtureAdmin } from "@/server/queries";
import { loadAdminLeague } from "../../load";
import { AdminFixtureCard } from "./admin-card";
import { LineupEditor } from "./lineup-editor";
import { RearrangementCard } from "./rearrangement-card";
import { StartMatchButton } from "./start-button";

export const metadata: Metadata = { title: "Match" };

/** Match day for captains and the league: pick teams, start the match, then score. */
export default async function FixtureAdminPage(props: PageProps<"/admin/[league]/fixtures/[fixtureId]">) {
  const { league: slug, fixtureId } = await props.params;
  const { db, actor, league } = await loadAdminLeague(slug);
  const data = await fixtureAdmin(db, actor, fixtureId).catch((e) => {
    if (e instanceof ForbiddenError || (e instanceof AppError && e.status === 404)) notFound();
    throw e;
  });
  if (data.ctx.fixture.leagueId !== league.id) notFound();
  const snap = await liveSnapshot(db, fixtureId);
  const { fixture } = data.ctx;
  const scheduled = fixture.status === "SCHEDULED";
  const bothConfirmed = data.confirmed.HOME && data.confirmed.AWAY;
  const scorerName = data.ctx.responsibleSide === "HOME" ? snap.home.name : snap.away.name;
  const groupNames = Object.fromEntries(data.groups.map((g) => [g.key, g.name]));
  const rearrangement = await fixtureRearrangementState(db, fixtureId);
  const names = { HOME: snap.home.name, AWAY: snap.away.name };
  const mySides = (["HOME", "AWAY"] as const).filter((s) => actor.teamAdminOf.has(s === "HOME" ? data.ctx.homeTeamId : data.ctx.awayTeamId));
  const defaults = {
    date: localDateInZone(fixture.scheduledAt, league.timezone),
    time: formatDate(fixture.scheduledAt, league.timezone, { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
  const toOption = (rows: (typeof data.squads)["HOME"]) => rows.map((r) => ({ registrationId: r.registrationId, name: `${r.player.firstName} ${r.player.lastName}` }));

  return (
    <Page>
      <PageHeader
        title={`${snap.home.name} v ${snap.away.name}`}
        subtitle={`${snap.competitionName} · ${formatDate(fixture.scheduledAt, league.timezone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${snap.venue ? ` · ${snap.venue}` : ""}`}
        actions={<Badge tone={fixture.status === "LIVE" ? "live" : fixture.status === "COMPLETED" ? "accent" : "neutral"}>{fixture.status.toLowerCase().replace("_", " ")}</Badge>}
      />
      <div className="space-y-4">
        {scheduled ? (
          <Card title="Match day">
            <ol className="space-y-1 text-sm">
              <li>1. Each captain picks their players and confirms.</li>
              <li>2. {scorerName} start the match and enter the score on a phone.</li>
              <li>3. Everyone can follow along live on the match page.</li>
            </ol>
            <div className="mt-4">
              {bothConfirmed ? (
                data.canScore ? (
                  <StartMatchButton fixtureId={fixtureId} />
                ) : (
                  <Notice>Both teams are confirmed. {scorerName} will start the match and keep score.</Notice>
                )
              ) : (
                <Notice tone="warning">
                  Waiting for {[!data.confirmed.HOME && snap.home.name, !data.confirmed.AWAY && snap.away.name].filter(Boolean).join(" and ")} to confirm their team.
                </Notice>
              )}
            </div>
          </Card>
        ) : (
          <Card>
            <div className="flex flex-wrap gap-2">
              {fixture.status === "LIVE" && data.canScore && <LinkButton href={`/score/${fixtureId}`}>Open scoring</LinkButton>}
              <LinkButton variant="secondary" href={`/fixtures/${fixtureId}`}>
                Match page
              </LinkButton>
            </div>
          </Card>
        )}

        <RearrangementCard
          fixtureId={fixtureId}
          status={fixture.status}
          state={rearrangement}
          names={names}
          mySides={mySides}
          leagueAdmin={data.leagueAdmin}
          tz={league.timezone}
          defaults={defaults}
        />

        <div className="grid gap-4 md:grid-cols-2">
          {(["HOME", "AWAY"] as const).map((side) => {
            const lineup = data.lineups[side];
            const teamName = side === "HOME" ? snap.home.name : snap.away.name;
            if (!lineup) {
              return (
                <Card key={side} title={teamName} actions={data.confirmed[side] ? <Badge tone="accent">Confirmed</Badge> : <Badge tone="warning">Not confirmed</Badge>}>
                  <p className="text-sm text-muted">Their team is shown once both captains have confirmed.</p>
                </Card>
              );
            }
            return (
              <LineupEditor
                key={side}
                fixtureId={fixtureId}
                side={side}
                teamName={teamName}
                slots={data.slots}
                groupNames={groupNames}
                squad={toOption(data.squads[side])}
                initial={lineup}
                confirmed={data.confirmed[side]}
                editable={scheduled && data.canEdit[side]}
                maxSingles={data.ctx.rules.match.maxSinglesPerPlayer}
                maxPairs={data.ctx.rules.match.maxPairsPerPlayer}
              />
            );
          })}
        </div>

        {data.leagueAdmin && (
          <AdminFixtureCard
            fixtureId={fixtureId}
            status={fixture.status}
            names={names}
            defaults={defaults}
            correctionsHref={fixture.status === "LIVE" || fixture.status === "COMPLETED" ? `/admin/${league.slug}/fixtures/${fixtureId}/corrections` : null}
            folded={!!fixture.foldEventId}
          />
        )}
      </div>
    </Page>
  );
}
