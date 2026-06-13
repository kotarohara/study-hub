// Issues a consent magic link for an enrollment (assistant+). Until the
// messaging core lands (Phase 3), the link is shown for manual sending.
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { audit } from "../../../lib/audit/log.ts";
import {
  CONSENT_LINK_TTL_SECONDS,
  consentLinkFor,
  getConsentState,
  mayConsent,
} from "../../../lib/objects/consents.ts";
import { getEnrollmentFor } from "./_shared.ts";
import { Layout } from "../../../components/Layout.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";

interface Data {
  studyId: string;
  studyName: string;
  /** Null when the link cannot be issued (with the reason). */
  link: string | null;
  reason?: string;
  reconsent: boolean;
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const found = await getEnrollmentFor(db, me, ctx.params.id);
    if (!found) throw new HttpError(404);
    const { enrollment, study } = found;

    const state = await getConsentState(db, { enrollment, study });
    let reason: string | undefined;
    if (state.status === "no_document") {
      reason = "This study has no APPROVED consent form document yet.";
    } else if (state.status === "current") {
      reason = "The current consent form is already signed.";
    } else if (!mayConsent(enrollment)) {
      reason = `A ${enrollment.status} enrollment cannot consent.`;
    }

    const link = reason ? null : consentLinkFor(enrollment);
    if (link) {
      await audit(db, {
        action: "consent.link_issued",
        actorId: me.id,
        objectType: "enrollment",
        objectId: enrollment.id,
        details: { ttlDays: CONSENT_LINK_TTL_SECONDS / 86400 },
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    }
    return page<Data>({
      studyId: study.id,
      studyName: study.name,
      link,
      reason,
      reconsent: state.status === "outdated",
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout
    member={state.member!}
    pathname={url.pathname}
    title="Consent link"
  >
    <div class="mb-4">
      <Chip
        href={`/studies/${data.studyId}?tab=participants`}
        icon="⚗"
        label={data.studyName}
      />
    </div>
    {data.link
      ? (
        <div class="max-w-2xl space-y-3 rounded-card border border-gray-200 bg-white p-4">
          <p class="text-sm text-gray-700">
            Send this {data.reconsent ? "re-consent" : "consent"}{" "}
            link to the participant (valid for{" "}
            {CONSENT_LINK_TTL_SECONDS / 86400}{" "}
            days). Automated delivery arrives with messaging in Phase 3.
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
