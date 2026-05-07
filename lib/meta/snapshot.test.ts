import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import {
  runMetaSnapshotForAllBusinesses,
  runMetaSnapshotForBusiness,
} from "@/lib/meta/snapshot";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses: vi.fn(),
}));

vi.mock("@/lib/meta/calibration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/calibration")>();
  return {
    ...actual,
    runMetaCalibrationForBusiness: vi.fn(),
    getMetaCalibrationScope: vi.fn(),
  };
});

vi.mock("@/lib/meta/campaigns-source", () => ({
  getMetaCampaignsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/adsets-source", () => ({
  getMetaAdSetsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/breakdowns-source", () => ({
  getMetaBreakdownsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/config-snapshots", () => ({
  readMetaBidRegimeHistorySummaries: vi.fn(),
}));

const db = await import("@/lib/db");
const activeBusinesses = await import("@/lib/sync/active-businesses");
const calibration = await import("@/lib/meta/calibration");
const campaignSource = await import("@/lib/meta/campaigns-source");
const adsetsSource = await import("@/lib/meta/adsets-source");
const breakdownsSource = await import("@/lib/meta/breakdowns-source");
const configSnapshots = await import("@/lib/meta/config-snapshots");

function makeSqlMock() {
  const calls: string[] = [];
  const queryPayloads: unknown[] = [];
  const tag = vi.fn((strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn((text: string, params?: unknown[]) => {
    calls.push(text);
    queryPayloads.push(params?.[0]);
    return Promise.resolve([]);
  });
  return { tag, calls, queryPayloads };
}

function campaign(overrides: Partial<MetaCampaignRow> = {}) {
  return {
    id: "cmp_1",
    accountId: "act_1",
    name: "Campaign 1",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    optimizationGoal: "Purchase",
    spend: 1500,
    purchases: 24,
    revenue: 4800,
    roas: 3.2,
    cpa: 62.5,
    ctr: 1.4,
    cpm: 12,
    impressions: 10000,
    clicks: 140,
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    bidValue: null,
    bidValueFormat: null,
    currency: "USD",
    budgetLevel: "campaign",
    ...overrides,
  } as unknown as MetaCampaignRow;
}

describe("meta snapshot job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);
    vi.mocked(calibration.runMetaCalibrationForBusiness).mockResolvedValue({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
      rowsWritten: 6,
      accountScopes: 1,
      campaignScopes: 1,
    });
    vi.mocked(calibration.getMetaCalibrationScope).mockResolvedValue({
      thresholds: {
        ...LEGACY_META_CALIBRATION_THRESHOLDS,
        metrics: {
          ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
          roas_28d: {
            p10: 1,
            p25: 1.5,
            p50: 2,
            p75: 2.8,
            p90: 4,
            sampleSize: 12,
          },
        },
        source: "calibrated",
      },
      scope: {
        type: "campaign",
        id: "cmp_1",
        snapshotDate: "2026-05-06",
      },
    });
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockResolvedValue({
      status: "ok",
      rows: [campaign()],
      evidenceSource: "live",
    } as never);
    vi.mocked(adsetsSource.getMetaAdSetsForRange).mockResolvedValue({
      status: "ok",
      rows: [],
      evidenceSource: "live",
    } as never);
    vi.mocked(breakdownsSource.getMetaBreakdownsForRange).mockResolvedValue({
      status: "ok",
      age: [],
      location: [],
      placement: [],
      budget: { campaign: [], adset: [] },
      audience: { available: false },
      products: { available: false },
    } as never);
    vi.mocked(configSnapshots.readMetaBidRegimeHistorySummaries).mockResolvedValue(new Map());
  });

  it("deletes and rewrites same-day rows on re-run", async () => {
    const sql = makeSqlMock();
    vi.mocked(db.getDb).mockReturnValue(sql.tag);

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");
    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    expect(sql.calls.filter((text) => text.includes("DELETE FROM meta_decision_snapshots_daily"))).toHaveLength(2);
    expect(sql.calls.filter((text) => text.includes("INSERT INTO meta_decision_snapshots_daily"))).toHaveLength(2);
  });

  it("runs calibration before fetching decision inputs", async () => {
    const order: string[] = [];
    vi.mocked(calibration.runMetaCalibrationForBusiness).mockImplementation(async () => {
      order.push("calibration");
      return {
        businessId: "biz_1",
        snapshotDate: "2026-05-06",
        rowsWritten: 6,
        accountScopes: 1,
        campaignScopes: 1,
      };
    });
    vi.mocked(campaignSource.getMetaCampaignsForRange).mockImplementation(async () => {
      order.push("campaigns");
      return {
        status: "ok",
        rows: [campaign()],
        evidenceSource: "live",
      } as never;
    });

    await runMetaSnapshotForBusiness("biz_1", "2026-05-06");

    expect(order[0]).toBe("calibration");
    expect(order).toContain("campaigns");
  });

  it("uses allSettled for all business snapshots", async () => {
    vi.mocked(activeBusinesses.getActiveBusinesses).mockResolvedValue([
      { id: "biz_ok", name: "OK" },
      { id: "biz_fail", name: "Fail" },
    ] as never);
    vi.mocked(calibration.runMetaCalibrationForBusiness).mockImplementation(async (businessId: string) => {
      if (businessId === "biz_fail") throw new Error("calibration failed");
      return {
        businessId,
        snapshotDate: "2026-05-06",
        rowsWritten: 6,
        accountScopes: 1,
        campaignScopes: 1,
      };
    });

    const result = await runMetaSnapshotForAllBusinesses("2026-05-06");

    expect(result.businessCount).toBe(2);
    expect(result.results.map((item) => item.status)).toEqual(["fulfilled", "rejected"]);
    expect(result.results[1]?.reason).toContain("calibration failed");
  });
});
