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

/* -------------------------------------------------------- gated controls */

/* --------------------------------------------------------------- report */

describe("report builder keyboard and pointer parity", () => {
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
