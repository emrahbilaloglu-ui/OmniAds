import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Selected ids must never be laundered into authoritative provider data.
 *
 * The read path used to synthesize a row for every selected id the provider had
 * not reported — `{ id, name: id, assigned: true }` — and in the no-snapshot
 * case labelled the result `sourceHealth: 'healthy_cached'`, `trustLevel:
 * 'safe'` while `stale: true`. Those rows are indistinguishable from real ones
 * to every caller, including `toSnapshotResultFromPayload`, which writes them
 * back into the snapshot store. An arbitrary or revoked id therefore acquired
 * the appearance of provider truth by being selected.
 *
 * These tests previously asserted that behaviour. They now assert the opposite:
 * account data contains only what the provider reported, and a selected id that
 * is missing from it is reported separately as a reconciliation problem.
 */

vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(),
}));

vi.mock("@/lib/provider-account-snapshots", () => ({
  readProviderAccountSnapshot: vi.fn(),
}));

const providerAssignments = await import("@/lib/provider-account-assignments");
const providerSnapshots = await import("@/lib/provider-account-snapshots");
const { resolveProviderDiscoveryPayload, reconcileAssignments, toSnapshotResultFromPayload } =
  await import("@/lib/provider-account-discovery");

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

const resolve = (provider: "meta" | "google" = "meta") =>
  resolveProviderDiscoveryPayload({
    businessId: "biz_1",
    provider,
    refreshRequested: false,
    liveLoader: vi.fn().mockResolvedValue([]),
    missingSnapshotNotice: "missing",
    degradedNotice: "degraded",
    unavailableNotice: "unavailable",
  });

describe("provider discovery read path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(providerAssignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["acct_1"],
    } as never);
  });

  it("marks a reported account as assigned", async () => {
    vi.mocked(providerSnapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [{ id: "acct_1", name: "Account 1" }],
      meta: buildSnapshotMeta(),
    } as never);

    const payload = await resolve("google");
    expect(payload.data).toEqual([{ id: "acct_1", name: "Account 1", assigned: true }]);
    expect(payload.invalidAssignedAccountIds).toEqual([]);
  });

  it("does not invent a row for a selected id the provider never reported", async () => {
    vi.mocked(providerSnapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [{ id: "acct_other", name: "Other" }],
      meta: buildSnapshotMeta(),
    } as never);

    const payload = await resolve("google");
    expect(payload.data).toEqual([{ id: "acct_other", name: "Other", assigned: false }]);
    // The disagreement is reported, not merged into the account data.
    expect(payload.invalidAssignedAccountIds).toEqual(["acct_1"]);
  });

  it("returns no account data when a persisted snapshot is empty", async () => {
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

    const payload = await resolve();
    expect(payload.data).toEqual([]);
    expect(payload.invalidAssignedAccountIds).toEqual(["acct_1"]);
    expect(payload.notice).toBe("degraded");
    // The provider failure class stays visible rather than being replaced by a
    // reassuring one.
    expect(payload.meta.failureClass).toBe("auth");
  });

  it("reports blocking health when no snapshot exists, not healthy_cached", async () => {
    vi.mocked(providerSnapshots.readProviderAccountSnapshot).mockResolvedValue(null as never);

    const payload = await resolve();
    expect(payload.data).toEqual([]);
    expect(payload.invalidAssignedAccountIds).toEqual(["acct_1"]);
    expect(payload.meta.sourceHealth).toBe("degraded_blocking");
    expect(payload.meta.trustLevel).toBe("blocking");
    expect(payload.meta.stale).toBe(true);
    expect(payload.notice).toBe("missing");
  });

  it("does not destructively clear selection during a provider outage", async () => {
    // Selection survives; only its ELIGIBILITY is withheld. Clearing here would
    // turn a transient provider failure into permanent data loss.
    vi.mocked(providerSnapshots.readProviderAccountSnapshot).mockResolvedValue(null as never);
    const payload = await resolve();
    expect(payload.invalidAssignedAccountIds).toEqual(["acct_1"]);
    expect(
      vi.mocked(providerAssignments.getProviderAccountAssignments).mock.calls.length,
    ).toBe(1);
  });

  it("recovers cleanly once the provider reports the account again", async () => {
    vi.mocked(providerSnapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [{ id: "acct_1", name: "Account 1" }],
      meta: buildSnapshotMeta({ sourceHealth: "fresh", stale: false }),
    } as never);
    const payload = await resolve("google");
    expect(payload.invalidAssignedAccountIds).toEqual([]);
    expect(payload.data[0]?.assigned).toBe(true);
  });

  it("never writes an unreported id back into the snapshot store", async () => {
    vi.mocked(providerSnapshots.readProviderAccountSnapshot).mockResolvedValue({
      accounts: [{ id: "acct_other", name: "Other" }],
      meta: buildSnapshotMeta(),
    } as never);
    const payload = await resolve("google");
    const asSnapshot = toSnapshotResultFromPayload(payload);
    expect(asSnapshot.accounts.map((account) => account.id)).toEqual(["acct_other"]);
  });
});

describe("reconcileAssignments", () => {
  it("treats act_100 and 100 as one Meta account", () => {
    const result = reconcileAssignments(
      "meta",
      [{ id: "act_100", name: "Mine" }],
      ["100"],
    );
    expect(result.rows[0]?.assigned).toBe(true);
    expect(result.invalidAssignedAccountIds).toEqual([]);
  });

  it("reports an arbitrary id as invalid rather than accessible", () => {
    const result = reconcileAssignments(
      "meta",
      [{ id: "act_100", name: "Mine" }],
      ["act_999"],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.assigned).toBe(false);
    expect(result.invalidAssignedAccountIds).toEqual(["act_999"]);
  });
});
