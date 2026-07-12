import { describe, expect, it } from "vitest";
import type {
  MetaCanonicalDecision,
  MetaDecisionBuyerAction,
  MetaDecisionsWorkspaceReadModel,
} from "@/lib/meta/decisions-workspace-contract";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { buildMetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-presentation";

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
    timeframeContext:
      input.timeframeContext ?? {
        coreVerdict: "Review",
        selectedRangeOverlay: "Current range",
        historicalSupport: "Unavailable",
        seasonalityFlag: "none",
        note: null,
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
      overlayVersion: "meta-decisions-classification-overlay.v2",
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

function readModel(items: MetaCanonicalDecision[]): MetaDecisionsWorkspaceReadModel {
  const emptySection = (key: "integrity_fires" | "money_moves" | "creative_rotation") => ({
    key,
    label: key,
    topN: 5,
    preCapCount: key === "creative_rotation" ? items.length : 0,
    selectedCount: key === "creative_rotation" ? items.length : 0,
    rankablePreCapCount: key === "creative_rotation" ? items.length : 0,
    unrankablePreCapCount: 0,
    items: key === "creative_rotation" ? items : [],
    exposureDigest: { basis: "pre_cap" as const, byCurrency: [], unavailableCount: 0, crossCurrencyTotal: null },
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
    contractVersion: "meta-decisions-workspace.read.v1",
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
      table: "engine_v3_decision_snapshots_daily",
      snapshotAsOf: "2026-07-10",
      computedAt: "2026-07-10T04:00:00.000Z",
      engineVersion: "v3-test",
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
      currency: "EUR",
    });

    expect(result.structure.groups).toHaveLength(1);
    expect(result.structure.groups[0]!.campaign.action.label).toBe("Review Campaign Budget");
    expect(result.structure.groups[0]!.campaign.action.label).not.toMatch(/scale/i);
    expect(result.structure.groups[0]!.campaign.suppressedAlternativeCount).toBe(1);
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
      },
    });

    const result = buildMetaOsDecisionsPresentation({
      actionNow: [cboAdset, costCapCampaign],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([]),
      currency: "EUR",
    });
    const cboNode = result.structure.groups
      .find((group) => group.campaign.campaignId === "cmp_cbo")!
      .adsets[0]!;
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
      targetLevel: "adset",
      providerMutation: "apply_bid",
    });
  });

  it("maps winner verdicts to Ad-safe language and withholds ambiguous creative identities", () => {
    const result = buildMetaOsDecisionsPresentation({
      actionNow: [],
      watching: [],
      nonSales: [],
      decisionReadModel: readModel([
        canonicalDecision({ id: "main-winner", adId: "120000000000000001", buyerAction: "scale", role: "main" }),
        canonicalDecision({ id: "test-winner", adId: "120000000000000002", buyerAction: "scale", role: "test" }),
        canonicalDecision({ id: "ambiguous-cut", adId: "120000000000000003", buyerAction: "cut", candidateAdCount: 2 }),
      ]),
      currency: "EUR",
    });

    expect(result.ads.items.map((item) => item.action.label)).toEqual([
      "Promote to Main",
      "Keep Running",
    ]);
    expect(result.ads.items.some((item) => /scale/i.test(item.action.label))).toBe(false);
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
        canonicalDecision({ id: "exact-cut", adId: "120000000000000001", buyerAction: "cut" }),
      ]),
      currency: "EUR",
    });

    expect(result.ads.items[0]!.action).toMatchObject({
      label: "Cut",
      intent: "review",
      providerMutation: null,
      scopeNote: "Pauses this ad only",
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

    expect(result.ads.items.map((item) => item.adId)).toEqual(["120000000000000011"]);
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
    expect(JSON.stringify(result)).not.toMatch(/Cannot Assess|Investigate Data/);
  });
});
