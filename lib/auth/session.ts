import { and, eq, gt, lt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Member, members, sessions } from "../db/schema.ts";
import { generateToken, hashToken } from "./token.ts";

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const SESSION_COOKIE = "sh_session";

export async function createSession(
  db: Db,
  memberId: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    memberId,
    expiresAt,
  });
  return { token, expiresAt };
}

/** Member for a valid, unexpired session token; null otherwise. */
export async function getSessionMember(
  db: Db,
  token: string,
  now = new Date(),
): Promise<Member | null> {
  const [row] = await db
    .select({ member: members })
    .from(sessions)
    .innerJoin(members, eq(sessions.memberId, members.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, now),
      ),
    );
  return row?.member ?? null;
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Destroys every session of a member ("sign out everywhere"). */
export async function destroyMemberSessions(
  db: Db,
  memberId: string,
): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.memberId, memberId))
    .returning({ id: sessions.id });
  return deleted.length;
}

/** Removes expired sessions; returns the number deleted. Run periodically. */
export async function pruneExpiredSessions(
  db: Db,
  now = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return deleted.length;
}

export function sessionCookie(
  token: string,
  expiresAt: Date,
  opts: { secure: boolean },
): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(opts: { secure: boolean }): string {
  return [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}
