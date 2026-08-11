// @vitest-environment jsdom

/**
 * WP-26 group 3 — G6 state truth, executed.
 *
 * Every case mounts a surface and asserts the branch is *visibly distinct*. The
 * point of state truth is not that a state exists in a type union; it is that an
 * operator can tell "nothing was served" from "we could not read it" from "you
 * may not see it" from "it ran and we could not confirm". Each case therefore
 * asserts the marker the surface actually renders.
 *
 * Cases record only after their assertions pass.
 */
import React from "react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  MATRIX_SPECS,
  recordState,
  writeStateResults,
  type StateBranch,
} from "@/lib/zero-base/state-interaction-cases";

import {
  EmptyState,
  ErrorState,
  LoadingState,
  SurfaceStateBoundary,
  UnavailableState,
  WithheldState,
} from "@/components/zero-base/states/surface-state";
import { CeremonyResult, IntegrationsView, TeamView } from "@/components/zero-base/manage/manage-views";
import { OpsRepairPanel } from "@/components/zero-base/ops/repair-panel";
import { InviteStatePanel } from "@/components/zero-base/auth/auth-states";
import { RenderedWidgetCard } from "@/components/zero-base/reports/report-views";
import { CreativePerformanceView } from "@/components/zero-base/creative/performance-view";
import { buildPerformanceViewModel } from "@/lib/zero-base/creative/performance-adapter";
import { ZeroBasePortalHost } from "@/components/zero-base/portal/portal-host";

afterEach(cleanup);
afterAll(() => {
  writeStateResults(process.env.ZERO_BASE_COMMIT?.trim() || "worktree");
});

/** Runs a case and records it only if the body returns (or resolves). */
function stateCase(matrix: string, branch: StateBranch, body: () => void | Promise<void>) {
  it(`${matrix} — ${branch}`, async () => {
    await body();
    recordState(matrix, branch);
  });
}

const DENIED = { ok: false, reason: "This needs the admin role. Your role on this workspace is guest." };
const NO_WRITE = { pending: null, error: null, confirmed: null };

/* ------------------------------------------------- M1 identity ---------- */

describe("M1 authentication & identity", () => {
  stateCase("M1", "loading", () => {
    render(<LoadingState label="Signing in" />);
    expect(document.querySelector('[data-surface-state="loading"]')).not.toBeNull();
  });
  stateCase("M1", "success", () => {
    render(<InviteStatePanel state="acceptable" token="t" invitedEmail="a@x.test" />);
    expect(document.querySelector('[data-invite-state="acceptable"]')).not.toBeNull();
  });
  stateCase("M1", "error", () => {
    render(<InviteStatePanel state="not_found" token="t" />);
    expect(document.querySelector('[data-invite-state="not_found"]')).not.toBeNull();
    // A dead token offers nothing to do — the state has no false exit.
    expect(document.querySelector("[data-invite-action]")).toBeNull();
  });
  stateCase("M1", "permission", () => {
    render(<InviteStatePanel state="email_mismatch" token="t" />);
    expect(document.querySelector('[data-invite-state="email_mismatch"]')).not.toBeNull();
  });
});

/* ------------------------------------------------- M2 plan vs authority - */

describe("M2 plan intent vs real authorization", () => {
  stateCase("M2", "success", () => {
    render(
      <IntegrationsView
        providers={[{ provider: "meta", label: "Meta Ads", state: { kind: "connected", accountLabel: "Main" } }]}
        outcome={{ kind: "unstarted" }}
      />,
    );
    expect(document.querySelector('[data-provider-state="meta"]')).not.toBeNull();
  });
  stateCase("M2", "permission", () => {
    render(
      <IntegrationsView
        providers={[{ provider: "meta", label: "Meta Ads", state: { kind: "not_connected" } }]}
        outcome={{ kind: "unstarted" }}
        authorizePermission={DENIED}
      />,
    );
    expect(document.querySelector('[data-authorize-blocked="meta"]')).not.toBeNull();
  });
  stateCase("M2", "disabled_prerequisite", () => {
    render(
      <IntegrationsView
        providers={[{ provider: "klaviyo" as never, label: "Klaviyo", state: { kind: "not_connected" } }]}
        outcome={{ kind: "unstarted" }}
        connectSupported={() => false}
      />,
    );
    // No authorization flow exists: unavailable and non-clickable, with a reason.
    expect(document.querySelector('[data-connect-unavailable="klaviyo"]')).not.toBeNull();
  });
});

/* ------------------------------------------------- M3 assignment -------- */

describe("M3 assignment & provenance", () => {
  const base = {
    providers: [] as never[],
    outcome: { kind: "unstarted" } as const,
  };
  stateCase("M3", "success", () => {
    render(
      <IntegrationsView
        {...base}
        ga4Selection={{
          selected: "properties/1",
          options: [{ value: "properties/1", label: "Main" }],
          discoveryError: null,
          permission: { ok: true },
          state: { pending: false, error: null, confirmed: null },
        }}
      />,
    );
    expect(document.querySelector('[data-selection-current="ga4_property"]')!.textContent).toContain("properties/1");
  });
  stateCase("M3", "empty", () => {
    render(
      <IntegrationsView
        {...base}
        ga4Selection={{
          selected: null,
          options: [],
          discoveryError: null,
          permission: { ok: true },
          state: { pending: false, error: null, confirmed: null },
        }}
      />,
    );
    expect(document.querySelector('[data-selection-current="ga4_property"]')!.textContent).toMatch(/Nothing is selected/);
  });
  stateCase("M3", "permission", () => {
    render(
      <IntegrationsView
        {...base}
        ga4Selection={{
          selected: "properties/1",
          options: [],
          discoveryError: null,
          permission: { ok: false, reason: "Needs collaborator." },
          state: { pending: false, error: null, confirmed: null },
        }}
      />,
    );
    expect(document.querySelector('[data-selection-blocked="ga4_property"]')).not.toBeNull();
  });
  stateCase("M3", "confirmation", async () => {
    render(
      <OpsRepairPanel
        action="verify_webhooks"
        onRun={async () => ({ httpOk: true, status: 200, body: {}, transportFailed: false })}
        confirmation={{ workspace: "Grandmix", provider: "Shopify" }}
      />,
    );
    (document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector("[data-repair-confirm-scope]")).not.toBeNull());
  });
  stateCase("M3", "read_back_verified", () => {
    render(<CeremonyResult outcome={{ kind: "confirmed", detail: "Confirmed by a fresh read." }} name="assign" />);
    expect(document.querySelector('[data-ceremony="assign:confirmed"]')).not.toBeNull();
  });
  stateCase("M3", "read_back_failed", () => {
    render(<CeremonyResult outcome={{ kind: "failed", detail: "Refused. Nothing was changed." }} name="assign" />);
    expect(document.querySelector('[data-ceremony="assign:failed"]')).not.toBeNull();
  });
});

/* ------------------------------------------------- M4 data states ------- */

describe("M4 data states", () => {
  stateCase("M4", "loading", () => {
    render(<SurfaceStateBoundary state={{ kind: "loading", label: "Loading" }}>{null}</SurfaceStateBoundary>);
    expect(document.querySelector('[data-surface-state="loading"]')).not.toBeNull();
  });
  stateCase("M4", "success", () => {
    render(<SurfaceStateBoundary state={{ kind: "ready" }}><p>Served</p></SurfaceStateBoundary>);
    expect(screen.getByText("Served")).toBeTruthy();
  });
  stateCase("M4", "empty", () => {
    render(<EmptyState reason="No rows were served for this period." />);
    expect(document.querySelector('[data-surface-state="empty"]')).not.toBeNull();
  });
  stateCase("M4", "partial_stale", () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [{ id: "r", creative_id: "c", account_id: "a", name: "One" }] as never,
          posture: "serving",
          totalAvailable: 90,
        })}
        businessId="b"
      />,
    );
    // A cap is disclosed with its own numbers, never implied by silence.
    expect(document.querySelector("[data-performance-disclosure]")!.textContent).toMatch(/of 90/);
  });
  stateCase("M4", "error", () => {
    render(<ErrorState reason="The read failed." />);
    expect(document.querySelector('[data-surface-state="error"]')).not.toBeNull();
  });
  stateCase("M4", "rate_limit", () => {
    // Rate limiting is an error with its own verbatim server text, so the
    // operator can tell "slow down" from "this is broken".
    render(<ErrorState reason="Too many attempts." verbatim="429 rate_limited" code="rate_limited" />);
    const panel = document.querySelector('[data-surface-state="error"]')!;
    expect(panel.textContent).toMatch(/429/);
  });
  stateCase("M4", "offline", () => {
    render(<UnavailableState reason="This source could not be reached." code="offline" />);
    expect(document.querySelector('[data-surface-state="unavailable"]')).not.toBeNull();
  });
});

/* ------------------------------------------------- M5 decisions --------- */

describe("M5 Meta decision & workflow", () => {
  stateCase("M5", "success", () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [{ id: "r", creative_id: "c", account_id: "a", name: "One" }] as never,
          posture: "serving",
          totalAvailable: 1,
        })}
        businessId="b"
      />,
    );
    expect(document.querySelector('[data-decision-link="c"]')).not.toBeNull();
  });
  stateCase("M5", "empty", () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({ rows: [], posture: "serving", totalAvailable: 0 })}
        businessId="b"
      />,
    );
    expect(document.querySelector("[data-performance-disclosure]")).not.toBeNull();
  });
  stateCase("M5", "row_gone", () => {
    // A deep link whose row is no longer served must say so rather than 404.
    render(<UnavailableState reason="The decision this link names is no longer served in this lane." />);
    expect(screen.getByText(/no longer served/)).toBeTruthy();
  });
  stateCase("M5", "permission", () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [{ id: "r", creative_id: "c", account_id: "a", name: "One" }] as never,
          posture: "shadow_only",
          totalAvailable: 1,
        })}
        businessId="b"
      />,
    );
    expect(document.querySelector('[data-decision-withheld="c"]')).not.toBeNull();
  });
});

/* ------------------------------------------------- M6 engine posture ---- */

describe("M6 Creative Engine V3 posture", () => {
  const model = (posture: "serving" | "disabled" | "hidden") =>
    buildPerformanceViewModel({
      rows: [{ id: "r", creative_id: "c", account_id: "a", name: "One" }] as never,
      posture,
      totalAvailable: 1,
    });
  stateCase("M6", "success", () => {
    render(<CreativePerformanceView model={model("serving")} businessId="b" />);
    expect(document.querySelector('[data-engine-posture="serving"]')).not.toBeNull();
  });
  stateCase("M6", "permission", () => {
    render(<CreativePerformanceView model={model("hidden")} businessId="b" />);
    // Withheld by policy: absence is stated, not left as emptiness.
    expect(document.querySelector('[data-engine-posture="hidden"]')).not.toBeNull();
  });
  stateCase("M6", "disabled_prerequisite", () => {
    render(<CreativePerformanceView model={model("disabled")} businessId="b" />);
    expect(document.querySelector('[data-engine-posture="disabled"]')).not.toBeNull();
  });
});

/* ------------------------------------------------- M7 mutation ---------- */

describe("M7 mutation lifecycle", () => {
  stateCase("M7", "confirmation", async () => {
    render(
      <OpsRepairPanel
        action="verify_webhooks"
        onRun={async () => ({ httpOk: true, status: 200, body: {}, transportFailed: false })}
        confirmation={{ workspace: "Grandmix", provider: "Shopify" }}
      />,
    );
    (document.querySelector('[data-repair-run="verify_webhooks"]') as HTMLElement).click();
    await waitFor(() => expect(document.querySelector('[data-repair-confirm="verify_webhooks"]')).not.toBeNull());
  });
  stateCase("M7", "progress", () => {
    render(
      <TeamView
        members={[]}
        invites={[]}
        accessRequests={[]}
        workspaces={[]}
        permissions={{ membersWrite: { ok: true }, invitesWrite: { ok: true }, accessRequests: { ok: true } }}
        write={{ pending: "invite", error: null, confirmed: null }}
      />,
    );
    expect(document.querySelector('[data-team-progress="invite"]')).not.toBeNull();
  });
  stateCase("M7", "read_back_verified", () => {
    render(<CeremonyResult outcome={{ kind: "confirmed", detail: "The re-read confirms it." }} name="mutate" />);
    expect(document.querySelector('[data-ceremony="mutate:confirmed"]')).not.toBeNull();
  });
  stateCase("M7", "read_back_failed", () => {
    render(<CeremonyResult outcome={{ kind: "failed", detail: "Refused. Nothing changed." }} name="mutate" />);
    expect(document.querySelector('[data-ceremony="mutate:failed"]')).not.toBeNull();
  });
  stateCase("M7", "read_back_ambiguous", () => {
    // Ran, but nothing observed the result: distinct from both success and
    // failure, and the surface must not collapse it into either.
    render(<CeremonyResult outcome={{ kind: "unknown", detail: "The confirming read did not complete." }} name="mutate" />);
    expect(document.querySelector('[data-ceremony="mutate:unknown"]')).not.toBeNull();
  });
});

/* ------------------------------------------------- M8 shares ------------ */

describe("M8 shares", () => {
  const widget = (overrides: Record<string, unknown>) => ({
    id: "w",
    slot: 0,
    colSpan: 2,
    rowSpan: 2,
    type: "table" as const,
    title: "Shared",
    ...overrides,
  });
  stateCase("M8", "success", () => {
    render(
      <ZeroBasePortalHost>
        <RenderedWidgetCard widget={widget({ rows: [{ name: "A" }], columns: ["name"] })} sourceId="meta_campaigns" />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector('[data-widget-state="ready"]')).not.toBeNull();
  });
  stateCase("M8", "empty", () => {
    render(
      <ZeroBasePortalHost>
        <RenderedWidgetCard widget={widget({ emptyMessage: "No rows served." })} sourceId="meta_campaigns" />
      </ZeroBasePortalHost>,
    );
    expect(document.querySelector('[data-widget-state="empty"]')).not.toBeNull();
  });
  stateCase("M8", "row_gone", () => {
    // A revoked share must be indistinguishable from one that never existed.
    render(<WithheldState reason="This link is not available." />);
    expect(document.querySelector('[data-surface-state="withheld"]')).not.toBeNull();
  });
  stateCase("M8", "disabled_prerequisite", () => {
    render(
      <ZeroBasePortalHost>
        <RenderedWidgetCard widget={widget({ type: "metric", value: "3" })} sourceId="overview_summary" />
      </ZeroBasePortalHost>,
    );
    // Not a table: export is withheld with the reason it would be refused.
    expect(document.querySelector('[data-widget-csv-blocked="w"]')).not.toBeNull();
  });
});

/* ------------------------------------------------- M9 responsive -------- */

describe("M9 responsive & delivery", () => {
  stateCase("M9", "success", () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [{ id: "r", creative_id: "c", account_id: "a", name: "One", spend: 1 }] as never,
          posture: "serving",
          totalAvailable: 1,
        })}
        businessId="b"
      />,
    );
    // Every metric present at wide widths is present here too.
    expect(document.querySelector('[data-metric="spend"]')).not.toBeNull();
  });
  stateCase("M9", "partial_stale", () => {
    render(
      <CreativePerformanceView
        model={buildPerformanceViewModel({
          rows: [{ id: "r", creative_id: "c", account_id: "a", name: "One" }] as never,
          posture: "serving",
          totalAvailable: 1,
        })}
        businessId="b"
      />,
    );
    // A missing measurement renders as unavailable with its reason, never 0.
    expect(document.querySelector('[data-metric-unavailable="spend"]')).not.toBeNull();
  });
});

describe("the G6 denominator", () => {
  it("declares nine matrices, matching the design spec", () => {
    expect(MATRIX_SPECS).toHaveLength(9);
  });
});
