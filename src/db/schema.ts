import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { LeagueRules } from "@/domain/rules";

/**
 * Database schema. See docs/ARCHITECTURE.md §2.
 * Conventions: rows referenced by history are never hard-deleted (status /
 * archived_at instead); every tenant-owned table carries league_id so access
 * can be scoped without trusting client input.
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const tsz = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const sideEnum = pgEnum("side", ["HOME", "AWAY"]);
export const resultEnum = pgEnum("result", ["HOME", "AWAY", "DRAW"]);
export const leagueRoleEnum = pgEnum("league_role", ["LEAGUE_ADMIN"]);
export const teamRoleEnum = pgEnum("team_role", ["TEAM_ADMIN"]);
export const seasonStatusEnum = pgEnum("season_status", ["DRAFT", "ACTIVE", "COMPLETED", "ARCHIVED"]);
export const competitionKindEnum = pgEnum("competition_kind", ["LEAGUE", "CUP"]);
export const entryStatusEnum = pgEnum("entry_status", ["ACTIVE", "FOLDED", "WITHDRAWN"]);
export const playerStatusEnum = pgEnum("player_status", ["ACTIVE", "INACTIVE", "SUSPENDED"]);
export const registrationStatusEnum = pgEnum("registration_status", ["ACTIVE", "ENDED"]);
export const blackoutKindEnum = pgEnum("blackout_kind", ["CUP", "BREAK", "OTHER"]);
export const fixtureStatusEnum = pgEnum("fixture_status", [
  "SCHEDULED",
  "REARRANGEMENT_REQUESTED",
  "POSTPONED",
  "LIVE",
  "COMPLETED",
  "CANCELLED",
  "VOID",
]);
export const outcomeSourceEnum = pgEnum("outcome_source", ["PLAYED", "AWARDED", "ADMIN"]);
export const gameKindEnum = pgEnum("game_kind", ["SINGLES", "PAIRS"]);
export const gameStatusEnum = pgEnum("game_status", ["PENDING", "LIVE", "COMPLETED", "WALKOVER", "NOT_REQUIRED", "VOID"]);
export const rearrangementStatusEnum = pgEnum("rearrangement_status", [
  "PENDING",
  "ACCEPTED",
  "REJECTED",
  "WITHDRAWN",
  "OVERRIDDEN",
  "EXPIRED",
]);
export const foldResultsEnum = pgEnum("fold_results", ["VOID_ALL", "MAX_LOSS_REMAINING", "MAX_LOSS_ALL"]);
export const foldStatsEnum = pgEnum("fold_stats", ["KEEP", "EXCLUDE"]);

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  // Text id so an auth library's id format can be adopted without a migration.
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
  /** scrypt hash ("scrypt$N$r$p$salt$hash"); null until the user sets a password. */
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
});

/** Login sessions. The cookie holds a random token; only its SHA-256 hash is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    expiresAt: tsz("expires_at").notNull(),
    createdAt: createdAt(),
    lastSeenAt: tsz("last_seen_at").notNull().defaultNow(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Failed sign-in attempts, used to slow down password guessing. */
export const authFailures = pgTable(
  "auth_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    email: text("email").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("auth_failures_email_idx").on(t.email, t.createdAt)],
);

export const leagues = pgTable("leagues", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Europe/London"),
  createdAt: createdAt(),
  archivedAt: tsz("archived_at"),
});

export const leagueMemberships = pgTable(
  "league_memberships",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: leagueRoleEnum("role").notNull(),
    createdAt: createdAt(),
    revokedAt: tsz("revoked_at"),
  },
  (t) => [
    uniqueIndex("league_memberships_active_uq")
      .on(t.leagueId, t.userId, t.role)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export const rulesets = pgTable(
  "rulesets",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    /** Validated against `rulesSchema` (src/domain/rules.ts) on every read and write. */
    config: jsonb("config").$type<LeagueRules>().notNull(),
    createdAt: createdAt(),
    createdBy: text("created_by").references(() => users.id),
  },
  (t) => [uniqueIndex("rulesets_name_version_uq").on(t.leagueId, t.name, t.version)],
);

export const seasons = pgTable(
  "seasons",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    name: text("name").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
    status: seasonStatusEnum("status").notNull().default("DRAFT"),
    /** End of the last day new players may be registered by team admins (league timezone). */
    registrationClosesAt: tsz("registration_closes_at"),
    maxSquadSize: integer("max_squad_size"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("seasons_name_uq").on(t.leagueId, t.name)],
);

export const divisions = pgTable(
  "divisions",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    name: text("name").notNull(),
    /** 1 = top division. */
    rank: integer("rank").notNull(),
    archivedAt: tsz("archived_at"),
  },
  (t) => [uniqueIndex("divisions_name_uq").on(t.leagueId, t.name)],
);

export const venues = pgTable("venues", {
  id: id(),
  leagueId: uuid("league_id").notNull().references(() => leagues.id),
  name: text("name").notNull(),
  address: text("address"),
  archivedAt: tsz("archived_at"),
});

export const teams = pgTable(
  "teams",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    homeVenueId: uuid("home_venue_id").references(() => venues.id),
    createdAt: createdAt(),
    archivedAt: tsz("archived_at"),
  },
  (t) => [uniqueIndex("teams_slug_uq").on(t.leagueId, t.slug)],
);

/**
 * An invitation to become a league or team admin. Shared as a link (the token
 * is shown once; only its hash is stored). Whoever opens the link and signs in
 * or creates an account receives the role.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    role: text("role").$type<"LEAGUE_ADMIN" | "TEAM_ADMIN">().notNull(),
    teamId: uuid("team_id").references(() => teams.id),
    /** Who it is meant for, shown to the inviter; not enforced. */
    note: text("note"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").notNull().references(() => users.id),
    expiresAt: tsz("expires_at").notNull(),
    acceptedAt: tsz("accepted_at"),
    acceptedBy: text("accepted_by").references(() => users.id),
    revokedAt: tsz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("invitations_token_uq").on(t.tokenHash),
    check("invitations_team_role", sql`(${t.role} = 'TEAM_ADMIN') = (${t.teamId} is not null)`),
  ],
);

export const teamMemberships = pgTable(
  "team_memberships",
  {
    id: id(),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: teamRoleEnum("role").notNull(),
    createdAt: createdAt(),
    revokedAt: tsz("revoked_at"),
  },
  (t) => [
    uniqueIndex("team_memberships_active_uq")
      .on(t.teamId, t.userId, t.role)
      .where(sql`${t.revokedAt} is null`),
  ],
);

// ---------------------------------------------------------------------------
// Competitions & entries
// ---------------------------------------------------------------------------

export const competitions = pgTable(
  "competitions",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    seasonId: uuid("season_id").notNull().references(() => seasons.id),
    kind: competitionKindEnum("kind").notNull(),
    /** Set for LEAGUE competitions (one per division per season). */
    divisionId: uuid("division_id").references(() => divisions.id),
    name: text("name").notNull(),
    /** 0 = Sunday … 6 = Saturday. */
    matchWeekday: integer("match_weekday"),
    createdAt: createdAt(),
  },
  (t) => [
    check("competitions_league_has_division", sql`${t.kind} <> 'LEAGUE' or ${t.divisionId} is not null`),
    check("competitions_weekday", sql`${t.matchWeekday} is null or ${t.matchWeekday} between 0 and 6`),
    uniqueIndex("competitions_division_season_uq")
      .on(t.seasonId, t.divisionId)
      .where(sql`${t.kind} = 'LEAGUE'`),
  ],
);

/**
 * The competition's rules timeline. A fixture is governed by the period in
 * force on its (league-local) date. Changing rules adds a period with an
 * explicit effective date, possibly in the past; rulesets themselves are
 * immutable versions.
 */
export const competitionRulePeriods = pgTable(
  "competition_rule_periods",
  {
    id: id(),
    competitionId: uuid("competition_id").notNull().references(() => competitions.id),
    rulesetId: uuid("ruleset_id").notNull().references(() => rulesets.id),
    effectiveFrom: date("effective_from").notNull(),
    reason: text("reason"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("competition_rule_periods_uq").on(t.competitionId, t.effectiveFrom)],
);

export const teamEntries = pgTable(
  "team_entries",
  {
    id: id(),
    competitionId: uuid("competition_id").notNull().references(() => competitions.id),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    /** Team name as it was this season (teams can be renamed later). */
    displayName: text("display_name").notNull(),
    venueId: uuid("venue_id").references(() => venues.id),
    status: entryStatusEnum("status").notNull().default("ACTIVE"),
    seed: integer("seed"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("team_entries_uq").on(t.competitionId, t.teamId)],
);

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export const players = pgTable(
  "players",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    status: playerStatusEnum("status").notNull().default("ACTIVE"),
    createdAt: createdAt(),
    /** GDPR erasure: names replaced, row and statistics kept. */
    anonymisedAt: tsz("anonymised_at"),
  },
  (t) => [index("players_league_idx").on(t.leagueId)],
);

export const playerRegistrations = pgTable(
  "player_registrations",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    playerId: uuid("player_id").notNull().references(() => players.id),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    seasonId: uuid("season_id").notNull().references(() => seasons.id),
    status: registrationStatusEnum("status").notNull().default("ACTIVE"),
    registeredAt: tsz("registered_at").notNull().defaultNow(),
    registeredBy: text("registered_by").references(() => users.id),
    /** Registered by a league admin past the deadline / squad limit. */
    isOverride: boolean("is_override").notNull().default(false),
    endedAt: tsz("ended_at"),
    endedReason: text("ended_reason"),
  },
  (t) => [
    // One active registration per player per season, enforced by the database.
    uniqueIndex("player_registrations_one_active_uq")
      .on(t.playerId, t.seasonId)
      .where(sql`${t.status} = 'ACTIVE'`),
    index("player_registrations_team_season_idx").on(t.teamId, t.seasonId),
  ],
);

// ---------------------------------------------------------------------------
// Calendar & scheduling constraints
// ---------------------------------------------------------------------------

export const blackoutDates = pgTable(
  "blackout_dates",
  {
    id: id(),
    seasonId: uuid("season_id").notNull().references(() => seasons.id),
    /** null = applies to every competition in the season. */
    competitionId: uuid("competition_id").references(() => competitions.id),
    date: date("date").notNull(),
    kind: blackoutKindEnum("kind").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [index("blackout_dates_season_idx").on(t.seasonId, t.date)],
);

export const schedulingConstraints = pgTable(
  "scheduling_constraints",
  {
    id: id(),
    seasonId: uuid("season_id").notNull().references(() => seasons.id),
    name: text("name").notNull(),
    venueId: uuid("venue_id").references(() => venues.id),
    maxHomePerDate: integer("max_home_per_date").notNull().default(1),
  },
  (t) => [check("scheduling_constraints_max", sql`${t.maxHomePerDate} >= 1`)],
);

export const schedulingConstraintTeams = pgTable(
  "scheduling_constraint_teams",
  {
    constraintId: uuid("constraint_id").notNull().references(() => schedulingConstraints.id),
    teamId: uuid("team_id").notNull().references(() => teams.id),
  },
  (t) => [primaryKey({ columns: [t.constraintId, t.teamId] })],
);

export const cupRounds = pgTable(
  "cup_rounds",
  {
    id: id(),
    competitionId: uuid("competition_id").notNull().references(() => competitions.id),
    ordinal: integer("ordinal").notNull(),
    name: text("name").notNull(),
    scheduledOn: date("scheduled_on"),
    /** Local start time (HH:MM, league timezone) for this round's ties. */
    kickOff: text("kick_off").notNull().default("19:30"),
  },
  (t) => [uniqueIndex("cup_rounds_uq").on(t.competitionId, t.ordinal)],
);

// ---------------------------------------------------------------------------
// Fixtures, games, legs, visits
// ---------------------------------------------------------------------------

export const foldEvents = pgTable("fold_events", {
  id: id(),
  teamEntryId: uuid("team_entry_id").notNull().references(() => teamEntries.id),
  foldedAt: tsz("folded_at").notNull().defaultNow(),
  resultsTreatment: foldResultsEnum("results_treatment").notNull(),
  playerStatsTreatment: foldStatsEnum("player_stats_treatment").notNull(),
  /** Fixture states before the fold, so it can be reversed exactly. */
  previousState: jsonb("previous_state").notNull(),
  createdBy: text("created_by").references(() => users.id),
  revertedAt: tsz("reverted_at"),
});

export const fixtures = pgTable(
  "fixtures",
  {
    id: id(),
    leagueId: uuid("league_id").notNull().references(() => leagues.id),
    competitionId: uuid("competition_id").notNull().references(() => competitions.id),
    roundNumber: integer("round_number"),
    cupRoundId: uuid("cup_round_id").references(() => cupRounds.id),
    /** Cups: the tie's place in its round (0-based); round r tie i is fed by round r-1 ties 2i and 2i+1. */
    bracketSlot: integer("bracket_slot"),
    homeEntryId: uuid("home_entry_id").notNull().references(() => teamEntries.id),
    /** null = bye (cups). */
    awayEntryId: uuid("away_entry_id").references(() => teamEntries.id),
    scheduledAt: tsz("scheduled_at").notNull(),
    venueId: uuid("venue_id").references(() => venues.id),
    status: fixtureStatusEnum("status").notNull().default("SCHEDULED"),
    /** Incremented on every change; used for optimistic locking and realtime resync. */
    version: integer("version").notNull().default(0),
    /** Per-fixture override of the ruleset's responsible scoring side (e.g. delegated scoring). */
    responsibleSide: sideEnum("responsible_side"),
    homeLineupConfirmedAt: tsz("home_lineup_confirmed_at"),
    awayLineupConfirmedAt: tsz("away_lineup_confirmed_at"),
    startedAt: tsz("started_at"),
    completedAt: tsz("completed_at"),
    voidReason: text("void_reason"),
    /** A voided fixture's player statistics still count (e.g. fold with stats kept). */
    keepStatsWhenVoid: boolean("keep_stats_when_void").notNull().default(false),
    /**
     * Player statistics from this fixture are left out even though it stands as
     * completed, e.g. a played match whose result was replaced by an award when
     * a team folded and the league chose not to keep the darts thrown.
     */
    statsExcluded: boolean("stats_excluded").notNull().default(false),
    foldEventId: uuid("fold_event_id").references(() => foldEvents.id),
    createdAt: createdAt(),
    updatedAt: tsz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("fixtures_distinct_teams", sql`${t.homeEntryId} <> ${t.awayEntryId}`),
    index("fixtures_competition_idx").on(t.competitionId, t.scheduledAt),
    index("fixtures_league_date_idx").on(t.leagueId, t.scheduledAt),
    uniqueIndex("fixtures_cup_slot_uq").on(t.cupRoundId, t.bracketSlot).where(sql`${t.cupRoundId} is not null`),
  ],
);

/** The official result. Written only by finalise/award/correct, in the same transaction as the status change. */
export const fixtureOutcomes = pgTable(
  "fixture_outcomes",
  {
    fixtureId: uuid("fixture_id").notNull().references(() => fixtures.id),
    /** Result group key from the rules, e.g. "main" or "pairs". One row per group. */
    groupKey: text("group_key").notNull(),
    homeGames: integer("home_games").notNull(),
    awayGames: integer("away_games").notNull(),
    homePointGames: integer("home_point_games").notNull(),
    awayPointGames: integer("away_point_games").notNull(),
    homeLegs: integer("home_legs").notNull(),
    awayLegs: integer("away_legs").notNull(),
    winner: resultEnum("winner").notNull(),
    source: outcomeSourceEnum("source").notNull(),
    finalisedAt: tsz("finalised_at").notNull().defaultNow(),
    finalisedBy: text("finalised_by").references(() => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.fixtureId, t.groupKey] }),
    check("fixture_outcomes_non_negative", sql`${t.homeGames} >= 0 and ${t.awayGames} >= 0`),
  ],
);

export const games = pgTable(
  "games",
  {
    id: id(),
    fixtureId: uuid("fixture_id").notNull().references(() => fixtures.id),
    ordinal: integer("ordinal").notNull(),
    kind: gameKindEnum("kind").notNull().default("SINGLES"),
    /** Which result group this game counts towards (copied from the rules when games are created). */
    groupKey: text("group_key").notNull().default("main"),
    status: gameStatusEnum("status").notNull().default("PENDING"),
    /** COMPLETED: winner or DRAW. WALKOVER: side awarded the game. */
    winner: resultEnum("winner"),
    homeLegs: integer("home_legs").notNull().default(0),
    awayLegs: integer("away_legs").notNull().default(0),
    firstThrower: sideEnum("first_thrower"),
    startedAt: tsz("started_at"),
    completedAt: tsz("completed_at"),
  },
  (t) => [
    uniqueIndex("games_fixture_ordinal_uq").on(t.fixtureId, t.ordinal),
    check("games_walkover_has_winner", sql`${t.status} <> 'WALKOVER' or ${t.winner} in ('HOME', 'AWAY')`),
  ],
);

/** The lineup: which registered player plays which game, on which side. */
export const gamePlayers = pgTable(
  "game_players",
  {
    gameId: uuid("game_id").notNull().references(() => games.id),
    side: sideEnum("side").notNull(),
    /** 1 for singles; 1–2 for pairs. */
    position: integer("position").notNull().default(1),
    registrationId: uuid("registration_id").notNull().references(() => playerRegistrations.id),
    playerId: uuid("player_id").notNull().references(() => players.id),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.side, t.position] }),
    index("game_players_player_idx").on(t.playerId),
  ],
);

export const legs = pgTable(
  "legs",
  {
    id: id(),
    gameId: uuid("game_id").notNull().references(() => games.id),
    ordinal: integer("ordinal").notNull(),
    startingSide: sideEnum("starting_side").notNull(),
    winner: sideEnum("winner"),
  },
  (t) => [uniqueIndex("legs_game_ordinal_uq").on(t.gameId, t.ordinal)],
);

/** One 3-dart visit. The single source of truth for every darts statistic. Append-only. */
export const visits = pgTable(
  "visits",
  {
    id: id(),
    legId: uuid("leg_id").notNull().references(() => legs.id),
    /** 1, 2, 3 … per leg. Voided visits keep their number; the next visit is max + 1. */
    seq: integer("seq").notNull(),
    side: sideEnum("side").notNull(),
    playerId: uuid("player_id").notNull().references(() => players.id),
    entered: integer("entered").notNull(),
    score: integer("score").notNull(),
    darts: integer("darts").notNull(),
    isBust: boolean("is_bust").notNull(),
    isCheckout: boolean("is_checkout").notNull(),
    /** Generated by the scoring device; makes retried submissions idempotent. */
    clientEventId: uuid("client_event_id").notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
    voidedAt: tsz("voided_at"),
    voidedBy: text("voided_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("visits_leg_seq_uq").on(t.legId, t.seq),
    uniqueIndex("visits_client_event_uq").on(t.clientEventId),
    check("visits_score", sql`${t.score} between 0 and 180 and ${t.entered} between 0 and 180`),
    check("visits_darts", sql`${t.darts} between 1 and 3`),
    check("visits_bust_scores_zero", sql`not ${t.isBust} or ${t.score} = 0`),
  ],
);

/**
 * Derived cache: one row per player per game, rebuilt from visits whenever a
 * game completes or is corrected. Safe to truncate and rebuild at any time.
 */
export const playerGameStats = pgTable(
  "player_game_stats",
  {
    gameId: uuid("game_id").notNull().references(() => games.id),
    playerId: uuid("player_id").notNull().references(() => players.id),
    registrationId: uuid("registration_id").notNull().references(() => playerRegistrations.id),
    side: sideEnum("side").notNull(),
    gameKind: gameKindEnum("game_kind").notNull(),
    isWalkover: boolean("is_walkover").notNull().default(false),
    points: integer("points").notNull(),
    darts: integer("darts").notNull(),
    bands: jsonb("bands").$type<Record<string, number>>().notNull(),
    highestCheckout: integer("highest_checkout"),
    bestLegDarts: integer("best_leg_darts"),
    legsPlayed: integer("legs_played").notNull(),
    legsWon: integer("legs_won").notNull(),
    gamesPlayed: integer("games_played").notNull(),
    wins: integer("wins").notNull(),
    losses: integer("losses").notNull(),
    draws: integer("draws").notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.playerId] }), index("player_game_stats_player_idx").on(t.playerId)],
);

// ---------------------------------------------------------------------------
// Rearrangements, notifications, audit
// ---------------------------------------------------------------------------

export const fixtureRearrangements = pgTable(
  "fixture_rearrangements",
  {
    id: id(),
    fixtureId: uuid("fixture_id").notNull().references(() => fixtures.id),
    requestedByTeamId: uuid("requested_by_team_id").notNull().references(() => teams.id),
    requestedBy: text("requested_by").notNull().references(() => users.id),
    originalAt: tsz("original_at").notNull(),
    /** SCHEDULED or POSTPONED: where the fixture goes back to if the request ends without a new date. */
    previousStatus: fixtureStatusEnum("previous_status").notNull().default("SCHEDULED"),
    proposedAt: tsz("proposed_at").notNull(),
    note: text("note"),
    status: rearrangementStatusEnum("status").notNull().default("PENDING"),
    respondedBy: text("responded_by").references(() => users.id),
    respondedAt: tsz("responded_at"),
    responseNote: text("response_note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fixture_rearrangements_one_pending_uq")
      .on(t.fixtureId)
      .where(sql`${t.status} = 'PENDING'`),
  ],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id),
    leagueId: uuid("league_id").references(() => leagues.id),
    /** e.g. "rearrangement.requested", "fixture.upcoming", "registration.deadline". */
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    readAt: tsz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/** Outbox for external channels (email, push, WhatsApp…). In-app needs no delivery row. */
export const notificationDeliveries = pgTable("notification_deliveries", {
  id: id(),
  notificationId: uuid("notification_id").notNull().references(() => notifications.id),
  channel: text("channel").notNull(),
  status: text("status").notNull().default("PENDING"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  sentAt: tsz("sent_at"),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    leagueId: uuid("league_id").references(() => leagues.id),
    actorUserId: text("actor_user_id").references(() => users.id),
    /** e.g. "fixture.result_corrected", "team.folded", "player.registered_override". */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_league_idx").on(t.leagueId, t.createdAt),
    index("audit_log_entity_idx").on(t.entityType, t.entityId),
  ],
);
