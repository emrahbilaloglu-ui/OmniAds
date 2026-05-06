import { describe, expect, it } from "vitest";
import {
  buildMetaCampaignOperatorLookup,
  buildMetaOperatorSurfaceModel,
} from "@/lib/meta/operator-surface";

function metaDecisionOsFixture() {
  return {
    authority: {
      missingInputs: ["target_pack"],
      note: "Meta decisions remain available, but truth caps still matter.",
    },
    commercialTruthCoverage: {
      missingInputs: ["target_pack"],
      summary: null,
    },
    summary: {
      todayPlanHeadline: "Today plan",
    },
    campaigns: [
      {
        campaignId: "cmp_scale",
        campaignName: "Scale Campaign",
        role: "Prospecting Scale",
        primaryAction: "scale_budget",
        confidence: 0.82,
        why: "Campaign-level wrapper.",
        evidence: [{ label: "ROAS", value: "2.80x" }],
        guardrails: ["Keep winners stable."],
        noTouch: false,
        whatWouldChangeThisDecision: ["Something changes."],
        laneLabel: "Scaling",
        missingCreativeAsk: [],
        trust: {
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          evidence: { materiality: "material" },
        },
        policy: {
          bidRegime: "open",
          objectiveFamily: "sales",
        },
      },
      {
        campaignId: "cmp_hold",
        campaignName: "Hold Campaign",
        role: "Prospecting Validation",
        primaryAction: "hold",
        confidence: 0.74,
        why: "Thin-signal wrapper.",
        evidence: [{ label: "ROAS", value: "1.90x" }],
        guardrails: ["Wait for more signal."],
        noTouch: false,
        whatWouldChangeThisDecision: ["More spend."],
        laneLabel: "Validation",
        missingCreativeAsk: [],
        trust: {
          surfaceLane: "watchlist",
          truthState: "live_confident",
          operatorDisposition: "review_hold",
          evidence: { materiality: "thin_signal" },
        },
        policy: {
          bidRegime: "cost_cap",
          objectiveFamily: "sales",
        },
      },
    ],
    adSets: [
      {
        decisionId: "adset_scale",
        adSetId: "adset_1",
        adSetName: "Scale Ad Set",
        campaignId: "cmp_scale",
        campaignName: "Scale Campaign",
        actionType: "scale_budget",
        confidence: 0.86,
        reasons: ["Winning ad set."],
        guardrails: ["Increase budget carefully."],
        noTouch: false,
        missingCreativeAsk: [],
        trust: {
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          evidence: { materiality: "material" },
        },
        policy: {
          bidRegime: "open",
          objectiveFamily: "sales",
        },
        supportingMetrics: {
          spend: 420,
          roas: 3.1,
          purchases: 14,
          cpa: 24,
          dailyBudget: 15000,
        },
      },
      {
        decisionId: "adset_truth",
        adSetId: "adset_2",
        adSetName: "Truth-Capped Ad Set",
        campaignId: "cmp_truth",
        campaignName: "Truth Campaign",
        actionType: "scale_budget",
        confidence: 0.78,
        reasons: ["Winner is constrained."],
        guardrails: ["Truth is missing."],
        noTouch: false,
        missingCreativeAsk: [],
        trust: {
          surfaceLane: "watchlist",
          truthState: "degraded_missing_truth",
          operatorDisposition: "profitable_truth_capped",
          reasons: ["Commercial truth is incomplete."],
          evidence: {
            materiality: "material",
            aggressiveActionBlockReasons: ["Commercial truth is incomplete."],
          },
        },
        policy: {
          bidRegime: "cost_cap",
          objectiveFamily: "sales",
        },
        supportingMetrics: {
          spend: 310,
          roas: 2.9,
          purchases: 9,
          cpa: 28,
          dailyBudget: 12000,
        },
      },
      {
        decisionId: "adset_thin",
        adSetId: "adset_3",
        adSetName: "Thin Ad Set",
        campaignId: "cmp_hold",
        campaignName: "Hold Campaign",
        actionType: "monitor_only",
        confidence: 0.58,
        reasons: ["Low-signal lane."],
        guardrails: ["Wait for more signal."],
        noTouch: false,
        missingCreativeAsk: [],
        trust: {
          surfaceLane: "watchlist",
          truthState: "live_confident",
          operatorDisposition: "review_hold",
          evidence: { materiality: "thin_signal" },
        },
        policy: {
          bidRegime: "cost_cap",
          objectiveFamily: "sales",
        },
        supportingMetrics: {
          spend: 55,
          roas: 1.7,
          purchases: 1,
          cpa: 40,
          dailyBudget: 5000,
        },
      },
    ],
  } as any;
}

describe("buildMetaOperatorSurfaceModel", () => {
  it("uses one visible action owner per campaign and surfaces truth-capped rows explicitly", () => {
    const model = buildMetaOperatorSurfaceModel(metaDecisionOsFixture());
    expect(model).not.toBeNull();

    const actNow = model?.buckets.find((bucket) => bucket.key === "act_now");
    const needsTruth = model?.buckets.find((bucket) => bucket.key === "needs_truth");

    expect(actNow?.rows.map((row) => row.id)).toContain("adset:adset_scale");
    expect(actNow?.rows.map((row) => row.id)).not.toContain("campaign:cmp_scale");
    expect(needsTruth?.rows[0]).toMatchObject({
      id: "adset:adset_truth",
      primaryAction: "Needs truth",
      authorityState: "needs_truth",
    });
    expect(model?.hiddenSummary).toContain("thin-signal");
  });

  it("maps capped bid-regime review into operator wording instead of generic bid edits", () => {
    const fixture = metaDecisionOsFixture();
    fixture.adSets.push({
      decisionId: "adset_cap",
      adSetId: "adset_cap",
      adSetName: "Cap Review Ad Set",
      campaignId: "cmp_cap",
      campaignName: "Cap Review Campaign",
      actionType: "tighten_bid",
      confidence: 0.72,
      reasons: ["Cap is the first lever."],
      guardrails: ["Review the guardrail before budget changes."],
      noTouch: false,
      missingCreativeAsk: [],
      trust: {
        surfaceLane: "action_core",
        truthState: "live_confident",
        operatorDisposition: "standard",
        evidence: { materiality: "material" },
      },
      policy: {
        bidRegime: "cost_cap",
        objectiveFamily: "sales",
        primaryDriver: "bid_regime_pressure",
      },
      supportingMetrics: {
        spend: 180,
        roas: 2.1,
        purchases: 5,
        cpa: 36,
        dailyBudget: 9000,
      },
    });

    const model = buildMetaOperatorSurfaceModel(fixture);
    const actNow = model?.buckets.find((bucket) => bucket.key === "act_now");

    expect(actNow?.rows.map((row) => row.primaryAction)).toContain("Review cost cap");
  });

  it("adds instructions that make blocked budget actions explicit", () => {
    const fixture = metaDecisionOsFixture();
    fixture.adSets[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      state: "blocked",
      actionClass: "scale",
      pushReadiness: "blocked_from_push",
      queueEligible: false,
      canApply: false,
      reasons: ["Budget is not binding."],
      blockers: ["Budget is not the binding constraint."],
      missingEvidence: ["budget_binding_evidence"],
      requiredEvidence: ["budget_binding_evidence"],
      explanation: "Budget is not the binding constraint.",
    };

    const model = buildMetaOperatorSurfaceModel(fixture);
    const row = model?.buckets
      .flatMap((bucket) => bucket.rows)
      .find((item) => item.id === "adset:adset_scale");

    expect(row?.instruction?.operatorVerb).toBe("Do not act");
    expect(row?.instruction?.primaryMove).toContain("Do not act");
    expect(row?.instruction?.pushReadiness).toBe("blocked_from_push");
  });

  it("adds bounded budget guidance only when current daily budget is available", () => {
    const fixture = metaDecisionOsFixture();
    fixture.adSets[0].operatorPolicy = {
      contractVersion: "operator-policy.v1",
      state: "do_now",
      actionClass: "scale",
      pushReadiness: "safe_to_queue",
      queueEligible: true,
      canApply: false,
      reasons: ["Budget scale is approved for operator review."],
      blockers: [],
      missingEvidence: [],
      requiredEvidence: ["row_provenance", "commercial_truth"],
      explanation: "Budget scale is approved for operator review.",
    };

    const model = buildMetaOperatorSurfaceModel(fixture);
    const row = model?.buckets
      .flatMap((bucket) => bucket.rows)
      .find((item) => item.id === "adset:adset_scale");

    expect(row?.instruction?.amountGuidance.status).toBe("bounded_estimate");
    expect(row?.instruction?.amountGuidance.label).toContain("+10-20% budget band");
    expect(row?.instruction?.amountGuidance.label).toContain("$165-$180/day");
    expect(row?.instruction?.amountGuidance.assumptions?.join(" ")).toContain(
      "does not override policy",
    );
  });

  it("builds a campaign drilldown lookup from the highest-priority visible action owner", () => {
    const lookup = buildMetaCampaignOperatorLookup(metaDecisionOsFixture());
    const scaleSummary = lookup.get("cmp_scale");
    const truthSummary = lookup.get("cmp_truth");

    expect(scaleSummary).toMatchObject({
      ownerType: "ad_set",
      ownerLabel: "Scale Ad Set",
    });
    expect(scaleSummary?.item.primaryAction).toBe("Increase budget");
    expect(truthSummary?.item.primaryAction).toBe("Needs truth");
  });
});
