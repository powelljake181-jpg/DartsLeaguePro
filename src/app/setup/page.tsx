import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { ActionForm } from "@/components/form";
import { Card, Field, Input, Page, PageHeader } from "@/components/ui";
import { userCount } from "@/server/auth-service";
import { setupAction } from "../auth-actions";

export const metadata: Metadata = { title: "Set up" };

/** First run only: create the platform administrator. */
export default async function SetupPage() {
  if ((await userCount(await getDb())) > 0) redirect("/login");
  return (
    <Page narrow>
      <PageHeader title="Set up" subtitle="Create the administrator account for this site. You can then create leagues and invite their secretaries." />
      <Card>
        <ActionForm action={setupAction} submitLabel="Create administrator">
          <Field label="Your name" htmlFor="name">
            <Input id="name" name="name" autoComplete="name" required />
          </Field>
          <Field label="Email" htmlFor="email">
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label="Password" htmlFor="password" hint="At least 10 characters.">
            <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
        </ActionForm>
      </Card>
    </Page>
  );
}
