import { describe, expect, it } from "vitest";
import {
  META_AUTOMATIC_CONTEXT_REVIEW_REASON,
  META_TEST_SCALE_TO_PROMOTE_REASON,
  applyMetaCampaignLabelGuard,
  buildMetaCampaignLabelKindMap,
  isContextTrustedForAction,
  type MetaCampaignContextGuardEntry,
} from "@/lib/meta/campaign-label-guard";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

/*
  D118 consumer golden — the Meta structure lane.

  A Main campaign runs a separate Test ad set. A campaign-level
  recommendation reads the campaign's role; an ad-set-level recommendation
  reads its OWN ad set's role. An undeclared ad set carries the campaign's
  role only as a suggestion, which is never role-dependent authority.
*/

const CAMPAIGN = "cmp-main";
const TEST_ADSET = "as-test";
const OPEN_ADSET = "as-open";

function declared(kind: "main" | "test"): MetaCampaignContextGuardEntry {
  return {
    kind,
    contextTrust: "high",
    source: "operator_declared",
    inferenceConfidenceClass: "high",
    resolverAuthorityValidated: false,
    declarationAuthorityValidated: true,
  };
}

/** What snapshot.ts hands the guard for an undeclared ad set: capped. */
function suggestionFrom(parent: MetaCampaignContextGuardEntry): MetaCampaignContextGuardEntry {
  return {
    ...parent,
    contextTrust: parent.contextTrust === "high" ? "medium" : parent.contextTrust,
    resolverAuthorityValidated: false,
    declarationAuthorityValidated: false,
    roleBasis: "parent_campaign_suggestion",
  };
}

function rec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "rec-1",
    level: "campaign",
    campaignId: CAMPAIGN,
    campaignName: "TS_MAIN_DPA_BIDCAP",
    type: "scale_for_volume",
    lens: "volume",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.88,
    confidenceReason: null,
    decisionState: "act",
    decision: "Scale",
    title: "Scale",
    why: "Above the calibrated scale line.",
    summary: "Strong.",
    recommendedAction: "Increase budget 10-15%.",
    expectedImpact: "More volume.",
    evidence: [{ label: "ROAS", value: "4.00x", tone: "positive" }],
    timeframeContext: {
      coreVerdict: "Strong",
      selectedRangeOverlay: "Selected range supports scale.",
      historicalSupport: "History supports scale.",
      seasonalityFlag: "none",
      note: null,
    },
    ...overrides,
  };
}

const campaignRec = rec({ id: "campaign-scale" });
const testAdsetRec = rec({
  id: "adset-scale-test",
  level: "adset",
  adsetId: TEST_ADSET,
  // A Main-sounding name proves nothing; the declaration says Test.
  adsetName: "MAIN_SCALE_ADSET",
  type: "adset_scale_budget",
});
const openAdsetRec = rec({
  id: "adset-scale-open",
  level: "adset",
  adsetId: OPEN_ADSET,
  adsetName: "TEST_CELL",
  type: "adset_scale_budget",
});

function guard(input: {
  campaign: MetaCampaignContextGuardEntry;
  adsets?: Map<string, MetaCampaignContextGuardEntry>;
}) {
  const result = applyMetaCampaignLabelGuard({
    recommendations: [campaignRec, testAdsetRec, openAdsetRec],
    campaignLabelsById: buildMetaCampaignLabelKindMap([]),
    campaignContextById: new Map([[CAMPAIGN, input.campaign]]),
    adsetContextById: input.adsets,
    automaticContextEnabled: true,
    activeCampaignIds: [CAMPAIGN],
  });
  const byOriginalId = (id: string) =>
    result.recommendations.find((item) => item.id === id || item.id.endsWith(id))!;
  return { result, byOriginalId };
}

describe("D118 — ad set roles in the Meta structure lane", () => {
  const campaign = declared("main");
  const adsets = new Map([
    [TEST_ADSET, declared("test")],
    [OPEN_ADSET, suggestionFrom(campaign)],
  ]);

  it("R118-S1: the campaign-level rec reads the declared Main campaign and keeps its action", () => {
    const { byOriginalId } = guard({ campaign, adsets });
    expect(byOriginalId("campaign-scale")).toMatchObject({
      decisionState: "act",
      campaignKind: "main",
      campaignContext: { kind: "main", source: "operator_declared", trustedForAction: true },
    });
  });

  it("R118-S2: the declared Test ad set inside that Main campaign gets Test semantics", () => {
    const { byOriginalId } = guard({ campaign, adsets });
    const promoted = byOriginalId("adset-scale-test");
    expect(promoted).toMatchObject({
      type: "promote_test_to_main",
      campaignKind: "test",
      labelTransform: { reason: META_TEST_SCALE_TO_PROMOTE_REASON },
      campaignContext: { kind: "test", trustedForAction: true },
    });
  });

  it("R118-S3: an undeclared ad set of the Main campaign shows Main as context but gets no role-dependent action", () => {
    const { byOriginalId, result } = guard({ campaign, adsets });
    expect(byOriginalId("adset-scale-open")).toMatchObject({
      decisionState: "watch",
      confidenceReason: META_AUTOMATIC_CONTEXT_REVIEW_REASON,
      campaignContext: { kind: "main", trustedForAction: false },
    });
    expect(byOriginalId("adset-scale-open").campaignKind).toBeUndefined();
    // The campaign itself is resolved; only the ad set lacks its own role.
    expect(result.unlabeledCampaignIds).toEqual([]);
  });

  it("R118-S4: without ad set roles no ad-set rec inherits the campaign's authority", () => {
    const { byOriginalId } = guard({ campaign });
    for (const id of ["adset-scale-test", "adset-scale-open"]) {
      expect(byOriginalId(id)).toMatchObject({ decisionState: "watch" });
    }
    expect(byOriginalId("campaign-scale").decisionState).toBe("act");
  });

  it("R118-S5: a validated automatic campaign role still governs campaign recs, never ad set recs", () => {
    const automatic: MetaCampaignContextGuardEntry = {
      kind: "main",
      contextTrust: "high",
      source: "system_inferred",
      inferenceConfidenceClass: "high",
      resolverAuthorityValidated: true,
    };
    expect(isContextTrustedForAction(automatic)).toBe(true);
    const { byOriginalId } = guard({
      campaign: automatic,
      adsets: new Map([[OPEN_ADSET, suggestionFrom(automatic)]]),
    });
    expect(byOriginalId("campaign-scale").decisionState).toBe("act");
    expect(byOriginalId("adset-scale-open").decisionState).toBe("watch");
  });

  it("R118-S6: a declaration without its contract proof is not authority", () => {
    expect(isContextTrustedForAction({ ...declared("main"), declarationAuthorityValidated: false })).toBe(false);
    expect(isContextTrustedForAction({ ...declared("main"), source: "user_override" })).toBe(false);
  });
});
