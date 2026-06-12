// wouldCreateCycle unit tests (pure) plus integration tests (stack
// required) for milestone CRUD, blocking, templates, and duplication.
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  type Member,
  members,
  type Project,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy, duplicateStudy } from "./studies.ts";
import {
  addDependency,
  applyMethodologyTemplate,
  createMilestone,
  deleteMilestone,
  listMilestonesOfProject,
  listMilestonesOfStudy,
  MILESTONE_TEMPLATES,
  MilestoneError,
  removeDependency,
  rescheduleMilestone,
  setMilestoneStatus,
  updateMilestone,
  wouldCreateCycle,
} from "./milestones.ts";

Deno.test("wouldCreateCycle: self, direct, transitive, and safe cases", () => {
  const edges = [
    { from: "b", to: "a" }, // b depends on a
    { from: "c", to: "b" },
  ];
  assert.ok(wouldCreateCycle(edges, "a", "a"));
  assert.ok(wouldCreateCycle(edges, "a", "b")); // b already depends on a
  assert.ok(wouldCreateCycle(edges, "a", "c")); // transitively
  assert.ok(!wouldCreateCycle(edges, "c", "a"));
  assert.ok(!wouldCreateCycle([], "x", "y"));
});

async function withEnv(
  fn: (env: {
    researcher: Member;
    project: Project;
    study: Study;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [researcher] = await db
    .insert(members)
    .values([
      fakeMember({
        email: `ms-res-${suffix}@studyhub.local`,
        role: "researcher",
      }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `milestone-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Timeline host",
    methodology: "survey",
    createdBy: researcher,
  });
  try {
    await fn({ researcher, project, study });
  } finally {
    // Some tests create extra projects (the cross-project dependency case);
    // delete everything the test member created so milestone created_by
    // FKs don't block deleting the member itself.
    await db.delete(projects).where(eq(projects.createdBy, researcher.id));
    await db.delete(members).where(inArray(members.id, [researcher.id]));
    await closeTestDb();
  }
}

Deno.test("CRUD: validation, dates, owner, ordering, audited delete", async () => {
  await withEnv(async ({ researcher, project, study }) => {
    const db = await getTestDb();
    await assert.rejects(
      () =>
        createMilestone(db, {
          project,
          study,
          title: " ",
          createdBy: researcher,
        }),
      MilestoneError,
    );
    await assert.rejects(
      () =>
        createMilestone(db, {
          project,
          study,
          title: "Bad dates",
          startsOn: new Date("2026-07-01"),
          dueOn: new Date("2026-06-01"),
          createdBy: researcher,
        }),
      MilestoneError,
    );

    const later = await createMilestone(db, {
      project,
      study,
      title: "Later",
      dueOn: new Date("2026-09-01"),
      createdBy: researcher,
    });
    const sooner = await createMilestone(db, {
      project,
      study,
      title: "Sooner",
      dueOn: new Date("2026-07-01"),
      ownerId: researcher.id,
      createdBy: researcher,
    });
    const undated = await createMilestone(db, {
      project,
      study,
      title: "Undated",
      createdBy: researcher,
    });

    const listed = await listMilestonesOfStudy(db, study.id);
    assert.deepEqual(
      listed.map((m) => m.milestone.title),
      ["Sooner", "Later", "Undated"], // due-dated first, undated last
    );
    assert.equal(listed[0].owner?.id, researcher.id);

    const renamed = await updateMilestone(db, {
      milestone: undated,
      title: "Renamed",
      notes: "n",
      ownerId: null,
      startsOn: null,
      dueOn: null,
      actor: researcher,
    });
    assert.equal(renamed.title, "Renamed");

    await deleteMilestone(db, { milestone: later, actor: researcher });
    assert.equal((await listMilestonesOfStudy(db, study.id)).length, 2);
    const deletion = (await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, later.id)))
      .find((e) => e.action === "milestone.deleted");
    assert.equal(deletion?.details?.title, "Later");
    void sooner;
  });
});

Deno.test("blocking: dependencies gate start/done; cycles refused", async () => {
  await withEnv(async ({ researcher, project, study }) => {
    const db = await getTestDb();
    const irb = await createMilestone(db, {
      project,
      study,
      title: "IRB approval",
      createdBy: researcher,
    });
    const recruit = await createMilestone(db, {
      project,
      study,
      title: "Start recruiting",
      createdBy: researcher,
    });
    await addDependency(db, {
      milestone: recruit,
      dependsOnId: irb.id,
      actor: researcher,
    });

    // "Can't start recruiting before IRB approval."
    await assert.rejects(
      () =>
        setMilestoneStatus(db, {
          milestone: recruit,
          status: "in_progress",
          actor: researcher,
        }),
      (err: unknown) => {
        assert.ok(err instanceof MilestoneError);
        assert.match(err.message, /IRB approval/);
        return true;
      },
    );
    const listed = await listMilestonesOfStudy(db, study.id);
    assert.equal(
      listed.find((m) => m.milestone.id === recruit.id)?.blocked,
      true,
    );

    // Cycles are refused.
    await assert.rejects(
      () =>
        addDependency(db, {
          milestone: irb,
          dependsOnId: recruit.id,
          actor: researcher,
        }),
      MilestoneError,
    );

    // Completing the dependency unblocks.
    await setMilestoneStatus(db, {
      milestone: irb,
      status: "done",
      actor: researcher,
    });
    const started = await setMilestoneStatus(db, {
      milestone: recruit,
      status: "in_progress",
      actor: researcher,
    });
    assert.equal(started.status, "in_progress");

    // Removing a dependency also unblocks.
    await removeDependency(db, { milestone: recruit, dependsOnId: irb.id });
    assert.equal(
      (await listMilestonesOfStudy(db, study.id)).find(
        (m) => m.milestone.id === recruit.id,
      )?.dependsOn.length,
      0,
    );
  });
});

Deno.test("dependencies must stay within the project", async () => {
  await withEnv(async ({ researcher, project, study }) => {
    const db = await getTestDb();
    const otherProject = await createProject(db, {
      name: `other-${crypto.randomUUID()}`,
      createdBy: researcher,
    });
    const foreign = await createMilestone(db, {
      project: otherProject,
      title: "Foreign",
      createdBy: researcher,
    });
    const local = await createMilestone(db, {
      project,
      study,
      title: "Local",
      createdBy: researcher,
    });
    await assert.rejects(
      () =>
        addDependency(db, {
          milestone: local,
          dependsOnId: foreign.id,
          actor: researcher,
        }),
      MilestoneError,
    );
  });
});

Deno.test("methodology template: chained milestones, audited", async () => {
  await withEnv(async ({ researcher, project, study }) => {
    const db = await getTestDb();
    const created = await applyMethodologyTemplate(db, {
      project,
      study,
      actor: researcher,
    });
    const expected = MILESTONE_TEMPLATES[study.methodology];
    assert.equal(created.length, expected.length);

    const listed = await listMilestonesOfStudy(db, study.id);
    // Sequential chain: every milestone after the first depends on its
    // predecessor and is therefore blocked initially.
    const byTitle = new Map(listed.map((m) => [m.milestone.title, m]));
    for (let i = 1; i < expected.length; i++) {
      const item = byTitle.get(expected[i])!;
      assert.equal(item.dependsOn.length, 1);
      assert.equal(item.blocked, true);
    }
    assert.equal(byTitle.get(expected[0])!.blocked, false);

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, study.id));
    const applied = entries.find(
      (e) => e.action === "study.milestone_template_applied",
    );
    assert.equal(applied?.details?.count, expected.length);
  });
});

Deno.test("project roll-up includes study and project milestones", async () => {
  await withEnv(async ({ researcher, project, study }) => {
    const db = await getTestDb();
    await createMilestone(db, {
      project,
      title: "Project-level kickoff",
      createdBy: researcher,
    });
    await createMilestone(db, {
      project,
      study,
      title: "Study-level item",
      createdBy: researcher,
    });
    const rollup = await listMilestonesOfProject(db, project.id);
    const titles = rollup.map((m) => m.milestone.title);
    assert.ok(titles.includes("Project-level kickoff"));
    assert.ok(titles.includes("Study-level item"));
  });
});

Deno.test("duplicate copies milestones with pending status and remapped deps", async () => {
  await withEnv(async ({ researcher, project, study }) => {
    const db = await getTestDb();
    const a = await createMilestone(db, {
      project,
      study,
      title: "First",
      dueOn: new Date("2026-08-01"),
      createdBy: researcher,
    });
    const b = await createMilestone(db, {
      project,
      study,
      title: "Second",
      createdBy: researcher,
    });
    await addDependency(db, {
      milestone: b,
      dependsOnId: a.id,
      actor: researcher,
    });
    await setMilestoneStatus(db, {
      milestone: a,
      status: "done",
      actor: researcher,
    });

    const copy = await duplicateStudy(db, { study, actor: researcher });
    const copied = await listMilestonesOfStudy(db, copy.id);
    assert.equal(copied.length, 2);
    // Statuses reset; dependency points at the copied "First", so the
    // copied "Second" starts blocked again.
    const first = copied.find((m) => m.milestone.title === "First")!;
    const second = copied.find((m) => m.milestone.title === "Second")!;
    assert.equal(first.milestone.status, "pending");
    assert.equal(
      first.milestone.dueOn?.toISOString().slice(0, 10),
      "2026-08-01",
    );
    assert.deepEqual(second.dependsOn, [first.milestone.id]);
    assert.equal(second.blocked, true);
  });
});

Deno.test("reschedule: date-only update with validation", async () => {
  await withEnv(async ({ researcher, project, study }) => {
    const db = await getTestDb();
    const m = await createMilestone(db, {
      project,
      study,
      title: "Movable",
      startsOn: new Date("2026-07-01"),
      dueOn: new Date("2026-07-10"),
      createdBy: researcher,
    });
    const moved = await rescheduleMilestone(db, {
      milestone: m,
      startsOn: new Date("2026-07-08"),
      dueOn: new Date("2026-07-17"),
      actor: researcher,
    });
    assert.equal(moved.startsOn?.toISOString().slice(0, 10), "2026-07-08");
    assert.equal(moved.dueOn?.toISOString().slice(0, 10), "2026-07-17");
    assert.equal(moved.title, "Movable"); // untouched

    await assert.rejects(
      () =>
        rescheduleMilestone(db, {
          milestone: moved,
          startsOn: new Date("2026-08-01"),
          dueOn: new Date("2026-07-01"),
          actor: researcher,
        }),
      MilestoneError,
    );
  });
});
