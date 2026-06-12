// Server-render tests for the OOUI components (pure Preact, no Fresh).
import assert from "node:assert/strict";
import { render } from "preact-render-to-string";
import { StatusBadge } from "./StatusBadge.tsx";
import { Chip } from "./Chip.tsx";
import { ActionBar } from "./ActionBar.tsx";
import { CollectionView } from "./CollectionView.tsx";
import { DetailView } from "./DetailView.tsx";
import {
  applyCollection,
  parseCollectionParams,
} from "../../lib/ooui/collection.ts";
import { resolveActions } from "../../lib/ooui/actions.ts";
import { Stepper } from "./Stepper.tsx";

Deno.test("Stepper: done/current/todo states", () => {
  const steps = ["draft", "irb_review", "recruiting", "running", "analysis"];
  const html = render(<Stepper steps={steps} current="recruiting" />);
  assert.equal(html.match(/data-step-state="done"/g)?.length, 2);
  assert.equal(html.match(/data-step-state="current"/g)?.length, 1);
  assert.equal(html.match(/data-step-state="todo"/g)?.length, 2);
  assert.ok(html.includes("✓"));

  // Archived (not on the forward path): every step renders as off.
  const off = render(<Stepper steps={steps} current="archived" />);
  assert.equal(off.match(/data-step-state="off"/g)?.length, 5);
});

Deno.test("StatusBadge: labels and tones", () => {
  const html = render(<StatusBadge status="irb_review" />);
  assert.ok(html.includes("IRB review"));
  assert.ok(html.includes('data-status="irb_review"'));

  const pilot = render(<StatusBadge status="pilot" />);
  assert.ok(pilot.includes("uppercase"), "pilot badge must be loud");
});

Deno.test("Chip: link with label, sublabel and status", () => {
  const html = render(
    <Chip href="/studies/s1" icon="⚗" label="Pilot run" status="pilot" />,
  );
  assert.ok(html.includes('href="/studies/s1"'));
  assert.ok(html.includes("Pilot run"));
  assert.ok(html.includes('data-status="pilot"'));
});

Deno.test("ActionBar: enabled POST form, GET link, disabled with reason", () => {
  const html = render(
    <ActionBar
      actions={resolveActions(
        [
          { id: "go", label: "Go", href: "/go" },
          { id: "open", label: "Open", href: "/open", method: "get" },
          { id: "del", label: "Delete", href: "/del", minRole: "pi" },
        ],
        { role: "assistant" },
      )}
    />,
  );
  assert.ok(html.includes('action="/go"'));
  assert.ok(html.includes('href="/open"'));
  assert.ok(html.includes("disabled"));
  assert.ok(html.includes("Requires pi role"));
});

Deno.test("CollectionView: rows, sort indicator, pagination, empty state", () => {
  const rows = Array.from(
    { length: 60 },
    (_, i) => ({ id: `id${i}`, name: `Item ${i}` }),
  );
  const result = applyCollection(
    rows,
    parseCollectionParams(new URLSearchParams("sort=name")),
    { sorters: { name: (a, b) => a.name.localeCompare(b.name) } },
  );
  const html = render(
    <CollectionView
      baseHref="/items"
      columns={[{
        id: "name",
        label: "Name",
        sortable: true,
        render: (r) => r.name,
      }]}
      result={result}
      rowId={(r) => r.id}
      rowHref={(r) => `/items/${r.id}`}
    />,
  );
  assert.ok(html.includes("1–50 of 60"));
  assert.ok(html.includes("Next →"));
  assert.ok(!html.includes("← Previous"));
  assert.ok(html.includes("↑"), "active sort indicator");
  assert.ok(html.includes('href="/items/id0"'));

  const empty = render(
    <CollectionView
      baseHref="/items"
      columns={[{
        id: "name",
        label: "Name",
        render: (r: { name: string }) => r.name,
      }]}
      result={applyCollection(
        [],
        parseCollectionParams(new URLSearchParams()),
        {},
      )}
      rowId={() => ""}
      emptyMessage="Nothing!"
    />,
  );
  assert.ok(empty.includes("Nothing!"));
});

Deno.test("DetailView: identity header, properties, tabs, action bar", () => {
  const html = render(
    <DetailView
      icon="⚗"
      typeLabel="Study"
      title="My Study"
      status="draft"
      properties={[{ label: "Target N", value: "24" }]}
      tabs={[{ id: "overview", label: "Overview" }, {
        id: "data",
        label: "Data",
      }]}
      activeTab="data"
      baseHref="/studies/s1"
      actions={resolveActions([{ id: "a", label: "Act", href: "/a" }], {
        role: "pi",
      })}
    >
      <p>tab content</p>
    </DetailView>,
  );
  assert.ok(html.includes("My Study"));
  assert.ok(html.includes('data-status="draft"'));
  assert.ok(html.includes("Target N"));
  assert.ok(html.includes('href="/studies/s1?tab=overview"'));
  assert.ok(html.includes("tab content"));
  assert.ok(html.includes('action="/a"'));
});
