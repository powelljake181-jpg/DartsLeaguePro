"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { requireActor } from "@/lib/session";
import { markRead } from "@/server/notification-service";

/** Mark everything read. Only ever touches the signed-in user's own notifications. */
export async function markAllReadAction(): Promise<void> {
  const { user } = await requireActor();
  await markRead(await getDb(), user.id);
  revalidatePath("/", "layout");
}

/** Open a notification: mark it read, then go where it points (always a path on this site). */
export async function openNotificationAction(fd: FormData): Promise<void> {
  const { user } = await requireActor();
  const id = fd.get("id");
  const href = fd.get("href");
  if (typeof id === "string") await markRead(await getDb(), user.id, [id]);
  revalidatePath("/", "layout");
  redirect(typeof href === "string" && href.startsWith("/") && !href.startsWith("//") ? href : "/notifications");
}
