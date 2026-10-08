/**
 * Seed the Manchester Darts League 2026/27 demo.
 *
 *   npx tsx scripts/seed-demo.ts                 # into .data/demo (PGlite), replacing it
 *   DATABASE_URL=postgres://… npx tsx scripts/seed-demo.ts   # into an EMPTY Postgres database
 *   npx tsx scripts/seed-demo.ts --memory        # dry run in memory (timing / checks)
 *   … --nights 2                                 # play only the first two match nights (quicker)
 *
 * Demo account passwords: DEMO_PASSWORD, or a random one printed at the end
 * (and, for the local copy, saved to the gitignored .data/demo-accounts.json).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/db/client";
import { seedDemo } from "../src/demo/seed";

async function main() {
  const memory = process.argv.includes("--memory");
  const url = process.env.DATABASE_URL;
  const dataDir = path.join(process.cwd(), ".data", "demo");
  if (!memory && !url && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  if (!memory && !url) mkdirSync(path.dirname(dataDir), { recursive: true });
  const db = await openDatabase(memory ? { memory: true } : url ? { url } : { dataDir });
  const started = Date.now();
  const nightsArg = process.argv.indexOf("--nights");
  const maxNights = nightsArg > 0 ? Number(process.argv[nightsArg + 1]) : undefined;
  const r = await seedDemo(db, { password: process.env.DEMO_PASSWORD, maxNights, log: (m) => console.log(`  ${m}`) });
  console.log(`\nSeeded "${r.leagueSlug}": ${r.played} matches, ${r.visits} visits in ${Math.round((Date.now() - started) / 1000)}s.\n`);
  console.table(r.accounts.map(({ role, email, password }) => ({ role, email, password })));
  if (!memory && !url) writeFileSync(path.join(process.cwd(), ".data", "demo-accounts.json"), JSON.stringify(r.accounts, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
