import type { Metadata } from "next";
import { ActionForm } from "@/components/form";
import { InviteForm } from "@/components/invite-form";
import { Badge, Card, EmptyState, Page, PageHeader, formatDate } from "@/components/ui";
import { pendingInvitations } from "@/server/invitation-service";
import { leaguePeople } from "@/server/queries";
import { revokeInvitationAction, revokeMembershipAction } from "../../actions";
import { loadLeagueAdminOnly } from "../load";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage(props: PageProps<"/admin/[league]/people">) {
  const { league: slug } = await props.params;
  const { db, actor, league } = await loadLeagueAdminOnly(slug);
  const [{ leagueAdmins, teamAdmins }, pending] = await Promise.all([leaguePeople(db, league.id), pendingInvitations(db, actor, league.id)]);

  return (
    <Page>
      <PageHeader title="People" subtitle="Who can manage the league and its teams. Invite team admins from each team's page." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="League admins" description="Full control of this league.">
          <ul className="mb-4 space-y-2">
            {leagueAdmins.map(({ membership, user }) => (
              <li key={membership.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{user.name}</div>
                  <div className="truncate text-xs text-muted">{user.email}</div>
                </div>
                {user.id !== actor.userId && (
                  <ActionForm action={revokeMembershipAction} submitLabel="Remove" submitVariant="secondary" className="shrink-0">
                    <input type="hidden" name="kind" value="league" />
                    <input type="hidden" name="membershipId" value={membership.id} />
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
          <InviteForm leagueId={league.id} role="LEAGUE_ADMIN" label="Invite a league admin" />
        </Card>

        <Card title="Team admins">
          {teamAdmins.length ? (
            <ul className="space-y-2">
              {teamAdmins.map(({ membership, team, user }) => (
                <li key={membership.id} className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.name}</div>
                    <div className="truncate text-xs text-muted">{team.name}</div>
                  </div>
                  <ActionForm action={revokeMembershipAction} submitLabel="Remove" submitVariant="secondary" className="shrink-0">
                    <input type="hidden" name="kind" value="team" />
                    <input type="hidden" name="membershipId" value={membership.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>No team admins yet. Open a team and use &ldquo;Invite a team admin&rdquo;.</EmptyState>
          )}
        </Card>

        <Card title="Unused invitations" className="sm:col-span-2" description="Links are only shown once, when created. Withdraw a link if it went to the wrong person.">
          {pending.length ? (
            <ul className="divide-y divide-border">
              {pending.map((inv) => (
                <li key={inv.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone={inv.role === "LEAGUE_ADMIN" ? "accent" : "neutral"}>{inv.role === "LEAGUE_ADMIN" ? "League admin" : inv.teamName}</Badge>
                      <span className="truncate text-sm">{inv.note ?? "No note"}</span>
                    </div>
                    <div className="text-xs text-muted">Expires {formatDate(inv.expiresAt, league.timezone)}</div>
                  </div>
                  <ActionForm action={revokeInvitationAction} submitLabel="Withdraw" submitVariant="secondary" className="shrink-0">
                    <input type="hidden" name="invitationId" value={inv.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">None.</p>
          )}
        </Card>
      </div>
    </Page>
  );
}
