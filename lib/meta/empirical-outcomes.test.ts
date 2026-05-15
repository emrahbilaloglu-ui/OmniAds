import { describe, expect, it } from "vitest";
import {
  classifyMetaDecisionOutcomeStatus,
  summarizeMetaDecisionOutcomes,
} from "@/lib/meta/empirical-outcomes";

function rows(statuses: string[]) {
  return statuses.map((outcomeStatus) => ({ outcomeStatus }));
}

describe("Meta empirical outcomes", () => {
  it("normalizes outcome status vocabulary", () => {
    expect(classifyMetaDecisionOutcomeStatus("profitable")).toBe("positive");
    expect(classifyMetaDecisionOutcomeStatus("regressed")).toBe("negative");
    expect(classifyMetaDecisionOutcomeStatus("mixed")).toBe("neutral");
    expect(classifyMetaDecisionOutcomeStatus(null)).toBe("unknown");
  });

  it("requires enough sample before emitting a confidence band", () => {
    const summary = summarizeMetaDecisionOutcomes(rows(["positive", "positive", "negative"]), {
      minSampleSize: 5,
    });

    expect(summary).toMatchObject({
      sampleSize: 3,
      judgedSampleSize: 3,
      positiveCount: 2,
      negativeCount: 1,
      confidenceBand: "insufficient_sample",
      autoEligible: false,
    });
  });

  it("marks high precision with low negative rate as auto eligible", () => {
    const summary = summarizeMetaDecisionOutcomes(
      rows([
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "positive",
        "neutral",
      ]),
      { minSampleSize: 10 },
    );

    expect(summary).toMatchObject({
      sampleSize: 10,
      judgedSampleSize: 9,
      positiveCount: 9,
      negativeCount: 0,
      precision: 1,
      negativeRate: 0,
      confidenceBand: "high",
      autoEligible: true,
    });
  });

  it("keeps weak precision below auto eligibility", () => {
    const summary = summarizeMetaDecisionOutcomes(
      rows(["positive", "positive", "positive", "negative", "negative", "negative", "neutral", "neutral", "neutral", "neutral"]),
      { minSampleSize: 10 },
    );

    expect(summary.confidenceBand).toBe("low");
    expect(summary.autoEligible).toBe(false);
  });
});
