import { describe, expect, it } from "vitest";
import {
  applyLabelHysteresis,
  stabilizeDecisionLabel,
  type PreviousPublishedLabel,
} from "../decision-stability";
import type { DecisionLabel, DecisionOutput } from "../types";

function runSequence(rawLabels: DecisionLabel[]): {
  published: DecisionLabel[];
  suppressedDays: number[];
} {
  const published: DecisionLabel[] = [];
  const suppressedDays: number[] = [];
  let previous: PreviousPublishedLabel | null = null;
  rawLabels.forEach((raw, day) => {
    const result = applyLabelHysteresis(raw, previous);
    published.push(result.publishedLabel);
    if (result.suppressed) suppressedDays.push(day);
    previous = { publishedLabel: result.publishedLabel, rawLabel: result.rawLabel };
  });
  return { published, suppressedDays };
}

describe("hard-label hysteresis (named live flip cases 2026-07-04..06)", () => {
  it("IwaStore 946471284944193: scale->keep->scale round trip is suppressed", () => {
    const { published, suppressedDays } = runSequence(["scale", "keep", "scale"]);
    expect(published).toEqual(["keep", "keep", "keep"]);
    expect(suppressedDays).toEqual([0, 2]);
  });

  it("TheSwaf 1962656064410174: cut->keep->cut round trip is suppressed", () => {
    const { published, suppressedDays } = runSequence(["cut", "keep", "cut"]);
    expect(published).toEqual(["keep", "keep", "keep"]);
    expect(suppressedDays).toEqual([0, 2]);
  });

  it("Tiles 25889037484086563: keep->cut->keep round trip is suppressed", () => {
    const { published, suppressedDays } = runSequence(["keep", "cut", "keep"]);
    expect(published).toEqual(["keep", "keep", "keep"]);
    expect(suppressedDays).toEqual([1]);
  });

  it("exits a previously published hard action immediately when current evidence becomes soft", () => {
    const result = applyLabelHysteresis("keep", {
      publishedLabel: "cut",
      rawLabel: "cut",
    });
    expect(result).toEqual({
      publishedLabel: "keep",
      rawLabel: "keep",
      suppressed: false,
    });
  });

  it("entering a hard label also requires confirmation", () => {
    const { published } = runSequence(["keep", "cut", "cut"]);
    expect(published).toEqual(["keep", "keep", "cut"]);
  });

  it("treats refresh as a hard action that requires confirmation", () => {
    const { published } = runSequence(["keep", "refresh", "refresh"]);
    expect(published).toEqual(["keep", "keep", "refresh"]);
  });

  it("neutralizes a direct hard-action switch until the new action confirms", () => {
    const first = applyLabelHysteresis("cut", {
      publishedLabel: "scale",
      rawLabel: "scale",
    });
    const second = applyLabelHysteresis("cut", {
      publishedLabel: first.publishedLabel,
      rawLabel: first.rawLabel,
    });
    expect([first.publishedLabel, second.publishedLabel]).toEqual(["keep", "cut"]);
  });

  it("publishes a safety diagnosis immediately instead of resurrecting the previous hard action", () => {
    const result = applyLabelHysteresis("diagnose", {
      publishedLabel: "scale",
      rawLabel: "scale",
    });
    expect(result.publishedLabel).toBe("diagnose");
    expect(result.suppressed).toBe(false);
  });

  it("soft-to-soft transitions publish immediately", () => {
    const { published, suppressedDays } = runSequence([
      "test_more",
      "keep",
      "diagnose",
    ]);
    expect(published).toEqual(["test_more", "keep", "diagnose"]);
    expect(suppressedDays).toEqual([]);
  });

  it("no previous snapshot holds a hard label at canonical keep", () => {
    const result = applyLabelHysteresis("cut", null);
    expect(result.publishedLabel).toBe("keep");
    expect(result.rawLabel).toBe("cut");
    expect(result.suppressed).toBe(true);
  });

  it("uses canonical keep rather than a previous diagnostic label for pending hard entry", () => {
    const result = applyLabelHysteresis("scale", {
      publishedLabel: "diagnose",
      rawLabel: "diagnose",
    });
    expect(result).toEqual({
      publishedLabel: "keep",
      rawLabel: "scale",
      suppressed: true,
    });
  });

  it("old snapshots without raw_label still exit a hard action immediately", () => {
    const result = applyLabelHysteresis("keep", {
      publishedLabel: "cut",
      rawLabel: null,
    });
    expect(result.publishedLabel).toBe("keep");
    expect(result.suppressed).toBe(false);
  });
});

describe("stabilizeDecisionLabel", () => {
  const baseDecision: DecisionOutput = {
    creativeId: "c-1",
    creativeName: "C1",
    label: "keep",
    reason: "Recovered above target in the recent window.",
    confidence: 75,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2.2,
    ratioToTarget: 0.7,
    badges: [],
    metrics: { spend: 1000, purchases: 5, roas: 1.5, recent7dRoas: 2.4 },
    engineVersion: "v3-test",
    generatedAt: "2026-07-06T00:00:00.000Z",
  };

  it("publishes a non-hard pending state with held-action provenance", () => {
    const scaleDecision: DecisionOutput = {
      ...baseDecision,
      label: "scale",
      reason: "Winner evidence supports promotion.",
    };
    const { decision, rawLabel, suppressed } = stabilizeDecisionLabel(scaleDecision, {
      publishedLabel: "keep",
      rawLabel: "keep",
    });
    expect(suppressed).toBe(true);
    expect(rawLabel).toBe("scale");
    expect(decision.label).toBe("keep");
    expect(decision.blockedActionType).toBe("scale");
    expect(decision.reason).toContain("No hard action is published");
    expect(
      decision.badges.some((badge) => badge.type === "pending_transition"),
    ).toBe(true);
  });

  it("returns the complete current safety decision without hysteresis suppression", () => {
    const safetyDecision: DecisionOutput = {
      ...baseDecision,
      label: "diagnose",
      reason: "Policy review blocks performance action.",
      badges: [
        {
          type: "policy_blocked",
          label: "Policy block",
          severity: "warning",
        },
      ],
    };
    const result = stabilizeDecisionLabel(safetyDecision, {
      publishedLabel: "scale",
      rawLabel: "scale",
    });

    expect(result.suppressed).toBe(false);
    expect(result.decision).toBe(safetyDecision);
    expect(result.decision.label).toBe("diagnose");
  });

  it("returns the decision untouched when not suppressed", () => {
    const { decision, suppressed } = stabilizeDecisionLabel(baseDecision, {
      publishedLabel: "keep",
      rawLabel: "keep",
    });
    expect(suppressed).toBe(false);
    expect(decision).toBe(decision);
    expect(decision.badges).toHaveLength(0);
  });
});
