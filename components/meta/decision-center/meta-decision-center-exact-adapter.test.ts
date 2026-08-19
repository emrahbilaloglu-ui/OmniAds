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
    expect(viewModel.archiveRows?.[0]).toMatchObject({ spend: "—" });
    // Archive is evidence. With no server action tuple there is no authority to
    // resume, so the row must not draw a Resume button it could only ever dim.
    expect(viewModel.archiveRows?.[0]).not.toHaveProperty("onResume");
    expect(viewModel.archiveRows?.[0]?.showResume).toBeUndefined();
    expect(viewModel.creativePosture).toHaveLength(4);
    expect(viewModel.creativePosture?.every((slot) =>
      slot.value === "—" && slot.detail === "—",
    )).toBe(true);
    expect(viewModel.nonSales?.[0]?.contextLabel).toBe(
      "Upper funnel · informational",
    );
    expect(viewModel.nonSales?.[0]?.metrics).toHaveLength(4);
    expect(
      viewModel.nonSales?.[0]?.metrics?.every((slot) => slot.value === "—"),
    ).toBe(true);
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
    // A ROAS needs spend behind it; the adapter withholds it otherwise, and a
    // fixture with 4.2x on zero spend is not a state the account can be in.
    workspace.pulse.pacing.windowSpend = 8600;
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
    expect(viewModel.nonSales?.[0]?.contextLabel).toBe(
      "Mid Funnel · informational",
    );
  });
});

describe("the bands the reference draws are backed, or honestly blank", () => {
  it("computes the posture tiles it can from served rows and leaves the rest blank", () => {
    const workspace = workspaceFixture({
      os: {
        ads: {
          items: [
            creativeFixture({
              id: "os_ad_freq_a",
              publishedLabel: "refresh",
              metrics: {
                ...creativeFixture().metrics,
                spend: 900,
                frequency: 4,
              },
            }),
            creativeFixture({
              id: "os_ad_freq_b",
              decisionId: "decision_2",
              publishedLabel: "keep",
              metrics: {
                ...creativeFixture().metrics,
                spend: 100,
                frequency: 1,
              },
            }),
            // No spend and no frequency: it counts toward the served total but
            // must not enter the weighted mean as a zero.
            creativeFixture({
              id: "os_ad_freq_c",
              decisionId: "decision_3",
              publishedLabel: "refresh",
              metrics: {
                ...creativeFixture().metrics,
                spend: null,
                frequency: null,
              },
            }),
          ],
        },
      },
    });

    const posture = buildMetaDecisionCenterExactViewModel({ workspace })
      .creativePosture;
    const byId = new Map(posture?.map((slot) => [slot.id, slot]));

    // (4 × 900 + 1 × 100) / 1000 = 3.7 — spend-weighted, not the flat mean 2.5.
    expect(byId.get("average-frequency")?.value).toBe("3.7");
    expect(byId.get("average-frequency")?.detail).toBe("2 of 3 creatives");
    expect(byId.get("refresh-pipeline")?.value).toBe("2");
    expect(byId.get("refresh-pipeline")?.detail).toBe("of 3 served decisions");
    // No served fatigue status and no served notion of a winner: the adapter
    // must not mint either from the labels it happens to have.
    expect(byId.get("fatigued-spend-share")?.value).toBe("—");
    expect(byId.get("winner-concentration")?.value).toBe("—");
  });

  it("renders every non-sales entity and fills the tiles the server enriched", () => {
    const workspace = workspaceFixture({
      currency: "USD",
      nonSales: [
        metaRec({
          id: "non_sales_a",
          campaignName: "Video Views",
          cohort: "upper_funnel",
          targetValue: {
            cpm: 12.5,
            cpmAccountP50: 9,
            thruplayActions: 4210,
            reach: 51_000,
          },
        }),
        metaRec({ id: "non_sales_b", campaignName: "Reach Broad" }),
      ],
    });

    const cards = buildMetaDecisionCenterExactViewModel({ workspace }).nonSales;
    // The lane tab counts them all, so the queue has to render them all.
    expect(cards).toHaveLength(2);

    const tiles = new Map(cards?.[0]?.metrics?.map((tile) => [tile.id, tile.value]));
    expect(tiles.get("thruplay")).toBe("4,210");
    expect(tiles.get("cpm")).toBe("$12.50");
    expect(tiles.get("cpm-account-p50")).toBe("$9");
    // Stored reach is a sum over daily rows, so a 28-day unique reach cannot be
    // read off it. A summed number under this caption would be a wrong figure
    // wearing a right label.
    expect(tiles.get("reach-28d")).toBe("—");
  });
});

describe("the lineage read fills what the reference draws", () => {
  it("binds media kind, fatigue share, row sparkline and the entity's own ROAS trail", () => {
    const fatigued = creativeFixture({
      id: "os_ad_fatigued",
      adId: "ad_fatigued",
      creativeFormat: "video",
      fatigueStatus: "fatigued",
      metrics: { ...creativeFixture().metrics, spend: 750, frequency: 5 },
    });
    const healthy = creativeFixture({
      id: "os_ad_healthy",
      decisionId: "decision_healthy",
      adId: "ad_healthy",
      creativeFormat: "catalog",
      fatigueStatus: "none",
      metrics: { ...creativeFixture().metrics, spend: 250, frequency: 1 },
    });
    // Assessed nowhere: it must not land in the denominator as "healthy".
    const unassessed = creativeFixture({
      id: "os_ad_unknown",
      decisionId: "decision_unknown",
      adId: "ad_unknown",
      creativeFormat: null,
      fatigueStatus: "unknown",
      metrics: { ...creativeFixture().metrics, spend: 4000, frequency: 2 },
    });

    const workspace = workspaceFixture({
      actionNow: [
        metaRec({
          id: "rec_trail",
          evidenceTrail: {
            roas_history: [1, 2, 3, 4],
            peer_comparison: { p10: 1, p50: 2, p90: 3, this_value: 2 },
            regime_stability: 1,
            age_days: 30,
            recent_changes: [],
          },
        }),
      ],
      os: { ads: { items: [fatigued, healthy, unassessed] } },
    });

    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace,
      overrides: {
        creativeCtrSeriesByAdId: new Map([["ad_fatigued", [1, 2, 1.5]]]),
      },
    });

    const rows = new Map(viewModel.creativeDecisions?.map((row) => [row.id, row]));
    expect(rows.get("os_ad_fatigued")?.kindShort).toBe("VID");
    expect(rows.get("os_ad_healthy")?.kindShort).toBe("CAT");
    // No served format is unknown, not a kind invented from something else.
    expect(rows.get("os_ad_unknown")?.kindShort).toBe("—");
    expect(rows.get("os_ad_fatigued")?.sparkPath).toContain("M0.0");
    // An ad the caller had no series for keeps the empty path rather than
    // borrowing the shape of the row above it.
    expect(rows.get("os_ad_healthy")?.sparkPath).toBeNull();

    const posture = new Map(viewModel.creativePosture?.map((slot) => [slot.id, slot]));
    // 750 fatigued of 1000 assessed. The 4000 unassessed spend is excluded from
    // both sides rather than counted as healthy, which would have said 15%.
    expect(posture.get("fatigued-spend-share")?.value).toBe("75%");
    expect(posture.get("fatigued-spend-share")?.detail).toBe(
      "of 2 assessed creatives",
    );

    expect(viewModel.inspector?.moneySparkPath).toContain("M0.0");
  });
});

describe("an empty Creatives scope says why, when the server gave a reason", () => {
  /**
   * An empty queue and a refused decision source render identically. On a real
   * account the native job can report `complete_source_run_missing`, the read
   * model falls back to the legacy source, and the scope serves nothing — with
   * no way for the operator to tell that apart from "no work today".
   */
  it("joins the served limitation and the fallback reason", () => {
    const workspace = workspaceFixture({});
    workspace.os.source.adsSource = "legacy_creative_review_only";
    workspace.os.source.fallbackReason = "native_account_manifest_incomplete";
    workspace.os.limitations = [
      {
        code: "legacy_creative_review_only",
        message: "Legacy creative-grain decisions cannot authorize Ad writes.",
      },
    ];

    expect(buildMetaDecisionCenterExactViewModel({ workspace }).creativesNotice).toBe(
      "Legacy creative-grain decisions cannot authorize Ad writes. Source: native_account_manifest_incomplete.",
    );
  });

  it("says nothing when the native source is the authority", () => {
    const workspace = workspaceFixture({});
    workspace.os.source.adsSource = "native_ad_decision";
    workspace.os.source.fallbackReason = null;
    // A healthy account with no actionable creative today needs no explanation
    // beyond the empty queue itself.
    expect(
      buildMetaDecisionCenterExactViewModel({ workspace }).creativesNotice,
    ).toBeNull();
  });

  it("still states the refusal when the payload carries no written limitation", () => {
    const workspace = workspaceFixture({});
    workspace.os.source.adsSource = "legacy_creative_review_only";
    workspace.os.source.fallbackReason = null;
    workspace.os.limitations = [];
    const notice = buildMetaDecisionCenterExactViewModel({ workspace }).creativesNotice;
    expect(notice).toContain("native decision source is not the authority");
  });
});

describe("ROAS is withheld when there was no spend to divide by", () => {
  /**
   * Return on ad spend is undefined at zero spend, not zero. The rollup reports
   * a literal 0 for both "spent nothing" and "summed no rows", so printing
   * 0.00 turned the second into a claim that the account earned nothing — the
   * shape of the Decision Center reporting ROAS 0.00 for an account spending
   * over a thousand dollars a day.
   */
  it("shows a dash, not 0.00, when the window carries no spend", () => {
    const workspace = workspaceFixture({});
    workspace.pulse.pacing.windowSpend = 0;
    workspace.pulse.roas.selected = 0;
    expect(
      buildMetaDecisionCenterExactViewModel({ workspace }).kpis?.roas?.value,
    ).toBe("—");
  });

  it("still reports a real zero return on real spend", () => {
    const workspace = workspaceFixture({});
    workspace.pulse.pacing.windowSpend = 1200;
    workspace.pulse.roas.selected = 0;
    // Money went out and nothing came back: that zero is a fact, not a gap.
    expect(
      buildMetaDecisionCenterExactViewModel({ workspace }).kpis?.roas?.value,
    ).toBe("0.00");
  });
});
