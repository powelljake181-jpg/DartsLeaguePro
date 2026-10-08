import { and, count, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { playerRegistrations, players, seasons, teams } from "@/db/schema";
import { assertCan, type Actor } from "@/domain/permissions";
import { canRegisterPlayer, type PlayerStatus } from "@/domain/registration";
import { audit } from "./context";
import { AppError, notFound } from "./errors";

export interface RegisterPlayerInput {
  seasonId: string;
  teamId: string;
  /** Register an existing player, or create a new one. */
  player: { playerId: string } | { firstName: string; lastName: string };
}

/**
 * Register a player to a team for a season. The deadline, squad limit and
 * one-team-per-season rule are enforced here (and the last also by a unique
 * index), regardless of what the UI allowed.
 */
export async function registerPlayer(db: Db, actor: Actor, input: RegisterPlayerInput, now = new Date()) {
  return db.transaction(async (tx) => {
    const [season] = await tx.select().from(seasons).where(eq(seasons.id, input.seasonId));
    const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId));
    // A season and team from different leagues are treated as not found, never mixed.
    if (!season || !team || season.leagueId !== team.leagueId) throw notFound("team or season");
    const leagueId = team.leagueId;
    assertCan(actor, { action: "player.register", leagueId, teamId: team.id });
    const actingAs = actor.isPlatformAdmin || actor.leagueAdminOf.has(leagueId) ? "LEAGUE_ADMIN" : "TEAM_ADMIN";

    let playerId: string | null = null;
    if ("playerId" in input.player) {
      const [p] = await tx.select().from(players).where(eq(players.id, input.player.playerId));
      if (!p || p.leagueId !== leagueId) throw notFound("player");
      playerId = p.id;
    }
    const [{ already }] = playerId
      ? await tx
          .select({ already: count() })
          .from(playerRegistrations)
          .where(
            and(
              eq(playerRegistrations.playerId, playerId),
              eq(playerRegistrations.seasonId, season.id),
              eq(playerRegistrations.status, "ACTIVE"),
            ),
          )
      : [{ already: 0 }];
    const [{ squad }] = await tx
      .select({ squad: count() })
      .from(playerRegistrations)
      .where(
        and(
          eq(playerRegistrations.teamId, team.id),
          eq(playerRegistrations.seasonId, season.id),
          eq(playerRegistrations.status, "ACTIVE"),
        ),
      );

    const decision = canRegisterPlayer({
      now,
      closesAt: season.registrationClosesAt,
      actingAs,
      alreadyRegisteredThisSeason: already > 0,
      squadSize: squad,
      maxSquadSize: season.maxSquadSize,
    });
    if (!decision.ok) throw new AppError(decision.code, decision.message, 422);

    if (!playerId) {
      const p = input.player as { firstName: string; lastName: string };
      const [created] = await tx
        .insert(players)
        .values({ leagueId, firstName: p.firstName.trim(), lastName: p.lastName.trim() })
        .returning();
      playerId = created.id;
    }
    const [registration] = await tx
      .insert(playerRegistrations)
      .values({
        leagueId,
        playerId,
        teamId: team.id,
        seasonId: season.id,
        registeredAt: now,
        registeredBy: actor.userId,
        isOverride: decision.override,
      })
      .returning();

    if (decision.override) {
      await audit(tx, {
        leagueId,
        actor,
        action: "player.registration_override",
        entityType: "player_registration",
        entityId: registration.id,
        after: { playerId, teamId: team.id, seasonId: season.id, registeredAt: now },
      });
    }
    return registration;
  });
}

export async function setPlayerStatus(db: Db, actor: Actor, playerId: string, status: PlayerStatus, reason?: string) {
  await db.transaction(async (tx) => {
    const [player] = await tx.select().from(players).where(eq(players.id, playerId));
    if (!player) throw notFound("player");
    assertCan(actor, { action: "player.setStatus", leagueId: player.leagueId });
    await tx.update(players).set({ status }).where(eq(players.id, playerId));
    await audit(tx, {
      leagueId: player.leagueId,
      actor,
      action: "player.status_changed",
      entityType: "player",
      entityId: playerId,
      before: { status: player.status },
      after: { status },
      reason,
    });
  });
}
