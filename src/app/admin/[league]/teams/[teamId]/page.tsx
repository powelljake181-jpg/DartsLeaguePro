import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/form";
import { InviteForm } from "@/components/invite-form";
import { Badge, Card, EmptyState, Field, Input, Notice, Page, PageHeader, Select, formatDate } from "@/components/ui";
import { ForbiddenError } from "@/domain/permissions";
import { AppError } from "@/server/errors";
import { leagueSetup, teamAdmins, teamFixtures, teamSquad } from "@/server/queries";
import {
  endRegistrationAction,
  registerPlayerAction,
  renamePlayerAction,
  revokeMembershipAction,
  setPlayerStatusAction,
  updateTeamAction,
} from "../../../actions";
import { loadAdminLeague } from "../../load";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage(props: PageProps<"/admin/[league]/teams/[teamId]">) {
  const { league: slug, teamId } = await props.params;
  const { season: seasonParam } = await props.searchParams;
  const { db, actor, league, leagueAdmin } = await loadAdminLeague(slug);
  const data = await teamSquad(db, actor, teamId, typeof seasonParam === "string" ? seasonParam : null).catch((e) => {
    if (e instanceof ForbiddenError || (e instanceof AppError && e.status === 404)) notFound();
    throw e;
  });
  if (data.team.leagueId !== league.id) notFound();
  const { team, venue, season, squad, seasons } = data;
  const admins = await teamAdmins(db, team.id);
  const fixtureRows = season ? await teamFixtures(db, team.id, season.id) : [];
  const upcoming = fixtureRows.filter((r) => ["SCHEDULED", "LIVE", "POSTPONED", "REARRANGEMENT_REQUESTED"].includes(r.fixture.status)).slice(0, 5);
  const recent = fixtureRows.filter((r) => r.fixture.status === "COMPLETED").slice(-3).reverse();
  const venues = leagueAdmin ? (await leagueSetup(db, league.id)).venues : [];

  const now = new Date();
  const closesAt = season?.registrationClosesAt ?? null;
  const closed = !!closesAt && now > closesAt;
  const active = squad.filter((r) => r.registration.status === "ACTIVE");
  const full = !!season?.maxSquadSize && active.length >= season.maxSquadSize;
  const base = `/admin/${league.slug}`;

  return (
    <Page>
      <PageHeader
        title={team.name}
        subtitle={venue ? `Home venue: ${venue.name}` : undefined}
        back={leagueAdmin ? { href: `${base}/teams`, label: "Teams" } : undefined}
      />
      {seasons.length > 1 && (
        <nav className="mb-4 flex flex-wrap gap-2" aria-label="Season">
          {seasons.map((s) => (
            <Link
              key={s.id}
              href={`?season=${s.id}`}
              className={`rounded-full border px-3 py-1 text-sm ${s.id === season?.id ? "border-accent bg-accent-soft font-semibold" : "border-border text-muted"}`}
            >
              {s.name}
            </Link>
          ))}
        </nav>
      )}

      {(upcoming.length > 0 || recent.length > 0) && (
        <Card title="Fixtures" className="mb-4">
          <ul className="divide-y divide-border">
            {[...upcoming, ...recent].map(({ fixture, home, opponent }) => (
              <li key={fixture.id}>
                <Link href={`${base}/fixtures/${fixture.id}`} className="flex min-h-14 items-center justify-between gap-3 py-2 hover:bg-surface-muted">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {home ? "v" : "@"} {opponent}
                    </div>
                    <div className="text-sm text-muted">{formatDate(fixture.scheduledAt, league.timezone, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>
                  </div>
                  {fixture.status === "LIVE" ? <Badge tone="live">Live</Badge> : fixture.status === "COMPLETED" ? <Badge tone="accent">Result</Badge> : fixture.homeLineupConfirmedAt && fixture.awayLineupConfirmedAt ? <Badge>Teams in</Badge> : <Badge tone="warning">Pick team</Badge>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-[1fr_20rem]">
        <Card
          title={season ? `Squad ${season.name}` : "Squad"}
          description={season ? `${active.length} registered${season.maxSquadSize ? ` of ${season.maxSquadSize}` : ""}` : undefined}
        >
          {!season ? (
            <EmptyState>The league hasn&apos;t created a season yet.</EmptyState>
          ) : squad.length === 0 ? (
            <EmptyState>No players registered yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {squad.map(({ registration, player }) => (
                <li key={registration.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className={`font-medium ${registration.status === "ENDED" ? "text-muted line-through" : ""}`}>
                        {player.firstName} {player.lastName}
                      </div>
                      <div className="text-xs text-muted">
                        Registered {formatDate(registration.registeredAt, league.timezone)}
                        {registration.isOverride && " · league override"}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {player.status !== "ACTIVE" && <Badge tone="warning">{player.status.toLowerCase()}</Badge>}
                      {registration.status === "ENDED" && <Badge>left</Badge>}
                    </div>
                  </div>
                  {leagueAdmin && (
                    <details className="mt-2 rounded-lg bg-surface-muted px-3 py-2 text-sm">
                      <summary className="cursor-pointer text-muted">League admin options</summary>
                      <div className="mt-3 space-y-4">
                        <ActionForm action={setPlayerStatusAction} submitLabel="Update status" submitVariant="secondary">
                          <input type="hidden" name="playerId" value={player.id} />
                          <div className="grid grid-cols-2 gap-2">
                            <Field label="Status" htmlFor={`st-${player.id}`}>
                              <Select id={`st-${player.id}`} name="status" defaultValue={player.status}>
                                <option value="ACTIVE">Active</option>
                                <option value="INACTIVE">Inactive</option>
                                <option value="SUSPENDED">Suspended</option>
                              </Select>
                            </Field>
                            <Field label="Reason" htmlFor={`rs-${player.id}`}>
                              <Input id={`rs-${player.id}`} name="reason" />
                            </Field>
                          </div>
                        </ActionForm>
                        <ActionForm action={renamePlayerAction} submitLabel="Correct name" submitVariant="secondary">
                          <input type="hidden" name="playerId" value={player.id} />
                          <div className="grid grid-cols-2 gap-2">
                            <Field label="First name" htmlFor={`fn-${player.id}`}>
                              <Input id={`fn-${player.id}`} name="firstName" defaultValue={player.firstName} required />
                            </Field>
                            <Field label="Last name" htmlFor={`ln-${player.id}`}>
                              <Input id={`ln-${player.id}`} name="lastName" defaultValue={player.lastName} required />
                            </Field>
                          </div>
                        </ActionForm>
                        {registration.status === "ACTIVE" && (
                          <ActionForm action={endRegistrationAction} submitLabel="Remove from squad" submitVariant="danger">
                            <input type="hidden" name="registrationId" value={registration.id} />
                            <Field label="Reason" htmlFor={`er-${registration.id}`} hint="Their results and statistics are kept.">
                              <Input id={`er-${registration.id}`} name="reason" placeholder="Left the team" />
                            </Field>
                          </ActionForm>
                        )}
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          {season && (
            <Card
              title="Register a player"
              description={closesAt ? `Registration ${closed ? "closed" : "closes"} ${formatDate(closesAt, league.timezone, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}.` : undefined}
            >
              {(closed || full) && !leagueAdmin ? (
                <Notice tone="warning">
                  {closed
                    ? "The registration deadline has passed. Contact the league secretary to add a player."
                    : `Your squad is full (${season.maxSquadSize} players). Contact the league secretary.`}
                </Notice>
              ) : (
                <ActionForm action={registerPlayerAction} submitLabel="Register player" resetOnSuccess>
                  {(closed || full) && <Notice tone="warning">{closed ? "The deadline has passed." : "The squad is full."} As a league admin you can still register; it will be recorded as an override.</Notice>}
                  <input type="hidden" name="seasonId" value={season.id} />
                  <input type="hidden" name="teamId" value={team.id} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="First name" htmlFor="reg-first">
                      <Input id="reg-first" name="firstName" autoComplete="off" required />
                    </Field>
                    <Field label="Last name" htmlFor="reg-last">
                      <Input id="reg-last" name="lastName" autoComplete="off" required />
                    </Field>
                  </div>
                </ActionForm>
              )}
            </Card>
          )}

          <Card title="Team admins" description="They can register players, pick teams and score matches.">
            {admins.length ? (
              <ul className="mb-4 space-y-2">
                {admins.map(({ membership, user }) => (
                  <li key={membership.id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{user.name}</div>
                      <div className="truncate text-xs text-muted">{user.email}</div>
                    </div>
                    {leagueAdmin && (
                      <ActionForm action={revokeMembershipAction} submitLabel="Remove" submitVariant="secondary" className="shrink-0">
                        <input type="hidden" name="kind" value="team" />
                        <input type="hidden" name="membershipId" value={membership.id} />
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-4 text-sm text-muted">No team admins yet.</p>
            )}
            <InviteForm leagueId={league.id} role="TEAM_ADMIN" teamId={team.id} label="Invite a team admin" />
          </Card>

          {leagueAdmin && (
            <Card title="Team details">
              <ActionForm action={updateTeamAction} submitLabel="Save" submitVariant="secondary">
                <input type="hidden" name="teamId" value={team.id} />
                <Field label="Name" htmlFor="team-name" hint="Past seasons keep the name used at the time.">
                  <Input id="team-name" name="name" defaultValue={team.name} required />
                </Field>
                <Field label="Home venue" htmlFor="team-venue">
                  <Select id="team-venue" name="venueId" defaultValue={team.homeVenueId ?? ""}>
                    <option value="">Not set</option>
                    {venues.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}
