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
  commandPalette: "components/layout/v2/command-palette.tsx",
  savedViews: "components/views/SavedViewsMenu.tsx",
  decisions: "components/meta/decision-center/MetaDecisionCenterExact.tsx",
  decisionsPage: "components/meta/redesign/MetaPlatformPage.tsx",
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
    // The Decision Center's lane toolbar is the surface's only free text entry
    // plus a select; both are unlabelled visually, so the name has to be given.
    const decisions = read("decisions");
    expect(decisions).toContain('aria-label="Search entities"');
    expect(decisions).toContain('aria-label="Sort decisions"');
  });

  it("marks the search listbox and its options", () => {
    expect(read("globalSearch")).toContain("aria-expanded");
    const palette = read("commandPalette");
    expect(palette).toContain('role="listbox"');
    expect(palette).toContain('role="option"');
  });

  it("exposes the saved-views menu state", () => {
    expect(read("savedViews")).toContain("aria-expanded={open}");
  });
});

describe("a disabled control says why it is disabled", () => {
  it("explains an action the server did not supply rather than just dimming it", () => {
    // A verdict CTA whose whole label is an em dash announces as an unnamed
    // dimmed button. The name has to say why it is inert, on the control.
    const decisions = read("decisions");
    expect(decisions).toContain("function unservedActionName(");
    expect(decisions).toContain("No action available:");
    // Design-pinned spans that carry no callback are marked inert rather than
    // silently swallowing clicks while still looking pressable.
    expect(decisions).toContain('"aria-disabled": callback ? undefined : true');
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
  it("announces a failed decision action instead of only tinting a banner", () => {
    // Every refusal and outcome lands in one notice; a failure has to be an
    // assertive region or a screen reader never learns the click did nothing.
    const page = read("decisionsPage");
    expect(page).toContain('role={notice.tone === "danger" ? "alert" : "status"}');
  });

  it("states a withheld decision action as text, not colour alone", () => {
    // A read-only viewer, an engaged kill switch and a review-only verdict all
    // produce a click that cannot write. Each says so in the notice detail
    // rather than relying on a dimmed button.
    const page = read("decisionsPage");
    expect(page).toContain('title: "Read-only access."');
    expect(page).toContain('title: "Recommendation is review-only."');
    expect(page).toContain("detail:");
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

  it("marks the pressed state on the decision scope and lane controls", () => {
    // The reference draws these as spans. They keep the tag and gain the role,
    // the tab stop and the pressed state, so the queue is operable without a
    // mouse and a screen reader can tell which lane is showing.
    //
    // The window control is no longer among them: it was removed from this
    // header because the shell topbar picker already owns the window, and two
    // controls for one value is two writers for one value. Its absence is
    // pinned in MetaDecisionCenterExact.test.tsx; what matters HERE is that
    // the controls that remain are still operable without a mouse.
    const decisions = read("decisions");
    expect(decisions).toContain("aria-pressed={activeScope === \"structure\"}");
    expect(decisions).toContain("aria-pressed={activeLane === item.id}");
    expect(decisions).not.toContain("aria-pressed={activeWindow === window}");
    expect(decisions).toContain("function activate(");
    expect(decisions).toContain('event.key !== "Enter" && event.key !== " "');
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
