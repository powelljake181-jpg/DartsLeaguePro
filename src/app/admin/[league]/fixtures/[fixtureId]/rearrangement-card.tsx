import { ActionForm } from "@/components/form";
import { Badge, Card, Field, Input, Notice, Select, formatDate } from "@/components/ui";
import type { Side } from "@/domain/scoring";
import { requestRearrangementAction, respondRearrangementAction, withdrawRearrangementAction } from "@/app/admin/fixture-actions";
import type { fixtureRearrangementState } from "@/server/rearrangement-service";
import { DateTimeFields } from "./date-fields";

type State = Awaited<ReturnType<typeof fixtureRearrangementState>>;

/**
 * Asking for, answering and withdrawing a change of date. Team captains see
 * the actions for their side; league admins can act for either team.
 */
export function RearrangementCard({
  fixtureId,
  status,
  state,
  names,
  mySides,
  leagueAdmin,
  tz,
  defaults,
}: {
  fixtureId: string;
  status: string;
  state: State;
  names: Record<Side, string>;
  /** Sides the user captains. */
  mySides: Side[];
  leagueAdmin: boolean;
  tz: string;
  defaults: { date: string; time: string };
}) {
  const when = (d: Date) => formatDate(d, tz, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const p = state.pending;
  const canAsk = (status === "SCHEDULED" || status === "POSTPONED") && (leagueAdmin || mySides.length > 0);
  if (!p && !canAsk && state.history.length === 0) return null;

  const otherSide = (s: Side): Side => (s === "HOME" ? "AWAY" : "HOME");
  const canAnswer = p && (leagueAdmin || mySides.includes(otherSide(p.requestingSide)));
  const canWithdraw = p && (leagueAdmin || mySides.includes(p.requestingSide));
  const askSides: Side[] = leagueAdmin ? ["HOME", "AWAY"] : mySides;

  return (
    <Card title="Change the date" description={p ? undefined : "Ask the other team to move this fixture. They accept or decline; the league is kept informed."}>
      {p ? (
        <div className="space-y-3">
          <Notice tone="warning">
            <strong>{p.team}</strong> asked to move this fixture from {when(p.r.originalAt)} to <strong>{when(p.r.proposedAt)}</strong>.
            {p.r.note && <span className="mt-1 block">&ldquo;{p.r.note}&rdquo;</span>}
          </Notice>
          {p.warnings.length > 0 && (
            <ul className="list-inside list-disc text-sm text-warning">
              {p.warnings.map((w) => (
                <li key={w.message}>{w.message}</li>
              ))}
            </ul>
          )}
          {canAnswer && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm font-medium">
                {leagueAdmin && !mySides.includes(otherSide(p.requestingSide)) ? `Answer for ${names[otherSide(p.requestingSide)]}` : "Your answer"}
              </p>
              <ActionForm action={respondRearrangementAction} submitLabel="Accept new date">
                <input type="hidden" name="rearrangementId" value={p.r.id} />
                <input type="hidden" name="fixtureId" value={fixtureId} />
                <input type="hidden" name="decision" value="accept" />
              </ActionForm>
              <details>
                <summary className="cursor-pointer text-sm text-muted">Decline…</summary>
                <ActionForm action={respondRearrangementAction} submitLabel="Decline" submitVariant="danger" className="mt-2 space-y-3">
                  <input type="hidden" name="rearrangementId" value={p.r.id} />
                  <input type="hidden" name="fixtureId" value={fixtureId} />
                  <input type="hidden" name="decision" value="reject" />
                  <Field label="Message (optional)" htmlFor="decline-note">
                    <Input id="decline-note" name="note" maxLength={500} placeholder="e.g. Half our team are on holiday" />
                  </Field>
                </ActionForm>
              </details>
            </div>
          )}
          {canWithdraw && (
            <ActionForm action={withdrawRearrangementAction} submitLabel="Withdraw request" submitVariant="secondary">
              <input type="hidden" name="rearrangementId" value={p.r.id} />
              <input type="hidden" name="fixtureId" value={fixtureId} />
            </ActionForm>
          )}
        </div>
      ) : (
        canAsk && (
          <ActionForm action={requestRearrangementAction} submitLabel="Send request" resetOnSuccess>
            <input type="hidden" name="fixtureId" value={fixtureId} />
            {askSides.length === 1 ? (
              <input type="hidden" name="side" value={askSides[0]} />
            ) : (
              <Field label="Asking on behalf of" htmlFor="ask-side">
                <Select id="ask-side" name="side" defaultValue={askSides[0]}>
                  {askSides.map((s) => (
                    <option key={s} value={s}>
                      {names[s]}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <DateTimeFields date={defaults.date} time={defaults.time} idPrefix="ask" />
            <Field label="Message (optional)" htmlFor="ask-note">
              <Input id="ask-note" name="note" maxLength={500} placeholder="Why you need to move it" />
            </Field>
          </ActionForm>
        )
      )}
      {state.history.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-muted">Earlier requests</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {state.history.map((h) => (
              <li key={h.r.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={h.r.status === "ACCEPTED" ? "accent" : "neutral"}>{h.r.status.toLowerCase()}</Badge>
                <span>
                  {h.team}: {when(h.r.originalAt)} → {when(h.r.proposedAt)}
                </span>
                {h.r.responseNote && <span className="text-muted">&ldquo;{h.r.responseNote}&rdquo;</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
