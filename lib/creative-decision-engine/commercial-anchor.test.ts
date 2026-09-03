import { describe, expect, it } from "vitest";

import {
  COMMERCIAL_ANCHOR_CONTRACT_VERSION,
  describeCommercialAnchorBlocker,
  resolveCommercialAnchorExplanation,
  type CommercialAnchorBlockerCode,
  type CommercialAnchorLineage,
} from "./commercial-anchor";
import { classifyMetaAovQuality, resolveSpendUnit } from "./spend-unit-resolver";

const EMPTY_LINEAGE: CommercialAnchorLineage = {
  targetCpa: null,
  operatorAovAssumption: null,
  targetRoas: null,
  breakEvenRoas: null,
  metaAttributedAovMean90d: null,
  metaAttributedAovPurchaseCount90d: 0,
  attributionAovAdjustmentMultiplier: null,
};

/** Mirrors the profile's own predicates so the ladder is exercised exactly as
 * production composes it: resolver -> threshold eligibility -> explanation. */
function explainFromLadder(input: {
  targetCpa?: number | null;
  operatorAovAssumption?: number | null;
  targetRoas?: number | null;
  breakEvenRoas?: number | null;
  metaAttributedAovMean90d?: number | null;
  metaAttributedAovPurchaseCount90d?: number;
  accountCpaP50?: number | null;
  accountCpaSampleCount?: number;
  provenanceUnverified?: boolean;
  calibrationReady?: boolean;
  shadowOnly?: boolean;
  currency?: string | null;
}) {
  const resolution = resolveSpendUnit({
    targetCpa: input.targetCpa ?? null,
    operatorAovAssumption: input.operatorAovAssumption ?? null,
    metaAttributedAovMean90d: input.metaAttributedAovMean90d ?? null,
    metaAttributedAovPurchaseCount90d:
      input.metaAttributedAovPurchaseCount90d ?? 0,
    metaAttributedRevenue90d: 0,
    targetRoas: input.targetRoas ?? null,
    breakEvenRoas: input.breakEvenRoas ?? null,
    accountCpaP50: input.accountCpaP50 ?? null,
    accountCpaSampleCount: input.accountCpaSampleCount ?? 0,
    attributionAovAdjustmentMultiplier: 1,
  });
  const metaAovQuality = classifyMetaAovQuality(
    input.metaAttributedAovPurchaseCount90d ?? 0,
  );
  const provenanceUnverified = input.provenanceUnverified ?? false;
  const hardEligibleByDefault =
    resolution.hardEligibleByDefault && !provenanceUnverified;
  const confidence = provenanceUnverified ? "low" : resolution.confidence;
  const thresholdEligible =
    hardEligibleByDefault &&
    (confidence === "high" ||
      (confidence === "medium" && metaAovQuality === "ready"));
  const scaleAnchorEligible = (input.targetRoas ?? 0) > 0;
  const cutAnchorEligible = (input.breakEvenRoas ?? 0) > 0;
  return {
    resolution,
    explanation: resolveCommercialAnchorExplanation({
      shadowOnly: input.shadowOnly ?? false,
      thresholdEligible,
      provenanceUnverified,
      scaleAnchorEligible,
      cutAnchorEligible,
      calibrationReady: input.calibrationReady ?? true,
      spendUnit: resolution.spendUnit,
      spendUnitSource: resolution.source,
      spendUnitConfidence: confidence,
      metaAovQuality,
      currency: input.currency ?? null,
      targetPackFreshness: null,
      targetPackUpdatedAt: null,
      lineage: {
        ...EMPTY_LINEAGE,
        targetCpa: input.targetCpa ?? null,
        operatorAovAssumption: input.operatorAovAssumption ?? null,
        targetRoas: input.targetRoas ?? null,
        breakEvenRoas: input.breakEvenRoas ?? null,
        metaAttributedAovMean90d: input.metaAttributedAovMean90d ?? null,
        metaAttributedAovPurchaseCount90d:
          input.metaAttributedAovPurchaseCount90d ?? 0,
      },
    }),
  };
}

describe("spend-unit ladder — source, eligibility and anchor status", () => {
  it("explicit Target CPA is high confidence, eligible, and reported as such", () => {
    const { resolution, explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: 3,
      breakEvenRoas: 2,
      currency: "USD",
    });
    expect(resolution.source).toBe("target_cpa");
    expect(resolution.confidence).toBe("high");
    expect(resolution.hardEligibleByDefault).toBe(true);
    expect(resolution.spendUnit).toBe(25);
    expect(explanation.status).toBe("eligible_target_cpa");
    expect(explanation.thresholdEligible).toBe(true);
    expect(explanation.missingInputs).toEqual([]);
    expect(explanation.currency).toBe("USD");
    expect(explanation.actions.scale.eligible).toBe(true);
    expect(explanation.actions.cut.eligible).toBe(true);
    expect(explanation.actions.refresh.eligible).toBe(true);
    expect(explanation.actions.cut.blockerCode).toBeNull();
  });

  it("operator AOV plus Target ROAS is high confidence and derives the spend unit", () => {
    const { resolution, explanation } = explainFromLadder({
      operatorAovAssumption: 90,
      targetRoas: 3,
      breakEvenRoas: 2,
    });
    expect(resolution.source).toBe("operator_aov");
    expect(resolution.spendUnit).toBe(30);
    expect(explanation.status).toBe("eligible_operator_aov");
    expect(explanation.missingInputs).toEqual([]);
    expect(explanation.lineage.operatorAovAssumption).toBe(90);
    expect(explanation.lineage.targetRoas).toBe(3);
  });

  it("a sampled Meta AOV is medium and eligible only at the ready sample bar", () => {
    const ready = explainFromLadder({
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 20,
      targetRoas: 3,
      breakEvenRoas: 2,
    });
    expect(ready.resolution.source).toBe("meta_derived_aov");
    expect(ready.resolution.confidence).toBe("medium");
    expect(ready.resolution.hardEligibleByDefault).toBe(true);
    expect(ready.explanation.status).toBe("eligible_meta_derived_aov");
    expect(ready.explanation.thresholdEligible).toBe(true);

    const lowSample = explainFromLadder({
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 19,
      targetRoas: 3,
      breakEvenRoas: 2,
    });
    expect(lowSample.resolution.confidence).toBe("low");
    expect(lowSample.resolution.hardEligibleByDefault).toBe(false);
    expect(lowSample.explanation.status).toBe(
      "blocked_meta_aov_sample_insufficient",
    );
    expect(lowSample.explanation.thresholdEligible).toBe(false);
    expect(lowSample.explanation.missingInputs).toContain(
      "meta_attributed_purchase_sample",
    );
    expect(lowSample.explanation.actions.cut.blockerCode).toBe(
      "commercial_anchor_sample_insufficient",
    );
  });

  it("account history is a spend unit but never hard-action eligible", () => {
    const { resolution, explanation } = explainFromLadder({
      accountCpaP50: 30,
      accountCpaSampleCount: 25,
      targetRoas: 3,
      breakEvenRoas: 2,
    });
    expect(resolution.source).toBe("account_history");
    expect(resolution.spendUnit).toBe(30);
    expect(resolution.hardEligibleByDefault).toBe(false);
    expect(explanation.status).toBe("blocked_missing_owner_anchor");
    expect(explanation.actions.scale.blockerCode).toBe(
      "commercial_anchor_missing",
    );
    expect(explanation.actions.cut.blockerCode).toBe(
      "commercial_anchor_missing",
    );
    expect(explanation.actions.refresh.blockerCode).toBe(
      "commercial_anchor_missing",
    );
    expect(explanation.missingInputs).toEqual([
      "target_cpa",
      "operator_aov_assumption",
    ]);
  });

  it("the break-even AOV fallback is not hard-action eligible", () => {
    const { resolution, explanation } = explainFromLadder({
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 0,
      breakEvenRoas: 2,
    });
    expect(resolution.source).toBe("break_even_aov");
    expect(resolution.hardEligibleByDefault).toBe(false);
    expect(explanation.status).toBe("blocked_missing_owner_anchor");
    expect(explanation.missingInputs).toEqual([
      "target_cpa",
      "operator_aov_assumption",
      "target_roas",
    ]);
  });

  it("no usable input at all resolves insufficient and names every anchor", () => {
    const { resolution, explanation } = explainFromLadder({});
    expect(resolution.source).toBe("insufficient");
    expect(resolution.spendUnit).toBeNull();
    expect(explanation.status).toBe("blocked_missing_owner_anchor");
    expect(explanation.spendUnit).toBeNull();
    expect(explanation.missingInputs).toEqual([
      "target_cpa",
      "operator_aov_assumption",
      "target_roas",
    ]);
  });
});

describe("fail-closed anchor inputs", () => {
  it.each([
    ["zero", 0],
    ["negative", -25],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("a %s Target CPA never becomes an anchor", (_label, value) => {
    const { resolution, explanation } = explainFromLadder({
      targetCpa: value,
      accountCpaP50: 30,
      accountCpaSampleCount: 25,
      targetRoas: 3,
      breakEvenRoas: 2,
    });
    expect(resolution.source).not.toBe("target_cpa");
    expect(explanation.thresholdEligible).toBe(false);
    expect(explanation.missingInputs).toContain("target_cpa");
  });

  it("an operator AOV without a Target ROAS is a partial anchor and stays blocked", () => {
    const { resolution, explanation } = explainFromLadder({
      operatorAovAssumption: 90,
      targetRoas: null,
      breakEvenRoas: 2,
    });
    expect(resolution.source).not.toBe("operator_aov");
    expect(explanation.thresholdEligible).toBe(false);
    expect(explanation.status).toBe("blocked_missing_owner_anchor");
    // The AOV is present, so the actionable gap is the ROAS — and it is named.
    expect(explanation.missingInputs).toContain("target_roas");
    expect(explanation.missingInputs).not.toContain("operator_aov_assumption");
  });

  it("a Target ROAS without any AOV or CPA is a partial anchor and stays blocked", () => {
    const { explanation } = explainFromLadder({
      targetRoas: 3,
      breakEvenRoas: 2,
    });
    expect(explanation.thresholdEligible).toBe(false);
    expect(explanation.missingInputs).toEqual([
      "target_cpa",
      "operator_aov_assumption",
    ]);
  });

  it("unverifiable target provenance demotes an otherwise high-confidence anchor", () => {
    const { explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: 3,
      breakEvenRoas: 2,
      provenanceUnverified: true,
    });
    expect(explanation.thresholdEligible).toBe(false);
    expect(explanation.status).toBe("blocked_provenance_unverified");
    expect(explanation.missingInputs).toEqual(["commercial_target_provenance"]);
    expect(explanation.actions.cut.blockerCode).toBe(
      "commercial_anchor_provenance_unverified",
    );
    // Re-saving the target is a different act from supplying a new anchor, so
    // the copy must not tell the operator to invent economics.
    expect(explanation.actions.cut.operatorCopy).toContain("Re-save");
  });

  it("shadow-only withholds every action regardless of a perfect anchor", () => {
    const { explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: 3,
      breakEvenRoas: 2,
      shadowOnly: true,
    });
    expect(explanation.status).toBe("blocked_shadow_only");
    for (const action of ["scale", "cut", "refresh"] as const) {
      expect(explanation.actions[action].eligible).toBe(false);
      expect(explanation.actions[action].blockerCode).toBe("shadow_only");
    }
    expect(explanation.missingInputs).toEqual([]);
  });
});

describe("independent per-action gates keep their own codes", () => {
  it("a good anchor with no Target ROAS blocks only Scale, and names the ROAS", () => {
    const { explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: null,
      breakEvenRoas: 2,
    });
    expect(explanation.thresholdEligible).toBe(true);
    expect(explanation.actions.scale.eligible).toBe(false);
    expect(explanation.actions.scale.blockerCode).toBe("target_roas_missing");
    expect(explanation.actions.cut.eligible).toBe(true);
    expect(explanation.actions.refresh.eligible).toBe(true);
  });

  it("a good anchor with no break-even ROAS blocks only Cut", () => {
    const { explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: 3,
      breakEvenRoas: null,
    });
    expect(explanation.actions.cut.eligible).toBe(false);
    expect(explanation.actions.cut.blockerCode).toBe("break_even_roas_missing");
    expect(explanation.actions.scale.eligible).toBe(true);
  });

  it("calibration below the floor blocks only Scale and is not an anchor problem", () => {
    const { explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: 3,
      breakEvenRoas: 2,
      calibrationReady: false,
    });
    expect(explanation.actions.scale.blockerCode).toBe(
      "scale_calibration_below_floor",
    );
    expect(explanation.actions.cut.eligible).toBe(true);
    expect(explanation.missingInputs).toEqual([]);
  });
});

describe("contract shape", () => {
  it("every blocker code has operator copy and none of it is empty", () => {
    const codes: CommercialAnchorBlockerCode[] = [
      "shadow_only",
      "commercial_anchor_missing",
      "commercial_anchor_sample_insufficient",
      "commercial_anchor_provenance_unverified",
      "target_roas_missing",
      "break_even_roas_missing",
      "scale_calibration_below_floor",
    ];
    for (const code of codes) {
      expect(describeCommercialAnchorBlocker(code).length).toBeGreaterThan(20);
    }
  });

  it("an eligible action never carries a blocker code, and a blocked one always does", () => {
    for (const scenario of [
      { targetCpa: 25, targetRoas: 3, breakEvenRoas: 2 },
      { accountCpaP50: 30, accountCpaSampleCount: 25 },
      { operatorAovAssumption: 90, targetRoas: 3 },
      {},
    ]) {
      const { explanation } = explainFromLadder(scenario);
      for (const action of ["scale", "cut", "refresh"] as const) {
        const entry = explanation.actions[action];
        if (entry.eligible) {
          expect(entry.blockerCode).toBeNull();
          expect(entry.operatorCopy).toBeNull();
        } else {
          expect(entry.blockerCode).not.toBeNull();
          expect(entry.operatorCopy).not.toBeNull();
        }
      }
    }
  });

  it("carries a stable contract version", () => {
    const { explanation } = explainFromLadder({ targetCpa: 25 });
    expect(explanation.contractVersion).toBe(COMMERCIAL_ANCHOR_CONTRACT_VERSION);
    expect(COMMERCIAL_ANCHOR_CONTRACT_VERSION).toBe(
      "creative-decision-engine.commercial-anchor.v1",
    );
  });

  it("currency is never defaulted to USD when unknown", () => {
    const { explanation } = explainFromLadder({ targetCpa: 25 });
    expect(explanation.currency).toBeNull();
  });
});
