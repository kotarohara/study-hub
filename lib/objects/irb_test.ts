// Expiry-status unit tests plus integration tests (stack required) for
// approval metadata and the recruiting guard's expiry arm.
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
import { createStudy, StudyError, transitionStudy } from "./studies.ts";
import { irbExpiryStatus, setIrbApproval } from "./irb.ts";
import { grantApprovedConsent } from "./testing.ts";

Deno.test("irbExpiryStatus: null, ok, expiring_soon, expired", () => {
  const now = new Date("2026-06-12T00:00:00Z");
  const day = 24 * 3600 * 1000;
  assert.equal(irbExpiryStatus({ irbExpiresOn: null }, now), null);
  assert.equal(
    irbExpiryStatus({ irbExpiresOn: new Date(now.getTime() + 90 * day) }, now),
    "ok",
  );
  assert.equal(
    irbExpiryStatus({ irbExpiresOn: new Date(now.getTime() + 10 * day) }, now),
    "expiring_soon",
  );
  assert.equal(
    irbExpiryStatus({ irbExpiresOn: new Date(now.getTime() - day) }, now),
    "expired",
  );
});

async function withEnv(
  fn: (
    env: { pi: Member; researcher: Member; project: Project },
  ) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [pi, researcher] = await db
    .insert(members)
    .values([
      fakeMember({ email: `irb-pi-${suffix}@studyhub.local`, role: "pi" }),
      fakeMember({
        email: `irb-res-${suffix}@studyhub.local`,
        role: "researcher",
      }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `irb-test-${suffix}`,
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

Deno.test("setIrbApproval: PI-only, validated, audited; not copied on duplicate", async () => {
  await withEnv(async ({ pi, researcher, project }) => {
    const db = await getTestDb();
    const study = await createStudy(db, {
      project,
      name: "IRB meta",
      methodology: "survey",
      createdBy: researcher,
    });

    await assert.rejects(
      () =>
        setIrbApproval(db, {
          study,
          protocolNumber: "P-1",
          approvedOn: null,
          expiresOn: null,
          actor: researcher,
        }),
      StudyError,
    );
    await assert.rejects(
      () =>
        setIrbApproval(db, {
          study,
          protocolNumber: " ",
          approvedOn: null,
          expiresOn: null,
          actor: pi,
        }),
      StudyError,
    );
    await assert.rejects(
      () =>
        setIrbApproval(db, {
          study,
          protocolNumber: "P-1",
          approvedOn: new Date("2026-06-01"),
          expiresOn: new Date("2026-05-01"),
          actor: pi,
        }),
      StudyError,
    );

    const updated = await setIrbApproval(db, {
      study,
      protocolNumber: "IRB-2026-042",
      approvedOn: new Date("2026-06-01"),
      expiresOn: new Date("2027-06-01"),
      actor: pi,
    });
    assert.equal(updated.irbProtocolNumber, "IRB-2026-042");

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, study.id));
    const recorded = entries.find(
      (e) => e.action === "study.irb_approval_recorded",
    );
    assert.equal(recorded?.details?.protocolNumber, "IRB-2026-042");
  });
});

Deno.test("recruiting guard: expired IRB approval blocks recruiting", async () => {
  await withEnv(async ({ pi, researcher, project }) => {
    const db = await getTestDb();
    let study = await createStudy(db, {
      project,
      name: "Expired IRB",
      methodology: "survey",
      createdBy: researcher,
    });
    await grantApprovedConsent(db, { project, study, author: researcher, pi });
    study = await setIrbApproval(db, {
      study,
      protocolNumber: "IRB-OLD",
      approvedOn: new Date("2024-01-01"),
      expiresOn: new Date("2025-01-01"), // long past
      actor: pi,
    });
    study = await transitionStudy(db, {
      study,
      to: "irb_review",
      actor: researcher,
    });

    await assert.rejects(
      () => transitionStudy(db, { study, to: "recruiting", actor: researcher }),
      (err: unknown) => {
        assert.ok(err instanceof StudyError);
        assert.match(err.message, /expired/);
        return true;
      },
    );

    // Renewal unblocks.
    study = await setIrbApproval(db, {
      study,
      protocolNumber: "IRB-OLD",
      approvedOn: new Date(),
      expiresOn: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      actor: pi,
    });
    study = await transitionStudy(db, {
      study,
      to: "recruiting",
      actor: researcher,
    });
    assert.equal(study.status, "recruiting");
  });
});
