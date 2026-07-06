// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  type Enrollment,
  type Member,
  members,
  messages,
  type Participant,
  participants,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { createParticipant } from "./participants.ts";
import { createEnrollment } from "./enrollments.ts";
import {
  approveCompensation,
  CompensationError,
  createCompensation,
  fmtAmount,
  listApprovedByMethod,
  listOutstanding,
  markBatchPaid,
  markCompensationPaid,
  outstandingTotals,
} from "./compensations.ts";
import { addChannel } from "./participants.ts";
import { ledgerRows, runSheet } from "./ledger.ts";

interface Env {
  db: Awaited<ReturnType<typeof getTestDb>>;
  member: Member;
  study: Study;
  participant: Participant;
  enrollment: Enrollment;
}

async function withEnv(fn: (env: Env) => Promise<void>) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [member] = await db
    .insert(members)
    .values([fakeMember({ email: `pay-${suffix}@studyhub.local` })])
    .returning();
  const project = await createProject(db, {
    name: `pay-${suffix}`,
    createdBy: member,
  });
  const study = await createStudy(db, {
    project,
    name: "Pay Study",
    methodology: "survey",
    createdBy: member,
  });
  const participant = await createParticipant(db, {
    name: "Ada Pay",
    createdBy: member,
  });
  const enrollment = await createEnrollment(db, {
    study,
    participant,
    actor: member,
  });
  try {
    await fn({ db, member, study, participant, enrollment });
  } finally {
    await db.delete(messages).where(eq(messages.enrollmentId, enrollment.id));
    await db.delete(projects).where(eq(projects.createdBy, member.id));
    await db.delete(participants).where(eq(participants.createdBy, member.id));
    await db.delete(members).where(inArray(members.id, [member.id]));
    await closeTestDb();
  }
}

Deno.test("compensation lifecycle: pending → approved → paid, audited, guarded", async () => {
  await withEnv(async ({ db, member, participant, enrollment }) => {
    // Validation: cents must be a positive integer.
    await assert.rejects(
      () =>
        createCompensation(db, {
          enrollment,
          amountCents: 0,
          method: "paynow",
          createdBy: member,
        }),
      CompensationError,
    );

    const compensation = await createCompensation(db, {
      enrollment,
      amountCents: 2050,
      method: "paynow",
      scheme: "base",
      createdBy: member,
    });
    assert.equal(compensation.status, "pending");
    assert.equal(fmtAmount(compensation.amountCents), "SGD 20.50");

    // Cannot pay before approval.
    await assert.rejects(
      () => markCompensationPaid(db, { compensation, actor: member }),
      CompensationError,
    );

    const approved = await approveCompensation(db, {
      compensation,
      actor: member,
    });
    assert.equal(approved.status, "approved");
    assert.equal(approved.approvedBy, member.id);
    assert.ok(approved.approvedAt);

    // Double-approval is refused (already processed).
    await assert.rejects(
      () => approveCompensation(db, { compensation, actor: member }),
      CompensationError,
    );

    const paid = await markCompensationPaid(db, {
      compensation: approved,
      actor: member,
    });
    assert.equal(paid.status, "paid");
    assert.ok(paid.paidAt);

    // Paid is terminal.
    await assert.rejects(
      () => approveCompensation(db, { compensation: paid, actor: member }),
      CompensationError,
    );

    // Approval + payout are audited without PII.
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, compensation.id));
    const actions = entries.map((e) => e.action).sort();
    assert.deepEqual(actions, [
      "compensation.created",
      "payment.approve",
      "payment.paid",
    ]);
    assert.ok(!JSON.stringify(entries).includes("Ada Pay"));
    void participant;
  });
});

Deno.test("outstanding dashboard: unpaid only, pseudonymous, totals by method", async () => {
  await withEnv(async ({ db, member, study, participant, enrollment }) => {
    const a = await createCompensation(db, {
      enrollment,
      amountCents: 1000,
      method: "paynow",
      createdBy: member,
    });
    const b = await createCompensation(db, {
      enrollment,
      amountCents: 2000,
      method: "paypal",
      createdBy: member,
    });
    const paid = await createCompensation(db, {
      enrollment,
      amountCents: 500,
      method: "cash",
      createdBy: member,
    });
    await approveCompensation(db, { compensation: b, actor: member });
    const paidApproved = await approveCompensation(db, {
      compensation: paid,
      actor: member,
    });
    await markCompensationPaid(db, {
      compensation: paidApproved,
      actor: member,
    });

    const rows = await listOutstanding(db);
    const mine = rows.filter((r) => r.studyId === study.id);
    assert.equal(mine.length, 2); // the paid one is gone
    assert.ok(mine.every((r) => r.participantCode === participant.code));
    assert.ok(mine.every((r) => r.studyName === "Pay Study"));
    assert.ok(!JSON.stringify(mine).includes("Ada Pay"));

    const totals = outstandingTotals(mine);
    assert.equal(totals.pendingCount, 1);
    assert.equal(totals.pendingCents, 1000);
    assert.equal(totals.approvedCount, 1);
    assert.deepEqual(totals.approvedByMethod, { paypal: 2000 });
    void a;
  });
});

Deno.test("run sheet + ledger: decrypted payment details, spec columns", async () => {
  await withEnv(async ({ db, member, participant, enrollment }) => {
    await addChannel(db, {
      participant,
      channel: { kind: "phone", value: "+65 9123 4567" },
      actor: member,
    });
    const approved = await approveCompensation(db, {
      compensation: await createCompensation(db, {
        enrollment,
        amountCents: 1550,
        method: "paynow",
        scheme: "base",
        createdBy: member,
      }),
      actor: member,
    });

    // Run sheet carries name + decrypted PayNow phone.
    const sheet = await runSheet(db, "paynow");
    const mine = sheet.find((r) => r.compensationId === approved.id);
    assert.ok(mine);
    assert.equal(mine.name, "Ada Pay");
    assert.equal(mine.payTo, "+65 9123 4567");
    assert.equal(mine.amountCents, 1550);

    // Paying with a reference lands it in the ledger with spec columns.
    await markCompensationPaid(db, {
      compensation: approved,
      actor: member,
      reference: "TXN-42",
    });
    const ledger = await ledgerRows(db);
    const entry = ledger.find((r) => r.reference === "TXN-42");
    assert.ok(entry);
    assert.equal(entry.name, "Ada Pay");
    assert.equal(entry.phone, "+65 9123 4567");
    assert.equal(entry.amountCents, 1550);
    assert.ok(entry.paidAt);

    // The paid row left the run sheet.
    assert.ok(
      !(await runSheet(db, "paynow")).some((r) =>
        r.compensationId === approved.id
      ),
    );
  });
});

Deno.test("payment confirmation: enqueued once on mark-paid, idempotent", async () => {
  await withEnv(async ({ db, member, participant, enrollment }) => {
    await addChannel(db, {
      participant,
      channel: { kind: "email", value: "ada-pay@example.com" },
      actor: member,
    });
    const approved = await approveCompensation(db, {
      compensation: await createCompensation(db, {
        enrollment,
        amountCents: 800,
        method: "paypal",
        createdBy: member,
      }),
      actor: member,
    });
    await markCompensationPaid(db, { compensation: approved, actor: member });

    const queued = await db
      .select()
      .from(messages)
      .where(eq(messages.enrollmentId, enrollment.id));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].templateKey, "payment_confirmation");
    assert.equal(queued[0].idempotencyKey, `payment:${approved.id}`);
    assert.ok(queued[0].body.includes("SGD 8.00"));

    await db.delete(messages).where(eq(messages.enrollmentId, enrollment.id));
  });
});

Deno.test("batch paid (run-sheet flow): only approved rows flip", async () => {
  await withEnv(async ({ db, member, enrollment }) => {
    const pending = await createCompensation(db, {
      enrollment,
      amountCents: 100,
      method: "paynow",
      createdBy: member,
    });
    const approved = await approveCompensation(db, {
      compensation: await createCompensation(db, {
        enrollment,
        amountCents: 200,
        method: "paynow",
        createdBy: member,
      }),
      actor: member,
    });

    const sheet = await listApprovedByMethod(db, "paynow");
    assert.ok(sheet.some((r) => r.compensation.id === approved.id));
    assert.ok(!sheet.some((r) => r.compensation.id === pending.id));

    const flipped = await markBatchPaid(db, {
      ids: [pending.id, approved.id], // pending sneaks in, must not flip
      actor: member,
    });
    assert.equal(flipped, 1);

    const after = await listOutstanding(db);
    const ids = after.map((r) => r.compensation.id);
    assert.ok(ids.includes(pending.id)); // still pending
    assert.ok(!ids.includes(approved.id)); // now paid
  });
});
