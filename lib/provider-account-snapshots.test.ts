import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  // Discovery refresh is serialised in the DATABASE now: the in-process map
  // says nothing about the web and worker containers refreshing at once.
  runDbTransaction: vi.fn(async (run: () => Promise<unknown>) => run()),
  getDb: vi.fn(),
}));

vi.mock("@/lib/provider-account-reference-store", () => ({
  resolveBusinessReferenceIds: vi.fn(async (businessIds: string[]) => {
    return new Map(
      businessIds.map((businessId) => [businessId, `business-ref-${businessId}`] as const),
    );
  }),
}));

const db = await import("@/lib/db");

describe("provider account snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes normalized snapshot runs/items and reads them back", async () => {
    let stored = false;
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ");
      queries.push(query);

      if (query.includes("SELECT") && query.includes("FROM provider_account_snapshot_runs")) {
        if (!stored) return [];
        return [
          {
            id: "run_1",
            business_id: "biz_1",
            provider: "meta",
            fetched_at: "2026-01-01T00:00:00.000Z",
            refresh_failed: false,
            last_error: null,
            refresh_requested_at: null,
            last_refresh_attempt_at: null,
            next_refresh_after: null,
            refresh_in_progress: false,
            accounts_hash: "hash_1",
            source_reason: "manual_refresh",
            last_successful_refresh_at: "2026-01-01T00:00:00.000Z",
            refresh_failure_streak: 0,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ];
      }

      if (query.includes("SELECT") && query.includes("FROM provider_account_snapshot_items")) {
        if (!stored) return [];
        return [
          {
            snapshot_run_id: "run_1",
            provider_account_ref_id: "provider-account-1",
            provider_account_id: "acc_1",
            provider_account_name: "Account 1",
            currency: "USD",
            timezone: "UTC",
            is_manager: false,
            position: 0,
            raw_payload: { id: "acc_1", name: "Account 1" },
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ];
      }

      if (query.includes("INSERT INTO provider_account_snapshot_runs")) {
        stored = true;
        return [{ id: "run_1" }];
      }

      if (
        query.includes("INSERT INTO provider_accounts") ||
        query.includes("INSERT INTO provider_account_snapshot_items") ||
        query.includes("DELETE FROM provider_account_snapshot_items")
      ) {
        return [];
      }

      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const { resolveProviderAccountSnapshot } = await import("@/lib/provider-account-snapshots");
    const snapshot = await resolveProviderAccountSnapshot({
      businessId: "biz_1",
      provider: "meta",
      liveLoader: async () => [{ id: "acc_1", name: "Account 1", currency: "USD", timezone: "UTC" }],
    });

    expect(snapshot.accounts).toEqual([
      { id: "acc_1", name: "Account 1", currency: "USD", timezone: "UTC", isManager: false },
    ]);
    expect(queries.join("\n")).toContain("provider_account_snapshot_runs");
    expect(queries.join("\n")).toContain("provider_account_snapshot_items");
    expect(queries.join("\n")).toContain("business_ref_id");
  });

  it("clears canonical snapshot runs by business/provider", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      queries.push(query);
      return [];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const {
      clearAllProviderAccountSnapshotsForProvider,
      clearProviderAccountSnapshot,
    } = await import("@/lib/provider-account-snapshots");
    await clearProviderAccountSnapshot("biz_1", "meta");
    await clearAllProviderAccountSnapshotsForProvider("google");

    expect(queries.join("\n")).toContain("DELETE FROM provider_account_snapshot_runs");
  });

  it("classifies Meta checkpoint account-list refresh failures as auth", async () => {
    const { classifyProviderSnapshotFailure } = await import("@/lib/provider-account-snapshots");

    expect(
      classifyProviderSnapshotFailure(
        "You cannot access the app till you log in to www.facebook.com and follow the instructions given.",
      ),
    ).toBe("auth");
    expect(classifyProviderSnapshotFailure("Facebook checkpoint required.")).toBe("auth");
  });
});
