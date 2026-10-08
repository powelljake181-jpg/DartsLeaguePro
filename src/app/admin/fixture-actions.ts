"use server";

import { revalidatePath } from "next/cache";
import { getDb, type Db } from "@/db/client";
import { zonedTimeToUtc } from "@/domain/dates";
import type { FoldResults } from "@/domain/folds";
import type { Side } from "@/domain/scoring";
import { attempt, str, type FormState } from "@/lib/action";
import { requireActor } from "@/lib/session";
import { leagueTimezone, loadFixtureContext } from "@/server/context";
import { AppError } from "@/server/errors";
import { publishFixtureChanged } from "@/server/events";
import { abandonFixture, awardFixture, cancelFixture, postponeFixture, rescheduleFixture, restoreFixture } from "@/server/fixture-admin-service";
import { foldTeam, previewFold, revertFold, type FoldPreview } from "@/server/fold-service";
import { correctLeg, voidFixture } from "@/server/match-service";
import { kickDelivery } from "@/server/notification-service";
import { requestRearrangement, respondToRearrangement, withdrawRearrangement } from "@/server/rearrangement-service";

/**
 * Server actions for rearrangements, league-admin fixture changes, score
 * corrections and folds. Each re-identifies the user from the session; the
 * services check permissions against the fixture's league and teams as stored.
 */

async function ctx() {
  const { actor } = await requireActor();
  return { actor, db: await getDb() };
}

/** After a change commits: refresh pages, push to live viewers, send queued notifications. */
function changed(db: Db, message: string, fixtureIds: string[] = []): FormState {
  for (const id of fixtureIds) publishFixtureChanged(id);
  kickDelivery(db);
  revalidatePath("/admin", "layout");
  revalidatePath("/leagues", "layout");
  return { ok: true, message };
}

/** A league-local date + time from the form, as an instant. */
async function whenFromForm(db: Db, fixtureId: string, fd: FormData): Promise<Date> {
  const date = str(fd, "date");
  const time = str(fd, "time");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new AppError("BAD_DATE", "choose a date and a time");
  const { fixture } = await loadFixtureContext(db, fixtureId);
  return zonedTimeToUtc(date, time, await leagueTimezone(db, fixture.leagueId));
}

const side = (fd: FormData, key = "side"): Side => (str(fd, key) === "AWAY" ? "AWAY" : "HOME");

// --- rearrangements --------------------------------------------------------

export async function requestRearrangementAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const fixtureId = str(fd, "fixtureId");
  const r = await attempt(async () =>
    requestRearrangement(db, actor, { fixtureId, side: side(fd), proposedAt: await whenFromForm(db, fixtureId, fd), note: str(fd, "note") }),
  );
  if (!r.ok) return { error: r.error };
  const warn = r.value.warnings.length ? ` Heads up: ${r.value.warnings.map((w) => w.message).join("; ")}.` : "";
  return changed(db, `Request sent. The other team and the league have been told.${warn}`, [fixtureId]);
}

export async function respondRearrangementAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const accept = str(fd, "decision") === "accept";
  const r = await attempt(() => respondToRearrangement(db, actor, { rearrangementId: str(fd, "rearrangementId"), accept, note: str(fd, "note") }));
  if (!r.ok) return { error: r.error };
  const reset = r.value.lineupsReset ? " The new date is played under different rules, so both teams need to pick their players again." : "";
  return changed(db, accept ? `New date agreed.${reset}` : "Request declined; the fixture keeps its date.", [str(fd, "fixtureId")]);
}

export async function withdrawRearrangementAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => withdrawRearrangement(db, actor, { rearrangementId: str(fd, "rearrangementId") }));
  return r.ok ? changed(db, "Request withdrawn.", [str(fd, "fixtureId")]) : { error: r.error };
}

// --- league admin fixture changes ------------------------------------------

export async function adminFixtureAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const fixtureId = str(fd, "fixtureId");
  const reason = str(fd, "reason");
  const op = str(fd, "op");
  const r = await attempt(async (): Promise<string> => {
    switch (op) {
      case "reschedule": {
        const { lineupsReset } = await rescheduleFixture(db, actor, { fixtureId, scheduledAt: await whenFromForm(db, fixtureId, fd), reason });
        return lineupsReset ? "Fixture moved. The new date is played under different rules, so both teams need to pick their players again." : "Fixture moved.";
      }
      case "postpone":
        await postponeFixture(db, actor, { fixtureId, reason });
        return "Fixture postponed.";
      case "cancel":
        await cancelFixture(db, actor, { fixtureId, reason });
        return "Fixture cancelled.";
      case "restore":
        await restoreFixture(db, actor, { fixtureId, reason });
        return "Fixture restored.";
      case "award":
        await awardFixture(db, actor, { fixtureId, winner: side(fd, "winner"), reason });
        return "Result awarded.";
      case "abandon":
        await abandonFixture(db, actor, { fixtureId, reason });
        return "Match abandoned. Finished games are kept; reschedule it to resume.";
      case "void":
        if (!reason.trim()) throw new AppError("REASON_REQUIRED", "give a reason; both teams will see it");
        await voidFixture(db, actor, { fixtureId, reason: reason.trim(), keepPlayerStats: str(fd, "keepStats") === "on" });
        return "Fixture voided.";
      default:
        throw new AppError("BAD_REQUEST", "unknown action");
    }
  });
  return r.ok ? changed(db, r.value, [fixtureId]) : { error: r.error };
}

// --- score corrections -----------------------------------------------------

export async function correctLegAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const fixtureId = str(fd, "fixtureId");
  let parsed: unknown;
  try {
    parsed = JSON.parse(str(fd, "visits"));
  } catch {
    return { error: "The visits couldn't be read; reload the page and try again." };
  }
  if (!Array.isArray(parsed)) return { error: "The visits couldn't be read; reload the page and try again." };
  const visits = parsed.map((v: Record<string, unknown>) => ({
    side: (v.side === "AWAY" ? "AWAY" : "HOME") as Side,
    playerId: typeof v.playerId === "string" && v.playerId ? v.playerId : undefined,
    scored: Number(v.scored),
    darts: v.darts === "" || v.darts === undefined || v.darts === null ? undefined : Number(v.darts),
  }));
  if (!str(fd, "reason").trim()) return { error: "Give a reason; both teams will see it." };
  const r = await attempt(() =>
    correctLeg(db, actor, {
      fixtureId,
      gameOrdinal: Number(str(fd, "gameOrdinal")),
      legOrdinal: Number(str(fd, "legOrdinal")),
      visits,
      reason: str(fd, "reason").trim(),
    }),
  );
  return r.ok ? changed(db, "Leg corrected; the result, table and statistics are updated.", [fixtureId]) : { error: r.error };
}

// --- folds ------------------------------------------------------------------

const foldInput = (fd: FormData) => ({
  entryId: str(fd, "entryId"),
  results: (["VOID_ALL", "MAX_LOSS_REMAINING", "MAX_LOSS_ALL"].includes(str(fd, "results")) ? str(fd, "results") : "MAX_LOSS_REMAINING") as FoldResults,
  playerStats: (str(fd, "playerStats") === "EXCLUDE" ? "EXCLUDE" : "KEEP") as "KEEP" | "EXCLUDE",
  reason: str(fd, "reason"),
});

export type FoldFormState = FormState & { preview?: FoldPreview; input?: ReturnType<typeof foldInput> };

/** One form, two buttons: "Preview" shows what would change; "Fold team" applies it. */
export async function foldAction(_: FoldFormState, fd: FormData): Promise<FoldFormState> {
  const { actor, db } = await ctx();
  const input = foldInput(fd);
  if (str(fd, "intent") !== "apply") {
    const r = await attempt(() => previewFold(db, actor, input));
    return r.ok ? { preview: r.value, input } : { error: r.error, input };
  }
  const r = await attempt(() => foldTeam(db, actor, input));
  if (!r.ok) return { error: r.error, input };
  return { ...changed(db, `${r.value.team} folded; ${r.value.changes.length} fixture(s) updated.`, r.value.changes.map((c) => c.fixtureId)), input };
}

export async function revertFoldAction(_: FormState, fd: FormData): Promise<FormState> {
  const { actor, db } = await ctx();
  const r = await attempt(() => revertFold(db, actor, { foldEventId: str(fd, "foldEventId"), reason: str(fd, "reason") }));
  return r.ok ? changed(db, "Fold reversed; the team and their fixtures are back as they were.") : { error: r.error };
}
