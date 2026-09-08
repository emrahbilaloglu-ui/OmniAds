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
  it("explicit Target CPA is high confidence and eligible where it still governs", () => {
    // RE-PINNED. This case used to also carry `targetRoas: 3`, which is now the
    // case where the platform AOV takes over. The CPA rung survives exactly
    // where it still means something: no Target ROAS, so nothing can divide an
    // average order value and the CPA is the only anchor there is.
    const { resolution, explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: null,
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
    // Scale is the one action that independently needs a ratio, and it names it.
    expect(explanation.actions.scale.eligible).toBe(false);
    expect(explanation.actions.scale.blockerCode).toBe("target_roas_missing");
    expect(explanation.actions.cut.eligible).toBe(true);
    expect(explanation.actions.refresh.eligible).toBe(true);
    expect(explanation.actions.cut.blockerCode).toBeNull();
  });

  it("a Target ROAS demotes an explicit Target CPA to the platform AOV", () => {
    const { resolution, explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: 3,
      breakEvenRoas: 2,
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 20,
    });
    expect(resolution.source).toBe("meta_derived_aov");
    expect(resolution.spendUnit).toBe(20);
    expect(resolution.spendUnit).not.toBe(25);
    expect(explanation.status).toBe("eligible_meta_derived_aov");
    // The CPA is demoted, not discarded: it stays readable in the lineage.
    expect(explanation.lineage.targetCpa).toBe(25);
  });

  it("operator AOV plus Target ROAS never derives the spend unit", () => {
    // RE-PINNED. This asserted `operator_aov` at 90 / 3 = 30. With a Target
    // ROAS the basis is Meta's own attributed AOV over that ratio, so the
    // operator rung is unreachable: 60 / 3, never 90 / 3.
    const { resolution, explanation } = explainFromLadder({
      operatorAovAssumption: 90,
      targetRoas: 3,
      breakEvenRoas: 2,
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 20,
    });
    expect(resolution.source).toBe("meta_derived_aov");
    expect(resolution.spendUnit).toBe(20);
    expect(resolution.spendUnit).not.toBe(30);
    expect(explanation.status).toBe("eligible_meta_derived_aov");
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
    /*
      ROUND 6: a thin sample builds NO unit under a Target ROAS. This expected
      a low-confidence `meta_derived_aov` — the action gate was closed but a
      real spend unit was still produced from 19 purchases and went on to size
      the maturity floor, the thresholds and the canonical hash. The named
      sample-insufficiency below is unchanged, which is the point: the operator
      still learns WHY, they just no longer get a number nothing may use.
    */
    expect(lowSample.resolution.source).toBe("insufficient");
    expect(lowSample.resolution.spendUnit).toBeNull();
    expect(lowSample.resolution.confidence).toBe("insufficient");
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

  it("account history is unreachable under a Target ROAS, and still a soft unit without one", () => {
    const { resolution, explanation } = explainFromLadder({
      accountCpaP50: 30,
      accountCpaSampleCount: 25,
      targetRoas: 3,
      breakEvenRoas: 2,
    });
    /*
      ROUND 6: this expected `account_history` with `spendUnit: 30`. The
      account's own median CPA is a money-per-purchase unit built from
      something other than ready Meta AOV, on an account whose Target ROAS says
      only ready Meta AOV may answer, and `hardEligibleByDefault: false` left
      the ARITHMETIC in place while closing only the action gate.
    */
    expect(resolution.source).toBe("insufficient");
    expect(resolution.spendUnit).toBeNull();
    expect(resolution.hardEligibleByDefault).toBe(false);

    // The compatibility control: without a Target ROAS the rung is reachable.
    const legacy = explainFromLadder({
      accountCpaP50: 30,
      accountCpaSampleCount: 25,
      targetRoas: null,
      breakEvenRoas: 2,
    });
    expect(legacy.resolution.source).toBe("account_history");
    expect(legacy.resolution.spendUnit).toBe(30);
    expect(legacy.resolution.hardEligibleByDefault).toBe(false);
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
    /*
      A Target ROAS is configured, so the canonical unit is Meta's own
      attributed AOV divided by it and the Meta purchase sample is the only
      absence. This used to read `["target_cpa", "operator_aov_assumption"]`,
      and `operator_aov_assumption` is now absent from EVERY missing-input list:
      with a Target ROAS it resolves the platform AOV rather than the operator's,
      and without one it divides by nothing — so on neither branch would typing
      it move the hold. A missing-input list names what WOULD work.
      which told an operator with a perfectly good ROAS to go and type one of
      the two numbers this product does not require.
    */
    expect(explanation.missingInputs).toEqual([
      "meta_attributed_purchase_sample",
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
    expect(explanation.status).toBe("blocked_missing_owner_anchor");
    /*
      The unusable value is rejected exactly as before — that is what the two
      assertions above measure. What moved is the ADVICE: a Target ROAS is
      configured here, so the hold names the Meta purchase sample the resolver
      actually stopped on rather than demanding the CPA back.
    */
    expect(explanation.missingInputs).toEqual([
      "meta_attributed_purchase_sample",
    ]);
  });

  it.each([
    ["zero", 0],
    ["negative", -25],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "a %s Target CPA with no Target ROAS still names the CPA",
    (_label, value) => {
      /*
        The guard against over-correcting the case above.

        Legacy target-CPA compatibility survives precisely where it still means
        something: with no Target ROAS nothing can divide an average order
        value, so a Target CPA is the only rung that could resolve an anchor and
        the hold must keep asking for it. Deleting `target_cpa` from this branch
        too would leave an unusable CPA and no ROAS reported as a Meta sampling
        problem, which it is not.
      */
      const { resolution, explanation } = explainFromLadder({
        targetCpa: value,
        accountCpaP50: 30,
        accountCpaSampleCount: 25,
        targetRoas: null,
        breakEvenRoas: 2,
      });
      expect(resolution.source).not.toBe("target_cpa");
      expect(explanation.thresholdEligible).toBe(false);
      expect(explanation.missingInputs).toEqual([
        "target_cpa",
          "target_roas",
      ]);
    },
  );

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

  it("a Target ROAS with no Meta purchase sample holds and names the sample", () => {
    /*
      The canonical rule, stated as an assertion: with a Target ROAS the spend
      unit is Meta's own attributed AOV divided by it, so the absence that
      blocks is the Meta purchase sample and NOT a CPA or an AOV nobody has to
      type. The account is still held — this lowers nothing.
    */
    const { resolution, explanation } = explainFromLadder({
      targetRoas: 3,
      breakEvenRoas: 2,
    });
    expect(resolution.source).toBe("insufficient");
    expect(explanation.thresholdEligible).toBe(false);
    expect(explanation.status).toBe("blocked_missing_owner_anchor");
    expect(explanation.missingInputs).toEqual([
      "meta_attributed_purchase_sample",
    ]);
  });

  it("a Target ROAS with a ready Meta sample resolves and demands nothing", () => {
    /*
      The guard against over-correcting the case above into a permanent hold.
      The same lineage, with Meta purchases attached, must still MINT a unit
      through the canonical rung — 60 / 3 — and name no missing input at all.
    */
    const { resolution, explanation } = explainFromLadder({
      targetRoas: 3,
      breakEvenRoas: 2,
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 20,
    });
    expect(resolution.source).toBe("meta_derived_aov");
    expect(resolution.spendUnit).toBe(20);
    expect(explanation.status).toBe("eligible_meta_derived_aov");
    expect(explanation.thresholdEligible).toBe(true);
    expect(explanation.missingInputs).toEqual([]);
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
    // RE-PINNED: the anchor is now the platform AOV rather than the Target CPA,
    // because a Target ROAS is configured. The CPA is left in place to show it
    // neither supplies nor withholds the anchor here.
    const { explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: 3,
      breakEvenRoas: null,
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 20,
    });
    expect(explanation.actions.cut.eligible).toBe(false);
    expect(explanation.actions.cut.blockerCode).toBe("break_even_roas_missing");
    expect(explanation.actions.scale.eligible).toBe(true);
  });

  it("calibration below the floor blocks only Scale and is not an anchor problem", () => {
    // RE-PINNED for the same reason as the case above.
    const { explanation } = explainFromLadder({
      targetCpa: 25,
      targetRoas: 3,
      breakEvenRoas: 2,
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 20,
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
