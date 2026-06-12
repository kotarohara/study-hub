// PI-invite flow (spec §3.10): the PI creates an invite for an email+role;
// the invitee follows the tokenized link and sets their name and password,
// which creates the member row. No self-signup path exists.
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Invite, invites, type Member, members } from "../db/schema.ts";
import type { Role } from "./roles.ts";
import { hashPassword } from "./password.ts";
import { generateToken, hashToken } from "./token.ts";

export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export class InviteError extends Error {}

export async function createInvite(
  db: Db,
  opts: { email: string; role: Role; invitedBy: string; now?: Date },
): Promise<{ token: string; invite: Invite }> {
  const now = opts.now ?? new Date();
  const email = opts.email.trim().toLowerCase();

  const existing = await db.query.members.findFirst({
    where: eq(members.email, email),
  });
  if (existing) {
    throw new InviteError(`${email} is already a member`);
  }

  const token = generateToken();
  const [invite] = await db
    .insert(invites)
    .values({
      email,
      role: opts.role,
      tokenHash: hashToken(token),
      invitedBy: opts.invitedBy,
      expiresAt: new Date(now.getTime() + INVITE_TTL_SECONDS * 1000),
    })
    .returning();
  return { token, invite };
}

/** Pending (unaccepted, unexpired) invite for a token, or null. */
export async function getPendingInvite(
  db: Db,
  token: string,
  now = new Date(),
): Promise<Invite | null> {
  const invite = await db.query.invites.findFirst({
    where: and(
      eq(invites.tokenHash, hashToken(token)),
      isNull(invites.acceptedAt),
      gt(invites.expiresAt, now),
    ),
  });
  return invite ?? null;
}

/** Accepts an invite: creates the member and marks the invite used. */
export async function acceptInvite(
  db: Db,
  opts: { token: string; name: string; password: string; now?: Date },
): Promise<Member> {
  const now = opts.now ?? new Date();
  const passwordHash = await hashPassword(opts.password);

  return await db.transaction(async (tx) => {
    // Re-read inside the transaction and claim atomically.
    const [claimed] = await tx
      .update(invites)
      .set({ acceptedAt: now })
      .where(
        and(
          eq(invites.tokenHash, hashToken(opts.token)),
          isNull(invites.acceptedAt),
          gt(invites.expiresAt, now),
        ),
      )
      .returning();
    if (!claimed) {
      throw new InviteError("invite is invalid, expired, or already used");
    }

    const [member] = await tx
      .insert(members)
      .values({
        email: claimed.email,
        name: opts.name.trim(),
        role: claimed.role,
        passwordHash,
      })
      .returning();
    return member;
  });
}
