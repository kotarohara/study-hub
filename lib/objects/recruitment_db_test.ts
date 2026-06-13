// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  type Member,
  members,
  participants,
  type Project,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import {
  addChannel,
  createParticipant,
  setDoNotContact,
  setPreferredChannel,
} from "./participants.ts";
import { createEnrollment, transitionEnrollment } from "./enrollments.ts";
import { grantApprovedConsent } from "./testing.ts";
import { recordConsent } from "./consents.ts";
import { bulkInvite, filterPool } from "./recruitment.ts";

async function withEnv(
  fn: (env: {
    pi: Member;
    researcher: Member;
    project: Project;
    oldStudy: Study;
    newStudy: Study;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [pi, researcher] = await db
    .insert(members)
    .values([
      fakeMember({ email: `rec-pi-${suffix}@studyhub.local`, role: "pi" }),
      fakeMember({ email: `rec-res-${suffix}@studyhub.local` }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `rec-test-${suffix}`,
    createdBy: researcher,
  });
  const oldStudy = await createStudy(db, {
    project,
    name: "Earlier study",
    methodology: "survey",
    createdBy: researcher,
  });
  const newStudy = await createStudy(db, {
    project,
    name: "Follow-up study",
    methodology: "interview",
    createdBy: researcher,
  });
  try {
    await fn({ pi, researcher, project, oldStudy, newStudy });
  } finally {
    await db.delete(projects).where(eq(projects.createdBy, researcher.id));
    await db
      .delete(participants)
      .where(eq(participants.createdBy, researcher.id));
    await db
      .delete(members)
      .where(inArray(members.id, [pi.id, researcher.id]));
    await closeTestDb();
  }
}

Deno.test("filterPool + bulkInvite: recontact guard, exclusions, run sheet", async () => {
  await withEnv(async ({ pi, researcher, project, oldStudy, newStudy }) => {
    const db = await getTestDb();
    await grantApprovedConsent(db, {
      project,
      study: oldStudy,
      author: researcher,
      pi,
    });

    // Ada: completed the earlier study, consented WITH recontact,
    // telegram preferred over the earlier email channel.
    const ada = await createParticipant(db, {
      name: "Ada Recruit",
      gender: "female",
      yearOfBirth: 1990,
      channels: [{ kind: "email", value: "ada@example.com" }],
      createdBy: researcher,
    });
    const adaTelegram = await addChannel(db, {
      participant: ada,
      channel: { kind: "telegram", value: "@ada" },
      actor: researcher,
    });
    await setPreferredChannel(db, {
      participant: ada,
      channelId: adaTelegram.id,
    });
    let adaEnr = await createEnrollment(db, {
      study: oldStudy,
      participant: ada,
      actor: researcher,
    });
    adaEnr = await transitionEnrollment(db, {
      enrollment: adaEnr,
      to: "eligible",
      actor: researcher,
    });
    await recordConsent(db, {
      enrollment: adaEnr,
      study: oldStudy,
      participantCode: ada.code,
      signatureName: "Ada Recruit",
      consentToRecontact: true,
    });

    // Ben: consented but said NO to recontact.
    const ben = await createParticipant(db, {
      name: "Ben Recruit",
      gender: "male",
      channels: [{ kind: "email", value: "ben@example.com" }],
      createdBy: researcher,
    });
    let benEnr = await createEnrollment(db, {
      study: oldStudy,
      participant: ben,
      actor: researcher,
    });
    benEnr = await transitionEnrollment(db, {
      enrollment: benEnr,
      to: "eligible",
      actor: researcher,
    });
    await recordConsent(db, {
      enrollment: benEnr,
      study: oldStudy,
      participantCode: ben.code,
      signatureName: "Ben Recruit",
      consentToRecontact: false,
    });

    // Cay: fresh pool entry, never consented to anything.
    const cay = await createParticipant(db, {
      name: "Cay Recruit",
      gender: "female",
      channels: [{ kind: "email", value: "cay@example.com" }],
      createdBy: researcher,
    });
    // Dee: matches demographics but is do-not-contact.
    const dee = await createParticipant(db, {
      name: "Dee Recruit",
      gender: "female",
      createdBy: researcher,
    });
    await setDoNotContact(db, {
      participant: dee,
      doNotContact: true,
      actor: researcher,
    });
    // Eve: already enrolled in the follow-up study.
    const eve = await createParticipant(db, {
      name: "Eve Recruit",
      gender: "female",
      createdBy: researcher,
    });
    await createEnrollment(db, {
      study: newStudy,
      participant: eve,
      actor: researcher,
    });

    // Recontact required (the default): only Ada qualifies.
    const strict = await filterPool(db, newStudy, { requireRecontact: true });
    assert.deepEqual(
      strict.map((m) => m.participant.code),
      [ada.code],
    );
    assert.equal(strict[0].recontactOk, true);
    // Preferred channel wins over the older email.
    assert.equal(strict[0].channel?.kind, "telegram");

    // Without the recontact guard: Ada, Ben and Cay — never Dee (DNC)
    // or Eve (already enrolled).
    const loose = await filterPool(db, newStudy, { requireRecontact: false });
    assert.deepEqual(
      loose.map((m) => m.participant.code).toSorted(),
      [ada.code, ben.code, cay.code].toSorted(),
    );

    // Demographic filters narrow further.
    const women = await filterPool(db, newStudy, {
      requireRecontact: false,
      gender: "female",
      minBirthYear: 1985,
    });
    assert.deepEqual(
      women.map((m) => m.participant.code),
      [ada.code],
    );

    // Bulk invite: Ada and Cay enrolled; Eve (stale selection) skipped.
    const result = await bulkInvite(db, {
      study: newStudy,
      participantIds: [ada.id, cay.id, eve.id],
      actor: researcher,
    });
    assert.deepEqual(
      result.invited.map((row) => row.participant.code).toSorted(),
      [ada.code, cay.code].toSorted(),
    );
    assert.equal(result.invited.length, 2);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /already enrolled/);

    // Invitees are now excluded from further filtering.
    assert.equal(
      (await filterPool(db, newStudy, { requireRecontact: false })).length,
      1, // only Ben remains
    );

    // One summary audit event with codes only — no PII.
    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, newStudy.id));
    const [summary] = events.filter(
      (e) => e.action === "recruitment.bulk_invited",
    );
    assert.ok(summary);
    assert.equal(summary.details?.invited, 2);
    assert.equal(summary.details?.skipped, 1);
    assert.ok(!JSON.stringify(summary.details).includes("Ada"));
  });
});
