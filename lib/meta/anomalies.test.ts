import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  anomalyMatchesStatusFilter,
  detectAnomaliesForBusiness,
  detectAnomalyEvaluationForBusiness,
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
  campaignDimensionRows?: Array<{ campaign_id: string }>;
  adsetDimensionRows?: Array<{ adset_id: string }>;
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
    if (text.includes("FROM meta_campaign_dimensions")) {
      return Promise.resolve(input.campaignDimensionRows ?? []);
    }
    if (text.includes("FROM meta_adset_dimensions")) {
      return Promise.resolve(input.adsetDimensionRows ?? []);
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

  it("adds an ordered diagnostic ladder to detected anomalies", async () => {
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
    const anomaly = anomalies.find((item) => item.type === "roas_drop_sudden");

    expect(anomaly?.diagnosticLadder?.map((step) => step.label)).toEqual([
      "Tracking",
      "Fatigue",
      "Recent edits",
      "Auction",
      "Seasonality",
    ]);
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
            evidence: { anomaly: { scopeLabel: "Adset 1", diagnosticLadder: [{ step: 1, label: "Tracking", detail: "Check events." }] } },
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
      diagnosticLadder: [{ step: 1, label: "Tracking", detail: "Check events." }],
    });
  });

  it("withholds persisted anomalies outside the explicit provider account", async () => {
    const snapshotRow = (scopeType: "campaign" | "adset", scopeId: string) => ({
      snapshot_date: "2026-05-06",
      rec_id: `${scopeType}-${scopeId}`,
      rec_type: scopeType === "campaign" ? "roas_drop_sudden" : "policy_block",
      scope_type: scopeType,
      scope_id: scopeId,
      severity: "high",
      evidence: { anomaly: { scopeLabel: scopeId } },
      recommended_action: "Review",
      reasoning: "Detected.",
      diagnostics: [],
      detected_at: "2026-05-06T10:00:00.000Z",
      resolved_at: null,
    });
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        snapshotRows: [
          snapshotRow("campaign", "cmp_allowed"),
          snapshotRow("campaign", "cmp_other"),
          snapshotRow("adset", "adset_allowed"),
          snapshotRow("adset", "adset_other"),
        ],
        campaignDimensionRows: [{ campaign_id: "cmp_allowed" }],
        adsetDimensionRows: [{ adset_id: "adset_allowed" }],
      }),
    );

    const result = await readMetaAnomaliesForBusiness({
      businessId: "biz_1",
      providerAccountId: "act_1",
    });

    expect(result.anomalies.map((item) => item.scopeId)).toEqual([
      "cmp_allowed",
      "adset_allowed",
    ]);
  });

  it("captures the entity status observed at detection time", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        campaignRows: campaignRows({
          spendByDay: () => 100,
          revenueByDay: (age) => (age <= 6 ? 100 : 400),
          status: "PAUSED",
        }),
      }),
    );

    const anomalies = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
      now: new Date("2026-05-06T22:00:00.000Z"),
    });

    const drop = anomalies.find((anomaly) => anomaly.type === "roas_drop_sudden");
    expect(drop?.entityStatus).toBe("PAUSED");
  });

  it("resolves policy-block scope status from the adset/campaign daily rows", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        adsetRows: adsetRows({
          adsetId: "adset_9",
          latestImpressions: 5000,
          previousImpressions: 5000,
          status: "PAUSED",
        }),
        adRows: [
          {
            date: "2026-05-06",
            campaign_id: "cmp_1",
            adset_id: "adset_9",
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
      now: new Date("2026-05-06T22:00:00.000Z"),
    });

    const block = anomalies.find((anomaly) => anomaly.type === "policy_block");
    expect(block?.scopeId).toBe("adset_9");
    expect(block?.entityStatus).toBe("PAUSED");
  });

  it("filters hydrated anomalies by the write-time entity status", async () => {
    const snapshotRow = (recId: string, entityStatus: string | null | undefined) => ({
      snapshot_date: "2026-05-06",
      rec_id: recId,
      rec_type: "policy_block",
      scope_type: "adset",
      scope_id: recId,
      severity: "high",
      evidence: { anomaly: { scopeLabel: recId, entityStatus } },
      recommended_action: "Policy delivery block",
      reasoning: "Rejected ad.",
      diagnostics: [],
      detected_at: "2026-05-06T10:00:00.000Z",
      resolved_at: null,
    });
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        snapshotRows: [
          snapshotRow("anom_active", "ACTIVE"),
          snapshotRow("anom_paused", "PAUSED"),
          snapshotRow("anom_archived", "ARCHIVED"),
          snapshotRow("anom_legacy", undefined),
        ],
      }),
    );

    const active = await readMetaAnomaliesForBusiness({
      businessId: "biz_1",
      statusFilter: "active",
    });
    // Legacy rows without a stored status fail open.
    expect(active.anomalies.map((anomaly) => anomaly.id)).toEqual([
      "anom_active",
      "anom_legacy",
    ]);
    expect(active.count).toBe(2);

    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        snapshotRows: [
          snapshotRow("anom_active", "ACTIVE"),
          snapshotRow("anom_paused", "PAUSED"),
          snapshotRow("anom_archived", "ARCHIVED"),
          snapshotRow("anom_legacy", undefined),
        ],
      }),
    );
    const withPaused = await readMetaAnomaliesForBusiness({
      businessId: "biz_1",
      statusFilter: "active_plus_recent_paused",
    });
    expect(withPaused.anomalies.map((anomaly) => anomaly.id)).toEqual([
      "anom_active",
      "anom_paused",
      "anom_legacy",
    ]);
  });

  it("applies no status filtering when statusFilter is absent", async () => {
    vi.mocked(db.getDb).mockReturnValue(
      makeSqlMock({
        snapshotRows: [
          {
            snapshot_date: "2026-05-06",
            rec_id: "anom_archived",
            rec_type: "policy_block",
            scope_type: "adset",
            scope_id: "adset_1",
            severity: "high",
            evidence: { anomaly: { scopeLabel: "Adset 1", entityStatus: "ARCHIVED" } },
            recommended_action: "Policy delivery block",
            reasoning: "Rejected ad.",
            diagnostics: [],
            detected_at: "2026-05-06T10:00:00.000Z",
            resolved_at: null,
          },
        ],
      }),
    );

    const result = await readMetaAnomaliesForBusiness({ businessId: "biz_1" });
    expect(result.count).toBe(1);
  });

  it("detectAnomaliesForBusiness is exactly the evaluation's anomalies", async () => {
    /*
      The array-returning function is a projection of the evaluation, not a
      second implementation. Anything that WRITES must take the evaluation,
      because only it distinguishes "this family found nothing" from "this
      family was never judged" — and the writer resolves open rows on that
      distinction. A divergence here would let a caller pick the lossy shape
      and get subtly different anomalies with it.
    */
    const rows = campaignRows({
      spendByDay: () => 100,
      revenueByDay: (age) => (age <= 6 ? 100 : 400),
    });
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock({ campaignRows: rows }));
    const evaluation = await detectAnomalyEvaluationForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
      now: new Date("2026-05-06T05:00:00.000Z"),
    });
    vi.mocked(db.getDb).mockReturnValue(makeSqlMock({ campaignRows: rows }));
    const plain = await detectAnomaliesForBusiness({
      businessId: "biz_1",
      snapshotDate: "2026-05-06",
      now: new Date("2026-05-06T05:00:00.000Z"),
    });
    expect(plain).toEqual(evaluation.anomalies);
    expect(plain.length).toBeGreaterThan(0);
  });

  it("anomalyMatchesStatusFilter is fail-open on unknown status", () => {
    expect(anomalyMatchesStatusFilter({ entityStatus: null }, "active")).toBe(true);
    expect(anomalyMatchesStatusFilter({ entityStatus: "UNKNOWN" }, "active")).toBe(true);
    expect(anomalyMatchesStatusFilter({ entityStatus: "PAUSED" }, "active")).toBe(false);
    expect(anomalyMatchesStatusFilter({ entityStatus: "PAUSED" }, "active_plus_recent_paused")).toBe(true);
    expect(anomalyMatchesStatusFilter({ entityStatus: "ARCHIVED" }, "active_plus_recent_paused")).toBe(false);
    expect(anomalyMatchesStatusFilter({ entityStatus: "ARCHIVED" }, "all")).toBe(true);
  });
});
