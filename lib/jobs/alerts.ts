// Failure alerts for background work (spec §3.8: "failure alerts via
// notification adapter"). The Discord webhook adapter (Phase 3.9) and/or
// email register a real sink at startup; until then alerts go to the
// console. Kept tiny and swappable so the job runner never hard-depends on
// a channel that may not exist yet.

export interface Alert {
  /** Namespaced reason, e.g. "message.delivery_failed", "job.failed". */
  kind: string;
  /** Human-readable detail — must not contain PII. */
  detail: string;
}

export interface AlertSink {
  notify(alert: Alert): Promise<void> | void;
}

const consoleSink: AlertSink = {
  notify(alert) {
    console.error(`[alert] ${alert.kind}: ${alert.detail}`);
  },
};

let sink: AlertSink = consoleSink;

/** Registers the process-wide alert sink (Phase 3.9 wires Discord). */
export function setAlertSink(next: AlertSink): void {
  sink = next;
}

/** Resets to the console sink (tests). */
export function resetAlertSink(): void {
  sink = consoleSink;
}

export async function alert(a: Alert): Promise<void> {
  try {
    await sink.notify(a);
  } catch (err) {
    // An alert sink must never break the caller; fall back to the console.
    console.error(`[alert] sink failed for ${a.kind}: ${err}`);
  }
}
