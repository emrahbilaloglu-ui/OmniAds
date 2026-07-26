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
    let claimOwner: string | null = null;
    let claimEpoch = 0;
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join(" ");
      queries.push(query);

      if (query.includes("INSERT INTO provider_account_snapshot_runs")) {
        // Record the claim this write actually took, so the compare-and-set
        // below answers with the owner and epoch that were written rather than
        // a fixture constant — which would make the CAS vacuous.
        const owner = values.find(
          (value) => typeof value === "string" && /^\d+:[0-9a-f-]{36}$/.test(value),
        );
        if (typeof owner === "string") claimOwner = owner;
        const epoch = values.find(
          (value) => typeof value === "number" && value > 0 && value < 1_000,
        );
        if (typeof epoch === "number") claimEpoch = epoch;
      }

      // The claim CAS. It joins the run to its connection and locks the run row,
      // so connection generation, claim owner and claim epoch are settled in ONE
      // statement instead of three separately-racy reads. Checked BEFORE the
      // generic run read below, which would otherwise shadow it.
      if (query.includes("FOR UPDATE OF run")) {
        return [
          {
            refresh_claim_owner: claimOwner,
            refresh_claim_epoch: String(claimEpoch),
            connection_generation: null,
            connection_status: null,
          },
        ];
      }

      // The run and its items come back from ONE statement now: two separate
      // SELECTs let a reader see run N's metadata with run N+1's accounts, and
      // selection authority reads exactly that pairing.
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
            refresh_claim_owner: claimOwner,
            refresh_claim_epoch: String(claimEpoch),
            refresh_claim_generation: null,
            items: [
              {
                provider_account_id: "acc_1",
                provider_account_name: "Account 1",
                currency: "USD",
                timezone: "UTC",
                is_manager: false,
              },
            ],
          },
        ];
      }

      if (query.includes("INSERT INTO provider_account_snapshot_runs")) {
        stored = true;
        return [{ id: "run_1" }];
      }
      // The claim CAS. It joins the run to its connection and locks the run
      // row, so the whole authority of an in-flight refresh — connection
      // generation, claim owner, claim epoch — is settled in ONE statement
      // rather than three separately-racy reads.
      if (
        query.includes("FROM provider_account_snapshot_runs run") &&
        query.includes("FOR UPDATE OF run")
      ) {
        return [
          {
            refresh_claim_owner: claimOwner,
            refresh_claim_epoch: String(claimEpoch),
            connection_generation: null,
            connection_status: null,
          },
        ];
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
    // The read is ONE statement joining the items laterally, so the run and its
    // accounts always come from a single MVCC snapshot.
    const readQuery = queries.find(
      (query) =>
        query.includes("FROM provider_account_snapshot_runs") && query.includes("SELECT"),
    );
    expect(readQuery).toContain("LEFT JOIN LATERAL");
    // The claim CAS ran, and it ran against the claim this refresh actually
    // took. An old claimant that fails this compare-and-set writes nothing.
    expect(claimOwner).toMatch(/^\d+:[0-9a-f-]{36}$/);
    expect(claimEpoch).toBe(1);
    expect(queries.some((text) => text.includes("FOR UPDATE OF run"))).toBe(true);
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
