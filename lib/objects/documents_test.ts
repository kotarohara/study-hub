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
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { createProject } from "./projects.ts";
import { createStudy, duplicateStudy } from "./studies.ts";
import {
  addComment,
  addVersion,
  createDocument,
  DocumentError,
  getDocumentFor,
  getVersion,
  listComments,
  listDocumentsOfStudy,
  listVersions,
  transitionDocument,
} from "./documents.ts";

async function withEnv(
  fn: (env: {
    pi: Member;
    researcher: Member;
    outsider: Member;
    project: Project;
    study: Study;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [pi, researcher, outsider] = await db
    .insert(members)
    .values([
      fakeMember({ email: `doc-pi-${suffix}@studyhub.local`, role: "pi" }),
      fakeMember({
        email: `doc-res-${suffix}@studyhub.local`,
        role: "researcher",
      }),
      fakeMember({
        email: `doc-out-${suffix}@studyhub.local`,
        role: "researcher",
      }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `doc-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Doc host study",
    methodology: "survey",
    createdBy: researcher,
  });
  try {
    await fn({ pi, researcher, outsider, project, study });
  } finally {
    await db.delete(projects).where(eq(projects.id, project.id));
    await db.delete(members).where(
      inArray(members.id, [pi.id, researcher.id, outsider.id]),
    );
    await closeTestDb();
  }
}

Deno.test("create: validates input, starts at v1 draft, visibility via project", async () => {
  await withEnv(async ({ researcher, outsider, project, study }) => {
    const db = await getTestDb();
    // Needs exactly one of content/file.
    await assert.rejects(
      () =>
        createDocument(db, {
          project,
          title: "Empty",
          kind: "other",
          initialVersion: {},
          createdBy: researcher,
        }),
      DocumentError,
    );
    await assert.rejects(
      () =>
        createDocument(db, {
          project,
          title: "Both",
          kind: "other",
          initialVersion: { content: "x", fileKey: "y" },
          createdBy: researcher,
        }),
      DocumentError,
    );

    const doc = await createDocument(db, {
      project,
      study,
      title: "Consent form",
      kind: "consent_form",
      initialVersion: { content: "You agree to participate." },
      createdBy: researcher,
    });
    assert.equal(doc.reviewStatus, "draft");
    assert.equal(doc.currentVersion, 1);

    assert.ok((await getDocumentFor(db, researcher, doc.id)) !== null);
    assert.equal(await getDocumentFor(db, outsider, doc.id), null);
    assert.equal((await listDocumentsOfStudy(db, study.id)).length, 1);
  });
});

Deno.test("review workflow: transitions, PI-only approval, audit", async () => {
  await withEnv(async ({ pi, researcher, project }) => {
    const db = await getTestDb();
    let doc = await createDocument(db, {
      project,
      title: "Protocol",
      kind: "irb_protocol",
      initialVersion: { content: "v1" },
      createdBy: researcher,
    });

    // draft cannot jump to approved.
    await assert.rejects(
      () =>
        transitionDocument(db, { document: doc, to: "approved", actor: pi }),
      DocumentError,
    );

    doc = await transitionDocument(db, {
      document: doc,
      to: "internal_review",
      actor: researcher,
    });
    doc = await transitionDocument(db, {
      document: doc,
      to: "submitted",
      actor: researcher,
    });

    // Researcher may not record approval.
    await assert.rejects(
      () =>
        transitionDocument(db, {
          document: doc,
          to: "approved",
          actor: researcher,
        }),
      DocumentError,
    );
    doc = await transitionDocument(db, {
      document: doc,
      to: "approved",
      actor: pi,
    });
    assert.equal(doc.reviewStatus, "approved");

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, doc.id));
    assert.equal(
      entries.filter((e) => e.action === "document.status_changed").length,
      3,
    );
  });
});

Deno.test("new version: requires rationale, resets approval to draft", async () => {
  await withEnv(async ({ pi, researcher, project }) => {
    const db = await getTestDb();
    let doc = await createDocument(db, {
      project,
      title: "Consent",
      kind: "consent_form",
      initialVersion: { content: "line one\nline two" },
      createdBy: researcher,
    });
    doc = await transitionDocument(db, {
      document: doc,
      to: "submitted",
      actor: researcher,
    });
    doc = await transitionDocument(db, {
      document: doc,
      to: "approved",
      actor: pi,
    });

    await assert.rejects(
      () =>
        addVersion(db, {
          document: doc,
          version: { content: "new" },
          actor: researcher,
        }),
      DocumentError,
    );

    doc = await addVersion(db, {
      document: doc,
      version: {
        content: "line one\nline two changed",
        changeRationale: "IRB amendment",
      },
      actor: researcher,
    });
    assert.equal(doc.currentVersion, 2);
    assert.equal(doc.reviewStatus, "draft"); // approval never carries over

    const versions = await listVersions(db, doc.id);
    assert.deepEqual(versions.map((v) => v.versionNumber), [2, 1]);
    const v2 = await getVersion(db, doc.id, 2);
    assert.equal(v2?.changeRationale, "IRB amendment");
  });
});

Deno.test("comments: stored with author and version", async () => {
  await withEnv(async ({ researcher, project }) => {
    const db = await getTestDb();
    const doc = await createDocument(db, {
      project,
      title: "Flyer",
      kind: "recruitment_material",
      initialVersion: { content: "Join our study!" },
      createdBy: researcher,
    });
    await assert.rejects(
      () => addComment(db, { document: doc, author: researcher, body: "  " }),
      DocumentError,
    );
    await addComment(db, {
      document: doc,
      author: researcher,
      body: "Tone this down a bit.",
      versionNumber: 1,
    });
    const comments = await listComments(db, doc.id);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].author.id, researcher.id);
    assert.equal(comments[0].comment.versionNumber, 1);
  });
});

Deno.test("duplicate study copies documents as fresh v1 drafts", async () => {
  await withEnv(async ({ pi, researcher, project, study }) => {
    const db = await getTestDb();
    let doc = await createDocument(db, {
      project,
      study,
      title: "Consent",
      kind: "consent_form",
      initialVersion: { content: "v1 text" },
      createdBy: researcher,
    });
    doc = await addVersion(db, {
      document: doc,
      version: { content: "v2 text", changeRationale: "tweak" },
      actor: researcher,
    });
    doc = await transitionDocument(db, {
      document: doc,
      to: "submitted",
      actor: researcher,
    });
    doc = await transitionDocument(db, {
      document: doc,
      to: "approved",
      actor: pi,
    });

    const copy = await duplicateStudy(db, { study, actor: researcher });
    const copiedDocs = await listDocumentsOfStudy(db, copy.id);
    assert.equal(copiedDocs.length, 1);
    assert.equal(copiedDocs[0].title, "Consent");
    assert.equal(copiedDocs[0].reviewStatus, "draft"); // approval not inherited
    assert.equal(copiedDocs[0].currentVersion, 1);
    const v1 = await getVersion(db, copiedDocs[0].id, 1);
    assert.equal(v1?.content, "v2 text"); // latest content carried as v1
  });
});
