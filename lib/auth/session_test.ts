// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import { members, sessions } from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionMember,
  pruneExpiredSessions,
  readSessionCookie,
  SESSION_COOKIE,
  sessionCookie,
} from "./session.ts";

async function withMember(
  fn: (memberId: string, email: string) => Promise<void>,
) {
  const db = await getTestDb();
  const input = fakeMember({
    email: `session-test-${crypto.randomUUID()}@studyhub.local`,
  });
  const [member] = await db.insert(members).values(input).returning();
  try {
    await fn(member.id, member.email);
  } finally {
    await db.delete(members).where(eq(members.id, member.id));
    await closeTestDb();
  }
}

Deno.test("session: create → resolve → destroy", async () => {
  await withMember(async (memberId, email) => {
    const db = await getTestDb();
    const { token, expiresAt } = await createSession(db, memberId);
    assert.ok(expiresAt > new Date());

    const resolved = await getSessionMember(db, token);
    assert.equal(resolved?.email, email);

    await destroySession(db, token);
    assert.equal(await getSessionMember(db, token), null);
  });
});

Deno.test("session: raw token is never stored", async () => {
  await withMember(async (memberId) => {
    const db = await getTestDb();
    const { token } = await createSession(db, memberId);
    const rows = await db
      .select({ tokenHash: sessions.tokenHash })
      .from(sessions)
      .where(eq(sessions.memberId, memberId));
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].tokenHash, token);
    const byRawToken = await db
      .select()
      .from(sessions)
      .where(like(sessions.tokenHash, token));
    assert.equal(byRawToken.length, 0);
    await destroySession(db, token);
  });
});

Deno.test("session: expired sessions do not resolve and get pruned", async () => {
  await withMember(async (memberId) => {
    const db = await getTestDb();
    const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
    const { token } = await createSession(db, memberId, past);
    assert.equal(await getSessionMember(db, token), null);

    const pruned = await pruneExpiredSessions(db);
    assert.ok(pruned >= 1);
    assert.equal(await getSessionMember(db, token), null);
  });
});

Deno.test("session: invalid token resolves to null", async () => {
  const db = await getTestDb();
  assert.equal(await getSessionMember(db, "no-such-token"), null);
  await closeTestDb();
});

Deno.test("cookie helpers", () => {
  const expires = new Date("2026-07-01T00:00:00Z");
  const prod = sessionCookie("tok123", expires, { secure: true });
  assert.ok(prod.includes(`${SESSION_COOKIE}=tok123`));
  assert.ok(prod.includes("HttpOnly"));
  assert.ok(prod.includes("SameSite=Lax"));
  assert.ok(prod.includes("Secure"));
  const dev = sessionCookie("tok123", expires, { secure: false });
  assert.ok(!dev.includes("Secure"));

  const req = new Request("http://x/", {
    headers: { cookie: `a=1; ${SESSION_COOKIE}=tok123; b=2` },
  });
  assert.equal(readSessionCookie(req), "tok123");
  assert.equal(readSessionCookie(new Request("http://x/")), null);

  assert.ok(clearSessionCookie({ secure: false }).includes("1970"));
});
