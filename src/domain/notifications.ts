/**
 * Notification content. A notification row stores a type and a payload; the
 * wording is produced here, at read time, so the in-app list and any external
 * channel (email, WhatsApp…) say exactly the same thing.
 */

export interface FixturePayload {
  fixtureId: string;
  leagueSlug: string;
  home: string;
  away: string;
  /** League timezone, for formatting times. */
  tz: string;
}

export type NotificationEvent =
  | { type: "rearrangement.requested"; payload: FixturePayload & { requestedBy: string; originalAt: string; proposedAt: string; note?: string | null; warnings: string[] } }
  | { type: "rearrangement.accepted"; payload: FixturePayload & { proposedAt: string; by: string } }
  | { type: "rearrangement.rejected"; payload: FixturePayload & { proposedAt: string; by: string; note?: string | null } }
  | { type: "rearrangement.withdrawn"; payload: FixturePayload & { proposedAt: string; by: string } }
  | { type: "rearrangement.expired"; payload: FixturePayload & { proposedAt: string } }
  | { type: "fixture.rescheduled"; payload: FixturePayload & { scheduledAt: string; reason?: string | null } }
  | { type: "fixture.postponed"; payload: FixturePayload & { reason?: string | null } }
  | { type: "fixture.cancelled"; payload: FixturePayload & { reason?: string | null } }
  | { type: "fixture.voided"; payload: FixturePayload & { reason?: string | null } }
  | { type: "fixture.restored"; payload: FixturePayload & { reason?: string | null } }
  | { type: "fixture.awarded"; payload: FixturePayload & { winner: string; reason?: string | null } }
  | { type: "fixture.abandoned"; payload: FixturePayload & { reason?: string | null } }
  | { type: "result.corrected"; payload: FixturePayload & { reason?: string | null } }
  | { type: "cup.drawn"; payload: { leagueSlug: string; cup: string; competitionId: string } }
  | { type: "cup.tie"; payload: FixturePayload & { cup: string; round: string; scheduledAt: string } }
  | { type: "team.folded"; payload: { leagueSlug: string; team: string; competition: string; fixtures: number } }
  | { type: "team.fold_reverted"; payload: { leagueSlug: string; team: string; competition: string } };

export type NotificationType = NotificationEvent["type"];

export interface RenderedNotification {
  title: string;
  body: string;
  /** Where tapping the notification goes. */
  href: string;
}

const when = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

const reasonText = (r?: string | null) => (r ? ` Reason: ${r}` : "");

export function renderNotification(type: string, payload: unknown): RenderedNotification {
  const e = { type, payload } as NotificationEvent;
  if (e.type === "cup.drawn") {
    const p = e.payload;
    return { title: `${p.cup}: the draw is out`, body: `See who you've got and when.`, href: `/leagues/${p.leagueSlug}/divisions/${p.competitionId}` };
  }
  if (e.type === "team.folded") {
    const p = e.payload;
    return { title: `${p.team} have folded`, body: `${p.team} have withdrawn from ${p.competition}; ${p.fixtures} of their fixtures were updated.`, href: `/leagues/${p.leagueSlug}/tables` };
  }
  if (e.type === "team.fold_reverted") {
    const p = e.payload;
    return { title: `${p.team} reinstated`, body: `The fold of ${p.team} in ${p.competition} was reversed.`, href: `/leagues/${p.leagueSlug}/tables` };
  }
  if (!isFixtureEvent(e)) return { title: "Update", body: "", href: "/" };
  const p = e.payload;
  const match = `${p.home} v ${p.away}`;
  const href = `/admin/${p.leagueSlug}/fixtures/${p.fixtureId}`;
  switch (e.type) {
    case "rearrangement.requested": {
      const q = e.payload;
      const warn = q.warnings.length ? ` Note: ${q.warnings.join("; ")}.` : "";
      const note = q.note ? ` "${q.note}"` : "";
      return { title: `Rearrangement requested: ${match}`, body: `${q.requestedBy} ask to move it from ${when(q.originalAt, p.tz)} to ${when(q.proposedAt, p.tz)}.${note}${warn}`, href };
    }
    case "rearrangement.accepted":
      return { title: `New date agreed: ${match}`, body: `${e.payload.by} accepted. Now ${when(e.payload.proposedAt, p.tz)}.`, href };
    case "rearrangement.rejected":
      return { title: `Rearrangement declined: ${match}`, body: `${e.payload.by} declined ${when(e.payload.proposedAt, p.tz)}.${e.payload.note ? ` "${e.payload.note}"` : ""}`, href };
    case "rearrangement.withdrawn":
      return { title: `Rearrangement withdrawn: ${match}`, body: `${e.payload.by} withdrew the request for ${when(e.payload.proposedAt, p.tz)}.`, href };
    case "rearrangement.expired":
      return { title: `Rearrangement lapsed: ${match}`, body: `The request for ${when(e.payload.proposedAt, p.tz)} wasn't answered in time. The league admin will decide.`, href };
    case "fixture.rescheduled":
      return { title: `Fixture moved: ${match}`, body: `Now ${when(e.payload.scheduledAt, p.tz)}.${reasonText(e.payload.reason)}`, href };
    case "fixture.postponed":
      return { title: `Postponed: ${match}`, body: `A new date will follow.${reasonText(e.payload.reason)}`, href };
    case "fixture.cancelled":
      return { title: `Cancelled: ${match}`, body: `This fixture won't be played.${reasonText(e.payload.reason)}`, href };
    case "fixture.voided":
      return { title: `Result voided: ${match}`, body: `It no longer counts in the table.${reasonText(e.payload.reason)}`, href };
    case "fixture.restored":
      return { title: `Fixture restored: ${match}`, body: `It's back on.${reasonText(e.payload.reason)}`, href };
    case "fixture.awarded":
      return { title: `Result awarded: ${match}`, body: `Awarded to ${e.payload.winner}.${reasonText(e.payload.reason)}`, href };
    case "fixture.abandoned":
      return { title: `Abandoned: ${match}`, body: `Play stopped; games finished so far are kept and the match resumes on a new date.${reasonText(e.payload.reason)}`, href };
    case "cup.tie":
      return { title: `${e.payload.cup} ${e.payload.round}: ${match}`, body: `${when(e.payload.scheduledAt, p.tz)} at ${p.home}'s venue.`, href };
    case "result.corrected":
      return { title: `Result corrected: ${match}`, body: `The league admin corrected the scores.${reasonText(e.payload.reason)}`, href };
  }
}

function isFixtureEvent(e: NotificationEvent): e is Exclude<NotificationEvent, { type: "team.folded" | "team.fold_reverted" | "cup.drawn" }> {
  return e.type !== "team.folded" && e.type !== "team.fold_reverted" && e.type !== "cup.drawn";
}
