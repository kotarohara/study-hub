import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Member, members } from "../db/schema.ts";
import { hashPassword, verifyPassword } from "./password.ts";

// Hash to verify against when the email is unknown, so response timing does
// not reveal whether an account exists.
const DUMMY_HASH = await hashPassword("dummy-password-for-timing");

/** Member on correct credentials; null otherwise (constant-time-ish). */
export async function authenticate(
  db: Db,
  email: string,
  password: string,
): Promise<Member | null> {
  const member = await db.query.members.findFirst({
    where: eq(members.email, email.trim().toLowerCase()),
  });
  const ok = await verifyPassword(
    member?.passwordHash ?? DUMMY_HASH,
    password,
  );
  return ok && member ? member : null;
}
