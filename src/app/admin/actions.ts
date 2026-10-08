"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { PlayerStatus } from "@/domain/registration";
import { RULE_TEMPLATES } from "@/domain/rules";
import { attempt, str, type FormState } from "@/lib/action";
import { requireActor } from "@/lib/session";
import { createInvitation, revokeInvitation, revokeMembership, type InviteRole } from "@/server/invitation-service";
import { publishFixtureChanged } from "@/server/events";
import { setLineup, startFixture } from "@/server/match-service";
import { registerPlayer, setPlayerStatus } from "@/server/registration-service";
import { applyRuleChange, previewRuleChange, type RuleChangePreview } from "@/server/rules-service";
import {
  addBlackoutDate,
  createConstraint,
  deleteConstraint,
  previewSchedule,
  publishSchedule,
  removeBlackoutDate,
  type SchedulePreview,
  type ScheduleRequest,
} from "@/server/schedule-service";
import {
  addTeamToCompetition,
  createDivision,
  createLeague,
  createLeagueCompetition,
  createSeason,
  createTeam,
  createVenue,
  endRegistration,
  removeTeamFromCompetition,
  renamePlayer,
  updateLeague,
  updateSeason,
  updateTeam,
} from "@/server/setup-service";

/**
 * Server actions for the admin area. Each re-identifies the user from the
 * session and delegates to a service, which checks permissions against data
 * loaded from the database. Ids in the form only say *what* to act on.
 */

async function ctx() {
  const { actor } = await requireActor();
  return { actor, db: await getDb() };
}

function done(message: string, value?: string): FormState {
  revalidatePath("/admin", "layout");
  return { ok: true, message, value };
}

async function siteUrl() {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

// --- leagues ---------------------------------------------------------------

export async function createLeagueAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() =>
    createLeague(db, actor, { name: str(fd, "name"), slug: str(fd, "slug"), timezone: str(fd, "timezone") || "Europe/London", firstAdminUserId: actor.userId }),
  );
  if (!r.ok) return { error: r.error };
  revalidatePath("/admin", "layout");
  redirect(`/admin/${r.value.slug}`);
}

export async function updateLeagueAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => updateLeague(db, actor, str(fd, "leagueId"), { name: str(fd, "name"), timezone: str(fd, "timezone") }));
  return r.ok ? done("League details saved.") : { error: r.error };
}

// --- seasons ---------------------------------------------------------------

const seasonFields = (fd: FormData) => ({
  name: str(fd, "name"),
  startsOn: str(fd, "startsOn"),
  endsOn: str(fd, "endsOn"),
  registrationDeadline: str(fd, "registrationDeadline"),
  maxSquadSize: str(fd, "maxSquadSize"),
});

export async function createSeasonAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => createSeason(db, actor, str(fd, "leagueId"), seasonFields(fd)));
  if (!r.ok) return { error: r.error };
  revalidatePath("/admin", "layout");
  redirect(`/admin/${str(fd, "leagueSlug")}/seasons/${r.value.id}`);
}

export async function updateSeasonAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const status = str(fd, "status") as "DRAFT" | "ACTIVE" | "COMPLETED" | "ARCHIVED";
  const r = await attempt(() => updateSeason(db, actor, str(fd, "seasonId"), { ...seasonFields(fd), status: status || undefined }));
  return r.ok ? done("Season saved.") : { error: r.error };
}

// --- structure -------------------------------------------------------------

export async function createDivisionAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => createDivision(db, actor, str(fd, "leagueId"), { name: str(fd, "name") }));
  return r.ok ? done(`${r.value.name} added.`) : { error: r.error };
}

export async function createVenueAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => createVenue(db, actor, str(fd, "leagueId"), { name: str(fd, "name"), address: str(fd, "address") }));
  return r.ok ? done(`${r.value.name} added.`) : { error: r.error };
}

export async function createTeamAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => createTeam(db, actor, str(fd, "leagueId"), { name: str(fd, "name"), venueId: str(fd, "venueId") }));
  return r.ok ? done(`${r.value.name} added.`) : { error: r.error };
}

export async function updateTeamAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => updateTeam(db, actor, str(fd, "teamId"), { name: str(fd, "name"), venueId: str(fd, "venueId") }));
  return r.ok ? done("Team saved.") : { error: r.error };
}

// --- competitions ----------------------------------------------------------

export async function createCompetitionAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const template = RULE_TEMPLATES.find((t) => t.key === str(fd, "template"));
  if (!template) return { error: "Choose a match format." };
  const weekday = str(fd, "matchWeekday");
  const r = await attempt(() =>
    createLeagueCompetition(db, actor, {
      seasonId: str(fd, "seasonId"),
      divisionId: str(fd, "divisionId"),
      rules: template.rules,
      matchWeekday: weekday === "" ? null : Number(weekday),
    }),
  );
  return r.ok ? done("Division set up for this season. You can fine-tune its rules any time.") : { error: r.error };
}

export async function addTeamToCompetitionAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => addTeamToCompetition(db, actor, { competitionId: str(fd, "competitionId"), teamId: str(fd, "teamId") }));
  return r.ok ? done(`${r.value.displayName} added.`) : { error: r.error };
}

export async function removeTeamFromCompetitionAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => removeTeamFromCompetition(db, actor, str(fd, "entryId")));
  return r.ok ? done("Team removed.") : { error: r.error };
}

// --- rules -----------------------------------------------------------------

export type RuleChangeResult = { ok: true; preview: RuleChangePreview; applied: boolean } | { ok: false; error: string };

/** Preview (apply = false) or apply a dated rule change. The rules arrive as JSON from the editor and are validated by the service. */
export async function ruleChangeAction(input: { competitionId: string; rules: unknown; effectiveFrom: string; reason: string; apply: boolean }): Promise<RuleChangeResult> {
  const { actor, db } = await ctx();
  const change = { competitionId: input.competitionId, rules: input.rules, effectiveFrom: input.effectiveFrom, reason: input.reason };
  const r = await attempt(() => (input.apply ? applyRuleChange(db, actor, change) : previewRuleChange(db, actor, change)));
  if (!r.ok) return { ok: false, error: r.error };
  if (input.apply) revalidatePath("/admin", "layout");
  return { ok: true, preview: r.value, applied: input.apply };
}

// --- calendar & fixtures -----------------------------------------------------

export async function addBlackoutAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() =>
    addBlackoutDate(db, actor, {
      seasonId: str(fd, "seasonId"),
      date: str(fd, "date"),
      kind: str(fd, "kind") as "CUP" | "BREAK" | "OTHER",
      reason: str(fd, "reason"),
      competitionId: str(fd, "competitionId") || undefined,
    }),
  );
  return r.ok ? done("Date added.") : { error: r.error };
}

export async function removeBlackoutAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => removeBlackoutDate(db, actor, str(fd, "blackoutId")));
  return r.ok ? done("Date removed.") : { error: r.error };
}

export async function createConstraintAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() =>
    createConstraint(db, actor, {
      seasonId: str(fd, "seasonId"),
      name: str(fd, "name"),
      teamIds: fd.getAll("teamIds").filter((v): v is string => typeof v === "string"),
      maxHome: Number(str(fd, "maxHome") || 1),
      venueId: str(fd, "venueId") || undefined,
    }),
  );
  return r.ok ? done("Constraint added.") : { error: r.error };
}

export async function deleteConstraintAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => deleteConstraint(db, actor, str(fd, "constraintId")));
  return r.ok ? done("Constraint removed.") : { error: r.error };
}

export type ScheduleActionResult =
  | { ok: true; preview: SchedulePreview }
  | { ok: true; published: { fixtures: number; replaced: number } }
  | { ok: false; error: string };

/** Preview a schedule, or publish it with the same inputs and seed. */
export async function scheduleAction(
  input: ScheduleRequest & { publish: boolean; replaceExisting: boolean; acknowledgeConflicts: boolean },
): Promise<ScheduleActionResult> {
  const { actor, db } = await ctx();
  if (!input.publish) {
    const r = await attempt(() => previewSchedule(db, actor, input));
    return r.ok ? { ok: true, preview: r.value } : { ok: false, error: r.error };
  }
  const r = await attempt(() => publishSchedule(db, actor, input));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath("/admin", "layout");
  return { ok: true, published: { fixtures: r.value.fixtures, replaced: r.value.replaced } };
}

// --- match day ---------------------------------------------------------------

export type SimpleResult = { ok: true } | { ok: false; error: string };

/** Save (and optionally confirm) one side's lineup. Eligibility is checked by the service. */
export async function saveLineupAction(input: { fixtureId: string; side: "HOME" | "AWAY"; slots: { gameOrdinal: number; registrationIds: string[] }[]; confirm: boolean }): Promise<SimpleResult> {
  const { actor, db } = await ctx();
  const r = await attempt(() => setLineup(db, actor, input));
  if (!r.ok) return r;
  publishFixtureChanged(input.fixtureId);
  revalidatePath("/admin", "layout");
  return { ok: true };
}

export async function startMatchAction(fixtureId: string): Promise<SimpleResult> {
  const { actor, db } = await ctx();
  const r = await attempt(() => startFixture(db, actor, fixtureId));
  if (!r.ok) return r;
  publishFixtureChanged(fixtureId);
  revalidatePath("/admin", "layout");
  return { ok: true };
}

// --- players ---------------------------------------------------------------

export async function registerPlayerAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() =>
    registerPlayer(db, actor, {
      seasonId: str(fd, "seasonId"),
      teamId: str(fd, "teamId"),
      player: { firstName: str(fd, "firstName"), lastName: str(fd, "lastName") },
    }),
  );
  if (!r.ok) return { error: r.error };
  return done(r.value.isOverride ? "Player registered (league override recorded)." : "Player registered.");
}

export async function setPlayerStatusAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => setPlayerStatus(db, actor, str(fd, "playerId"), str(fd, "status") as PlayerStatus, str(fd, "reason") || undefined));
  return r.ok ? done("Player status updated.") : { error: r.error };
}

export async function renamePlayerAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => renamePlayer(db, actor, str(fd, "playerId"), { firstName: str(fd, "firstName"), lastName: str(fd, "lastName") }));
  return r.ok ? done("Name corrected.") : { error: r.error };
}

export async function endRegistrationAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => endRegistration(db, actor, str(fd, "registrationId"), str(fd, "reason")));
  return r.ok ? done("Player removed from the squad. Their past results and statistics are kept.") : { error: r.error };
}

// --- people ----------------------------------------------------------------

export async function createInvitationAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const role = str(fd, "role") as InviteRole;
  const r = await attempt(() =>
    createInvitation(db, actor, { leagueId: str(fd, "leagueId"), role, teamId: str(fd, "teamId") || undefined, note: str(fd, "note") }),
  );
  if (!r.ok) return { error: r.error };
  return done("Invitation created. Send this link to them — it works once and expires in 14 days.", `${await siteUrl()}/invite/${r.value.token}`);
}

export async function revokeInvitationAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => revokeInvitation(db, actor, str(fd, "invitationId")));
  return r.ok ? done("Invitation withdrawn.") : { error: r.error };
}

export async function revokeMembershipAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const kind = str(fd, "kind") === "league" ? "league" : "team";
  const r = await attempt(() => revokeMembership(db, actor, { kind, membershipId: str(fd, "membershipId") }));
  return r.ok ? done("Admin access removed.") : { error: r.error };
}
