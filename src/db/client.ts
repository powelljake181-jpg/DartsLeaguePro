import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import path from "node:path";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Database access. With DATABASE_URL set, connects to PostgreSQL (production).
 * Without it, runs PGlite — real Postgres in-process — persisted to .data/pglite
 * (or PGLITE_DIR, e.g. .data/demo) for local development, or in memory for tests.
 */

const MIGRATIONS = path.join(process.cwd(), "drizzle");

/** The database or a transaction; both drivers share this base type, so services accept either. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export async function openDatabase(opts: { url?: string; dataDir?: string; memory?: boolean } = {}): Promise<Db> {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (url && !opts.memory) {
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX) || 10,
      // Don't hang a request forever on a database that has gone away.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
    });
    // A dropped idle connection (database restart, maintenance) must not crash the
    // server: log it; the pool discards that client and opens a new one when needed.
    pool.on("error", (e) => console.error("[db] idle connection error:", e.message));
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder: MIGRATIONS });
    return db as unknown as Db;
  }
  const dir = opts.dataDir ?? process.env.PGLITE_DIR ?? path.join(process.cwd(), ".data", "pglite");
  const client = opts.memory ? new PGlite() : new PGlite(dir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return db as unknown as Db;
}

/** A fresh, migrated, in-memory database for tests. */
export const openTestDatabase = () => openDatabase({ memory: true });

/**
 * The application's database, opened once per process. Kept on globalThis so
 * dev-server hot reloads reuse it (a PGlite data directory can only be open once).
 */
export function getDb(): Promise<Db> {
  const g = globalThis as unknown as { __dartsDb?: Promise<Db> };
  g.__dartsDb ??= openDatabase();
  return g.__dartsDb;
}
