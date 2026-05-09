import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MetaAnalysisStatusCard } from "@/components/meta/meta-analysis-status-card";
import type { MetaAnalysisStatus } from "@/lib/meta/analysis-state";

function status(overrides: Partial<MetaAnalysisStatus> = {}): MetaAnalysisStatus {
  return {
    state: "not_run",
    decisionOsStatus: "archived",
    decisionOsLabel: "Archived",
    recommendationSource: "none",
    recommendationSourceLabel: "None",
    presentationMode: "no_guidance",
    presentationModeLabel: "No guidance",
    isAnalysisRunning: false,
    message: "Run analysis to generate snapshot-backed recommendation context.",
    detailReasons: [],
    safeErrorMessage: null,
    rangeMismatch: false,
    analyzedRangeLabel: null,
    lastAnalyzedAtIso: null,
    ...overrides,
  };
}

describe("MetaAnalysisStatusCard", () => {
  it("renders initial not-run state", () => {
    const html = renderToStaticMarkup(<MetaAnalysisStatusCard status={status()} />);

    expect(html).toContain("Analysis status");
    expect(html).toContain("Decision OS: Archived");
    expect(html).toContain("Recommendation source: None");
    expect(html).toContain("Presentation: No guidance");
    expect(html).toContain("Run analysis to generate snapshot-backed recommendation context.");
  });

  it("renders fallback source and analyzed range", () => {
    const html = renderToStaticMarkup(
      <MetaAnalysisStatusCard
        status={status({
          state: "recommendation_fallback",
          decisionOsStatus: "archived",
          decisionOsLabel: "Archived",
          recommendationSource: "snapshot_fallback",
          recommendationSourceLabel: "Snapshot fallback",
          presentationMode: "fallback_context",
          presentationModeLabel: "Fallback context",
          message: "Showing snapshot-backed recommendation context.",
          detailReasons: ["meta_engine_v1_snapshot"],
          analyzedRangeLabel: "2026-04-01 to 2026-04-21",
          lastAnalyzedAtIso: "2026-04-21T10:00:00.000Z",
        })}
      />,
    );

    expect(html).toContain("Decision OS: Archived");
    expect(html).toContain("Recommendation source: Snapshot fallback");
    expect(html).toContain("Presentation: Fallback context");
    expect(html).toContain("Last successful analysis at 2026-04-21 10:00 UTC.");
    expect(html).toContain("Analyzed for 2026-04-01 to 2026-04-21.");
    expect(html).not.toContain("Decision OS last analyzed");
    expect(html).toContain("meta_engine_v1_snapshot");
  });

  it("renders safe recommendation errors without exposing raw errors", () => {
    const html = renderToStaticMarkup(
      <MetaAnalysisStatusCard
        status={status({
          state: "error",
          decisionOsStatus: "error",
          decisionOsLabel: "Error",
          recommendationSource: "none",
          recommendationSourceLabel: "None",
          presentationMode: "error",
          presentationModeLabel: "Error",
          message: "Recommendations could not complete safely.",
          safeErrorMessage: "Analysis could not complete safely. Run analysis again for this range.",
          analyzedRangeLabel: "2026-04-01 to 2026-04-21",
          lastAnalyzedAtIso: "2026-04-21T10:00:00.000Z",
        })}
      />,
    );

    expect(html).toContain("Decision OS: Error");
    expect(html).toContain("Recommendation source: None");
    expect(html).toContain("Presentation: Error");
    expect(html).toContain("Recommendations could not complete safely");
    expect(html).toContain("Last successful analysis at 2026-04-21 10:00 UTC.");
    expect(html).not.toContain("Decision OS last analyzed");
  });

  it("renders demo source as context rather than no guidance", () => {
    const html = renderToStaticMarkup(
      <MetaAnalysisStatusCard
        status={status({
          recommendationSource: "demo",
          recommendationSourceLabel: "Demo",
          presentationMode: "demo_context",
          presentationModeLabel: "Demo context",
          message: "Showing demo recommendation context for this range.",
        })}
      />,
    );

    expect(html).toContain("Recommendation source: Demo");
    expect(html).toContain("Presentation: Demo context");
    expect(html).not.toContain("Presentation: No guidance");
  });

  it("separates running analysis from Decision OS surface status", () => {
    const html = renderToStaticMarkup(
      <MetaAnalysisStatusCard
        status={status({
          state: "running",
          presentationMode: "loading",
          presentationModeLabel: "Loading",
          isAnalysisRunning: true,
          message: "Analysis is running for the selected range.",
        })}
      />,
    );

    expect(html).toContain("Analysis: Running");
    expect(html).toContain("Decision OS: Archived");
  });
});
