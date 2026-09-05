import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true, missingTables: [] })),
}));

import * as db from "@/lib/db";
import { detectAnomaliesForBusiness } from "@/lib/meta/anomalies";

const TODAY = "2026-09-05";

type Row = {
  date: string;
  spend: number;
  revenue?: number;
  purchases?: number;
  daily_budget?: number;
  campaign_status?: string;
};

/**
 * The anomaly reader issues three tagged queries in one `Promise.all`:
 * campaign, ad set, ad. Only the first matters here, so the other two answer
 * empty.
 */
function withCampaignRows(rows: Row[]) {
  let call = 0;
  const tag = ((..._args: unknown[]) => {
    call += 1;
    if (call === 1) {
      return Promise.resolve(rows.map((row) => ({
        provider_account_id: "act_1",
        date: row.date,
        campaign_id: "camp_1",
        campaign_name: "Prospecting",
        campaign_status: row.campaign_status ?? "ACTIVE",
        spend: row.spend,
        revenue: row.revenue ?? 0,
        purchases: row.purchases ?? 0,
        impressions: 10_000,
        daily_budget: row.daily_budget ?? 0,
      })));
    }
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  vi.mocked(db.getDb).mockReturnValue(tag);
}

function sevenClosedDays(spendPerDay: number, extra: Partial<Row> = {}) {
  return Array.from({ length: 7 }, (_unused, index) => ({
    date: `2026-08-${String(29 + index).padStart(2, "0")}`.replace("2026-08-32", "2026-09-01"),
    spend: spendPerDay,
    ...extra,
  }));
}

describe("spending with no purchases", () => {
  const window = [
    { date: "2026-08-30", spend: 40 }, { date: "2026-08-31", spend: 40 },
    { date: "2026-09-01", spend: 40 }, { date: "2026-09-02", spend: 40 },
    { date: "2026-09-03", spend: 40 }, { date: "2026-09-04", spend: 40 },
  ];

  it("reports a campaign past its own loss budget with nothing to show", async () => {
    withCampaignRows(window);
    const found = await detectAnomaliesForBusiness({
      businessId: "biz", snapshotDate: TODAY,
      profile: { lossBudgetSpend: 100, timezone: null },
      now: new Date(`${TODAY}T12:00:00.000Z`),
    });
    const anomaly = found.find((row) => row.type === "zero_conversions_with_spend");
    expect(anomaly).toBeDefined();
    // $240 against a $100 loss budget: more than twice over.
    expect(anomaly!.severity).toBe("high");
  });

  it("says nothing below the loss budget, where zero is just a small sample", async () => {
    withCampaignRows([{ date: "2026-09-04", spend: 12 }]);
    const found = await detectAnomaliesForBusiness({
      businessId: "biz", snapshotDate: TODAY,
      profile: { lossBudgetSpend: 100, timezone: null },
      now: new Date(`${TODAY}T12:00:00.000Z`),
    });
    expect(found.some((row) => row.type === "zero_conversions_with_spend")).toBe(false);
  });

  it("counts a purchase with no value as a purchase", async () => {
    // A conversion the pixel recorded without a value is still a conversion;
    // calling it "no purchases" would be reporting a tracking gap as a
    // performance failure.
    withCampaignRows(window.map((row, index) =>
      index === 0 ? { ...row, purchases: 1 } : row));
    const found = await detectAnomaliesForBusiness({
      businessId: "biz", snapshotDate: TODAY,
      profile: { lossBudgetSpend: 100, timezone: null },
      now: new Date(`${TODAY}T12:00:00.000Z`),
    });
    expect(found.some((row) => row.type === "zero_conversions_with_spend")).toBe(false);
  });

  it("stays silent when the business has no loss budget configured", async () => {
    // No profile means no threshold, and inventing one would make this module
    // decide what a bad week is for somebody else's account.
    withCampaignRows(window);
    const found = await detectAnomaliesForBusiness({
      businessId: "biz", snapshotDate: TODAY,
      profile: { lossBudgetSpend: null, timezone: null },
      now: new Date(`${TODAY}T12:00:00.000Z`),
    });
    expect(found.some((row) => row.type === "zero_conversions_with_spend")).toBe(false);
  });

  it("ignores a paused campaign", async () => {
    withCampaignRows(sevenClosedDays(40, { campaign_status: "PAUSED" }));
    const found = await detectAnomaliesForBusiness({
      businessId: "biz", snapshotDate: TODAY,
      profile: { lossBudgetSpend: 100, timezone: null },
      now: new Date(`${TODAY}T12:00:00.000Z`),
    });
    expect(found.some((row) => row.type === "zero_conversions_with_spend")).toBe(false);
  });
});

describe("budget spent early", () => {
  it("reports a budget nearly gone at a third of the local day", async () => {
    withCampaignRows([{ date: TODAY, spend: 96, daily_budget: 100 }]);
    // 08:00 in Istanbul is a third of the local day; the same instant is
    // 05:00 UTC, which is why the zone has to travel.
    const found = await detectAnomaliesForBusiness({
      businessId: "biz", snapshotDate: TODAY,
      profile: { lossBudgetSpend: null, timezone: "Europe/Istanbul" },
      now: new Date(`${TODAY}T05:00:00.000Z`),
    });
    const anomaly = found.find((row) => row.type === "budget_exhausted_early");
    expect(anomaly).toBeDefined();
    expect(anomaly!.severity).toBe("high");
  });

  it("says nothing about a campaign pacing correctly", async () => {
    // 90% of budget at 90% of the day is exactly right, not early.
    withCampaignRows([{ date: TODAY, spend: 90, daily_budget: 100 }]);
    const found = await detectAnomaliesForBusiness({
      businessId: "biz", snapshotDate: TODAY,
      profile: { lossBudgetSpend: null, timezone: "Europe/Istanbul" },
      now: new Date(`${TODAY}T18:30:00.000Z`),
    });
    expect(found.some((row) => row.type === "budget_exhausted_early")).toBe(false);
  });

  it("stays silent without a timezone rather than reporting somebody else's morning", async () => {
    withCampaignRows([{ date: TODAY, spend: 96, daily_budget: 100 }]);
    const found = await detectAnomaliesForBusiness({
      businessId: "biz", snapshotDate: TODAY,
      profile: { lossBudgetSpend: null, timezone: null },
      now: new Date(`${TODAY}T05:00:00.000Z`),
    });
    expect(found.some((row) => row.type === "budget_exhausted_early")).toBe(false);
  });

  it("stays silent on an unreadable timezone", async () => {
    withCampaignRows([{ date: TODAY, spend: 96, daily_budget: 100 }]);
    const found = await detectAnomaliesForBusiness({
      businessId: "biz", snapshotDate: TODAY,
      profile: { lossBudgetSpend: null, timezone: "Mars/Olympus" },
      now: new Date(`${TODAY}T05:00:00.000Z`),
    });
    expect(found.some((row) => row.type === "budget_exhausted_early")).toBe(false);
  });
});
