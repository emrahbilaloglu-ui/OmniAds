import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn(),
  isMissingRelationError: vi.fn(() => false),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  /*
    ROUND 22, ITEM 1: the bindings view of the same store. `refIds` is what the
    id-only helper returns; `timezones` is what the binding actually holds
    afterwards, which writers now stamp their rows from. Mocked here as the
    identity of what was passed, because these suites are not about the binding
    rule -- lib/provider-account-timezone-authority.db.test.ts proves that
    against a real PostgreSQL.
  */
  ensureProviderAccountReferenceBindings: vi.fn(
    async ({
      accounts,
    }: {
      accounts: Array<{ externalAccountId: string; timezone?: string | null }>;
    }) => ({
      refIds: new Map(
        accounts.map(
          (account) =>
            [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const,
        ),
      ),
      timezones: new Map(
        accounts
          .filter((account) => (account.timezone ?? "").trim().length > 0)
          .map((account) => [account.externalAccountId, String(account.timezone)] as const),
      ),
    }),
  ),
  ensureProviderAccountReferenceIds: vi.fn(async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) => {
    return new Map(
      accounts.map((account) => [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const),
    );
  }),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `business-ref-${businessId}`] as const),
    );
  }),
}));

const schemaReadiness = await import("@/lib/db-schema-readiness");
const {
  persistShopifyOverviewServingState,
  recordShopifyOverviewReconciliationRun,
} = await import("@/lib/shopify/overview-materializer");

describe("shopify overview materializer", () => {
  const readinessResult = {
    ready: true,
    missingTables: [],
    checkedAt: "2026-04-09T00:00:00.000Z",
  } satisfies Awaited<ReturnType<typeof schemaReadiness.assertDbSchemaReady>>;

  beforeEach(() => {
    vi.resetAllMocks();
    sql.mockResolvedValue([]);
    vi.mocked(schemaReadiness.assertDbSchemaReady).mockResolvedValue(readinessResult);
  });

  it("persists serving state only through explicit materialization tables", async () => {
    await persistShopifyOverviewServingState({
      businessId: "biz_1",
      providerAccountId: "shop",
      canaryKey: "canary",
      startDate: "2026-03-01",
      endDate: "2026-03-30",
      timeZoneBasis: "shop",
      assessedAt: "2026-04-09T00:00:00.000Z",
      statusState: "partial",
      preferredSource: "live",
      productionMode: "auto",
      trustState: "pending_repair",
      fallbackReason: "pending_repair",
      coverageStatus: "historical_incomplete",
      pendingRepair: true,
      pendingRepairStartedAt: "2026-04-09T00:00:00.000Z",
      pendingRepairLastTopic: "ORDERS_UPDATED",
      pendingRepairLastReceivedAt: "2026-04-09T00:00:00.000Z",
      consecutiveCleanValidations: 0,
      ordersRecentSyncedAt: null,
      ordersRecentCursorTimestamp: null,
      ordersRecentCursorValue: null,
      returnsRecentSyncedAt: null,
      returnsRecentCursorTimestamp: null,
      returnsRecentCursorValue: null,
      ordersHistoricalSyncedAt: null,
      ordersHistoricalReadyThroughDate: null,
      ordersHistoricalTargetEnd: null,
      returnsHistoricalSyncedAt: null,
      returnsHistoricalReadyThroughDate: null,
      returnsHistoricalTargetEnd: null,
      canServeWarehouse: false,
      canaryEnabled: true,
      decisionReasons: ["pending_repair"],
      divergence: null,
    });

    expect(sql).toHaveBeenCalledTimes(2);
    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain(
      "INSERT INTO shopify_serving_state",
    );
    expect(String(sql.mock.calls[1]?.[0]?.join(" ") ?? "")).toContain(
      "INSERT INTO shopify_serving_state_history",
    );
  });

  it("records reconciliation evidence only in shopify_reconciliation_runs", async () => {
    await recordShopifyOverviewReconciliationRun({
      businessId: "biz_1",
      providerAccountId: "shop",
      reconciliationKey: "range-key",
      startDate: "2026-03-01",
      endDate: "2026-03-30",
      preferredSource: "warehouse",
      canServeWarehouse: true,
      selectedRevenueTruthBasis: "ledger",
      basisSelectionReason: "consistent",
      transactionCoverageOrderRate: 1,
      transactionCoverageAmountRate: 1,
      orderRevenueTruthDelta: 0,
      transactionRevenueDelta: 0,
      explainedAdjustmentRevenue: 0,
      unexplainedAdjustmentRevenue: 0,
      divergence: null,
      warehouseAggregate: null,
      ledgerAggregate: null,
      liveAggregate: null,
      recordedAt: "2026-04-09T00:00:00.000Z",
      createdAt: null,
    });

    expect(String(sql.mock.calls[0]?.[0]?.join(" ") ?? "")).toContain(
      "INSERT INTO shopify_reconciliation_runs",
    );
  });
});
