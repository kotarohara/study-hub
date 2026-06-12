// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  type Member,
  members,
  type Participant,
  participants,
  type Project,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { isEncrypted } from "../crypto/encryption.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { createParticipant } from "./participants.ts";
import {
  createEnrollment,
  getEnrollment,
  transitionEnrollment,
} from "./enrollments.ts";
import {
  addVersion,
  listDocumentsOfStudy,
  transitionDocument,
} from "./documents.ts";
import { grantApprovedConsent } from "./testing.ts";
import {
  ConsentError,
  consentLinkFor,
  consentStatusOfStudy,
  getConsentState,
  listConsents,
  recordConsent,
  verifyConsentToken,
} from "./consents.ts";

async function withEnv(
  fn: (env: {
    pi: Member;
    researcher: Member;
    project: Project;
    study: Study;
    alice: Participant;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [pi, researcher] = await db
    .insert(members)
    .values([
      fakeMember({ email: `con-pi-${suffix}@studyhub.local`, role: "pi" }),
      fakeMember({ email: `con-res-${suffix}@studyhub.local` }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `con-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Consent host study",
    methodology: "survey",
    createdBy: researcher,
  });
  const alice = await createParticipant(db, {
    name: "Alice Consent",
    createdBy: researcher,
  });
  try {
    await fn({ pi, researcher, project, study, alice });
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

Deno.test("magic link: purpose-scoped roundtrip to the enrollment", async () => {
  await withEnv(async ({ researcher, study, alice }) => {
    const db = await getTestDb();
    const enrollment = await createEnrollment(db, {
      study,
      participant: alice,
      actor: researcher,
    });
    const link = consentLinkFor(enrollment);
    const token = link.split("/p/")[1].replace("/consent", "");
    assert.equal(verifyConsentToken(token), enrollment.id);
    // Tampered tokens resolve to null, not an exception.
    assert.equal(verifyConsentToken(token.slice(0, -2)), null);
    assert.equal(verifyConsentToken(""), null);
  });
});

Deno.test("consent: signs current version, advances enrollment, encrypted + audited", async () => {
  await withEnv(async ({ pi, researcher, project, study, alice }) => {
    const db = await getTestDb();
    let enrollment = await createEnrollment(db, {
      study,
      participant: alice,
      actor: researcher,
    });
    enrollment = await transitionEnrollment(db, {
      enrollment,
      to: "eligible",
      actor: researcher,
    });

    // No approved consent document yet.
    let state = await getConsentState(db, { enrollment, study });
    assert.equal(state.status, "no_document");
    await assert.rejects(
      () =>
        recordConsent(db, {
          enrollment,
          study,
          participantCode: alice.code,
          signatureName: "Alice Consent",
          consentToRecontact: true,
        }),
      /no approved consent form/,
    );

    await grantApprovedConsent(db, { project, study, author: researcher, pi });
    state = await getConsentState(db, { enrollment, study });
    assert.equal(state.status, "none");

    // Signature required.
    await assert.rejects(
      () =>
        recordConsent(db, {
          enrollment,
          study,
          participantCode: alice.code,
          signatureName: "  ",
          consentToRecontact: false,
        }),
      ConsentError,
    );

    const consent = await recordConsent(db, {
      enrollment,
      study,
      participantCode: alice.code,
      signatureName: "Alice Consent",
      consentToRecontact: true,
    });
    assert.equal(consent.documentVersionNumber, 1);
    assert.equal(consent.consentToRecontact, true);

    // eligible → consented happened in the same transaction.
    const after = await getEnrollment(db, enrollment.id);
    assert.equal(after?.status, "consented");

    // Signature is ciphertext at rest.
    const raw = await db.execute<{ signature_name: string }>(
      sql`select signature_name from consents where id = ${consent.id}`,
    );
    assert.ok(isEncrypted(raw[0].signature_name));
    assert.ok(!raw[0].signature_name.includes("Alice"));

    // Double-signing the same version is refused.
    await assert.rejects(
      () =>
        recordConsent(db, {
          enrollment: after!,
          study,
          participantCode: alice.code,
          signatureName: "Alice Consent",
          consentToRecontact: true,
        }),
      /already been signed/,
    );

    // Audited with no member actor and no PII.
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, enrollment.id));
    const given = entries.find((e) => e.action === "consent.given");
    assert.ok(given);
    assert.equal(given.actorId, null);
    assert.equal(given.details?.recontact, true);
    const statusChange = entries.find(
      (e) =>
        e.action === "enrollment.status_changed" &&
        e.details?.via === "consent_page",
    );
    assert.ok(statusChange);
    for (const e of entries) {
      assert.ok(!JSON.stringify(e.details).includes("Alice"));
    }
  });
});

Deno.test("amendment: approved new version outdates consents, re-consent records anew", async () => {
  await withEnv(async ({ pi, researcher, project, study, alice }) => {
    const db = await getTestDb();
    await grantApprovedConsent(db, { project, study, author: researcher, pi });
    let enrollment = await createEnrollment(db, {
      study,
      participant: alice,
      actor: researcher,
    });
    enrollment = await transitionEnrollment(db, {
      enrollment,
      to: "eligible",
      actor: researcher,
    });
    await recordConsent(db, {
      enrollment,
      study,
      participantCode: alice.code,
      signatureName: "Alice Consent",
      consentToRecontact: false,
    });
    enrollment = (await getEnrollment(db, enrollment.id))!;

    // Amend the consent form: new version, re-reviewed, approved.
    let [doc] = await listDocumentsOfStudy(db, study.id);
    doc = await addVersion(db, {
      document: doc,
      version: {
        content: "You agree to participate. Now with a diary component.",
        changeRationale: "Added diary component (amendment).",
      },
      actor: researcher,
    });
    doc = await transitionDocument(db, {
      document: doc,
      to: "submitted",
      actor: researcher,
    });
    await transitionDocument(db, { document: doc, to: "approved", actor: pi });

    const state = await getConsentState(db, { enrollment, study });
    assert.equal(state.status, "outdated");

    // Re-consent (enrollment already consented; status does not regress).
    const second = await recordConsent(db, {
      enrollment,
      study,
      participantCode: alice.code,
      signatureName: "Alice Consent",
      consentToRecontact: true,
    });
    assert.equal(second.documentVersionNumber, 2);
    assert.equal((await getEnrollment(db, enrollment.id))?.status, "consented");
    assert.equal(
      (await getConsentState(db, { enrollment, study })).status,
      "current",
    );

    // History is immutable: both rows remain.
    const history = await listConsents(db, enrollment.id);
    assert.deepEqual(
      history.map((c) => c.documentVersionNumber).toSorted(),
      [1, 2],
    );

    // The re-consent audit event says so.
    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, enrollment.id));
    const reconsents = events.filter(
      (e) => e.action === "consent.given" && e.details?.reconsent === true,
    );
    assert.equal(reconsents.length, 1);

    // Batch status helper agrees.
    const map = await consentStatusOfStudy(db, study, [enrollment]);
    assert.equal(map.get(enrollment.id), "current");
  });
});
