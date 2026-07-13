import { describe, expect, it } from "vitest";
import {
  aggregateRows,
  sha256Text,
  validateCompatibleReports,
  type Row,
  type SweepReport,
} from "@/scripts/creative-decision-center/multi-window-robustness-summary";

function row(overrides: Partial<Row> = {}): Row {
  return {
    windowId: "window-1",
    business: "Business 1",
    variantId: "V1",
    rowsEvaluated: 10,
    episodes: 1,
    defensible: false,
    known14: 1,
    recovered14: 0,
    earlyRate14: 0,
    trueLosers14: 1,
    savedUnits14: 10,
    baselineKnown14: 1,
    baselineRecovered14: 0,
    baselineEarlyRate14: 0,
    baselineSavedUnits14: 4,
    earlyDeltaPp: 0,
    savedDeltaUnits14: 6,
    affectedDailyRowsVsBaseline: 1,
    affectedDailyRowRate: 0.1,
    lossBudgetGeHardCutEpisodes: 0,
    ...overrides,
  };
}

function report(overrides: Partial<SweepReport> = {}): SweepReport {
  return {
    contractVersion: "adsecute.f1-f2-cut-threshold-sweep.v1",
    revision: 4,
    title: "test",
    asOf: "2026-01-31",
    generatedAt: "2026-02-01T00:00:00.000Z",
    engineVersion: "engine-v1",
    reviews: [],
    ...overrides,
  };
}

describe("multi-window robustness aggregation", () => {
  it("sums saved-unit deltas only over pairwise-complete windows", () => {
    const [aggregate] = aggregateRows([
      row(),
      row({ windowId: "window-2", savedUnits14: 5, baselineSavedUnits14: null }),
      row({ windowId: "window-3", savedUnits14: null, baselineSavedUnits14: 2 }),
    ]);

    expect(aggregate).toMatchObject({
      windows: 3,
      savedUnits14: 10,
      baselineSavedUnits14: 4,
      savedDeltaUnits14: 6,
      savedUnitsNullWindows: 1,
      baselineSavedUnitsNullWindows: 1,
    });
  });

  it("rejects mixed revisions and engine versions", () => {
    expect(() => validateCompatibleReports([report(), report({ revision: 3 })])).toThrow(
      "Input revisions are incompatible",
    );
    expect(() =>
      validateCompatibleReports([report(), report({ engineVersion: "engine-v2" })]),
    ).toThrow("Input engine versions are incompatible");
  });

  it("rejects unsupported contracts and revisions", () => {
    expect(() => validateCompatibleReports([report({ contractVersion: "other" })])).toThrow(
      "incompatible contract",
    );
    expect(() => validateCompatibleReports([report({ revision: 2 })])).toThrow(
      "unsupported revision",
    );
  });

  it("hashes exact input bytes deterministically", () => {
    expect(sha256Text("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
