import { describe, expect, it, vi } from "vitest";

import {
  metaHealthy,
  metaRec,
} from "@/components/meta/redesign/test-fixtures";
import type {
  MetaArchivedEntity,
  MetaDecisionsWorkspacePayload,
  MetaHealthyEntity,
  MetaWatchingSegment,
} from "@/components/meta/redesign/types";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaOsAdDecision,
  MetaOsDecisionAction,
  MetaOsDecisionsPresentation,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";

import { buildMetaDecisionCenterExactViewModel } from "./meta-decision-center-exact-adapter";

const priority = {
  band: "high",
  rank: 100,
  version: "meta-os-decisions.presentation.v5",
} as const;

const urgency = {
  level: "high",
  rank: 3,
  label: "High",
  reason: null,
} as const;

function actionFixture(
  overrides: Partial<MetaOsDecisionAction> = {},
): MetaOsDecisionAction {
  return {
    code: "review_budget",
    label: "Review Campaign Budget",
    intent: "manual",
    targetLevel: "campaign",
    providerMutation: null,
    scopeNote: "Review only in the existing guarded flow.",
    ...overrides,
  };
}

function structureNodeFixture(
  overrides: Partial<MetaOsStructureNode> = {},
): MetaOsStructureNode {
  return {
    id: "node_1",
    sourceRecommendationId: "rec_action",
    level: "campaign",
    providerEntityId: "cmp_1",
    campaignId: "cmp_1",
    campaignName: "Server Campaign",
    name: "Server Campaign",
    lifecycleRole: "main",
    budgetOwner: "campaign",
    budgetMode: "campaign_budget",
    controlOwner: "campaign",
    status: "ACTIVE",
    optimizationGoal: "PURCHASE",
    action: actionFixture(),
    lane: "act",
    priority,
    urgency,
    confidence: "high",
    assessment: "Server assessment",
    whyNow: "Server why now",
    expectedImpact: "Server expected impact",
    evidence: [{ label: "Server evidence", value: "literal value", tone: "neutral" }],
    metrics: {
      spend: 500,
      purchases: 12,
      roas: 4.2,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 3.5,
      ratioToTarget: 1.2,
      currency: null,
      attribution: "meta_attributed",
      grain: "campaign_or_adset",
    },
    suppressedAlternativeCount: 0,
    ...overrides,
  };
}

function creativeFixture(
  overrides: Partial<MetaOsAdDecision> = {},
): MetaOsAdDecision {
  return {
    id: "os_ad_1",
    decisionId: "decision_1",
    sourceSnapshotId: "snapshot_1",
    episodeId: "episode_1",
    providerAccountId: "act_1",
    adId: "ad_1",
    adName: "Server Creative",
    campaignId: "cmp_1",
    campaignName: "Server Campaign",
    adsetId: "set_1",
    adsetName: "Server Ad set",
    creativeId: "creative_1",
    creativeName: "Server Creative",
    thumbnailUrl: null,
    lifecycleRole: "main",
    campaignRoleSource: "automatic",
    campaignRoleConfidence: "high",
    campaignRoleTrustedForAction: true,
    action: actionFixture({
      code: "provider_pause_withheld",
      label: "Review served creative decision",
      intent: "review",
      targetLevel: "ad",
      providerMutation: "pause",
    }),
    lane: "act",
    priority,
    assessment: "Server creative assessment",
    confidence: "high",
    confidenceScore: 0.91,
    riskTier: "high",
    confirmationCeremony: "highest",
    whyNow: "Server creative why now",
    blockers: [],
    resolution: null,
    metrics: {
      spend: 725,
      purchases: 18,
      roas: 3.8,
      cpa: null,
      ctr: null,
      frequency: null,
      effectiveTargetRoas: 3.1,
      ratioToTarget: 1.23,
      currency: "EUR",
      attribution: "meta_attributed",
      grain: "ad",
    },
    rawLabel: "scale",
    publishedLabel: "scale",
    engineVersion: "server-engine-v1",
    snapshotAsOf: "2026-08-16",
    sourceGrain: "ad",
    decisionAvailability: "available",
    ...overrides,
  };
}

function canonicalFixture(
  overrides: Partial<MetaCanonicalDecision> = {},
): MetaCanonicalDecision {
  return {
    decisionId: "decision_1",
    sourceSnapshotId: "snapshot_1",
    identityGrain: "ad",
    metrics: { currency: "GBP" },
    ...overrides,
  } as unknown as MetaCanonicalDecision;
}

interface WorkspaceFixtureInput {
  actionNow?: MetaRecommendation[];
  watching?: MetaRecommendation[];
  healthy?: MetaHealthyEntity[];
  nonSales?: MetaRecommendation[];
  archive?: MetaArchivedEntity[];
  watchSegments?: MetaWatchingSegment[];
  deferredIds?: string[];
  counts?: Partial<MetaDecisionsWorkspacePayload["lanes"]["counts"]>;
  os?: unknown;
  canonical?: MetaCanonicalDecision[];
  currency?: string | null;
  providerAccountId?: string | null;
  lastSyncAt?: string | null;
}

function fullOs(input: {
  nodes?: MetaOsStructureNode[];
  creatives?: MetaOsAdDecision[];
} = {}): MetaOsDecisionsPresentation {
  const nodes = input.nodes ?? [];
  const creatives = input.creatives ?? [];
  return {
    contractVersion: "meta-os-decisions.presentation.v5",
    generatedAt: "2026-08-17T10:00:00.000Z",
    source: {
      snapshotAsOf: "2026-08-16",
      engineVersion: "server-engine-v1",
      structureSource: "meta_recommendations",
      adsSource: "native_ad_decision",
      health: "healthy",
      fallbackReason: null,
    },
    structure: {
      groups: nodes.map((node) => ({
        id: `group_${node.id}`,
        campaign: node,
        adsets: [],
        highestPriority: node.priority,
        highestUrgency: node.urgency,
        urgentAdsetCount: 0,
      })),
      actCount: nodes.length,
      blockedCount: 0,
      monitorCount: 0,
      suppressedAlternativeCount: 0,
    },
    ads: {
      items: creatives,
      actCount: creatives.length,
      blockedCount: 0,
      monitorCount: 0,
      statePreCapCounts: { act: creatives.length, blocked: 0, monitor: 0 },
      eligiblePreCapCount: creatives.length,
      omittedWithoutVerifiedAdId: 0,
      omittedAmbiguousIdentity: 0,
      omittedNotApplicable: 0,
      sourcePreCapCount: creatives.length,
    },
    limitations: [],
  };
}

function workspaceFixture(
  input: WorkspaceFixtureInput = {},
): MetaDecisionsWorkspacePayload {
  const actionNow = input.actionNow ?? [];
  const watching = input.watching ?? [];
  const healthy = input.healthy ?? [];
  const nonSales = input.nonSales ?? [];
  const archive = input.archive ?? [];
  const canonical = input.canonical ?? [];
  const counts = {
    actionNow: actionNow.length,
    watching: watching.length,
    healthy: healthy.length,
    nonSales: nonSales.length,
    archive: archive.length,
    ...input.counts,
  };

  return {
    businessId: "biz_1",
    window: "28d",
    startDate: "2026-07-21",
    endDate: "2026-08-17",
    pulse: {
      businessId: "biz_1",
      window: "28d",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      pacing: {
        mtdSpend: 0,
        mtdTarget: 0,
        dayPace: 0,
      },
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
      lastSyncAt: input.lastSyncAt ?? null,
      currency: input.currency ?? null,
    },
    lanes: {
      businessId: "biz_1",
      startDate: "2026-07-21",
      endDate: "2026-08-17",
      sourceModel: "snapshot_persistent",
      snapshotDate: "2026-08-16",
      actionNow,
      watching,
      healthy,
      nonSales,
      archive,
      deferredIds: input.deferredIds ?? [],
      watchingSegments: input.watchSegments ?? [],
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
      currency: input.currency ?? null,
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
        providerAccountId: Object.prototype.hasOwnProperty.call(
          input,
          "providerAccountId",
        )
          ? input.providerAccountId ?? null
          : "act_1",
        decisionMode: "current",
        metricsRangeAffectsDecisionSnapshot: false,
      },
      source: {
        snapshotAsOf: "2026-08-16",
        computedAt: "2026-08-17T09:55:00.000Z",
        engineVersion: "server-engine-v1",
      },
      queue: {
        adCandidates: { items: canonical },
        sections: {},
      },
    },
    os: Object.prototype.hasOwnProperty.call(input, "os")
      ? input.os
      : fullOs(),
  } as unknown as MetaDecisionsWorkspacePayload;
}

function pausedArchive(): MetaArchivedEntity {
  return {
    id: "archive_1",
    level: "campaign",
    name: "Paused Campaign",
    status: "PAUSED",
    statusLabel: "PAUSED",
    spend: 980,
    roas: 2.1,
    cpa: null,
    purchases: 4,
    lastKnownWindow: "28d",
    diagnosticNote: "Inactive server evidence only.",
  };
}

describe("buildMetaDecisionCenterExactViewModel R7 boundaries", () => {
  it("fails missing currency and partial legacy OS closed without USD, writes, or prototype figures", () => {
    const nonSales = metaRec({
      id: "non_sales_1",
      campaignName: "Awareness Campaign",
      cohort: "upper_funnel",
    });
    const workspace = workspaceFixture({
      nonSales: [nonSales],
      archive: [pausedArchive()],
      currency: null,
      providerAccountId: null,
      lastSyncAt: "2026-08-17T09:48:00.000Z",
      os: {
        source: {
          snapshotAsOf: "2026-08-16",
          engineVersion: "server-engine-v1",
        },
      },
    });

    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace,
      account: { id: "act_unscoped", name: null, currency: null, timezone: null },
      selection: null,
    });

    expect(viewModel.identity).toMatchObject({
      accountLabel: "act_unscoped",
      currency: "—",
      syncedLabel: "synced —",
    });
    expect(viewModel.counts?.creatives).toBe("—");
    expect(viewModel.creativeDecisions).toEqual([]);
    expect(viewModel.archiveRows).toHaveLength(1);
    expect(viewModel.archiveRows?.[0]).toMatchObject({
      showResume: true,
      spend: "—",
    });
    expect(viewModel.archiveRows?.[0]).not.toHaveProperty("onResume");
    expect(viewModel.creativePosture).toHaveLength(4);
    expect(viewModel.creativePosture?.every((slot) =>
      slot.value === "—" && slot.detail === "—",
    )).toBe(true);
    expect(viewModel.nonSales?.contextLabel).toBe("Upper funnel · informational");
    expect(viewModel.nonSales?.metrics).toHaveLength(4);
    expect(viewModel.nonSales?.metrics?.every((slot) => slot.value === "—")).toBe(true);
    expect(viewModel.watchSegments?.map((slot) => slot.id)).toEqual([
      "learning",
      "recently_changed",
      "mid_confidence",
      "deferred",
      "insufficient_signal",
    ]);
    expect(viewModel.watchSegments?.every((slot) => slot.count === "—")).toBe(true);

    const serialized = JSON.stringify(viewModel);
    expect(serialized).not.toContain("USD");
    expect(serialized).not.toContain("$");
    expect(serialized).not.toContain("2026-08-17T09:48:00.000Z");
    for (const prototypeValue of [
      "$1,240",
      "5.12",
      "$8.6k",
      "41%",
      "38%",
      "1.2M",
      "$17.8k",
    ]) {
      expect(serialized).not.toContain(prototypeValue);
    }
  });

  it("binds real scoped fields and exact server tuples while callbacks remain caller-owned review paths", () => {
    const recommendation = metaRec({
      id: "rec_action",
      campaignId: "cmp_1",
      campaignName: "Scoped Campaign",
      decisionLabel: "scale",
      metrics: { spend: 111, roas: 1.1 },
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "scale",
        blockers: ["missing_executor"],
        missingEvidence: ["literal_server_receipt"],
        requiredEvidence: ["literal_server_receipt"],
        reason: "Literal server readiness reason.",
      },
    });
    const action = actionFixture();
    const node = structureNodeFixture({
      id: "node_not_the_recommendation_id",
      sourceRecommendationId: recommendation.id,
      action,
    });
    const creative = creativeFixture();
    const canonical = canonicalFixture();
    const decoyCanonical = canonicalFixture({ sourceSnapshotId: "wrong_snapshot" });
    const watchSegments: MetaWatchingSegment[] = [
      {
        key: "deferred",
        label: "Server order deferred",
        count: 4,
        description: "",
        ctaLabel: null,
        href: null,
      },
      {
        key: "issues",
        label: "Not a canonical exact slot",
        count: 99,
        description: "",
        ctaLabel: null,
        href: null,
      },
      {
        key: "learning",
        label: "Server order learning",
        count: 2,
        description: "",
        ctaLabel: null,
        href: null,
      },
    ];
    const workspace = workspaceFixture({
      actionNow: [recommendation],
      archive: [pausedArchive()],
      watchSegments,
      deferredIds: ["server_deferred_1"],
      currency: "USD",
      canonical: [decoyCanonical, canonical],
      os: fullOs({ nodes: [node], creatives: [creative] }),
      lastSyncAt: "2026-08-17T09:48:00.000Z",
    });
    const account: MetaHistoryAccount = {
      id: "act_1",
      name: "Authorized Account",
      currency: "TRY",
      timezone: "Europe/Istanbul",
    };
    const onStructurePrimary = vi.fn();
    const onCreativeReview = vi.fn();

    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace,
      account,
      now: "2026-08-17T10:00:00.000Z",
      overrides: { deferredCount: 6 },
      callbacks: { onStructurePrimary, onCreativeReview },
    });

    expect(viewModel.identity).toMatchObject({
      accountLabel: "Authorized Account",
      currency: "TRY",
      syncedLabel: "synced 12m ago",
    });
    expect(viewModel.counts?.deferred).toBe(6);
    expect(viewModel.actionRows?.[0]).toMatchObject({
      id: "rec_action",
      actionLabel: "Review Campaign Budget",
      money: "₺500 · ROAS 4.20",
      moneySub: "vs 3.50 target · Server expected impact",
    });
    viewModel.actionRows?.[0]?.onPrimary?.();
    expect(onStructurePrimary).toHaveBeenCalledTimes(1);
    expect(onStructurePrimary).toHaveBeenCalledWith(recommendation, action);

    expect(viewModel.inspector).toMatchObject({
      readiness: "manual_review · Literal server readiness reason.",
      blockers: "missing_executor · literal_server_receipt",
      blockerTone: "warning",
    });
    expect(viewModel.watchSegments?.map(({ id, count }) => [id, count])).toEqual([
      ["learning", 2],
      ["recently_changed", "—"],
      ["mid_confidence", "—"],
      ["deferred", 4],
      ["insufficient_signal", "—"],
    ]);
    expect(viewModel.creativeDecisions?.[0]).toMatchObject({
      id: "os_ad_1",
      name: "Server Creative",
      kindShort: "—",
      money: "€725 · ROAS 3.80",
      actionLabel: "Review served creative decision",
    });
    viewModel.creativeDecisions?.[0]?.onPrimary?.();
    viewModel.creativeDecisions?.[0]?.onOpen?.();
    expect(onCreativeReview).toHaveBeenCalledTimes(2);
    expect(onCreativeReview).toHaveBeenNthCalledWith(1, creative, canonical);
    expect(onCreativeReview).toHaveBeenNthCalledWith(2, creative, canonical);
    expect(viewModel.archiveRows?.[0]).not.toHaveProperty("onResume");

    const creativeInspector = buildMetaDecisionCenterExactViewModel({
      workspace,
      account,
      selection: {
        kind: "creative",
        decisionId: creative.decisionId,
        sourceSnapshotId: creative.sourceSnapshotId,
      },
      callbacks: { onCreativeReview },
    }).inspector;
    creativeInspector?.onPrimary?.();
    expect(onCreativeReview).toHaveBeenLastCalledWith(creative, canonical);
  });

  it("uses optional filtered row overrides without replacing full server lane counts", () => {
    const first = metaRec({ id: "rec_first", campaignName: "First" });
    const second = metaRec({ id: "rec_second", campaignName: "Second" });
    const workspace = workspaceFixture({
      actionNow: [first, second],
      watching: [metaRec({ id: "watch_full", decisionState: "watch" })],
      healthy: [metaHealthy({ id: "healthy_full" })],
      nonSales: [metaRec({ id: "non_sales_full" })],
      archive: [pausedArchive()],
      counts: {
        actionNow: 8,
        watching: 7,
        healthy: 6,
        nonSales: 5,
        archive: 4,
      },
      os: fullOs(),
    });

    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace,
      selection: null,
      overrides: {
        actionNow: [second],
        watching: [],
        healthy: [],
        nonSales: [],
        archive: [],
        creatives: [],
        deferredCount: 3,
      },
    });

    expect(viewModel.actionRows?.map((row) => row.id)).toEqual(["rec_second"]);
    expect(viewModel.watchingRows).toEqual([]);
    expect(viewModel.healthyGroups).toEqual([]);
    expect(viewModel.archiveRows).toEqual([]);
    expect(viewModel.counts).toMatchObject({
      action: 8,
      watching: 7,
      healthy: 6,
      nonsales: 5,
      archive: 4,
      deferred: 3,
    });
  });

  it("binds custom-range ROAS and target freshness without relabeling a mid-funnel row", () => {
    const workspace = workspaceFixture({
      nonSales: [
        metaRec({
          id: "mid_funnel_row",
          cohort: "mid_funnel",
          decisionState: "watch",
        }),
      ],
    });
    workspace.window = "custom";
    workspace.pulse.window = "custom";
    workspace.pulse.roas.selected = 4.2;
    workspace.pulse.roas.d28 = 1.1;
    workspace.pulse.roas.target = 3.8;
    workspace.pulse.roas.target_source = "commercial_truth";
    workspace.pulse.roas.targetFreshness = "stale";

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(viewModel.activeWindow).toBeNull();
    expect(viewModel.kpis?.roas).toMatchObject({
      label: "ROAS · selected range",
      value: "4.20",
      target: "3.80 · stale",
    });
    expect(viewModel.nonSales?.contextLabel).toBe(
      "Mid Funnel · informational",
    );
  });
});
