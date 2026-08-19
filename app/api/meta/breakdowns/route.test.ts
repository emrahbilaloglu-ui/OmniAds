import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/meta/breakdowns/route";
import { assertMetaBreakdownsPageContract } from "@/lib/meta/page-route-contract.test-helpers";
import { getDemoMetaStatus } from "@/lib/demo-business";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

vi.mock("@/lib/business-mode.server", () => ({
  isDemoBusiness: vi.fn(() => false),
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

vi.mock("@/lib/meta/constraints", () => ({
  getMetaBreakdownGuardrail: vi.fn(() => ({ message: null })),
}));

vi.mock("@/lib/meta/readiness", () => ({
  getMetaPartialReason: vi.fn(() => "Breakdown data is still being prepared."),
  getMetaRangePreparationContext: vi.fn(),
}));

vi.mock("@/lib/meta/serving", () => ({
  getMetaWarehouseBreakdowns: vi.fn(),
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  getMetaSelectedRangeTruthReadiness: vi.fn(),
}));

const access = await import("@/lib/access");
const businessMode = await import("@/lib/business-mode.server");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const integrations = await import("@/lib/integrations");
const assignments = await import("@/lib/provider-account-assignments");
const migrations = await import("@/lib/migrations");
const readiness = await import("@/lib/meta/readiness");
const serving = await import("@/lib/meta/serving");
const metaSync = await import("@/lib/sync/meta-sync");

describe("GET /api/meta/breakdowns", () => {
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
    vi.mocked(integrations.getIntegration).mockResolvedValue({
      status: "connected",
      access_token: "token",
    } as never);
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-04-03",
      selectedRangeTruthEndDate: "2026-04-03",
      currentDateInTimezone: "2026-04-05",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    });
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: true,
      state: "finalized_verified",
      verificationState: "finalized_verified",
      completedCoreDays: 3,
      totalDays: 3,
      blockingReasons: [],
      reasonCounts: {},
      sourceFetchedAt: "2026-04-05T00:00:00Z",
      publishedAt: "2026-04-05T00:05:00Z",
      asOf: "2026-04-05T00:05:00Z",
    } as never);
  });

  it("returns the visible breakdown sections used by the current page", async () => {
    vi.mocked(serving.getMetaWarehouseBreakdowns).mockResolvedValue({
      age: [{ key: "18-24", label: "18-24", spend: 10, revenue: 22 }],
      location: [{ key: "US", label: "United States", spend: 12, revenue: 30 }],
      placement: [{ key: "facebook|feed|mobile", label: "facebook • feed • mobile", spend: 9, revenue: 18 }],
      budget: { campaign: [{ key: "cmp", label: "Campaign", spend: 12 }], adset: [] },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&startDate=2026-04-01&endDate=2026-04-03"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    assertMetaBreakdownsPageContract(payload);
    expect(payload.age).toHaveLength(1);
    expect(payload.location).toHaveLength(1);
    expect(payload.placement).toHaveLength(1);
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("keeps the page-contract assertions focused on age, location, and placement only", async () => {
    vi.mocked(serving.getMetaWarehouseBreakdowns).mockResolvedValue({
      age: [],
      location: [],
      placement: [],
      budget: { campaign: [{ key: "cmp", label: "Campaign", spend: 999 }], adset: [{ key: "adset", label: "Ad set", spend: 123 }] },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&startDate=2026-04-01&endDate=2026-04-03"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    assertMetaBreakdownsPageContract(payload);
    expect(payload).toHaveProperty("budget");
    expect(payload).toHaveProperty("audience");
    expect(payload).toHaveProperty("products");
  });

  it("does not surface unpublished historical breakdown truth when warehouse payload is partial under v2", async () => {
    vi.mocked(serving.getMetaWarehouseBreakdowns).mockResolvedValue({
      age: [],
      location: [],
      placement: [],
      budget: { campaign: [], adset: [] },
      verification: {
        verificationState: "processing",
        sourceFetchedAt: "2026-04-05T00:00:00Z",
        publishedAt: null,
        asOf: "2026-04-05T00:00:00Z",
      },
      isPartial: true,
    } as never);
    vi.mocked(metaSync.getMetaSelectedRangeTruthReadiness).mockResolvedValue({
      truthReady: false,
      state: "processing",
      verificationState: "processing",
      completedCoreDays: 0,
      totalDays: 3,
      blockingReasons: ["non_finalized"],
      reasonCounts: { processing: 1 },
      sourceFetchedAt: "2026-04-05T00:00:00Z",
      publishedAt: null,
      asOf: "2026-04-05T00:00:00Z",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&startDate=2026-04-01&endDate=2026-04-03"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.age).toEqual([]);
    expect(payload.location).toEqual([]);
    expect(payload.placement).toEqual([]);
    expect(payload.isPartial).toBe(true);
    expect(payload.notReadyReason).toContain("prepared");
  });

  it("keeps current-day breakdown behavior unchanged", async () => {
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: true,
      selectedRangeIncludesCurrentDay: false,
      selectedRangeHistoricalEndDate: "2026-04-05",
      selectedRangeTruthEndDate: "2026-04-05",
      currentDateInTimezone: "2026-04-05",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "current_day_live",
      breakdownReadMode: "current_day_live",
    });
    vi.mocked(serving.getMetaWarehouseBreakdowns).mockResolvedValue({
      age: [{ key: "18-24", label: "18-24", spend: 10, purchases: 1, revenue: 20, clicks: 4, impressions: 80 }],
      location: [],
      placement: [],
      budget: { campaign: [], adset: [] },
      isPartial: false,
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&startDate=2026-04-05&endDate=2026-04-05"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(metaSync.getMetaSelectedRangeTruthReadiness).not.toHaveBeenCalled();
    expect(payload.isPartial).toBe(false);
    expect(payload.age).toHaveLength(1);
  });

  it("uses the published historical end date when a selected range includes today", async () => {
    vi.mocked(readiness.getMetaRangePreparationContext).mockResolvedValue({
      isSelectedCurrentDay: false,
      selectedRangeIncludesCurrentDay: true,
      selectedRangeHistoricalEndDate: "2026-04-04",
      selectedRangeTruthEndDate: "2026-04-04",
      currentDateInTimezone: "2026-04-05",
      primaryAccountTimezone: "UTC",
      withinAuthoritativeHistory: true,
      withinBreakdownHistory: true,
      historicalReadMode: "historical_authoritative",
      breakdownReadMode: "historical_authoritative",
    });
    vi.mocked(serving.getMetaWarehouseBreakdowns).mockResolvedValue({
      age: [{ key: "18-24", label: "18-24", spend: 10, revenue: 22 }],
      location: [],
      placement: [],
      budget: { campaign: [], adset: [] },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&startDate=2026-04-01&endDate=2026-04-05"
      )
    );

    expect(response.status).toBe(200);
    expect(metaSync.getMetaSelectedRangeTruthReadiness).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-04",
    });
    expect(serving.getMetaWarehouseBreakdowns).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-04",
      providerAccountIds: ["act_1"],
    });
  });

  /**
   * The page sends the one account the operator picked. Reading that parameter
   * is the whole point: before this, the route ignored it and answered with
   * every assigned account, so two accounts with different ROAS produced one
   * blended bar carrying the chosen account's name.
   */
  it("narrows the warehouse read to the requested account when it is assigned", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    vi.mocked(serving.getMetaWarehouseBreakdowns).mockResolvedValue({
      age: [{ key: "18-24", label: "18-24", spend: 10, revenue: 22 }],
      location: [],
      placement: [],
      budget: { campaign: [], adset: [] },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&providerAccountId=act_2&startDate=2026-04-01&endDate=2026-04-03"
      )
    );

    expect(response.status).toBe(200);
    expect(serving.getMetaWarehouseBreakdowns).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-03",
      providerAccountIds: ["act_2"],
    });
  });

  /**
   * An id this workspace is not assigned is refused, never widened. Answering
   * with every assigned account would hand back numbers that belong to accounts
   * the caller did not ask for, under the label of one it may not even hold.
   */
  it("refuses an unassigned account instead of silently widening the read", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1"],
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&providerAccountId=act_9&startDate=2026-04-01&endDate=2026-04-03"
      )
    );
    const payload = await response.json();

    expect(payload.status).toBe("account_not_assigned");
    expect(payload.notReadyReason).toContain("not assigned");
    expect(payload.age).toEqual([]);
    expect(serving.getMetaWarehouseBreakdowns).not.toHaveBeenCalled();
  });

  it("keeps the account-wide read when no account is requested", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    vi.mocked(serving.getMetaWarehouseBreakdowns).mockResolvedValue({
      age: [{ key: "18-24", label: "18-24", spend: 10, revenue: 22 }],
      location: [],
      placement: [],
      budget: { campaign: [], adset: [] },
    } as never);

    await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&startDate=2026-04-01&endDate=2026-04-03"
      )
    );

    expect(serving.getMetaWarehouseBreakdowns).toHaveBeenCalledWith({
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-03",
      providerAccountIds: ["act_1", "act_2"],
    });
  });

  /**
   * The warehouse already measures when it last observed these rows; the route
   * used to drop it, which left every reader with no honest as-of and a strong
   * temptation to invent one from its own clock.
   */
  it("serves the warehouse freshness instead of discarding it", async () => {
    vi.mocked(serving.getMetaWarehouseBreakdowns).mockResolvedValue({
      freshness: {
        dataState: "ready",
        lastSyncedAt: "2026-04-04T09:15:00.000Z",
        liveRefreshedAt: null,
        isPartial: false,
        missingWindows: [],
        warnings: [],
      },
      age: [{ key: "18-24", label: "18-24", spend: 10, revenue: 22 }],
      location: [],
      placement: [],
      budget: { campaign: [], adset: [] },
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&startDate=2026-04-01&endDate=2026-04-03"
      )
    );
    const payload = await response.json();

    expect(payload.freshness?.lastSyncedAt).toBe("2026-04-04T09:15:00.000Z");
  });

  it("degrades to the existing no-accounts contract when assignment schema is not ready", async () => {
    vi.mocked(schemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["provider_account_assignments"],
      checkedAt: "2026-04-09T00:00:00.000Z",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=biz&startDate=2026-04-01&endDate=2026-04-03"
      )
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "no_accounts_assigned",
      age: [],
      location: [],
      placement: [],
      isPartial: false,
    });
    expect(assignments.getProviderAccountAssignments).not.toHaveBeenCalled();
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });
});

/**
 * ITEM 17 — THE DEMO BRANCH MUST NOT BYPASS ACCOUNT SCOPING.
 *
 * `getMetaBreakdownsForRange` answers demo workspaces from a fixture, and that
 * branch ran BEFORE the assignment intersection every other caller is subject
 * to. Audiences sends the operator's chosen `providerAccountId` on every
 * request, so a demo workspace answered `act_SOMEONE_ELSES` with UrbanTrail's
 * spend and ROAS under a caption naming the requested account — a fabricated
 * number wearing a real account's identity, which is exactly what the
 * non-demo path refuses with `account_not_assigned`.
 *
 * The demo workspace is EXPLICITLY SINGLE-ACCOUNT: `getDemoMetaStatus()` — the
 * same assignment list every other demo Meta surface reads — holds exactly one
 * id, so the fixture needs no partitioning and is asserted to stay that way. A
 * second demo account is the point at which the fixture must be partitioned
 * rather than shared, and the first assertion below is what fails then.
 */
describe("GET /api/meta/breakdowns — demo workspace account scoping", () => {
  const demoAccountIds = getDemoMetaStatus().assignedAccountIds;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: {} as never,
      membership: {} as never,
    });
    vi.mocked(businessMode.isDemoBusiness).mockResolvedValue(true as never);
  });

  it("is a single-account fixture, so one shared set of rows is not a pooled one", () => {
    expect(demoAccountIds).toHaveLength(1);
  });

  it("serves the fixture for the account the demo workspace actually holds", async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/meta/breakdowns?businessId=demo&providerAccountId=${demoAccountIds[0]}` +
          "&startDate=2026-04-01&endDate=2026-04-03",
      ),
    );
    const payload = await response.json();

    expect(payload.status).toBe("ok");
    expect(payload.age.length).toBeGreaterThan(0);
    expect(payload.placement.length).toBeGreaterThan(0);
  });

  it("refuses an account the demo workspace does not hold instead of answering with another account's rows", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=demo&providerAccountId=act_not_assigned" +
          "&startDate=2026-04-01&endDate=2026-04-03",
      ),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: "account_not_assigned",
      age: [],
      location: [],
      placement: [],
      isPartial: false,
    });
    expect(payload.notReadyReason).toBe(
      "The requested Meta ad account is not assigned to this workspace.",
    );
  });

  it("keeps the account-wide answer when the request names no account", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/meta/breakdowns?businessId=demo&startDate=2026-04-01&endDate=2026-04-03",
      ),
    );
    const payload = await response.json();

    expect(payload.status).toBe("ok");
    expect(payload.age.length).toBeGreaterThan(0);
  });
});
