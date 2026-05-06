import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CreativeDecisionCenterSurface } from "@/components/creatives/CreativeDecisionCenterSurface";

describe("CreativeDecisionCenterSurface", () => {
  it("renders no UI when the additive snapshot is absent", () => {
    const html = renderToStaticMarkup(<CreativeDecisionCenterSurface decisionCenter={null} />);

    expect(html).toBe("");
  });

  it("renders Today Brief and Action Board from the additive snapshot", () => {
    const html = renderToStaticMarkup(
      <CreativeDecisionCenterSurface
        decisionCenter={
          {
            contractVersion: "creative-decision-center.v2.1",
            engineVersion: "creative-decision-os.v2.1-shadow-empty",
            adapterVersion: "creative-decision-center.buyer-adapter.v0",
            configVersion: "creative-decision-center.v2.1.default",
            generatedAt: "2026-04-10T00:00:00.000Z",
            dataFreshness: { status: "unknown", maxAgeHours: null },
            inputCoverageSummary: { totalCreatives: 3 },
            missingDataSummary: {},
            todayBrief: [
              {
                id: "brief_1",
                priority: "high",
                text: "Review one scale candidate.",
                rowIds: ["row_1"],
              },
            ],
            actionBoard: {
              scale: ["row_1"],
              cut: [],
              refresh: [],
              protect: [],
              test_more: [],
              watch_launch: [],
              fix_delivery: [],
              fix_policy: [],
              diagnose_data: [],
            },
            rowDecisions: [],
            aggregateDecisions: [],
          } as any
        }
      />,
    );

    expect(html).toContain("Decision Center V2.1");
    expect(html).toContain("Review one scale candidate.");
    expect(html).toContain("Action Board");
    expect(html).toContain("Scale");
  });
});
