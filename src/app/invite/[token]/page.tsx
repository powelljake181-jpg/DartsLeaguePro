import type { Metadata } from "next";
import { getDb } from "@/db/client";
import { ActionForm } from "@/components/form";
import { Card, Field, Input, Notice, Page, PageHeader } from "@/components/ui";
import { currentUser } from "@/lib/session";
import { lookupInvitation } from "@/server/invitation-service";
import { acceptInviteAction } from "../../auth-actions";

export const metadata: Metadata = { title: "Invitation", robots: { index: false } };

export default async function InvitePage(props: PageProps<"/invite/[token]">) {
  const { token } = await props.params;
  const invite = await lookupInvitation(await getDb(), token);
  const user = await currentUser();

  if (!invite || invite.state !== "VALID") {
    const why = !invite
      ? "This invitation link isn't valid. Check you copied all of it."
      : invite.state === "USED"
        ? "This invitation has already been used."
        : invite.state === "EXPIRED"
          ? "This invitation has expired."
          : "This invitation has been withdrawn.";
    return (
      <Page narrow>
        <PageHeader title="Invitation" />
        <Notice tone="warning">{why} Ask {invite?.invitedByName ?? "your league secretary"} for a new link.</Notice>
      </Page>
    );
  }

  const role = invite.role === "LEAGUE_ADMIN" ? `a league admin for ${invite.leagueName}` : `team admin for ${invite.teamName} (${invite.leagueName})`;
  return (
    <Page narrow>
      <PageHeader title="You're invited" subtitle={`${invite.invitedByName} has invited you to be ${role}.`} />
      {user ? (
        <Card>
          <p className="mb-4 text-sm">
            Signed in as <strong>{user.name}</strong> ({user.email}).
          </p>
          <ActionForm action={acceptInviteAction} submitLabel="Accept invitation">
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="mode" value="current" />
          </ActionForm>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card title="New here?" description="Create your account to accept.">
            <ActionForm action={acceptInviteAction} submitLabel="Create account and accept">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="mode" value="create" />
              <Field label="Your name" htmlFor="c-name">
                <Input id="c-name" name="name" autoComplete="name" required />
              </Field>
              <Field label="Email" htmlFor="c-email">
                <Input id="c-email" name="email" type="email" autoComplete="email" required />
              </Field>
              <Field label="Password" htmlFor="c-password" hint="At least 10 characters.">
                <Input id="c-password" name="password" type="password" autoComplete="new-password" minLength={10} required />
              </Field>
              <Field label="Password again" htmlFor="c-confirm">
                <Input id="c-confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
              </Field>
            </ActionForm>
          </Card>
          <Card title="Already have an account?">
            <ActionForm action={acceptInviteAction} submitLabel="Sign in and accept" submitVariant="secondary">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="mode" value="signin" />
              <Field label="Email" htmlFor="s-email">
                <Input id="s-email" name="email" type="email" autoComplete="email" required />
              </Field>
              <Field label="Password" htmlFor="s-password">
                <Input id="s-password" name="password" type="password" autoComplete="current-password" required />
              </Field>
            </ActionForm>
          </Card>
        </div>
      )}
    </Page>
  );
}
