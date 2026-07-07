// Participant consent page (spec §4 kept-feature 1): reached only via a
// signed, expiring, purpose-scoped magic link — no Turnstile needed (this
// is not an open form), but submissions are rate-limited. Renders the
// CURRENT approved consent Document version; signing records the consent
// and advances an eligible enrollment to consented.
import { page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { RateLimiter } from "../../../lib/rate_limit.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { getStudy } from "../../../lib/objects/studies.ts";
import { getEnrollment } from "../../../lib/objects/enrollments.ts";
import { getParticipant } from "../../../lib/objects/participants.ts";
import { getVersion } from "../../../lib/objects/documents.ts";
import {
  ConsentError,
  getConsentState,
  mayConsent,
  recordConsent,
  verifyConsentToken,
} from "../../../lib/objects/consents.ts";
import { PublicLayout } from "../../../components/PublicLayout.tsx";

const consentLimiter = new RateLimiter({
  capacity: 10,
  refillPerSecond: 1 / 60,
});

interface Data {
  state: "closed" | "form" | "already" | "done";
  studyName?: string;
  /** Consent document text (in-app content only). */
  content?: string;
  version?: number;
  reconsent?: boolean;
  error?: string;
  signatureName?: string;
  recontact?: boolean;
}

const CLOSED = { state: "closed" } as const;

async function loadConsentable(token: string) {
  const enrollmentId = verifyConsentToken(token);
  if (!enrollmentId) return null;
  const db = getDb();
  const enrollment = await getEnrollment(db, enrollmentId);
  if (!enrollment || !mayConsent(enrollment)) return null;
  const study = await getStudy(db, enrollment.studyId);
  if (!study) return null;
  const state = await getConsentState(db, { enrollment, study });
  if (state.status === "no_document") return null;
  return { db, enrollment, study, state };
}

export const handler = define.handlers({
  async GET(ctx) {
    const live = await loadConsentable(ctx.params.token);
    if (!live) return page<Data>(CLOSED, { status: 404 });
    if (live.state.status === "current") {
      return page<Data>({ state: "already", studyName: live.study.name });
    }
    const version = await getVersion(
      live.db,
      live.state.document!.id,
      live.state.document!.currentVersion,
    );
    if (!version?.content) {
      // File-only consent documents cannot be rendered on this page.
      return page<Data>(CLOSED, { status: 404 });
    }
    return page<Data>({
      state: "form",
      studyName: live.study.name,
      content: version.content,
      version: version.versionNumber,
      reconsent: live.state.status === "outdated",
    });
  },
  async POST(ctx) {
    if (!consentLimiter.check(clientHost(ctx.info))) {
      return new Response("Too many requests — try again later.", {
        status: 429,
      });
    }
    const live = await loadConsentable(ctx.params.token);
    if (!live) return page<Data>(CLOSED, { status: 404 });

    const form = await ctx.req.formData();
    const signatureName = String(form.get("signature") ?? "");
    const recontact = form.get("recontact") === "1";
    const participant = await getParticipant(
      live.db,
      live.enrollment.participantId,
    );

    try {
      await recordConsent(live.db, {
        enrollment: live.enrollment,
        study: live.study,
        participantCode: participant?.code ?? "?",
        signatureName,
        consentToRecontact: recontact,
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    } catch (err) {
      if (err instanceof ConsentError) {
        const version = await getVersion(
          live.db,
          live.state.document!.id,
          live.state.document!.currentVersion,
        );
        return page<Data>({
          state: "form",
          studyName: live.study.name,
          content: version?.content ?? "",
          version: version?.versionNumber,
          reconsent: live.state.status === "outdated",
          error: err.message,
          signatureName,
          recontact,
        }, { status: 400 });
      }
      throw err;
    }
    return page<Data>({ state: "done", studyName: live.study.name });
  },
});

export default define.page<typeof handler>(({ data }) => {
  if (data.state === "closed") {
    return (
      <PublicLayout title="Not available">
        <p class="text-sm text-gray-700">
          This link is invalid, has expired, or is no longer needed. Please
          contact the research team for a fresh link.
        </p>
      </PublicLayout>
    );
  }
  if (data.state === "already") {
    return (
      <PublicLayout title="Already signed">
        <p class="text-sm text-gray-700">
          You have already signed the current consent form for{" "}
          <strong>{data.studyName}</strong>. Nothing more to do.
        </p>
      </PublicLayout>
    );
  }
  if (data.state === "done") {
    return (
      <PublicLayout title="Consent recorded">
        <p class="text-sm text-gray-700">
          Thank you — your consent for <strong>{data.studyName}</strong>{" "}
          has been recorded. The research team will be in touch with next steps.
        </p>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout title={`${data.studyName} — consent form`}>
      <div class="space-y-6">
        {data.reconsent && (
          <p class="rounded-card border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            The consent form has been updated since you last signed. Please
            review and sign the new version below.
          </p>
        )}
        <article class="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-card border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800">
          {data.content}
        </article>
        <p class="text-xs text-gray-500">Consent form version {data.version}</p>

        <form method="post" class="space-y-4">
          {data.error && (
            <p
              role="alert"
              class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {data.error}
            </p>
          )}
          <label class="flex flex-col gap-1 text-sm">
            Type your full name as your signature
            <input
              type="text"
              name="signature"
              required
              value={data.signatureName ?? ""}
              class="w-full max-w-md rounded-card border border-gray-300 px-3 py-2"
            />
          </label>
          <label class="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              name="recontact"
              value="1"
              checked={data.recontact ?? false}
              class="mt-0.5"
            />
            The research team may contact me about future studies.
          </label>
          <p class="text-xs text-gray-500">
            Your signature is stored encrypted. By submitting you agree to the
            consent form shown above.
          </p>
          <button
            type="submit"
            class="rounded-card bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            I agree — sign and submit
          </button>
        </form>
      </div>
    </PublicLayout>
  );
});
