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
