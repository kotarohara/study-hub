// The permanent, prominent pilot badge (spec §3.3): shown on EVERY view of
// an Internal Pilot study, never restyled or toned down.
export function PilotBanner() {
  return (
    <div
      class="rounded-card border-2 border-pilot-border bg-pilot-bg px-4 py-2 text-sm font-bold uppercase tracking-wide text-pilot-text"
      data-pilot-banner
    >
      Pilot — not IRB reviewed
      <span class="ml-2 font-normal normal-case tracking-normal">
        Data is quarantined and excluded from publishable exports by default. No
        public recruitment.
      </span>
    </div>
  );
}
