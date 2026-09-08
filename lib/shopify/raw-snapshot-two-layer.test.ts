import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = Object.assign(vi.fn(), { query: vi.fn() });

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn().mockResolvedValue(undefined),
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
        accounts.map(
          (account) => [account.externalAccountId, `${account.externalAccountId}-ref`] as const,
        ),
      ),
  ),
  resolveBusinessReferenceIds: vi.fn(
    async (businessIds: string[]) =>
      new Map(businessIds.map((id) => [id, `${id}-ref`] as const)),
  ),
}));

const db = await import("@/lib/db");
const { buildShopifyRawSnapshotContentKey, insertShopifyRawSnapshot } = await import(
  "@/lib/shopify/warehouse"
);

function recordedQueries() {
  return sql.mock.calls.map((call) => {
    const first = call[0] as TemplateStringsArray | string;
    return typeof first === "string" ? first : first.join("?");
  });
}

describe("buildShopifyRawSnapshotContentKey", () => {
  const base = {
    businessId: "biz-1",
    providerAccountId: "shop-1",
    endpointName: "orders",
    entityScope: "shop",
    startDate: "2026-03-01",
    endDate: "2026-03-01",
    payloadHash: "hash-a",
  };

  it("excludes status and observation time from content identity", () => {
    // A failed observation of identical bytes must reach the SAME canonical
    // row, or an outage would duplicate content instead of being recorded.
    const key = buildShopifyRawSnapshotContentKey(base);
    expect(key).toContain("hash-a");
    expect(key).not.toContain("fetched");
  });

  it("distinguishes every scope field", () => {
    const baseline = buildShopifyRawSnapshotContentKey(base);
    for (const override of [
      { businessId: "biz-2" },
      { providerAccountId: "shop-2" },
      { endpointName: "customers" },
      { entityScope: "order" },
      { startDate: "2026-03-02" },
      { endDate: "2026-03-02" },
      { payloadHash: "hash-b" },
    ]) {
      expect(buildShopifyRawSnapshotContentKey({ ...base, ...override })).not.toEqual(
        baseline,
      );
    }
  });

  it("separates components so adjacent fields cannot be re-partitioned", () => {
    expect(
      buildShopifyRawSnapshotContentKey({ ...base, businessId: "ab", providerAccountId: "c" }),
    ).not.toEqual(
      buildShopifyRawSnapshotContentKey({ ...base, businessId: "a", providerAccountId: "bc" }),
    );
  });

  it("treats a missing date window as an explicit empty component", () => {
    // start_date/end_date are nullable on this table. Dropping the component
    // entirely would let (null, "2026-03-01") and ("2026-03-01", null) collide.
    expect(
      buildShopifyRawSnapshotContentKey({ ...base, startDate: null, endDate: "2026-03-01" }),
    ).not.toEqual(
      buildShopifyRawSnapshotContentKey({ ...base, startDate: "2026-03-01", endDate: null }),
    );
  });
});

describe("insertShopifyRawSnapshot two-layer write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql.mockResolvedValue([{ id: "snap-1" }]);
    sql.query.mockResolvedValue([]);
  });

  it("writes canonical content and a separate receipt in one transaction", async () => {
    const id = await insertShopifyRawSnapshot({
      businessId: "biz-1",
      providerAccountId: "shop-1",
      endpointName: "orders",
      entityScope: "shop",
      payloadJson: { rows: [] },
      payloadHash: "hash-1",
      status: "fetched",
    } as never);
    expect(id).toBe("snap-1");
    expect(vi.mocked(db.runDbTransaction)).toHaveBeenCalledTimes(1);

    const queries = recordedQueries();
    const content = queries.find((query) =>
      query.includes("INSERT INTO shopify_raw_snapshots"),
    );
    expect(content).toContain("ON CONFLICT (content_key) WHERE content_key IS NOT NULL");
    const doUpdate = content!.slice(content!.indexOf("DO UPDATE SET"));
    // Content is immutable — the heartbeat may only advance last_observed_at
    // and the counter.
    expect(doUpdate).not.toContain("fetched_at =");
    expect(doUpdate).not.toContain("first_observed_at =");
    expect(doUpdate).not.toContain("payload_json =");
    expect(doUpdate).not.toContain("status =");
    expect(doUpdate).toContain(
      "observation_count = shopify_raw_snapshots.observation_count + 1",
    );

    const receipt = queries.find((query) =>
      query.includes("INSERT INTO shopify_raw_snapshot_observations"),
    );
    expect(receipt).toBeDefined();
    expect(receipt).toContain("ON CONFLICT (snapshot_id, status, observed_at)");
  });

  it("does not write a receipt when no canonical content row is returned", async () => {
    sql.mockResolvedValue([]);
    const id = await insertShopifyRawSnapshot({
      businessId: "biz-1",
      providerAccountId: "shop-1",
      endpointName: "orders",
      entityScope: "shop",
      payloadJson: { rows: [] },
      payloadHash: "hash-1",
      status: "fetched",
    } as never);
    expect(id).toBeNull();
    expect(
      recordedQueries().some((query) =>
        query.includes("INSERT INTO shopify_raw_snapshot_observations"),
      ),
    ).toBe(false);
  });
});
