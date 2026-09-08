import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
  getDbWithTimeout: vi.fn(),
  runDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
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
          (account) =>
            [account.externalAccountId, `provider-ref-${account.externalAccountId}`] as const,
        ),
      ),
  ),
  resolveBusinessReferenceIds: vi.fn(
    async (businessIds: string[]) =>
      new Map(businessIds.map((id) => [id, `business-ref-${id}`] as const)),
  ),
}));

vi.mock("@/lib/sync/worker-health", () => ({
  recordSyncReclaimEvents: vi.fn().mockResolvedValue(undefined),
}));

const db = await import("@/lib/db");
const {
  buildMetaRawSnapshotContentKey,
  listMetaRawSnapshotsForRun,
  persistMetaRawSnapshot,
  supersedeMetaRawSnapshotsForPartition,
} = await import("@/lib/meta/warehouse");

/**
 * Records the SQL text of every tagged-template query so the structural
 * contracts of the two-layer model can be asserted without a database. The
 * behavioural proofs (coalescing, PIT, FK protection) live in the real-PG
 * provider fixture seam; these are the shape guards that fail fast in unit CI.
 */
function installSqlRecorder(rowsFor: (query: string) => unknown[] = () => []) {
  const queries: string[] = [];
  const tag = (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    const query = typeof strings === "string" ? strings : strings.join("?");
    queries.push(query);
    void values;
    return Promise.resolve(rowsFor(query));
  };
  (tag as unknown as { query: unknown }).query = (query: string) => {
    queries.push(query);
    return Promise.resolve(rowsFor(query));
  };
  vi.mocked(db.getDb).mockReturnValue(tag as never);
  return queries;
}

const BASE_RECORD = {
  businessId: "biz-1",
  providerAccountId: "act_1",
  endpointName: "campaign_configs",
  entityScope: "campaign",
  partitionId: "11111111-1111-4111-8111-111111111111",
  checkpointId: null,
  runId: "run-1",
  pageIndex: 0,
  providerCursor: "cursor-1",
  startDate: "2026-03-01",
  endDate: "2026-03-01",
  accountTimezone: "Europe/Istanbul",
  accountCurrency: "TRY",
  payloadJson: { a: 1 },
  payloadHash: "hash-a",
  requestContext: {},
  responseHeaders: {},
  providerHttpStatus: 200,
  status: "fetched" as const,
  fetchedAt: "2026-03-01T08:00:00.000Z",
};

describe("buildMetaRawSnapshotContentKey", () => {
  it("excludes observation-scoped lifecycle identity", () => {
    // Two observations of the same bytes from different partitions/runs must
    // produce the SAME content key, or content can never be shared.
    const key = buildMetaRawSnapshotContentKey({
      businessId: "biz-1",
      providerAccountId: "act_1",
      endpointName: "campaign_configs",
      entityScope: "campaign",
      startDate: "2026-03-01",
      endDate: "2026-03-01",
      pageIndex: 0,
      payloadHash: "hash-a",
    });
    expect(key).not.toContain("run-1");
    expect(key).toContain("hash-a");
  });

  it("separates components so adjacent fields cannot be re-partitioned", () => {
    // Without a separator that cannot occur in any component,
    // ("ab","c") and ("a","bc") would collapse onto one canonical row and two
    // different businesses' payloads would silently share content.
    const left = buildMetaRawSnapshotContentKey({
      businessId: "ab",
      providerAccountId: "c",
      endpointName: "e",
      entityScope: "s",
      startDate: "2026-03-01",
      endDate: "2026-03-01",
      pageIndex: 0,
      payloadHash: "h",
    });
    const right = buildMetaRawSnapshotContentKey({
      businessId: "a",
      providerAccountId: "bc",
      endpointName: "e",
      entityScope: "s",
      startDate: "2026-03-01",
      endDate: "2026-03-01",
      pageIndex: 0,
      payloadHash: "h",
    });
    expect(left).not.toEqual(right);
  });

  it("distinguishes every scope field", () => {
    const base = {
      businessId: "biz-1",
      providerAccountId: "act_1",
      endpointName: "campaign_configs",
      entityScope: "campaign",
      startDate: "2026-03-01",
      endDate: "2026-03-01",
      pageIndex: 0,
      payloadHash: "hash-a",
    };
    const baseline = buildMetaRawSnapshotContentKey(base);
    for (const override of [
      { businessId: "biz-2" },
      { providerAccountId: "act_2" },
      { endpointName: "adset_configs" },
      { entityScope: "adset" },
      { startDate: "2026-03-02" },
      { endDate: "2026-03-02" },
      { pageIndex: 1 },
      { payloadHash: "hash-b" },
    ]) {
      expect(buildMetaRawSnapshotContentKey({ ...base, ...override })).not.toEqual(
        baseline,
      );
    }
  });
});

describe("persistMetaRawSnapshot two-layer write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes canonical content with NULL lifecycle identity and a separate receipt", async () => {
    const queries = installSqlRecorder((query) =>
      query.includes("INSERT INTO meta_raw_snapshots") ? [{ id: "snap-1" }] : [],
    );
    const id = await persistMetaRawSnapshot(BASE_RECORD as never);
    expect(id).toBe("snap-1");

    const content = queries.find((query) =>
      query.includes("INSERT INTO meta_raw_snapshots"),
    );
    expect(content).toBeDefined();
    // Content identity arbitrates on the partial index; lifecycle columns are
    // literal NULL rather than bound parameters.
    expect(content).toContain("ON CONFLICT (content_key) WHERE content_key IS NOT NULL");
    expect(content).toContain("observation_count = meta_raw_snapshots.observation_count + 1");
    // fetched_at / first_observed_at must never appear in the DO UPDATE SET.
    const doUpdate = content!.slice(content!.indexOf("DO UPDATE SET"));
    expect(doUpdate).not.toContain("fetched_at =");
    expect(doUpdate).not.toContain("first_observed_at =");
    expect(doUpdate).not.toContain("payload_json =");
    expect(doUpdate).not.toContain("status =");

    const receipt = queries.find((query) =>
      query.includes("INSERT INTO meta_raw_snapshot_observations"),
    );
    expect(receipt).toBeDefined();
    expect(receipt).toContain("observed_at");
    // Receipt identity must include the instant, or A->B->A collapses.
    const conflict = receipt!.slice(receipt!.indexOf("ON CONFLICT"));
    expect(conflict).toContain("status");
    expect(conflict).toContain("observed_at");
  });

  it("performs both writes inside one transaction", async () => {
    installSqlRecorder((query) =>
      query.includes("INSERT INTO meta_raw_snapshots") ? [{ id: "snap-1" }] : [],
    );
    await persistMetaRawSnapshot(BASE_RECORD as never);
    expect(vi.mocked(db.runDbTransaction)).toHaveBeenCalledTimes(1);
  });
});

describe("receipt-first readers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes from the receipt timeline with an explicit legacy fallback", async () => {
    const queries = installSqlRecorder(() => []);
    await listMetaRawSnapshotsForRun({
      partitionId: "11111111-1111-4111-8111-111111111111",
      endpointName: "campaign_configs",
      runId: "run-1",
    });
    const query = queries.at(-1)!;
    expect(query).toContain("FROM meta_raw_snapshot_observations receipt");
    // The legacy arm must be restricted to pre-model rows, or a new row would
    // be counted twice by the UNION ALL.
    expect(query).toContain("legacy.content_key IS NULL");
  });

  it("returns exactly one resume authority per page while keeping the timeline", async () => {
    const queries = installSqlRecorder(() => []);
    await listMetaRawSnapshotsForRun({
      partitionId: "11111111-1111-4111-8111-111111111111",
      endpointName: "campaign_configs",
      runId: "run-1",
    });
    const query = queries.at(-1)!;
    // Receipts are append-only: a retried page has two, and a superseded
    // partition adds a third. Resume validation rejects a duplicate page_index
    // outright, so without this the restore path breaks on exactly the runs
    // that needed it.
    expect(query).toContain("DISTINCT ON (receipt.page_index)");
    expect(query).toContain("receipt.observed_at DESC");
    // Superseded evidence is retired, not resumable.
    expect(query).toContain("receipt.status <> 'superseded'");
    // The narrowing is scoped to the resume view; nothing deletes or rewrites
    // a receipt, so the point-in-time timeline is unaffected.
    expect(query).not.toMatch(/DELETE|UPDATE/);
  });

  it("supersedes by appending a receipt event and never rewrites shared content", async () => {
    const queries = installSqlRecorder(() => []);
    await supersedeMetaRawSnapshotsForPartition({
      partitionId: "11111111-1111-4111-8111-111111111111",
    });
    const appended = queries.find((query) =>
      query.includes("INSERT INTO meta_raw_snapshot_observations"),
    );
    expect(appended).toBeDefined();
    // DISTINCT ON is load-bearing: ON CONFLICT cannot arbitrate two rows
    // produced by the same statement.
    expect(appended).toContain("SELECT DISTINCT ON");
    const legacy = queries.find((query) =>
      query.includes("UPDATE meta_raw_snapshots"),
    );
    expect(legacy).toBeDefined();
    expect(legacy).toContain("content_key IS NULL");
  });
});
