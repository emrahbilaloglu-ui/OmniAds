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
    expect(published).toEqual(["scale", "scale", "scale"]);
    expect(suppressedDays).toEqual([1]);
  });

  it("TheSwaf 1962656064410174: cut->keep->cut round trip is suppressed", () => {
    const { published, suppressedDays } = runSequence(["cut", "keep", "cut"]);
    expect(published).toEqual(["cut", "cut", "cut"]);
    expect(suppressedDays).toEqual([1]);
  });

  it("Tiles 25889037484086563: keep->cut->keep round trip is suppressed", () => {
    const { published, suppressedDays } = runSequence(["keep", "cut", "keep"]);
    expect(published).toEqual(["keep", "keep", "keep"]);
    expect(suppressedDays).toEqual([1]);
  });

  it("a genuine sustained hard transition confirms after exactly one held day", () => {
    const { published } = runSequence(["cut", "keep", "keep", "keep"]);
    expect(published).toEqual(["cut", "cut", "keep", "keep"]);
  });

  it("entering a hard label also requires confirmation", () => {
    const { published } = runSequence(["keep", "cut", "cut"]);
    expect(published).toEqual(["keep", "keep", "cut"]);
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

  it("no previous snapshot publishes the raw label (clean epoch start)", () => {
    const result = applyLabelHysteresis("cut", null);
    expect(result.publishedLabel).toBe("cut");
    expect(result.suppressed).toBe(false);
  });

  it("old snapshots without raw_label fall back to published label memory", () => {
    const result = applyLabelHysteresis("keep", {
      publishedLabel: "cut",
      rawLabel: null,
    });
    expect(result.publishedLabel).toBe("cut");
    expect(result.suppressed).toBe(true);
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

  it("keeps yesterday's label with a pending badge and reason prefix when suppressed", () => {
    const { decision, rawLabel, suppressed } = stabilizeDecisionLabel(baseDecision, {
      publishedLabel: "cut",
      rawLabel: "cut",
    });
    expect(suppressed).toBe(true);
    expect(rawLabel).toBe("keep");
    expect(decision.label).toBe("cut");
    expect(decision.reason.startsWith("[Pending transition")).toBe(true);
    expect(
      decision.badges.some((badge) => badge.type === "pending_transition"),
    ).toBe(true);
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
