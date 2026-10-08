CREATE TYPE "public"."blackout_kind" AS ENUM('CUP', 'BREAK', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."competition_kind" AS ENUM('LEAGUE', 'CUP');--> statement-breakpoint
CREATE TYPE "public"."entry_status" AS ENUM('ACTIVE', 'FOLDED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."fixture_status" AS ENUM('SCHEDULED', 'REARRANGEMENT_REQUESTED', 'POSTPONED', 'LIVE', 'COMPLETED', 'CANCELLED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."fold_results" AS ENUM('VOID_ALL', 'MAX_LOSS_REMAINING', 'MAX_LOSS_ALL');--> statement-breakpoint
CREATE TYPE "public"."fold_stats" AS ENUM('KEEP', 'EXCLUDE');--> statement-breakpoint
CREATE TYPE "public"."game_kind" AS ENUM('SINGLES', 'PAIRS');--> statement-breakpoint
CREATE TYPE "public"."game_status" AS ENUM('PENDING', 'LIVE', 'COMPLETED', 'WALKOVER', 'NOT_REQUIRED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."league_role" AS ENUM('LEAGUE_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."outcome_source" AS ENUM('PLAYED', 'AWARDED', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."player_status" AS ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."rearrangement_status" AS ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'OVERRIDDEN', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."registration_status" AS ENUM('ACTIVE', 'ENDED');--> statement-breakpoint
CREATE TYPE "public"."result" AS ENUM('HOME', 'AWAY', 'DRAW');--> statement-breakpoint
CREATE TYPE "public"."season_status" AS ENUM('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."side" AS ENUM('HOME', 'AWAY');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('TEAM_ADMIN');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"league_id" uuid,
	"actor_user_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blackout_dates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"competition_id" uuid,
	"date" date NOT NULL,
	"kind" "blackout_kind" NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_rule_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"ruleset_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"kind" "competition_kind" NOT NULL,
	"division_id" uuid,
	"name" text NOT NULL,
	"match_weekday" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitions_league_has_division" CHECK ("competitions"."kind" <> 'LEAGUE' or "competitions"."division_id" is not null),
	CONSTRAINT "competitions_weekday" CHECK ("competitions"."match_weekday" is null or "competitions"."match_weekday" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "cup_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"name" text NOT NULL,
	"scheduled_on" date
);
--> statement-breakpoint
CREATE TABLE "divisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rank" integer NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fixture_outcomes" (
	"fixture_id" uuid NOT NULL,
	"group_key" text NOT NULL,
	"home_games" integer NOT NULL,
	"away_games" integer NOT NULL,
	"home_point_games" integer NOT NULL,
	"away_point_games" integer NOT NULL,
	"home_legs" integer NOT NULL,
	"away_legs" integer NOT NULL,
	"winner" "result" NOT NULL,
	"source" "outcome_source" NOT NULL,
	"finalised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalised_by" text,
	CONSTRAINT "fixture_outcomes_fixture_id_group_key_pk" PRIMARY KEY("fixture_id","group_key"),
	CONSTRAINT "fixture_outcomes_non_negative" CHECK ("fixture_outcomes"."home_games" >= 0 and "fixture_outcomes"."away_games" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fixture_rearrangements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fixture_id" uuid NOT NULL,
	"requested_by_team_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"original_at" timestamp with time zone NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"note" text,
	"status" "rearrangement_status" DEFAULT 'PENDING' NOT NULL,
	"responded_by" text,
	"responded_at" timestamp with time zone,
	"response_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixtures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"competition_id" uuid NOT NULL,
	"round_number" integer,
	"cup_round_id" uuid,
	"home_entry_id" uuid NOT NULL,
	"away_entry_id" uuid,
	"scheduled_at" timestamp with time zone NOT NULL,
	"venue_id" uuid,
	"status" "fixture_status" DEFAULT 'SCHEDULED' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"responsible_side" "side",
	"home_lineup_confirmed_at" timestamp with time zone,
	"away_lineup_confirmed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"void_reason" text,
	"keep_stats_when_void" boolean DEFAULT false NOT NULL,
	"fold_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixtures_distinct_teams" CHECK ("fixtures"."home_entry_id" <> "fixtures"."away_entry_id")
);
--> statement-breakpoint
CREATE TABLE "fold_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_entry_id" uuid NOT NULL,
	"folded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"results_treatment" "fold_results" NOT NULL,
	"player_stats_treatment" "fold_stats" NOT NULL,
	"previous_state" jsonb NOT NULL,
	"created_by" text,
	"reverted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "game_players" (
	"game_id" uuid NOT NULL,
	"side" "side" NOT NULL,
	"position" integer DEFAULT 1 NOT NULL,
	"registration_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	CONSTRAINT "game_players_game_id_side_position_pk" PRIMARY KEY("game_id","side","position")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fixture_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" "game_kind" DEFAULT 'SINGLES' NOT NULL,
	"group_key" text DEFAULT 'main' NOT NULL,
	"status" "game_status" DEFAULT 'PENDING' NOT NULL,
	"winner" "result",
	"home_legs" integer DEFAULT 0 NOT NULL,
	"away_legs" integer DEFAULT 0 NOT NULL,
	"first_thrower" "side",
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "games_walkover_has_winner" CHECK ("games"."status" <> 'WALKOVER' or "games"."winner" in ('HOME', 'AWAY'))
);
--> statement-breakpoint
CREATE TABLE "league_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "league_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Europe/London' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "leagues_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "legs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"starting_side" "side" NOT NULL,
	"winner" "side"
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"league_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_game_stats" (
	"game_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"side" "side" NOT NULL,
	"game_kind" "game_kind" NOT NULL,
	"is_walkover" boolean DEFAULT false NOT NULL,
	"points" integer NOT NULL,
	"darts" integer NOT NULL,
	"bands" jsonb NOT NULL,
	"highest_checkout" integer,
	"best_leg_darts" integer,
	"legs_played" integer NOT NULL,
	"legs_won" integer NOT NULL,
	"games_played" integer NOT NULL,
	"wins" integer NOT NULL,
	"losses" integer NOT NULL,
	"draws" integer NOT NULL,
	CONSTRAINT "player_game_stats_game_id_player_id_pk" PRIMARY KEY("game_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "player_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"status" "registration_status" DEFAULT 'ACTIVE' NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registered_by" text,
	"is_override" boolean DEFAULT false NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"status" "player_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anonymised_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rulesets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "scheduling_constraint_teams" (
	"constraint_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "scheduling_constraint_teams_constraint_id_team_id_pk" PRIMARY KEY("constraint_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "scheduling_constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"name" text NOT NULL,
	"venue_id" uuid,
	"max_home_per_date" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "scheduling_constraints_max" CHECK ("scheduling_constraints"."max_home_per_date" >= 1)
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"status" "season_status" DEFAULT 'DRAFT' NOT NULL,
	"registration_closes_at" timestamp with time zone,
	"max_squad_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competition_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"venue_id" uuid,
	"status" "entry_status" DEFAULT 'ACTIVE' NOT NULL,
	"seed" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" "team_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"home_venue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"league_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leg_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"side" "side" NOT NULL,
	"player_id" uuid NOT NULL,
	"entered" integer NOT NULL,
	"score" integer NOT NULL,
	"darts" integer NOT NULL,
	"is_bust" boolean NOT NULL,
	"is_checkout" boolean NOT NULL,
	"client_event_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	CONSTRAINT "visits_score" CHECK ("visits"."score" between 0 and 180 and "visits"."entered" between 0 and 180),
	CONSTRAINT "visits_darts" CHECK ("visits"."darts" between 1 and 3),
	CONSTRAINT "visits_bust_scores_zero" CHECK (not "visits"."is_bust" or "visits"."score" = 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blackout_dates" ADD CONSTRAINT "blackout_dates_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blackout_dates" ADD CONSTRAINT "blackout_dates_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_rule_periods" ADD CONSTRAINT "competition_rule_periods_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_rule_periods" ADD CONSTRAINT "competition_rule_periods_ruleset_id_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."rulesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_rule_periods" ADD CONSTRAINT "competition_rule_periods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_division_id_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."divisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cup_rounds" ADD CONSTRAINT "cup_rounds_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "divisions" ADD CONSTRAINT "divisions_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_outcomes" ADD CONSTRAINT "fixture_outcomes_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_outcomes" ADD CONSTRAINT "fixture_outcomes_finalised_by_users_id_fk" FOREIGN KEY ("finalised_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_rearrangements" ADD CONSTRAINT "fixture_rearrangements_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_rearrangements" ADD CONSTRAINT "fixture_rearrangements_requested_by_team_id_teams_id_fk" FOREIGN KEY ("requested_by_team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_rearrangements" ADD CONSTRAINT "fixture_rearrangements_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_rearrangements" ADD CONSTRAINT "fixture_rearrangements_responded_by_users_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_cup_round_id_cup_rounds_id_fk" FOREIGN KEY ("cup_round_id") REFERENCES "public"."cup_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_home_entry_id_team_entries_id_fk" FOREIGN KEY ("home_entry_id") REFERENCES "public"."team_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_away_entry_id_team_entries_id_fk" FOREIGN KEY ("away_entry_id") REFERENCES "public"."team_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_fold_event_id_fold_events_id_fk" FOREIGN KEY ("fold_event_id") REFERENCES "public"."fold_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fold_events" ADD CONSTRAINT "fold_events_team_entry_id_team_entries_id_fk" FOREIGN KEY ("team_entry_id") REFERENCES "public"."team_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fold_events" ADD CONSTRAINT "fold_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_registration_id_player_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."player_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_players" ADD CONSTRAINT "game_players_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_fixture_id_fixtures_id_fk" FOREIGN KEY ("fixture_id") REFERENCES "public"."fixtures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legs" ADD CONSTRAINT "legs_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_game_stats" ADD CONSTRAINT "player_game_stats_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_game_stats" ADD CONSTRAINT "player_game_stats_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_game_stats" ADD CONSTRAINT "player_game_stats_registration_id_player_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."player_registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_registrations" ADD CONSTRAINT "player_registrations_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_registrations" ADD CONSTRAINT "player_registrations_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_registrations" ADD CONSTRAINT "player_registrations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_registrations" ADD CONSTRAINT "player_registrations_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_registrations" ADD CONSTRAINT "player_registrations_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rulesets" ADD CONSTRAINT "rulesets_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rulesets" ADD CONSTRAINT "rulesets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_constraint_teams" ADD CONSTRAINT "scheduling_constraint_teams_constraint_id_scheduling_constraints_id_fk" FOREIGN KEY ("constraint_id") REFERENCES "public"."scheduling_constraints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_constraint_teams" ADD CONSTRAINT "scheduling_constraint_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_constraints" ADD CONSTRAINT "scheduling_constraints_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_constraints" ADD CONSTRAINT "scheduling_constraints_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_entries" ADD CONSTRAINT "team_entries_competition_id_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_entries" ADD CONSTRAINT "team_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_entries" ADD CONSTRAINT "team_entries_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_home_venue_id_venues_id_fk" FOREIGN KEY ("home_venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_leg_id_legs_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."legs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_league_idx" ON "audit_log" USING btree ("league_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "blackout_dates_season_idx" ON "blackout_dates" USING btree ("season_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "competition_rule_periods_uq" ON "competition_rule_periods" USING btree ("competition_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "competitions_division_season_uq" ON "competitions" USING btree ("season_id","division_id") WHERE "competitions"."kind" = 'LEAGUE';--> statement-breakpoint
CREATE UNIQUE INDEX "cup_rounds_uq" ON "cup_rounds" USING btree ("competition_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "divisions_name_uq" ON "divisions" USING btree ("league_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "fixture_rearrangements_one_pending_uq" ON "fixture_rearrangements" USING btree ("fixture_id") WHERE "fixture_rearrangements"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "fixtures_competition_idx" ON "fixtures" USING btree ("competition_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "fixtures_league_date_idx" ON "fixtures" USING btree ("league_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "game_players_player_idx" ON "game_players" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "games_fixture_ordinal_uq" ON "games" USING btree ("fixture_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "league_memberships_active_uq" ON "league_memberships" USING btree ("league_id","user_id","role") WHERE "league_memberships"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "legs_game_ordinal_uq" ON "legs" USING btree ("game_id","ordinal");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "player_game_stats_player_idx" ON "player_game_stats" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_registrations_one_active_uq" ON "player_registrations" USING btree ("player_id","season_id") WHERE "player_registrations"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "player_registrations_team_season_idx" ON "player_registrations" USING btree ("team_id","season_id");--> statement-breakpoint
CREATE INDEX "players_league_idx" ON "players" USING btree ("league_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rulesets_name_version_uq" ON "rulesets" USING btree ("league_id","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_name_uq" ON "seasons" USING btree ("league_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "team_entries_uq" ON "team_entries" USING btree ("competition_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_memberships_active_uq" ON "team_memberships" USING btree ("team_id","user_id","role") WHERE "team_memberships"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_slug_uq" ON "teams" USING btree ("league_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "visits_leg_seq_uq" ON "visits" USING btree ("leg_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "visits_client_event_uq" ON "visits" USING btree ("client_event_id");