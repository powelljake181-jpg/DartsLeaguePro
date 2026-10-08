// Run the app against the demo database (.data/demo), seeding it first if it doesn't exist.
//   npm run demo          → next dev on the demo data
//   npm run demo -- prod  → next start (after `npm run build`) on the demo data
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), ".data", "demo");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
if (!existsSync(dir)) {
  const r = spawnSync(npx, ["tsx", "scripts/seed-demo.ts"], { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const prod = process.argv.includes("prod");
const child = spawn(npx, ["next", prod ? "start" : "dev"], { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, PGLITE_DIR: dir } });
child.on("exit", (code) => process.exit(code ?? 0));
