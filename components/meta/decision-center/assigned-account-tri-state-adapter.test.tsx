// D078 correction 3 (C3.1): the account-evidence tri-state must survive the
// REAL route-payload → adapter → UI chain, not just the component props.
// Correction 2's adapter collapsed an absent legacy field (`undefined`)
// into read-failed (`null`) via `?? null`, so a legacy payload rendered the
// "coverage unavailable" warning. These tests start from REAL
// workspace-shaped payloads, call `buildMetaDecisionCenterExactViewModel`,
// and render the produced view model — the absent-field case FAILS against
// the correction-2 adapter by construction.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MetaDecisionsWorkspacePayload } from "@/components/meta/redesign/types";

vi.mock("@/lib/zero-base/language", () => ({
  useZeroBaseLanguage: () => "en",
}));

const { buildMetaDecisionCenterExactViewModel } =
  await import("@/components/meta/decision-center/meta-decision-center-exact-adapter");
const { MetaDecisionCenterExact } =
  await import("@/components/meta/decision-center/MetaDecisionCenterExact");

const POPULATED_STATE = {
  providerAccountId: "act_main",
  accountName: "TheSwaf-Main",
  selectionState: "selected" as const,
  accountCurrency: "USD",
  accountTimezone: "America/Chicago",
  latestFactDate: "2026-08-21",
  spend14d: 33887.25,
  latestDecisionAsOf: "2026-08-22",
  latestDecisionRows: 750,
  latestDecisionAuthorizedRows: 7,
  policy:
    "Selected — serving decisions; in write scope subject to every write gate.",
};

/**
 * A real workspace-shaped payload (the same shape the route serves and the
 * established adapter suite fixtures), trimmed to required sections.
 * `assignedAccountStates` is spread in ONLY when provided so the
 * absent-field case genuinely lacks the key rather than carrying
 * `undefined` explicitly.
 */
function workspacePayload(
  input: { assignedAccountStates?: unknown } = {},
): MetaDecisionsWorkspacePayload {
  const counts = {
    actionNow: 0,
    watching: 0,
    healthy: 0,
    nonSales: 0,
    archive: 0,
  };
  return {
    ...("assignedAccountStates" in input
      ? { assignedAccountStates: input.assignedAccountStates }
      : {}),
    businessId: "biz_1",
    window: "28d",
    startDate: "2026-07-21",
    endDate: "2026-08-17",
    pulse: {
      businessId: "biz_1",
      window: "28d",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      pacing: { mtdSpend: 0, mtdTarget: 0, dayPace: 0 },
      roas: {
        selected: Number.NaN,
        d7: Number.NaN,
        d14: Number.NaN,
        d28: Number.NaN,
        target: null,
        median: null,
        target_source: "none",
      },
      spend: { current: 0, prev: 0 },
      revenue: { current: 0, prev: 0 },
      cpa: { current: null, prev: null },
      matureCampaigns: 0,
      learningCampaigns: 0,
      operatingMode: "",
      seasonalRegime: "",
      engineLastRun: null,
      engineVersion: "server-engine-v1",
      trackingHealth: { status: "unknown", detail: "" },
      lastSyncAt: null,
      currency: "USD",
    },
    lanes: {
      businessId: "biz_1",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      sourceModel: "snapshot_persistent",
      snapshotDate: "2026-08-16",
      actionNow: [],
      watching: [],
      healthy: [],
      nonSales: [],
      archive: [],
      deferredIds: [],
      watchingSegments: [],
      counts,
    },
    queue: {
      groups: [],
      actionStates: {
        executablePause: 0,
        executableBid: 0,
        executableResume: 0,
        launchpadRoutes: 0,
        reviewOnly: 0,
        missingActionKind: 0,
      },
    },
    system: {
      trackingBlocked: false,
      dataReadiness: null,
      snapshotHealth: null,
      laneSnapshotDate: "2026-08-16",
      laneSnapshotCreatedAt: "2026-08-17T09:00:00.000Z",
      engineVersion: "server-engine-v1",
      currency: "USD",
      killSwitchEngaged: false,
      killSwitchReason: null,
    },
    viewer: null,
    banners: [],
    digest: {
      snapshotDate: "2026-08-16",
      unavailableReason: null,
      labelFlips: { count: 0, publishedCount: 0, items: [] },
      actions: { verifiedCount: 0, silentFailureCount: 0, items: [] },
      anomalies: { openedCount: 0, items: [] },
      deferrals: { dueCount: 0, items: [] },
    },
    decisionReadModel: {
      scope: {
        businessId: "biz_1",
        providerAccountId: "act_main",
        decisionMode: "current",
        metricsRangeAffectsDecisionSnapshot: false,
      },
      source: {
        snapshotAsOf: "2026-08-16",
        computedAt: "2026-08-17T09:55:00.000Z",
        engineVersion: "server-engine-v1",
      },
      queue: {
        adCandidates: { items: [] },
        sections: {},
        inactiveAssets: {
          preCapCount: 0,
          inactiveCount: 0,
          unknownCount: 0,
          items: [],
        },
      },
    },
    os: {
      source: {
        snapshotAsOf: "2026-08-16",
        engineVersion: "server-engine-v1",
      },
    },
  } as unknown as MetaDecisionsWorkspacePayload;
}

function renderThroughAdapter(workspace: MetaDecisionsWorkspacePayload): {
  viewModel: ReturnType<typeof buildMetaDecisionCenterExactViewModel>;
  html: string;
} {
  const viewModel = buildMetaDecisionCenterExactViewModel({
    workspace,
    account: {
      id: "act_main",
      name: "TheSwaf-Main",
      currency: "USD",
      timezone: "America/Chicago",
    },
    selection: null,
  });
  return {
    viewModel,
    html: renderToStaticMarkup(
      <MetaDecisionCenterExact viewModel={viewModel} />,
    ),
  };
}

describe("assigned-account four-state through the REAL adapter (D078 C3.1)", () => {
  it("ABSENT legacy field stays `undefined` through the adapter and renders NOTHING — not the unavailable warning (fails on the correction-2 `?? null`)", () => {
    const workspace = workspacePayload();
    expect("assignedAccountStates" in workspace).toBe(false);
    const { viewModel, html } = renderThroughAdapter(workspace);
    expect(viewModel.assignedAccountStates).toBeUndefined();
    expect(html).not.toContain("assigned-account-coverage");
    expect(html).not.toContain("Assigned-account coverage unavailable");
  });

  it("`null` (read FAILED) survives the adapter without adding a diagnostics panel", () => {
    const { viewModel, html } = renderThroughAdapter(
      workspacePayload({ assignedAccountStates: null }),
    );
    expect(viewModel.assignedAccountStates).toBeNull();
    expect(html).not.toContain(
      'data-testid="assigned-account-coverage-unavailable"',
    );
    expect(html).not.toContain("Assigned-account coverage unavailable");
    expect(html).not.toContain('data-testid="assigned-account-coverage"');
    expect(html).not.toContain('data-testid="assigned-account-coverage-empty"');
  });

  it("`[]` (proven zero) survives the adapter without adding a diagnostics panel", () => {
    const { viewModel, html } = renderThroughAdapter(
      workspacePayload({ assignedAccountStates: [] }),
    );
    expect(viewModel.assignedAccountStates).toEqual([]);
    expect(html).not.toContain('data-testid="assigned-account-coverage-empty"');
    expect(html).not.toContain("ZERO assigned Meta identities");
    expect(html).not.toContain("coverage unavailable");
  });

  it("populated states survive the adapter without exposing account diagnostics", () => {
    const { viewModel, html } = renderThroughAdapter(
      workspacePayload({ assignedAccountStates: [POPULATED_STATE] }),
    );
    expect(viewModel.assignedAccountStates).toEqual([POPULATED_STATE]);
    expect(html).not.toContain('data-testid="assigned-account-coverage"');
    expect(html).not.toContain("act_main");
    expect(html).not.toContain("timezone America/Chicago");
    expect(html).not.toContain("coverage unavailable");
  });
});
