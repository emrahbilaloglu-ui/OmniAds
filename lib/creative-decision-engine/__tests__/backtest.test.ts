import { describe, expect, it } from "vitest";
import {
  computeExpectedCalibrationError,
  summarizeDecisionBacktest,
  summarizeDecisionBacktestByLabelAndWeek,
} from "../backtest";

describe("summarizeDecisionBacktest", () => {
  it("computes hard-action precision, recall, calibration, coverage, and conflict gates", () => {
    const summary = summarizeDecisionBacktest({
      rows: [
        {
          creativeId: "c1",
          asOfDate: "2026-05-03",
          label: "cut",
          confidence: 90,
          realizedOutcome: "positive",
          severity: "high",
        },
        {
          creativeId: "c2",
          asOfDate: "2026-05-03",
          label: "scale",
          confidence: 80,
          realizedOutcome: "negative",
          severity: "critical",
        },
        {
          creativeId: "c3",
          asOfDate: "2026-05-04",
          label: "keep",
          confidence: 40,
          realizedOutcome: "positive",
          severity: "high",
        },
      ],
      coverage: {
        activeCreativeCount: 3,
        snapshotRowCount: 3,
        staleSnapshotCount: 0,
        conflictingSnapshotCount: 1,
      },
    });

    expect(summary.hardActionPrecision).toBe(0.5);
    expect(summary.hardActionRecall).toBe(0.5);
    expect(summary.criticalFalsePositiveRate).toBe(0.5);
    expect(summary.highSeverityMissedOpportunityRate).toBe(0.5);
    expect(summary.activeDecisionCoverage).toBe(1);
    expect(summary.persistedCoveragePass).toBe(true);
    expect(summary.conflictFreePass).toBe(false);
  });

  it("does not treat safe non-hard outcomes as missed hard-action demand", () => {
    const summary = summarizeDecisionBacktest({
      rows: [
        {
          creativeId: "c1",
          asOfDate: "2026-05-04",
          label: "cut",
          confidence: 90,
          realizedOutcome: "positive",
          severity: "high",
        },
        {
          creativeId: "c2",
          asOfDate: "2026-05-04",
          label: "keep",
          confidence: 40,
          realizedOutcome: "negative",
          severity: "low",
        },
      ],
      coverage: {
        activeCreativeCount: 2,
        snapshotRowCount: 2,
        staleSnapshotCount: 0,
        conflictingSnapshotCount: 0,
      },
    });

    expect(summary.hardActionRecall).toBe(1);
    expect(summary.highSeverityMissedOpportunityRate).toBe(0);
  });

  it("excludes unknown and inconclusive hard outcomes from judged precision", () => {
    const summary = summarizeDecisionBacktest({
      rows: [
        { creativeId: "tp", asOfDate: "2026-05-04", label: "cut", confidence: 90, realizedOutcome: "positive" },
        { creativeId: "fp", asOfDate: "2026-05-04", label: "scale", confidence: 80, realizedOutcome: "negative" },
        { creativeId: "unknown", asOfDate: "2026-05-04", label: "cut", confidence: 70, realizedOutcome: "unknown" },
        { creativeId: "neutral", asOfDate: "2026-05-04", label: "refresh", confidence: 60, realizedOutcome: "neutral" },
      ],
      coverage: {
        activeCreativeCount: 4,
        snapshotRowCount: 4,
        staleSnapshotCount: 0,
        conflictingSnapshotCount: 0,
      },
    });

    expect(summary.hardActionPrecision).toBe(0.5);
    expect(summary.hardActionKnownSampleSize).toBe(2);
  });

  it("excludes out-of-scope rows from the recall opportunity set", () => {
    const summary = summarizeDecisionBacktest({
      rows: [
        { creativeId: "tp", asOfDate: "2026-05-04", label: "cut", confidence: 90, realizedOutcome: "positive" },
        { creativeId: "excluded", asOfDate: "2026-05-04", label: "out_of_scope", confidence: 0, realizedOutcome: "positive" },
      ],
      coverage: {
        activeCreativeCount: 2,
        snapshotRowCount: 2,
        staleSnapshotCount: 0,
        conflictingSnapshotCount: 0,
      },
    });

    expect(summary.hardActionRecall).toBe(1);
  });

  it("segments realized outcome metrics by decision label and decision week", () => {
    const segments = summarizeDecisionBacktestByLabelAndWeek({
      rows: [
        {
          creativeId: "c1",
          asOfDate: "2026-05-03",
          label: "cut",
          confidence: 90,
          realizedOutcome: "positive",
          severity: "high",
        },
        {
          creativeId: "c2",
          asOfDate: "2026-05-05",
          label: "cut",
          confidence: 70,
          realizedOutcome: "negative",
          severity: "medium",
        },
        {
          creativeId: "c3",
          asOfDate: "2026-05-11",
          label: "scale",
          confidence: 80,
          realizedOutcome: "positive",
          severity: "high",
        },
      ],
      coverage: {
        activeCreativeCount: 3,
        snapshotRowCount: 3,
        staleSnapshotCount: 0,
        conflictingSnapshotCount: 0,
      },
      coverageByWeek: {
        "2026-05-04": {
          activeCreativeCount: 2,
          snapshotRowCount: 2,
          staleSnapshotCount: 0,
          conflictingSnapshotCount: 0,
        },
      },
      minSegmentSampleSize: 2,
    });

    expect(segments).toEqual([
      expect.objectContaining({
        label: "cut",
        weekStartDate: "2026-04-27",
        coverageScope: "global",
        hardActionPrecision: null,
        hardActionRecall: null,
        expectedCalibrationError: null,
        sampleSize: 1,
        sampleReliable: false,
        confidenceLevel: "insufficient_sample",
        nonComputableReason: "insufficient_segment_sample_size",
      }),
      expect.objectContaining({
        label: "cut",
        weekStartDate: "2026-05-04",
        coverageScope: "week",
        hardActionPrecision: null,
        hardActionRecall: null,
        expectedCalibrationError: null,
        sampleSize: 1,
        sampleReliable: false,
        confidenceLevel: "insufficient_sample",
        nonComputableReason: "insufficient_segment_sample_size",
      }),
      expect.objectContaining({
        label: "scale",
        weekStartDate: "2026-05-11",
        coverageScope: "global",
        hardActionPrecision: null,
        hardActionRecall: null,
        expectedCalibrationError: null,
        sampleSize: 1,
        sampleReliable: false,
        confidenceLevel: "insufficient_sample",
        nonComputableReason: "insufficient_segment_sample_size",
      }),
    ]);
  });

  it("computes segment recall from the complete weekly opportunity set", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, index) => ({
        creativeId: `cut-${index}`,
        asOfDate: "2026-05-05",
        label: "cut" as const,
        confidence: 90,
        realizedOutcome: "positive" as const,
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        creativeId: `miss-${index}`,
        asOfDate: "2026-05-05",
        label: "keep" as const,
        confidence: 60,
        realizedOutcome: "positive" as const,
      })),
    ];
    const segments = summarizeDecisionBacktestByLabelAndWeek({
      rows,
      coverage: {
        activeCreativeCount: 60,
        snapshotRowCount: 60,
        staleSnapshotCount: 0,
        conflictingSnapshotCount: 0,
      },
      minSegmentSampleSize: 30,
    });

    const cut = segments.find((segment) => segment.label === "cut");
    const keep = segments.find((segment) => segment.label === "keep");
    expect(cut).toMatchObject({
      hardActionPrecision: 1,
      hardActionRecall: 0.5,
      hardActionRecallScope: "week_opportunity_set",
      hardActionRecallSampleSize: 60,
      hardActionRecallReliable: true,
    });
    expect(keep?.hardActionRecall).toBe(0.5);
  });
});

describe("computeExpectedCalibrationError", () => {
  it("measures calibration on hard-action rows only", () => {
    const hardOnly = computeExpectedCalibrationError([
      {
        creativeId: "c1",
        asOfDate: "2026-05-03",
        label: "cut",
        confidence: 85,
        realizedOutcome: "positive",
        severity: "high",
      },
    ]);
    // A confident correct keep must not register as calibration error: for
    // non-hard labels "positive" flags a missed action (opposite polarity).
    const withConfidentKeeps = computeExpectedCalibrationError([
      {
        creativeId: "c1",
        asOfDate: "2026-05-03",
        label: "cut",
        confidence: 85,
        realizedOutcome: "positive",
        severity: "high",
      },
      {
        creativeId: "c2",
        asOfDate: "2026-05-03",
        label: "keep",
        confidence: 85,
        realizedOutcome: "negative",
        severity: "low",
      },
      {
        creativeId: "c3",
        asOfDate: "2026-05-03",
        label: "keep",
        confidence: 85,
        realizedOutcome: "negative",
        severity: "low",
      },
    ]);
    expect(withConfidentKeeps).toBe(hardOnly);
  });

  it("returns null when there are no known hard-action rows", () => {
    expect(
      computeExpectedCalibrationError([
        {
          creativeId: "c1",
          asOfDate: "2026-05-03",
          label: "keep",
          confidence: 60,
          realizedOutcome: "negative",
          severity: "low",
        },
        {
          creativeId: "c2",
          asOfDate: "2026-05-03",
          label: "cut",
          confidence: 90,
          realizedOutcome: "unknown",
          severity: "high",
        },
      ]),
    ).toBeNull();
  });

  it("uses actual confidence and excludes inconclusive hard outcomes", () => {
    expect(
      computeExpectedCalibrationError([
        {
          creativeId: "correct",
          asOfDate: "2026-05-03",
          label: "cut",
          confidence: 81,
          realizedOutcome: "positive",
        },
        {
          creativeId: "inconclusive",
          asOfDate: "2026-05-03",
          label: "scale",
          confidence: 99,
          realizedOutcome: "neutral",
        },
      ]),
    ).toBe(0.19);
  });
});

describe("hardConfidenceBuckets", () => {
  it("reports observed positive rates per confidence decade over hard known rows", () => {
    const summary = summarizeDecisionBacktest({
      rows: [
        { creativeId: "c1", asOfDate: "2026-05-03", label: "cut", confidence: 72, realizedOutcome: "positive", severity: "high" },
        { creativeId: "c2", asOfDate: "2026-05-03", label: "cut", confidence: 78, realizedOutcome: "negative", severity: "high" },
        { creativeId: "c3", asOfDate: "2026-05-03", label: "scale", confidence: 85, realizedOutcome: "positive", severity: "high" },
        { creativeId: "c4", asOfDate: "2026-05-03", label: "keep", confidence: 75, realizedOutcome: "positive", severity: "high" },
        { creativeId: "c5", asOfDate: "2026-05-03", label: "cut", confidence: 71, realizedOutcome: "unknown", severity: "high" },
      ],
      coverage: { activeCreativeCount: 5, snapshotRowCount: 5, staleSnapshotCount: 0, conflictingSnapshotCount: 0 },
    });
    expect(summary.hardConfidenceBuckets).toEqual([
      { bucket: "70_79", known: 2, positive: 1, observedRate: 0.5 },
      { bucket: "80_89", known: 1, positive: 1, observedRate: 1 },
    ]);
  });
});
