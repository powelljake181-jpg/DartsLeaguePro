import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { and, count, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { authFailures, sessions, users } from "@/db/schema";
import { AppError } from "./errors";

/**
 * Accounts and sessions. Framework-agnostic: the Next.js layer only moves the
 * session token in and out of a cookie.
 *
 * - Passwords: scrypt with a per-user salt, compared in constant time.
 * - Sessions: a random 256-bit token in an httpOnly cookie; the database stores
 *   only its SHA-256 hash, so a database leak does not leak live sessions.
 * - Guessing: after MAX_FAILURES failed sign-ins for an email within
 *   FAILURE_WINDOW_MS, further attempts are refused until the window passes.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64 };

export const emailSchema = z.string().trim().toLowerCase().email("enter a valid email address");
export const passwordSchema = z.string().min(10, "use at least 10 characters").max(200);
export const nameSchema = z.string().trim().min(1, "enter your name").max(100);

const scrypt = (password: string, salt: Buffer, opts: ScryptOptions & { keylen: number }) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: 256 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), { N: Number(n), r: Number(r), p: Number(p), keylen: expected.length });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
}

const toSessionUser = (u: typeof users.$inferSelect): SessionUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  isPlatformAdmin: u.isPlatformAdmin,
});

export async function userCount(db: Db): Promise<number> {
  const [{ n }] = await db.select({ n: count() }).from(users);
  return n;
}

export interface NewAccount {
  email: string;
  name: string;
  password: string;
}

function parseAccount(input: NewAccount) {
  const parsed = z.object({ email: emailSchema, name: nameSchema, password: passwordSchema }).safeParse(input);
  if (!parsed.success) throw new AppError("INVALID_ACCOUNT", parsed.error.issues[0].message, 422);
  return parsed.data;
}

export async function createAccount(db: Db, input: NewAccount, opts: { platformAdmin?: boolean } = {}): Promise<SessionUser> {
  const a = parseAccount(input);
  const [existing] = await db.select().from(users).where(eq(users.email, a.email));
  if (existing) throw new AppError("EMAIL_TAKEN", "an account with that email already exists; sign in instead", 409);
  const [user] = await db
    .insert(users)
    .values({
      id: `u_${newToken().slice(0, 22)}`,
      email: a.email,
      name: a.name,
      passwordHash: await hashPassword(a.password),
      isPlatformAdmin: !!opts.platformAdmin,
    })
    .returning();
  return toSessionUser(user);
}

/** First-run setup: create the platform admin. Refused once any account exists. */
export async function createFirstPlatformAdmin(db: Db, input: NewAccount): Promise<SessionUser> {
  return db.transaction(async (tx) => {
    // Serialise concurrent setup attempts.
    await tx.execute(sql`lock table ${users} in exclusive mode`);
    if ((await userCount(tx)) > 0) throw new AppError("ALREADY_SET_UP", "this site has already been set up", 409);
    return createAccount(tx, input, { platformAdmin: true });
  });
}

export async function authenticate(db: Db, emailInput: string, password: string, now = new Date()): Promise<SessionUser> {
  const email = emailSchema.safeParse(emailInput).success ? emailSchema.parse(emailInput) : emailInput.trim().toLowerCase();
  const since = new Date(now.getTime() - FAILURE_WINDOW_MS);
  const [{ failures }] = await db
    .select({ failures: count() })
    .from(authFailures)
    .where(and(eq(authFailures.email, email), gt(authFailures.createdAt, since)));
  if (failures >= MAX_FAILURES) {
    throw new AppError("TOO_MANY_ATTEMPTS", "too many failed attempts; wait 15 minutes and try again", 429);
  }
  const [user] = await db.select().from(users).where(eq(users.email, email));
  // Always run a hash comparison so response time does not reveal whether the email exists.
  const ok = user?.passwordHash
    ? await verifyPassword(password, user.passwordHash)
    : (await verifyPassword(password, DUMMY_HASH), false);
  if (!user || !ok) {
    await db.insert(authFailures).values({ email, createdAt: now });
    throw new AppError("BAD_CREDENTIALS", "that email and password don't match", 401);
  }
  await db.delete(authFailures).where(eq(authFailures.email, email));
  return toSessionUser(user);
}
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export async function createSession(db: Db, userId: string, userAgent: string | null, now = new Date()) {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt, createdAt: now, lastSeenAt: now, userAgent });
  return { token, expiresAt };
}

/** The signed-in user for a session token, or null. Extends the session when it is used. */
export async function resolveSession(db: Db, token: string | undefined, now = new Date()): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sha256(token)));
  const row = rows[0];
  if (!row) return null;
  if (row.session.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, row.session.id));
    return null;
  }
  if (now.getTime() - row.session.lastSeenAt.getTime() > SESSION_REFRESH_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
      .where(eq(sessions.id, row.session.id));
  }
  return toSessionUser(row.user);
}

export async function endSession(db: Db, token: string | undefined): Promise<void> {
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

/** Housekeeping: drop expired sessions and old failure records. */
export async function pruneAuth(db: Db, now = new Date()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db.delete(authFailures).where(lt(authFailures.createdAt, new Date(now.getTime() - FAILURE_WINDOW_MS)));
}
