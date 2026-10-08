import { and, count, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { invitations, leagueMemberships, leagues, teamMemberships, teams, users } from "@/db/schema";
import { assertCan, ForbiddenError, type Actor } from "@/domain/permissions";
import { newToken, sha256 } from "./auth-service";
import { audit } from "./context";
import { AppError, notFound } from "./errors";

/**
 * Admin access is granted by invitation links. The inviter copies the link
 * (e.g. into WhatsApp); whoever opens it signs in or creates an account and
 * receives the role. Links expire, work once, and can be revoked.
 */

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type InviteRole = "LEAGUE_ADMIN" | "TEAM_ADMIN";

export interface CreateInvitationInput {
  leagueId: string;
  role: InviteRole;
  teamId?: string;
  note?: string;
}

export async function createInvitation(db: Db, actor: Actor, input: CreateInvitationInput, now = new Date()) {
  return db.transaction(async (tx) => {
    if (input.role === "LEAGUE_ADMIN") {
      assertCan(actor, { action: "league.configure", leagueId: input.leagueId });
    } else {
      if (!input.teamId) throw new AppError("TEAM_REQUIRED", "choose the team", 422);
      const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId));
      if (!team || team.leagueId !== input.leagueId) throw notFound("team");
      // League admins, and a team's own admins (to add a co-admin), may invite team admins.
      assertCan(actor, { action: "team.manage", leagueId: input.leagueId, teamId: team.id });
    }
    const token = newToken();
    const [invitation] = await tx
      .insert(invitations)
      .values({
        leagueId: input.leagueId,
        role: input.role,
        teamId: input.role === "TEAM_ADMIN" ? input.teamId! : null,
        note: input.note?.trim() || null,
        tokenHash: sha256(token),
        invitedBy: actor.userId,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        createdAt: now,
      })
      .returning();
    await audit(tx, {
      leagueId: input.leagueId,
      actor,
      action: "invitation.created",
      entityType: "invitation",
      entityId: invitation.id,
      after: { role: input.role, teamId: invitation.teamId, note: invitation.note },
    });
    return { invitation, token };
  });
}

export type InvitationState = "VALID" | "EXPIRED" | "USED" | "REVOKED";

export interface InvitationView {
  id: string;
  role: InviteRole;
  leagueId: string;
  leagueName: string;
  teamName: string | null;
  invitedByName: string;
  state: InvitationState;
}

/** What an invitation link is for, without accepting it. */
export async function lookupInvitation(db: Db, token: string, now = new Date()): Promise<InvitationView | null> {
  const rows = await db
    .select({ inv: invitations, leagueName: leagues.name, teamName: teams.name, invitedByName: users.name })
    .from(invitations)
    .innerJoin(leagues, eq(leagues.id, invitations.leagueId))
    .innerJoin(users, eq(users.id, invitations.invitedBy))
    .leftJoin(teams, eq(teams.id, invitations.teamId))
    .where(eq(invitations.tokenHash, sha256(token)));
  const row = rows[0];
  if (!row) return null;
  const { inv } = row;
  const state: InvitationState = inv.revokedAt
    ? "REVOKED"
    : inv.acceptedAt
      ? "USED"
      : inv.expiresAt.getTime() <= now.getTime()
        ? "EXPIRED"
        : "VALID";
  return {
    id: inv.id,
    role: inv.role,
    leagueId: inv.leagueId,
    leagueName: row.leagueName,
    teamName: row.teamName,
    invitedByName: row.invitedByName,
    state,
  };
}

export async function acceptInvitation(db: Db, userId: string, token: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, sha256(token))).for("update");
    if (!inv) throw notFound("invitation");
    if (inv.revokedAt) throw new AppError("INVITATION_REVOKED", "this invitation has been withdrawn", 410);
    if (inv.acceptedAt) throw new AppError("INVITATION_USED", "this invitation has already been used", 410);
    if (inv.expiresAt.getTime() <= now.getTime()) throw new AppError("INVITATION_EXPIRED", "this invitation has expired; ask for a new link", 410);

    if (inv.role === "LEAGUE_ADMIN") {
      await tx
        .insert(leagueMemberships)
        .values({ leagueId: inv.leagueId, userId, role: "LEAGUE_ADMIN", createdAt: now })
        .onConflictDoNothing();
    } else {
      await tx
        .insert(teamMemberships)
        .values({ teamId: inv.teamId!, userId, role: "TEAM_ADMIN", createdAt: now })
        .onConflictDoNothing();
    }
    await tx.update(invitations).set({ acceptedAt: now, acceptedBy: userId }).where(eq(invitations.id, inv.id));
    await audit(tx, {
      leagueId: inv.leagueId,
      actor: { userId, isPlatformAdmin: false, leagueAdminOf: new Set(), teamAdminOf: new Set() },
      action: "membership.granted",
      entityType: inv.role === "LEAGUE_ADMIN" ? "league" : "team",
      entityId: inv.role === "LEAGUE_ADMIN" ? inv.leagueId : inv.teamId!,
      after: { userId, role: inv.role, invitationId: inv.id },
    });
    return inv;
  });
}

export async function revokeInvitation(db: Db, actor: Actor, invitationId: string, now = new Date()) {
  await db.transaction(async (tx) => {
    const [inv] = await tx.select().from(invitations).where(eq(invitations.id, invitationId));
    if (!inv) throw notFound("invitation");
    if (inv.role === "LEAGUE_ADMIN") assertCan(actor, { action: "league.configure", leagueId: inv.leagueId });
    else assertCan(actor, { action: "team.manage", leagueId: inv.leagueId, teamId: inv.teamId! });
    await tx.update(invitations).set({ revokedAt: now }).where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt)));
    await audit(tx, { leagueId: inv.leagueId, actor, action: "invitation.revoked", entityType: "invitation", entityId: inv.id });
  });
}

/** Pending (unused, unexpired, not revoked) invitations for a league. League admins see all; team admins see their team's. */
export async function pendingInvitations(db: Db, actor: Actor, leagueId: string, now = new Date()) {
  const rows = await db
    .select({ inv: invitations, teamName: teams.name })
    .from(invitations)
    .leftJoin(teams, eq(teams.id, invitations.teamId))
    .where(
      and(
        eq(invitations.leagueId, leagueId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      ),
    );
  const isLeagueAdmin = actor.isPlatformAdmin || actor.leagueAdminOf.has(leagueId);
  return rows
    .filter(({ inv }) => isLeagueAdmin || (inv.teamId && actor.teamAdminOf.has(inv.teamId)))
    .map(({ inv, teamName }) => ({ id: inv.id, role: inv.role, teamName, note: inv.note, expiresAt: inv.expiresAt }));
}

/** Remove someone's admin role. A league must always keep at least one league admin. */
export async function revokeMembership(
  db: Db,
  actor: Actor,
  input: { kind: "league"; membershipId: string } | { kind: "team"; membershipId: string },
  now = new Date(),
) {
  await db.transaction(async (tx) => {
    if (input.kind === "league") {
      const [m] = await tx.select().from(leagueMemberships).where(eq(leagueMemberships.id, input.membershipId));
      if (!m || m.revokedAt) throw notFound("admin");
      assertCan(actor, { action: "league.configure", leagueId: m.leagueId });
      const [{ n }] = await tx
        .select({ n: count() })
        .from(leagueMemberships)
        .where(and(eq(leagueMemberships.leagueId, m.leagueId), isNull(leagueMemberships.revokedAt)));
      if (n <= 1 && !actor.isPlatformAdmin) {
        throw new AppError("LAST_LEAGUE_ADMIN", "a league needs at least one league admin; invite another first", 409);
      }
      await tx.update(leagueMemberships).set({ revokedAt: now }).where(eq(leagueMemberships.id, m.id));
      await audit(tx, { leagueId: m.leagueId, actor, action: "membership.revoked", entityType: "league", entityId: m.leagueId, before: { userId: m.userId, role: m.role } });
    } else {
      const [m] = await tx.select().from(teamMemberships).where(eq(teamMemberships.id, input.membershipId));
      if (!m || m.revokedAt) throw notFound("admin");
      const [team] = await tx.select().from(teams).where(eq(teams.id, m.teamId));
      // Team admins cannot remove each other; only the league can.
      if (!actor.isPlatformAdmin && !actor.leagueAdminOf.has(team.leagueId)) throw new ForbiddenError();
      await tx.update(teamMemberships).set({ revokedAt: now }).where(eq(teamMemberships.id, m.id));
      await audit(tx, { leagueId: team.leagueId, actor, action: "membership.revoked", entityType: "team", entityId: team.id, before: { userId: m.userId, role: m.role } });
    }
  });
}
