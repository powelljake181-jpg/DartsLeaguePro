/**
 * End-to-end smoke test over HTTP against a running server (ideally a
 * production build on the demo data):
 *
 *   npm run build && npm run demo -- prod      # in one terminal
 *   npm run e2e [-- http://localhost:3000]     # in another
 *
 * Crawls the public site from the home page — every league tab, then a sample
 * of the division, cup, team, player and match pages it links to — and checks
 * status codes, that pages render without errors, that bad links 404, that the
 * admin area needs a sign-in, and that a live match streams updates.
 */

const base = (process.argv[2] ?? process.env.E2E_URL ?? "http://localhost:3000").replace(/\/$/, "");
let failures = 0;
let passes = 0;

function check(ok: boolean, what: string) {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${what}`);
}

async function get(path: string, opts: { status?: number; contains?: string[] } = {}) {
  const res = await fetch(base + path, { redirect: "manual" });
  const body = res.status < 300 ? await res.text() : "";
  const want = opts.status ?? 200;
  const errorPage = /Application error|Internal Server Error|Unhandled Runtime Error/.test(body);
  const missing = (opts.contains ?? []).filter((s) => !body.includes(s));
  check(res.status === want && !errorPage && missing.length === 0, `${path} → ${res.status}${errorPage ? " (error page)" : ""}${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
  return { res, body };
}

const links = (html: string, pattern: RegExp) => [...new Set([...html.matchAll(pattern)].map((m) => m[1]))];

async function main() {
  console.log(`Smoke-testing ${base}\n`);
  const health = await get("/api/health");
  check(health.body.includes('"ok":true'), "health check reports the database is reachable");

  const home = await get("/", { contains: ["Leagues"] });
  const leagueLinks = links(home.body, /href="(\/leagues\/[a-z0-9-]+)"/g);
  check(leagueLinks.length > 0, `home page lists leagues (${leagueLinks.length})`);
  const league = leagueLinks[0];

  const overview = await get(league, { contains: ["Coming up", "Latest results"] });
  const pages: Record<string, string> = {};
  for (const tab of ["tables", "fixtures", "results", "leaderboards", "teams"]) pages[tab] = (await get(`${league}/${tab}`)).body;
  check(pages.leaderboards.includes("Average"), "leaderboards show averages");

  const sample = <T>(xs: T[], n: number) => xs.slice(0, n);
  const all = Object.values(pages).join("") + overview.body;
  const divisions = links(all, new RegExp(`href="(${league}/divisions/[0-9a-f-]{36})`, "g"));
  const teams = links(all, new RegExp(`href="(${league}/teams/[a-z0-9-]+)"`, "g"));
  const matches = links(all, /href="(\/fixtures\/[0-9a-f-]{36})"/g);
  check(divisions.length >= 2, `division and cup pages linked (${divisions.length})`);
  check(teams.length >= 8, `team pages linked (${teams.length})`);
  check(matches.length >= 10, `match pages linked (${matches.length})`);
  let playerPages: string[] = [];
  for (const d of divisions) await get(d);
  for (const t of sample(teams, 6)) playerPages.push(...links((await get(t, { contains: ["Squad"] })).body, new RegExp(`href="(${league}/players/[0-9a-f-]{36})"`, "g")));
  playerPages = [...new Set(playerPages)];
  check(playerPages.length > 0, `player pages linked (${playerPages.length})`);
  for (const p of sample(playerPages, 8)) await get(p, { contains: ["By season", "Games"] });
  for (const m of sample(matches, 8)) await get(m);

  // A live match streams its state to spectators.
  const liveLink = links(overview.body.split("Coming up")[0], /href="(\/fixtures\/[0-9a-f-]{36})"/g)[0];
  if (liveLink && overview.body.includes("Live now")) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${base}/api${liveLink}/stream`, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      let text = "";
      // Events can arrive in several chunks: read until the first snapshot.
      while (!text.includes("event: snapshot")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      check(res.headers.get("content-type")?.includes("text/event-stream") === true && text.includes("event: snapshot") && text.includes('"fixtureId"'), "live match streams a snapshot");
    } catch (e) {
      check(false, `live match stream (${(e as Error).message})`);
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  } else {
    console.log("  skip  no live match to stream");
  }

  // Bad links are 404s, never errors; the admin area needs a sign-in.
  await get("/leagues/no-such-league", { status: 404 });
  await get(`${league}/players/not-a-player`, { status: 404 });
  await get(`${league}/teams/no-such-team`, { status: 404 });
  await get(`${league}/divisions/00000000-0000-0000-0000-000000000000`, { status: 404 });
  const admin = await fetch(`${base}/admin`, { redirect: "manual" });
  check([303, 307, 308].includes(admin.status) && (admin.headers.get("location") ?? "").includes("/login"), `/admin redirects to sign-in (${admin.status})`);
  await get("/login", { contains: ["Sign in"] });
  const cron = await fetch(`${base}/api/notifications/deliver`, { method: "POST" });
  check(cron.status === 401, `notification delivery endpoint refuses callers without the secret (${cron.status})`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
