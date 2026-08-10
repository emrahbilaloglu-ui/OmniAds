import { describe, expect, it } from "vitest";
import type {
  MetaCanonicalDecision,
  MetaDecisionBuyerAction,
  MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import {
  buildMetaOsDecisionsPresentation,
  revalidateMetaStructureLanesForCurrentTargets,
} from "@/lib/meta/decisions-os-presentation";
import { metaLanePayload } from "@/components/meta/redesign/test-fixtures";

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

  it("preserves a saved campaign-role override in Structure provenance", () => {
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
          source: "persisted_label",
          confidenceClass: "high",
          sourceUpdatedAt: "2026-07-13T04:00:00.000Z",
          resolverVersion: "campaign-context-resolver.v1",
        },
      ],
      currency: "EUR",
    });

    expect(result.structure.groups[0]!.campaign).toMatchObject({
      lifecycleRole: "main",
      campaignRoleSource: "user_override",
      campaignRoleConfidence: "high",
      campaignRoleTrustedForAction: true,
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
      currency: "EUR",
    });

    expect(result.ads.items[0]).toMatchObject({
      sourceGrain: "ad",
      creativeId: "creative:native-cut",
      action: {
        label: "Cut",
        intent: "execute",
        providerMutation: "pause",
        scopeNote: "Pauses this exact ad only",
      },
    });
    expect(result.source.adsSource).toBe("native_ad_decision");
    expect(result.source).toMatchObject({
      health: "healthy",
      fallbackReason: null,
    });
    expect(result.limitations).toEqual([]);
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

  it("shows current ACTIVE provider inventory instead of an empty Ads layer", () => {
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

    expect(result.ads.items).toHaveLength(1);
    expect(result.ads.items[0]).toMatchObject({
      adId: "120000000000000021",
      lane: "blocked",
      decisionAvailability: "pending_native_evidence",
      lifecycleRole: "test",
      campaignRoleSource: "automatic",
      campaignRoleConfidence: "unknown",
      campaignRoleTrustedForAction: false,
      action: {
        code: "await_ad_grain_evidence",
        intent: "review",
        providerMutation: null,
      },
    });
    expect(result.ads.blockedCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("label_needed");
    expect(result.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "active_ad_inventory_pending_native_decision",
        }),
      ]),
    );
  });

  it("auto-assigns a non-authoritative role when the daily context row is missing", () => {
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

    expect(result.ads.items[0]).toMatchObject({
      campaignName: "R3 US Test",
      lifecycleRole: "test",
      campaignRoleSource: "automatic",
      campaignRoleConfidence: "unknown",
      campaignRoleTrustedForAction: false,
      decisionAvailability: "pending_native_evidence",
      action: { providerMutation: null },
    });
    expect(JSON.stringify(result)).not.toMatch(/label_needed|Label needed/i);
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

    expect(result.contractVersion).toBe("meta-os-decisions.presentation.v4");
    expect(result.ads.items[0]).toMatchObject({
      action: {
        code: "keep_running",
        intent: "none",
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
