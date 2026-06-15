// Issues a Telegram pairing deep link for a participant (assistant+). The
// participant taps it, the bot receives `/start <token>`, and their chat
// becomes a verified telegram channel (spec §3.7). Shown for manual sending
// alongside the other contact channels.
import { HttpError, page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { hasRole } from "../../../lib/auth/roles.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { audit } from "../../../lib/audit/log.ts";
import { getParticipant } from "../../../lib/objects/participants.ts";
import {
  TELEGRAM_PAIR_TTL_SECONDS,
  telegramDeepLink,
} from "../../../lib/objects/telegram.ts";
import { Layout } from "../../../components/Layout.tsx";
import { Chip } from "../../../components/ooui/Chip.tsx";

interface Data {
  participantId: string;
  participantCode: string;
  link: string | null;
  reason?: string;
}

export const handler = define.handlers({
  async GET(ctx) {
    const me = ctx.state.member!;
    if (!hasRole(me.role, "assistant")) throw new HttpError(403);
    const db = getDb();
    const participant = await getParticipant(db, ctx.params.id);
    if (!participant) throw new HttpError(404);

    let link: string | null = null;
    let reason: string | undefined;
    if (participant.doNotContact) {
      reason = `${participant.code} is flagged do-not-contact.`;
    } else {
      link = telegramDeepLink(participant);
      if (!link) {
        reason = "Telegram is not configured for this StudyHub instance.";
      }
    }

    if (link) {
      await audit(db, {
        action: "participant.telegram_link_issued",
        actorId: me.id,
        objectType: "participant",
        objectId: participant.id,
        details: {
          code: participant.code,
          ttlDays: TELEGRAM_PAIR_TTL_SECONDS / 86400,
        },
        requestId: ctx.state.requestId,
        ip: clientHost(ctx.info),
      });
    }

    return page<Data>({
      participantId: participant.id,
      participantCode: participant.code,
      link,
      reason,
    });
  },
});

export default define.page<typeof handler>(({ data, state, url }) => (
  <Layout member={state.member!} pathname={url.pathname} title="Telegram link">
    <div class="mb-4">
      <Chip
        href={`/participants/${data.participantId}?tab=channels`}
        icon="◉"
        label={data.participantCode}
      />
    </div>
    {data.link
      ? (
        <div class="max-w-2xl space-y-3 rounded-card border border-gray-200 bg-white p-4">
          <p class="text-sm text-gray-700">
            Send this pairing link to the participant (valid for{" "}
            {TELEGRAM_PAIR_TTL_SECONDS / 86400}{" "}
            days). Tapping it opens Telegram and connects their chat, so
            reminders go there instead of email. They can send{" "}
            <code>/stop</code> any time to switch back.
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
