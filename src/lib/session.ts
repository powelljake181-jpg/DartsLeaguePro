import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db/client";
import type { Actor } from "@/domain/permissions";
import { createSession, endSession, resolveSession, type SessionUser } from "@/server/auth-service";
import { loadActor } from "@/server/context";

/**
 * Session cookie handling for the Next.js layer. All authorisation decisions
 * are made by the services; this only identifies who is asking.
 */

const COOKIE = "dl_session";

/** The signed-in user, or null. Memoised per request. */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  return resolveSession(await getDb(), token);
});

/** The signed-in user and their grants; redirects to sign-in if there is no session. */
export const requireActor = cache(async (): Promise<{ user: SessionUser; actor: Actor }> => {
  const user = await currentUser();
  if (!user) redirect("/login");
  return { user, actor: await loadActor(await getDb(), user.id) };
});

/** Start a session (server actions / route handlers only). */
export async function signIn(userId: string): Promise<void> {
  const ua = (await headers()).get("user-agent");
  const { token, expiresAt } = await createSession(await getDb(), userId, ua?.slice(0, 300) ?? null);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  await endSession(await getDb(), store.get(COOKIE)?.value);
  store.delete(COOKIE);
}

/** Only allow redirects back into this site after sign-in. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/admin";
}
