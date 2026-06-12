// Integration tests — require the local stack: `deno task stack:up`.
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
import { createProject, setProjectStatus } from "./projects.ts";
import {
  archiveStudy,
  createStudy,
  duplicateStudy,
  getStudyFor,
  listStudiesFor,
  listStudiesOfProject,
  StudyError,
  transitionStudy,
  unarchiveStudy,
  updateStudy,
} from "./studies.ts";

async function withProject(
  fn: (env: {
    researcher: Member;
    outsider: Member;
    project: Project;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher, outsider] = await db
    .insert(members)
    .values([
      fakeMember({
        email: `study-res-${suffix}@studyhub.local`,
        role: "researcher",
      }),
      fakeMember({
        email: `study-out-${suffix}@studyhub.local`,
        role: "researcher",
      }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `study-test-${suffix}`,
    createdBy: researcher,
  });
  try {
    await fn({ researcher, outsider, project });
  } finally {
    await db.delete(projects).where(eq(projects.id, project.id));
    await db.delete(members).where(
      inArray(members.id, [researcher.id, outsider.id]),
    );
    await closeTestDb();
  }
}

Deno.test("create: defaults, validation, archived-project refusal", async () => {
  await withProject(async ({ researcher, project }) => {
    const db = await getTestDb();
    await assert.rejects(
      () =>
        createStudy(db, {
          project,
          name: " ",
          methodology: "survey",
          createdBy: researcher,
        }),
      StudyError,
    );

    const study = await createStudy(db, {
      project,
      name: "Diary study A",
      methodology: "diary_study",
      createdBy: researcher,
    });
    assert.equal(study.status, "draft");
    assert.equal(study.oversightPathway, "irb_reviewed");

    const archived = await setProjectStatus(db, {
      project,
      status: "archived",
      actor: researcher,
    });
    await assert.rejects(
      () =>
        createStudy(db, {
          project: archived,
          name: "Nope",
          methodology: "survey",
          createdBy: researcher,
        }),
      StudyError,
    );
    await setProjectStatus(db, {
      project: archived,
      status: "active",
      actor: researcher,
    });
  });
});

Deno.test("visibility follows the parent project", async () => {
  await withProject(async ({ researcher, outsider, project }) => {
    const db = await getTestDb();
    const study = await createStudy(db, {
      project,
      name: "Visible?",
      methodology: "survey",
      createdBy: researcher,
    });

    const mine = await listStudiesFor(db, researcher);
    assert.ok(mine.some((r) => r.study.id === study.id));
    assert.ok((await getStudyFor(db, researcher, study.id)) !== null);

    const theirs = await listStudiesFor(db, outsider);
    assert.ok(!theirs.some((r) => r.study.id === study.id));
    assert.equal(await getStudyFor(db, outsider, study.id), null);

    assert.equal((await listStudiesOfProject(db, project.id)).length, 1);
  });
});

Deno.test("lifecycle: valid path works, invalid jumps are refused, audited", async () => {
  await withProject(async ({ researcher, project }) => {
    const db = await getTestDb();
    let study = await createStudy(db, {
      project,
      name: "Lifecycle",
      methodology: "lab_experiment",
      createdBy: researcher,
    });

    // draft cannot jump straight to running.
    await assert.rejects(
      () => transitionStudy(db, { study, to: "running", actor: researcher }),
      StudyError,
    );

    for (
      const to of ["irb_review", "recruiting", "running", "analysis"] as const
    ) {
      study = await transitionStudy(db, { study, to, actor: researcher });
      assert.equal(study.status, to);
    }
    // analysis is terminal except for archiving.
    await assert.rejects(
      () => transitionStudy(db, { study, to: "draft", actor: researcher }),
      StudyError,
    );

    const changes = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, study.id));
    assert.equal(
      changes.filter((e) => e.action === "study.status_changed").length,
      4,
    );
  });
});

Deno.test("irb_review can return to draft for revisions", async () => {
  await withProject(async ({ researcher, project }) => {
    const db = await getTestDb();
    let study = await createStudy(db, {
      project,
      name: "Revisable",
      methodology: "interview",
      createdBy: researcher,
    });
    study = await transitionStudy(db, {
      study,
      to: "irb_review",
      actor: researcher,
    });
    study = await transitionStudy(db, {
      study,
      to: "draft",
      actor: researcher,
    });
    assert.equal(study.status, "draft");
  });
});

Deno.test("edit allowed in draft/irb_review only", async () => {
  await withProject(async ({ researcher, project }) => {
    const db = await getTestDb();
    let study = await createStudy(db, {
      project,
      name: "Editable",
      methodology: "survey",
      createdBy: researcher,
    });
    study = await updateStudy(db, {
      study,
      name: "Edited",
      description: "x",
      actor: researcher,
    });
    assert.equal(study.name, "Edited");

    study = await transitionStudy(db, {
      study,
      to: "irb_review",
      actor: researcher,
    });
    study = await transitionStudy(db, {
      study,
      to: "recruiting",
      actor: researcher,
    });
    await assert.rejects(
      () =>
        updateStudy(db, {
          study,
          name: "Too late",
          description: "",
          actor: researcher,
        }),
      StudyError,
    );
  });
});

Deno.test("archive from any state; unarchive restores it", async () => {
  await withProject(async ({ researcher, project }) => {
    const db = await getTestDb();
    let study = await createStudy(db, {
      project,
      name: "Archivable",
      methodology: "survey",
      createdBy: researcher,
    });
    study = await transitionStudy(db, {
      study,
      to: "irb_review",
      actor: researcher,
    });
    study = await transitionStudy(db, {
      study,
      to: "recruiting",
      actor: researcher,
    });

    study = await archiveStudy(db, { study, actor: researcher });
    assert.equal(study.status, "archived");
    assert.equal(study.archivedFrom, "recruiting");
    await assert.rejects(
      () => archiveStudy(db, { study, actor: researcher }),
      StudyError,
    );

    study = await unarchiveStudy(db, { study, actor: researcher });
    assert.equal(study.status, "recruiting");
    assert.equal(study.archivedFrom, null);
  });
});

Deno.test("duplicate: copies design into a fresh draft, audited", async () => {
  await withProject(async ({ researcher, project }) => {
    const db = await getTestDb();
    let original = await createStudy(db, {
      project,
      name: "Original",
      description: "the design",
      methodology: "crowdsourcing",
      createdBy: researcher,
    });
    original = await transitionStudy(db, {
      study: original,
      to: "irb_review",
      actor: researcher,
    });
    original = await transitionStudy(db, {
      study: original,
      to: "recruiting",
      actor: researcher,
    });

    const copy = await duplicateStudy(db, {
      study: original,
      actor: researcher,
    });
    assert.equal(copy.name, "Original (copy)");
    assert.equal(copy.description, "the design");
    assert.equal(copy.methodology, "crowdsourcing");
    assert.equal(copy.status, "draft"); // never inherits lifecycle position
    assert.notEqual(copy.id, original.id);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, copy.id));
    assert.equal(entry.action, "study.duplicated");
    assert.equal(entry.details?.sourceStudyId, original.id);
  });
});
