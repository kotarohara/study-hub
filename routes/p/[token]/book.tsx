// Participant self-booking page (spec §4 kept-feature 2): reached via a
// purpose-scoped magic link. Shows the study's open slots and the
// participant's current booking; supports book, reschedule (move) and
// cancel. Rate-limited; no Turnstile (the token is the capability).
import { page } from "fresh";
import { define } from "../../../utils.ts";
import { getDb } from "../../../lib/db/client.ts";
import { RateLimiter } from "../../../lib/rate_limit.ts";
import { clientHost } from "../../../lib/auth/limiters.ts";
import { getStudy } from "../../../lib/objects/studies.ts";
import { getEnrollment, isTerminal } from "../../../lib/objects/enrollments.ts";
import type { StudySession } from "../../../lib/db/schema.ts";
import {
  bookSession,
  calendarLinkFor,
  cancelBooking,
  getSession,
  listOpenSlots,
  listSessionsOfEnrollment,
  rescheduleBooking,
  SessionError,
  verifyBookingToken,
} from "../../../lib/objects/sessions.ts";
import { PublicLayout } from "../../../components/PublicLayout.tsx";

const bookLimiter = new RateLimiter({ capacity: 12, refillPerSecond: 1 / 60 });

interface SlotView {
  id: string;
  startsAt: string;
  endsAt: string;
  location: string;
}

interface Data {
  state: "closed" | "form" | "done";
  studyName?: string;
  booking?: SlotView | null;
  slots?: SlotView[];
  /** Subscribable .ics feed of this participant's sessions. */
  calendarUrl?: string;
  error?: string;
  doneMessage?: string;
}

const CLOSED = { state: "closed" } as const;

function view(s: StudySession): SlotView {
  return {
    id: s.id,
    startsAt: s.startsAt.toISOString().slice(0, 16).replace("T", " "),
    endsAt: s.endsAt.toISOString().slice(11, 16),
    location: s.location,
  };
}

async function load(token: string) {
  const enrollmentId = verifyBookingToken(token);
  if (!enrollmentId) return null;
  const db = getDb();
  const enrollment = await getEnrollment(db, enrollmentId);
  if (!enrollment || isTerminal(enrollment.status)) return null;
  const study = await getStudy(db, enrollment.studyId);
  if (!study) return null;
  return { db, enrollment, study };
}

async function render(
  live: NonNullable<Awaited<ReturnType<typeof load>>>,
  extra: Partial<Data> = {},
): Promise<Data> {
  const booked = (await listSessionsOfEnrollment(live.db, live.enrollment.id))
    .find((s) => s.status === "booked");
  const slots = await listOpenSlots(live.db, live.study.id);
  return {
    state: "form",
    studyName: live.study.name,
    booking: booked ? view(booked) : null,
    slots: slots.map(view),
    calendarUrl: calendarLinkFor(live.enrollment),
    ...extra,
  };
}

export const handler = define.handlers({
  async GET(ctx) {
    const live = await load(ctx.params.token);
    if (!live) return page<Data>(CLOSED, { status: 404 });
    return page<Data>(await render(live));
  },
  async POST(ctx) {
    if (!bookLimiter.check(clientHost(ctx.info))) {
      return new Response("Too many requests — try again later.", {
        status: 429,
      });
    }
    const live = await load(ctx.params.token);
    if (!live) return page<Data>(CLOSED, { status: 404 });

    const form = await ctx.req.formData();
    const action = String(form.get("action") ?? "");
    const auditCtx = {
      requestId: ctx.state.requestId,
      ip: clientHost(ctx.info),
    };

    try {
      if (action === "cancel") {
        const session = await ownBooking(live, String(form.get("sessionId")));
        await cancelBooking(live.db, { session, actor: null, ...auditCtx });
        return page<Data>({
          state: "done",
          studyName: live.study.name,
          doneMessage: "Your booking has been cancelled.",
        });
      }

      const slot = await getSession(live.db, String(form.get("slotId") ?? ""));
      if (!slot || slot.studyId !== live.study.id) {
        return page<Data>(
          await render(live, { error: "That slot is no longer available." }),
          { status: 400 },
        );
      }

      const current =
        (await listSessionsOfEnrollment(live.db, live.enrollment.id))
          .find((s) => s.status === "booked");
      if (current) {
        await rescheduleBooking(live.db, {
          from: current,
          to: slot,
          enrollment: live.enrollment,
          actor: null,
          ...auditCtx,
        });
      } else {
        await bookSession(live.db, {
          session: slot,
          enrollment: live.enrollment,
          actor: null,
          ...auditCtx,
        });
      }
      return page<Data>({
        state: "done",
        studyName: live.study.name,
        doneMessage: "Your session is booked. See you then!",
      });
    } catch (err) {
      if (err instanceof SessionError) {
        return page<Data>(await render(live, { error: err.message }), {
          status: 409,
        });
      }
      throw err;
    }
  },
});

/** Loads a session and confirms it is this enrollment's active booking. */
async function ownBooking(
  live: NonNullable<Awaited<ReturnType<typeof load>>>,
  sessionId: string,
) {
  const session = await getSession(live.db, sessionId);
  if (
    !session || session.enrollmentId !== live.enrollment.id ||
    session.status !== "booked"
  ) {
    throw new SessionError("That booking could not be found.");
  }
  return session;
}

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
  if (data.state === "done") {
    return (
      <PublicLayout title="All set">
        <p class="text-sm text-gray-700">{data.doneMessage}</p>
      </PublicLayout>
    );
  }

  const { booking, slots = [] } = data;
  return (
    <PublicLayout title={`${data.studyName} — book a session`}>
      <div class="space-y-6">
        {data.error && (
          <p class="rounded-card border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {data.error}
          </p>
        )}

        {booking
          ? (
            <section class="space-y-2 rounded-card border border-brand-200 bg-brand-50 p-4">
              <h2 class="text-sm font-semibold text-gray-900">Your session</h2>
              <p class="text-sm text-gray-800">
                {booking.startsAt} – {booking.endsAt}
                {booking.location && ` · ${booking.location}`}
              </p>
              <form method="post" data-confirm="Cancel your booking?">
                <input type="hidden" name="action" value="cancel" />
                <input type="hidden" name="sessionId" value={booking.id} />
                <button
                  type="submit"
                  class="rounded-card border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                >
                  Cancel booking
                </button>
              </form>
            </section>
          )
          : (
            <p class="text-sm text-gray-700">
              Pick a slot below to book your session.
            </p>
          )}

        {booking && data.calendarUrl && (
          <p class="text-xs text-gray-500">
            Add your sessions to your calendar app:{" "}
            <a
              href={data.calendarUrl}
              class="break-all text-brand-700 underline"
            >
              subscribe (.ics)
            </a>
          </p>
        )}

        <section class="space-y-2">
          <h2 class="text-sm font-semibold text-gray-900">
            {booking ? "Move to a different slot" : "Available slots"}
          </h2>
          {slots.length === 0
            ? (
              <p class="text-sm text-gray-500">
                No open slots right now — please check back later.
              </p>
            )
            : (
              <ul class="space-y-2">
                {slots.map((slot) => (
                  <li
                    key={slot.id}
                    class="flex items-center justify-between rounded-card border border-gray-200 bg-white p-3"
                  >
                    <span class="text-sm text-gray-800">
                      {slot.startsAt} – {slot.endsAt}
                      {slot.location && ` · ${slot.location}`}
                    </span>
                    <form method="post">
                      <input type="hidden" name="action" value="book" />
                      <input type="hidden" name="slotId" value={slot.id} />
                      <button
                        type="submit"
                        class="rounded-card bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
                      >
                        {booking ? "Move here" : "Book"}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </PublicLayout>
  );
});
