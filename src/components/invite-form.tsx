"use client";

import { createInvitationAction } from "@/app/admin/actions";
import { ActionForm, CopyLink } from "./form";
import { Field, Input, Notice } from "./ui";

/** Create an invitation and show the link to share. */
export function InviteForm({ leagueId, role, teamId, label }: { leagueId: string; role: "LEAGUE_ADMIN" | "TEAM_ADMIN"; teamId?: string; label: string }) {
  return (
    <ActionForm
      action={createInvitationAction}
      submitLabel={label}
      submitVariant="secondary"
      renderSuccess={(s) =>
        s.value && (
          <div className="space-y-2">
            <Notice tone="accent">{s.message}</Notice>
            <CopyLink url={s.value} />
          </div>
        )
      }
    >
      <input type="hidden" name="leagueId" value={leagueId} />
      <input type="hidden" name="role" value={role} />
      {teamId && <input type="hidden" name="teamId" value={teamId} />}
      <Field label="Who is it for? (optional)" htmlFor={`note-${role}-${teamId ?? ""}`} hint="Just a reminder for you, e.g. 'Dave, captain'.">
        <Input id={`note-${role}-${teamId ?? ""}`} name="note" />
      </Field>
    </ActionForm>
  );
}
