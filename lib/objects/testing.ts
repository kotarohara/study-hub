// Shared helpers for integration tests (not a test file itself).
import type { Db } from "../db/client.ts";
import type { Member, Project, Study } from "../db/schema.ts";
import { createDocument, transitionDocument } from "./documents.ts";

/** Satisfies the recruiting guard: creates an APPROVED consent form for the
 * study (authored by `author`, approval recorded by `pi`). */
export async function grantApprovedConsent(
  db: Db,
  opts: { project: Project; study: Study; author: Member; pi: Member },
): Promise<void> {
  let doc = await createDocument(db, {
    project: opts.project,
    study: opts.study,
    title: "Consent form",
    kind: "consent_form",
    initialVersion: { content: "You agree to participate." },
    createdBy: opts.author,
  });
  doc = await transitionDocument(db, {
    document: doc,
    to: "submitted",
    actor: opts.author,
  });
  await transitionDocument(db, {
    document: doc,
    to: "approved",
    actor: opts.pi,
  });
}
