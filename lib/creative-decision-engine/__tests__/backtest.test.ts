import { describe, expect, it } from "vitest";
import {
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
