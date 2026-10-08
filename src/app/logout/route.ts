import { signOut } from "@/lib/session";

/**
 * Sign out. A plain POST route (not a server action) so it also works from
 * error and not-found pages. Same-origin only.
 */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return new Response("Forbidden", { status: 403 });
  }
  await signOut();
  return new Response(null, { status: 303, headers: { Location: "/" } });
}
