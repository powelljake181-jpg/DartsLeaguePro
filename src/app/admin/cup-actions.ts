"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import type { DrawMode } from "@/domain/cups";
import { RULE_TEMPLATES } from "@/domain/rules";
import { attempt, str, type FormState } from "@/lib/action";
import { requireActor } from "@/lib/session";
import { addCupEntrant, createCup, makeDraw, previewDraw, removeCupEntrant, setCupRoundDate, setCupSeeds, type DrawResult } from "@/server/cup-service";
import { kickDelivery } from "@/server/notification-service";

/** Server actions for cups. Services check permissions against the stored league. */

async function ctx() {
  const { actor } = await requireActor();
  return { actor, db: await getDb() };
}

function done(message: string): FormState {
  revalidatePath("/admin", "layout");
  revalidatePath("/leagues", "layout");
  return { ok: true, message };
}

export async function createCupAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const template = RULE_TEMPLATES.find((t) => t.key === str(fd, "template"));
  if (!template) return { error: "Choose a match format." };
  const r = await attempt(() =>
    createCup(db, actor, { seasonId: str(fd, "seasonId"), name: str(fd, "name"), rules: template.rules, teamIds: fd.getAll("teamId").filter((x): x is string => typeof x === "string") }),
  );
  if (!r.ok) return { error: r.error };
  revalidatePath("/admin", "layout");
  redirect(`/admin/${str(fd, "leagueSlug")}/cups/${r.value.id}`);
}

export async function addCupEntrantAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => addCupEntrant(db, actor, { competitionId: str(fd, "competitionId"), teamId: str(fd, "teamId") }));
  return r.ok ? done("Team added.") : { error: r.error };
}

export async function removeCupEntrantAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => removeCupEntrant(db, actor, { entryId: str(fd, "entryId") }));
  return r.ok ? done("Team removed.") : { error: r.error };
}

export async function setCupSeedsAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const seeds: Record<string, number | null> = {};
  for (const [k, v] of fd.entries()) {
    if (!k.startsWith("seed:") || typeof v !== "string") continue;
    seeds[k.slice(5)] = v.trim() === "" ? null : Number(v);
  }
  const r = await attempt(() => setCupSeeds(db, actor, { competitionId: str(fd, "competitionId"), seeds }));
  return r.ok ? done("Seeds saved.") : { error: r.error };
}

export async function setCupRoundDateAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => setCupRoundDate(db, actor, { roundId: str(fd, "roundId"), date: str(fd, "date"), kickOff: str(fd, "time") }));
  if (!r.ok) return { error: r.error };
  kickDelivery(db);
  const moved = r.value.moved ? ` ${r.value.moved} tie${r.value.moved === 1 ? "" : "s"} moved.` : "";
  const warn = r.value.warnings.length ? ` Heads up: ${r.value.warnings.join("; ")}.` : "";
  return done(`Date saved.${moved}${warn}`);
}

export type DrawFormState = FormState & { preview?: DrawResult; mode?: DrawMode };

const drawInput = (fd: FormData) => {
  const mode = (["RANDOM", "SEEDED", "MANUAL"].includes(str(fd, "mode")) ? str(fd, "mode") : "RANDOM") as DrawMode;
  const manual = [];
  for (let i = 0; fd.has(`home:${i}`); i++) manual.push({ home: str(fd, `home:${i}`) || null, away: str(fd, `away:${i}`) || null });
  const seed = Number(str(fd, "rngSeed"));
  return { competitionId: str(fd, "competitionId"), mode, manual, rngSeed: Number.isInteger(seed) && str(fd, "rngSeed") ? seed : undefined };
};

/** "Preview" shows the draw; "Confirm" saves exactly that draw (same random seed). */
export async function drawAction(_: DrawFormState, fd: FormData): Promise<DrawFormState> {
  const { actor, db } = await ctx();
  const input = drawInput(fd);
  if (str(fd, "intent") !== "apply") {
    // A fresh preview gets a fresh random seed.
    const r = await attempt(() => previewDraw(db, actor, { ...input, rngSeed: undefined }));
    return r.ok ? { preview: r.value, mode: input.mode } : { error: r.error, mode: input.mode };
  }
  const r = await attempt(() => makeDraw(db, actor, input));
  if (!r.ok) return { error: r.error, mode: input.mode };
  kickDelivery(db);
  return { ...done("The draw is made; every team in the cup has been told."), mode: input.mode };
}
