import type { Metadata } from "next";
import { Card, EmptyState, Page, PageHeader, formatDate } from "@/components/ui";
import { recentAudit } from "@/server/queries";
import { loadLeagueAdminOnly } from "../load";

export const metadata: Metadata = { title: "Activity" };

const LABELS: Record<string, string> = {
  "league.created": "Created the league",
  "league.updated": "Changed league details",
  "season.created": "Created a season",
  "season.updated": "Changed season settings",
  "division.created": "Added a division",
  "venue.created": "Added a venue",
  "team.created": "Added a team",
  "team.updated": "Changed team details",
  "team.entered": "Put a team in a division",
  "team.removed_from_competition": "Took a team out of a division",
  "competition.created": "Set up a division for the season",
  "rules.changed": "Changed rules",
  "invitation.created": "Created an invitation",
  "invitation.revoked": "Withdrew an invitation",
  "membership.granted": "Accepted an invitation",
  "membership.revoked": "Removed admin access",
  "player.registration_override": "Registered a player as an override",
  "player.status_changed": "Changed a player's status",
  "player.renamed": "Corrected a player's name",
  "player.registration_ended": "Removed a player from a squad",
  "fixture.completed": "Completed a fixture",
  "fixture.result_corrected": "Corrected a result",
  "fixture.voided": "Voided a fixture",
  "scoring.corrected": "Corrected scoring",
  "game.walkover_applied": "Applied a walkover",
  "calendar.blackout_added": "Excluded a date from fixtures",
  "calendar.blackout_removed": "Removed an excluded date",
  "calendar.constraint_added": "Added a shared-venue constraint",
  "calendar.constraint_removed": "Removed a shared-venue constraint",
  "schedule.published": "Published fixtures",
};

/** The audit log: who changed what, when and why. */
export default async function ActivityPage(props: PageProps<"/admin/[league]/activity">) {
  const { league: slug } = await props.params;
  const { db, league } = await loadLeagueAdminOnly(slug);
  const rows = await recentAudit(db, league.id, 100);

  return (
    <Page>
      <PageHeader title="Activity" subtitle="Every important change, so disputes can be settled." />
      <Card>
        {rows.length ? (
          <ol className="divide-y divide-border">
            {rows.map(({ entry, actorName }) => (
              <li key={entry.id} className="py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium">{LABELS[entry.action] ?? entry.action}</span>
                  <time className="text-xs text-muted" dateTime={entry.createdAt.toISOString()}>
                    {formatDate(entry.createdAt, league.timezone, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </time>
                </div>
                <div className="text-sm text-muted">
                  {actorName ?? "System"}
                  {entry.reason && <> · &ldquo;{entry.reason}&rdquo;</>}
                </div>
                {(entry.before !== null || entry.after !== null) && (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted">Details</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-surface-muted p-2">{JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState>Nothing has happened yet.</EmptyState>
        )}
      </Card>
    </Page>
  );
}
