// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { desc, eq, inArray } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import { auditLog, type Member, members, projects } from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import {
  addProjectMember,
  createProject,
  getProjectFor,
  listAddableMembers,
  listProjectMembers,
  listProjectsFor,
  listProjectsOfMember,
  ProjectError,
  removeProjectMember,
  setProjectStatus,
  updateProject,
} from "./projects.ts";

async function withActors(
  fn: (
    actors: { pi: Member; researcher: Member; outsider: Member },
  ) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [pi, researcher, outsider] = await db
    .insert(members)
    .values([
      fakeMember({ email: `proj-pi-${suffix}@studyhub.local`, role: "pi" }),
      fakeMember({
        email: `proj-res-${suffix}@studyhub.local`,
        role: "researcher",
      }),
      fakeMember({
        email: `proj-out-${suffix}@studyhub.local`,
        role: "researcher",
      }),
    ])
    .returning();
  try {
    await fn({ pi, researcher, outsider });
  } finally {
    // Cascades remove project memberships; projects are deleted explicitly.
    await db.delete(projects).where(
      inArray(projects.createdBy, [pi.id, researcher.id, outsider.id]),
    );
    await db.delete(members).where(
      inArray(members.id, [pi.id, researcher.id, outsider.id]),
    );
    await closeTestDb();
  }
}

Deno.test("create: validates name, auto-joins creator, audits", async () => {
  await withActors(async ({ researcher }) => {
    const db = await getTestDb();
    await assert.rejects(
      () => createProject(db, { name: "   ", createdBy: researcher }),
      ProjectError,
    );

    const project = await createProject(db, {
      name: "  Attention Study 2026  ",
      description: "desc",
      createdBy: researcher,
    });
    assert.equal(project.name, "Attention Study 2026");
    assert.equal(project.status, "active");

    const team = await listProjectMembers(db, project.id);
    assert.deepEqual(team.map((m) => m.id), [researcher.id]);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, project.id))
      .orderBy(desc(auditLog.at))
      .limit(1);
    assert.equal(entry.action, "project.created");
    assert.equal(entry.actorId, researcher.id);
  });
});

Deno.test("visibility: PI sees all, others only assigned projects", async () => {
  await withActors(async ({ pi, researcher, outsider }) => {
    const db = await getTestDb();
    const project = await createProject(db, {
      name: `vis-${crypto.randomUUID()}`,
      createdBy: researcher,
    });

    const piSees = await listProjectsFor(db, pi);
    assert.ok(piSees.some((p) => p.id === project.id));
    assert.ok((await getProjectFor(db, pi, project.id)) !== null);

    const memberSees = await listProjectsFor(db, researcher);
    assert.ok(memberSees.some((p) => p.id === project.id));

    const outsiderSees = await listProjectsFor(db, outsider);
    assert.ok(!outsiderSees.some((p) => p.id === project.id));
    assert.equal(await getProjectFor(db, outsider, project.id), null);
  });
});

Deno.test("update: edits active projects, refuses archived ones", async () => {
  await withActors(async ({ researcher }) => {
    const db = await getTestDb();
    const project = await createProject(db, {
      name: `upd-${crypto.randomUUID()}`,
      createdBy: researcher,
    });

    const updated = await updateProject(db, {
      project,
      name: "Renamed",
      description: "new",
      actor: researcher,
    });
    assert.equal(updated.name, "Renamed");
    assert.ok(updated.updatedAt >= project.updatedAt);

    const archived = await setProjectStatus(db, {
      project: updated,
      status: "archived",
      actor: researcher,
    });
    assert.equal(archived.status, "archived");
    await assert.rejects(
      () =>
        updateProject(db, {
          project: archived,
          name: "Nope",
          description: "",
          actor: researcher,
        }),
      ProjectError,
    );

    const restored = await setProjectStatus(db, {
      project: archived,
      status: "active",
      actor: researcher,
    });
    assert.equal(restored.status, "active");
  });
});

Deno.test("membership: add/remove with idempotency and pickers", async () => {
  await withActors(async ({ researcher, outsider }) => {
    const db = await getTestDb();
    const project = await createProject(db, {
      name: `mem-${crypto.randomUUID()}`,
      createdBy: researcher,
    });

    const addable = await listAddableMembers(db, project.id);
    assert.ok(addable.some((m) => m.id === outsider.id));
    assert.ok(!addable.some((m) => m.id === researcher.id));

    await addProjectMember(db, {
      project,
      memberId: outsider.id,
      actor: researcher,
    });
    // Idempotent: second add is a no-op (and writes no audit row).
    await addProjectMember(db, {
      project,
      memberId: outsider.id,
      actor: researcher,
    });
    const team = await listProjectMembers(db, project.id);
    assert.equal(team.filter((m) => m.id === outsider.id).length, 1);

    assert.ok(
      (await listProjectsOfMember(db, outsider.id)).some(
        (p) => p.id === project.id,
      ),
    );

    await removeProjectMember(db, {
      project,
      memberId: outsider.id,
      actor: researcher,
    });
    assert.ok(
      !(await listProjectMembers(db, project.id)).some(
        (m) => m.id === outsider.id,
      ),
    );

    const auditEntries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, project.id));
    const adds = auditEntries.filter((e) =>
      e.action === "project.member_added"
    );
    const removes = auditEntries.filter(
      (e) => e.action === "project.member_removed",
    );
    assert.equal(adds.length, 1);
    assert.equal(removes.length, 1);
  });
});
