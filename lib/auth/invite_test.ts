// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import { invites, members } from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import {
  acceptInvite,
  createInvite,
  getPendingInvite,
  InviteError,
} from "./invite.ts";
import { verifyPassword } from "./password.ts";

async function withPi(fn: (piId: string) => Promise<string[]>) {
  const db = await getTestDb();
  const [pi] = await db
    .insert(members)
    .values(
      fakeMember({
        email: `invite-test-pi-${crypto.randomUUID()}@studyhub.local`,
        role: "pi",
      }),
    )
    .returning();
  let extraEmails: string[] = [];
  try {
    extraEmails = await fn(pi.id);
  } finally {
    await db.delete(invites).where(eq(invites.invitedBy, pi.id));
    if (extraEmails.length > 0) {
      await db.delete(members).where(inArray(members.email, extraEmails));
    }
    await db.delete(members).where(eq(members.id, pi.id));
    await closeTestDb();
  }
}

Deno.test("invite: create → accept creates the member with invited role", async () => {
  await withPi(async (piId) => {
    const db = await getTestDb();
    const email = `invitee-${crypto.randomUUID()}@studyhub.local`;
    const { token, invite } = await createInvite(db, {
      email: email.toUpperCase(), // normalized on create
      role: "assistant",
      invitedBy: piId,
    });
    assert.equal(invite.email, email);

    const pending = await getPendingInvite(db, token);
    assert.equal(pending?.id, invite.id);

    const member = await acceptInvite(db, {
      token,
      name: "New Assistant",
      password: "a-strong-password",
    });
    assert.equal(member.email, email);
    assert.equal(member.role, "assistant");
    assert.ok(member.passwordHash);
    assert.equal(
      await verifyPassword(member.passwordHash!, "a-strong-password"),
      true,
    );
    return [email];
  });
});

Deno.test("invite: cannot be accepted twice", async () => {
  await withPi(async (piId) => {
    const db = await getTestDb();
    const email = `twice-${crypto.randomUUID()}@studyhub.local`;
    const { token } = await createInvite(db, {
      email,
      role: "researcher",
      invitedBy: piId,
    });
    await acceptInvite(db, { token, name: "A", password: "long-enough-pw" });
    await assert.rejects(
      () => acceptInvite(db, { token, name: "B", password: "long-enough-pw" }),
      InviteError,
    );
    assert.equal(await getPendingInvite(db, token), null);
    return [email];
  });
});

Deno.test("invite: expired invites are not pending and cannot be accepted", async () => {
  await withPi(async (piId) => {
    const db = await getTestDb();
    const past = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const { token } = await createInvite(db, {
      email: `expired-${crypto.randomUUID()}@studyhub.local`,
      role: "collaborator",
      invitedBy: piId,
      now: past,
    });
    assert.equal(await getPendingInvite(db, token), null);
    await assert.rejects(
      () => acceptInvite(db, { token, name: "X", password: "long-enough-pw" }),
      InviteError,
    );
    return [];
  });
});

Deno.test("invite: existing members cannot be re-invited", async () => {
  await withPi(async (piId) => {
    const db = await getTestDb();
    const email = `member-${crypto.randomUUID()}@studyhub.local`;
    await db.insert(members).values(fakeMember({ email }));
    await assert.rejects(
      () => createInvite(db, { email, role: "assistant", invitedBy: piId }),
      InviteError,
    );
    return [email];
  });
});
