ALTER TABLE "cup_rounds" ADD COLUMN "kick_off" text DEFAULT '19:30' NOT NULL;--> statement-breakpoint
ALTER TABLE "fixtures" ADD COLUMN "bracket_slot" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "fixtures_cup_slot_uq" ON "fixtures" USING btree ("cup_round_id","bracket_slot") WHERE "fixtures"."cup_round_id" is not null;