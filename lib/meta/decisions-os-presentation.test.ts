import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MetaCanonicalDecision,
  MetaDecisionAuthorityBlocker,
  MetaDecisionBuyerAction,
  MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-contract";
import { projectMetaDecisionSemantics } from "@/lib/meta/decision-semantics";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import {
  buildMetaOsDecisionsPresentation,
  revalidateMetaStructureLanesForCurrentTargets,
} from "@/lib/meta/decisions-os-presentation";
import { metaLanePayload } from "@/components/meta/redesign/test-fixtures";
import { CAMPAIGN_CONTEXT_RESOLVER_VERSION } from "@/lib/creative-decision-engine/campaign-context/resolver";
import { CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV } from "@/lib/creative-decision-engine/campaign-context/source";

afterEach(() => {
  vi.unstubAllEnvs();
});

function recommendation(
  input: Partial<MetaRecommendation> & Pick<MetaRecommendation, "id" | "level">,
): MetaRecommendation {
  return {
    campaignId: input.campaignId,
    campaignName: input.campaignName,
    adsetId: input.adsetId,
    adsetName: input.adsetName,
    type: input.type ?? "campaign_structure",
    lens: input.lens ?? "structure",
    priority: input.priority ?? "medium",
    confidence: input.confidence ?? "medium",
    decisionState: input.decisionState ?? "act",
    decision: input.decision ?? "Review",
    title: input.title ?? "Review entity",
    why: input.why ?? "Server evidence requires review.",
    summary: input.summary ?? "Review entity",
    recommendedAction: input.recommendedAction ?? "Review",
    expectedImpact: input.expectedImpact ?? "Cannot calculate",
    evidence: input.evidence ?? [],
    timeframeContext: input.timeframeContext ?? {
      coreVerdict: "Review",
      selectedRangeOverlay: "Current range",
      historicalSupport: "Unavailable",
      seasonalityFlag: "none",
      note: null,
    },
    entityConfiguration: input.entityConfiguration ?? {
      source:
        input.level === "adset"
          ? "account_scoped_adset_row"
          : "account_scoped_campaign_row",
      budgetOwner: input.level === "adset" ? "adset" : "campaign",
      budgetMode: input.level === "adset" ? "adset_budget" : "campaign_budget",
      controlOwner: input.level === "adset" ? "adset" : "campaign",
      status: "ACTIVE",
      optimizationGoal: "PURCHASE",
      bidStrategyType: "lowest_cost",
    },
    ...input,
    id: input.id,
    level: input.level,
  };
}

function canonicalDecision(input: {
  id: string;
  adId: string | null;
  buyerAction: MetaDecisionBuyerAction;
  role?: MetaCanonicalDecision["classification"]["lifecycleRole"]["value"];
  candidateAdCount?: number;
}): MetaCanonicalDecision {
  const candidateAdCount = input.candidateAdCount ?? (input.adId ? 1 : 0);
  return {
    decisionId: input.id,
    episodeId: `${input.id}:episode`,
    episodeStartedAt: "2026-07-10",
    providerAccountId: "act_1",
    identityGrain: "creative",
    sourceSnapshotId: `${input.id}:snapshot`,
    sourceDecision: {
      label:
        input.buyerAction === "diagnose_data" ? "diagnose" : input.buyerAction,
      preAuthorityLabel:
        input.buyerAction === "diagnose_data" ? "diagnose" : input.buyerAction,
      authorityBlocker: null,
      rawLabel: input.buyerAction,
      reason: "Persisted server decision.",
      confidence: 0.8,
      confidenceBand: "high",
      truthSource: "commercial_truth",
      engineVersion: "v3-test",
      snapshotAsOf: "2026-07-10",
      computedAt: "2026-07-10T04:00:00.000Z",
      badges: [],
      provenance: {
        source: "test",
        field: "decision",
        recordId: input.id,
        asOf: "2026-07-10",
        version: "v3-test",
      },
    },
    parentChain: {
      account: { id: "act_1", name: "Account" },
      campaign: { id: "cmp_1", name: "Main campaign" },
      adset: { id: "set_1", name: "Broad" },
      ad: input.adId ? { id: input.adId, name: `Ad ${input.adId}` } : null,
      creative: { id: `creative:${input.id}`, name: `Creative ${input.id}` },
      provenance: {
        source: "test",
        field: "identity",
        recordId: input.id,
        asOf: "2026-07-10",
        version: null,
      },
    },
    identityResolution: {
      basis:
        candidateAdCount === 1
          ? "single_ad_creative_equivalent"
          : candidateAdCount > 1
            ? "creative_ambiguous"
            : "unresolved",
      candidateAdCount,
      metricsEquivalent: candidateAdCount === 1,
      adActionEligible: candidateAdCount === 1,
    },
    media: {
      state: "missing",
      missingMedia: true,
      thumbnail: { state: "missing", url: null },
      provenance: {
        source: "test",
        field: "media",
        recordId: input.id,
        asOf: "2026-07-10",
        version: null,
      },
    },
    classification: {
      overlayVersion: "meta-decisions-classification-overlay.v4",
      queueSection: "creative_rotation",
      lifecycleRole: {
        value: input.role ?? "main",
        confidence: "high",
        trustedForAction: true,
        blockerCode: null,
        provenance: {
          source: "test",
          field: "role",
          recordId: input.id,
          asOf: "2026-07-10",
          version: null,
        },
      },
      assessment: {
        value:
          input.buyerAction === "cut"
            ? "below_target"
            : input.buyerAction === "test_more"
              ? "learning"
              : input.buyerAction === "diagnose_data"
                ? "decision_blocked"
                : "proven_winner",
        blockerCode: null,
        provenance: {
          source: "test",
          field: "assessment",
          recordId: input.id,
          asOf: "2026-07-10",
          version: null,
        },
      },
      decisionState:
        input.buyerAction === "diagnose_data"
          ? "blocked"
          : input.buyerAction === "cut" || input.buyerAction === "refresh"
            ? "act"
            : input.buyerAction === "scale" &&
                (input.role === "test" || input.role === "mixed")
              ? "act"
              : "monitor",
      heldAction: null,
      legacyBuyerAction: input.buyerAction,
      buyerAction:
        input.buyerAction === "diagnose_data" ? null : input.buyerAction,
      buyerLabel: input.buyerAction,
      executionAction: input.buyerAction === "scale" ? "scale_budget" : null,
      resolution:
        input.buyerAction === "diagnose_data"
          ? {
              code: "resolve_evidence_gap",
              category: "system",
              owner: "system",
              label: "Resolve Evidence Gap",
              nextStep: "Complete missing evidence.",
            }
          : null,
      blockers: [],
      provenance: {
        source: "test",
        field: "classification",
        recordId: input.id,
        asOf: "2026-07-10",
        version: null,
      },
    },
    riskTier: null,
    confirmationCeremony: "highest",
    riskTierProvenance: {
      status: "proposed",
      reason: "risk_tier_producer_not_persisted",
    },
    promotionBasis: {
      status: "proposed",
      value: null,
      reason: "promotion_basis_not_persisted",
    },
    metrics: {
      spend: 100,
      purchases: 4,
      roas: 2.4,
      recent7dRoas: 2.2,
      effectiveTargetRoas: 1.8,
      ratioToTarget: 1.33,
      currency: "EUR",
      attribution: "meta_attributed",
      provenance: {
        source: "test",
        field: "metrics",
        recordId: input.id,
        asOf: "2026-07-10",
        version: null,
      },
    },
    exposure: null,
    exposureUnavailableReason: null,
    history: {
      events: { status: "available", reason: null, preCapCount: 0, items: [] },
      outcomes: { status: "available", reason: null, items: [] },
      responses: {
        status: "unavailable",
        reason: "legacy_response_journal_not_keyed_by_decision_episode",
      },
      providerWrites: {
        status: "unavailable",
        reason: "provider_write_journal_not_keyed_by_decision_episode",
      },
    },
  };
}

function readModel(
  items: MetaCanonicalDecision[],
): MetaDecisionsWorkspaceReadModel {
  const emptySection = (
    key: "integrity_fires" | "money_moves" | "creative_rotation",
  ) => ({
    key,
    label: key,
    topN: 5,
    preCapCount: key === "creative_rotation" ? items.length : 0,
    selectedCount: key === "creative_rotation" ? items.length : 0,
    rankablePreCapCount: key === "creative_rotation" ? items.length : 0,
    unrankablePreCapCount: 0,
    items: key === "creative_rotation" ? items : [],
    exposureDigest: {
      basis: "pre_cap" as const,
      byCurrency: [],
      unavailableCount: 0,
      crossCurrencyTotal: null,
    },
    suppressionReceipt: {
      receiptId: `receipt:${key}`,
      selectionVersion: "meta-decisions-section-selection.v1" as const,
      topN: 5,
      preCapCount: key === "creative_rotation" ? items.length : 0,
      selectedCount: key === "creative_rotation" ? items.length : 0,
      suppressedCount: 0,
      reasons: [],
    },
  });
  return {
    contractVersion: "meta-decisions-workspace.read.v4",
    status: "available",
    generatedAt: "2026-07-10T04:00:00.000Z",
    scope: {
      businessId: "biz_1",
      providerAccountId: "act_1",
      decisionMode: "current",
      metricsRangeAffectsDecisionSnapshot: false,
    },
    unavailable: null,
    source: {
      status: "available",
      authority: "legacy_creative",
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf: "2026-07-10",
      computedAt: "2026-07-10T04:00:00.000Z",
      engineVersion: "v3-test",
      fallbackReason: "native_generation_unavailable",
      generation: null,
    },
    queue: {
      deduplicationGrain: "creative",
      sourcePreCapCount: items.length,
      queuedPreCapCount: items.length,
      sections: {
        integrity_fires: emptySection("integrity_fires"),
        money_moves: emptySection("money_moves"),
        creative_rotation: emptySection("creative_rotation"),
      },
      omittedFromQueue: { count: 0, reasons: [] },
    },
    capabilities: {
      providerAccountScope: { status: "available", reason: null },
      stableDecisionIdentity: { status: "available", reason: null },
      stableEpisodeIdentity: { status: "available", reason: null },
      classificationOverlay: { status: "available", reason: null },
      riskTierProducer: { status: "proposed", reason: "test" },
      promotionBasisProducer: { status: "proposed", reason: "test" },
      responseAttribution: { status: "unavailable", reason: "test" },
      providerWriteLinkage: { status: "unavailable", reason: "test" },
    },
  };
}

describe("buildMetaOsDecisionsPresentation", () => {
  it("downgrades persisted Structure hard actions when current target authority is unavailable", () => {
    const scale = recommendation({
      id: "structure-scale",
      level: "campaign",
      campaignId: "cmp_scale",
      campaignName: "Scale campaign",
      decisionLabel: "scale",
      actionKind: "execute_bid",
      primaryActionLabel: "Increase campaign budget",
      targetValue: { bidAmountMinor: 2500 },
      proposedAction: { kind: "apply_bid", bidAmountMinor: 2500 },
    });
    const cut = recommendation({
      id: "structure-cut",
      level: "adset",
      campaignId: "cmp_cut",
      campaignName: "Cut campaign",
      adsetId: "set_cut",
      adsetName: "Cut ad set",
      decisionLabel: "cut",
      actionKind: "execute_pause",
      primaryActionLabel: "Pause Ad Set",
      proposedAction: { kind: "pause" },
      automationReadiness: {
        contractVersion: "meta-automation-readiness.v1",
        tier: "auto_execute",
        autoExecuteEligible: true,
        operatorReviewRequired: false,
        decisionLabel: "cut",
        blockers: [],
        missingEvidence: [],
        requiredEvidence: [],
        reason: "Eligible in the persisted snapshot.",
      },
    });
    const lanes = revalidateMetaStructureLanesForCurrentTargets(
      metaLanePayload({
        actionNow: [scale, cut],
        watching: [],
        nonSales: [],
        healthy: [],
        archive: [],
        counts: {
          actionNow: 2,
          watching: 0,
          healthy: 0,
          nonSales: 0,
          archive: 0,
        },
      }),
      { scale: true, cut: false },
    );

    expect(lanes.counts).toMatchObject({ actionNow: 1, watching: 1 });
    expect(lanes.actionNow[0]).toMatchObject({
      id: "structure-scale",
      actionKind: "execute_bid",
    });
    expect(lanes.watching[0]).toMatchObject({
      id: "structure-cut",
      decisionLabel: "cut",
      decisionState: "watch",
      actionKind: "review_drill",
      primaryActionLabel: "Review Commercial Truth",
      watchSegment: "missing_target",
      rowPresentation: {
        signal: "blocker",
        blockerLabel: "Current break-even ROAS authority",
      },
      automationReadiness: {
        tier: "manual_review",
        autoExecuteEligible: false,
        operatorReviewRequired: true,
        blockers: ["missing_commercial_anchor"],
      },
    });
    expect(lanes.watching[0]!.proposedAction).toBeUndefined();
    expect(lanes.watchingSegments).toEqual([
      {
        key: "missing_target",
        label: "Missing target",
        count: 1,
        description: "Commercial target or break-even anchor is missing.",
        ctaLabel: "Set targets",
        href: "/commercial-truth",
      },
    ]);

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [scale, cut],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currency: "EUR",
      targetHardActionEligibility: { scale: true, cut: false },
    });
    const scaleNode = result.structure.groups.find(
      (group) => group.campaign.campaignId === "cmp_scale",
    )!.campaign;
    const cutNode = result.structure.groups.find(
      (group) => group.campaign.campaignId === "cmp_cut",
    )!.adsets[0]!;
    expect(scaleNode).toMatchObject({
      lane: "act",
      action: { code: "execute_bid", providerMutation: "apply_bid" },
    });
    expect(cutNode).toMatchObject({
      lane: "blocked",
      assessment: "Decision Blocked",
      action: {
        code: "review_commercial_truth",
        label: "Review Commercial Truth",
        intent: "review",
        providerMutation: null,
      },
    });
  });

  it("merges the complete Structure inventory while keeping live recommendation authority", () => {
    const activeRecommendation = recommendation({
      id: "rec_set_live",
      level: "adset",
      campaignId: "cmp_live",
      campaignName: "Live campaign",
      adsetId: "set_live",
      adsetName: "Broad",
      priority: "high",
      confidence: "high",
      decisionState: "act",
      decisionLabel: "cut",
      actionKind: "execute_pause",
      primaryActionLabel: "Pause Ad Set",
    });
    const configuration = (level: "campaign" | "adset", status: string) => ({
      source:
        level === "campaign"
          ? ("account_scoped_campaign_row" as const)
          : ("account_scoped_adset_row" as const),
      budgetOwner: level,
      budgetMode:
        level === "campaign"
          ? ("campaign_budget" as const)
          : ("adset_budget" as const),
      controlOwner: level,
      status,
      optimizationGoal: "PURCHASE",
      bidStrategyType: "lowest_cost",
    });

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [activeRecommendation],
      watching: [],
      nonSales: [],
      structureInventory: [
        {
          id: "cmp_live",
          level: "campaign",
          name: "Live campaign",
          campaignId: "cmp_live",
          campaignName: "Live campaign",
          campaignKind: "main",
          status: "ACTIVE",
          statusLabel: "Active",
          metrics: {
            spend: 1000,
            purchases: 20,
            roas: 2.5,
            cpa: 50,
            ctr: 1.2,
            frequency: 1.4,
          },
          entityConfiguration: configuration("campaign", "ACTIVE"),
        },
        {
          id: "set_live",
          level: "adset",
          name: "Broad",
          campaignId: "cmp_live",
          campaignName: "Live campaign",
          campaignKind: "main",
          status: "ACTIVE",
          statusLabel: "Active",
          metrics: {
            spend: 600,
            purchases: 8,
            roas: 1.1,
            cpa: 75,
            ctr: 0.8,
            frequency: 1.6,
          },
          entityConfiguration: configuration("adset", "ACTIVE"),
        },
        {
          id: "cmp_paused",
          level: "campaign",
          name: "Paused campaign",
          campaignId: "cmp_paused",
          campaignName: "Paused campaign",
          campaignKind: null,
          status: "PAUSED",
          statusLabel: "Paused",
          metrics: {
            spend: 200,
            purchases: 2,
            roas: 0.9,
            cpa: 100,
            ctr: null,
            frequency: null,
          },
          entityConfiguration: configuration("campaign", "PAUSED"),
        },
      ],
      decisionReadModel: readModel([]),
      currency: "EUR",
    });

    expect(result.structure.groups).toHaveLength(2);
    const live = result.structure.groups.find(
      (group) => group.campaign.campaignId === "cmp_live",
    )!;
    expect(live.campaign.action.code).toBe("no_current_intervention");
    expect(live.adsets[0]).toMatchObject({
      sourceRecommendationId: "rec_set_live",
      action: { providerMutation: "pause" },
      urgency: { level: "critical" },
    });
    expect(live).toMatchObject({
      highestUrgency: { level: "critical" },
      urgentAdsetCount: 1,
    });
    const paused = result.structure.groups.find(
      (group) => group.campaign.campaignId === "cmp_paused",
    )!.campaign;
    expect(paused).toMatchObject({
      status: "PAUSED",
      action: { code: "inactive_inventory", providerMutation: null },
      urgency: { level: "none" },
    });
  });

  it("deduplicates structure controls and never exposes Scale as the action label", () => {
    const high = recommendation({
      id: "campaign-high",
      level: "campaign",
      campaignId: "cmp_1",
      campaignName: "Prospecting",
      decisionLabel: "scale",
      primaryActionLabel: "Scale budget",
      strategyLayer: "budget",
      priority: "high",
      metrics: { spend: 1000, roas: 2.8 },
    });
    const low = recommendation({
      id: "campaign-low",
      level: "campaign",
      campaignId: "cmp_1",
      campaignName: "Prospecting",
      decisionLabel: "keep",
      primaryActionLabel: "Keep",
      priority: "low",
    });

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [high, low],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currentAdCampaignContexts: [
        {
          campaignId: "cmp_1",
          kind: null,
          suggestedKind: "test",
          source: "system_inferred",
          confidenceClass: "unknown",
          sourceUpdatedAt: "2026-07-13T04:00:00.000Z",
          resolverVersion: "campaign-context-resolver.v1",
        },
      ],
      pipelineHealth: {
        overall: "healthy",
        executionReady: true,
        blockers: [],
      },
      currency: "EUR",
    });

    expect(result.structure.groups).toHaveLength(1);
    expect(result.structure.groups[0]!.campaign.action.label).toBe(
      "Review Campaign Budget",
    );
    expect(result.structure.groups[0]!.campaign.action.label).not.toMatch(
      /scale/i,
    );
    expect(result.structure.groups[0]!.campaign.lifecycleRole).toBe("test");
    expect(result.structure.groups[0]!.campaign).toMatchObject({
      campaignRoleSource: "automatic",
      campaignRoleConfidence: "unknown",
      campaignRoleTrustedForAction: false,
    });
    expect(
      result.structure.groups[0]!.campaign.suppressedAlternativeCount,
    ).toBe(1);
  });

  it("trusts automatic Structure provenance only for the validated resolver version", () => {
    vi.stubEnv(
      CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION_ENV,
      CAMPAIGN_CONTEXT_RESOLVER_VERSION,
    );
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [
        recommendation({
          id: "campaign-override",
          level: "campaign",
          campaignId: "cmp_override",
          campaignName: "Winner campaign",
          campaignKind: "main",
        }),
      ],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currentAdCampaignContexts: [
        {
          campaignId: "cmp_override",
          kind: "main",
          suggestedKind: "main",
          source: "system_inferred",
          confidenceClass: "high",
          sourceUpdatedAt: "2026-07-13T04:00:00.000Z",
          resolverVersion: CAMPAIGN_CONTEXT_RESOLVER_VERSION,
        },
      ],
      currency: "EUR",
    });

    expect(result.structure.groups[0]!.campaign).toMatchObject({
      lifecycleRole: "main",
      campaignRoleSource: "automatic",
      campaignRoleConfidence: "high",
      campaignRoleTrustedForAction: true,
    });
  });

  /**
   * D074/D076: every campaign context row the presentation consumes is
   * EXPLAINED — the resolver's own kind, confidence class and score, evidence,
   * conflicts, unresolved reason, last evaluation time and resolver version
   * travel verbatim, and no kind is ever computed into the explanation.
   */
  it("serves the resolver's role explanation verbatim on structure and Ad rows", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [
        recommendation({
          id: "campaign-explained",
          level: "campaign",
          campaignId: "cmp_1",
          campaignName: "Main campaign",
        }),
      ],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([
        canonicalDecision({
          id: "explained-ad",
          adId: "120000000000000031",
          buyerAction: "cut",
        }),
      ]),
      currentAdCampaignContexts: [
        {
          campaignId: "cmp_1",
          kind: "main",
          suggestedKind: "main",
          source: "system_inferred",
          confidenceClass: "high",
          sourceUpdatedAt: "2026-07-10T04:00:00.000Z",
          resolverVersion: "campaign-context-v2-account-scoped",
          confidenceScore: 0.87,
          evidence: ["budget concentration 0.81"],
          conflictReasons: [],
          unresolvedReason: null,
          lastEvaluatedAt: "2026-07-10T04:00:00.000Z",
        },
      ],
      currency: "EUR",
    });

    const expected = {
      kind: "main",
      confidenceClass: "high",
      confidenceScore: 0.87,
      evidence: ["budget concentration 0.81"],
      conflictReasons: [],
      unresolvedReason: null,
      lastEvaluatedAt: "2026-07-10T04:00:00.000Z",
      resolverVersion: "campaign-context-v2-account-scoped",
    };
    expect(result.structure.groups[0]!.campaign.campaignRoleExplanation).toEqual(
      expected,
    );
    expect(result.ads.items[0]!.campaignRoleExplanation).toEqual(expected);
  });

  it("keeps the resolver's null kind visible beside the provisional display role", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [
        recommendation({
          id: "campaign-unresolved",
          level: "campaign",
          campaignId: "cmp_unresolved",
          campaignName: "Unclassified current campaign",
        }),
      ],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currentAdCampaignContexts: [
        {
          campaignId: "cmp_unresolved",
          kind: null,
          suggestedKind: "main",
          source: "system_inferred",
          confidenceClass: "unknown",
          sourceUpdatedAt: "2026-07-10T04:00:00.000Z",
          resolverVersion: "campaign-context-v2-account-scoped",
          confidenceScore: 0.21,
          evidence: ["signal volume below threshold"],
          conflictReasons: [],
          unresolvedReason: "insufficient_evidence",
          lastEvaluatedAt: "2026-07-10T04:00:00.000Z",
        },
      ],
      currency: "EUR",
    });

    const campaign = result.structure.groups[0]!.campaign;
    // The display role may be provisional; the explanation is the resolver's
    // own answer and stays null-kinded with the server's reason.
    expect(campaign.lifecycleRole).toBe("main");
    expect(campaign.campaignRoleExplanation).toMatchObject({
      kind: null,
      confidenceScore: 0.21,
      evidence: ["signal volume below threshold"],
      unresolvedReason: "insufficient_evidence",
    });
  });

  it("explains a campaign with no context row as not yet evaluated", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [
        recommendation({
          id: "campaign-never-evaluated",
          level: "campaign",
          campaignId: "cmp_never",
          campaignName: "Fresh campaign",
        }),
      ],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currentAdCampaignContexts: [],
      currency: "EUR",
    });

    expect(
      result.structure.groups[0]!.campaign.campaignRoleExplanation,
    ).toEqual({
      kind: null,
      confidenceClass: "unknown",
      confidenceScore: null,
      evidence: [],
      conflictReasons: [],
      unresolvedReason: "not_yet_evaluated",
      lastEvaluatedAt: null,
      resolverVersion: null,
    });
  });

  it("uses server-composed provider configuration for budget and bid ownership", () => {
    const cboAdset = recommendation({
      id: "cbo-adset",
      level: "adset",
      campaignId: "cmp_cbo",
      campaignName: "CBO campaign",
      adsetId: "set_cbo",
      adsetName: "Broad",
      decisionLabel: "scale",
      strategyLayer: "budget",
      primaryActionLabel: "Scale budget",
      entityConfiguration: {
        source: "account_scoped_adset_row",
        budgetOwner: "campaign",
        budgetMode: "campaign_budget",
        controlOwner: "adset",
        status: "ACTIVE",
        optimizationGoal: "PURCHASE",
        bidStrategyType: "cost_cap",
        bidStrategyLabel: "Cost cap",
        bidValue: 1800,
        bidValueFormat: "currency",
        previousBidValue: 1600,
        previousBidValueFormat: "currency",
        previousBidValueCapturedAt: "2026-07-09T11:00:00.000Z",
        dailyBudget: 10000,
        lifetimeBudget: null,
        budgetUtilization: 0.72,
      },
    });
    const costCapCampaign = recommendation({
      id: "cost-cap-campaign",
      level: "campaign",
      campaignId: "cmp_cap",
      campaignName: "Cost cap",
      actionKind: "execute_bid",
      primaryActionLabel: "Apply cost cap",
      entityConfiguration: {
        source: "account_scoped_campaign_row",
        budgetOwner: "campaign",
        budgetMode: "campaign_budget",
        controlOwner: "adset",
        status: "ACTIVE",
        optimizationGoal: "PURCHASE",
        bidStrategyType: "cost_cap",
        bidStrategyLabel: "Cost cap",
        bidValue: 1800,
        bidValueFormat: "currency",
        previousBidValue: 1600,
        previousBidValueFormat: "currency",
        previousBidValueCapturedAt: "2026-07-09T11:00:00.000Z",
        dailyBudget: 10000,
        lifetimeBudget: null,
        budgetUtilization: 0.72,
      },
    });

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [cboAdset, costCapCampaign],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currency: "EUR",
    });
    const cboNode = result.structure.groups.find(
      (group) => group.campaign.campaignId === "cmp_cbo",
    )!.adsets[0]!;
    const capNode = result.structure.groups.find(
      (group) => group.campaign.campaignId === "cmp_cap",
    )!.campaign;

    expect(cboNode).toMatchObject({
      budgetOwner: "campaign",
      budgetMode: "campaign_budget",
      controlOwner: "adset",
      status: "ACTIVE",
      optimizationGoal: "PURCHASE",
      action: { targetLevel: "campaign" },
    });
    expect(capNode.action).toMatchObject({
      label: "Apply cost cap",
      targetLevel: "adset",
      providerMutation: "apply_bid",
    });
    expect(capNode.bidConfiguration).toEqual({
      strategyType: "cost_cap",
      strategyLabel: "Cost cap",
      currentValue: 18,
      currentValueFormat: "currency",
      previousValue: 16,
      previousValueFormat: "currency",
      previousValueCapturedAt: "2026-07-09T11:00:00.000Z",
      dailyBudget: 100,
      lifetimeBudget: null,
      budgetUtilization: 0.72,
    });
  });

  it("keeps closed structure and Ad evidence in an advisory-only inactive envelope", () => {
    const inactiveAd = canonicalDecision({
      id: "inactive-ad",
      adId: "120000000000000099",
      buyerAction: "cut",
    });
    inactiveAd.deliveryScope = {
      state: "inactive",
      campaignStatus: "PAUSED",
      adsetStatus: "PAUSED",
      adStatus: "PAUSED",
      reason: "hierarchy_not_active",
      provenance: {
        source: "meta_entity_state_history",
        field: "status",
        recordId: "inactive-ad",
        asOf: "2026-07-10",
        version: null,
      },
    };
    const inactiveCreative = canonicalDecision({
      id: "inactive-creative",
      adId: null,
      buyerAction: "refresh",
    });
    inactiveCreative.deliveryScope = {
      state: "unknown",
      campaignStatus: "PAUSED",
      adsetStatus: null,
      adStatus: null,
      reason: "hierarchy_status_unknown",
      provenance: {
        source: "meta_entity_state_history",
        field: "status",
        recordId: "inactive-creative",
        asOf: "2026-07-10",
        version: null,
      },
    };
    const model = readModel([]);
    model.queue.inactiveAssets = {
      preCapCount: 2,
      inactiveCount: 1,
      unknownCount: 1,
      items: [inactiveAd, inactiveCreative],
    };

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      inactiveStructure: [
        {
          id: "cmp_paused",
          level: "campaign",
          name: "Paused campaign",
          campaignName: "Paused campaign",
          status: "PAUSED",
          statusLabel: "Paused",
          spend: 250,
          roas: 1.2,
          cpa: 50,
          purchases: 5,
          diagnosticNote: "Campaign is not active.",
          advisory: {
            decisionLabel: "keep",
            primaryActionLabel: "Review before reactivation",
            why: "Historical performance is retained for review.",
            confidence: "medium",
          },
        },
      ],
      decisionReadModel: model,
      currency: "EUR",
    });

    expect(result.structure.actCount).toBe(0);
    expect(result.ads.actCount).toBe(0);
    expect(result.inactive).toMatchObject({
      count: 3,
      inactiveCount: 2,
      unknownCount: 1,
    });
    expect(result.inactive?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "campaign",
          providerEntityId: "cmp_paused",
          providerWriteAuthority: "none",
        }),
        expect.objectContaining({
          level: "ad",
          providerEntityId: "120000000000000099",
          providerWriteAuthority: "none",
        }),
        expect.objectContaining({
          level: "creative",
          providerEntityId: "creative:inactive-creative",
          providerWriteAuthority: "none",
        }),
      ]),
    );
  });

  it("fails closed when a malformed upstream lane includes a non-active Structure recommendation", () => {
    const paused = recommendation({
      id: "paused-upstream-rec",
      level: "campaign",
      campaignId: "cmp_paused_upstream",
      campaignName: "Paused upstream campaign",
      entityConfiguration: {
        source: "account_scoped_campaign_row",
        budgetOwner: "campaign",
        budgetMode: "campaign_budget",
        controlOwner: "campaign",
        status: "PAUSED",
        optimizationGoal: "PURCHASE",
        bidStrategyType: "lowest_cost",
      },
    });
    const unknown = recommendation({
      id: "unknown-upstream-rec",
      level: "campaign",
      campaignId: "cmp_unknown_upstream",
      campaignName: "Unknown upstream campaign",
      entityConfiguration: undefined,
    });

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [paused, unknown],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currency: "EUR",
    });

    expect(result.structure.actCount).toBe(0);
    expect(result.structure.groups).toHaveLength(0);
  });

  it("maps winner verdicts to Ad-safe language and withholds ambiguous creative identities", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([
        canonicalDecision({
          id: "main-winner",
          adId: "120000000000000001",
          buyerAction: "scale",
          role: "main",
        }),
        canonicalDecision({
          id: "test-winner",
          adId: "120000000000000002",
          buyerAction: "scale",
          role: "test",
        }),
        canonicalDecision({
          id: "ambiguous-cut",
          adId: "120000000000000003",
          buyerAction: "cut",
          candidateAdCount: 2,
        }),
      ]),
      currency: "EUR",
    });

    expect(result.ads.items.map((item) => item.action.label)).toEqual([
      "Promote to Main",
      "Keep Running",
    ]);
    expect(
      result.ads.items.some((item) => /scale/i.test(item.action.label)),
    ).toBe(false);
    expect(result.ads.omittedAmbiguousIdentity).toBe(1);
    expect(result.ads.items[0]).toMatchObject({
      sourceSnapshotId: "test-winner:snapshot",
      action: { intent: "launchpad" },
    });
  });

  it("keeps Cut review-only until provider-write linkage is persisted", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([
        canonicalDecision({
          id: "exact-cut",
          adId: "120000000000000001",
          buyerAction: "cut",
        }),
      ]),
      currency: "EUR",
    });

    expect(result.ads.items[0]!.action).toMatchObject({
      label: "Cut",
      intent: "review",
      providerMutation: null,
      scopeNote: "Review only until exact native ad authority is available",
    });
  });

  it("withholds only hard Scale/Cut actions when current target authority is unavailable", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([
        canonicalDecision({
          id: "target-blocked-scale",
          adId: "120000000000000011",
          buyerAction: "scale",
          role: "test",
        }),
        canonicalDecision({
          id: "target-blocked-cut",
          adId: "120000000000000012",
          buyerAction: "cut",
        }),
        canonicalDecision({
          id: "target-independent-refresh",
          adId: "120000000000000013",
          buyerAction: "refresh",
        }),
      ]),
      currency: "EUR",
      targetHardActionEligibility: { scale: false, cut: false },
    });

    const scale = result.ads.items.find(
      (item) => item.decisionId === "target-blocked-scale",
    );
    const cut = result.ads.items.find(
      (item) => item.decisionId === "target-blocked-cut",
    );
    const refresh = result.ads.items.find(
      (item) => item.decisionId === "target-independent-refresh",
    );
    for (const item of [scale, cut]) {
      expect(item).toMatchObject({
        lane: "blocked",
        action: {
          code: "review_commercial_truth",
          label: "Review Commercial Truth",
          intent: "review",
          providerMutation: null,
        },
      });
    }
    expect(refresh).toMatchObject({
      lane: "act",
      action: { code: "refresh_creative", intent: "brief" },
    });
  });

  it("revalidates Scale and Cut against their own current ROAS anchors", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([
        canonicalDecision({
          id: "scale-without-current-target-roas",
          adId: "120000000000000021",
          buyerAction: "scale",
          role: "test",
        }),
        canonicalDecision({
          id: "cut-with-current-break-even-roas",
          adId: "120000000000000022",
          buyerAction: "cut",
        }),
      ]),
      currency: "EUR",
      targetHardActionEligibility: { scale: false, cut: true },
    });

    expect(
      result.ads.items.find(
        (item) => item.decisionId === "scale-without-current-target-roas",
      ),
    ).toMatchObject({
      lane: "blocked",
      action: { code: "review_commercial_truth", intent: "review" },
    });
    expect(
      result.ads.items.find(
        (item) => item.decisionId === "cut-with-current-break-even-roas",
      )?.action.code,
    ).not.toBe("review_commercial_truth");
  });

  it("enables an exact Ad pause only when native lineage authorizes the served Cut", () => {
    const exact = canonicalDecision({
      id: "native-cut",
      adId: "120000000000000099",
      buyerAction: "cut",
    });
    exact.identityGrain = "ad";
    exact.sourceAuthority = {
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      snapshotId: exact.sourceSnapshotId,
      evaluationId: "10000000-0000-4000-8000-000000000099",
      inputHash: "a".repeat(64),
      decisionHash: "b".repeat(64),
      providerAccountRefId: "30000000-0000-4000-8000-000000000001",
      engineVersion: "v3-ad-test",
      realAdId: "120000000000000099",
      authorizedAction: "cut",
      jobRunId: "20000000-0000-4000-8000-000000000001",
      executionReadiness: "live_preflight_required",
      decisionFreshness: {
        status: "fresh",
        computedAt: exact.sourceDecision.computedAt,
        ageHours: 1,
        maxAgeHours: 12,
      },
    };
    const model = readModel([exact]);
    model.source.authority = "native_ad";
    model.source.table = "engine_v3_ad_decision_snapshots_daily";
    model.source.fallbackReason = null;

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currentAdCampaignContexts: [
        {
          campaignId: "cmp_1",
          kind: "main",
          suggestedKind: "main",
          source: "system_inferred",
          confidenceClass: "high",
          sourceUpdatedAt: "2026-07-10T04:00:00.000Z",
          resolverVersion: "campaign-context-v2-account-scoped",
        },
      ],
      pipelineHealth: {
        overall: "healthy",
        executionReady: true,
        blockers: [],
      },
      currency: "EUR",
    });

    expect(result.ads.items[0]).toMatchObject({
      sourceGrain: "ad",
      creativeId: "creative:native-cut",
      action: {
        label: "Cut",
        intent: "execute",
        providerMutation: "pause",
        scopeNote: "Runs a live preflight, then pauses this exact ad only",
      },
    });
    expect(result.source.adsSource).toBe("native_ad_decision");
    expect(result.source).toMatchObject({
      health: "healthy",
      fallbackReason: null,
    });
    expect(result.limitations).toEqual([]);

    exact.sourceAuthority!.executionReadiness = "stale_decision";
    exact.sourceAuthority!.decisionFreshness = {
      status: "stale",
      computedAt: exact.sourceDecision.computedAt,
      ageHours: 13,
      maxAgeHours: 12,
    };
    const stale = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currency: "EUR",
    });
    expect(stale.ads.items[0]).toMatchObject({
      lane: "blocked",
      action: {
        code: "refresh_decision_data",
        label: "Refresh Decision",
        intent: "review",
        providerMutation: null,
      },
    });
  });

  it("exposes legacy fallback as degraded with the exact read-model reason", () => {
    const model = readModel([
      canonicalDecision({
        id: "legacy-review-only",
        adId: "120000000000000098",
        buyerAction: "cut",
      }),
    ]);
    model.source.fallbackReason = "native_schema_or_generation_read_failed";

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currency: "EUR",
    });

    expect(result.source).toMatchObject({
      adsSource: "legacy_creative_review_only",
      health: "degraded",
      fallbackReason: "native_schema_or_generation_read_failed",
    });
    expect(result.ads.items[0]!.action).toMatchObject({
      intent: "review",
      providerMutation: null,
    });
    expect(result.limitations).toContainEqual({
      code: "legacy_creative_review_only",
      message:
        "Legacy creative-grain decisions remain visible for continuity but cannot authorize Ad writes.",
    });
  });

  it("serves exact Ads from the independent candidate envelope even when section top-N omits them", () => {
    const model = readModel([
      canonicalDecision({
        id: "queue-visible-ambiguous",
        adId: "120000000000000010",
        buyerAction: "cut",
        candidateAdCount: 2,
      }),
    ]);
    const exact = canonicalDecision({
      id: "queue-hidden-exact",
      adId: "120000000000000011",
      buyerAction: "cut",
    });
    model.queue.adCandidates = {
      selectionVersion: "meta-decisions-ad-candidate-selection.v2",
      limit: 60,
      preCapCount: 2,
      eligiblePreCapCount: 1,
      selectedCount: 1,
      stateCounts: {
        act: { preCapCount: 1, selectedCount: 1 },
        blocked: { preCapCount: 0, selectedCount: 0 },
        monitor: { preCapCount: 0, selectedCount: 0 },
      },
      omittedAmbiguousIdentity: 1,
      omittedWithoutVerifiedAdId: 0,
      omittedNotApplicable: 0,
      items: [exact],
    };

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currency: "EUR",
    });

    expect(result.ads.items.map((item) => item.adId)).toEqual([
      "120000000000000011",
    ]);
    expect(result.ads.omittedAmbiguousIdentity).toBe(1);
  });

  it("keeps an existing test_more ad in Monitoring instead of inventing a new test", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([
        canonicalDecision({
          id: "test-more",
          adId: "120000000000000012",
          buyerAction: "test_more",
          role: "test",
        }),
      ]),
      currency: "EUR",
    });

    expect(result.ads.items[0]).toMatchObject({
      lane: "monitor",
      action: {
        code: "continue_test",
        label: "Continue Test",
        intent: "none",
      },
    });
  });

  it("keeps evidence-blocked rows out of Act Now and serves a concrete resolution", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([
        canonicalDecision({
          id: "blocked",
          adId: "120000000000000013",
          buyerAction: "diagnose_data",
        }),
      ]),
      currency: "EUR",
    });

    expect(result.ads).toMatchObject({
      actCount: 0,
      blockedCount: 1,
      monitorCount: 0,
    });
    expect(result.ads.items[0]).toMatchObject({
      lane: "blocked",
      assessment: "Decision Blocked",
      action: {
        code: "resolve_evidence_gap",
        label: "Resolve Evidence Gap",
        providerMutation: null,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /Cannot Assess|Investigate Data/,
    );
  });

  it("counts ACTIVE provider inventory as source health, never as a decision", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currentAds: [
        {
          providerAccountId: "act_1",
          adId: "120000000000000021",
          adName: "Live without native snapshot",
          campaignId: "cmp_1",
          adsetId: "adset_1",
          creativeId: "creative_21",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-13T09:00:00.000Z",
        },
        {
          providerAccountId: "act_1",
          adId: "120000000000000022",
          adName: "Closed",
          campaignId: "cmp_1",
          adsetId: "adset_1",
          creativeId: "creative_22",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-13T09:00:00.000Z",
        },
      ],
      currentAdCampaignContexts: [
        {
          campaignId: "cmp_1",
          kind: null,
          suggestedKind: "test",
          source: "system_inferred",
          confidenceClass: "unknown",
          sourceUpdatedAt: "2026-07-13T04:00:00.000Z",
          resolverVersion: "campaign-context-resolver.v1",
        },
      ],
      currency: "EUR",
    });

    /*
     * LAW: the decision lanes carry DECISIONS.
     *
     * An ACTIVE Ad that no producer has decided is real and must be stated, but
     * it is not a decision and an operator cannot act on it. It used to be
     * synthesised into `ads.items` as a `lane: "blocked"` placeholder with
     * every metric null, which made `blockedCount` a mixture of withheld
     * verdicts and un-evaluated inventory, and — on an account whose producer
     * had failed — filled the entire response cap with rows that say only that
     * nothing was decided.
     *
     * It is now one count and one sentence.
     */
    expect(result.ads.items).toHaveLength(0);
    expect(result.ads.blockedCount).toBe(0);
    expect(result.ads.statePreCapCounts.blocked).toBe(0);
    expect(result.ads.eligiblePreCapCount).toBe(0);

    // The PAUSED ad in `currentAds` above is not inventory awaiting a decision,
    // so the count is 1 and not 2.
    expect(result.ads.pendingInventoryCount).toBe(1);
    const limitation = result.limitations.find(
      (item) => item.code === "active_ad_inventory_pending_native_decision",
    );
    expect(limitation?.message).toContain("1 ACTIVE Ad has");
    expect(JSON.stringify(result)).not.toContain("label_needed");
    // The placeholder vocabulary must not reach the payload at all now, under
    // any key: it was the row, and the row is gone.
    expect(JSON.stringify(result)).not.toContain("await_ad_grain_evidence");
    expect(JSON.stringify(result)).not.toContain("pending_native_evidence");
  });

  it("selects canonical and pending Ads before the cap with stable 60, 120 and 300 prefixes", () => {
    const canonical = Array.from({ length: 320 }, (_, index) =>
      canonicalDecision({
        id: `canonical-act-${index + 1}`,
        adId: `120000${String(index + 1).padStart(12, "0")}`,
        buyerAction: "cut",
      }),
    );
    const pendingAd = {
      providerAccountId: "act_1",
      adId: "120000999999999999",
      adName: "Current Ad awaiting exact evidence",
      campaignId: "cmp_1",
      adsetId: "adset_1",
      creativeId: "creative_pending",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      providerUpdatedAt: null,
      fetchedAt: "2026-07-13T09:00:00.000Z",
    } as const;
    const modelAt = (limit: 60 | 120 | 300) => {
      const selected = canonical.slice(0, limit);
      const model = readModel(selected);
      model.queue.adCandidates = {
        selectionVersion: "meta-decisions-ad-candidate-selection.v2",
        limit,
        preCapCount: canonical.length,
        eligiblePreCapCount: canonical.length,
        selectedCount: selected.length,
        stateCounts: {
          act: { preCapCount: canonical.length, selectedCount: selected.length },
          blocked: { preCapCount: 0, selectedCount: 0 },
          monitor: { preCapCount: 0, selectedCount: 0 },
        },
        omittedAmbiguousIdentity: 0,
        omittedWithoutVerifiedAdId: 0,
        omittedNotApplicable: 0,
        items: selected,
      };
      return model;
    };

    const first = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: modelAt(60),
      currentAds: [pendingAd],
      currency: "EUR",
    });
    const expanded = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: modelAt(120),
      currentAds: [pendingAd],
      currency: "EUR",
    });
    const full = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: modelAt(300),
      currentAds: [pendingAd],
      currency: "EUR",
    });

    /*
     * THE CAP BELONGS TO THE DECISIONS.
     *
     * The pending Ad used to take one of the 60 slots, so the page carried 59
     * real verdicts instead of 60 and the counts described a mixed population.
     * Every slot now goes to a decision, at all three limits.
     */
    expect(first.ads.items).toHaveLength(60);
    expect(first.ads).toMatchObject({
      actCount: 60,
      blockedCount: 0,
      monitorCount: 0,
      statePreCapCounts: { act: 320, blocked: 0, monitor: 0 },
      eligiblePreCapCount: 320,
      pendingInventoryCount: 1,
    });
    expect(
      first.ads.items.some(
        (item) => item.decisionAvailability === "pending_native_evidence",
      ),
    ).toBe(false);
    expect(expanded.ads.items.slice(0, 60).map((item) => item.decisionId)).toEqual(
      first.ads.items.map((item) => item.decisionId),
    );
    expect(full.ads.items.slice(0, 120).map((item) => item.decisionId)).toEqual(
      expanded.ads.items.map((item) => item.decisionId),
    );
    expect(full.ads).toMatchObject({
      actCount: 300,
      blockedCount: 0,
      monitorCount: 0,
      statePreCapCounts: { act: 320, blocked: 0, monitor: 0 },
      eligiblePreCapCount: 320,
      pendingInventoryCount: 1,
    });
    /*
     * The sentence no longer depends on the cap. The population is summarised
     * rather than paginated, so "withheld by the response cap" would describe a
     * mechanism that no longer applies to it — and the count is the same at
     * every limit, which is the point.
     */
    for (const result of [first, expanded, full]) {
      expect(
        result.limitations.find(
          (item) => item.code === "active_ad_inventory_pending_native_decision",
        )?.message,
      ).toContain("1 ACTIVE Ad has no exact Ad-grain decision yet");
    }
  });

  it("keeps un-evaluated inventory out of a full page of real held verdicts", () => {
    const canonical = Array.from({ length: 60 }, (_, index) =>
      canonicalDecision({
        id: `canonical-blocked-${index + 1}`,
        adId: `120001${String(index + 1).padStart(12, "0")}`,
        buyerAction: "diagnose_data",
      }),
    );
    const model = readModel(canonical);
    model.queue.adCandidates = {
      selectionVersion: "meta-decisions-ad-candidate-selection.v2",
      limit: 60,
      preCapCount: canonical.length,
      eligiblePreCapCount: canonical.length,
      selectedCount: canonical.length,
      stateCounts: {
        act: { preCapCount: 0, selectedCount: 0 },
        blocked: {
          preCapCount: canonical.length,
          selectedCount: canonical.length,
        },
        monitor: { preCapCount: 0, selectedCount: 0 },
      },
      omittedAmbiguousIdentity: 0,
      omittedWithoutVerifiedAdId: 0,
      omittedNotApplicable: 0,
      items: canonical,
    };

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currentAds: [
        {
          providerAccountId: "act_1",
          adId: "120001999999999999",
          adName: "Pending row outside the cap",
          campaignId: "cmp_1",
          adsetId: "adset_1",
          creativeId: "creative_pending_withheld",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-13T09:00:00.000Z",
        },
      ],
      currency: "EUR",
    });

    expect(result.ads.items).toHaveLength(60);
    /*
     * `blocked` counts WITHHELD VERDICTS, and only those.
     *
     * All 60 canonical rows here are genuinely blocked decisions, so the lane
     * count is 60 and the pre-cap count is 60 too. It used to be 61 — the
     * un-evaluated Ad was added in, so the two numbers described different
     * populations and no reader could tell which one they were looking at.
     * The un-evaluated Ad is counted under its own name instead.
     */
    expect(result.ads.blockedCount).toBe(60);
    expect(result.ads.statePreCapCounts.blocked).toBe(60);
    expect(result.ads.pendingInventoryCount).toBe(1);
    expect(
      result.ads.items.some(
        (item) => item.decisionAvailability === "pending_native_evidence",
      ),
    ).toBe(false);
    const limitation = result.limitations.find(
      (item) => item.code === "active_ad_inventory_pending_native_decision",
    );
    expect(limitation?.message).toContain(
      "1 ACTIVE Ad has no exact Ad-grain decision yet",
    );
    // The cap is not the reason any more, so it must not be named as one.
    expect(limitation?.message).not.toContain("response cap");
    expect(limitation?.message).not.toContain("is visible");
  });

  it("serves a zero commercial target as the absence of a target", () => {
    /*
     * `truth_source = 'global_default'` PERSISTS A TARGET OF ZERO.
     *
     * Measured read-only against production on 2026-09-07: of the 11,438 rows
     * in `engine_v3_ad_decision_snapshots_daily`, 6,365 carry
     * `truth_source = 'global_default'` and EVERY ONE of them has
     * `effective_target_roas = 0` (min 0, max 0). The other three truth sources
     * have no zero at all.
     *
     * Zero is finite, so it passed every `Number.isFinite` guard on the way to
     * the surface, and the money line rendered "vs 0.00 target" beside a real
     * ROAS — a goal nobody set, printed as a goal that every ad on the account
     * clears. A ratio measured against it is arithmetic on a number that does
     * not mean anything, so it goes with it.
     */
    const zeroTarget = canonicalDecision({
      id: "global-default-target",
      adId: "120000000000000041",
      buyerAction: "protect",
    });
    zeroTarget.identityGrain = "ad";
    zeroTarget.sourceDecision.truthSource = "global_default";
    zeroTarget.metrics.effectiveTargetRoas = 0;
    zeroTarget.metrics.ratioToTarget = 0;

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([zeroTarget]),
      currency: "EUR",
    });

    const served = result.ads.items[0];
    expect(served?.adId).toBe("120000000000000041");
    expect(served?.metrics.effectiveTargetRoas).toBeNull();
    expect(served?.metrics.ratioToTarget).toBeNull();
    // The real ROAS is untouched: this is about the target, not the measurement.
    expect(served?.metrics.roas).toBe(2.4);
  });

  it("keeps a real commercial target and its ratio", () => {
    // The other side of the same rule, so the guard cannot be widened into
    // deleting targets that exist. `canonicalDecision` carries 1.8 / 1.33.
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([
        (() => {
          const decision = canonicalDecision({
            id: "real-target",
            adId: "120000000000000042",
            buyerAction: "protect",
          });
          decision.identityGrain = "ad";
          return decision;
        })(),
      ]),
      currency: "EUR",
    });

    expect(result.ads.items[0]?.metrics.effectiveTargetRoas).toBe(1.8);
    expect(result.ads.items[0]?.metrics.ratioToTarget).toBe(1.33);
  });

  it("does not decide an ACTIVE Ad the producer never reached", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currentAds: [
        {
          providerAccountId: "act_1",
          adId: "120000000000000031",
          adName: "New live Ad",
          campaignId: "cmp_new",
          campaignName: "R3 US Test",
          adsetId: "adset_new",
          creativeId: "creative_31",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          providerUpdatedAt: null,
          fetchedAt: "2026-07-13T09:00:00.000Z",
        },
      ],
      currentAdCampaignContexts: [],
      currency: "USD",
    });

    /*
     * An Ad with no campaign-context row and no decision snapshot yields no
     * decision — not a placeholder one, and above all not a labelled one.
     *
     * The campaign name is the only thing the payload knew about it, and it is
     * NOT served on a decision, because there is no decision to attach it to.
     * `presentedCampaignRole` — the resolver this case used to reach through
     * the placeholder — is still exercised by the structure-node cases in this
     * file, where it describes a campaign that was actually decided.
     */
    expect(result.ads.items).toHaveLength(0);
    expect(result.ads.pendingInventoryCount).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/label_needed|Label needed/i);
    // No inferred role escapes onto a row that has no verdict to qualify.
    expect(JSON.stringify(result.ads)).not.toContain("R3 US Test");
  });

  it("presents first-blocker provenance without authorizing a hard pre-authority verdict", () => {
    const decision = canonicalDecision({
      id: "authority-held",
      adId: "120000000000000088",
      buyerAction: "protect",
    });
    decision.identityGrain = "ad";
    decision.sourceDecision.label = "keep";
    decision.sourceDecision.rawLabel = "keep";
    decision.sourceDecision.preAuthorityLabel = "cut";
    decision.sourceDecision.authorityBlocker = "source_freshness";
    decision.classification.heldAction = "cut";
    decision.sourceAuthority = {
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      snapshotId: decision.sourceSnapshotId,
      evaluationId: "10000000-0000-4000-8000-000000000088",
      inputHash: "a".repeat(64),
      decisionHash: "b".repeat(64),
      providerAccountRefId: "30000000-0000-4000-8000-000000000001",
      engineVersion: "v3-ad-test",
      realAdId: "120000000000000088",
      authorizedAction: "cut",
      jobRunId: "20000000-0000-4000-8000-000000000001",
    };
    const model = readModel([decision]);
    model.source.authority = "native_ad";
    model.source.table = "engine_v3_ad_decision_snapshots_daily";
    model.source.fallbackReason = null;

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currency: "EUR",
    });

    expect(result.contractVersion).toBe("meta-os-decisions.presentation.v5");
    /*
      RE-PINNED. This asserted `code: "keep_running", intent: "none"` — the
      published `keep` label's own affirmative soft action, served for a row
      whose engine verdict was a withheld Cut. INVARIANTS.md forbids exactly
      that inheritance ("It must never inherit an affirmative soft label such
      as `Continue Test` from the published compatibility label"), and it is
      how a held Refresh reached the operator as "Keep Running". The row is
      now served in the blocked lane with the withheld verdict typed beside
      it. The provenance assertions below are unchanged.
    */
    expect(result.ads.items[0]).toMatchObject({
      lane: "blocked",
      heldAction: "cut",
      action: {
        code: "resolve_evidence_gap",
        intent: "review",
        providerMutation: null,
      },
      authorityProvenance: {
        availability: "available",
        preAuthorityLabel: "cut",
        postAuthorityRawLabel: "keep",
        publishedLabel: "keep",
        firstBlocker: {
          code: "source_freshness",
          label: "Source evidence is not fresh enough",
        },
      },
    });
    /*
      The held verdict does not become an authorization on the way out, and no
      resolution is invented for it: this payload's classification carries
      none, and a fabricated generic one would read as a measured answer.
    */
    expect(result.ads.items[0]!.heldResolution).toBeNull();
    expect(result.ads.items[0]!.action.providerMutation).toBeNull();
    expect(result.ads.items[0]!.action.intent).not.toBe("execute");
    expect(result.ads.heldCounts).toEqual({ scale: 0, cut: 1, refresh: 0 });
    // Counted separately: the row is in `blockedCount` exactly once.
    expect(result.ads.blockedCount).toBe(1);
    expect(result.ads.actCount + result.ads.monitorCount).toBe(0);
  });

  it("presents the D063 recent-evidence blocker without a provider mutation", () => {
    const decision = canonicalDecision({
      id: "recent-evidence-held",
      adId: "120000000000000098",
      buyerAction: "protect",
    });
    decision.identityGrain = "ad";
    decision.sourceDecision.label = "test_more";
    decision.sourceDecision.rawLabel = "test_more";
    decision.sourceDecision.preAuthorityLabel = "cut";
    decision.sourceDecision.authorityBlocker =
      "recent_recovery_unverifiable";
    decision.classification.heldAction = "cut";
    decision.classification.decisionState = "blocked";
    decision.classification.buyerAction = null;
    decision.classification.executionAction = null;
    decision.sourceAuthority = {
      status: "native_exact",
      actionEligible: false,
      reviewOnlyReason: "recent_recovery_unverifiable",
      snapshotId: decision.sourceSnapshotId,
      evaluationId: "10000000-0000-4000-8000-000000000098",
      inputHash: "a".repeat(64),
      decisionHash: "b".repeat(64),
      providerAccountRefId: "30000000-0000-4000-8000-000000000001",
      engineVersion: "v3-ad-test",
      realAdId: "120000000000000098",
      authorizedAction: null,
      jobRunId: "20000000-0000-4000-8000-000000000001",
    };
    const model = readModel([decision]);
    model.source.authority = "native_ad";
    model.source.table = "engine_v3_ad_decision_snapshots_daily";
    model.source.fallbackReason = null;

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: model,
      currency: "EUR",
    });

    expect(result.ads.items[0]).toMatchObject({
      action: { intent: "review", providerMutation: null },
      authorityProvenance: {
        preAuthorityLabel: "cut",
        postAuthorityRawLabel: "test_more",
        publishedLabel: "test_more",
        firstBlocker: {
          code: "recent_recovery_unverifiable",
          label: "Recent economic recovery cannot be ruled out",
        },
      },
    });
  });

  it("marks historical authority provenance unavailable instead of reconstructing it", () => {
    const decision = canonicalDecision({
      id: "historical",
      adId: "120000000000000089",
      buyerAction: "test_more",
    });
    decision.sourceDecision.preAuthorityLabel = null;
    decision.sourceDecision.authorityBlocker = null;

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([decision]),
      currency: "EUR",
    });

    expect(result.ads.items[0]?.authorityProvenance).toEqual({
      availability: "historical_unavailable",
      preAuthorityLabel: null,
      postAuthorityRawLabel: "test_more",
      publishedLabel: "test_more",
      firstBlocker: null,
    });
  });
});

/**
 * ITEM 5 — THE VERDICT THE ENGINE REACHED AND THEN WITHHELD.
 *
 * These drive the REAL semantics projector rather than hand-setting a
 * classification, because the defect lives in the seam between the two: the
 * projector already computed a held Refresh and its specific resolution, the
 * presentation read `heldAction` in exactly one place (`priorityForDecision`,
 * to rank the row) and then dropped it, and the row reached the operator
 * under its published compatibility label — `keep`, rendered "Keep Running" —
 * with no served evidence that a Refresh verdict existed at all.
 */
function heldCanonicalDecision(input: {
  id: string;
  adId: string;
  heldAction: "scale" | "cut" | "refresh";
  publishedLabel: string;
  authorityBlocker: MetaDecisionAuthorityBlocker;
  legacyBuyerAction: MetaDecisionBuyerAction;
  predicateBlockers?: ReadonlyArray<{
    predicate: string;
    observed: string | number | null;
    threshold: string | number | null;
  }>;
}): MetaCanonicalDecision {
  const decision = canonicalDecision({
    id: input.id,
    adId: input.adId,
    buyerAction: input.legacyBuyerAction,
  });
  const semantics = projectMetaDecisionSemantics({
    legacyBuyerAction: input.legacyBuyerAction,
    sourceLabel: input.publishedLabel,
    lifecycleRole: "main",
    badgeCodes: [],
    blockerCodes: [],
    heldAction: input.heldAction,
    authorityBlocker: input.authorityBlocker,
    predicateBlockers: input.predicateBlockers ?? [],
  });
  decision.identityGrain = "ad";
  decision.sourceDecision.label = input.publishedLabel;
  decision.sourceDecision.rawLabel = input.publishedLabel;
  decision.sourceDecision.preAuthorityLabel = input.heldAction;
  decision.sourceDecision.authorityBlocker = input.authorityBlocker;
  decision.classification.decisionState = semantics.decisionState;
  decision.classification.heldAction = semantics.heldAction;
  decision.classification.legacyBuyerAction = semantics.legacyBuyerAction;
  decision.classification.buyerAction = semantics.buyerAction;
  decision.classification.resolution = semantics.resolution;
  decision.classification.executionAction = null;
  // A fully authorized native exact identity, so nothing about the ad itself
  // is what withholds the action: only the held verdict is.
  decision.sourceAuthority = {
    status: "native_exact",
    actionEligible: true,
    reviewOnlyReason: null,
    snapshotId: decision.sourceSnapshotId,
    evaluationId: "10000000-0000-4000-8000-000000000501",
    inputHash: "a".repeat(64),
    decisionHash: "b".repeat(64),
    providerAccountRefId: "30000000-0000-4000-8000-000000000001",
    engineVersion: "v3-ad-test",
    realAdId: input.adId,
    authorizedAction: input.heldAction === "cut" ? "cut" : null,
    executionReadiness: "live_preflight_required",
    jobRunId: "20000000-0000-4000-8000-000000000001",
  };
  return decision;
}

function nativeReadModel(
  decisions: MetaCanonicalDecision[],
): MetaDecisionsWorkspaceReadModel {
  const model = readModel(decisions);
  model.source.authority = "native_ad";
  model.source.table = "engine_v3_ad_decision_snapshots_daily";
  model.source.fallbackReason = null;
  return model;
}

describe("held verdicts on the served Ad decision", () => {
  it("serves a held Refresh beside the published keep label, with its own resolution", () => {
    const decision = heldCanonicalDecision({
      id: "held-refresh",
      adId: "120000000000000501",
      heldAction: "refresh",
      publishedLabel: "keep",
      authorityBlocker: "native_metrics_unavailable",
      legacyBuyerAction: "refresh",
      predicateBlockers: [
        {
          predicate: "refresh_ad_lifecycle_evidence",
          observed: null,
          threshold: null,
        },
      ],
    });

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: nativeReadModel([decision]),
      currency: "EUR",
    });

    const item = result.ads.items[0]!;
    // The PUBLISHED label is untouched. The held verdict is served alongside.
    expect(item.publishedLabel).toBe("keep");
    expect(item.heldAction).toBe("refresh");
    /*
      The resolution belonging to the HELD verdict, not the published row's
      generic one. `resolutionForAuthorityBlocker` in
      lib/meta/decision-semantics.ts produces this exact sentence for a Refresh
      held on missing ad-level fatigue evidence; the generic answers it beats
      are "Refresh Decision Data" (the same blocker without the predicate) and
      `adAction`'s own "Resolve Evidence Gap" fallback.
    */
    expect(item.heldResolution).toEqual({
      code: "complete_hard_action_evidence",
      category: "system",
      owner: "system",
      label: "Refresh Held — Ad Fatigue Evidence Missing",
      nextStep:
        "The recent window decayed against this ad's own earlier period, but no ad-level fatigue verdict exists to confirm creative wear, so no provider action is authorized yet. The verdict resolves as sibling-ad exposure evidence accumulates.",
    });
    expect(item.heldResolution?.code).not.toBe("resolve_evidence_gap");
    expect(item.heldResolution?.label).not.toBe("Refresh Decision Data");
    // The engine's own reason for the row survives too.
    expect(item.whyNow).toBe(decision.sourceDecision.reason);

    // EVERY execution field is null on a held row.
    expect(item.action.providerMutation).toBeNull();
    expect(item.action.intent).not.toBe("execute");
    expect(item.action.budgetIntent).toBeUndefined();
    expect(item.action.bidIntent).toBeUndefined();
    expect(item.lane).toBe("blocked");
    expect(item.action.code).not.toBe("keep_running");

    // Counted separately from the lane counts, never added to them.
    expect(result.ads.heldCounts).toEqual({ scale: 0, cut: 0, refresh: 1 });
    expect(result.ads.blockedCount).toBe(1);
    expect(result.ads.actCount).toBe(0);
    expect(result.ads.monitorCount).toBe(0);
  });

  it("counts each held verdict separately and leaves the lane counts alone", () => {
    const decisions = [
      heldCanonicalDecision({
        id: "held-refresh-2",
        adId: "120000000000000502",
        heldAction: "refresh",
        publishedLabel: "keep",
        authorityBlocker: "source_freshness",
        legacyBuyerAction: "refresh",
      }),
      heldCanonicalDecision({
        id: "held-cut-2",
        adId: "120000000000000503",
        heldAction: "cut",
        publishedLabel: "test_more",
        authorityBlocker: "source_freshness",
        legacyBuyerAction: "cut",
      }),
      heldCanonicalDecision({
        id: "held-scale-2",
        adId: "120000000000000504",
        heldAction: "scale",
        publishedLabel: "keep",
        authorityBlocker: "profile_hard_action_ineligible",
        legacyBuyerAction: "scale",
      }),
    ];

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: nativeReadModel(decisions),
      currency: "EUR",
    });

    expect(result.ads.heldCounts).toEqual({ scale: 1, cut: 1, refresh: 1 });
    // All three sit in `blockedCount` exactly once. The held tally is a second,
    // orthogonal reading of the same rows, not a fourth lane.
    expect(result.ads.blockedCount).toBe(3);
    expect(
      result.ads.actCount +
        result.ads.blockedCount +
        result.ads.monitorCount,
    ).toBe(result.ads.items.length);
    for (const item of result.ads.items) {
      expect(item.action.providerMutation).toBeNull();
      expect(item.action.intent).not.toBe("execute");
      expect(item.heldResolution).not.toBeNull();
    }
  });

  it("refuses a provider mutation for a held verdict a payload claims is actionable", () => {
    /*
      A CONTRACT-INVALID payload, deliberately.

      INVARIANTS.md pairs a non-null held verdict with `decisionState: blocked`
      and `buyerAction: null`, and `projectMetaDecisionSemantics` produces only
      that pairing. A stored or hand-built payload that claims otherwise used
      to be read through `buyerAction` alone: a held Cut beside
      `decisionState: "act"` and a native exact authority fell through to the
      Cut branch and was served with `intent: "execute"` and
      `providerMutation: "pause"` — a provider write originating from a verdict
      the engine had explicitly withheld.
    */
    const decision = heldCanonicalDecision({
      id: "held-cut-claiming-act",
      adId: "120000000000000505",
      heldAction: "cut",
      publishedLabel: "keep",
      authorityBlocker: "source_freshness",
      legacyBuyerAction: "cut",
    });
    decision.classification.decisionState = "act";
    decision.classification.buyerAction = "cut";

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: nativeReadModel([decision]),
      currency: "EUR",
    });

    const item = result.ads.items[0]!;
    expect(item.action.providerMutation).toBeNull();
    expect(item.action.intent).not.toBe("execute");
    expect(item.lane).toBe("blocked");
    expect(item.heldAction).toBe("cut");
    expect(result.ads.heldCounts).toEqual({ scale: 0, cut: 1, refresh: 0 });
  });

  it("still authorizes a Cut that was never held", () => {
    /*
      The guard against over-correcting. Withholding execution for a HELD
      verdict must not withhold it for every Cut: a decision with no held
      verdict and a native exact authorization keeps its provider mutation.
    */
    const decision = canonicalDecision({
      id: "authorized-cut",
      adId: "120000000000000506",
      buyerAction: "cut",
    });
    decision.identityGrain = "ad";
    decision.sourceAuthority = {
      status: "native_exact",
      actionEligible: true,
      reviewOnlyReason: null,
      snapshotId: decision.sourceSnapshotId,
      evaluationId: "10000000-0000-4000-8000-000000000506",
      inputHash: "a".repeat(64),
      decisionHash: "b".repeat(64),
      providerAccountRefId: "30000000-0000-4000-8000-000000000001",
      engineVersion: "v3-ad-test",
      realAdId: "120000000000000506",
      authorizedAction: "cut",
      executionReadiness: "live_preflight_required",
      jobRunId: "20000000-0000-4000-8000-000000000001",
    };

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: nativeReadModel([decision]),
      currency: "EUR",
    });

    const item = result.ads.items[0]!;
    expect(item.heldAction).toBeNull();
    expect(item.heldResolution).toBeNull();
    expect(item.lane).toBe("act");
    expect(item.action).toMatchObject({
      code: "cut",
      intent: "execute",
      providerMutation: "pause",
    });
    expect(result.ads.heldCounts).toEqual({ scale: 0, cut: 0, refresh: 0 });
  });

  it("keeps a payload serialized before the held fields readable", () => {
    const decision = heldCanonicalDecision({
      id: "held-refresh-legacy",
      adId: "120000000000000507",
      heldAction: "refresh",
      publishedLabel: "keep",
      authorityBlocker: "source_freshness",
      legacyBuyerAction: "refresh",
    });
    const built = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: nativeReadModel([decision]),
      currency: "EUR",
    });

    // What the current builder emits...
    expect(built.ads.heldCounts).toEqual({ scale: 0, cut: 0, refresh: 1 });
    expect(built.ads.items[0]!.heldAction).toBe("refresh");

    // ...and the same payload as it was serialized before these fields existed.
    const serializedBeforeTheseFields = JSON.parse(
      JSON.stringify(built),
    ) as MetaOsDecisionsPresentation;
    delete serializedBeforeTheseFields.ads.heldCounts;
    for (const item of serializedBeforeTheseFields.ads.items) {
      delete item.heldAction;
      delete item.heldResolution;
    }

    // Still a valid presentation: the fields are optional, and their ABSENCE
    // reads as "not measured", which a reader must not confuse with three
    // measured zeroes or with a measured "no verdict was held".
    expect(serializedBeforeTheseFields.contractVersion).toBe(
      "meta-os-decisions.presentation.v5",
    );
    expect(serializedBeforeTheseFields.ads.heldCounts).toBeUndefined();
    expect(serializedBeforeTheseFields.ads.items[0]!.heldAction).toBeUndefined();
    expect(
      serializedBeforeTheseFields.ads.items[0]!.heldResolution,
    ).toBeUndefined();
    expect(serializedBeforeTheseFields.ads.blockedCount).toBe(1);
    expect(serializedBeforeTheseFields.ads.items[0]!.publishedLabel).toBe(
      "keep",
    );
  });
});

/**
 * ITEM 6 — A STRUCTURE ACTION MUST NOT BE DECIDED BY ITS OWN COPY.
 *
 * `structureAction` used to test English against the producer's operator copy
 * to choose the served label AND the served `intent`:
 *
 *     (decisionLabel === "scale" && !/^(increase|reduce)\b.*\bbudget\b/i…) ||
 *       /\bscale\b/i.test(label)
 *     … else if (/review structure\s*&\s*scale/i.test(label))
 *     … if (/budget/i.test(label) && providerMutation === null) intent = "manual"
 *
 * `intent` is authority-bearing — `launchModeForServedStructureAction` in
 * components/meta/redesign/MetaPlatformPage.tsx opens Launchpad only for
 * `intent === "launchpad"` — so a copy edit could move a row between
 * authorities, and word order made the "Review Structure" branch unreachable.
 *
 * Each case below is the SAME typed input under four different copies. The
 * shipped one, an English rewrite, a Turkish translation, and none at all.
 */
const STRUCTURE_COPY_PERMUTATIONS = [
  { name: "shipped copy", copy: "Review scale plan" },
  { name: "English rewrite", copy: "Push the daily spend up a notch" },
  { name: "Turkish translation", copy: "Bütçeyi kontrollü biçimde artırın" },
  { name: "no copy at all", copy: "" },
] as const;

function structureActionUnderCopy(input: {
  copy: string;
  rec: Partial<MetaRecommendation>;
  eligibility?: { scale: boolean; cut: boolean };
}) {
  const result = buildMetaOsDecisionsPresentation({
    actionNow: [
      recommendation({
        id: "rec_copy_permutation",
        level: "campaign",
        campaignId: "cmp_copy_permutation",
        campaignName: "Copy permutations",
        primaryActionLabel: input.copy,
        recommendedAction: input.copy,
        decision: input.copy,
        ...input.rec,
      }),
    ],
    watching: [],
    nonSales: [],
    decisionReadModel: readModel([]),
    currency: "EUR",
    targetHardActionEligibility: input.eligibility ?? { scale: true, cut: true },
  });
  return result.structure.groups[0]!.campaign.action;
}

describe("structure actions are decided by typed fields, not by their copy", () => {
  const cases = [
    {
      shape: "commercial truth withheld",
      rec: { decisionLabel: "scale" as const },
      eligibility: { scale: false, cut: true },
      expected: {
        code: "review_commercial_truth",
        label: "Review Commercial Truth",
        intent: "review",
        targetLevel: "campaign",
        providerMutation: null,
        scopeNote:
          "Current target ROAS authority is unavailable; no Scale action is authorized",
      },
    },
    {
      shape: "decision inputs missing",
      rec: { decisionLabel: "diagnose" as const },
      expected: {
        code: "resolve_decision_inputs",
        label: "Resolve Decision Inputs",
        intent: "review",
        targetLevel: "campaign",
        providerMutation: null,
        scopeNote:
          "Complete the missing server evidence before changing provider state",
      },
    },
    {
      shape: "budget review on a Main campaign",
      rec: {
        decisionLabel: "scale" as const,
        campaignKind: "main" as const,
        actionKind: "review_drill" as const,
      },
      expected: {
        code: "review_drill",
        label: "Review Campaign Budget",
        intent: "manual",
        targetLevel: "campaign",
        providerMutation: null,
        scopeNote: "Affects this campaign only",
      },
    },
    {
      shape: "structure review on a Mixed campaign",
      rec: {
        decisionLabel: "scale" as const,
        campaignKind: "mixed" as const,
        actionKind: "review_drill" as const,
      },
      expected: {
        code: "review_drill",
        // D016: a Mixed campaign reviews its structure BEFORE any execution
        // instruction. The predecessor served "Review Campaign Budget" here,
        // because `/\bscale\b/i` matched first and made this branch dead.
        label: "Review Structure",
        intent: "manual",
        targetLevel: "campaign",
        providerMutation: null,
        scopeNote: "Affects this campaign only",
      },
    },
    {
      shape: "pause on a row that carries a pause control",
      rec: {
        decisionLabel: "cut" as const,
        actionKind: "execute_pause" as const,
      },
      expected: {
        code: "execute_pause",
        label: "Pause Campaign",
        intent: "review",
        targetLevel: "campaign",
        providerMutation: "pause",
        scopeNote: "Affects this campaign only",
      },
    },
  ];

  it("serves one identical action per typed shape across every copy", () => {
    for (const testCase of cases) {
      for (const permutation of STRUCTURE_COPY_PERMUTATIONS) {
        const action = structureActionUnderCopy({
          copy: permutation.copy,
          rec: testCase.rec,
          eligibility: testCase.eligibility,
        });
        expect(
          { shape: testCase.shape, permutation: permutation.name, ...action },
          `${testCase.shape} under ${permutation.name}`,
        ).toEqual({
          shape: testCase.shape,
          permutation: permutation.name,
          ...testCase.expected,
        });
      }
    }
  });

  it("still shows the producer's own copy where no typed shape names the action", () => {
    /*
      The guard against over-correcting.

      Removing the regexes must not flatten every structure row to a typed
      constant: a row whose typed fields name no specific shape still DISPLAYS
      the producer's operator copy. What changed is that the copy no longer
      DECIDES anything — the code, the intent, the authority and the target
      level are identical across all four permutations.
    */
    const rec = {
      decisionLabel: "keep" as const,
      actionKind: "review_drill" as const,
    };
    const served = STRUCTURE_COPY_PERMUTATIONS.map((permutation) =>
      structureActionUnderCopy({ copy: permutation.copy, rec }),
    );

    expect(served.map((action) => action.label)).toEqual([
      "Review scale plan",
      "Push the daily spend up a notch",
      "Bütçeyi kontrollü biçimde artırın",
      // The only typed fallback: the producer supplied no copy at all.
      "Review",
    ]);
    for (const action of served) {
      expect(action.code).toBe("review_drill");
      expect(action.intent).toBe("review");
      expect(action.providerMutation).toBeNull();
      expect(action.targetLevel).toBe("campaign");
    }
  });

  it("does not turn a Launchpad route into a manual budget review", () => {
    /*
      `intent` is authority. A `route_launchpad_duplicate` row whose copy
      happens to contain the word "budget" used to be downgraded to `manual`
      by `/budget/i.test(label)`, which is `launchModeForServedStructureAction`
      refusing to open Launchpad because of a word in a sentence.
    */
    const served = STRUCTURE_COPY_PERMUTATIONS.map((permutation) =>
      structureActionUnderCopy({
        copy: permutation.copy,
        rec: {
          decisionLabel: "swap",
          actionKind: "route_launchpad_duplicate",
        },
      }),
    );
    for (const action of served) {
      expect(action.intent).toBe("launchpad");
      expect(action.code).toBe("route_launchpad_duplicate");
    }
    expect(
      structureActionUnderCopy({
        copy: "Duplicate the winner and give it its own budget",
        rec: {
          decisionLabel: "swap",
          actionKind: "route_launchpad_duplicate",
        },
      }).intent,
    ).toBe("launchpad");
  });
});
