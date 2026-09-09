import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = Object.assign(vi.fn(), {
  query: vi.fn(),
});

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
  getDbSchemaReadiness: vi.fn().mockResolvedValue({
    ready: true,
    missingTables: [],
    checkedAt: "2026-04-19T00:00:00.000Z",
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
  ensureProviderAccountReferenceIds: vi.fn(
    async ({ accounts }: { accounts: Array<{ externalAccountId: string }> }) =>
      new Map(
        accounts.map((account) => [
          account.externalAccountId,
          `${account.externalAccountId}-ref`,
        ] as const),
      ),
  ),
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `${businessId}-ref`] as const),
    );
  }),
}));

const syncState = await import("@/lib/shopify/sync-state");
const dbSchemaReadiness = await import("@/lib/db-schema-readiness");

describe("shopify sync-state archive lane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql.mockResolvedValue([]);
    sql.query.mockResolvedValue([]);
    vi.mocked(dbSchemaReadiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-19T00:00:00.000Z",
    } as never);
  });

  it("writes sync result summaries to the archive lane instead of the main row", async () => {
    await syncState.upsertShopifySyncState({
      businessId: "biz-1",
      providerAccountId: "shop-1.myshopify.com",
      syncTarget: "commerce_orders_recent",
      latestSyncStatus: "succeeded",
      lastResultSummary: { imported: 12 },
    });

    const templateSql = sql.mock.calls
      .map(([strings]) => String((strings as TemplateStringsArray).join(" ")))
      .join("\n");

    expect(templateSql).toContain("INSERT INTO shopify_sync_state");
    expect(templateSql).not.toContain("last_result_summary");
    expect(templateSql).toContain("INSERT INTO shopify_entity_payload_archives");
    expect(templateSql).toContain("sync_state_detail");
  });

  it("hydrates sync result summaries from archived payloads", async () => {
    sql
      .mockResolvedValueOnce([
        {
          business_id: "biz-1",
          provider_account_id: "shop-1.myshopify.com",
          sync_target: "commerce_orders_recent",
          historical_target_start: null,
          historical_target_end: null,
          ready_through_date: null,
          cursor_timestamp: null,
          cursor_value: null,
          latest_sync_started_at: "2026-04-19T00:00:00.000Z",
          latest_successful_sync_at: "2026-04-19T00:01:00.000Z",
          latest_sync_status: "succeeded",
          latest_sync_window_start: null,
          latest_sync_window_end: null,
          last_error: null,
          archived_payload_json: {
            lastResultSummary: {
              imported: 12,
              reconciled: true,
            },
          },
        },
      ]);

    const state = await syncState.getShopifySyncState({
      businessId: "biz-1",
      providerAccountId: "shop-1.myshopify.com",
      syncTarget: "commerce_orders_recent",
    });

    expect(state?.lastResultSummary).toEqual({
      imported: 12,
      reconciled: true,
    });
  });

  it("fails closed when the archive lane is not ready", async () => {
    vi.mocked(dbSchemaReadiness.getDbSchemaReadiness).mockResolvedValueOnce({
      ready: false,
      missingTables: ["shopify_entity_payload_archives"],
      checkedAt: "2026-04-19T00:00:00.000Z",
    } as never);

    const state = await syncState.getShopifySyncState({
      businessId: "biz-1",
      providerAccountId: "shop-1.myshopify.com",
      syncTarget: "commerce_orders_recent",
    });

    expect(state).toBeNull();
    expect(sql).not.toHaveBeenCalled();
  });
});
