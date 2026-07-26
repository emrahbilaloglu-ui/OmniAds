import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/provider-account-snapshots", () => ({
  forceProviderAccountSnapshotRefresh: vi.fn(),
}));

const providerAssignments = await import("@/lib/provider-account-assignments");
const providerSnapshots = await import("@/lib/provider-account-snapshots");
const { refreshProviderDiscoveryPayload } = await import("@/lib/provider-account-discovery-refresh");

describe("provider discovery refresh path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(providerAssignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["acct_1"],
    } as never);
    vi.mocked(providerSnapshots.forceProviderAccountSnapshotRefresh).mockResolvedValue({
      accounts: [
        { id: "acct_1", name: "Account 1" },
        { id: "acct_2", name: "Account 2" },
      ],
      meta: {
        source: "live",
        sourceHealth: "fresh",
        fetchedAt: "2026-05-14T12:00:00.000Z",
        stale: false,
        refreshFailed: false,
        failureClass: null,
        lastError: null,
        lastKnownGoodAvailable: true,
        refreshRequestedAt: null,
        lastRefreshAttemptAt: null,
        nextRefreshAfter: null,
        retryAfterAt: null,
        refreshInProgress: false,
        sourceReason: "assignment_drawer_manual_refresh",
        trustLevel: "safe",
        trustScore: 100,
      },
    } as never);
  });

  it("forces a provider account snapshot refresh and reapplies assignments", async () => {
    const liveLoader = vi.fn().mockResolvedValue([]);

    const payload = await refreshProviderDiscoveryPayload({
      businessId: "biz_1",
      provider: "meta",
      liveLoader,
      freshnessMs: 1000,
    });

    expect(providerSnapshots.forceProviderAccountSnapshotRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz_1",
        provider: "meta",
        liveLoader,
        freshnessMs: 1000,
        reason: "assignment_drawer_manual_refresh",
      }),
    );
    expect(payload.notice).toBeNull();
    expect(payload.data).toEqual([
      { id: "acct_1", name: "Account 1", assigned: true },
      { id: "acct_2", name: "Account 2", assigned: false },
    ]);
  });

  it("reports a selected id missing from a fresh refresh instead of inventing a row", async () => {
    // A manual refresh is the strongest evidence available — it just asked the
    // provider. An id it did not return is not accessible, and appending it as
    // `{ id, name: id, assigned: true }` made a revoked or arbitrary id
    // indistinguishable from a real account.
    vi.mocked(providerAssignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["acct_1", "acct_missing"],
    } as never);

    const payload = await refreshProviderDiscoveryPayload({
      businessId: "biz_1",
      provider: "meta",
      liveLoader: vi.fn().mockResolvedValue([]),
    });

    expect(payload.data).toEqual([
      { id: "acct_1", name: "Account 1", assigned: true },
      { id: "acct_2", name: "Account 2", assigned: false },
    ]);
    expect(payload.invalidAssignedAccountIds).toEqual(["acct_missing"]);
  });
});
