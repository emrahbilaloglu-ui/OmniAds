import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/campaigns/route";
import { assertMetaCampaignRowPageContract } from "@/lib/meta/page-route-contract.test-helpers";

/*
 * The posture read, stubbed at its own DB read.
 *
 * The source moved off the boolean `isDemoBusiness` onto the tri-state
 * `readMetaBusinessDataPosture`, which fails CLOSED: an unreadable flag
 * withholds rather than falling through to the live reader.
 */
vi.mock("@/app/api/launchpad/meta/demo-write-authority", () => ({
  readLaunchpadWriteAuthority: vi.fn(async () => "live"),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(),
}));

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  getIntegration: vi.fn(),
}));

vi.mock("@/lib/provider-account-assignments", () => ({
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES: [
    "business_provider_accounts",
    "provider_accounts",
  ],
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));

vi.mock("@/lib/meta/readiness", () => ({
  getMetaPartialReason: vi.fn(),
  getMetaRangePreparationContext: vi.fn(),
}));

vi.mock("@/lib/meta/serving", () => ({
  getMetaWarehouseCampaignTable: vi.fn(),
}));

vi.mock("@/lib/meta/live", () => ({
  getMetaLiveCampaignRows: vi.fn(),
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  getMetaSelectedRangeTruthReadiness: vi.fn(),
}));

const businessMode = await import("@/lib/business-mode.server");
const access = await import("@/lib/access");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const integrations = await import("@/lib/integrations");
const assignments = await import("@/lib/provider-account-assignments");
const migrations = await import("@/lib/migrations");
const readiness = await import("@/lib/meta/readiness");
const serving = await import("@/lib/meta/serving");
const live = await import("@/lib/meta/live");
const metaSync = await import("@/lib/sync/meta-sync");

describe("GET /api/meta/campaigns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(false);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      id: "1",
      business_id: "biz",
      provider: "meta",
      account_ids: ["act_1"],
      created_at: "",
      updated_at: "",
    });
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-03-15",
      selectedRangeTruthEndDate: "2026-03-15",
      currentDateInTimezone: "2026-03-31",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    });
    vi.mocked(readiness.getMetaPartialReason).mockReturnValue(
      "Current-day live Meta campaign data is still being prepared.",
    );
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: true,
      verificationState: "finalized_verified",
      state: "ready",
    } as never);
  });

  it("serves warehouse-backed historical data even without a live access token", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      id: "int_1",
      business_id: "biz",
      provider: "meta",
      status: "connected",
      provider_account_id: "act_1",
      provider_account_name: "Main",
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      scopes: null,
      error_message: null,
      metadata: {},
      connected_at: null,
      disconnected_at: null,
      created_at: "",
      updated_at: "",
    });
    vi.mocked(serving.getMetaWarehouseCampaignTable).mockResolvedValue([
      {
        id: "cmp_1",
        name: "Campaign 1",
        status: "ACTIVE",
        objective: "Conversions",
        spend: 1200,
        revenue: 3600,
        roas: 3,
        cpa: 24,
        dailyBudget: 5000,
        lifetimeBudget: null,
        previousDailyBudget: 4500,
        previousLifetimeBudget: null,
        previousBudgetCapturedAt: "2026-02-28T00:00:00.000Z",
      },
    ] as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/campaigns?businessId=biz&startDate=2026-03-01&endDate=2026-03-15"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.status).toBe("ok");
    expect(payload.rows).toHaveLength(1);
    assertMetaCampaignRowPageContract(payload.rows[0]);
    expect(serving.getMetaWarehouseCampaignTable).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        startDate: "2026-03-01",
        endDate: "2026-03-15",
        includePrev: false,
      })
    );
    expect(live.getMetaLiveCampaignRows).not.toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("uses the live path for current-day requests and keeps the page-visible campaign subset", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
    } as never);
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: true,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-03-31",
      selectedRangeTruthEndDate: "2026-03-31",
      currentDateInTimezone: "2026-03-31",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "current_day_live",
      breakdownReadMode: "current_day_live",
    });
    vi.mocked(live.getMetaLiveCampaignRows).mockResolvedValue([
      {
        id: "cmp_live",
        name: "Today Campaign",
        status: "ACTIVE",
        objective: "Sales",
        spend: 50,
        revenue: 125,
        roas: 2.5,
        cpa: 10,
        dailyBudget: 3000,
        lifetimeBudget: null,
        previousDailyBudget: null,
        previousLifetimeBudget: null,
        previousBudgetCapturedAt: null,
      },
    ] as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/campaigns?businessId=biz&startDate=2026-03-31&endDate=2026-03-31"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.rows).toHaveLength(1);
    assertMetaCampaignRowPageContract(payload.rows[0]);
    expect(live.getMetaLiveCampaignRows).toHaveBeenCalledTimes(1);
    expect(serving.getMetaWarehouseCampaignTable).not.toHaveBeenCalled();
  });

  it("returns a partial current-day payload when the live path returns no campaigns", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
    } as never);
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: true,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-03-31",
      selectedRangeTruthEndDate: "2026-03-31",
      currentDateInTimezone: "2026-03-31",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "current_day_live",
      breakdownReadMode: "current_day_live",
    });
    vi.mocked(live.getMetaLiveCampaignRows).mockResolvedValue([] as never);
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/campaigns?businessId=biz&startDate=2026-03-31&endDate=2026-03-31"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.rows).toHaveLength(0);
    expect(payload.isPartial).toBe(true);
    expect(payload.notReadyReason).toContain("Current-day live Meta campaign data");
    expect(live.getMetaLiveCampaignRows).toHaveBeenCalledTimes(1);
    expect(serving.getMetaWarehouseCampaignTable).not.toHaveBeenCalled();
  });

  it("uses the historical truth end date when a selected range includes today", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
    } as never);
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: true,
      selectedRangeHistoricalEndDate: "2026-03-30",
      selectedRangeTruthEndDate: "2026-03-30",
      currentDateInTimezone: "2026-03-31",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    } as never);
    vi.mocked(serving.getMetaWarehouseCampaignTable).mockResolvedValue([
      {
        id: "cmp_hist",
        name: "Historical Campaign",
        status: "ACTIVE",
        objective: "Sales",
        spend: 75,
        revenue: 210,
        roas: 2.8,
        cpa: 15,
        dailyBudget: 1500,
        lifetimeBudget: null,
        previousDailyBudget: null,
        previousLifetimeBudget: null,
        previousBudgetCapturedAt: null,
      },
    ] as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/campaigns?businessId=biz&startDate=2026-03-25&endDate=2026-03-31"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    expect(payload.isPartial).toBe(false);
    expect(payload.notReadyReason).toBeNull();
    expect(serving.getMetaWarehouseCampaignTable).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz",
        startDate: "2026-03-25",
        endDate: "2026-03-30",
        includePrev: false,
      })
    );
    expect(live.getMetaLiveCampaignRows).not.toHaveBeenCalled();
  });

  it("forwards includePrev for the current page budget-change contract", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
    } as never);
    vi.mocked(serving.getMetaWarehouseCampaignTable).mockResolvedValue([
      {
        id: "cmp_1",
        name: "Campaign 1",
        status: "ACTIVE",
        objective: "Sales",
        spend: 100,
        revenue: 300,
        roas: 3,
        cpa: 20,
        dailyBudget: 5000,
        lifetimeBudget: null,
        previousDailyBudget: 4000,
        previousLifetimeBudget: null,
        previousBudgetCapturedAt: "2026-02-27T00:00:00.000Z",
      },
    ] as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/campaigns?businessId=biz&startDate=2026-03-01&endDate=2026-03-15&includePrev=1"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    assertMetaCampaignRowPageContract(payload.rows[0]);
    expect(serving.getMetaWarehouseCampaignTable).toHaveBeenCalledWith(
      expect.objectContaining({
        includePrev: true,
      })
    );
  });

  it("scopes includePrev responses to the selected campaign when campaignId is provided", async () => {
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
    } as never);
    vi.mocked(serving.getMetaWarehouseCampaignTable).mockResolvedValue([
      {
        id: "cmp_1",
        name: "Campaign 1",
        status: "ACTIVE",
        objective: "Sales",
        spend: 100,
        revenue: 300,
        roas: 3,
        cpa: 20,
        dailyBudget: 5000,
        lifetimeBudget: null,
        previousDailyBudget: 4000,
        previousLifetimeBudget: null,
        previousBudgetCapturedAt: "2026-02-27T00:00:00.000Z",
      },
      {
        id: "cmp_2",
        name: "Campaign 2",
        status: "ACTIVE",
        objective: "Sales",
        spend: 80,
        revenue: 240,
        roas: 3,
        cpa: 16,
        dailyBudget: 3000,
        lifetimeBudget: null,
        previousDailyBudget: 2500,
        previousLifetimeBudget: null,
        previousBudgetCapturedAt: "2026-02-27T00:00:00.000Z",
      },
    ] as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/campaigns?businessId=biz&startDate=2026-03-01&endDate=2026-03-15&includePrev=1&campaignId=cmp_2"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].id).toBe("cmp_2");
    assertMetaCampaignRowPageContract(payload.rows[0]);
    expect(serving.getMetaWarehouseCampaignTable).toHaveBeenCalledWith(
      expect.objectContaining({
        includePrev: true,
      })
    );
  });

  it("keeps the no-accounts-assigned route status used by the page", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      id: "1",
      business_id: "biz",
      provider: "meta",
      account_ids: [],
      created_at: "",
      updated_at: "",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/campaigns?businessId=biz&startDate=2026-03-01&endDate=2026-03-15"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("no_accounts_assigned");
    expect(payload.rows).toEqual([]);
  });

  it("degrades to the existing no-accounts contract when assignment schema is not ready", async () => {
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["provider_account_assignments"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/campaigns?businessId=biz&startDate=2026-03-01&endDate=2026-03-15"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "no_accounts_assigned",
      rows: [],
      isPartial: false,
    });
    expect(assignments.getProviderAccountAssignments).not.toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });
});
