import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { ActionForm } from "@/components/form";
import { Card, Field, Input, Page, PageHeader } from "@/components/ui";
import { currentUser, safeNext } from "@/lib/session";
import { userCount } from "@/server/auth-service";
import { signInAction } from "../auth-actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const { next } = await props.searchParams;
  if (await currentUser()) redirect(safeNext(next));
  if ((await userCount(await getDb())) === 0) redirect("/setup");
  return (
    <Page narrow>
      <PageHeader title="Sign in" subtitle="For league secretaries and team captains." />
      <Card>
        <ActionForm action={signInAction} submitLabel="Sign in">
          <input type="hidden" name="next" value={typeof next === "string" ? next : ""} />
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </Field>
        </ActionForm>
      </Card>
      <p className="mt-4 text-center text-sm text-muted">No account? Ask your league secretary for an invitation link.</p>
    </Page>
  );
}
