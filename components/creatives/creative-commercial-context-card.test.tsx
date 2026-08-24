import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildOperatorDecisionMetadata } from "@/lib/operator-decision-metadata";

const metadata = buildOperatorDecisionMetadata({
  analyticsStartDate: "2026-04-01",
  analyticsEndDate: "2026-04-10",
  decisionAsOf: "2026-04-10",
});

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
    currentMode: "Margin Protect",
    recommendedMode: "Margin Protect",
    confidence: 0.74,
    why: ["Live decision-window performance is below break-even."],
    guardrails: ["Restrict scaling until margin pressure clears."],
    changeTriggers: [],
    activeCommercialInputs: [
      { label: "Break-even ROAS", detail: "1.60x" },
      { label: "Target ROAS", detail: "2.30x" },
    ],
    platformInputs: [],
    missingInputs: ["Meta location breakdown is unavailable for the live decision window."],
    degradedMode: {
      active: false,
      confidenceCap: null,
      reasons: [],
      safeActionLabels: [],
    },
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

const { CreativeCommercialContextCard } = await import(
  "@/components/creatives/creative-commercial-context-card"
);

describe("CreativeCommercialContextCard", () => {
  it("renders commercial context without touching AI commentary labels", () => {
    const html = renderToStaticMarkup(
      <CreativeCommercialContextCard
        businessId="biz"
        startDate="2026-04-01"
        endDate="2026-04-10"
      />,
    );

    expect(html).toContain("Commercial Context");
    expect(html).toContain("Margin Protect");
    expect(html).toContain("Decisions use live windows");
    expect(html).toContain("Guardrail");
    expect(html).toContain("Missing inputs:");
  });

  it("shows a quiet fallback when the context route fails", () => {
    mockQuery = {
      isLoading: false,
      isError: true,
      data: null,
    };

    const html = renderToStaticMarkup(
      <CreativeCommercialContextCard
        businessId="biz"
        startDate="2026-04-01"
        endDate="2026-04-10"
      />,
    );

    expect(html).toContain("Commercial context is unavailable for the live decision windows.");
  });
});
