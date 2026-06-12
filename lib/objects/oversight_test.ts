// Integration tests — require the local stack: `deno task stack:up`.
// Plus pure validatePathway unit tests (no stack needed).
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  type Member,
  members,
  type Project,
  projects,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import {
  createStudy,
  duplicateStudy,
  isPilotStudy,
  setOversightPathway,
  StudyError,
  transitionStudy,
  validatePathway,
} from "./studies.ts";

Deno.test("validatePathway: exemption reference and pilot PI gate", () => {
  assert.deepEqual(validatePathway({ pathway: "irb_reviewed" }, "researcher"), {
    irbExemptionReference: "",
    pilotJustification: "",
  });
  assert.throws(
    () => validatePathway({ pathway: "irb_exempt" }, "researcher"),
    StudyError,
  );
  assert.deepEqual(
    validatePathway(
      { pathway: "irb_exempt", exemptionReference: " IRB-2026-042 " },
      "researcher",
    ),
    { irbExemptionReference: "IRB-2026-042", pilotJustification: "" },
  );
  // Pilot: PI-only, justification required.
  assert.throws(
    () =>
      validatePathway(
        { pathway: "internal_pilot", justification: "dry run" },
        "researcher",
      ),
    StudyError,
  );
  assert.throws(
    () => validatePathway({ pathway: "internal_pilot" }, "pi"),
    StudyError,
  );
  assert.deepEqual(
    validatePathway(
      { pathway: "internal_pilot", justification: "protocol dry run" },
      "pi",
    ),
    { irbExemptionReference: "", pilotJustification: "protocol dry run" },
  );
});

async function withEnv(
  fn: (env: {
    pi: Member;
    researcher: Member;
    project: Project;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [pi, researcher] = await db
    .insert(members)
    .values([
      fakeMember({ email: `ov-pi-${suffix}@studyhub.local`, role: "pi" }),
      fakeMember({
        email: `ov-res-${suffix}@studyhub.local`,
        role: "researcher",
      }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `oversight-test-${suffix}`,
    createdBy: pi,
  });
  try {
    await fn({ pi, researcher, project });
  } finally {
    await db.delete(projects).where(eq(projects.id, project.id));
    await db.delete(members).where(inArray(members.id, [pi.id, researcher.id]));
    await closeTestDb();
  }
}

Deno.test("creation: researcher cannot declare a pilot; PI can, audited", async () => {
  await withEnv(async ({ pi, researcher, project }) => {
    const db = await getTestDb();
    await assert.rejects(
      () =>
        createStudy(db, {
          project,
          name: "Sneaky pilot",
          methodology: "survey",
          pathway: { pathway: "internal_pilot", justification: "why not" },
          createdBy: researcher,
        }),
      StudyError,
    );

    const pilot = await createStudy(db, {
      project,
      name: "Real pilot",
      methodology: "lab_experiment",
      pathway: { pathway: "internal_pilot", justification: "protocol dry run" },
      createdBy: pi,
    });
    assert.ok(isPilotStudy(pilot));
    assert.equal(pilot.pilotJustification, "protocol dry run");

    // The PI confirmation + justification land in the audit log (spec §3.3).
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, pilot.id));
    assert.equal(entry.action, "study.created");
    assert.equal(entry.actorId, pi.id);
    assert.equal(entry.details?.justification, "protocol dry run");
  });
});

Deno.test("pathway change: PI-only, state-gated, audited with details", async () => {
  await withEnv(async ({ pi, researcher, project }) => {
    const db = await getTestDb();
    let study = await createStudy(db, {
      project,
      name: "Pathway change",
      methodology: "survey",
      createdBy: pi,
    });

    await assert.rejects(
      () =>
        setOversightPathway(db, {
          study,
          input: { pathway: "irb_exempt", exemptionReference: "X-1" },
          actor: researcher,
        }),
      StudyError,
    );

    study = await setOversightPathway(db, {
      study,
      input: { pathway: "irb_exempt", exemptionReference: "EX-2026-007" },
      actor: pi,
    });
    assert.equal(study.oversightPathway, "irb_exempt");
    assert.equal(study.irbExemptionReference, "EX-2026-007");

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, study.id));
    const change = entries.find((e) => e.action === "study.pathway_changed");
    assert.equal(change?.details?.to, "irb_exempt");
    assert.equal(change?.details?.exemptionReference, "EX-2026-007");

    // Once past the editable states, the pathway is locked.
    study = await transitionStudy(db, {
      study,
      to: "irb_review",
      actor: pi,
    });
    study = await transitionStudy(db, { study, to: "recruiting", actor: pi });
    await assert.rejects(
      () =>
        setOversightPathway(db, {
          study,
          input: { pathway: "irb_reviewed" },
          actor: pi,
        }),
      StudyError,
    );
  });
});

Deno.test("duplicating a pilot is PI-only and keeps the declaration", async () => {
  await withEnv(async ({ pi, researcher, project }) => {
    const db = await getTestDb();
    const pilot = await createStudy(db, {
      project,
      name: "Pilot original",
      methodology: "interview",
      pathway: { pathway: "internal_pilot", justification: "tooling check" },
      createdBy: pi,
    });

    await assert.rejects(
      () => duplicateStudy(db, { study: pilot, actor: researcher }),
      StudyError,
    );

    const copy = await duplicateStudy(db, { study: pilot, actor: pi });
    assert.ok(isPilotStudy(copy));
    assert.equal(copy.pilotJustification, "tooling check");
  });
});
