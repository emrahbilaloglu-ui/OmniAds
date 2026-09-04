import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { metaHealthy, metaRec } from "@/components/meta/redesign/test-fixtures";
import type {
  MetaArchivedEntity,
  MetaDecisionsWorkspacePayload,
  MetaHealthyEntity,
  MetaStructureInventoryEntity,
  MetaWatchingSegment,
} from "@/components/meta/redesign/types";
import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import {
  emptyAuthorityBlockerCounts,
  projectMetaCommercialAnchorPanel,
  type MetaCommercialAnchorPanel,
} from "@/lib/meta/commercial-anchor-panel";
import {
  projectBudgetDecisionEvidencePanel,
  type MetaBudgetDecisionEvidenceByDirection,
} from "@/lib/meta/budget-decision-evidence-panel";
import { evaluateBudgetDecisionGates } from "@/lib/meta/budget-decision-gates";
import { buildWorkspaceBudgetGateInput } from "@/lib/meta/budget-decision-workspace-adapter";
import {
  makeAnchorTargetPack,
  resolveAnchorProfileFixture,
} from "@/lib/creative-decision-engine/__tests__/anchor-profile-fixture";
import { makeAccountCalibration } from "@/lib/creative-decision-engine/__tests__/helpers";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaOsAdDecision,
  MetaOsDecisionAction,
  MetaOsLegacyDecisionAction,
  MetaOsDecisionsPresentation,
  MetaOsStructureNode,
} from "@/lib/meta/decisions-os-contract";

import {
  buildMetaDecisionCenterExactViewModel,
  buildMetaStructureInventoryViewModel,
} from "./meta-decision-center-exact-adapter";

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
  overrides: Partial<MetaOsLegacyDecisionAction> = {},
): MetaOsLegacyDecisionAction {
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
    evidence: [
      { label: "Server evidence", value: "literal value", tone: "neutral" },
    ],
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
  structureInventory?: MetaStructureInventoryEntity[];
  watchSegments?: MetaWatchingSegment[];
  deferredIds?: string[];
  counts?: Partial<MetaDecisionsWorkspacePayload["lanes"]["counts"]>;
  os?: unknown;
  canonical?: MetaCanonicalDecision[];
  inactiveAssets?: MetaCanonicalDecision[];
  currency?: string | null;
  providerAccountId?: string | null;
  lastSyncAt?: string | null;
  commercialAnchor?: MetaCommercialAnchorPanel;
  budgetEvidence?: MetaBudgetDecisionEvidenceByDirection;
}

function fullOs(
  input: {
    nodes?: MetaOsStructureNode[];
    creatives?: MetaOsAdDecision[];
  } = {},
): MetaOsDecisionsPresentation {
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
      actCount: nodes.filter((node) => node.lane === "act").length,
      blockedCount: nodes.filter((node) => node.lane === "blocked").length,
      monitorCount: nodes.filter((node) => node.lane === "monitor").length,
      suppressedAlternativeCount: nodes.reduce(
        (total, node) => total + node.suppressedAlternativeCount,
        0,
      ),
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

function healthyPipelineHealth() {
  return {
    contractVersion: "meta-decision-pipeline-health.v1" as const,
    evaluatedAt: "2026-08-17T10:00:00.000Z",
    overall: "healthy" as const,
    executionReady: true,
    blockers: [],
    syncActivity: {
      status: "fresh" as const,
      latestAt: "2026-08-17T09:58:00.000Z",
      ageMinutes: 2,
      maxAgeMinutes: 60,
      latestJobStatus: "succeeded",
      latestRunStatus: "succeeded",
      reason: null,
    },
    warehouse: {
      status: "fresh" as const,
      latestFinalizedDate: "2026-08-16",
      expectedFinalizedDate: "2026-08-16",
      lagDays: 0,
      accountTimeZone: "Europe/Istanbul",
      reason: null,
    },
    admission: {
      status: "fresh" as const,
      allowed: true,
      reason: "ready",
      offender: null,
      evaluatedAt: "2026-08-17T10:00:00.000Z",
    },
    decisionGeneration: {
      status: "fresh" as const,
      computedAt: "2026-08-17T09:55:00.000Z",
      ageHours: 1 / 12,
      maxAgeHours: 12,
      engineVersion: "server-engine-v1",
      reason: null,
    },
    manifest: {
      status: "fresh" as const,
      authority: "native_ad",
      jobRunId: "job_1",
      manifestHash: "a".repeat(64),
      expectedAdCount: 1,
      reason: null,
    },
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
      ...(input.structureInventory
        ? { structureInventory: input.structureInventory }
        : {}),
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
      pipelineHealth: healthyPipelineHealth(),
      ...(input.commercialAnchor
        ? { commercialAnchor: input.commercialAnchor }
        : {}),
      ...(input.budgetEvidence ? { budgetEvidence: input.budgetEvidence } : {}),
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
          ? (input.providerAccountId ?? null)
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
        inactiveAssets: {
          preCapCount: (input.inactiveAssets ?? []).length,
          inactiveCount: (input.inactiveAssets ?? []).length,
          unknownCount: 0,
          items: input.inactiveAssets ?? [],
        },
      },
    },
    os: Object.prototype.hasOwnProperty.call(input, "os") ? input.os : fullOs(),
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
      account: {
        id: "act_unscoped",
        name: null,
        currency: null,
        timezone: null,
      },
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
    expect(
      viewModel.creativePosture?.every(
        (slot) => slot.value === "—" && slot.detail === "—",
      ),
    ).toBe(true);
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
    expect(viewModel.watchSegments?.every((slot) => slot.count === "—")).toBe(
      true,
    );

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
    const decoyCanonical = canonicalFixture({
      sourceSnapshotId: "wrong_snapshot",
    });
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
      readiness: "Manual review required · Literal server readiness reason.",
      blockers:
        "No executor is enabled for this action type · Literal server receipt",
      blockerTone: "warning",
    });
    expect(JSON.stringify(viewModel.inspector)).not.toContain("manual_review");
    expect(JSON.stringify(viewModel.inspector)).not.toContain(
      "missing_executor",
    );
    expect(
      viewModel.watchSegments?.map(({ id, count }) => [id, count]),
    ).toEqual([
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

  it("keeps the served advisories out of the Blockers line and states them with their reason", () => {
    /*
     * `risk_tier_unclassified` used to arrive inside
     * `classification.blockers`, so the inspector's Blockers line and the
     * blocked-row note both said "Risk is unclassified" about rows that were
     * fully authorized to act — the one line that answers "why can this row
     * not move" naming something that never moved anything.
     *
     * The statement is kept, on its own line, with the reason attached: the
     * risk-tier producer is not persisted, which is a gap in this pipeline and
     * not a finding about the ad.
     */
    const creative = creativeFixture({ blockers: [] });
    const canonical = canonicalFixture({
      decisionId: creative.decisionId,
      sourceSnapshotId: creative.sourceSnapshotId,
      classification: {
        blockers: [],
        advisories: [
          {
            code: "risk_tier_unclassified",
            label: "Risk is unclassified",
            category: "risk",
            reason: "risk_tier_producer_not_persisted",
            provenance: {
              source: "overlay",
              field: "riskTier",
              recordId: null,
              asOf: null,
              version: null,
            },
          },
        ],
      },
    } as unknown as Partial<MetaCanonicalDecision>);

    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({
        os: fullOs({ creatives: [creative] }),
        canonical: [canonical],
      }),
      selection: {
        kind: "creative",
        decisionId: creative.decisionId,
        sourceSnapshotId: creative.sourceSnapshotId,
      },
    });

    expect(viewModel.inspector).toMatchObject({
      blockers: "—",
      blockerTone: "neutral",
      advisories: "Risk is unclassified (risk tier producer not persisted)",
    });
    // An advisory is not a reason a row cannot move, so it never becomes the
    // blocked note.
    expect(viewModel.creativeDecisions?.[0]).not.toHaveProperty("blockedNote");
  });

  it("translates automation safety codes into operator-readable copy without changing the served gates", () => {
    const recommendation = metaRec({
      id: "rec_human_readable_gates",
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        decisionLabel: "scale",
        blockers: [
          "missing_controlled_causal_evidence",
          "missing_valid_treatment_receipt",
          "missing_live_preflight",
          "missing_rollback_plan",
          "missing_operator_enablement",
          "unsupported_action_class",
        ],
        missingEvidence: [
          "controlled_causal_outcomes",
          "empirical_outcome_sample",
        ],
        requiredEvidence: [],
        reason: "This action class is not mapped to a safe Meta executor.",
      },
    });
    const node = structureNodeFixture({
      sourceRecommendationId: recommendation.id,
    });
    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({
        actionNow: [recommendation],
        os: fullOs({ nodes: [node] }),
      }),
    });

    expect(viewModel.inspector?.readiness).toBe(
      "Manual review required · This action class is not mapped to a safe Meta executor.",
    );
    expect(viewModel.inspector?.blockers).toContain(
      "Controlled causal evidence is missing",
    );
    expect(viewModel.inspector?.blockers).toContain(
      "Live Meta preflight evidence is missing",
    );
    expect(viewModel.inspector?.blockers).toContain(
      "A rollback plan is missing",
    );
    expect(viewModel.inspector?.blockers).toContain(
      "Operator execution is not enabled",
    );
    expect(viewModel.inspector?.blockers).toContain(
      "Controlled causal outcomes are required",
    );
    expect(viewModel.inspector?.blockers).toContain(
      "An empirical outcome sample is required",
    );
    expect(JSON.stringify(viewModel.inspector)).not.toMatch(
      /manual_review|missing_[a-z_]+|unsupported_action_class/,
    );
  });

  it("says an em dash for advisories when no canonical envelope was served", () => {
    const creative = creativeFixture({ blockers: [] });
    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({ os: fullOs({ creatives: [creative] }) }),
      selection: {
        kind: "creative",
        decisionId: creative.decisionId,
        sourceSnapshotId: creative.sourceSnapshotId,
      },
    });
    expect(viewModel.inspector?.advisories).toBe("—");
  });

  it("qualifies a healthy group's one strategy when the server says its ad sets disagree", () => {
    /*
     * The group line prints ONE bid strategy for a whole campaign. The server
     * already says when that single answer summarises children that disagree,
     * and dropping the flag made the line state something false for part of
     * the group: "Lowest Cost", flatly, for a campaign whose ad sets run
     * Lowest Cost and Cost Cap side by side.
     *
     * A mixed flag is rendered exactly where the value it qualifies is
     * rendered — which is why `isOptimizationGoalMixed`, `isCustomEventTypeMixed`
     * and `isBidValueMixed` stay unrendered in this lane: it prints none of
     * the three values they qualify.
     * @see decision-payload-coverage.test.ts
     */
    const agreed = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({
        healthy: [
          metaHealthy({
            id: "cmp_agreed",
            campaignId: "cmp_agreed",
            bidStrategyLabel: "Lowest Cost",
            isBidStrategyMixed: false,
            isOptimizationGoalMixed: true,
            isBidValueMixed: true,
          }),
        ],
      }),
      selection: null,
    }).healthyGroups;
    expect(agreed?.[0]?.strategy).toBe("Lowest Cost");

    const mixed = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({
        healthy: [
          metaHealthy({
            id: "cmp_mixed",
            campaignId: "cmp_mixed",
            bidStrategyLabel: "Lowest Cost",
            isBidStrategyMixed: true,
          }),
        ],
      }),
      selection: null,
    }).healthyGroups;
    expect(mixed?.[0]?.strategy).toBe("Lowest Cost · mixed");

    // No served strategy at all is still an em dash: "mixed" qualifies a
    // value, and there is nothing here for it to qualify.
    const unserved = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({
        healthy: [
          metaHealthy({
            id: "cmp_unserved",
            campaignId: "cmp_unserved",
            bidStrategyLabel: null,
            bidStrategyType: null,
            isBidStrategyMixed: true,
          }),
        ],
      }),
      selection: null,
    }).healthyGroups;
    expect(unserved?.[0]?.strategy).toBe("—");
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
      target: "target 3.80 · stale",
    });
    expect(viewModel.nonSales?.[0]?.contextLabel).toBe(
      "Mid Funnel · informational",
    );
  });
});

describe("the ROAS reference states the source the server declared", () => {
  /*
   * `/api/meta/account-pulse` answers this reference from four sources and
   * NAMES the one in force in `target_source`. The tile used to format
   * `target` alone, so the arm where the server sets `target: null` and serves
   * the account median it MEASURED printed an em dash — "we could not tell"
   * about a number the server did tell, on every business unit without a fresh
   * commercial-truth target.
   *
   * What is pinned here is that all four arms read differently, and that the
   * median never borrows the target's noun: the engine's own comparisons and
   * the mobile decision line still speak of a "target", and an account median
   * captioned as one would be a target nobody set.
   */
  function referenceFor(
    roas: Partial<MetaDecisionsWorkspacePayload["pulse"]["roas"]>,
  ): string | number | null | undefined {
    const workspace = workspaceFixture();
    workspace.pulse.pacing.windowSpend = 8600;
    workspace.pulse.roas = { ...workspace.pulse.roas, ...roas };
    return buildMetaDecisionCenterExactViewModel({ workspace }).kpis?.roas
      ?.target;
  }

  it("prints a fresh commercial-truth target with no qualifier", () => {
    expect(
      referenceFor({
        target: 2.5,
        median: 2.1,
        target_source: "commercial_truth",
        targetFreshness: "fresh",
      }),
    ).toBe("target 2.50");
  });

  it("never lets a stale commercial-truth target read as a fresh one", () => {
    expect(
      referenceFor({
        target: 2.5,
        median: 2.1,
        target_source: "commercial_truth_stale",
        targetFreshness: "stale",
      }),
    ).toBe("target 2.50 · stale");
    expect(
      referenceFor({
        target: 2.5,
        median: 2.1,
        target_source: "commercial_truth_stale",
        targetFreshness: "unknown",
      }),
    ).toBe("target 2.50 · freshness unknown");
  });

  it("states the measured account median under its own name", () => {
    const reference = referenceFor({
      target: null,
      median: 2.1,
      target_source: "account_median",
      targetFreshness: "unknown",
    });

    expect(reference).toBe("account median 2.10");
    // The two failures this replaces, pinned from both sides: the em dash that
    // hid a measured number, and the alias that would have invented a target.
    expect(reference).not.toBe("—");
    expect(reference).not.toContain("target");
  });

  it("keeps the median's own absence honest instead of falling back to the target", () => {
    expect(
      referenceFor({
        target: null,
        median: null,
        target_source: "account_median",
        targetFreshness: "unknown",
      }),
    ).toBe("account median —");
  });

  it("leaves the arm with no reference at all an em dash", () => {
    expect(
      referenceFor({
        target: null,
        median: null,
        target_source: "none",
        targetFreshness: "unknown",
      }),
    ).toBe("target —");
  });

  it("shows the account median without disturbing the comparison the rows draw from the engine's own target", () => {
    const workspace = workspaceFixture({
      actionNow: [metaRec({ id: "rec_action" })],
      os: fullOs({ nodes: [structureNodeFixture()] }),
    });
    workspace.pulse.pacing.windowSpend = 8600;
    workspace.pulse.roas = {
      ...workspace.pulse.roas,
      target: null,
      median: 2.1,
      target_source: "account_median",
      targetFreshness: "unknown",
    };

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(viewModel.kpis?.roas?.target).toBe("account median 2.10");
    // The queue's "vs N target" is each decision's own effectiveTargetRoas —
    // a different resolution reading a different field, which the tile must
    // not have started speaking for. Both sides pinned: the row keeps the
    // engine's number, and the median reaches no line that says "target".
    expect(viewModel.actionRows?.[0]?.moneySub).toContain("vs 3.50 target");
    expect(JSON.stringify(viewModel)).not.toContain("vs 2.10 target");
    expect(JSON.stringify(viewModel)).not.toContain("target 2.10");
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

    const posture = buildMetaDecisionCenterExactViewModel({
      workspace,
    }).creativePosture;
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

    const tiles = new Map(
      cards?.[0]?.metrics?.map((tile) => [tile.id, tile.value]),
    );
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

    const rows = new Map(
      viewModel.creativeDecisions?.map((row) => [row.id, row]),
    );
    expect(rows.get("os_ad_fatigued")?.kindShort).toBe("VID");
    expect(rows.get("os_ad_healthy")?.kindShort).toBe("CAT");
    // No served format is unknown, not a kind invented from something else.
    expect(rows.get("os_ad_unknown")?.kindShort).toBe("—");
    expect(rows.get("os_ad_fatigued")?.sparkPath).toContain("M0.0");
    // An ad the caller had no series for keeps the empty path rather than
    // borrowing the shape of the row above it.
    expect(rows.get("os_ad_healthy")?.sparkPath).toBeNull();

    const posture = new Map(
      viewModel.creativePosture?.map((slot) => [slot.id, slot]),
    );
    // 750 fatigued of 1000 assessed. The 4000 unassessed spend is excluded from
    // both sides rather than counted as healthy, which would have said 15%.
    expect(posture.get("fatigued-spend-share")?.value).toBe("75%");
    expect(posture.get("fatigued-spend-share")?.detail).toBe(
      "of 2 assessed creatives",
    );

    expect(viewModel.inspector?.moneySparkPath).toContain("M0.0");
  });
});

describe("the creative queue is the served set, split by the served state", () => {
  /**
   * LAW: `os.ads.items` is the served creative queue. A section is a RANKING.
   *
   * Measured on Grandmix (act_805150454596350) the payload carried 60 Ads in
   * `os.ads.items`, `queue.adCandidates.items` was EMPTY (every Ad omitted as
   * not-applicable) and `sections.creative_rotation` held 5 `out_of_scope`
   * decisions that matched none of the 60. The old intersection therefore
   * rendered nothing at all. These assertions pin the three facts that fix
   * gave back: every served row renders, its served state is visible, and its
   * blockers and resolution are printed instead of dropped.
   */
  it("renders rows no canonical envelope backs, and keeps their state visible", () => {
    const acted = creativeFixture();
    const pending = creativeFixture({
      id: "os_ad_pending",
      decisionId: "inventory:ad_2",
      sourceSnapshotId: "inventory:ad_2:2026-08-16",
      adId: "ad_2",
      adName: "Live Ad Without A Decision",
      lane: "blocked",
      decisionAvailability: "pending_native_evidence",
      publishedLabel: "not_evaluated",
      rawLabel: null,
      whyNow:
        "Meta confirms this Ad is ACTIVE, but the exact Ad-grain decision snapshot is not available.",
      action: actionFixture({
        code: "await_ad_grain_evidence",
        label: "Evidence pending",
        intent: "review",
        targetLevel: "ad",
        providerMutation: null,
      }),
      blockers: [
        {
          code: "native_ad_decision_unavailable",
          label: "Exact Ad-grain decision evidence is unavailable",
        },
      ],
      resolution: {
        code: "produce_native_ad_decision",
        category: "system",
        owner: "system",
        label: "Produce exact Ad decision",
        nextStep:
          "Complete the native Ad decision schema and producer lineage gate.",
      },
    });
    const workspace = workspaceFixture({
      canonical: [canonicalFixture()],
      os: fullOs({ creatives: [acted, pending] }),
    });
    // The server's own pre-cap totals: the queue is a capped window onto them.
    (workspace as any).os.ads.statePreCapCounts = {
      act: 1,
      blocked: 80,
      monitor: 0,
    };
    const onCreativeReview = vi.fn();

    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace,
      callbacks: { onCreativeReview },
    });

    expect(viewModel.creativeDecisions?.map((row) => row.id)).toEqual([
      "os_ad_1",
      "os_ad_pending",
    ]);
    const rows = new Map(
      viewModel.creativeDecisions?.map((row) => [row.id, row]),
    );
    expect(rows.get("os_ad_pending")).toMatchObject({
      stateLabel: "Blocked",
      stateTone: "warning",
      note: "Meta confirms this Ad is ACTIVE, but the exact Ad-grain decision snapshot is not available.",
      blockedNote:
        "Exact Ad-grain decision evidence is unavailable — Next: Complete the native Ad decision schema and producer lineage gate.",
    });
    /*
     * LAW: a served row can open its own evidence, and the envelope's absence
     * travels with it instead of closing the door.
     *
     * This used to assert the opposite — no `onPrimary`, no `onOpen` on a row
     * with no envelope — and that assertion was pinning the defect. On Grandmix
     * the envelope join matches ZERO of the 60 served ads, so the rule "no
     * envelope, no affordance" made the evidence window unreachable by any
     * click on the entire account, while the payload carried the engine's real
     * evidence for every one of those rows.
     *
     * What must stay true, and is asserted here: the callback receives the
     * canonical envelope EXACTLY as the join found it, `null` included. Nothing
     * is substituted, and the row's authority question is answered downstream
     * by the window rather than papered over here.
     */
    rows.get("os_ad_pending")?.onOpen?.();
    expect(onCreativeReview).toHaveBeenNthCalledWith(1, pending, null);
    rows.get("os_ad_pending")?.onPrimary?.();
    expect(onCreativeReview).toHaveBeenNthCalledWith(2, pending, null);
    rows.get("os_ad_1")?.onPrimary?.();
    expect(onCreativeReview).toHaveBeenNthCalledWith(
      3,
      acted,
      canonicalFixture(),
    );
    expect(onCreativeReview).toHaveBeenCalledTimes(3);

    const groups = new Map(
      viewModel.creativeGroups?.map((group) => [group.id, group]),
    );
    // Only states the server actually filled become groups.
    expect([...groups.keys()]).toEqual(["act", "blocked"]);
    expect(groups.get("blocked")).toMatchObject({
      label: "Blocked",
      count: "1 shown · 80 eligible pre-cap",
      note: "Evidence pending",
    });
    // The act group is not capped, so it states one number, not two.
    expect(groups.get("act")?.count).toBe("1 shown");

    // LAW: the footer states the SERVED vocabulary. It used to assert a fixed
    // three-verb list ("refresh, retire, scale winner") that no real account
    // serves.
    expect(viewModel.creativeFootnote).toBe(
      "Ad-level calls served for this account: Review served creative decision · Evidence pending. " +
        "Click a row for the evidence window; metric deep-dives and side-by-side comparison live in Creative Studio.",
    );
  });

  it("says so when the account was served no ad-level call at all", () => {
    const workspace = workspaceFixture({ os: fullOs({ creatives: [] }) });
    expect(
      buildMetaDecisionCenterExactViewModel({ workspace }).creativeFootnote,
    ).toContain("No ad-level call was served for this account.");
  });

  /**
   * LAW: the envelope lookup is a union of every served list, not one of them.
   *
   * `adCandidates` is present-but-empty on any account whose Ads are all
   * omitted as not-applicable, and the old lookup returned it and stopped —
   * throwing away the section envelopes that were the payload's only ones.
   */
  it("joins envelopes from the sections when adCandidates is served empty", () => {
    const creative = creativeFixture();
    const canonical = canonicalFixture();
    const workspace = workspaceFixture({
      canonical: [],
      os: fullOs({ creatives: [creative] }),
    });
    (workspace as any).decisionReadModel.queue.sections = {
      creative_rotation: { items: [canonical] },
    };
    const onCreativeReview = vi.fn();

    const viewModel = buildMetaDecisionCenterExactViewModel({
      workspace,
      callbacks: { onCreativeReview },
    });

    viewModel.creativeDecisions?.[0]?.onPrimary?.();
    expect(onCreativeReview).toHaveBeenCalledWith(creative, canonical);
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

    expect(
      buildMetaDecisionCenterExactViewModel({ workspace }).creativesNotice,
    ).toBe(
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
    const notice = buildMetaDecisionCenterExactViewModel({
      workspace,
    }).creativesNotice;
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

/**
 * The archive lane holds two grains, and both of them are served.
 *
 * `decisionReadModel.queue.inactiveAssets` carries the Ad-grain decisions the
 * read model withheld from every live queue because the current hierarchy is
 * not exactly ACTIVE. The page computed them, filtered them against the search
 * box, and then dropped every one of them on the floor — measured on the live
 * dev server against Grandmix (act_805150454596350): 83 served, 0 rendered;
 * TheSwaf (act_822913786458311): 319 served, 0 rendered. One of Grandmix's had
 * $699.34 of spend on it and appeared on no screen in the product.
 */
function inactiveAdFixture(
  overrides: Partial<MetaCanonicalDecision> = {},
): MetaCanonicalDecision {
  return {
    decisionId: "inactive_1",
    sourceSnapshotId: "snapshot_9",
    identityGrain: "ad",
    parentChain: {
      account: { id: "act_1", name: "Account" },
      campaign: { id: "cmp_9", name: "Retired Campaign" },
      adset: { id: "ads_9", name: "Retired Ad set" },
      ad: { id: "ad_9", name: "Cat-Guarantee" },
      creative: { id: "crt_9", name: "Cat-Guarantee creative" },
    },
    deliveryScope: {
      state: "inactive",
      campaignStatus: "NOT_ACTIVE",
      adsetStatus: "NOT_ACTIVE",
      adStatus: "NOT_ACTIVE",
      reason: "hierarchy_not_active",
    },
    sourceAuthority: {
      status: "native_exact",
      actionEligible: false,
      reviewOnlyReason: "current_hierarchy_is_not_active",
      authorizedAction: null,
    },
    classification: {
      buyerLabel: "Cut this creative",
      decisionState: "act",
      heldAction: "cut",
    },
    sourceDecision: { label: "cut", reason: "ROAS below target" },
    metrics: { spend: 699.34, purchases: 2, roas: 1.1 },
    ...overrides,
  } as unknown as MetaCanonicalDecision;
}

function archivedStructure(
  overrides: Partial<MetaArchivedEntity> = {},
): MetaArchivedEntity {
  return {
    id: "cmp_archived",
    level: "campaign",
    name: "ADTC - Bath",
    status: "PAUSED",
    statusLabel: "Paused 1045d",
    spend: 0,
    roas: 0,
    cpa: null,
    purchases: 0,
    lastKnownWindow: "28d",
    diagnosticNote: "Campaign is configured for mid funnel delivery.",
    ...overrides,
  };
}

describe("archive lane grain", () => {
  it("renders the withheld Ad decisions the lane was dropping, each grain named", () => {
    const workspace = workspaceFixture({
      currency: "USD",
      archive: [
        archivedStructure(),
        archivedStructure({
          id: "ads_archived",
          level: "adset",
          name: "Broad",
          statusLabel: "Campaign paused 1045d",
          diagnosticNote: "Parent campaign is not active.",
        }),
      ],
      inactiveAssets: [
        inactiveAdFixture(),
        inactiveAdFixture({
          decisionId: "inactive_2",
          metrics: { spend: 0 },
        } as Partial<MetaCanonicalDecision>),
        inactiveAdFixture({
          decisionId: "inactive_3",
          metrics: { spend: null },
        } as Partial<MetaCanonicalDecision>),
      ],
    });

    const rows =
      buildMetaDecisionCenterExactViewModel({ workspace }).archiveRows ?? [];

    expect(rows).toHaveLength(5);
    // Every row says what it is. Without this, an ad, an ad set and a campaign
    // are three names and three money figures in one undifferentiated table.
    expect(rows.map((row) => row.status)).toEqual([
      "Campaign · Paused 1045d",
      "Ad set · Campaign paused 1045d",
      "Ad · Not Active",
      "Ad · Not Active",
      "Ad · Not Active",
    ]);
    // Grains stay grouped rather than interleaved on spend: a campaign's spend
    // already contains its ads', so one money ranking across the two would
    // assert a comparison no server made.
    expect(rows.map((row) => row.id)).toEqual([
      "cmp_archived",
      "ads_archived",
      "inactive-ad:inactive_1",
      "inactive-ad:inactive_2",
      "inactive-ad:inactive_3",
    ]);
    expect(rows[2]).toMatchObject({ name: "Cat-Guarantee", spend: "$699.34" });
    // A measured zero is a fact; an unserved spend is a gap. They must not
    // render as the same thing.
    expect(rows[3]?.spend).toBe("$0");
    expect(rows[4]?.spend).toBe("—");
  });

  it("counts the archive chip over both grains it now shows", () => {
    const workspace = workspaceFixture({
      archive: [archivedStructure()],
      inactiveAssets: [
        inactiveAdFixture(),
        inactiveAdFixture({ decisionId: "b" }),
      ],
      counts: { archive: 1211 },
    });

    // The lane total, not the rendered-row count — the same rule the other lane
    // chips follow, so a search term narrows the table without appearing to
    // shrink the account. `lanes.counts.archive` counts campaigns and ad sets
    // only, so on Grandmix the chip said 1211 beside a table of 1294 rows.
    expect(
      buildMetaDecisionCenterExactViewModel({ workspace }).counts?.archive,
    ).toBe(1213);
  });

  it("never lets a withheld Ad decision read as an ordinary recommendation", () => {
    const workspace = workspaceFixture({
      currency: "USD",
      inactiveAssets: [inactiveAdFixture()],
    });

    const row = buildMetaDecisionCenterExactViewModel({ workspace })
      .archiveRows?.[0];

    // LAW (docs/creative-decision-center/INVARIANTS.md): a blocked, held or
    // review-only decision must never render as an ordinary recommendation and
    // must never map to a Launchpad mode. The read model already stripped this
    // row's authority (`actionEligible: false`, `authorizedAction: null`); the
    // fixture still carries a "Cut this creative" buyer label and a `cut`
    // source label, and neither may reach the screen from here.
    const rendered = JSON.stringify(row);
    expect(rendered).not.toContain("Cut this creative");
    expect(rendered).not.toContain("ROAS below target");
    // No action affordance: there is no server action tuple to give a button,
    // so drawing one could only ever produce a permanently dimmed control.
    expect(row).not.toHaveProperty("onResume");
    expect(row?.showResume).toBeUndefined();
    expect(row?.note).toBe(
      "Withheld from the live queue: the current campaign / ad set / ad hierarchy is not active. " +
        "Current status — campaign NOT_ACTIVE, ad set NOT_ACTIVE, ad NOT_ACTIVE.",
    );
  });

  it("says an unknown hierarchy status is unknown instead of rounding it to paused", () => {
    const workspace = workspaceFixture({
      inactiveAssets: [
        inactiveAdFixture({
          deliveryScope: {
            state: "unknown",
            campaignStatus: null,
            adsetStatus: null,
            adStatus: null,
            reason: "hierarchy_status_unknown",
          },
          sourceAuthority: {
            status: "native_exact",
            actionEligible: false,
            reviewOnlyReason: "current_hierarchy_status_is_unknown",
            authorizedAction: null,
          },
        } as Partial<MetaCanonicalDecision>),
      ],
    });

    const row = buildMetaDecisionCenterExactViewModel({ workspace })
      .archiveRows?.[0];

    expect(row?.status).toBe("Ad · Status unknown");
    expect(row?.statusTone).toBe("neutral");
    expect(row?.note).toBe(
      "Withheld from the live queue: current hierarchy status is unknown.",
    );
  });
});

/**
 * The source panel, built from a payload shaped like a real account.
 *
 * MEASURED, not imagined. Read straight off production for Grandmix
 * (biz 5dbc7147-f051-4681-a4d6-20617170074f / act_805150454596350, snapshot
 * 2026-08-19, engine v3-ad-2026-07-18-decision-presentation-hardening-shadow):
 *
 *   os.ads.items.length            60      <- what the desktop renders
 *   os.ads.sourcePreCapCount       80      <- what the source actually held
 *   os.ads.statePreCapCounts       act 2 · blocked 33 · monitor 45
 *   queue.sourcePreCapCount        80
 *   queue.queuedPreCapCount        80
 *   queue.omittedFromQueue         { count: 0, reasons: [] }
 *   source.generation              expectedAdCount 2517
 *   capabilities                   4 available · riskTierProducer and
 *                                  promotionBasisProducer "proposed" ·
 *                                  responseAttribution and providerWriteLinkage
 *                                  "unavailable"
 *
 * Twenty monitor decisions are dropped by the cap and four of the eight named
 * capabilities are not available — and before this panel existed the screen
 * stated none of it, because the only channel for source facts was a notice
 * rendered under `decisions.length === 0`.
 */
describe("the served decision source is stated beside the rows, not instead of them", () => {
  function grandmixShapedWorkspace(): MetaDecisionsWorkspacePayload {
    const creatives = [creativeFixture()];
    const workspace = workspaceFixture({ os: fullOs({ creatives }) });
    workspace.os.ads.sourcePreCapCount = 80;
    workspace.os.ads.eligiblePreCapCount = 80;
    workspace.os.ads.statePreCapCounts = { act: 2, blocked: 33, monitor: 45 };
    const readModel = workspace.decisionReadModel as unknown as Record<
      string,
      unknown
    >;
    readModel.source = {
      status: "available",
      authority: "native_ad",
      table: "engine_v3_ad_decision_snapshots_daily",
      snapshotAsOf: "2026-08-19",
      computedAt: "2026-08-19 03:53:25.268+00",
      engineVersion: "v3-ad-2026-07-18-decision-presentation-hardening-shadow",
      fallbackReason: null,
      generation: {
        jobRunId: "6180e299-53c2-4897-ae11-fb1fd5b40d00",
        providerAccountRefId: "2a5b71d1-d42e-4c89-a58f-d1b252c4c8b2",
        manifestHash:
          "f8d1e32bcdcb7b9d5658e47cc7ed8c7b6ce038de7df00cb7c816c33709c1ddfb",
        expectedAdCount: 2517,
      },
    };
    readModel.capabilities = {
      providerAccountScope: {
        status: "available",
        reason: "provider_account_id_required_and_source_join_scoped",
      },
      stableDecisionIdentity: { status: "available", reason: null },
      stableEpisodeIdentity: { status: "available", reason: null },
      classificationOverlay: { status: "available", reason: null },
      riskTierProducer: {
        status: "proposed",
        reason: "risk_tier_producer_not_persisted",
      },
      promotionBasisProducer: {
        status: "proposed",
        reason: "promotion_basis_not_persisted",
      },
      responseAttribution: {
        status: "unavailable",
        reason: "native_response_source_unavailable",
      },
      providerWriteLinkage: {
        status: "unavailable",
        reason: "native_action_receipt_not_observed",
      },
    };
    // The read model's OWN status and its `unavailable` slot, which are NOT
    // `source.status` — Grandmix serves "available" on both, and the panel has
    // to say which is which even when they agree.
    readModel.status = "available";
    readModel.unavailable = null;
    const queue = readModel.queue as Record<string, unknown>;
    queue.sourcePreCapCount = 80;
    queue.queuedPreCapCount = 80;
    queue.omittedFromQueue = { count: 0, reasons: [] };
    (queue.adCandidates as Record<string, unknown>).eligiblePreCapCount = 80;
    return workspace;
  }

  function factValue(
    model: ReturnType<typeof buildMetaDecisionCenterExactViewModel>,
    group: "source" | "coverage" | "suppression" | "limitations",
    id: string,
  ) {
    return model.sourceProvenance?.[group]?.find((entry) => entry.id === id)
      ?.value;
  }

  it("names the authority, the coverage and every capability gap while rows render", () => {
    const workspace = grandmixShapedWorkspace();

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    // The rows are still there. The panel is additive, never a replacement.
    expect(viewModel.creativeDecisions).toHaveLength(1);
    const provenance = viewModel.sourceProvenance;
    expect(provenance?.headline).toBe("native_ad · healthy");
    // Paired against the eligible pre-cap, which is the population the rendered
    // list is a capped view OF. Grandmix serves 60 items against 80 eligible.
    //
    // "(derived)" is not decoration. The number in this pair is
    // `os.ads.eligiblePreCapCount`, which the presentation computes as a MAXIMUM
    // over the read model's served count and the rows it actually built
    // (lib/meta/decisions-os-presentation.ts:1679-1682) — so the summary names
    // which of the two "eligible" numbers it is showing.
    expect(provenance?.coverageSummary).toBe(
      "1 shown · 80 eligible pre-cap (derived)",
    );
    expect(factValue(viewModel, "source", "authority")).toBe("native_ad");
    expect(factValue(viewModel, "source", "table")).toBe(
      "engine_v3_ad_decision_snapshots_daily",
    );
    expect(factValue(viewModel, "source", "generation-expected-ads")).toBe(
      "2,517",
    );
    expect(factValue(viewModel, "coverage", "ads-eligible-pre-cap")).toBe("80");
    expect(factValue(viewModel, "coverage", "queue-eligible-pre-cap")).toBe(
      "80",
    );
    expect(factValue(viewModel, "coverage", "queue-source-pre-cap")).toBe("80");
    // Two statuses, two labels: the read model's own and its source's.
    expect(factValue(viewModel, "source", "read-model-status")).toBe(
      "available",
    );
    expect(factValue(viewModel, "source", "status")).toBe("available");
    expect(factValue(viewModel, "coverage", "queue-queued-pre-cap")).toBe("80");

    // The eight named states, with only the four that are NOT available listed,
    // each carrying the SERVER's reason rather than a sentence written here.
    expect(provenance?.capabilitySummary).toBe("4 of 8 not available");
    expect(
      provenance?.capabilityGaps?.map((gap) => [
        gap.id,
        gap.status,
        gap.reason,
      ]),
    ).toEqual([
      ["riskTierProducer", "Proposed", "risk_tier_producer_not_persisted"],
      ["promotionBasisProducer", "Proposed", "promotion_basis_not_persisted"],
      [
        "responseAttribution",
        "Unavailable",
        "native_response_source_unavailable",
      ],
      [
        "providerWriteLinkage",
        "Unavailable",
        "native_action_receipt_not_observed",
      ],
    ]);

    // LAW: presentation only. The panel may carry no callback of any kind, or it
    // becomes a second, unaudited route to a provider write.
    const everyEntry = [
      ...(provenance?.source ?? []),
      ...(provenance?.coverage ?? []),
      ...(provenance?.suppression ?? []),
      ...(provenance?.limitations ?? []),
    ];
    expect(
      everyEntry.some((entry) =>
        Object.values(entry).some((value) => typeof value === "function"),
      ),
    ).toBe(false);
  });

  it("does not paint a current decision source healthy when live sync admission is blocked", () => {
    const workspace = grandmixShapedWorkspace();
    workspace.system.pipelineHealth = {
      ...healthyPipelineHealth(),
      overall: "blocked",
      executionReady: false,
      blockers: ["sync_admission_blocked"],
      syncActivity: {
        ...healthyPipelineHealth().syncActivity,
        status: "blocked",
        reason: "New sync work is refused by the growth fence.",
      },
      admission: {
        ...healthyPipelineHealth().admission,
        status: "blocked",
        allowed: false,
        reason: "table_budget_exceeded",
        offender: {
          table: "meta_entity_state_history",
          bytes: 5_368_750_080,
          budget: 5_368_709_120,
          overByBytes: 40_960,
        },
      },
    };

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(viewModel.sourceProvenance?.tone).toBe("negative");
    expect(viewModel.structureProvenance?.tone).toBe("negative");
    expect(factValue(viewModel, "source", "pipeline-health")).toBe("blocked");
    expect(factValue(viewModel, "source", "pipeline-execution-ready")).toBe(
      "no",
    );
    expect(factValue(viewModel, "source", "pipeline-admission-table")).toBe(
      "meta_entity_state_history",
    );
    expect(factValue(viewModel, "source", "pipeline-admission-over")).toBe(
      "40,960 bytes",
    );
  });

  /**
   * LAW: a measured zero is a fact and stays 0; an unserved field is an em dash.
   *
   * Grandmix withholds nothing from the queue today, and rendering that as an
   * em dash would say "we could not tell" about something the server measured.
   */
  it("keeps a served zero apart from an unserved envelope", () => {
    const workspace = grandmixShapedWorkspace();

    const served = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(factValue(served, "suppression", "suppressed-count")).toBe("0");
    expect(factValue(served, "limitations", "limitation-count")).toBe("0");
    expect(factValue(served, "source", "fallback-reason")).toBe("—");

    const readModel = workspace.decisionReadModel as unknown as Record<
      string,
      unknown
    >;
    delete (readModel.queue as Record<string, unknown>).omittedFromQueue;
    delete readModel.capabilities;

    const unserved = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(factValue(unserved, "suppression", "suppressed-count")).toBe("—");
    expect(unserved.sourceProvenance?.capabilitySummary).toBe("capabilities —");
    expect(unserved.sourceProvenance?.capabilityGaps).toEqual([]);
  });

  /**
   * LAW: a label names the field it prints, and no other one.
   *
   * `MetaDecisionsWorkspaceReadModel.status` (decisions-workspace-contract.ts:401)
   * and `MetaDecisionsWorkspaceReadModel.source.status` (:413) are two fields.
   * The panel used to print the second under the first one's name and never
   * print the first at all. They are independently meaningful — a read model
   * can SUCCEED while the snapshot source behind it could not be read — so a
   * reader who sees one value must be able to tell which field it came from.
   *
   * This pins the divergent case in both directions, because a panel that only
   * ever sees them agree cannot prove it is reading two fields.
   */
  it("prints the read model's status and its source's status under their own names", () => {
    const workspace = grandmixShapedWorkspace();
    const readModel = workspace.decisionReadModel as unknown as Record<
      string,
      unknown
    >;
    // The read model succeeded; the snapshot source behind it did not.
    readModel.status = "available";
    readModel.unavailable = null;
    (readModel.source as Record<string, unknown>).status = "unavailable";

    const degradedSource = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(factValue(degradedSource, "source", "read-model-status")).toBe(
      "available",
    );
    expect(factValue(degradedSource, "source", "status")).toBe("unavailable");
    // `unavailable: null` is a served statement that there is none. Printing it
    // as an em dash would say "we could not tell", which is the opposite fact.
    expect(
      degradedSource.sourceProvenance?.source?.map((entry) => entry.id),
    ).not.toContain("unavailable-code");

    // And the other way round: the read model itself refused, with its reason.
    readModel.status = "unavailable";
    readModel.unavailable = {
      code: "provider_account_required",
      message: "No provider account is connected for this business.",
    };
    (readModel.source as Record<string, unknown>).status = "available";

    const refusedModel = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(factValue(refusedModel, "source", "read-model-status")).toBe(
      "unavailable",
    );
    expect(factValue(refusedModel, "source", "status")).toBe("available");
    expect(factValue(refusedModel, "source", "unavailable-code")).toBe(
      "provider_account_required",
    );
    expect(factValue(refusedModel, "source", "unavailable-message")).toBe(
      "No provider account is connected for this business.",
    );

    // A payload that served no status at all is an em dash, never "available".
    delete readModel.status;
    delete readModel.unavailable;
    const silent = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(factValue(silent, "source", "read-model-status")).toBe("—");
    expect(factValue(silent, "source", "status")).toBe("available");
  });

  /**
   * LAW: a derived maximum may not be printed under the served field's name.
   *
   * `os.ads.eligiblePreCapCount` is NOT `queue.adCandidates.eligiblePreCapCount`
   * forwarded. The presentation computes
   * `Math.max(served ?? canonicalAds.length, canonicalAds.length + pendingInventoryPreCapCount)`
   * (lib/meta/decisions-os-presentation.ts:1679-1682), so it can strictly
   * exceed the served count — which reached no surface at all while the derived
   * one wore the bare label "Eligible (pre-cap)".
   *
   * The contrast is with `sourcePreCapCount`, which genuinely IS forwarded
   * (presentation:1686) and is therefore still read once and printed once.
   */
  it("tells the served eligible pre-cap apart from the presentation's derived maximum", () => {
    const workspace = grandmixShapedWorkspace();
    const readModel = workspace.decisionReadModel as unknown as Record<
      string,
      unknown
    >;
    const queue = readModel.queue as Record<string, unknown>;
    // The divergence the max() produces: the read model counted 71 eligible,
    // the presentation built more rows than that and raised the ceiling to 80.
    (queue.adCandidates as Record<string, unknown>).eligiblePreCapCount = 71;
    workspace.os.ads.eligiblePreCapCount = 80;

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(factValue(viewModel, "coverage", "queue-eligible-pre-cap")).toBe(
      "71",
    );
    expect(factValue(viewModel, "coverage", "ads-eligible-pre-cap")).toBe("80");
    const labels = new Map(
      (viewModel.sourceProvenance?.coverage ?? []).map((entry) => [
        entry.id,
        entry.label,
      ]),
    );
    expect(labels.get("queue-eligible-pre-cap")).toBe(
      "Eligible (pre-cap) · read model",
    );
    expect(labels.get("ads-eligible-pre-cap")).toBe(
      "Eligible (pre-cap) · derived maximum",
    );
    // No label may be the bare "Eligible (pre-cap)" any more: that name belongs
    // to the served field and was worn by the derived one.
    expect([...labels.values()]).not.toContain("Eligible (pre-cap)");
    // The summary pairs against the derived maximum — the only one of the two
    // that is never smaller than the list beside it — and says so.
    expect(viewModel.sourceProvenance?.coverageSummary).toBe(
      "1 shown · 80 eligible pre-cap (derived)",
    );

    // A served count the payload omitted is an em dash, not the derived number
    // borrowed to fill the hole.
    delete (queue.adCandidates as Record<string, unknown>).eligiblePreCapCount;
    const unserved = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(factValue(unserved, "coverage", "queue-eligible-pre-cap")).toBe("—");
    expect(factValue(unserved, "coverage", "ads-eligible-pre-cap")).toBe("80");
  });

  /**
   * The case the old empty-gate hid: a degraded source WITH rows.
   *
   * `authority: "legacy_creative"` plus `health: "degraded"` plus a fallback
   * reason used to reach the operator only when the creative queue was empty.
   */
  it("reports a degraded legacy source even though the queue is full", () => {
    const workspace = grandmixShapedWorkspace();
    const readModel = workspace.decisionReadModel as unknown as Record<
      string,
      unknown
    >;
    (readModel.source as Record<string, unknown>).authority = "legacy_creative";
    (readModel.source as Record<string, unknown>).fallbackReason =
      "native_account_manifest_incomplete";
    workspace.os.source.adsSource = "legacy_creative_review_only";
    workspace.os.source.health = "degraded";
    workspace.os.source.fallbackReason = "native_account_manifest_incomplete";
    workspace.os.limitations = [
      {
        code: "legacy_creative_review_only",
        message:
          "Legacy creative-grain decisions remain visible for continuity but cannot authorize Ad writes.",
      },
    ];

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(viewModel.creativeDecisions?.length).toBeGreaterThan(0);
    expect(viewModel.sourceProvenance?.headline).toBe(
      "legacy_creative · degraded",
    );
    expect(viewModel.sourceProvenance?.tone).toBe("warning");
    expect(factValue(viewModel, "source", "fallback-reason")).toBe(
      "native_account_manifest_incomplete",
    );
    expect(factValue(viewModel, "limitations", "limitation-count")).toBe("1");
    expect(
      factValue(
        viewModel,
        "limitations",
        "limitation-legacy_creative_review_only",
      ),
    ).toBe(
      "Legacy creative-grain decisions remain visible for continuity but cannot authorize Ad writes.",
    );
    // The joined notice still exists and is now rendered by the panel rather
    // than by a branch that requires an empty queue.
    expect(viewModel.creativesNotice).toContain(
      "native_account_manifest_incomplete",
    );
  });

  it("lists the suppression envelope reason by reason", () => {
    const workspace = grandmixShapedWorkspace();
    const queue = (
      workspace.decisionReadModel as unknown as Record<string, unknown>
    ).queue as Record<string, unknown>;
    queue.omittedFromQueue = {
      count: 7,
      reasons: [
        { code: "ambiguous_identity", count: 4 },
        { code: "not_applicable", count: 3 },
      ],
    };

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(
      viewModel.sourceProvenance?.suppression?.map((entry) => [
        entry.label,
        entry.value,
      ]),
    ).toEqual([
      ["Withheld", "7"],
      ["ambiguous_identity", "4"],
      ["not_applicable", "3"],
      // The section cap is a SECOND withholding over a different population and
      // keeps its own row. This fixture serves `sections: {}` — no receipt at
      // all — so it reads as unknown rather than as a measured nothing.
      ["Section cap · envelopes held back", "—"],
    ]);
  });

  /**
   * LAW: the section top-N cap is stated, because it decides which rows can
   * open their evidence.
   *
   * The Creatives lane draws `os.ads.items`, so the cap hides no ROW here. What
   * it withholds is a canonical ENVELOPE: the adapter's own lookup table is
   * `adCandidates.items` unioned with the sections' items, so a decision the cap
   * dropped and the candidate selection did not recover leaves its row with no
   * envelope — and every canonical-only field in that row's evidence window
   * reads "unavailable" instead of answering. Before this, the served receipt
   * that counts exactly those decisions was rendered nowhere, so the screen
   * could not explain its own dashes.
   *
   * It is counted SEPARATELY from `omittedFromQueue`, which is the earlier cut
   * over a different population; summing them would claim one withholding where
   * the server recorded two.
   */
  it("states the section cap's held-back envelopes apart from the queue omissions", () => {
    const workspace = grandmixShapedWorkspace();
    const queue = (
      workspace.decisionReadModel as unknown as Record<string, unknown>
    ).queue as Record<string, unknown>;
    queue.omittedFromQueue = {
      count: 2,
      reasons: [{ code: "not_applicable", count: 2 }],
    };
    queue.sections = {
      creative_rotation: {
        items: [],
        suppressionReceipt: {
          topN: 5,
          preCapCount: 12,
          selectedCount: 5,
          suppressedCount: 7,
          reasons: [
            { code: "section_top_n_ranked", count: 5 },
            { code: "section_top_n_unrankable", count: 2 },
          ],
        },
      },
      scale: {
        items: [],
        suppressionReceipt: {
          topN: 5,
          preCapCount: 6,
          selectedCount: 5,
          suppressedCount: 1,
          reasons: [{ code: "section_top_n_ranked", count: 1 }],
        },
      },
    };

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(
      viewModel.sourceProvenance?.suppression?.map((entry) => [
        entry.label,
        entry.value,
      ]),
    ).toEqual([
      ["Withheld", "2"],
      ["not_applicable", "2"],
      // 7 + 1 across the two served receipts, and the two reason codes summed
      // per code across sections. Never added to the 2 above it.
      ["Section cap · envelopes held back", "8"],
      ["Section cap · section_top_n_ranked", "6"],
      ["Section cap · section_top_n_unrankable", "2"],
    ]);
  });

  /**
   * LAW: a measured zero is a fact; an unserved receipt is not.
   *
   * Sections that capped nothing print 0 — "nothing was held back" is something
   * the server measured. A payload with no `sections` object at all prints an em
   * dash, because "we could not tell" is the other fact and must not be dressed
   * as a clean run.
   */
  it("separates a section cap that held nothing back from a receipt that was never served", () => {
    const workspace = grandmixShapedWorkspace();
    const queue = (
      workspace.decisionReadModel as unknown as Record<string, unknown>
    ).queue as Record<string, unknown>;
    queue.sections = {
      creative_rotation: {
        items: [],
        suppressionReceipt: {
          topN: 5,
          preCapCount: 3,
          selectedCount: 3,
          suppressedCount: 0,
          reasons: [],
        },
      },
    };

    const measuredZero = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(
      factValue(measuredZero, "suppression", "section-cap-held-back"),
    ).toBe("0");

    delete queue.sections;
    const unserved = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(factValue(unserved, "suppression", "section-cap-held-back")).toBe(
      "—",
    );
  });

  /**
   * The section cap says nothing about the CAMPAIGN and AD SET lanes.
   *
   * Sections are counted at `queue.deduplicationGrain`, which is "ad" or
   * "creative" and never a campaign or an ad set. The structure scope already
   * withholds every other ad-grain fact for that reason; this pins that the new
   * row did not quietly become the exception.
   */
  it("keeps the section cap out of the structure scope", () => {
    const workspace = structureShapedWorkspace();
    const queue = (
      workspace.decisionReadModel as unknown as Record<string, unknown>
    ).queue as Record<string, unknown>;
    queue.sections = {
      creative_rotation: {
        items: [],
        suppressionReceipt: {
          topN: 5,
          preCapCount: 12,
          selectedCount: 5,
          suppressedCount: 7,
          reasons: [{ code: "section_top_n_ranked", count: 7 }],
        },
      },
    };

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(viewModel.structureProvenance?.suppression ?? []).toEqual([]);
    expect(JSON.stringify(viewModel.structureProvenance)).not.toContain(
      "Section cap",
    );
  });

  /*
   * THE STRUCTURES SCOPE, which stated no source authority at all.
   *
   * It is backed by the same read model and the same capabilities envelope as
   * Creatives — and it is the scope that draws the action buttons
   * `providerWriteLinkage` and `responseAttribution` govern. On Grandmix both
   * are `unavailable`, and the campaign and ad-set lanes said nothing about
   * either. These pin that it now says so in that scope's OWN terms, and that
   * it does not borrow an ads number to do it.
   */
  function structureShapedWorkspace(): MetaDecisionsWorkspacePayload {
    const workspace = grandmixShapedWorkspace();
    workspace.os.structure = {
      groups: [],
      actCount: 3,
      blockedCount: 19,
      monitorCount: 0,
      suppressedAlternativeCount: 4,
    };
    workspace.lanes.structureInventory = Array.from(
      { length: 1230 },
      (_, index) => ({
        id: `entity_${index}`,
        level: index < 476 ? "campaign" : "adset",
        name: `Entity ${index}`,
        status: "PAUSED",
        statusLabel: "PAUSED",
        campaignName: null,
        metrics: { spend: 0, roas: null, purchases: 0 },
      }),
    ) as unknown as MetaDecisionsWorkspacePayload["lanes"]["structureInventory"];
    return workspace;
  }

  function structureFact(
    model: ReturnType<typeof buildMetaDecisionCenterExactViewModel>,
    group: "source" | "coverage" | "suppression" | "limitations",
    id: string,
  ) {
    return model.structureProvenance?.[group]?.find((entry) => entry.id === id)
      ?.value;
  }

  function structureFactIds(
    model: ReturnType<typeof buildMetaDecisionCenterExactViewModel>,
  ): string[] {
    const provenance = model.structureProvenance;
    return [
      ...(provenance?.source ?? []),
      ...(provenance?.coverage ?? []),
      ...(provenance?.suppression ?? []),
      ...(provenance?.limitations ?? []),
    ].map((entry) => entry.id);
  }

  it("states the served envelope in the Structures scope, in that scope's own terms", () => {
    const workspace = structureShapedWorkspace();

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    const provenance = viewModel.structureProvenance;
    // The structure source token, not the ad authority, and the read model's
    // own status rather than a health flag derived from the ad grain.
    expect(provenance?.headline).toBe("meta_recommendations · available");
    expect(structureFact(viewModel, "source", "structure-source")).toBe(
      "meta_recommendations",
    );
    // Two statuses, two labels. "Read model status" is the read model's own
    // field; "Source status" is its snapshot source's, and it is the one the
    // headline above is standing for.
    expect(structureFact(viewModel, "source", "read-model-status")).toBe(
      "available",
    );
    expect(structureFact(viewModel, "source", "status")).toBe("available");
    expect(structureFact(viewModel, "source", "scope-provider-account")).toBe(
      "act_1",
    );
    expect(structureFact(viewModel, "source", "snapshot-as-of")).toBe(
      "2026-08-19",
    );

    // This scope's own census, paired the way Creatives pairs shown vs eligible.
    expect(provenance?.coverageSummary).toBe(
      "22 carry a decision · 1,230 in census",
    );
    expect(structureFact(viewModel, "coverage", "structure-census")).toBe(
      "1,230",
    );
    expect(structureFact(viewModel, "coverage", "structure-decisions")).toBe(
      "22",
    );
    expect(structureFact(viewModel, "coverage", "structure-act")).toBe("3");
    expect(structureFact(viewModel, "coverage", "structure-blocked")).toBe(
      "19",
    );
    expect(structureFact(viewModel, "coverage", "structure-monitor")).toBe("0");
    expect(
      structureFact(viewModel, "coverage", "structure-suppressed-alternatives"),
    ).toBe("4");

    // LAW: the capability envelope is a property of the read model, not of a
    // grain. Both scopes state the SAME eight with the SAME server reasons.
    expect(provenance?.capabilitySummary).toBe(
      viewModel.sourceProvenance?.capabilitySummary,
    );
    expect(provenance?.capabilityGaps).toEqual(
      viewModel.sourceProvenance?.capabilityGaps,
    );
    expect(
      provenance?.capabilityGaps?.map((gap) => [
        gap.id,
        gap.status,
        gap.reason,
      ]),
    ).toEqual([
      ["riskTierProducer", "Proposed", "risk_tier_producer_not_persisted"],
      ["promotionBasisProducer", "Proposed", "promotion_basis_not_persisted"],
      [
        "responseAttribution",
        "Unavailable",
        "native_response_source_unavailable",
      ],
      [
        "providerWriteLinkage",
        "Unavailable",
        "native_action_receipt_not_observed",
      ],
    ]);
    // A write-bearing gap carries the headline, which the source status alone
    // would have painted green directly above "provider write linkage
    // unavailable".
    expect(provenance?.tone).toBe("warning");

    // LAW: no ads number may appear under a structure heading. Every one of
    // these describes the ad grain and is withheld rather than reprinted.
    const ids = structureFactIds(viewModel);
    for (const adOnly of [
      "authority",
      "health",
      "ads-source",
      "table",
      "fallback-reason",
      "generation-job-run",
      "generation-account-ref",
      "generation-manifest",
      "generation-expected-ads",
      "shown",
      "ads-eligible-pre-cap",
      "queue-eligible-pre-cap",
      "queue-source-pre-cap",
      "queue-queued-pre-cap",
      "omitted-unverified-ad-id",
      "omitted-ambiguous-identity",
      "omitted-not-applicable",
      "suppressed-count",
    ]) {
      expect(ids).not.toContain(adOnly);
    }
    // `queue.omittedFromQueue` is counted at `deduplicationGrain`, which is
    // "ad" or "creative" — never a campaign or an ad set.
    expect(provenance?.suppression ?? []).toEqual([]);

    // LAW: presentation only. A second panel is a second chance to become an
    // unaudited write path, so it carries no callback either.
    const everyEntry = [
      ...(provenance?.source ?? []),
      ...(provenance?.coverage ?? []),
      ...(provenance?.limitations ?? []),
      ...(provenance?.capabilityGaps ?? []),
    ];
    expect(
      everyEntry.some((entry) =>
        Object.values(entry).some((value) => typeof value === "function"),
      ),
    ).toBe(false);
  });

  /**
   * LAW: withhold an ads limitation from Structures — but never silently.
   *
   * All three codes the OS presentation emits today constrain the ad grain
   * only. Printing them beside a campaign row would attach a refusal to rows
   * they do not govern; dropping them without a word would make a withheld
   * limitation indistinguishable from an absent one. So the count is stated
   * and the scope that carries the text is named.
   */
  it("withholds the ad-grain limitations from Structures and says where they are", () => {
    const workspace = structureShapedWorkspace();
    workspace.os.limitations = [
      {
        code: "legacy_creative_review_only",
        message:
          "Legacy creative-grain decisions remain visible for continuity but cannot authorize Ad writes.",
      },
      {
        code: "ad_metrics_are_creative_context",
        message: "Legacy rows use creative-grain metrics and are review-only.",
      },
      {
        code: "account_currency_unavailable",
        message: "The account currency was not served for this window.",
      },
    ];

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    // Only the code that is NOT ad-grain survives into the structure panel,
    // and an unknown code is SHOWN by default: withholding a served limitation
    // from the operator is the worse failure of the two.
    expect(
      viewModel.structureProvenance?.limitations?.map((entry) => [
        entry.id,
        entry.value,
      ]),
    ).toEqual([
      ["limitation-count", "1"],
      [
        "limitation-account_currency_unavailable",
        "The account currency was not served for this window.",
      ],
      ["limitation-ad-grain-elsewhere", "2 stated in the Creatives scope"],
    ]);

    // The Creatives scope still states all three, unchanged.
    expect(
      viewModel.sourceProvenance?.limitations?.map((entry) => entry.id),
    ).toEqual([
      "limitation-count",
      "limitation-legacy_creative_review_only",
      "limitation-ad_metrics_are_creative_context",
      "limitation-account_currency_unavailable",
    ]);
    // The ad-grain sentences reach the operator through the Creatives panel and
    // through `creativesNotice`, neither of which the structure panel carries.
    // @see SourceProvenancePanel — only Creatives is handed the notice.
    expect(JSON.stringify(viewModel.structureProvenance)).not.toContain(
      "cannot authorize Ad writes",
    );
  });

  /**
   * LAW: an unserved count is an em dash, a measured zero stays 0, and a sum is
   * never asserted from a partially served envelope.
   */
  it("keeps an unserved structure census apart from a measured zero", () => {
    const workspace = structureShapedWorkspace();
    workspace.os.structure.actCount = 0;
    workspace.os.structure.blockedCount = 0;
    workspace.os.structure.monitorCount = 0;

    const zeroed = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(structureFact(zeroed, "coverage", "structure-decisions")).toBe("0");
    expect(zeroed.structureProvenance?.coverageSummary).toBe(
      "0 carry a decision · 1,230 in census",
    );

    delete (workspace.os.structure as unknown as Record<string, unknown>)
      .monitorCount;
    delete (workspace.lanes as unknown as Record<string, unknown>)
      .structureInventory;

    const unserved = buildMetaDecisionCenterExactViewModel({ workspace });
    expect(structureFact(unserved, "coverage", "structure-census")).toBe("—");
    expect(structureFact(unserved, "coverage", "structure-monitor")).toBe("—");
    // Not 3 + 19 + nothing. A partial sum and "we could not tell" are
    // different claims and only one of them is true here.
    expect(structureFact(unserved, "coverage", "structure-decisions")).toBe(
      "—",
    );
    expect(unserved.structureProvenance?.coverageSummary).toBe(
      "— carry a decision · — in census",
    );
  });

  it("says an unavailable read model instead of colouring the scope healthy", () => {
    const workspace = structureShapedWorkspace();
    const readModel = workspace.decisionReadModel as unknown as Record<
      string,
      unknown
    >;
    readModel.status = "unavailable";
    (readModel.source as Record<string, unknown>).status = "unavailable";
    readModel.unavailable = {
      code: "provider_account_scope_unverified",
      message:
        "The provider account scope could not be verified for this business.",
    };

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    // The headline still stands for the SOURCE status, unchanged: what colours
    // this panel is a claim about whether the source could be read.
    expect(viewModel.structureProvenance?.headline).toBe(
      "meta_recommendations · unavailable",
    );
    expect(viewModel.structureProvenance?.tone).toBe("negative");
    expect(structureFact(viewModel, "source", "read-model-status")).toBe(
      "unavailable",
    );
    expect(structureFact(viewModel, "source", "status")).toBe("unavailable");
    expect(structureFact(viewModel, "source", "unavailable-code")).toBe(
      "provider_account_scope_unverified",
    );
    expect(structureFact(viewModel, "source", "unavailable-message")).toBe(
      "The provider account scope could not be verified for this business.",
    );
  });

  /**
   * LAW: the `unavailable` code and message explain
   * `MetaDecisionsWorkspaceReadModel.status`, not `source.status`. They used to
   * be printed directly under a row labelled "Read model status" that carried
   * the SOURCE's value — one field's reason attached to another field's number.
   *
   * This pins that the reason now travels with the status it belongs to, and
   * that a source failure does not conjure a read-model refusal.
   */
  it("keeps the unavailability reason attached to the status it explains", () => {
    const workspace = structureShapedWorkspace();
    const readModel = workspace.decisionReadModel as unknown as Record<
      string,
      unknown
    >;
    // The source could not be read; the read model itself did not refuse.
    readModel.status = "available";
    readModel.unavailable = null;
    (readModel.source as Record<string, unknown>).status = "unavailable";

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(structureFact(viewModel, "source", "read-model-status")).toBe(
      "available",
    );
    expect(structureFact(viewModel, "source", "status")).toBe("unavailable");
    expect(structureFactIds(viewModel)).not.toContain("unavailable-code");
    expect(structureFactIds(viewModel)).not.toContain("unavailable-message");
    // The source status is still what colours the panel, so the operator is not
    // shown a green scope over a source that could not be read.
    expect(viewModel.structureProvenance?.tone).toBe("negative");
  });

  /**
   * `unavailable: null` is a served statement that there is no unavailability,
   * already carried by the status. Printing it as an em dash would say "we
   * could not tell", which is the opposite fact — so the row is absent, not
   * blank.
   */
  it("goes positive only when the write-bearing capabilities are available", () => {
    const workspace = structureShapedWorkspace();
    const capabilities = (
      workspace.decisionReadModel as unknown as Record<string, unknown>
    ).capabilities as Record<string, unknown>;
    capabilities.responseAttribution = { status: "available", reason: null };
    capabilities.providerWriteLinkage = { status: "available", reason: null };

    const viewModel = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(viewModel.structureProvenance?.tone).toBe("positive");
    expect(structureFactIds(viewModel)).not.toContain("unavailable-code");
    // Two capabilities are still merely "proposed", and they are still listed.
    expect(viewModel.structureProvenance?.capabilitySummary).toBe(
      "2 of 8 not available",
    );
  });
});

/**
 * The served census, and the law that it is a census and nothing else.
 *
 * MEASURED on Grandmix (5dbc7147-f051-4681-a4d6-20617170074f /
 * act_805150454596350, window 28d, snapshot 2026-08-18): the workspace serves
 * `lanes.structureInventory` with 1,230 entities (476 campaigns, 754 ad sets)
 * while the lanes that render them hold Action Now 3, Watching 19, Healthy 0,
 * Non-sales 0 and Archive 1,211 structure rows. 1,211 of 1,230 — 98.5% — were
 * reachable only by opening a lane named Archive, and the scope pill above
 * those lanes printed `lanes.counts.actionNow`, so a scope holding 1,230
 * entities announced 3.
 *
 * THE LAW: inventory visibility is not recommendation or execution
 * eligibility (INVARIANTS.md). Listing an entity may not give it an action, a
 * lane or a decision, and may not move it out of the lane the server filed it
 * in. These tests pin both halves — that the census is reachable at all, and
 * that reaching it grants nothing.
 */
function inventoryEntity(
  input: Partial<MetaStructureInventoryEntity> & {
    id: string;
    level: "campaign" | "adset";
  },
): MetaStructureInventoryEntity {
  return {
    name: `entity ${input.id}`,
    campaignId: input.level === "campaign" ? input.id : "camp_1",
    campaignName: input.level === "campaign" ? `entity ${input.id}` : "Parent",
    campaignKind: "main",
    status: "PAUSED",
    statusLabel: "Paused 1045d",
    metrics: {
      spend: 0,
      purchases: 0,
      roas: 0,
      cpa: null,
      ctr: null,
      frequency: null,
    },
    entityConfiguration: {
      source:
        input.level === "campaign"
          ? "account_scoped_campaign_row"
          : "account_scoped_adset_row",
      budgetOwner: "campaign",
      budgetMode: "campaign_budget",
      controlOwner: "campaign",
      status: "PAUSED",
      optimizationGoal: "Offsite Conversions",
      bidStrategyType: "lowest_cost",
      bidStrategyLabel: "Lowest Cost",
      dailyBudget: 1_000_000,
      lifetimeBudget: null,
      budgetUtilization: null,
    },
    ...input,
  };
}

describe("served structure inventory", () => {
  it("carries every served entity in the served order, at both grains", () => {
    const workspace = workspaceFixture({
      currency: "USD",
      structureInventory: [
        inventoryEntity({ id: "camp_1", level: "campaign" }),
        inventoryEntity({ id: "camp_2", level: "campaign" }),
        inventoryEntity({ id: "adset_1", level: "adset" }),
      ],
    });

    const view = buildMetaStructureInventoryViewModel({
      workspace,
      fallbackCurrency: "USD",
    });

    expect(view.servedCount).toBe(3);
    expect(view.campaignCount).toBe(2);
    expect(view.adsetCount).toBe(1);
    expect(view.shownCount).toBe(3);
    // The server's order, not a re-rank. Campaigns then ad sets is what
    // lane-classify serves; a spend sort here would rank a campaign against
    // the ad sets whose spend it already contains.
    expect(view.rows.map((row) => row.id)).toEqual([
      "campaign:camp_1",
      "campaign:camp_2",
      "adset:adset_1",
    ]);
    expect(view.rows.map((row) => row.grain)).toEqual([
      "Campaign",
      "Campaign",
      "Ad set",
    ]);
    expect(view.unavailableReason).toBeNull();
  });

  it("gives an inventory row no action, no lane and no decision", () => {
    const workspace = workspaceFixture({
      currency: "USD",
      actionNow: [metaRec({ id: "camp_1", level: "campaign" })],
      structureInventory: [
        inventoryEntity({ id: "camp_1", level: "campaign" }),
      ],
    });

    const [row] = buildMetaStructureInventoryViewModel({
      workspace,
      fallbackCurrency: "USD",
    }).rows;

    // Every key the row has, listed. An action tuple, a lane, a decision
    // label, a priority or a callback appearing here is the invariant
    // breaking, so the assertion is the whole shape rather than a spot check.
    //
    // `cpa` and `ctr` joined the list when the served-field coverage matrix
    // classified them as fields that should be rendered. They are MEASURES,
    // not authority: adding a metric column to a census row still gives that
    // row no action, no lane and no decision, which is why the shape pin below
    // is restated rather than relaxed. `frequency`, the third served metric,
    // is deliberately absent — it is derived from reach summed across days.
    // @see decision-payload-coverage.test.ts
    expect(Object.keys(row!).sort()).toEqual([
      "configuration",
      "cpa",
      "ctr",
      "grain",
      "id",
      "lineage",
      "name",
      "purchases",
      "roas",
      "spend",
      "status",
    ]);
    expect(JSON.stringify(row)).not.toMatch(
      /action|lane|decision|launchpad|priority|urgency/i,
    );
  });

  it("keeps a measured zero and refuses ROAS the account never earned", () => {
    const workspace = workspaceFixture({
      currency: "USD",
      structureInventory: [
        inventoryEntity({ id: "camp_1", level: "campaign" }),
        inventoryEntity({
          id: "camp_2",
          level: "campaign",
          metrics: {
            spend: null,
            purchases: null,
            roas: null,
            cpa: null,
            ctr: null,
            frequency: null,
          },
        }),
      ],
    });

    const [measured, unserved] = buildMetaStructureInventoryViewModel({
      workspace,
      fallbackCurrency: "USD",
    }).rows;

    // Spent nothing, measured: the zero is the finding.
    expect(measured!.spend).toBe("$0");
    expect(measured!.purchases).toBe("0");
    // ROAS is undefined at zero spend, not 0.00 — printing 0.00 would be a
    // confident claim that the entity earned nothing.
    expect(measured!.roas).toBe("—");
    // Nothing served: an em dash, never a zero standing in for absence.
    expect(unserved!.spend).toBe("—");
    expect(unserved!.purchases).toBe("—");
    expect(unserved!.roas).toBe("—");
  });

  it("never prints a budget whose unit scale the contract does not state", () => {
    const workspace = workspaceFixture({
      currency: "USD",
      structureInventory: [
        inventoryEntity({ id: "camp_1", level: "campaign" }),
      ],
    });

    const [row] = buildMetaStructureInventoryViewModel({
      workspace,
      fallbackCurrency: "USD",
    }).rows;

    // `dailyBudget: 1_000_000` is $10,000 in the provider's minor units and
    // nothing in the contract says so. The setup column carries the served
    // labels instead of a number this file cannot scale.
    expect(row!.configuration).toBe(
      "Offsite Conversions · Lowest Cost · Campaign budget",
    );
    expect(row!.configuration).not.toContain("1,000,000");
  });

  it("reports the served total beside the matched total when a term is typed", () => {
    const workspace = workspaceFixture({
      currency: "USD",
      structureInventory: [
        inventoryEntity({ id: "camp_1", level: "campaign", name: "Bathroom" }),
        inventoryEntity({ id: "camp_2", level: "campaign", name: "Kitchen" }),
      ],
    });

    const view = buildMetaStructureInventoryViewModel({
      workspace,
      fallbackCurrency: "USD",
      search: "bathroom",
    });

    // A typed term narrows the table without shrinking the account.
    expect(view.servedCount).toBe(2);
    expect(view.shownCount).toBe(1);
    expect(view.searchApplied).toBe(true);
    expect(view.rows.map((row) => row.name)).toEqual(["Bathroom"]);
  });

  it("says an absent census is absent instead of reporting zero entities", () => {
    const view = buildMetaStructureInventoryViewModel({
      workspace: workspaceFixture({ currency: "USD" }),
      fallbackCurrency: "USD",
    });

    expect(view.servedCount).toBeNull();
    expect(view.rows).toEqual([]);
    expect(view.unavailableReason).toContain("no structure inventory");
  });

  it("counts the scope on the scope pill, not the first lane inside it", () => {
    const workspace = workspaceFixture({
      currency: "USD",
      actionNow: [metaRec({ id: "camp_1", level: "campaign" })],
      counts: { actionNow: 3 },
      structureInventory: [
        inventoryEntity({ id: "camp_1", level: "campaign" }),
        inventoryEntity({ id: "camp_2", level: "campaign" }),
        inventoryEntity({ id: "adset_1", level: "adset" }),
      ],
    });

    const model = buildMetaDecisionCenterExactViewModel({
      workspace,
      now: Date.parse("2026-08-17T10:00:00.000Z"),
    });

    // "Campaigns & Ad sets" counts campaigns and ad sets. It used to print
    // `lanes.counts.actionNow`, so on Grandmix it read 3 for a scope holding
    // 1,230 served entities — the same 3 the Action Now pill beside it showed.
    expect(model.counts?.structure).toBe(3);
    expect(model.counts?.action).toBe(3);

    const withoutCensus = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({
        currency: "USD",
        counts: { actionNow: 7 },
      }),
      now: Date.parse("2026-08-17T10:00:00.000Z"),
    });
    // No census served: an em dash. Falling back to the lane total is exactly
    // how the counter came to misname itself as the scope.
    expect(withoutCensus.counts?.structure).toBe("—");
    expect(withoutCensus.counts?.action).toBe(7);
  });

  it("builds the operator summary across structure and creative server lanes", () => {
    const workspace = workspaceFixture({
      counts: { actionNow: 0, watching: 0 },
      os: fullOs({ creatives: [creativeFixture()] }),
    });

    const model = buildMetaDecisionCenterExactViewModel({ workspace });

    // Lane-toolbar counts remain scoped to the structure table.
    expect(model.counts?.action).toBe(0);
    // The top-level answer covers both scopes, so a creative action cannot be
    // hidden behind a false "no change" headline.
    expect(model.operatorSummary).toMatchObject({
      action: 1,
      needsResolution: 0,
      watching: 0,
      creatives: 1,
      actionScope: "creatives",
      scopeCounts: {
        structure: { action: 0, needsResolution: 0, watching: 0 },
        creatives: { action: 1, needsResolution: 0, watching: 0 },
      },
    });
  });

  it("does not count recommendation-free Monitor inventory as watched decisions", () => {
    const recommendation = metaRec({
      id: "watching_recommendation",
      level: "campaign",
      campaignId: "cmp_watching",
      decisionState: "watch",
    });
    const workspace = workspaceFixture({
      watching: [recommendation],
      os: fullOs({
        nodes: [
          structureNodeFixture({
            id: "campaign:cmp_watching",
            sourceRecommendationId: recommendation.id,
            providerEntityId: "cmp_watching",
            campaignId: "cmp_watching",
            lane: "monitor",
          }),
          structureNodeFixture({
            id: "campaign:cmp_inventory_only",
            sourceRecommendationId: null,
            providerEntityId: "cmp_inventory_only",
            campaignId: "cmp_inventory_only",
            lane: "monitor",
          }),
        ],
      }),
    });

    const model = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(workspace.os?.structure?.monitorCount).toBe(2);
    expect(model.watchingRows?.map((row) => row.id)).toEqual([
      recommendation.id,
    ]);
    expect(model.operatorSummary).toMatchObject({
      watching: 1,
      scopeCounts: {
        structure: { watching: 1 },
      },
    });
  });

  it("does not count a synthetic campaign parent as a second decision", () => {
    const recommendation = metaRec({
      id: "adset_action",
      level: "adset",
      campaignId: "cmp_parent",
      campaignName: "Parent campaign",
      adsetId: "set_child",
      adsetName: "Child ad set",
      decisionState: "act",
    });
    const child = structureNodeFixture({
      id: "adset:set_child",
      sourceRecommendationId: recommendation.id,
      level: "adset",
      providerEntityId: "set_child",
      campaignId: "cmp_parent",
      campaignName: "Parent campaign",
      name: "Child ad set",
      lane: "act",
    });
    const syntheticParent = structureNodeFixture({
      id: "campaign:cmp_parent",
      sourceRecommendationId: null,
      level: "campaign",
      providerEntityId: "cmp_parent",
      campaignId: "cmp_parent",
      campaignName: "Parent campaign",
      name: "Parent campaign",
      lane: "act",
    });
    const os = fullOs();
    os.structure = {
      groups: [
        {
          id: "campaign:cmp_parent",
          campaign: syntheticParent,
          adsets: [child],
          highestPriority: child.priority,
          highestUrgency: child.urgency,
          urgentAdsetCount: 1,
        },
      ],
      actCount: 2,
      blockedCount: 0,
      monitorCount: 0,
      suppressedAlternativeCount: 0,
    };
    const workspace = workspaceFixture({
      actionNow: [recommendation],
      os,
    });

    const model = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(model.actionRows).toHaveLength(1);
    expect(model.counts?.action).toBe(1);
    expect(model.operatorSummary).toMatchObject({
      action: 1,
      scopeCounts: { structure: { action: 1 } },
    });
    const coverage = new Map(
      model.structureProvenance?.coverage?.map((fact) => [fact.id, fact.value]),
    );
    expect(coverage.get("structure-act")).toBe("2");
    expect(coverage.get("structure-decisions")).toBe("1");
  });

  it("routes an active non-sales source row into the server-owned Action lane", () => {
    const recommendation = metaRec({
      id: "non_sales_act",
      level: "campaign",
      campaignId: "cmp_non_sales",
      campaignName: "Server-routed campaign",
      decisionState: "act",
    });
    const workspace = workspaceFixture({
      nonSales: [recommendation],
      os: fullOs({
        nodes: [
          structureNodeFixture({
            id: "campaign:cmp_non_sales",
            sourceRecommendationId: recommendation.id,
            providerEntityId: "cmp_non_sales",
            campaignId: "cmp_non_sales",
            campaignName: "Server-routed campaign",
            name: "Server-routed campaign",
            lane: "act",
          }),
        ],
      }),
    });

    const model = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(model.operatorSummary).toMatchObject({
      action: 1,
      needsResolution: 0,
      watching: 0,
      actionScope: "structure",
    });
    expect(model.counts).toMatchObject({
      action: 1,
      needsres: 0,
      watching: 0,
      nonsales: 0,
    });
    expect(model.actionRows?.map((row) => row.id)).toEqual([recommendation.id]);
    expect(model.nonSales?.map((card) => card.id)).not.toContain(
      recommendation.id,
    );
  });

  it("does not draw server-suppressed alternatives as duplicate entity decisions", () => {
    const selected = metaRec({
      id: "selected_campaign_decision",
      level: "campaign",
      campaignId: "cmp_shared",
      campaignName: "Shared campaign",
    });
    const suppressed = metaRec({
      id: "suppressed_campaign_decision",
      level: "campaign",
      campaignId: "cmp_shared",
      campaignName: "Shared campaign",
    });
    const workspace = workspaceFixture({
      watching: [suppressed, selected],
      os: fullOs({
        nodes: [
          structureNodeFixture({
            id: "campaign:cmp_shared",
            sourceRecommendationId: selected.id,
            providerEntityId: "cmp_shared",
            campaignId: "cmp_shared",
            campaignName: "Shared campaign",
            name: "Shared campaign",
            lane: "blocked",
            suppressedAlternativeCount: 1,
          }),
        ],
      }),
    });

    const model = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(model.needsResolutionRows?.map((row) => row.id)).toEqual([
      selected.id,
    ]);
    expect(model.watchingRows).toEqual([]);
    expect(model.operatorSummary).toMatchObject({
      action: 0,
      needsResolution: 1,
      watching: 0,
    });
  });

  it("carries locale-neutral spend and campaign-role facts", () => {
    const workspace = workspaceFixture();
    workspace.pulse.campaignRoleCoverage = {
      activeCampaigns: 5,
      classifiedCampaigns: 4,
      unresolvedCampaigns: 1,
      latestUpdatedAt: null,
    };

    const model = buildMetaDecisionCenterExactViewModel({ workspace });

    expect(model.kpis?.spend).toMatchObject({ date: "2026-08-17" });
    expect(model.kpis?.spend).not.toHaveProperty("label");
    expect(model.kpis?.campaignRoles).toMatchObject({
      status: "unresolved",
      unresolvedCount: "1",
    });
    expect(model.kpis?.campaignRoles).not.toHaveProperty("detail");
  });

  it("leaves lane membership and the archive lane exactly where the server put them", () => {
    const archived: MetaArchivedEntity = {
      id: "camp_2",
      level: "campaign",
      name: "entity camp_2",
      status: "PAUSED",
      statusLabel: "Paused 1045d",
      spend: 0,
      roas: 0,
      cpa: null,
      purchases: 0,
      lastKnownWindow: "28d",
      diagnosticNote: null,
    };
    const workspace = workspaceFixture({
      currency: "USD",
      actionNow: [metaRec({ id: "camp_1", level: "campaign" })],
      archive: [archived],
      structureInventory: [
        inventoryEntity({ id: "camp_1", level: "campaign" }),
        inventoryEntity({ id: "camp_2", level: "campaign" }),
      ],
    });

    const model = buildMetaDecisionCenterExactViewModel({
      workspace,
      now: Date.parse("2026-08-17T10:00:00.000Z"),
    });

    // camp_2 is listed in the census AND still the only archive row. Listing
    // it did not promote it out of Archive, and Archive did not grow.
    expect(model.actionRows?.map((row) => row.id)).toEqual(["camp_1"]);
    expect(model.archiveRows?.map((row) => row.id)).toEqual(["camp_2"]);
    expect(model.counts?.archive).toBe(1);
    expect(
      buildMetaStructureInventoryViewModel({
        workspace,
        fallbackCurrency: "USD",
      }).rows.map((row) => row.id),
    ).toEqual(["campaign:camp_1", "campaign:camp_2"]);
  });
});

/**
 * THE ONE FIELD THIS ROUND DELIBERATELY DID NOT WIRE, and the check that keeps
 * the decision honest.
 *
 * `MetaCanonicalDecision.classification.resolution` — the canonical
 * `MetaDecisionResolution` (decisions-workspace-contract.ts:57, :318) — rides
 * the `onCreativeReview` payload and reaches no pixel on the Decision page. It
 * is INTENTIONALLY-NOT-RENDERED, not an oversight, and the reason is a single
 * assignment in the producer rather than an opinion:
 *
 *   `lib/meta/decisions-os-presentation.ts` writes `MetaOsAdDecision.resolution`
 *   in exactly two places. One is `resolution: decision.classification.resolution`
 *   — the canonical object forwarded verbatim, which is what the evidence
 *   window's "Served resolution" line prints. The other is the
 *   pending-inventory placeholder, synthesised for an ACTIVE ad that has NO
 *   canonical decision at all, so there is no canonical resolution for a second
 *   block to disagree with — only em dashes beside a populated line, which
 *   would read as two producers contradicting each other where one produced
 *   nothing.
 *
 * A second heading for one fact invites a reader to hunt for a difference the
 * assignment forbids; a fabricated disagreement is the same class of defect as
 * a fabricated measurement. So the field stays unrendered and THIS is what
 * fails the day the equivalence stops holding.
 */
describe("the canonical resolution is the served resolution", () => {
  it("pins the two writers of the OS resolution, so the withholding stays checkable", () => {
    const presentation = readFileSync(
      "lib/meta/decisions-os-presentation.ts",
      "utf8",
    );
    const writers = presentation.match(/^\s*resolution: .*$/gm) ?? [];

    // Exactly two. A THIRD writer means the OS resolution is no longer the
    // canonical one under another name, and the classification has to be made
    // again rather than inherited.
    expect(writers).toHaveLength(2);
    expect(writers[0]?.trim()).toBe(
      "resolution: decision.classification.resolution,",
    );
    // The second is the synthesised placeholder's object literal, which exists
    // only on rows that carry no canonical decision.
    expect(writers[1]?.trim()).toBe("resolution: {");
    expect(presentation).toContain('code: "produce_native_ad_decision"');
  });

  it("reads the canonical resolution nowhere on this surface", () => {
    // Every mention on the Decision Center surface is a comment about the
    // choice, never a read. A bare `classification.resolution` in live code
    // here would be a second resolution under a second label.
    for (const file of [
      "components/meta/decision-center/meta-decision-center-exact-adapter.ts",
      "components/meta/decision-center/MetaDecisionCenterExact.tsx",
    ]) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.includes("classification.resolution")) continue;
        expect(line.trim(), file).toMatch(/^(\*|\/\/|\/\*)/);
      }
    }
  });
});

describe("commercial anchor projection (server-owned, client renders only)", () => {
  /** Projects a REAL resolved profile exactly as the workspace route does. */
  async function realPanel(input: {
    targetPack: Parameters<typeof makeAnchorTargetPack>[0];
    calibration?: ReturnType<typeof makeAccountCalibration>;
    currency?: string | null;
  }): Promise<MetaCommercialAnchorPanel> {
    const profile = await resolveAnchorProfileFixture({
      targetPack: makeAnchorTargetPack(input.targetPack),
      calibration: input.calibration,
    });
    return projectMetaCommercialAnchorPanel({
      eligibility: profile.hardActionEligibility,
      currency: "currency" in input ? (input.currency ?? null) : "TRY",
      blockers: {
        ...emptyAuthorityBlockerCounts(),
        profileHardActionIneligible: 603,
        campaignContext: 12,
      },
    });
  }

  function anchorFacts(panel: MetaCommercialAnchorPanel | undefined) {
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({
        currency: "TRY",
        ...(panel ? { commercialAnchor: panel } : {}),
      }),
    });
    return model.sourceProvenance?.commercialAnchor ?? [];
  }

  function byId(facts: ReturnType<typeof anchorFacts>) {
    return new Map(facts.map((entry) => [entry.id, entry]));
  }

  it("renders nothing at all when the server sent no panel", () => {
    expect(anchorFacts(undefined)).toEqual([]);
  });

  it("renders the real source, confidence and spend unit in the business currency", async () => {
    const panel = await realPanel({ targetPack: { targetCpa: 400 } });
    const facts = byId(anchorFacts(panel));
    expect(facts.get("anchor-status")?.value).toBe("eligible_target_cpa");
    expect(facts.get("anchor-source")?.value).toBe("target_cpa");
    expect(facts.get("anchor-confidence")?.value).toBe("high");
    expect(String(facts.get("anchor-spend-unit")?.value)).toContain("₺");
    expect(facts.get("anchor-currency")?.value).toBe("TRY");
  });

  /**
   * THE REJECTED BEHAVIOUR, pinned at the render boundary: a ready sampled
   * Meta AOV must never surface as a missing owner anchor.
   */
  it("renders a ready sampled Meta AOV as the real source, never anchor missing", async () => {
    const panel = await realPanel({
      targetPack: { targetCpa: null, operatorAovAssumption: null },
      calibration: makeAccountCalibration({
        metaAttributedAovMean90d: 60,
        metaAttributedAovPurchaseCount90d: 40,
        metaAttributedRevenue90d: 2400,
      }),
    });
    const facts = byId(anchorFacts(panel));
    expect(facts.get("anchor-source")?.value).toBe("meta_derived_aov");
    expect(facts.get("anchor-status")?.value).toBe("eligible_meta_derived_aov");
    expect(facts.get("anchor-status")?.value).not.toBe("anchor_missing");
    expect(String(facts.get("anchor-meta-aov")?.value)).toContain("40");
    expect(facts.has("anchor-missing-inputs")).toBe(false);
  });

  it("renders Scale, Cut and Refresh separately with code and operator copy", async () => {
    const panel = await realPanel({
      targetPack: { targetCpa: 400, breakEvenRoas: null, targetRoas: null },
    });
    const facts = byId(anchorFacts(panel));
    expect(String(facts.get("anchor-action-cut")?.value)).toContain(
      "break_even_roas_missing",
    );
    expect(String(facts.get("anchor-action-scale")?.value)).toContain(
      "target_roas_missing",
    );
    expect(facts.get("anchor-action-refresh")?.value).toBe("eligible");
    expect(String(facts.get("anchor-action-cut-copy")?.value)).toContain(
      "break-even ROAS",
    );
    // An eligible action has no next-step row.
    expect(facts.has("anchor-action-refresh-copy")).toBe(false);
  });

  it("separates the independent gates from the anchor gate", async () => {
    const panel = await realPanel({ targetPack: { targetCpa: 400 } });
    const facts = byId(anchorFacts(panel));
    // Generic on purpose: `profile_hard_action_ineligible` is a first-blocker
    // family, so the row must not claim a commercial-threshold cause.
    expect(facts.get("anchor-withheld-profile-evidence")?.value).toBe("603");
    expect(facts.has("anchor-withheld-threshold")).toBe(false);
    expect(facts.get("anchor-withheld-campaign-context")?.value).toBe("12");
  });

  it("renders an unavailable profile honestly, with no spend unit or eligibility", () => {
    const facts = byId(
      anchorFacts(
        projectMetaCommercialAnchorPanel({
          eligibility: null,
          profileReadFailed: true,
          currency: "TRY",
          blockers: emptyAuthorityBlockerCounts(),
        }),
      ),
    );
    expect(facts.get("anchor-status")?.value).toBe("unavailable");
    expect(facts.get("anchor-unavailable-reason")?.value).toBe(
      "profile_read_failed",
    );
    expect(facts.has("anchor-spend-unit")).toBe(false);
    expect(facts.has("anchor-action-cut")).toBe(false);
  });

  it("never fabricates a currency the server did not supply", async () => {
    const panel = await realPanel({
      targetPack: { targetCpa: 400 },
      currency: null,
    });
    const facts = byId(anchorFacts(panel));
    expect(facts.get("anchor-currency")?.value).toBe("account currency");
  });
});

/**
 * D084 Correction 2 — the DIRECTIONAL envelope survives the trip to the view
 * model, whole.
 *
 * It is forwarded rather than flattened into the source-fact list every other
 * provenance group uses, because flattening separates a blocker code from its
 * own sentence and would collapse the two directions into one.
 */
describe("the exact adapter forwards the budget-evidence directions", () => {
  const servedEvidence = (): MetaBudgetDecisionEvidenceByDirection => {
    const build = (direction: "increase" | "decrease") =>
      projectBudgetDecisionEvidencePanel({
        verdict: evaluateBudgetDecisionGates(
          buildWorkspaceBudgetGateInput({
            direction,
            originMs: Date.parse("2026-09-01T00:00:00.000Z"),
            profile: null,
            profileSourceStatus: "read_failed",
            profileUnavailableWhy: "the account decision profile read failed",
            commercialTarget: null,
            roleResolved: false,
            providerCompatibilityKnown: false,
            automationEnabled: false,
            changeHistory: {
              readState: "not_attempted",
              readStateWhy: "no history read",
              lastChangeAtMs: null,
              changesForEntityToday: null,
              changesInAccountToday: null,
              changesInBusinessToday: null,
              changesInFleetToday: null,
              accountChangesToday: null,
              fleetChangesToday: null,
              countSemantics: "prospective_including_candidate",
            },
            knownBindings: [],
          }),
        ),
      });
    return {
      contractVersion: "meta-budget-decision-evidence-directional.v3",
      directionToAction: { increase: "scale", decrease: "cut" },
      directionToActionWhy:
        "an increase is a scale decision and a decrease is a cut decision",
      directionSelected: null,
      directionSelectedWhy: "no proposal direction has been selected",
      increase: build("increase"),
      decrease: build("decrease"),
    };
  };

  it("carries both directions through verbatim, code and sentence together", () => {
    const evidence = servedEvidence();
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({ budgetEvidence: evidence }),
    });
    expect(model.budgetEvidence).toEqual(evidence);
    for (const direction of ["increase", "decrease"] as const) {
      const panel = model.budgetEvidence![direction];
      const primary = panel.primaryBlocker!;
      const owning = panel.sections.find((s) =>
        s.blockerCodes.includes(primary.code),
      );
      expect(
        owning,
        `${direction}: ${primary.code} is in no section`,
      ).toBeTruthy();
      expect(owning!.reasons).toContain(primary.reason);
    }
  });

  it("keeps the two directions distinguishable rather than merging them", () => {
    const evidence = servedEvidence();
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({ budgetEvidence: evidence }),
    });
    expect(model.budgetEvidence!.directionSelected).toBeNull();
    // An increase faces the conversion floor and the binding test; a decrease
    // faces neither, so their blocker sets must not be identical.
    const increaseCodes = model.budgetEvidence!.increase.sections.flatMap(
      (s) => s.blockerCodes,
    );
    const decreaseCodes = model.budgetEvidence!.decrease.sections.flatMap(
      (s) => s.blockerCodes,
    );
    expect(increaseCodes).toContain(
      "evidence_conversions_below_increase_floor",
    );
    expect(decreaseCodes).not.toContain(
      "evidence_conversions_below_increase_floor",
    );
  });

  it("passes null when the server sent nothing, never an empty clear panel", () => {
    const model = buildMetaDecisionCenterExactViewModel({
      workspace: workspaceFixture({}),
    });
    expect(model.budgetEvidence).toBeNull();
  });
});
