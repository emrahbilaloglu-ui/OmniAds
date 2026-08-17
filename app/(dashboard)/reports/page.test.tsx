// @vitest-environment jsdom

import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const appState = {
  selectedBusinessId: "biz",
  businesses: [{ id: "biz", name: "Aurora Supply Co.", currency: "USD" }],
};

vi.mock("@/store/app-store", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(appState),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("@/components/pricing/PlanGate", () => ({
  PlanGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/states/useTierZeroFreshness", () => ({
  useTierZeroFreshness: vi.fn(),
}));

const { default: ReportsPage } = await import("./legacy-page");

const SAVED_REPORT = {
  id: "report-1",
  businessId: "biz",
  name: "Weekly Exec Summary",
  description: "Top-line blended performance.",
  templateId: "one-click-paid-media",
  definition: {
    version: 1,
    dateRangePreset: "28",
    compareMode: "previous_period",
    widgets: [
      {
        id: "w1",
        type: "metric",
        slot: 0,
        colSpan: 1,
        rowSpan: 1,
        size: "S",
        title: "Spend",
        dataSource: "overview_summary",
        metricKey: "spend",
      },
    ],
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

function mountReports(props: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReportsPage {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  appState.selectedBusinessId = "biz";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/reports?")) {
        return new Response(
          JSON.stringify({ reports: [SAVED_REPORT], generatedAt: "2026-08-17T09:00:00.000Z" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/reports/render") {
        return new Response(
          JSON.stringify({
            report: {
              businessId: "biz",
              name: "Weekly Exec Summary",
              dateRangeLabel: "Last 28 Days",
              startDate: "2026-07-17",
              endDate: "2026-08-13",
              generatedAt: "2026-08-17T09:00:00.000Z",
              widgets: [
                {
                  id: "w1",
                  slot: 0,
                  colSpan: 1,
                  rowSpan: 1,
                  type: "metric",
                  title: "Spend",
                  value: "$118,220",
                  deltaLabel: "+8.1%",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("/reports lists real saved reports", () => {
  it("reads the business's reports from the reports API", async () => {
    mountReports();
    await waitFor(() => expect(screen.getByText("Weekly Exec Summary")).toBeTruthy());
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/reports?businessId=biz",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("derives the row's meta line from the stored document, not from a seed value", async () => {
    mountReports();
    await waitFor(() => expect(screen.getByText(/1 block/)).toBeTruthy());
    expect(screen.getByText(/updated Aug 12 · 1 block · Blended/)).toBeTruthy();
    expect(screen.queryByText(/\$118,220/)).toBeNull();
  });

  it("withholds the surface entirely when no business is selected", () => {
    appState.selectedBusinessId = "";
    mountReports();
    expect(screen.queryByRole("heading", { level: 1, name: "Reports" })).toBeNull();
  });
});

describe("/reports builder renders measured figures", () => {
  it("puts a deep-linked report on the builder tab with real block values", async () => {
    mountReports({ initialTab: "builder", initialReportId: "report-1" });
    await waitFor(() => expect(screen.getByText("$118,220")).toBeTruthy());
    expect(screen.getByText("+8.1%")).toBeTruthy();
    expect(screen.getByText("Aurora Supply Co. · 2026-07-17 – 2026-08-13 · Page 1")).toBeTruthy();
  });

  it("opens a blank builder without writing anything", async () => {
    mountReports({ initialTab: "builder" });
    await waitFor(() => expect(screen.getByText("0 blocks")).toBeTruthy());
    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((call) => String(call[0]) === "/api/reports" )).toBe(false);
  });
});

describe("every route family reaches the same exact component", () => {
  const routes = [
    "app/(dashboard)/reports/legacy-page.tsx",
    "app/(dashboard)/reports/new/legacy-page.tsx",
    "app/(dashboard)/reports/[reportId]/edit/legacy-page.tsx",
    "app/c/[businessId]/reports/page.tsx",
    "app/c/[businessId]/reports/new/page.tsx",
    "app/c/[businessId]/reports/[reportId]/edit/page.tsx",
  ];

  for (const route of routes) {
    it(`${route} mounts the Reports screen`, () => {
      const source = readFileSync(route, "utf8");
      const mountsContainer = source.includes("reports-exact-container");
      const mountsScreen = source.includes('app/(dashboard)/reports/legacy-page"');
      expect(mountsContainer || mountsScreen).toBe(true);
    });
  }

  it("keeps the business authorization on every canonical route", () => {
    for (const route of routes.filter((path) => path.startsWith("app/c/"))) {
      const source = readFileSync(route, "utf8");
      expect(source).toContain("requireBusinessPageContext");
      expect(source).toContain("getSessionFromCookies");
    }
  });

  it("no longer ships the replaced builder", () => {
    expect(() => readFileSync("components/reports/report-builder.tsx", "utf8")).toThrow();
  });
});
