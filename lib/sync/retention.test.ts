import { beforeEach, describe, expect, it, vi } from "vitest";

const getDbWithTimeout = vi.fn();
const assertDbSchemaReady = vi.fn();
const acquireSyncRunnerLease = vi.fn();
const releaseSyncRunnerLease = vi.fn();

vi.mock("@/lib/db", () => ({
  getDbWithTimeout,
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady,
}));

vi.mock("@/lib/sync/worker-health", () => ({
  acquireSyncRunnerLease,
  releaseSyncRunnerLease,
}));

const retention = await import("@/lib/sync/retention");

describe("pruneSyncLifecycleData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(assertDbSchemaReady).mockResolvedValue(undefined);
    delete process.env.SYNC_RETENTION_QUERY_TIMEOUT_MS;
    delete process.env.SYNC_RETENTION_BATCH_SIZE;
    delete process.env.SYNC_RETENTION_LEASE_MINUTES;
  });

  it("skips pruning when another retention lease is active", async () => {
    const sql = vi.fn();
    vi.mocked(getDbWithTimeout).mockReturnValue(sql as never);
    vi.mocked(acquireSyncRunnerLease).mockResolvedValue(false);

    const result = await retention.pruneSyncLifecycleData();

    expect(result).toEqual(
      expect.objectContaining({
        googleRawSnapshotsDeleted: 0,
        googleCheckpointsDeleted: 0,
        metaRawSnapshotsDeleted: 0,
        metaCheckpointsDeleted: 0,
        workerHeartbeatsDeleted: 0,
        reclaimEventsDeleted: 0,
        skippedDueToActiveLease: true,
      }),
    );
    expect(sql).not.toHaveBeenCalled();
    expect(releaseSyncRunnerLease).not.toHaveBeenCalled();
  });

  it("batches deletes and releases the retention lease when pruning completes", async () => {
    process.env.SYNC_RETENTION_BATCH_SIZE = "2";
    const sql = vi
      .fn()
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 1 }])
      .mockResolvedValueOnce([{ count: 2 }])
      .mockResolvedValueOnce([{ count: 1 }]);
    vi.mocked(getDbWithTimeout).mockReturnValue(sql as never);
    vi.mocked(acquireSyncRunnerLease).mockResolvedValue(true);
    vi.mocked(releaseSyncRunnerLease).mockResolvedValue(undefined);

    const result = await retention.pruneSyncLifecycleData();

    expect(result).toEqual(
      expect.objectContaining({
        googleRawSnapshotsDeleted: 3,
        googleCheckpointsDeleted: 1,
        metaRawSnapshotsDeleted: 0,
        metaCheckpointsDeleted: 0,
        workerHeartbeatsDeleted: 4,
        reclaimEventsDeleted: 3,
        skippedDueToActiveLease: false,
      }),
    );
    expect(sql).toHaveBeenCalledTimes(10);
    const queries = sql.mock.calls.map(([strings]) => (strings as TemplateStringsArray).join(""));
    expect(queries[0]).toContain("FROM google_ads_raw_snapshots snapshot");
    expect(queries[0]).toContain("WHERE EXISTS");
    expect(queries[0]).toContain("FROM google_ads_sync_partitions partition");
    expect(queries[0]).not.toContain("JOIN google_ads_sync_partitions partition");
    expect(queries[2]).toContain("FROM meta_raw_snapshots snapshot");
    expect(queries[2]).toContain("WHERE EXISTS");
    expect(queries[2]).toContain("FROM meta_sync_partitions partition");
    expect(queries[2]).not.toContain("JOIN meta_sync_partitions partition");
    expect(releaseSyncRunnerLease).toHaveBeenCalledTimes(1);
  });
});
