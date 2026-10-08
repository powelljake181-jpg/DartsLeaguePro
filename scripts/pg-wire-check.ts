/**
 * Exercise the production database path — the node-postgres driver, SQL
 * migrations, transactions and row locks over the Postgres wire protocol —
 * without installing Postgres: PGlite is served over TCP by `pglite-server`
 * (from @electric-sql/pglite-socket), running as its own process like a real
 * database server.
 *
 *   npm run build && npx tsx scripts/pg-wire-check.ts
 *
 * Steps: start the database server; migrate and seed two demo match nights
 * through DATABASE_URL; start the production server on that database; run
 * the HTTP smoke test against it.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";

const DB_PORT = 54329;
const APP_PORT = 3100;
const url = `postgres://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable`;
const win = process.platform === "win32";
const npx = win ? "npx.cmd" : "npx";
// PGlite has one real connection; the server can multiplex more, but transactions must not interleave.
const env = { ...process.env, DATABASE_URL: url, DATABASE_POOL_MAX: "1", PGSSLMODE: "disable" };

const start = (cmd: string, args: string[], opts: SpawnOptions = {}) => spawn(cmd, args, { stdio: "inherit", shell: win, ...opts });
const finished = (child: ChildProcess) => new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
const kill = (child: ChildProcess) => (win && child.pid ? spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]) : child.kill());

async function waitFor(what: string, check: () => Promise<boolean>, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const ok = await Promise.race([check().catch(() => false), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} didn't come up`);
}

async function main() {
  // One client is active at a time (seed, then server); 2 lets a new one connect while the last disconnects.
  const db = start(npx, ["pglite-server", "--port", String(DB_PORT), "--max-connections", "2"]);
  let app: ChildProcess | null = null;
  try {
    const { Client } = await import("pg");
    await waitFor("database server", async () => {
      const c = new Client({ connectionString: url });
      await c.connect();
      await c.end();
      return true;
    }, 30_000);
    console.log(`Database server on :${DB_PORT}`);

    if ((await finished(start(npx, ["tsx", "scripts/seed-demo.ts", "--nights", "2"], { env: { ...env, DEMO_PASSWORD: "wire-check-password" } }))) !== 0) {
      throw new Error("seeding over the wire failed");
    }
    app = start(npx, ["next", "start", "-p", String(APP_PORT)], { env });
    await waitFor("production server", async () => (await fetch(`http://localhost:${APP_PORT}/api/health`)).ok, 60_000);
    if ((await finished(start(npx, ["tsx", "scripts/e2e-smoke.ts", `http://localhost:${APP_PORT}`]))) !== 0) throw new Error("smoke test failed");
    console.log("\nProduction database path OK.");
    return 0;
  } finally {
    if (app) kill(app);
    kill(db);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
