import type { ReactNode } from "react";
import { ActionForm } from "@/components/form";
import { Card, Field, LinkButton, Select } from "@/components/ui";
import type { Side } from "@/domain/scoring";
import { adminFixtureAction } from "@/app/admin/fixture-actions";
import { DateTimeFields, ReasonField } from "./date-fields";

type Op = "reschedule" | "postpone" | "award" | "abandon" | "cancel" | "void" | "restore";

/** Which direct changes make sense for a fixture in each status. */
const OPS: Record<string, Op[]> = {
  SCHEDULED: ["reschedule", "postpone", "award", "cancel", "void"],
  REARRANGEMENT_REQUESTED: ["reschedule", "postpone", "award", "cancel", "void"],
  POSTPONED: ["reschedule", "award", "cancel", "void"],
  LIVE: ["abandon", "award", "void"],
  COMPLETED: ["void"],
  VOID: ["restore"],
  CANCELLED: ["restore"],
};

const LABEL: Record<Op, { title: string; submit: string; help: string; danger?: boolean }> = {
  reschedule: { title: "Move to a new date", submit: "Move fixture", help: "Overrides any pending request from the teams." },
  postpone: { title: "Postpone", submit: "Postpone", help: "No new date yet; move it later." },
  award: { title: "Award the result", submit: "Award result", help: "Every game goes to the winner, e.g. for a no-show." },
  abandon: { title: "Abandon (resume later)", submit: "Abandon match", help: "Finished games are kept; the match is postponed and resumes where it stopped once moved to a new date." },
  cancel: { title: "Cancel", submit: "Cancel fixture", help: "It won't be played and doesn't count.", danger: true },
  void: { title: "Void", submit: "Void fixture", help: "It no longer counts in the table. Can be restored.", danger: true },
  restore: { title: "Restore", submit: "Restore fixture", help: "Puts it back as it was before it was cancelled or voided." },
};

/** League-admin changes to this fixture, each needing a reason that both teams see. */
export function AdminFixtureCard({
  fixtureId,
  status,
  names,
  defaults,
  correctionsHref,
  folded,
}: {
  fixtureId: string;
  status: string;
  names: Record<Side, string>;
  defaults: { date: string; time: string };
  correctionsHref: string | null;
  folded: boolean;
}) {
  if (folded) {
    return (
      <Card title="League admin">
        <p className="text-sm text-muted">This fixture was changed when a team folded. To undo it, reverse the fold from the season page.</p>
      </Card>
    );
  }
  const ops = OPS[status] ?? [];
  const extra: Partial<Record<Op, ReactNode>> = {
    reschedule: <DateTimeFields date={defaults.date} time={defaults.time} idPrefix="admin" />,
    award: (
      <Field label="Winner" htmlFor="award-winner">
        <Select id="award-winner" name="winner" defaultValue="HOME">
          <option value="HOME">{names.HOME}</option>
          <option value="AWAY">{names.AWAY}</option>
        </Select>
      </Field>
    ),
    void: (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="keepStats" className="h-4 w-4" /> Keep the players&apos; statistics from games already played
      </label>
    ),
  };
  return (
    <Card title="League admin" description="Changes are logged, and both teams are told.">
      {correctionsHref && (
        <div className="mb-3">
          <LinkButton variant="secondary" href={correctionsHref}>
            Correct scores
          </LinkButton>
        </div>
      )}
      <div className="divide-y divide-border">
        {ops.map((op) => (
          <details key={op} className="py-2">
            <summary className={`cursor-pointer py-1 font-medium ${LABEL[op].danger ? "text-danger" : ""}`}>{LABEL[op].title}</summary>
            <ActionForm action={adminFixtureAction} submitLabel={LABEL[op].submit} submitVariant={LABEL[op].danger ? "danger" : "primary"} className="mt-2 space-y-3">
              <p className="text-sm text-muted">{LABEL[op].help}</p>
              <input type="hidden" name="fixtureId" value={fixtureId} />
              <input type="hidden" name="op" value={op} />
              {extra[op]}
              <ReasonField id={`${op}-reason`} />
            </ActionForm>
          </details>
        ))}
      </div>
    </Card>
  );
}
