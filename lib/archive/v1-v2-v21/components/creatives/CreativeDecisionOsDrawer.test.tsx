import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/creatives/CreativeDecisionOsOverview", () => ({
  CreativeDecisionOsOverview: () =>
    React.createElement("div", { "data-testid": "creative-decision-os-overview-stub" }, "creative-overview-stub"),
}));

vi.mock("@/components/creatives/CreativeDecisionSupportSurface", () => ({
  CreativeDecisionSupportSurface: () =>
    React.createElement("div", { "data-testid": "creative-decision-support-surface-stub" }, "creative-support-surface-stub"),
}));

const { CreativeDecisionOsDrawer } = await import(
  "@/components/creatives/CreativeDecisionOsDrawer"
);

describe("CreativeDecisionOsDrawer", () => {
  it("renders the drawer header with decision metadata and operating mode badge", () => {
    const html = renderToStaticMarkup(
      <CreativeDecisionOsDrawer
        decisionOs={
          {
            decisionAsOf: "2026-04-10",
            decisionWindows: {
              primary30d: {
                startDate: "2026-03-11",
                endDate: "2026-04-10",
              },
            },
            summary: {
              message:
                "Decision OS highlights Scale, Test More, Protect, Refresh, Cut, and Diagnose primary decisions with review-only and reason-tag context.",
              operatingMode: "Exploit",
              totalCreatives: 40,
              scaleReadyCount: 3,
              protectedWinnerCount: 2,
              keepTestingCount: 5,
              fatiguedCount: 1,
              blockedCount: 0,
            },
          } as any
        }
        isLoading={false}
        open
        onOpenChange={vi.fn()}
        quickFilters={[]}
        allRows={[]}
        selectedRows={[]}
        activeFamilyId={null}
        activeQuickFilterKey={null}
        onSelectFamily={vi.fn()}
        onSelectQuickFilter={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    expect(html).toContain("Creative System Intelligence");
    expect(html).toContain("Decision OS");
    expect(html).toContain("2026-04-10");
    expect(html).toContain("Exploit");
    expect(html).toContain("Reset width");
    expect(html).toContain("Close Creative Decision OS");
    expect(html).toContain("Run Creative Analysis");
  });

  it("renders a manual not-run state with a run-analysis action", () => {
    const html = renderToStaticMarkup(
      <CreativeDecisionOsDrawer
        decisionOs={null}
        isLoading={false}
        snapshot={null}
        snapshotStatus="not_run"
        snapshotError={null}
        onRunAnalysis={vi.fn()}
        isRunningAnalysis={false}
        open
        onOpenChange={vi.fn()}
        quickFilters={[]}
        allRows={[]}
        selectedRows={[]}
        activeFamilyId={null}
        activeQuickFilterKey={null}
        onSelectFamily={vi.fn()}
        onSelectQuickFilter={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    expect(html).toContain("Decision OS has not been run for this scope.");
    expect(html).toContain("Run Creative Analysis");
    expect(html).toContain(
      "Reporting range changes do not recompute Creative Decision OS.",
    );
  });

  it("renders a V2.1 decision center summary without replacing the legacy drawer", () => {
    const html = renderToStaticMarkup(
      <CreativeDecisionOsDrawer
        decisionOs={null}
        decisionCenter={
          {
            contractVersion: "creative-decision-center.v2.1",
            engineVersion: "creative-decision-os.v2.1-shadow-empty",
            adapterVersion: "creative-decision-center.buyer-adapter.v0",
            configVersion: "creative-decision-center.v2.1.default",
            generatedAt: "2026-04-10T00:00:00.000Z",
            dataFreshness: { status: "unknown", maxAgeHours: null },
            inputCoverageSummary: { totalCreatives: 12 },
            missingDataSummary: {},
            todayBrief: [],
            actionBoard: {
              scale: [],
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
        isLoading={false}
        snapshotStatus="ready"
        open
        onOpenChange={vi.fn()}
        quickFilters={[]}
        allRows={[]}
        selectedRows={[]}
        activeFamilyId={null}
        activeQuickFilterKey={null}
        onSelectFamily={vi.fn()}
        onSelectQuickFilter={vi.fn()}
        onClearFilters={vi.fn()}
      />,
    );

    expect(html).toContain("Decision Center V2.1");
    expect(html).toContain("0 row decisions");
    expect(html).toContain("Legacy Decision OS remains available below.");
  });
});
