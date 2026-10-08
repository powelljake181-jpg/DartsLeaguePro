"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { attempt, str, type FormState } from "@/lib/action";
import { currentUser, safeNext, signIn } from "@/lib/session";
import { authenticate, createAccount, createFirstPlatformAdmin } from "@/server/auth-service";
import { acceptInvitation } from "@/server/invitation-service";

export async function signInAction(_: FormState, fd: FormData): Promise<FormState> {
  const db = await getDb();
  const r = await attempt(() => authenticate(db, str(fd, "email"), str(fd, "password")));
  if (!r.ok) return { error: r.error };
  await signIn(r.value.id);
  redirect(safeNext(str(fd, "next")));
}

export async function setupAction(_: FormState, fd: FormData): Promise<FormState> {
  const db = await getDb();
  const r = await attempt(() =>
    createFirstPlatformAdmin(db, { email: str(fd, "email"), name: str(fd, "name"), password: str(fd, "password") }),
  );
  if (!r.ok) return { error: r.error };
  await signIn(r.value.id);
  redirect("/admin");
}

/** Accept an invitation, signing in with an existing account or creating one first. */
export async function acceptInviteAction(_: FormState, fd: FormData): Promise<FormState> {
  const db = await getDb();
  const token = str(fd, "token");
  const mode = str(fd, "mode");
  let userId: string;

  if (mode === "signin") {
    const r = await attempt(() => authenticate(db, str(fd, "email"), str(fd, "password")));
    if (!r.ok) return { error: r.error };
    userId = r.value.id;
  } else if (mode === "create") {
    if (str(fd, "password") !== str(fd, "confirm")) return { error: "The two passwords don't match." };
    const r = await attempt(() => createAccount(db, { email: str(fd, "email"), name: str(fd, "name"), password: str(fd, "password") }));
    if (!r.ok) return { error: r.error };
    userId = r.value.id;
  } else {
    // Already signed in: the user id comes from the session, never the form.
    const me = await currentUser();
    if (!me) return { error: "Your session has ended. Sign in again." };
    userId = me.id;
  }

  const accepted = await attempt(() => acceptInvitation(db, userId, token));
  if (!accepted.ok) return { error: accepted.error };
  if (mode === "signin" || mode === "create") await signIn(userId);
  redirect("/admin");
}
