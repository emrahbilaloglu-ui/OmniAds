import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/provider-account-snapshots", () => ({
  readProviderAccountSnapshot: vi.fn(),
  requestProviderAccountSnapshotRefresh: vi.fn(),
  forceProviderAccountSnapshotRefresh: vi.fn(),
}));

const providerAssignments = await import("@/lib/provider-account-assignments");
const providerSnapshots = await import("@/lib/provider-account-snapshots");
const { resolveProviderDiscoveryPayload } = await import("@/lib/provider-account-discovery");

function buildSnapshotMeta(overrides: Record<string, unknown> = {}) {
  return {
    source: "snapshot",
    sourceHealth: "stale_cached",
    fetchedAt: "2026-04-08T10:00:00.000Z",
    stale: true,
    refreshFailed: false,
    failureClass: null,
    lastError: null,
    lastKnownGoodAvailable: true,
    refreshRequestedAt: null,
    lastRefreshAttemptAt: null,
    nextRefreshAfter: null,
    retryAfterAt: null,
    refreshInProgress: false,
    sourceReason: "stale_snapshot",
    trustLevel: "safe",
    trustScore: 72,
    snapshotAgeHours: 8,
    lastSuccessfulRefreshAgeHours: 8,
    refreshFailureStreak: 0,
    ...overrides,
  };
}

describe("provider discovery read path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(providerAssignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["acct_1"],
    } as never);
  });

  it("does not schedule a background refresh when a stale snapshot is served", async () => {
    vi.mocked(providerSnapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [{ id: "acct_1", name: "Account 1" }],
      meta: buildSnapshotMeta(),
    } as never);

    const payload = await resolveProviderDiscoveryPayload({
      businessId: "biz_1",
      provider: "google",
      refreshRequested: false,
      liveLoader: vi.fn().mockResolvedValue([]),
      missingSnapshotNotice: "missing",
      degradedNotice: "degraded",
      unavailableNotice: "unavailable",
    });

    expect(payload.data).toEqual([{ id: "acct_1", name: "Account 1", assigned: true }]);
    expect(providerSnapshots.requestProviderAccountSnapshotRefresh).not.toHaveBeenCalled();
    expect(providerSnapshots.forceProviderAccountSnapshotRefresh).not.toHaveBeenCalled();
  });

  it("does not force a snapshot refresh when GET requests ask for refresh", async () => {
    vi.mocked(providerSnapshots.readProviderAccountSnapshot).mockResolvedValue(null as never);

    const payload = await resolveProviderDiscoveryPayload({
      businessId: "biz_1",
      provider: "meta",
      refreshRequested: true,
      liveLoader: vi.fn().mockResolvedValue([]),
      missingSnapshotNotice: "missing",
      degradedNotice: "degraded",
      unavailableNotice: "unavailable",
    });

    expect(payload.data).toEqual([{ id: "acct_1", name: "acct_1", assigned: true }]);
    expect(payload.notice).toBe("missing");
    expect(providerSnapshots.requestProviderAccountSnapshotRefresh).not.toHaveBeenCalled();
    expect(providerSnapshots.forceProviderAccountSnapshotRefresh).not.toHaveBeenCalled();
  });

  it("keeps assigned fallback rows when a persisted snapshot is empty or failed", async () => {
    vi.mocked(providerSnapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [],
      meta: buildSnapshotMeta({
        sourceHealth: "degraded_blocking",
        refreshFailed: true,
        failureClass: "auth",
        lastError: "You cannot access the app till you log in to www.facebook.com.",
        lastKnownGoodAvailable: false,
        trustLevel: "blocking",
        trustScore: 0,
      }),
    } as never);

    const payload = await resolveProviderDiscoveryPayload({
      businessId: "biz_1",
      provider: "meta",
      refreshRequested: false,
      liveLoader: vi.fn().mockResolvedValue([]),
      missingSnapshotNotice: "missing",
      degradedNotice: "degraded",
      unavailableNotice: "unavailable",
    });

    expect(payload.data).toEqual([{ id: "acct_1", name: "acct_1", assigned: true }]);
    expect(payload.notice).toBe("degraded");
    expect(payload.meta.failureClass).toBe("auth");
  });
});
