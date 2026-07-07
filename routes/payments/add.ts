// Creates a compensation for an enrollment (researcher+).
import { HttpError } from "fresh";
import { define } from "../../utils.ts";
import { getDb } from "../../lib/db/client.ts";
import { hasRole } from "../../lib/auth/roles.ts";
import { clientHost } from "../../lib/auth/limiters.ts";
import { getStudyFor } from "../../lib/objects/studies.ts";
import { getEnrollment } from "../../lib/objects/enrollments.ts";
import {
  COMPENSATION_METHODS,
  CompensationError,
  createCompensation,
} from "../../lib/objects/compensations.ts";
import type { CompensationMethod } from "../../lib/db/schema.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "researcher")) throw new HttpError(403);
    const db = getDb();
    const form = await ctx.req.formData();

    const enrollment = await getEnrollment(
      db,
      String(form.get("enrollmentId") ?? ""),
    );
    if (!enrollment) throw new HttpError(404);
    const found = await getStudyFor(db, me, enrollment.studyId);
    if (!found) throw new HttpError(404);

    const method = String(form.get("method") ?? "");
    if (!COMPENSATION_METHODS.includes(method as CompensationMethod)) {
      throw new HttpError(400, "Pick a payment method.");
    }
    const amountCents = Math.round(Number(form.get("amount")) * 100);

    try {
      await createCompensation(db, {
        enrollment,
        amountCents,
        method: method as CompensationMethod,
        scheme: String(form.get("scheme") ?? ""),
        prolificSubmissionId: String(form.get("prolificSubmissionId") ?? ""),
        notes: String(form.get("notes") ?? ""),
        createdBy: me,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof CompensationError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
    return ctx.redirect("/payments", 303);
  },
});
