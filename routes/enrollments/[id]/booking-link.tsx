// Issues a session self-booking magic link for an enrollment (assistant+).
// Until messaging lands (Phase 3.6), the link is shown for manual sending.
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { audit } from "../../../lib/audit/log.ts";
import { isTerminal } from "../../../lib/objects/enrollments.ts";
import {
  BOOKING_LINK_TTL_SECONDS,
  bookingLinkFor,
} from "../../../lib/objects/sessions.ts";
import { getEnrollmentFor } from "./_shared.ts";
import { Layout } from "../../../components/Layout.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";

interface Data {
  studyId: string;
  studyName: string;
  link: string | null;
  reason?: string;
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getEnrollmentFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);
    const { enrollment, study } = found;

    const reason = isTerminal(enrollment.status)
      ? `A ${enrollment.status} enrollment cannot book sessions.`
      : undefined;
    const link = reason ? null : bookingLinkFor(enrollment);
    if (link) {
      await audit(db, {
        action: "session.booking_link_issued",
        actorId: me.id,
        objectType: "enrollment",
        objectId: enrollment.id,
        details: { ttlDays: BOOKING_LINK_TTL_SECONDS / 86400 },
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    }
    return page<Data>({
      studyId: study.id,
      studyName: study.name,
      link,
      reason,
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Booking link">
    <div class="mb-4">
      <Chip
        href={`/studies/${data.studyId}?tab=sessions`}
        icon="⚗"
        label={data.studyName}
      />
    </div>
    {data.link
      ? (
        <div class="max-w-2xl space-y-3 rounded-card border border-gray-200 bg-white p-4">
          <p class="text-sm text-gray-700">
            Send this self-booking link to the participant (valid for{" "}
            {BOOKING_LINK_TTL_SECONDS / 86400}{" "}
            days). They pick from the study's open slots. Automated delivery
            arrives with messaging in Phase 3.6.
          </p>
          <code class="block break-all rounded bg-gray-50 p-2 text-xs">
            {data.link}
          </code>
        </div>
      )
      : (
        <p class="max-w-2xl rounded-card border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          {data.reason}
        </p>
      )}
  </Layout>
));
