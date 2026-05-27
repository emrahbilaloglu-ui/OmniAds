import { describe, expect, it } from "vitest";
import type {
  DecisionBadge,
  DecisionOutput,
} from "@/lib/creative-decision-engine/types";
import { adaptCreativeDecisionToRow } from "../adapter";
import {
  CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION,
  bridgeV3DecisionToAdapterInput,
  bridgeV3DecisionToV21,
  bridgeV3DecisionsToAdapterInputs,
  type CreativeDecisionCenterV3BridgeContext,
  type V3BridgeMappedResult,
} from "../v3-bridge";
import { auditCreativeDecisionCenterRowInvariants } from "../invariants";
import {
  validateCreativeDecisionCenterRowDecision,
  validateCreativeDecisionOsV21Output,
} from "../validators";

function badge(
  type: DecisionBadge["type"],
  severity: DecisionBadge["severity"] = "info",
): DecisionBadge {
  return { type, label: type, severity };
}

function makeV3Decision(
  overrides: Partial<DecisionOutput> = {},
): DecisionOutput {
  return {
    creativeId: "creative_1",
    creativeName: "Creative 1",
    label: "diagnose",
    reason: "Diagnostic evidence is required.",
    confidence: 42,
    truthSource: "account_baseline",
    effectiveTargetRoas: 2,
    ratioToTarget: 0.9,
    badges: [],
    metrics: {
      spend: 100,
      purchases: 1,
      roas: 1.8,
      recent7dRoas: 1.7,
    },
    campaignLabelStatus: "labeled",
    campaignKind: "main",
    campaignTestDimension: null,
    blockedActionType: null,
    decisionKindSource: "kind_main",
    labelTransform: null,
    engineVersion: "v3-test",
    generatedAt: "2026-05-24T00:00:00.000Z",
    ...overrides,
  };
}

function requireMapped(result: ReturnType<typeof bridgeV3DecisionToV21>) {
  expect(result.kind).toBe("mapped");
  return result as V3BridgeMappedResult;
}

function validateMappedBridge(result: V3BridgeMappedResult) {
  const engineValidation = validateCreativeDecisionOsV21Output(result.engine);
  expect(engineValidation.ok, engineValidation.errors.join(", ")).toBe(true);
  expect(result.engine).toBe(result.adapterInput.engine);

  const { row } = adaptCreativeDecisionToRow(result.adapterInput);
  const rowValidation = validateCreativeDecisionCenterRowDecision(row);
  expect(rowValidation.ok, rowValidation.errors.join(", ")).toBe(true);
  expect(auditCreativeDecisionCenterRowInvariants(row)).toEqual([]);
  return row;
}

describe("Creative Decision Center V3 bridge", () => {
  it("exposes a stable bridge version", () => {
    expect(CREATIVE_DECISION_CENTER_V3_BRIDGE_VERSION).toBe(
      "creative-decision-center.v3-bridge.v1",
    );
  });

  it("maps every V3 label into a V2.1 row or explicit omission", () => {
    const cases = [
      { label: "scale", primaryDecision: "Scale" },
      { label: "cut", primaryDecision: "Cut" },
      { label: "refresh", primaryDecision: "Refresh" },
      { label: "test_more", primaryDecision: "Test More" },
      { label: "diagnose", primaryDecision: "Diagnose" },
    ] as const;

    for (const testCase of cases) {
      const result = requireMapped(
        bridgeV3DecisionToV21({
          decision: makeV3Decision({
            label: testCase.label,
            reason: `${testCase.label} reason.`,
            confidence: 80,
          }),
        }),
      );
      expect(result.engine.primaryDecision).toBe(testCase.primaryDecision);
      expect(result.sourceDecision).toBe(`v3:${testCase.label}`);
      expect(result.engine.reasonTags).toContain(`v3_${testCase.label}`);
      validateMappedBridge(result);
    }

    const keep = bridgeV3DecisionToV21({
      decision: makeV3Decision({ label: "keep", reason: "Hold steady." }),
    });
    expect(keep).toMatchObject({
      kind: "omitted",
      omitReason: "plain_keep_no_action",
      sourceDecision: "v3:keep",
    });

    const outOfScope = bridgeV3DecisionToV21({
      decision: makeV3Decision({ label: "out_of_scope" }),
    });
    expect(outOfScope).toMatchObject({
      kind: "omitted",
      omitReason: "out_of_scope",
      sourceDecision: "v3:out_of_scope",
    });
  });

  it("maps scale rows through the existing adapter execution CTAs", () => {
    const cases = [
      { campaignKind: "test", executionAction: "promote_to_main" },
      { campaignKind: "main", executionAction: "scale_budget" },
      { campaignKind: "mixed", executionAction: "controlled_scale" },
    ] as const;

    for (const testCase of cases) {
      const result = requireMapped(
        bridgeV3DecisionToV21({
          decision: makeV3Decision({
            label: "scale",
            campaignKind: testCase.campaignKind,
            confidence: 85,
            reason: "Scale-ready winner.",
          }),
          context: { campaignKind: testCase.campaignKind },
        }),
      );
      const row = validateMappedBridge(result);

      expect(row.buyerAction).toBe("scale");
      expect(row.executionAction).toBe(testCase.executionAction);
      expect(row.sourceDecision).toBe("v3:scale");
    }
  });

  it("lets the existing adapter block unlabeled scale execution", () => {
    const result = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "scale",
          campaignKind: null,
          campaignLabelStatus: "unlabeled",
          confidence: 90,
          reason: "Would scale if campaign kind were labeled.",
        }),
        context: { campaignKind: null },
      }),
    );
    const { row, trace } = adaptCreativeDecisionToRow(result.adapterInput);

    expect(result.engine.primaryDecision).toBe("Scale");
    expect(row.buyerAction).toBe("diagnose_data");
    expect(row.executionAction).toBeNull();
    expect(trace.unlabeledScaleSafetyApplied).toBe(true);
    expect(validateCreativeDecisionCenterRowDecision(row).ok).toBe(true);
  });

  it("maps review-worthy keep decisions without inventing a keep primary decision", () => {
    const campaignGap = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "keep",
          campaignLabelStatus: "unlabeled",
          badges: [badge("unlabeled_campaign_context", "warning")],
        }),
      }),
    );
    expect(campaignGap.engine.primaryDecision).toBe("Diagnose");
    expect(campaignGap.engine.actionability).toBe("diagnose");
    expect(campaignGap.engine.problemClass).toBe("campaign_context");
    expect(campaignGap.engine.reasonTags).toContain("campaign_label_missing");
    validateMappedBridge(campaignGap);

    const nearScale = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "keep",
          badges: [badge("scale_readiness_blocked")],
        }),
      }),
    );
    expect(nearScale.engine.primaryDecision).toBe("Test More");
    expect(nearScale.engine.problemClass).toBe("insufficient_signal");
    expect(nearScale.engine.reasonTags).toContain("near_scale_blocked");
    validateMappedBridge(nearScale);
  });

  it("preserves labelTransform as sourceDecision instead of flattening to the final label", () => {
    const result = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "cut",
          labelTransform: "test_cohort_refresh_to_cut",
          reason: "Refresh was transformed to cut for test cohort evidence.",
        }),
      }),
    );

    expect(result.sourceDecision).toBe("test_cohort_refresh_to_cut");
    expect(result.adapterInput.sourceDecision).toBe(
      "test_cohort_refresh_to_cut",
    );
    expect(result.trace.labelTransform).toBe("test_cohort_refresh_to_cut");
    expect(validateMappedBridge(result).sourceDecision).toBe(
      "test_cohort_refresh_to_cut",
    );
  });

  it("adds missing-data markers from degraded route health and V3 data badges", () => {
    const result = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "diagnose",
          truthSource: "global_default",
          confidence: 95,
          badges: [
            badge("tracking_anomaly", "warning"),
            badge("missing_recent_data", "warning"),
          ],
          reason: "Data proof is degraded.",
        }),
        context: { dataHealthDegraded: true },
      }),
    );
    const row = validateMappedBridge(result);

    expect(result.engine.missingData).toEqual([
      "data_health",
      "freshness",
      "tracking",
      "truth",
    ]);
    expect(result.engine.reasonTags).toEqual(
      expect.arrayContaining([
        "data_health_degraded",
        "tracking_anomaly_present",
        "truth_degraded",
      ]),
    );
    expect(row.confidenceBand).toBe("low");
  });

  it("keeps stale stop-loss cut as a Cut row with stale evidence missing-data marker", () => {
    const result = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "cut",
          confidence: 65,
          badges: [badge("stale_evidence", "warning")],
          reason: "ROAS below target after mature spend - cut underperforming creative.",
          metrics: {
            spend: 620,
            purchases: 1,
            roas: 0.27,
            recent7dRoas: 0.25,
          },
        }),
      }),
    );
    const row = validateMappedBridge(result);

    expect(result.engine.primaryDecision).toBe("Cut");
    expect(result.engine.actionability).toBe("review_only");
    expect(result.engine.applyEligible).toBe(false);
    expect(result.engine.missingData).toEqual(["stale_evidence"]);
    expect(result.engine.reasonTags).toContain("stale_evidence");
    expect(row.buyerAction).toBe("cut");
  });

  it("maps verified no-delivery diagnostics to fix_delivery without missing delivery proof", () => {
    const result = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "diagnose",
          badges: [badge("delivery_no_spend_24h", "warning")],
          confidence: 75,
          reason: "Delivery issue: active creative has verified 0 spend and 0 impressions.",
        }),
      }),
    );
    const row = validateMappedBridge(result);

    expect(result.engine.problemClass).toBe("delivery");
    expect(result.engine.missingData).toEqual([]);
    expect(row.buyerAction).toBe("fix_delivery");
  });

  it("maps policy-block diagnostics to fix_policy", () => {
    const result = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "diagnose",
          badges: [badge("policy_blocked", "warning")],
          confidence: 75,
          reason: "Policy reject: Creative has prohibited claims.",
        }),
      }),
    );
    const row = validateMappedBridge(result);

    expect(result.engine.problemClass).toBe("policy");
    expect(row.buyerAction).toBe("fix_policy");
  });

  it("maps launch-monitoring test_more diagnostics to watch_launch", () => {
    const result = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "test_more",
          badges: [badge("launch_monitoring")],
          confidence: 60,
          reason: "Below commercial maturity inside the launch window.",
        }),
      }),
    );
    const row = validateMappedBridge(result);

    expect(result.engine.primaryDecision).toBe("Test More");
    expect(result.engine.problemClass).toBe("launch_monitoring");
    expect(row.buyerAction).toBe("watch_launch");
  });

  it("derives conservative maturity and priority without reading account profiles", () => {
    const tooEarly = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "test_more",
          metrics: { spend: 0, purchases: 0, roas: null, recent7dRoas: null },
          confidence: 30,
        }),
      }),
    );
    expect(tooEarly.engine.maturity).toBe("too_early");
    expect(tooEarly.engine.priority).toBe("low");

    const matureHigh = requireMapped(
      bridgeV3DecisionToV21({
        decision: makeV3Decision({
          label: "cut",
          metrics: { spend: 500, purchases: 3, roas: 0.5, recent7dRoas: 0.4 },
          confidence: 80,
        }),
      }),
    );
    expect(matureHigh.engine.maturity).toBe("mature");
    expect(matureHigh.engine.priority).toBe("high");
  });

  it("returns null adapter input for omitted decisions and filters them in bulk", () => {
    const omitted = bridgeV3DecisionToAdapterInput({
      decision: makeV3Decision({ label: "out_of_scope" }),
    });
    expect(omitted).toBeNull();

    const inputs = bridgeV3DecisionsToAdapterInputs([
      { decision: makeV3Decision({ label: "keep" }) },
      {
        decision: makeV3Decision({
          label: "scale",
          confidence: 80,
          reason: "Scale-ready winner.",
        }),
        context: { campaignKind: "main" },
      },
    ]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.engine.primaryDecision).toBe("Scale");
  });

  it("produces deterministic JSON for repeated calls", () => {
    const input: {
      decision: DecisionOutput;
      context: CreativeDecisionCenterV3BridgeContext;
    } = {
      decision: makeV3Decision({
        label: "keep",
        badges: [badge("weak_performance"), badge("truth_global_default")],
        truthSource: "global_default",
      }),
      context: { dataHealthDegraded: true, campaignKind: "main" },
    };

    const first = bridgeV3DecisionToV21(input);
    const second = bridgeV3DecisionToV21(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("Creative Decision Center V3 bridge documented coverage gaps", () => {
  it.todo("GC-009 watch_launch severe-overspend policy still needs final product decision");
  it.todo("GC-029 Protect waits for family/no-new-winner signal enrichment");
  it.todo("GC-031 Protect waits for family winner-aging signal enrichment");
  it.todo("GC-034 Protect waits for stable-winner family signal enrichment");
  it.todo("GC-038 review-like no-op stays omitted until a V2.1 action exists");
  it.todo("GC-040 same_as_canonical has no V2.1 buyer action yet");
  it.todo("GC-041 same_as_canonical has no V2.1 buyer action yet");
  it.todo("GC-049 review-like keep remains safe test_more in bridge v1");
  it.todo("GC-050 review-like keep remains safe test_more in bridge v1");
  it.todo("GC-051 review-like keep remains safe test_more in bridge v1");
  it.todo("GC-052 review-like keep remains safe test_more in bridge v1");
});
