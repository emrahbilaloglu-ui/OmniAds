import { describe, expect, it, vi, beforeEach } from "vitest";

const getIntegrationStatusByBusiness = vi.hoisted(() => vi.fn());
const getProviderAccountAssignments = vi.hoisted(() => vi.fn());
const getMetaCanonicalOverviewSummary = vi.hoisted(() => vi.fn());
const getMetaCanonicalOverviewTrends = vi.hoisted(() => vi.fn());
const getMetaBreakdownsForRange = vi.hoisted(() => vi.fn());
const getMetaCampaignsForRange = vi.hoisted(() => vi.fn());
const readMetaAnomaliesForBusiness = vi.hoisted(() => vi.fn());
const readMetaCampaignLabels = vi.hoisted(() => vi.fn());
const readMetaDecisionsWorkspaceReadModel = vi.hoisted(() => vi.fn());

vi.mock("@/lib/integration-status", () => ({ getIntegrationStatusByBusiness }));
vi.mock("@/lib/provider-account-assignments", () => ({ getProviderAccountAssignments }));
vi.mock("@/lib/meta/canonical-overview", () => ({
  getMetaCanonicalOverviewSummary,
  getMetaCanonicalOverviewTrends,
}));
vi.mock("@/lib/meta/breakdowns-source", () => ({ getMetaBreakdownsForRange }));
vi.mock("@/lib/meta/campaigns-source", () => ({ getMetaCampaignsForRange }));
vi.mock("@/lib/meta/anomalies", () => ({ readMetaAnomaliesForBusiness }));
vi.mock("@/lib/meta/campaign-labels", () => ({ readMetaCampaignLabels }));
vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  readMetaDecisionsWorkspaceReadModel,
}));

import { readMetaIntelligence } from "@/lib/zero-base/meta/intelligence-server";

const WINDOW = { startDate: "2026-07-15", endDate: "2026-08-11" };

function read() {
  return readMetaIntelligence({ businessId: "biz-1", ...WINDOW, now: new Date("2026-08-11T12:00:00Z") });
}

describe("account intelligence composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    getMetaCampaignsForRange.mockResolvedValue({ campaigns: [{}, {}] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({
      readSource: "warehouse_published",
      isPartial: false,
    });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [{}, {}, {}], isPartial: false });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready", isPartial: false });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [{}] });
    readMetaCampaignLabels.mockResolvedValue([{}, {}]);
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({ structureRows: [{}] });
  });

  it("composes every named authority as its own section", async () => {
    const result = await read();
    expect(result.sections.map((item) => item.key)).toEqual([
      "status",
      "pulse",
      "summary",
      "trends",
      "breakdowns",
      "anomalies",
      "labels",
      "structure",
    ]);
    expect(result.providerAccountId).toBe("act_1");
  });

  it("actually calls each read model, scoped to the same window", async () => {
    await read();
    for (const spy of [
      getMetaCampaignsForRange,
      getMetaCanonicalOverviewSummary,
      getMetaCanonicalOverviewTrends,
      getMetaBreakdownsForRange,
    ]) {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject(WINDOW);
    }
    expect(readMetaAnomaliesForBusiness).toHaveBeenCalledTimes(1);
    expect(readMetaCampaignLabels).toHaveBeenCalledTimes(1);
    expect(readMetaDecisionsWorkspaceReadModel).toHaveBeenCalledTimes(1);
  });

  it("carries served counts rather than inventing metrics", async () => {
    const result = await read();
    expect(result.sections.find((s) => s.key === "trends")?.facts).toEqual([
      { label: "Trend points", value: "3" },
    ]);
    expect(result.sections.find((s) => s.key === "anomalies")?.facts).toEqual([
      { label: "Active anomalies", value: "1" },
    ]);
  });

  it("says a count was not reported rather than printing zero", async () => {
    getMetaCanonicalOverviewTrends.mockResolvedValue({ isPartial: false });
    const result = await read();
    // A missing collection is unknown, and 0 would be a measurement nobody took.
    expect(result.sections.find((s) => s.key === "trends")?.facts[0].value).toBe("Not reported");
  });
});

describe("one failing authority degrades one row, not the page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    getMetaCampaignsForRange.mockResolvedValue({ campaigns: [] });
    getMetaCanonicalOverviewSummary.mockRejectedValue(new Error("summary source is down"));
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [], isPartial: false });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready", isPartial: false });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [] });
    readMetaCampaignLabels.mockResolvedValue([]);
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({ structureRows: [] });
  });

  it("marks the failed source degraded with its own verbatim reason", async () => {
    const result = await read();
    const summary = result.sections.find((s) => s.key === "summary")!;
    expect(summary.state).toBe("degraded");
    expect(summary.reason).toBe("summary source is down");
    // Degraded, not unavailable: a failed read is not the same as nothing to give.
    expect(summary.state).not.toBe("unavailable");
  });

  it("leaves every other section serving", async () => {
    const result = await read();
    expect(result.sections.filter((s) => s.state === "degraded")).toHaveLength(1);
    expect(result.unavailableReason).toBeNull();
  });
});

describe("partial states keep the source's own words", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1"] });
    getMetaCampaignsForRange.mockResolvedValue({ campaigns: [] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({
      readSource: "current_day_live",
      isPartial: true,
      notReadyReason: "Current-day live Meta totals are still being prepared.",
    });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [], isPartial: false });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready", isPartial: false });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [] });
    readMetaCampaignLabels.mockResolvedValue([]);
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({ structureRows: [] });
  });

  it("reports partial with the read model's reason, not a rewritten one", async () => {
    const summary = (await read()).sections.find((s) => s.key === "summary")!;
    expect(summary.state).toBe("partial");
    expect(summary.reason).toBe("Current-day live Meta totals are still being prepared.");
  });

  it("does not collapse a partial source into a single page-wide message", async () => {
    const result = await read();
    // Exactly one source is partial; the rest keep their own states.
    expect(result.sections.filter((s) => s.state === "partial")).toHaveLength(1);
  });
});

describe("account scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: true, google: true });
    getMetaCampaignsForRange.mockResolvedValue({ campaigns: [] });
    getMetaCanonicalOverviewSummary.mockResolvedValue({ readSource: "warehouse_published" });
    getMetaCanonicalOverviewTrends.mockResolvedValue({ points: [] });
    getMetaBreakdownsForRange.mockResolvedValue({ status: "ready" });
    readMetaAnomaliesForBusiness.mockResolvedValue({ anomalies: [] });
    readMetaCampaignLabels.mockResolvedValue([]);
    readMetaDecisionsWorkspaceReadModel.mockResolvedValue({ structureRows: [] });
  });

  it("refuses to pick one of several assigned accounts", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: ["act_1", "act_2"] });
    const result = await read();
    // Choosing would scope every section to an account nobody selected.
    expect(result.providerAccountId).toBeNull();
    expect(result.sections.find((s) => s.key === "status")?.state).toBe("partial");
    expect(readMetaDecisionsWorkspaceReadModel).not.toHaveBeenCalled();
  });

  it("marks account-scoped sources unavailable when no account resolves", async () => {
    getProviderAccountAssignments.mockResolvedValue({ account_ids: [] });
    const result = await read();
    expect(result.sections.find((s) => s.key === "structure")?.state).toBe("unavailable");
  });
});

describe("the surface refuses rather than guessing", () => {
  it("says integration status could not be read", async () => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockRejectedValue(new Error("db down"));
    const result = await read();
    expect(result.unavailableReason).toMatch(/could not be read/);
    expect(result.sections).toEqual([]);
  });

  it("says Meta is not connected instead of composing empty sections", async () => {
    vi.clearAllMocks();
    getIntegrationStatusByBusiness.mockResolvedValue({ meta: false, google: true });
    const result = await read();
    expect(result.unavailableReason).toMatch(/not connected/);
    expect(getMetaCanonicalOverviewSummary).not.toHaveBeenCalled();
  });
});
