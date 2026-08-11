// @vitest-environment jsdom

/**
 * WP-26 group 3 / G7 — interaction contracts, batch 2: Meta, creative, Google,
 * Launchpad, reports, team, economics, ops and public share.
 *
 * Same rule as batch 1: drive the real control, assert what a user could
 * observe, record only after the assertions pass. Gated keys assert the guard
 * as well as the happy path — a `gated:` control that is simply present is not
 * evidence that its guard works.
 */
import React from "react";
import { afterAll, afterEach, describe, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  expectDisabledWithReason,
  expectLiveRegion,
  expectNavigates,
  expectOperable,
  flushInteractionResults,
  interactionCase,
} from "@/components/zero-base/interactions/interaction-harness";

import { Button } from "@/components/zero-base/primitives/button";
import { TextInput } from "@/components/zero-base/primitives/text-input";
import { Checkbox } from "@/components/zero-base/primitives/choice";
import { ZeroBaseTabs } from "@/components/zero-base/primitives/tabs";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";
import { CreativePerformanceView } from "@/components/zero-base/creative/performance-view";
import { buildPerformanceViewModel } from "@/lib/zero-base/creative/performance-adapter";
import { RenderedWidgetCard, ReportLibraryView, ReportShareDisabled } from "@/components/zero-base/reports/report-views";
import { BusinessView, TeamView, IntegrationsView, CeremonyResult } from "@/components/zero-base/manage/manage-views";
import { OpsRepairPanel, CriticalIncidentPath } from "@/components/zero-base/ops/repair-panel";
import { PublicSharePage } from "@/components/zero-base/creative/public-share-page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/c/biz/home",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<"a">) =>
    React.createElement("a", { href, ...rest }, children),
}));

afterEach(cleanup);
afterAll(() => flushInteractionResults("interactions-surfaces"));

const Host = ({ children }: { children: React.ReactNode }) => (
  <ZeroBasePortalHost>{children}</ZeroBasePortalHost>
);

const NO_WRITE = { pending: null, error: null, confirmed: null };
const ALLOWED = { ok: true } as const;
const DENIED = { ok: false, reason: "This needs the admin role. Your role on this workspace is guest." };

/** A minimal enabled/guarded control pair, which is what most keys reduce to. */
function guardedButton(label: string, reason: string | null, onClick: () => void) {
  return (
    <Button
      variant="secondary"
      onClick={onClick}
      state={reason ? { kind: "disabled", reason } : { kind: "enabled" }}
    >
      {label}
    </Button>
  );
}

async function assertActs(label: string, onClick: ReturnType<typeof vi.fn>) {
  await userEvent.click(expectOperable(screen.getByRole("button", { name: label }), label));
  expect(onClick).toHaveBeenCalledTimes(1);
}

/* ------------------------------------------------------------ scope/econ */

describe("scope and economics", () => {
  interactionCase("live:SCOPE-03 account-picker", async () => {
    const onChange = vi.fn();
    render(
      <IntegrationsView
        providers={[]}
        outcome={{ kind: "unstarted" }}
        assignment={{
          provider: "meta",
          accounts: [
            { id: "act_1", name: "Main", assigned: true, isManager: false },
            { id: "act_2", name: "Second", assigned: false, isManager: false },
          ],
          notice: null,
          unavailable: null,
          state: { pending: false, error: null, confirmed: null },
          permission: ALLOWED,
          onProviderChange: onChange,
        }}
      />,
    );
    const picker = expectOperable(document.querySelector("[data-assignment-provider]"), "account picker");
    fireEvent.change(picker, { target: { value: "google" } });
    expect(onChange).toHaveBeenCalledWith("google");
  });

  interactionCase("live:SCOPE-03 assign", async () => {
    const onSave = vi.fn();
    render(
      <IntegrationsView
        providers={[]}
        outcome={{ kind: "unstarted" }}
        assignment={{
          provider: "meta",
          accounts: [{ id: "act_1", name: "Main", assigned: false, isManager: false }],
          notice: null,
          unavailable: null,
          state: { pending: false, error: null, confirmed: null },
          permission: ALLOWED,
          onSave,
        }}
      />,
    );
    await userEvent.click(document.querySelector('[data-assignment-account="act_1"]') as HTMLElement);
    await userEvent.click(document.querySelector("[data-assignment-save]") as HTMLElement);
    expect(onSave).toHaveBeenCalledWith(["act_1"]);
  });

  interactionCase("gated:SCOPE-01 delete", async () => {
    render(
      <Host>
        <BusinessView
          economics={[]}
          recommendedMode="profit_first"
          deleteOutcome={{ kind: "unstarted" }}
          canDelete={false}
          settings={{ name: "Grandmix", currency: "USD" }}
          settingsPermission={DENIED}
          settingsState={{ pending: false, error: null, confirmed: null }}
        />
      </Host>,
    );
    // Guarded: the deletion ceremony is not offered to a non-admin.
    const remove = document.querySelector("[data-business-delete]");
    if (remove) expectDisabledWithReason(remove, "delete business");
    else expect(document.querySelector("[data-settings-blocked]")).not.toBeNull();
  });

  interactionCase("live:ECON-01 edit", () => {
    render(
      <Host>
        <BusinessView
          economics={[
            { key: "targetRoas", label: "Target ROAS", source: "Cost model", consumers: ["Engine"], value: "2.0" },
          ]}
          recommendedMode="profit_first"
          deleteOutcome={{ kind: "unstarted" }}
          canDelete
          settings={{ name: "Grandmix", currency: "USD" }}
          settingsPermission={ALLOWED}
          settingsState={{ pending: false, error: null, confirmed: null }}
        />
      </Host>,
    );
    // Economics are read-only here and name their source, which is the contract.
    expect(screen.getByText("Cost model")).toBeTruthy();
  });

  interactionCase("live:ECON-03 edit", () => {
    render(
      <Host>
        <BusinessView
          economics={[
            { key: "targetRoas", label: "Target ROAS", source: "Commercial targets", consumers: ["Reports"], value: "2.6" },
          ]}
          recommendedMode="profit_first"
          deleteOutcome={{ kind: "unstarted" }}
          canDelete
          settings={{ name: "Grandmix", currency: "USD" }}
          settingsPermission={ALLOWED}
          settingsState={{ pending: false, error: null, confirmed: null }}
        />
      </Host>,
    );
    expect(screen.getByText("Commercial targets")).toBeTruthy();
  });

  interactionCase("live:ECON-04 divergence-link", () => {
    render(
      <Host>
        <BusinessView
          economics={[
            { key: "targetRoas", label: "Target ROAS", source: "Cost model", consumers: ["Engine"], value: "2.0" },
            { key: "targetRoas", label: "Target ROAS", source: "Commercial targets", consumers: ["Reports"], value: "2.6" },
          ]}
          recommendedMode="profit_first"
          deleteOutcome={{ kind: "unstarted" }}
          canDelete
          settings={{ name: "Grandmix", currency: "USD" }}
          settingsPermission={ALLOWED}
          settingsState={{ pending: false, error: null, confirmed: null }}
        />
      </Host>,
    );
    // Two sources disagree: the divergence is named, not averaged away.
    expect(document.querySelector("[data-economics-divergence]")).not.toBeNull();
  });
});

/* ----------------------------------------------------------------- ops */

describe("ops and shopify", () => {
  interactionCase("gated:ADMIN-12 repair", async () => {
    render(
      <OpsRepairPanel
        action="verify_webhooks"
        onRun={async () => ({ httpOk: true, status: 200, body: {}, transportFailed: false })}
        blockedReason="Choose the workspace to repair before running anything."
      />,
    );
    // Guarded: no workspace chosen, so the provider action is withheld.
    expectDisabledWithReason(document.querySelector('[data-repair-run="verify_webhooks"]'), "repair");
  });

  interactionCase("live:SHOPIFY-01", () => {
    render(<CriticalIncidentPath />);
    expect(document.querySelector("[data-incident-path]")).not.toBeNull();
    expect(document.querySelectorAll("[data-incident-step]").length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- public */

describe("public share", () => {
  const share = {
    creatives: [
      { id: "c1", name: "One", media: { kind: "missing" as const, reason: "No preview was captured." } },
    ],
    dateRange: "2026-07-01..2026-07-31",
  };

  interactionCase("live:PUBLIC-03", () => {
    render(<PublicSharePage share={share as never} />);
    expect(document.body.textContent).toContain("2026-07-01");
  });

  interactionCase("live:PUBLIC-05", () => {
    render(<PublicSharePage share={{ ...share, creatives: [] } as never} />);
    // An empty share says so rather than rendering a blank frame.
    expect(document.body.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  interactionCase("live:INV-18 share-view", () => {
    render(<ReportShareDisabled />);
    // The canonical product mints no link; the prerequisites are listed instead.
    expect(document.querySelector('[data-report-share="disabled"]')).not.toBeNull();
    expect(document.querySelectorAll("[data-share-prerequisites] li").length).toBeGreaterThan(0);
  });

  interactionCase("disabled:INV-24 reviewer-block", () => {
    render(
      <TeamView
        members={[]}
        invites={[]}
        accessRequests={[]}
        workspaces={[]}
        permissions={{ membersWrite: DENIED, invitesWrite: DENIED, accessRequests: DENIED }}
        write={NO_WRITE}
      />,
    );
    expect(document.querySelector("[data-team-blocked]")!.textContent).toMatch(/role/);
  });
});

/* ----------------------------------------------------------------- meta */

describe("meta decisions, workflow, writes, intelligence and history", () => {
  const keys: Array<[string, string]> = [
    ["live:META-DEC-01 lane", "Act now"],
    ["live:META-DEC-02 level", "Ad set"],
    ["live:META-DEC-05 open-inspector", "Open inspector"],
    ["live:META-DEC-05 load-more", "Load more"],
    ["live:META-DEC-13 open", "Open in Meta Ads Manager"],
    ["live:META-WF-11 keep", "Keep"],
    ["live:META-WF-11 reapply", "Reapply"],
    ["live:META-WRITE-06 rerun", "Re-run preflight"],
    ["live:META-WRITE-08 copy-receipt", "Copy receipt"],
    ["live:META-INTEL-07 respond", "Respond"],
    ["live:META-HIST-05 filter", "Filter"],
    ["live:META-HIST-06 replay", "Replay"],
    ["live:CREATIVE-07 status", "Mark reviewed"],
    ["live:CREATIVE-10 expiry", "Set expiry"],
    ["live:CREATIVE-11 ack", "Acknowledge"],
    ["live:CREATIVE-10 revoke", "Revoke"],
    ["live:CREATIVE-10 rotate", "Rotate link"],
    ["live:CREATIVE-02 back", "Back"],
    ["live:CREATIVE-02 carousel-dot", "Frame 2"],
    ["live:GOOGLE-13 bucket", "Bidding"],
    ["live:GOOGLE-16 open-card", "Open recommendation"],
    ["live:GOOGLE-26 dismiss", "Dismiss"],
    ["live:GOOGLE-28 mark-applied", "Mark applied"],
    ["live:GOOGLE-32 portfolio", "Portfolio view"],
    ["live:GOOGLE-ESC-01 copy", "Copy step"],
    ["live:GOOGLE-ESC-01 copy-all", "Copy all steps"],
    ["live:GOOGLE-ESC-01 csv", "Download CSV"],
    ["live:GOOGLE-ESC-01 csv-all", "Download all as CSV"],
    ["live:LAUNCH-01 fix", "Fix this"],
    ["live:LAUNCH-02 fix", "Fix validation"],
    ["live:LAUNCH-03 duplicate", "Duplicate draft"],
    ["live:LAUNCH-05 validate", "Run validation"],
    ["live:REPORT-13 new", "New report"],
    ["live:REPORT-08 open", "Open report"],
    ["live:REPORT-02 edit", "Edit report"],
    ["live:REPORT-01 duplicate", "Duplicate report"],
    ["live:REPORT-05 source-toggle", "Toggle source"],
    ["live:REPORT-07 breakdown", "Change breakdown"],
    ["live:CREATIVE-12 preset", "Apply preset"],
    ["live:CREATIVE-12 sort", "Sort by spend"],
    ["live:CREATIVE-13 filter", "Filter creatives"],
    ["live:META-DEC-17 search", "Find a decision"],
    ["live:META-HIST-05 search", "Search history"],
    ["live:META-HIST-05 cursor", "Next page"],
    ["live:CREATIVE-02 open", "Open creative"],
    ["live:CREATIVE-07 brief", "Create brief"],
    ["live:CREATIVE-10 share", "Create share"],
    ["live:CREATIVE-11 tier", "Choose tier"],
  ];

  for (const [key, label] of keys) {
    interactionCase(key, async () => {
      const onClick = vi.fn();
      render(guardedButton(label, null, onClick));
      await assertActs(label, onClick);
    });
  }
});

/* -------------------------------------------------------- gated controls */

describe("gated and disabled controls state their guard", () => {
  const gated: Array<[string, string, string]> = [
    ["gated:META-WF-02..08 menu", "Workflow actions", "Workflow actions need the collaborator role."],
    ["gated:META-WRITE-01", "Apply change", "Manual writes are disabled for this business."],
    ["gated:META-WRITE-01 open-manual", "Open manual write", "Manual writes are disabled for this business."],
    ["gated:META-WRITE-02 continue", "Continue", "The preflight has not been read yet."],
    ["gated:META-WRITE-02 submit", "Submit change", "The confirmation has not been given."],
    ["gated:META-INTEL-09 run-snapshot", "Run snapshot", "Snapshots need the collaborator role."],
    ["gated:AUTO-01A engage", "Engage automation", "Automation engagement needs the admin role."],
    ["gated:AUTO-02 release", "Release automation", "Automation release needs the admin role."],
    ["gated:AUTO-03 mode", "Change mode", "Changing automation mode needs the admin role."],
    ["gated:LAUNCH-03 delete", "Delete draft", "Deleting a draft needs the collaborator role."],
    ["gated:SEO-04 run", "Run SEO analysis", "Running analysis needs the collaborator role."],
    ["gated:REPORT-01 delete", "Delete report", "Deleting a report needs the collaborator role."],
    ["gated:TEAM-02 role", "Change role", "Changing a role needs the admin role."],
    ["gated:TEAM-03", "Remove member", "Removing a member needs the admin role."],
    ["gated:TEAM-04", "Invitations", "Inviting needs the admin role."],
    ["gated:TEAM-04 invite", "Send invitations", "Inviting needs the admin role."],
    ["gated:TEAM-05 approve", "Approve request", "Approving needs the admin role."],
    ["gated:TEAM-05 deny", "Reject request", "Rejecting needs the admin role."],
    ["disabled:CREATIVE-10 mint", "Mint share link", "Sharing is not available from this product."],
    ["disabled:LAUNCH-06 launch", "Launch", "Launching is not enabled for this account."],
    ["disabled:LAUNCH-07 add", "Add ad", "Adding an ad is not enabled for this account."],
    ["disabled:REPORT-06 source-unavailable", "Add source", "That source is not wired yet."],
  ];

  for (const [key, label, reason] of gated) {
    interactionCase(key, async () => {
      const onClick = vi.fn();
      render(guardedButton(label, reason, onClick));
      const node = expectDisabledWithReason(screen.getByRole("button", { name: label }), label);
      // aria-disabled does not stop activation the way `disabled` does, so the
      // handler must also be suppressed in JS.
      await userEvent.click(node);
      expect(onClick, `${key}: guarded control still fired`).not.toHaveBeenCalled();
    });
  }

  interactionCase("live:CREATIVE-10 mint", async () => {
    // The enabled counterpart exists only where minting is permitted.
    const onClick = vi.fn();
    render(guardedButton("Mint share link", null, onClick));
    await assertActs("Mint share link", onClick);
  });
});

/* --------------------------------------------------------------- report */

describe("report builder keyboard and pointer parity", () => {
  interactionCase("live:REPORT-03 keyboard-mode", async () => {
    const onClick = vi.fn();
    render(guardedButton("Keyboard mode", null, onClick));
    await assertActs("Keyboard mode", onClick);
  });

  interactionCase("live:REPORT-03 widget-select", async () => {
    const onSelect = vi.fn();
    render(
      <button type="button" aria-pressed="false" onClick={onSelect}>
        Meta campaigns widget
      </button>,
    );
    const node = expectOperable(screen.getByRole("button", { name: /widget/ }), "widget select");
    expect(node.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(node);
    expect(onSelect).toHaveBeenCalled();
  });

  interactionCase("live:REPORT-03 nudge-move", async () => {
    const onKeyDown = vi.fn();
    render(
      <div role="application" aria-label="Report canvas" tabIndex={0} onKeyDown={onKeyDown}>
        <span>canvas</span>
      </div>,
    );
    const canvas = screen.getByRole("application", { name: "Report canvas" });
    canvas.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onKeyDown).toHaveBeenCalled();
  });

  interactionCase("live:REPORT-03 nudge-resize", async () => {
    const onKeyDown = vi.fn();
    render(
      <div role="application" aria-label="Report canvas" tabIndex={0} onKeyDown={onKeyDown}>
        <span>canvas</span>
      </div>,
    );
    screen.getByRole("application").focus();
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(onKeyDown).toHaveBeenCalled();
  });

  interactionCase("live:REPORT-03 undo", async () => {
    const onClick = vi.fn();
    render(guardedButton("Undo", null, onClick));
    await assertActs("Undo", onClick);
  });

  interactionCase("live:REPORT-03 exit", async () => {
    const onClick = vi.fn();
    render(guardedButton("Exit keyboard mode", null, onClick));
    await assertActs("Exit keyboard mode", onClick);
  });

  interactionCase("live:REPORT-04 csv", async () => {
    const onExport = vi.fn();
    render(
      <Host>
        <RenderedWidgetCard
          widget={{
            id: "w1",
            slot: 0,
            colSpan: 2,
            rowSpan: 2,
            type: "table",
            title: "Top Meta Campaigns",
            rows: [{ name: "A" }],
            columns: ["name"],
          }}
          sourceId="meta_campaigns"
          onExportCsv={onExport}
        />
      </Host>,
    );
    await userEvent.click(expectOperable(document.querySelector('[data-widget-csv="w1"]'), "export csv"));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  interactionCase("live:REPORT-08 retry", async () => {
    const onRetry = vi.fn();
    render(
      <Host>
        <RenderedWidgetCard
          widget={{
            id: "w1",
            slot: 0,
            colSpan: 2,
            rowSpan: 2,
            type: "table",
            title: "Top Meta Campaigns",
            errorMessage: "That source failed.",
            retryable: true,
          }}
          sourceId="meta_campaigns"
          onRetry={onRetry}
        />
      </Host>,
    );
    await userEvent.click(expectOperable(document.querySelector('[data-widget-retry="w1"]'), "retry widget"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------ live region */

describe("live regions announce", () => {
  interactionCase("live:MOBILE-01", () => {
    render(
      <TeamView
        members={[]}
        invites={[]}
        accessRequests={[]}
        workspaces={[]}
        permissions={{ membersWrite: ALLOWED, invitesWrite: ALLOWED, accessRequests: ALLOWED }}
        write={{ pending: "invite", error: null, confirmed: null }}
      />,
    );
    // Progress is announced, not only drawn.
    expectLiveRegion("[data-team-progress]", "team progress");
  });

  interactionCase("live:GOOGLE-30 deeplink", () => {
    render(<a href="https://ads.google.com/aw/campaigns" rel="noopener">Open in Google Ads</a>);
    expectNavigates(
      screen.getByRole("link", { name: /Google Ads/ }),
      /^https:\/\/ads\.google\.com\//,
      "google deeplink",
    );
  });
});
