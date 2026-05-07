import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectAnomaliesForBusiness,
  readMetaAnomaliesForBusiness,
  severityFromMagnitude,
} from "@/lib/meta/anomalies";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

const db = await import("@/lib/db");
const readiness = await import("@/lib/db-schema-readiness");

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function campaignRows(input: {
  campaignId?: string;
  snapshotDate?: string;
  name?: string;
  status?: string;
  dailyBudget?: number;
  spendByDay: (age: number) => number;
  revenueByDay: (age: number) => number;
  impressionsByDay?: (age: number) => number;
}) {
  const snapshotDate = input.snapshotDate ?? "2026-05-06";
  return Array.from({ length: 28 }, (_, index) => {
    const age = 27 - index;
    return {
      provider_account_id: "act_1",
      date: addDays(snapshotDate, -age),
      campaign_id: input.campaignId ?? "cmp_1",
      campaign_name: input.name ?? "Campaign 1",
      campaign_status: input.status ?? "ACTIVE",
      spend: input.spendByDay(age),
      revenue: input.revenueByDay(age),
      impressions: input.impressionsByDay?.(age) ?? 10000,
      daily_budget: input.dailyBudget ?? 100,
    };
  });
}

function adsetRows(input: {
  adsetId?: string;
  snapshotDate?: string;
  latestImpressions: number;
  previousImpressions: number;
  status?: string;
}) {
  const snapshotDate = input.snapshotDate ?? "2026-05-06";
  return Array.from({ length: 8 }, (_, index) => {
    const age = 7 - index;
    return {
      provider_account_id: "act_1",
      date: addDays(snapshotDate, -age),
      campaign_id: "cmp_1",
      adset_id: input.adsetId ?? "adset_1",
      adset_name: "Adset 1",
      adset_status: input.status ?? "ACTIVE",
      spend: 20,
      impressions: age === 0 ? input.latestImpressions : input.previousImpressions,
      daily_budget: 50,
    };
  });
}

function makeSqlMock(input: {
  campaignRows?: Array<Record<string, unknown>>;
  adsetRows?: Array<Record<string, unknown>>;
  adRows?: Array<Record<string, unknown>>;
  snapshotRows?: Array<Record<string, unknown>>;
}) {
  const tag = vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("FROM meta_campaign_daily")) {
      return Promise.resolve(input.campaignRows ?? []);
    }
    if (text.includes("FROM meta_adset_daily")) {
      return Promise.resolve(input.adsetRows ?? []);
    }
    if (text.includes("FROM meta_ad_daily")) {
      return Promise.resolve(input.adRows ?? []);
    }
    if (text.includes("MAX(snapshot_date)")) {
      return Promise.resolve(
        input.snapshotRows?.length
          ? [{ snapshot_date: input.snapshotRows[0]?.snapshot_date }]
          : [{ snapshot_date: null }],
      );
    }
    if (text.includes("FROM meta_decision_snapshots_daily")) {
      return Promise.resolve(input.snapshotRows ?? []);
    }
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  tag.query = vi.fn();
  return tag;
}

describe("meta anomalies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-05-06T00:00:00.000Z",
    });
  });

  it("uses the high, medium, low severity ladder", () => {
    expect(severityFromMagnitude(0.6)).toBe("high");
    expect(severityFromMagnitude(0.3)).toBe("medium");
    expect(severityFromMagnitude(0.1)).toBe("low");
  });

  it("detects sudden ROAS drops and ignores stable campaigns", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        campaignRows: campaignRows({
          spendByDay: () => 100,
          revenueByDay: (age) => (age <= 6 ? 100 : 400),
        }),
      }),
    );

    const anomalies = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
    });

    expect(anomalies.some((item) => item.type === "roas_drop_sudden")).toBe(true);
    expect(anomalies.find((item) => item.type === "roas_drop_sudden")?.severity).toBe("high");

    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        campaignRows: campaignRows({
          spendByDay: () => 100,
          revenueByDay: () => 300,
        }),
      }),
    );
    const stable = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
    });
    expect(stable.some((item) => item.type === "roas_drop_sudden")).toBe(false);
  });

  it("detects delivery stalls only for active adsets", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        adsetRows: adsetRows({ latestImpressions: 2000, previousImpressions: 10000 }),
      }),
    );

    const anomalies = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
    });

    expect(anomalies.find((item) => item.type === "delivery_stall")?.severity).toBe("high");

    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        adsetRows: adsetRows({
          latestImpressions: 2000,
          previousImpressions: 10000,
          status: "PAUSED",
        }),
      }),
    );
    const paused = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
    });
    expect(paused.some((item) => item.type === "delivery_stall")).toBe(false);
  });

  it("detects policy blocks and ignores active ads", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        adRows: [
          {
            date: "2026-05-06",
            campaign_id: "cmp_1",
            adset_id: "adset_1",
            ad_id: "ad_1",
            ad_name: "Ad 1",
            effective_status: "REJECTED",
            impressions: 0,
            spend: 0,
          },
        ],
      }),
    );

    const anomalies = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
    });
    expect(anomalies.find((item) => item.type === "policy_block")?.severity).toBe("high");

    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        adRows: [
          {
            date: "2026-05-06",
            campaign_id: "cmp_1",
            adset_id: "adset_1",
            ad_id: "ad_1",
            ad_name: "Ad 1",
            effective_status: "ACTIVE",
            impressions: 1000,
            spend: 20,
          },
        ],
      }),
    );
    const healthy = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
    });
    expect(healthy.some((item) => item.type === "policy_block")).toBe(false);
  });

  it("detects pacing failures only after enough day progress", async () => {
    const rows = campaignRows({
      dailyBudget: 100,
      spendByDay: (age) => (age === 0 ? 15 : 100),
      revenueByDay: () => 200,
    });
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock({ campaignRows: rows }));

    const anomalies = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
      now: new Date("2026-05-06T18:00:00.000Z"),
    });
    expect(anomalies.find((item) => item.type === "pacing_failure")?.severity).toBe("high");

    vi.mocked(db.getDb).mockReturnValue(makeSqlMock({ campaignRows: rows }));
    const early = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
      now: new Date("2026-05-06T08:00:00.000Z"),
    });
    expect(early.some((item) => item.type === "pacing_failure")).toBe(false);
  });

  it("detects CPM spikes and ignores normal CPM movement", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        campaignRows: campaignRows({
          spendByDay: (age) => (age <= 2 ? 300 : 50),
          revenueByDay: () => 300,
          impressionsByDay: (age) => (age <= 2 ? 10000 : 10000),
        }),
      }),
    );

    const anomalies = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
    });
    expect(anomalies.find((item) => item.type === "cpm_spike")?.severity).toBe("high");

    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        campaignRows: campaignRows({
          spendByDay: () => 50,
          revenueByDay: () => 300,
          impressionsByDay: () => 10000,
        }),
      }),
    );
    const stable = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
    });
    expect(stable.some((item) => item.type === "cpm_spike")).toBe(false);
  });

  it("hydrates active anomalies from the most recent snapshot", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        snapshotRows: [
          {
            snapshot_date: "2026-05-06",
            rec_id: "anom_1",
            rec_type: "policy_block",
            scope_type: "adset",
            scope_id: "adset_1",
            severity: "high",
            evidence: { anomaly: { scopeLabel: "Adset 1" } },
            recommended_action: "Policy delivery block",
            reasoning: "Rejected ad.",
            diagnostics: ["Ad 1: REJECTED"],
            detected_at: "2026-05-06T10:00:00.000Z",
            resolved_at: null,
          },
        ],
      }),
    );

    const result = await readMetaAnomaliesForBusiness({
      businessId: "biz_1",
      activeOnly: true,
    });

    expect(result.snapshotDate).toBe("2026-05-06");
    expect(result.count).toBe(1);
    expect(result.anomalies[0]).toMatchObject({
      id: "anom_1",
      scopeLabel: "Adset 1",
      diagnostics: ["Ad 1: REJECTED"],
    });
  });
});
