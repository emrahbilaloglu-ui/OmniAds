import { describe, expect, it } from "vitest";
import {
  CREATIVE_OUTCOME_CLASSIFIER_VERSION,
  classifyCreativeDecisionOutcome,
} from "../outcome-classifier";

const base = {
  confidence: 80,
  effectiveTargetRoas: 2,
  baselineSpend: 500,
  baselinePurchases: 4,
  baselineRoas: 2.4,
  outcomeSpend: 300,
  outcomePurchases: 3,
  outcomeRevenue: 750,
  outcomeRoas: 2.5,
  outcomeWindowDays: 7,
};

describe("classifyCreativeDecisionOutcome", () => {
  it("uses the v2 classifier contract", () => {
    expect(CREATIVE_OUTCOME_CLASSIFIER_VERSION).toBe(
      "creative-outcome-classifier.v2",
    );
  });

  it("marks scale positive when the outcome window holds above target", () => {
    expect(
      classifyCreativeDecisionOutcome({
        ...base,
        label: "scale",
      }),
    ).toMatchObject({
      realizedOutcome: "positive",
      evidence: { rule: "scale_held_above_target" },
    });
  });

  it("grades spend severity against the row baseline instead of absolute thresholds", () => {
    expect(
      classifyCreativeDecisionOutcome({
        ...base,
        label: "scale",
        baselineSpend: 100,
        outcomeSpend: 80,
        outcomeRoas: 2.5,
      }),
    ).toMatchObject({
      realizedOutcome: "positive",
      severity: "high",
    });

    expect(
      classifyCreativeDecisionOutcome({
        ...base,
        label: "scale",
        baselineSpend: 100,
        outcomeSpend: 120,
        outcomeRoas: 2.5,
      }),
    ).toMatchObject({
      realizedOutcome: "positive",
      severity: "critical",
    });
  });

  it("marks cut negative when the creative recovers above target", () => {
    expect(
      classifyCreativeDecisionOutcome({
        ...base,
        label: "cut",
        outcomeRoas: 2.3,
        outcomeRevenue: 690,
      }),
    ).toMatchObject({
      realizedOutcome: "negative",
      evidence: { rule: "cut_recovered_above_target" },
    });
  });

  it("marks non-hard rows positive only when a hard opportunity was missed", () => {
    expect(
      classifyCreativeDecisionOutcome({
        ...base,
        label: "keep",
        outcomeRoas: 0.7,
        outcomePurchases: 0,
        outcomeRevenue: 210,
      }),
    ).toMatchObject({
      realizedOutcome: "positive",
      evidence: { rule: "non_hard_missed_cut_opportunity" },
    });
  });

  it("does not credit refresh outcomes as positive when baseline ROAS is missing", () => {
    expect(
      classifyCreativeDecisionOutcome({
        ...base,
        label: "refresh",
        baselineRoas: null,
        baselinePurchases: null,
        outcomeRoas: 1.5,
        outcomeRevenue: 450,
      }),
    ).toMatchObject({
      realizedOutcome: "neutral",
      evidence: { rule: "refresh_missing_baseline_inconclusive" },
    });
  });

  it("credits refresh outcomes only when decay continues versus a real baseline", () => {
    expect(
      classifyCreativeDecisionOutcome({
        ...base,
        label: "refresh",
        baselineRoas: 2.4,
        outcomeRoas: 1.5,
        outcomeRevenue: 450,
      }),
    ).toMatchObject({
      realizedOutcome: "positive",
      evidence: { rule: "refresh_decay_continued" },
    });
  });

  it("keeps rows unknown when there is no outcome spend or target", () => {
    expect(
      classifyCreativeDecisionOutcome({
        ...base,
        label: "scale",
        outcomeSpend: 0,
        outcomePurchases: 0,
        outcomeRevenue: 0,
        outcomeRoas: null,
      }),
    ).toMatchObject({
      realizedOutcome: "unknown",
      evidence: { rule: "missing_outcome_spend_or_target" },
    });
  });
});
