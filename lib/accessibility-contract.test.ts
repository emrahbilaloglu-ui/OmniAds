import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Accessibility contract for the Tier-0 surfaces this programme changed.
 *
 * These assert on the shipped markup rather than on a rendered screenshot,
 * because the properties that matter here are structural: an icon-only control
 * either carries a name or it does not, a disabled control either explains
 * itself or leaves the operator guessing, an error either announces itself to a
 * screen reader or is only visible to people who can see it.
 *
 * The live browser behaviours — focus order, dialog trap, Escape, restoration,
 * 200% zoom, reduced motion — are asserted in the full-UI smoke, where a real
 * browser can actually exercise them. This file covers what static structure can
 * honestly prove; the two are complementary, and neither alone is "accessible".
 */
const FILES = {
  agencyToday: "components/overview/AgencyToday.tsx",
  globalSearch: "components/layout/GlobalSearch.tsx",
  savedViews: "components/views/SavedViewsMenu.tsx",
  workflow: "components/meta/os/DecisionWorkflowControls.tsx",
  guarded: "components/meta/os/GuardedActionPanel.tsx",
  freshness: "components/states/FreshnessChip.tsx",
  topbar: "components/layout/topbar.tsx",
} as const;

function read(key: keyof typeof FILES): string {
  return readFileSync(FILES[key], "utf8");
}

describe("every control can be reached and named without sight", () => {
  it("gives icon-only controls an accessible name", () => {
    // An icon with no name is a control a screen reader announces as "button".
    // The bell is icon-only and now lives in its own component, so the check
    // follows it there rather than passing because the topbar happens to hold
    // some other labelled control.
    expect(
      readFileSync("components/notifications/NotificationBell.tsx", "utf8"),
    ).toContain("aria-label");
    const savedViews = read("savedViews");
    expect(savedViews).toContain("aria-label={`Delete view ${view.name}`}");
  });

  it("labels the free-text inputs it renders", () => {
    expect(read("workflow")).toContain(
      'aria-label="Reason for disagreeing with this decision"',
    );
  });

  it("marks the search listbox and its options", () => {
    const search = read("globalSearch");
    expect(search).toContain('role="option"');
    expect(search).toContain("aria-expanded");
  });

  it("exposes the saved-views menu state", () => {
    expect(read("savedViews")).toContain("aria-expanded={open}");
  });
});

describe("a disabled control says why it is disabled", () => {
  it("explains the workflow reason requirement rather than just greying out", () => {
    const workflow = read("workflow");
    expect(workflow).toContain("Disagreeing requires a reason");
    // The explanation is on the control itself, not only in prose elsewhere.
    expect(workflow).toContain("title={");
  });

  it("explains an unavailable saved view", () => {
    const savedViews = read("savedViews");
    expect(savedViews).toContain("title={reason ?? undefined}");
    expect(savedViews).toContain("— unavailable");
  });

  it("names the bell's state rather than leaving it unexplained", () => {
    // Superseded: the bell used to be disabled with "not available yet",
    // because no producer wrote notification events. The producer now runs on
    // the maintenance cron, so the bell works — and its accessible name has to
    // distinguish the three states a sighted user reads from the badge, since
    // an absent badge and an unreadable count look identical to a screen
    // reader otherwise.
    const bell = readFileSync(
      "components/notifications/NotificationBell.tsx",
      "utf8",
    );
    expect(bell).toContain("Notifications — count unavailable");
    expect(bell).toContain("Notifications — loading");
    expect(bell).toContain("unacknowledged`");
  });
});

describe("state changes are announced, not only shown", () => {
  it("marks the workflow failure as an error region", () => {
    expect(read("workflow")).toContain('data-workflow-error="true"');
  });

  it("states the guarded-action capability as data, not colour alone", () => {
    const guarded = read("guarded");
    expect(guarded).toContain("data-guarded-action=");
    // The capability's reason is rendered as text, so a limited action explains
    // itself rather than relying on a greyed-out appearance.
    expect(guarded).toContain("capability.reason");
  });

  it("says when ownership tracking is unavailable instead of showing no owner", () => {
    expect(read("workflow")).toContain('data-workflow-state="unavailable"');
  });

  it("renders freshness in every case, including unknown", () => {
    const freshness = read("freshness");
    // Silence would read as "current", which is the failure this prevents.
    expect(freshness).toContain("unknown");
    expect(freshness).toContain("title={reading.description}");
  });
});

describe("pressable rows are real controls", () => {
  it("uses a link for a navigating client row rather than a click handler on a div", () => {
    const agency = read("agencyToday");
    expect(agency).toContain("<Link");
    expect(agency).toContain("href={row.href}");
  });

  it("marks selection state on decision rows", () => {
    const decisions = readFileSync(
      "components/meta/os/DecisionsOsView.tsx",
      "utf8",
    );
    expect(decisions).toContain("aria-pressed={selected}");
  });
});

describe("long and localised text cannot break the layout", () => {
  it("allows narrow surfaces to wrap rather than overflow", () => {
    const globals = readFileSync("app/globals.css", "utf8");
    expect(globals).toContain("overflow-wrap: anywhere");
  });

  it("keeps the mobile card composition for tabular data", () => {
    const globals = readFileSync("app/globals.css", "utf8");
    expect(globals).toContain("table-layout: fixed");
    expect(globals).toContain("@media (max-width: 767px)");
  });
});
