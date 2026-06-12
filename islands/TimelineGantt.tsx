// Gantt-style timeline island (spec §3.7, §2.2 #4): milestones as bars on
// a month-scaled axis; dated bars can be dragged horizontally to
// reschedule (direct manipulation). Geometry lives in lib/ooui/gantt.ts.
import { useRef, useState } from "preact/hooks";
import {
  barGeometry,
  type GanttItem,
  type GanttRange,
  monthTicks,
  shiftIsoDate,
} from "../lib/ooui/gantt.ts";

const STATUS_CLASSES: Record<string, string> = {
  pending: "bg-gray-300",
  in_progress: "bg-blue-400",
  done: "bg-green-400",
};

export interface TimelineGanttProps {
  items: GanttItem[];
  /** Serialized range (island props must be JSON-safe). */
  rangeStartIso: string;
  rangeDays: number;
  editable: boolean;
}

export default function TimelineGantt(props: TimelineGanttProps) {
  const range: GanttRange = {
    start: new Date(props.rangeStartIso + "T00:00:00Z"),
    days: props.rangeDays,
  };
  const chartRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<
    { id: string; startX: number; deltaDays: number } | null
  >(null);
  const [saving, setSaving] = useState(false);

  const dated = props.items.filter((i) => i.start ?? i.due);
  const undated = props.items.filter((i) => !(i.start ?? i.due));
  const ticks = monthTicks(range);
  const today = new Date().toISOString().slice(0, 10);
  const todayPct =
    ((new Date(today + "T00:00:00Z").getTime() - range.start.getTime()) /
      (range.days * 24 * 3600 * 1000)) * 100;

  function deltaDaysFromPx(dx: number): number {
    const width = chartRef.current?.getBoundingClientRect().width ?? 1;
    return Math.round(dx / (width / range.days));
  }

  function onPointerDown(event: PointerEvent, id: string) {
    if (!props.editable || saving) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({ id, startX: event.clientX, deltaDays: 0 });
  }

  function onPointerMove(event: PointerEvent) {
    if (!drag) return;
    setDrag({
      ...drag,
      deltaDays: deltaDaysFromPx(event.clientX - drag.startX),
    });
  }

  async function onPointerUp() {
    if (!drag) return;
    const { id, deltaDays } = drag;
    setDrag(null);
    if (deltaDays === 0) return;
    const item = props.items.find((i) => i.id === id);
    if (!item) return;

    setSaving(true);
    const body = new FormData();
    body.set("startsOn", item.start ? shiftIsoDate(item.start, deltaDays) : "");
    body.set("dueOn", item.due ? shiftIsoDate(item.due, deltaDays) : "");
    const res = await fetch(`/milestones/${id}/reschedule`, {
      method: "POST",
      body,
    });
    if (res.ok) {
      location.reload();
    } else {
      setSaving(false);
      alert(`Could not reschedule: ${await res.text()}`);
    }
  }

  if (dated.length === 0) {
    return (
      <p class="text-sm text-gray-500">
        Give milestones due dates to see them on the timeline.
      </p>
    );
  }

  return (
    <div class="rounded-card border border-gray-200 bg-white p-3">
      {/* Month axis */}
      <div class="relative ml-40 h-5 text-xs text-gray-500">
        {ticks.map((tick) => (
          <span
            key={tick.label}
            class="absolute border-l border-gray-200 pl-1"
            style={{ left: `${tick.leftPct}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      <div class="space-y-1">
        {dated.map((item) => {
          const geometry = barGeometry(item, range)!;
          const dragging = drag?.id === item.id;
          const offsetPct = dragging ? (drag!.deltaDays / range.days) * 100 : 0;
          return (
            <div key={item.id} class="flex items-center gap-2">
              <span
                class="w-38 shrink-0 truncate text-right text-xs text-gray-700"
                style={{ width: "9.5rem" }}
                title={item.title}
              >
                {item.title}
              </span>
              <div
                ref={chartRef}
                class="relative h-5 flex-1 rounded bg-gray-50"
              >
                {todayPct >= 0 && todayPct <= 100 && (
                  <span
                    class="absolute top-0 h-full border-l-2 border-red-300"
                    style={{ left: `${todayPct}%` }}
                  />
                )}
                <div
                  class={`absolute top-0.5 h-4 rounded ${
                    STATUS_CLASSES[item.status] ?? "bg-gray-300"
                  } ${item.blocked ? "ring-2 ring-red-300" : ""} ${
                    props.editable ? "cursor-grab" : ""
                  } ${dragging ? "opacity-70" : ""}`}
                  style={{
                    left: `${geometry.leftPct + offsetPct}%`,
                    width: `${geometry.widthPct}%`,
                    touchAction: "none",
                  }}
                  title={`${item.title} (${item.start ?? "—"} → ${
                    item.due ?? "—"
                  })${item.blocked ? " · blocked" : ""}`}
                  onPointerDown={(e) => onPointerDown(e, item.id)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                />
              </div>
              {dragging && drag!.deltaDays !== 0 && (
                <span class="w-12 text-xs text-gray-500">
                  {drag!.deltaDays > 0 ? "+" : ""}
                  {drag!.deltaDays}d
                </span>
              )}
            </div>
          );
        })}
      </div>

      {undated.length > 0 && (
        <p class="mt-2 text-xs text-gray-400">
          No dates yet: {undated.map((i) => i.title).join(", ")}
        </p>
      )}
      {props.editable && (
        <p class="mt-2 text-xs text-gray-400">
          Drag a bar to reschedule (whole days).
        </p>
      )}
    </div>
  );
}
