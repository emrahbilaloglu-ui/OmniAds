import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
  getDbSchemaReadiness: vi.fn().mockResolvedValue({
    ready: true,
    missingTables: [],
    checkedAt: "2026-04-17T00:00:00.000Z",
  }),
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
      accounts.map((account) => [account.externalAccountId, `${account.externalAccountId}-ref`] as const),
    );
  }),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `${businessId}-ref`] as const),
    );
  }),
}));

const syncState = await import("@/lib/shopify/sync-state");

describe("shopify sync state canonical refs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql.mockResolvedValue([]);
  });

  it("normalizes database date objects without shifting local calendar days", async () => {
    sql.mockResolvedValueOnce([
      {
        business_id: "biz-1",
        provider_account_id: "shop-1",
        sync_target: "commerce_orders_historical",
        historical_target_start: new Date(2025, 3, 20),
        historical_target_end: new Date(2026, 3, 19),
        ready_through_date: new Date(2025, 4, 4),
        cursor_timestamp: null,
        cursor_value: "2025-05-04",
        latest_sync_started_at: null,
        latest_successful_sync_at: null,
        latest_sync_status: "succeeded",
        latest_sync_window_start: new Date(2025, 3, 20),
        latest_sync_window_end: new Date(2025, 4, 4),
        last_error: null,
        archived_payload_json: null,
      },
    ]);

    const result = await syncState.getShopifySyncState({
      businessId: "biz-1",
      providerAccountId: "shop-1",
      syncTarget: "commerce_orders_historical",
    });

    expect(result).toEqual(
      expect.objectContaining({
        historicalTargetStart: "2025-04-20",
        historicalTargetEnd: "2026-04-19",
        readyThroughDate: "2025-05-04",
        latestSyncWindowStart: "2025-04-20",
        latestSyncWindowEnd: "2025-05-04",
      })
    );
  });

  it("writes canonical ref ids during upsert", async () => {
    await syncState.upsertShopifySyncState({
      businessId: "biz-1",
      providerAccountId: "shop-1",
      syncTarget: "orders_recent",
      latestSyncStatus: "running",
    });

    const query = String((sql.mock.calls[0]?.[0] as TemplateStringsArray).join(" "));
    expect(query).toContain("business_ref_id");
    expect(query).toContain("provider_account_ref_id");
  });
});
