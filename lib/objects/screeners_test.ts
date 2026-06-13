// Integration tests — require the local stack: `deno task stack:up`.
import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { fakeMember } from "../db/factories.ts";
import {
  auditLog,
  type Member,
  members,
  participants,
  type Project,
  projects,
  type Study,
} from "../db/schema.ts";
import { closeTestDb, getTestDb } from "../db/test_util.ts";
import { isEncrypted } from "../crypto/encryption.ts";
import { createProject } from "./projects.ts";
import { createStudy, setOversightPathway } from "./studies.ts";
import { createInstrument } from "./instruments.ts";
import {
  configureScreener,
  getScreenerByToken,
  isScreenerLive,
  listScreenerResponses,
  recordScreenerView,
  screenerDefinition,
  ScreenerError,
  setScreenerStatus,
  submitScreener,
} from "./screeners.ts";

const ITEMS = [
  { key: "age", prompt: "Age", type: "number", required: true },
  {
    key: "device",
    prompt: "Device",
    type: "single_choice",
    required: true,
    options: ["phone", "laptop"],
  },
];

async function withEnv(
  fn: (env: {
    pi: Member;
    researcher: Member;
    project: Project;
    study: Study;
  }) => Promise<void>,
) {
  const db = await getTestDb();
  const suffix = crypto.randomUUID();
  const [pi, researcher] = await db
    .insert(members)
    .values([
      fakeMember({ email: `scr-pi-${suffix}@studyhub.local`, role: "pi" }),
      fakeMember({ email: `scr-res-${suffix}@studyhub.local` }),
    ])
    .returning();
  const project = await createProject(db, {
    name: `scr-test-${suffix}`,
    createdBy: researcher,
  });
  const study = await createStudy(db, {
    project,
    name: "Screener host study",
    methodology: "survey",
    createdBy: researcher,
  });
  try {
    await fn({ pi, researcher, project, study });
  } finally {
    // Projects cascade studies → screeners → enrollments → responses;
    // screener-created participants are memberless, found via source.
    await db.delete(projects).where(eq(projects.createdBy, researcher.id));
    await db.execute(sql`
      delete from participants
      where source = 'screener' and created_by is null
    `);
    await db
      .delete(participants)
      .where(eq(participants.createdBy, researcher.id));
    await db.execute(sql`
      delete from instruments where created_by = ${researcher.id}
    `);
    await db
      .delete(members)
      .where(inArray(members.id, [pi.id, researcher.id]));
    await closeTestDb();
  }
}

function makeInstrument(db: Awaited<ReturnType<typeof getTestDb>>, by: Member) {
  return createInstrument(db, {
    name: "Pool screener",
    kind: "simple_form",
    purpose: "screener",
    content: {
      items: ITEMS,
      scoring: [],
    },
    createdBy: by,
  });
}

Deno.test("configure: validates, pins version, keeps token; pilots refused", async () => {
  await withEnv(async ({ pi, researcher, project, study }) => {
    const db = await getTestDb();
    const instrument = await makeInstrument(db, researcher);

    // External instruments cannot back a screener.
    const external = await createInstrument(db, {
      name: "Qualtrics",
      kind: "external",
      purpose: "other",
      content: { externalUrl: "https://example.com/s" },
      createdBy: researcher,
    });
    await assert.rejects(
      () =>
        configureScreener(db, {
          study,
          instrument: external,
          eligibility: [],
          actor: researcher,
        }),
      /simple-form/,
    );
    // Rules are validated against the pinned items.
    await assert.rejects(
      () =>
        configureScreener(db, {
          study,
          instrument,
          eligibility: [{ item: "nope", min: 1 }],
          actor: researcher,
        }),
      /unknown item/,
    );

    const screener = await configureScreener(db, {
      study,
      instrument,
      eligibility: [{ item: "age", min: 21 }],
      actor: researcher,
    });
    assert.equal(screener.instrumentVersionNumber, 1);
    assert.match(screener.token, /^[0-9a-f]{32}$/);

    // Reconfiguring keeps the public token (links keep working).
    const again = await configureScreener(db, {
      study,
      instrument,
      eligibility: [{ item: "age", min: 18 }],
      actor: researcher,
    });
    assert.equal(again.id, screener.id);
    assert.equal(again.token, screener.token);

    const definition = await screenerDefinition(db, again);
    assert.equal(definition.rules[0].min, 18);

    // Internal Pilot studies never get a public screener (spec §3.3).
    const pilot = await createStudy(db, {
      project,
      name: "Pilot study",
      methodology: "survey",
      createdBy: researcher,
    });
    const piloted = await setOversightPathway(db, {
      study: pilot,
      input: {
        pathway: "internal_pilot",
        justification: "dry run with labmates",
      },
      actor: pi,
    });
    await assert.rejects(
      () =>
        configureScreener(db, {
          study: piloted,
          instrument,
          eligibility: [],
          actor: researcher,
        }),
      ScreenerError,
    );
  });
});

Deno.test("liveness: open + recruiting only; pause toggles and is audited", async () => {
  await withEnv(async ({ researcher, study }) => {
    const db = await getTestDb();
    const instrument = await makeInstrument(db, researcher);
    const screener = await configureScreener(db, {
      study,
      instrument,
      eligibility: [],
      actor: researcher,
    });

    assert.equal(isScreenerLive(screener, study), false); // study is draft
    const recruiting = { ...study, status: "recruiting" as const };
    assert.equal(isScreenerLive(screener, recruiting), true);

    const paused = await setScreenerStatus(db, {
      screener,
      status: "paused",
      actor: researcher,
    });
    assert.equal(isScreenerLive(paused, recruiting), false);

    await recordScreenerView(db, screener);
    await recordScreenerView(db, screener);
    const fetched = await getScreenerByToken(db, screener.token);
    assert.equal(fetched?.views, 2);

    const actions = (
      await db
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.objectId, screener.id))
    ).map((e) => e.action);
    assert.ok(actions.includes("screener.configured"));
    assert.ok(actions.includes("screener.status_changed"));
  });
});

Deno.test("submit: creates pool record + enrollment, eligibility sets status", async () => {
  await withEnv(async ({ researcher, study }) => {
    const db = await getTestDb();
    const instrument = await makeInstrument(db, researcher);
    const screener = await configureScreener(db, {
      study,
      instrument,
      eligibility: [
        { item: "age", min: 21, max: 65 },
        { item: "device", anyOf: ["phone"] },
      ],
      actor: researcher,
    });
    const definition = await screenerDefinition(db, screener);

    // Invalid submissions are rejected defensively.
    await assert.rejects(
      () =>
        submitScreener(db, {
          screener,
          study,
          definition,
          raw: { age: "not-a-number", device: "phone" },
          contact: { name: "Mallory", email: "m@example.com" },
        }),
      ScreenerError,
    );

    const eligible = await submitScreener(db, {
      screener,
      study,
      definition,
      raw: { age: "30", device: "phone" },
      contact: { name: "Pat Lim", email: "Pat@Example.com" },
    });
    assert.equal(eligible.eligible, true);
    assert.equal(eligible.enrollment.status, "eligible");
    assert.equal(eligible.enrollment.isPilot, false);

    const ineligible = await submitScreener(db, {
      screener,
      study,
      definition,
      raw: { age: "30", device: "laptop" },
      contact: { name: "Sam Toh", email: "sam@example.com" },
    });
    assert.equal(ineligible.eligible, false);
    assert.equal(ineligible.enrollment.status, "screened");

    // The pool record is memberless, sourced, with encrypted PII.
    const [pat] = await db
      .select()
      .from(participants)
      .where(eq(participants.id, eligible.enrollment.participantId));
    assert.equal(pat.name, "Pat Lim");
    assert.equal(pat.source, "screener");
    assert.equal(pat.createdBy, null);
    const raw = await db.execute<{ name: string; value: string }>(sql`
      select p.name, c.value from participants p
      join contact_channels c on c.participant_id = p.id
      where p.id = ${pat.id}
    `);
    assert.ok(isEncrypted(raw[0].name));
    assert.ok(isEncrypted(raw[0].value));
    assert.ok(!raw[0].value.includes("Pat"));

    // Responses list uses pseudonymous codes; answers stored as submitted.
    const rows = await listScreenerResponses(db, screener.id);
    assert.equal(rows.length, 2);
    const patRow = rows.find((r) => r.participantId === pat.id);
    assert.equal(patRow?.participantCode, pat.code);
    assert.deepEqual(patRow?.answers, { age: 30, device: "phone" });

    // Audited without PII, with no member actor.
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.objectId, eligible.enrollment.id));
    assert.equal(entry.action, "enrollment.screened");
    assert.equal(entry.actorId, null);
    assert.equal(entry.details?.eligible, true);
    assert.ok(!JSON.stringify(entry.details).includes("Pat"));
  });
});
