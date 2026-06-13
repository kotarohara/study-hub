// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
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
import { createProject } from "./projects.ts";
import { createStudy } from "./studies.ts";
import { createParticipant } from "./participants.ts";
import { createEnrollment, transitionEnrollment } from "./enrollments.ts";
import {
  bookingLinkFor,
  bookSession,
  cancelBooking,
  listOpenSlots,
  listSessionsOfEnrollment,
  listSessionsOfStudy,
  markSessionOutcome,
  publishSlot,
  rescheduleBooking,
  SessionError,
  verifyBookingToken,
} from "./sessions.ts";

const HOUR = 60 * 60 * 1000;
const future = (offsetHours: number) =>
  new Date(Date.now() + offsetHours * HOUR);

async function withEnv(
  fn: (env: {
    researcher: Member;
    project: Project;
    study: Study;
    ada: Participant;
    ben: Participant;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher] = await db
    .insert(members)
    .values([fakeMember({ email: `ses-res-${suffix}@studyhub.local` })])
    .returning();
  const project = await createProject(db, {
    name: `ses-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Session host study",
    methodology: "interview",
    createdBy: researcher,
  });
  const ada = await createParticipant(db, {
    name: "Ada Session",
    createdBy: researcher,
  });
  const ben = await createParticipant(db, {
    name: "Ben Session",
    createdBy: researcher,
  });
  try {
    await fn({ researcher, project, study, ada, ben });
  } finally {
    await db.delete(projects).where(eq(projects.createdBy, researcher.id));
    await db
      .delete(participants)
      .where(eq(participants.createdBy, researcher.id));
    await db.delete(members).where(inArray(members.id, [researcher.id]));
    await closeTestDb();
  }
}

async function enroll(
  db: Awaited<ReturnType<typeof getTestDb>>,
  study: Study,
  participant: Participant,
  researcher: Member,
) {
  let e = await createEnrollment(db, { study, participant, actor: researcher });
  e = await transitionEnrollment(db, {
    enrollment: e,
    to: "eligible",
    actor: researcher,
  });
  return await transitionEnrollment(db, {
    enrollment: e,
    to: "consented",
    actor: researcher,
  });
}

Deno.test("publish + self-book: one slot, atomic claim, magic link, audited", async () => {
  await withEnv(async ({ researcher, study, ada, ben }) => {
    const db = await getTestDb();

    // Publishing rejects bad/ past times.
    await assert.rejects(
      () =>
        publishSlot(db, {
          study,
          startsAt: future(3),
          endsAt: future(2),
          actor: researcher,
        }),
      /end after it starts/,
    );
    await assert.rejects(
      () =>
        publishSlot(db, {
          study,
          startsAt: future(-2),
          endsAt: future(-1),
          actor: researcher,
        }),
      /future/,
    );

    const slot = await publishSlot(db, {
      study,
      startsAt: future(24),
      endsAt: future(25),
      location: "Lab 3A",
      actor: researcher,
    });
    assert.equal(slot.status, "open");
    assert.equal((await listOpenSlots(db, study.id)).length, 1);

    const adaEnr = await enroll(db, study, ada, researcher);
    // Self-booking: no member actor.
    const booked = await bookSession(db, {
      session: slot,
      enrollment: adaEnr,
      actor: null,
    });
    assert.equal(booked.status, "booked");
    assert.equal(booked.enrollmentId, adaEnr.id);
    assert.equal((await listOpenSlots(db, study.id)).length, 0);

    // The same slot cannot be booked twice (Ben arrives late, holding a
    // stale open slot object). The pre-check passes on the stale status, so
    // the atomic claim — UPDATE ... WHERE status = 'open' returning nothing —
    // is what rejects the double-booking.
    const benEnr = await enroll(db, study, ben, researcher);
    await assert.rejects(
      () => bookSession(db, { session: slot, enrollment: benEnr, actor: null }),
      /just taken|no longer available/,
    );

    // Booking link round-trips to the enrollment.
    const token = bookingLinkFor(adaEnr).split("/p/")[1].replace("/book", "");
    assert.equal(verifyBookingToken(token), adaEnr.id);
    assert.equal(verifyBookingToken("garbage"), null);

    // Audited with the pseudonymous code, no member actor, no PII.
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, slot.id));
    const booking = (
      await db.select().from(auditLog).where(eq(auditLog.objectId, slot.id))
    ).find((e) => e.action === "session.booked");
    assert.ok(entry);
    assert.ok(booking);
    assert.equal(booking.actorId, null);
    assert.equal(booking.details?.code, ada.code);
    assert.ok(!JSON.stringify(booking.details).includes("Ada"));
  });
});

Deno.test("reschedule + no-show: frees the old slot, books the new, tracks outcome", async () => {
  await withEnv(async ({ researcher, study, ada }) => {
    const db = await getTestDb();
    const slotA = await publishSlot(db, {
      study,
      startsAt: future(24),
      endsAt: future(25),
      actor: researcher,
    });
    const slotB = await publishSlot(db, {
      study,
      startsAt: future(48),
      endsAt: future(49),
      actor: researcher,
    });
    const adaEnr = await enroll(db, study, ada, researcher);
    const bookedA = await bookSession(db, {
      session: slotA,
      enrollment: adaEnr,
      actor: null,
    });

    // Reschedule A → B.
    const bookedB = await rescheduleBooking(db, {
      from: bookedA,
      to: slotB,
      enrollment: adaEnr,
      actor: null,
    });
    assert.equal(bookedB.id, slotB.id);
    assert.equal(bookedB.status, "booked");
    // Slot A is open again and bookable.
    const open = await listOpenSlots(db, study.id);
    assert.deepEqual(open.map((s) => s.id), [slotA.id]);

    // The participant's session list shows the active booking on B.
    const mine = await listSessionsOfEnrollment(db, adaEnr.id);
    assert.deepEqual(
      mine.filter((s) => s.status === "booked").map((s) => s.id),
      [slotB.id],
    );

    // No-show is recorded against the booked session.
    const noShow = await markSessionOutcome(db, {
      session: bookedB,
      status: "no_show",
      actor: researcher,
    });
    assert.equal(noShow.status, "no_show");
    // A finalized session cannot be unbooked.
    await assert.rejects(
      () => cancelBooking(db, { session: noShow, actor: researcher }),
      SessionError,
    );

    const actions = (
      await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(inArray(auditLog.objectId, [slotA.id, slotB.id]))
    ).map((e) => e.action);
    assert.ok(actions.includes("session.rescheduled"));
    assert.ok(actions.includes("session.outcome_recorded"));
  });
});

Deno.test("pilot inheritance: a pilot enrollment's session is quarantined", async () => {
  await withEnv(async ({ researcher, study, ada }) => {
    const db = await getTestDb();
    const slot = await publishSlot(db, {
      study,
      startsAt: future(12),
      endsAt: future(13),
      actor: researcher,
    });
    let pilot = await createEnrollment(db, {
      study,
      participant: ada,
      isPilot: true,
      actor: researcher,
    });
    pilot = await transitionEnrollment(db, {
      enrollment: pilot,
      to: "eligible",
      actor: researcher,
    });
    const booked = await bookSession(db, {
      session: slot,
      enrollment: pilot,
      actor: researcher,
    });
    assert.equal(booked.isPilot, true);

    // Cancelling the booking frees the slot and clears the pilot flag.
    const freed = await cancelBooking(db, {
      session: booked,
      actor: researcher,
    });
    assert.equal(freed.status, "open");
    assert.equal(freed.isPilot, false);
    assert.equal(freed.enrollmentId, null);

    const rows = await listSessionsOfStudy(db, study.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].participantCode, null); // open slot, no booker
  });
});
