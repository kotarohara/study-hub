// Full local dress rehearsal (spec §8 phase item 5.5): run ONE study
// end-to-end against the compose stack — recruit → consent → schedule →
// remind → collect → compensate → export — asserting the invariants at
// each hop. This is the integration test that proves the phases compose.
import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  type Member,
  members,
  messages,
  participants,
  projects,
  studies,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy, transitionStudy } from "./studies.ts";
import { createInstrument } from "./instruments.ts";
import { configureScreener, submitScreener } from "./screeners.ts";
import { screenerDefinition } from "./screeners.ts";
import { grantApprovedConsent } from "./testing.ts";
import { recordConsent } from "./consents.ts";
import { transitionEnrollment } from "./enrollments.ts";
import { addChannel, getParticipant } from "./participants.ts";
import { bookSession, publishSlot } from "./sessions.ts";
import { notifyBookingConfirmed, sweepDueReminders } from "./notifications.ts";
import { runDueMessages } from "../jobs/message_runner.ts";
import { FakeAdapter } from "../integrations/fake_channel.ts";
import {
  listDatasetsOfStudy,
  listRecords,
  RESPONSES_DATASET,
} from "./datasets.ts";
import { applyProfile } from "../export/profiles.ts";
import {
  approveCompensation,
  createCompensation,
  fmtAmount,
  listOutstanding,
  markCompensationPaid,
} from "./compensations.ts";
import { ledgerRows } from "./ledger.ts";

const HOUR = 3600_000;

Deno.test("dress rehearsal: recruit → consent → schedule → remind → collect → compensate → export", async () => {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [pi] = await db
    .insert(members)
    .values([fakeMember({ email: `dr-${suffix}@studyhub.local`, role: "pi" })])
    .returning();
  const me: Member = pi;
  let enrollmentId: string | undefined;
  try {
    // ---- setup: a project + study with a screener --------------------------
    const project = await createProject(db, {
      name: `dress-${suffix}`,
      createdBy: me,
    });
    let study = await createStudy(db, {
      project,
      name: "Dress Rehearsal Study",
      methodology: "survey",
      createdBy: me,
    });
    await grantApprovedConsent(db, { project, study, author: me, pi: me });
    await db.update(studies).set({ targetN: 1 }).where(
      eq(studies.id, study.id),
    );
    study = { ...study, targetN: 1 };

    const screenerInstrument = await createInstrument(db, {
      name: "Screener",
      kind: "simple_form",
      purpose: "screener",
      content: {
        items: [
          { key: "age", prompt: "Age", type: "number", required: true },
          {
            key: "device",
            prompt: "Device",
            type: "single_choice",
            required: true,
            options: ["phone", "laptop"],
          },
        ],
      },
      createdBy: me,
    });
    const screener = await configureScreener(db, {
      study,
      instrument: screenerInstrument,
      eligibility: [{ item: "age", min: 21, max: 65 }],
      actor: me,
    });
    // A public screener needs the study recruiting; the lifecycle routes
    // through IRB review (draft → irb_review → recruiting).
    study = await transitionStudy(db, { study, to: "irb_review", actor: me });
    study = await transitionStudy(db, { study, to: "recruiting", actor: me });

    // ---- recruit: a public screener submission ----------------------------
    const definition = await screenerDefinition(db, screener);
    const { enrollment, eligible } = await submitScreener(db, {
      screener,
      study,
      definition,
      raw: { age: "34", device: "phone" },
      contact: { name: "Dora Rehearsal", email: "dora@example.com" },
    });
    assert.equal(eligible, true);
    assert.equal(enrollment.status, "eligible");
    enrollmentId = enrollment.id;

    // The screener answers were captured pseudonymously (4.2).
    const participant = (await getParticipant(db, enrollment.participantId))!;
    await addChannel(db, {
      participant,
      channel: { kind: "phone", value: "+65 9111 2222" },
      actor: me,
    });

    // ---- consent ----------------------------------------------------------
    let live = enrollment;
    await recordConsent(db, {
      enrollment: live,
      study,
      participantCode: participant.code,
      signatureName: "Dora Rehearsal",
      consentToRecontact: true,
    });
    live = await transitionEnrollment(db, {
      enrollment: live,
      to: "consented",
      actor: me,
    });
    live = await transitionEnrollment(db, {
      enrollment: live,
      to: "active",
      actor: me,
    });

    // ---- schedule + remind ------------------------------------------------
    const startsAt = new Date(Date.now() + 6 * HOUR); // inside the 24h window
    const slot = await publishSlot(db, {
      study,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR),
      location: "Lab 5",
      actor: me,
    });
    const booked = await bookSession(db, {
      session: slot,
      enrollment: live,
      actor: me,
    });
    await notifyBookingConfirmed(db, booked.id);
    await sweepDueReminders(db); // enqueues a reminder for the 6h session

    // Deliver the queued messages via a fake adapter — proves the job
    // runner drains what the study produced. Assertions are scoped to THIS
    // enrollment (the sweep/runner operate lab-wide) so the test never
    // couples to other suites' data.
    const adapter = new FakeAdapter("email");
    await runDueMessages(db, { adapter });
    const enrollmentMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.enrollmentId, live.id));
    assert.deepEqual(
      enrollmentMessages.map((m) => m.templateKey).sort(),
      ["booking_confirmation", "session_reminder"],
    );
    assert.ok(enrollmentMessages.every((m) => m.status === "sent"));
    assert.ok(
      enrollmentMessages.every((m) => m.recipient === "dora@example.com"),
    );

    // ---- collect: mark the session completed ------------------------------
    // (Data capture already happened at screener submit; the "Responses"
    // dataset holds the pseudonymous record.)
    const responses = (await listDatasetsOfStudy(db, study.id))
      .find((d) => d.dataset.name === RESPONSES_DATASET)!;
    const records = await listRecords(db, responses.dataset.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].participantCode, participant.code);
    assert.deepEqual(records[0].record.data, { age: 34, device: "phone" });

    // ---- compensate -------------------------------------------------------
    const compensation = await approveCompensation(db, {
      compensation: await createCompensation(db, {
        enrollment: live,
        amountCents: 2500,
        method: "paynow",
        scheme: "base",
        createdBy: me,
      }),
      actor: me,
    });
    assert.equal(
      (await listOutstanding(db)).some((r) =>
        r.compensation.id === compensation.id
      ),
      true,
    );
    await markCompensationPaid(db, {
      compensation,
      actor: me,
      reference: "DR-TXN-1",
    });

    // The participant got a payment confirmation.
    const paymentMsg = (await db
      .select()
      .from(messages)
      .where(eq(messages.enrollmentId, live.id)))
      .find((m) => m.templateKey === "payment_confirmation");
    assert.ok(paymentMsg);
    assert.ok(paymentMsg.body.includes(fmtAmount(2500)));

    // The ledger carries name + decrypted phone + amount (PI-only export).
    const ledger = (await ledgerRows(db)).find((r) =>
      r.reference === "DR-TXN-1"
    );
    assert.ok(ledger);
    assert.equal(ledger.name, "Dora Rehearsal");
    assert.equal(ledger.phone, "+65 9111 2222");
    assert.equal(ledger.amountCents, 2500);

    // ---- export: de-identified profile leaks no PII -----------------------
    const deid = applyProfile(records, "de_identified");
    const json = JSON.stringify(deid);
    for (
      const pii of ["Dora Rehearsal", "dora@example.com", participant.code]
    ) {
      assert.ok(!json.includes(pii), `de-identified export leaked ${pii}`);
    }
    assert.deepEqual(deid.columns, [
      "participant",
      "condition",
      "age",
      "device",
    ]);
  } finally {
    if (enrollmentId) {
      await db.delete(messages).where(eq(messages.enrollmentId, enrollmentId));
    }
    await db.delete(projects).where(eq(projects.createdBy, me.id));
    await db.execute(sql`
      delete from participants where source = 'screener' and created_by is null
    `);
    await db.delete(participants).where(eq(participants.createdBy, me.id));
    await db.execute(sql`delete from instruments where created_by = ${me.id}`);
    await db.delete(members).where(inArray(members.id, [me.id]));
    await closeTestDb();
  }
});
