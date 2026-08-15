import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IntegrationsCard } from "@/components/integrations/integrations-card";
import type { GoogleAdsFreshnessSummary } from "@/lib/google-ads/freshness-read";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { ProviderViewState } from "@/store/integrations-store";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { ShopifyStatusResponse } from "@/lib/shopify/status";

vi.mock("next/image", () => ({
  default: (props: React.ImgHTMLAttributes<HTMLImageElement>) =>
    React.createElement("img", props),
}));

const baseView: ProviderViewState = {
  provider: "meta",
  status: "ready",
  connectionLabel: "Connected",
  primaryActionLabel: "Manage assignments",
  statusLabel: "Connected",
  detailLabel: "Status",
  detailValue: "Healthy",
  accountLabel: "Account",
  accountValue: "1 assigned",
  lastSyncLabel: "Last sync",
  lastSyncValue: "2026-04-10T08:00:00.000Z",
  assignedCount: 1,
  assignedSummary: "1 Meta account assigned.",
  notice: null,
  canManageAssignments: true,
  isConnected: true,
};

function buildStatus(): MetaStatusResponse {
  return {
    state: "syncing",
    connected: true,
    assignedAccountIds: ["act_1"],
    primaryAccountTimezone: "UTC",
    latestSync: {
      status: "running",
      progressPercent: 71,
      readyThroughDate: "2026-04-10",
    },
    coreReadiness: {
      state: "ready",
      usable: true,
      complete: true,
      percent: 100,
      reason: null,
      summary: "Summary and campaign data are ready for Meta's primary reporting surfaces.",
      missingSurfaces: [],
      blockedSurfaces: [],
      surfaces: {} as never,
    },
    extendedCompleteness: {
      state: "syncing",
      complete: false,
      percent: 33,
      reason: "Breakdown data is still being prepared for the selected range.",
      summary: "Breakdown data is still being prepared for the selected range.",
      missingSurfaces: ["breakdowns.age"],
      blockedSurfaces: [],
      surfaces: {} as never,
    },
    rangeCompletionBySurface: {
      account_daily: {
        recentCompletedDays: 10,
        recentTotalDays: 14,
        historicalCompletedDays: 180,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-10",
      },
      campaign_daily: {
        recentCompletedDays: 10,
        recentTotalDays: 14,
        historicalCompletedDays: 180,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-10",
      },
      adset_daily: {
        recentCompletedDays: 8,
        recentTotalDays: 14,
        historicalCompletedDays: 160,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-08",
      },
      creative_daily: {
        recentCompletedDays: 6,
        recentTotalDays: 14,
        historicalCompletedDays: 120,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-06",
      },
      ad_daily: {
        recentCompletedDays: 6,
        recentTotalDays: 14,
        historicalCompletedDays: 110,
        historicalTotalDays: 365,
        readyThroughDate: "2026-04-05",
      },
    },
    recentExtendedReady: false,
    historicalExtendedReady: false,
    warehouse: {
      coverage: {
        pendingSurfaces: ["creative_daily", "ad_daily"],
      },
    } as never,
    jobHealth: {
      queueDepth: 8,
      leasedPartitions: 2,
      retryableFailedPartitions: 0,
      deadLetterPartitions: 0,
    } as never,
    operations: {
      progressState: "syncing",
      blockingReasons: [],
      repairableActions: [],
      stallFingerprints: [],
    },
  };
}

function buildGoogleStatus(
  overrides: Partial<GoogleAdsStatusResponse> = {},
): GoogleAdsStatusResponse {
  return {
    state: "ready",
    connected: true,
    assignedAccountIds: ["acc_1"],
    blockerClass: "none",
    controlPlanePersistence: {
      identity: {
        buildId: "build-1",
        environment: "production",
        providerScope: "google_ads",
      },
      exact: {
        deployGate: null,
        releaseGate: null,
        repairPlan: null,
      },
      fallbackByBuild: {
        deployGate: null,
        releaseGate: null,
        repairPlan: null,
      },
      latest: {
        deployGate: null,
        releaseGate: null,
        repairPlan: null,
      },
      missingExact: [],
      exactRowsPresent: true,
    },
    releaseGate: {
      id: "gate-1",
      gateKind: "release_gate",
      gateScope: "release_readiness",
      buildId: "build-1",
      environment: "production",
      mode: "block",
      baseResult: "pass",
      verdict: "pass",
      blockerClass: null,
      summary: "passed",
      breakGlass: false,
      overrideReason: null,
      evidence: {},
      emittedAt: "2026-04-20T07:22:20.362Z",
    },
    repairPlan: {
      id: "plan-1",
      buildId: "build-1",
      environment: "production",
      providerScope: "google_ads",
      planMode: "dry_run",
      eligible: true,
      blockedReason: null,
      breakGlass: false,
      summary: "no recommendations",
      recommendations: [],
      emittedAt: "2026-04-20T07:22:20.672Z",
    },
    operations: {
      currentMode: "safe_mode",
      globalExtendedExecutionEnabled: false,
      quotaPressure: 0,
      breakerState: "closed",
      progressState: "ready",
      blockingReasons: [],
      repairableActions: [],
      stallFingerprints: [],
      activityState: "ready",
    } as never,
    domains: {
      core: {
        state: "ready",
        label: "Core ready",
        detail: "Summary and campaign data are ready.",
      },
      selectedRange: {
        state: "ready",
        label: "Range ready",
        detail: "Selected range surfaces are ready.",
      },
      advisor: {
        state: "ready",
        label: "Analysis ready",
        detail: "Analysis inputs are ready.",
      },
    },
    panel: {
      coreUsable: true,
      extendedLimited: false,
      headline: "Google Ads is ready.",
      detail: "All primary surfaces are available.",
      surfaceStates: [],
    },
    advisor: {
      ready: true,
      readinessWindowDays: 90,
      requiredSurfaces: [],
      availableSurfaces: [],
      missingSurfaces: [],
      readyRangeStart: "2026-01-01",
      readyRangeEnd: "2026-04-19",
    },
    primaryAccountTimezone: "UTC",
    warehouse: {
      rowCount: 7,
      firstDate: "2026-04-13",
      lastDate: "2026-04-19",
      coverage: {
        selectedRange: {
          startDate: "2026-04-13",
          endDate: "2026-04-19",
          completedDays: 7,
          totalDays: 7,
          readyThroughDate: "2026-04-19",
          isComplete: true,
        },
      },
    },
    jobHealth: {
      runningJobs: 0,
      staleRunningJobs: 0,
      queueDepth: 0,
      leasedPartitions: 0,
      deadLetterPartitions: 0,
    },
    ...overrides,
  };
}

function buildGoogleFreshness(
  overrides: Partial<GoogleAdsFreshnessSummary> = {},
): GoogleAdsFreshnessSummary {
  return {
    evidenceAvailable: true,
    unavailableReason: null,
    state: "provisional",
    label: "Provisional",
    percent: 42,
    complete: false,
    mayStopPolling: false,
    detail: "4 of 7 days have not been re-read since they closed.",
    startDate: "2026-04-13",
    endDate: "2026-04-19",
    totalDays: 7,
    includesOpenDay: false,
    timeZoneSource: "account",
    conversionLookbackDays: 30,
    scopes: [
      {
        scope: "campaign_daily",
        state: "provisional",
        label: "Provisional",
        percent: 42,
        complete: false,
        mayStopPolling: false,
        detail: "4 of 7 days have not been re-read since they closed.",
        coveredDays: 7,
        postCloseObservedDays: 3,
        lookbackExhaustedDays: 0,
        dueNowDays: 4,
        oldestObservationAt: "2026-04-14T01:40:00.000Z",
        latestObservationAt: "2026-04-17T01:40:00.000Z",
      },
    ],
    ...overrides,
  };
}

function renderGoogleCard(status: GoogleAdsStatusResponse) {
  return renderToStaticMarkup(
    <IntegrationsCard
      businessId="biz-1"
      provider="google"
      language="en"
      description="Link Google Ads to track performance and sync account data."
      view={{
        ...baseView,
        provider: "google",
        detailValue: "Healthy",
        accountValue: "1 assigned",
      }}
      googleSyncStatus={status}
      googleSyncLoading={false}
      onConnect={() => undefined}
      onReconnect={() => undefined}
      onRetry={() => undefined}
      onCancel={() => undefined}
      onDisconnect={() => undefined}
      onOpenAssignments={() => undefined}
    />
  );
}

/** The green pill markup, which only a self-consistent verdict may earn. */
const GREEN_PILL = "border-emerald-200 bg-emerald-50 text-emerald-700";

function buildShopifyStatus(
  overrides: Partial<ShopifyStatusResponse> = {},
): ShopifyStatusResponse {
  const syncState = {
    businessId: "biz_1",
    providerAccountId: "test-shop.myshopify.com",
    syncTarget: "commerce_orders_recent",
    historicalTargetStart: null,
    historicalTargetEnd: null,
    readyThroughDate: null,
    cursorTimestamp: null,
    cursorValue: null,
    latestSyncStartedAt: null,
    latestSuccessfulSyncAt: "2026-04-21T08:00:00.000Z",
    latestSyncStatus: "succeeded",
    latestSyncWindowStart: null,
    latestSyncWindowEnd: null,
    lastError: null,
    lastResultSummary: null,
  };
  return {
    state: "partial",
    connected: true,
    shopId: "test-shop.myshopify.com",
    warehouse: {
      orderRowCount: 9017,
      refundRowCount: 11,
      returnRowCount: 2,
      firstOrderDate: "2025-01-01",
      lastOrderDate: "2026-04-20",
    },
    sync: {
      ordersRecent: {
        ...syncState,
        syncTarget: "commerce_orders_recent",
      },
      returnsRecent: null,
      ordersHistorical: {
        ...syncState,
        syncTarget: "commerce_orders_historical",
        historicalTargetEnd: "2026-04-20",
        readyThroughDate: "2026-03-15",
      },
      returnsHistorical: null,
    },
    serving: null,
    reconciliation: null,
    issues: ["Historical Shopify backfill is not complete yet."],
    ...overrides,
  };
}

describe("IntegrationsCard", () => {
  it("renders the compact Meta progress block in English without removing the existing pill and notice", () => {
    const html = renderToStaticMarkup(
      <IntegrationsCard
      businessId="biz-1"
        provider="meta"
        language="en"
        description="Connect Ads Manager to import campaigns, ad sets, and spend."
        view={baseView}
        syncNotice="Breakdown data is still being prepared for the selected range."
        metaSyncStatus={buildStatus()}
        metaSyncLoading={false}
        onConnect={() => undefined}
        onReconnect={() => undefined}
        onRetry={() => undefined}
        onCancel={() => undefined}
        onDisconnect={() => undefined}
        onOpenAssignments={() => undefined}
      />
    );

    expect(html).toContain("Core ready");
    expect(html).toContain("Breakdown data is still being prepared for the selected range.");
    expect(html).toContain("Connection");
    expect(html).toContain("Queue / worker");
    expect(html).toContain("Core data");
    expect(html).toContain("Extended surfaces");
    expect(html).toContain("worker active");
    expect(html).toContain("core ready");
  });

  it("renders the compact Meta progress block in Turkish", () => {
    const html = renderToStaticMarkup(
      <IntegrationsCard
      businessId="biz-1"
        provider="meta"
        language="tr"
        description="Connect Ads Manager to import campaigns, ad sets, and spend."
        view={baseView}
        syncNotice="Breakdown verisi hâlâ hazırlanıyor."
        metaSyncStatus={buildStatus()}
        metaSyncLoading={false}
        onConnect={() => undefined}
        onReconnect={() => undefined}
        onRetry={() => undefined}
        onCancel={() => undefined}
        onDisconnect={() => undefined}
        onOpenAssignments={() => undefined}
      />
    );

    expect(html).toContain("Bağlantı");
    expect(html).toContain("Kuyruk / worker");
    expect(html).toContain("Çekirdek veri");
    expect(html).toContain("Genişletilmiş yüzeyler");
    expect(html).toContain("worker aktif");
    expect(html).toContain("Bu workspace için Meta hesabı atanmış.");
  });

  it("shows creative preview readiness separately from extended surface readiness", () => {
    const status: MetaStatusResponse = {
      ...buildStatus(),
      extendedCompleteness: {
        state: "ready",
        complete: true,
        percent: 100,
        reason: null,
        summary: "Breakdowns are ready.",
        missingSurfaces: [],
        blockedSurfaces: [],
        surfaces: {} as never,
      },
      recentExtendedReady: true,
      operations: {
        ...buildStatus().operations,
        secondaryReadiness: [
          {
            key: "creatives_preview",
            state: "building",
            detail: "Creative previews ready: 3458/3582.",
          },
        ],
      } as never,
    };

    const html = renderToStaticMarkup(
      <IntegrationsCard
      businessId="biz-1"
        provider="meta"
        language="en"
        description="Connect Ads Manager to import campaigns, ad sets, and spend."
        view={baseView}
        metaSyncStatus={status}
        metaSyncLoading={false}
        onConnect={() => undefined}
        onReconnect={() => undefined}
        onRetry={() => undefined}
        onCancel={() => undefined}
        onDisconnect={() => undefined}
        onOpenAssignments={() => undefined}
      />
    );

    expect(html).toContain("Extended surfaces");
    expect(html).toContain("extended ready");
    expect(html).toContain("Creative previews");
    expect(html).toContain("Creative previews ready: 3458/3582.");
    expect(html).toContain("partial");
  });

  it("does not show the Meta provider badge as connected when sync is action-required", () => {
    const baseStatus = buildStatus();
    const actionRequiredStatus: MetaStatusResponse = {
      ...baseStatus,
      state: "action_required",
      latestSync: {
        ...baseStatus.latestSync,
        lastError: "Meta account checkpoint requires login.",
      },
      operations: {
        ...baseStatus.operations,
        blockingReasons: [
          {
            code: "account_action_required",
            message: "Meta account login is required.",
            repairable: false,
          },
        ],
      } as never,
    };

    const html = renderToStaticMarkup(
      <IntegrationsCard
      businessId="biz-1"
        provider="meta"
        language="en"
        description="Connect Ads Manager to import campaigns, ad sets, and spend."
        view={baseView}
        metaSyncStatus={actionRequiredStatus}
        metaSyncLoading={false}
        onConnect={() => undefined}
        onReconnect={() => undefined}
        onRetry={() => undefined}
        onCancel={() => undefined}
        onDisconnect={() => undefined}
        onOpenAssignments={() => undefined}
      />
    );

    expect(html).toContain("Action required");
    expect(html).toContain("Meta sync needs attention");
    expect(html).not.toContain('text-emerald-700">Connected</span>');
  });

  it("renders the compact Google progress block without surfacing stale sync attention when the control plane is closed", () => {
    const html = renderToStaticMarkup(
      <IntegrationsCard
      businessId="biz-1"
        provider="google"
        language="en"
        description="Link Google Ads to track performance and sync account data."
        view={{
          ...baseView,
          provider: "google",
          detailValue: "Healthy",
          accountValue: "1 assigned",
        }}
        syncNotice="Cached accounts available while the latest refresh finishes."
        syncNoticeTone="info"
        googleSyncStatus={buildGoogleStatus()}
        googleSyncLoading={false}
        onConnect={() => undefined}
        onReconnect={() => undefined}
        onRetry={() => undefined}
        onCancel={() => undefined}
        onDisconnect={() => undefined}
        onOpenAssignments={() => undefined}
      />
    );

    expect(html).toContain("Connection");
    expect(html).toContain("Queue / worker");
    expect(html).toContain("Core data");
    expect(html).toContain("Selected range");
    expect(html).toContain("Analysis / advisor");
    expect(html).toContain("queue clear");
    expect(html).toContain("Cached accounts available while the latest refresh finishes.");
    expect(html).not.toContain("Attention / recovery");
    expect(html).not.toContain("attention needed");

    // This fixture carries no freshness evidence at all, so the card may not
    // present the sync as done — it says so instead of going green.
    expect(html).toContain("Data freshness");
    expect(html).toContain("Unknown freshness");
    expect(html).not.toContain(">Active<");
  });

  it("keeps the Google sync pill green only when the freshness verdict is steady", () => {
    const settled = renderGoogleCard(
      buildGoogleStatus({
        freshness: buildGoogleFreshness({
          state: "settled",
          label: "Policy-settled",
          percent: 100,
          complete: true,
          mayStopPolling: true,
          detail: "All days re-read after closing and past the conversion window.",
          scopes: [],
        }),
      }),
    );

    expect(settled).toContain(`${GREEN_PILL}">Active<`);
    expect(settled).toContain("Policy-settled");
    expect(settled).toContain(
      "Settled against a 30-day conversion window; Google can still revise conversions inside it.",
    );
    // The strongest word we are allowed to use is "settled".
    expect(settled).not.toMatch(/\b(Final|Immutable|100% synced)\b/);

    // Converging: every day re-read after close, so still healthy and green,
    // but the range is inside the conversion window and cannot be 100.
    const converging = renderGoogleCard(
      buildGoogleStatus({
        freshness: buildGoogleFreshness({
          state: "converging",
          label: "Refreshing",
          percent: 99,
          detail:
            "All days re-read after closing; conversions may still arrive within the conversion window.",
          scopes: [],
        }),
      }),
    );

    expect(converging).toContain(`${GREEN_PILL}">Active<`);
    expect(converging).toContain("Refreshing");
  });

  it("demotes the green Google pill when days were covered but never re-read", () => {
    const html = renderGoogleCard(
      buildGoogleStatus({ freshness: buildGoogleFreshness() }),
    );

    // The pill that used to read a green "Active" over a day captured once at
    // 01:40 now states the verdict instead, in the neutral info tone.
    expect(html).toContain('border-sky-200 bg-sky-50 text-sky-800">42% Provisional<');
    expect(html).not.toContain(`${GREEN_PILL}">Active<`);
    expect(html).not.toContain(">Active<");
    expect(html).toContain("4 of 7 days have not been re-read since they closed.");
    expect(html).toContain("3/7 days re-read after close • 4 days due now");

    // Not an error state either: no amber, and no attention copy.
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("attention needed");

    // The only green left on the card is the connection badge, never the
    // freshness verdict.
    const greenPills = html.split(GREEN_PILL).length - 1;
    expect(greenPills).toBeGreaterThan(0);
    expect(html).not.toMatch(
      new RegExp(`${GREEN_PILL}[^<]*">\\s*(Provisional|Unknown|Missing data)`),
    );
  });

  it("renders unreadable Google freshness evidence as unknown, not as a failure", () => {
    const html = renderGoogleCard(
      buildGoogleStatus({
        freshness: buildGoogleFreshness({
          evidenceAvailable: false,
          unavailableReason: "Google Ads freshness tables are not ready yet.",
          state: "unknown",
          label: "Unknown",
          percent: 0,
          scopes: [],
        }),
      }),
    );

    expect(html).toContain("Unknown freshness");
    expect(html).toContain("Google Ads freshness tables are not ready yet.");
    expect(html).toContain("still being polled");
    expect(html).not.toContain(">Active<");
    expect(html).not.toContain("Needs attention");
    // Nothing anywhere claims the sync finished.
    expect(html).not.toContain("100%");
  });

  it("does not show the Google provider badge as connected when sync is action-required", () => {
    const actionRequiredStatus = buildGoogleStatus({
      state: "action_required",
      operations: {
        currentMode: "safe_mode",
        globalExtendedExecutionEnabled: false,
        quotaPressure: 0,
        breakerState: "closed",
        progressState: "blocked",
        blockingReasons: [
          {
            code: "account_action_required",
            message: "Google Ads account access requires reconnect.",
            repairable: false,
          },
        ],
        repairableActions: [],
        stallFingerprints: [],
        activityState: "blocked",
      } as never,
      latestSync: {
        status: "failed",
        lastError: "Google Ads account access requires reconnect.",
      },
    });
    const html = renderToStaticMarkup(
      <IntegrationsCard
      businessId="biz-1"
        provider="google"
        language="en"
        description="Link Google Ads to track performance and sync account data."
        view={{
          ...baseView,
          provider: "google",
          detailValue: "Healthy",
          accountValue: "1 assigned",
        }}
        googleSyncStatus={actionRequiredStatus}
        googleSyncLoading={false}
        onConnect={() => undefined}
        onReconnect={() => undefined}
        onRetry={() => undefined}
        onCancel={() => undefined}
        onDisconnect={() => undefined}
        onOpenAssignments={() => undefined}
      />
    );

    expect(html).toContain("Action required");
    expect(html).toContain("Google sync needs attention");
    expect(html).not.toContain('text-emerald-700">Connected</span>');
  });

  it("renders a compact Shopify status block without the Meta/Google staged breakdown", () => {
    const html = renderToStaticMarkup(
      <IntegrationsCard
      businessId="biz-1"
        provider="shopify"
        language="en"
        description="Sync storefront events and conversion data for attribution."
        view={{
          ...baseView,
          provider: "shopify",
          detailLabel: "Store",
          detailValue: "test-shop.myshopify.com",
          primaryActionLabel: "Connected",
          canManageAssignments: false,
        }}
        shopifySyncStatus={buildShopifyStatus()}
        shopifySyncLoading={false}
        onConnect={() => undefined}
        onReconnect={() => undefined}
        onRetry={() => undefined}
        onCancel={() => undefined}
        onDisconnect={() => undefined}
        onOpenAssignments={() => undefined}
      />
    );

    expect(html).toContain("Shopify sync");
    expect(html).toContain("Backfilling");
    expect(html).toContain("Recent Shopify commerce data is usable");
    expect(html).toContain("Ready through 2026-03-15");
    expect(html).not.toContain("Queue / worker");
    expect(html).not.toContain("Core data");
    expect(html).not.toContain("Analysis / advisor");
  });
});
