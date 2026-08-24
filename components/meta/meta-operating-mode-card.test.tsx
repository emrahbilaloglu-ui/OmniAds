import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOperatorDecisionMetadata } from "@/lib/operator-decision-metadata";
import { createEmptyBusinessCommercialCoverageSummary } from "@/src/types/business-commercial";

const metadata = buildOperatorDecisionMetadata({
  analyticsStartDate: "2026-04-01",
  analyticsEndDate: "2026-04-10",
  decisionAsOf: "2026-04-10",
});
const commercialSummary = createEmptyBusinessCommercialCoverageSummary();

let mockQuery: Record<string, unknown> = {
  isLoading: false,
  isError: false,
  data: {
    startDate: "2026-04-01",
    endDate: "2026-04-10",
    analyticsWindow: metadata.analyticsWindow,
    decisionWindows: metadata.decisionWindows,
    historicalMemory: metadata.historicalMemory,
    decisionAsOf: metadata.decisionAsOf,
    currentMode: "Exploit",
    recommendedMode: "Exploit",
    confidence: 0.82,
    why: ["Live decision-window performance is beating targets."],
    guardrails: ["Scale in controlled steps."],
    changeTriggers: ["Performance slips toward target."],
    activeCommercialInputs: [{ label: "Target ROAS", detail: "2.40x" }],
    platformInputs: [{ label: "Primary window ROAS", detail: "3.10x" }],
    missingInputs: [],
    degradedMode: {
      active: false,
      confidenceCap: null,
      reasons: [],
      safeActionLabels: [],
    },
    authority: {
      scope: "Operating Mode",
      truthState: "degraded_missing_truth",
      completeness: "missing",
      freshness: {
        status: "partial",
        updatedAt: null,
        reason: "One or more Meta decision-window sources are incomplete.",
      },
      missingInputs: ["target_pack"],
      reasons: ["Commercial truth is incomplete."],
      actionCoreCount: 0,
      watchlistCount: 1,
      archiveCount: 0,
      suppressedCount: 1,
      note: "Operating Mode is present but trust-capped by missing truth or low-signal inputs.",
    },
    commercialSummary,
  },
};

vi.mock("@tanstack/react-query", () => ({
  /**
   * Mounted pages hand this to `placeholderData` so a key change keeps the
   * previous rows on screen instead of blanking them to a skeleton. These
   * mocks never read it; the export just has to exist for the page to mount.
   */
  keepPreviousData: Symbol.for("keepPreviousData"),
  useQuery: vi.fn(() => mockQuery),
}));

const { MetaOperatingModeCard } = await import("@/components/meta/meta-operating-mode-card");

describe("MetaOperatingModeCard", () => {
  it("renders the deterministic operating-mode summary", () => {
    const html = renderToStaticMarkup(
      <MetaOperatingModeCard
        businessId="biz"
        startDate="2026-04-01"
        endDate="2026-04-10"
      />,
    );

    expect(html).toContain("Operating Mode");
    expect(html).toContain("Exploit");
    expect(html).toContain("Decisions use live windows");
    expect(html).toContain("Operating Authority");
    expect(html).toContain("Target ROAS 2.5x");
    expect(html).toContain("Commercial Drivers");
    expect(html).toContain("What changes this mode");
  });

  it("keeps a non-throwing fallback when data is unavailable", () => {
    mockQuery = {
      isLoading: false,
      isError: true,
      data: null,
    };

    const html = renderToStaticMarkup(
      <MetaOperatingModeCard
        businessId="biz"
        startDate="2026-04-01"
        endDate="2026-04-10"
      />,
    );

    expect(html).toContain("Operating mode is currently unavailable.");
  });
});
