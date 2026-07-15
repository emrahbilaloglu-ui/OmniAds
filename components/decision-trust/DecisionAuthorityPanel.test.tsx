import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DecisionAuthorityPanel } from "@/components/decision-trust/DecisionAuthorityPanel";
import { createEmptyBusinessCommercialCoverageSummary } from "@/src/types/business-commercial";

describe("DecisionAuthorityPanel", () => {
  it("renders thresholds, action ceilings, and blocking reasons", () => {
    const summary = createEmptyBusinessCommercialCoverageSummary();
    const html = renderToStaticMarkup(
      <DecisionAuthorityPanel
        title="Meta Authority"
        authority={{
          scope: "Meta Decision OS",
          truthState: "degraded_missing_truth",
          completeness: "missing",
          freshness: {
            status: "stale",
            updatedAt: null,
            reason: "Country breakdown data is partial.",
          },
          missingInputs: ["target_pack", "country_economics"],
          reasons: ["Commercial truth is incomplete."],
          actionCoreCount: 2,
          watchlistCount: 4,
          archiveCount: 8,
          suppressedCount: 12,
          note: "Meta Decision OS remains visible but trust-capped by missing commercial truth.",
        }}
        commercialSummary={summary}
      />,
    );

    expect(html).toContain("Meta Authority");
    expect(html).toContain("Target ROAS 2.5x");
    expect(html).toContain("Action Ceilings");
    expect(html).toContain("review hold");
    expect(html).toContain("Blocking Reasons");
    expect(html).toContain("target_pack");
  });

  it("does not present target age as a blocking truth gap", () => {
    const summary = createEmptyBusinessCommercialCoverageSummary();
    const reviewReason =
      "Target pack thresholds are older than 30 days and should be reviewed.";
    summary.completeness = "complete";
    summary.freshness = {
      status: "fresh",
      updatedAt: "2026-07-14T00:00:00.000Z",
      ageHours: 24,
      reason: null,
    };
    summary.blockingReasons = [];
    summary.nonBlockingReasons = [reviewReason];
    summary.actionCeilings = [];
    summary.requiredInputs = summary.requiredInputs.map((input) => {
      if (input.section === "targetPack") {
        return {
          ...input,
          freshness: {
            status: "stale" as const,
            updatedAt: "2026-05-01T00:00:00.000Z",
            ageHours: 1_800,
            reason: reviewReason,
          },
          reason: reviewReason,
          actionCeiling: null,
        };
      }
      if (input.section === "operatingConstraints") {
        return {
          ...input,
          freshness: {
            status: "fresh" as const,
            updatedAt: "2026-07-14T00:00:00.000Z",
            ageHours: 24,
            reason: null,
          },
          reason: "Operating constraints are configured.",
          actionCeiling: null,
        };
      }
      return input;
    });

    const html = renderToStaticMarkup(
      <DecisionAuthorityPanel commercialSummary={summary} />,
    );

    expect(html).not.toContain("Blocking Truth Gaps");
    expect(html).not.toContain("Blocking Reasons");
    expect(html).toContain("target pack: stale");
  });
});
