import { beforeEach, describe, expect, it, vi } from "vitest";

const getDbWithTimeout = vi.fn();
const assertDbSchemaReady = vi.fn();
const acquireSyncRunnerLease = vi.fn();
const releaseSyncRunnerLease = vi.fn();
const assertSyncRetentionExecutionReady = vi.fn();

vi.mock("@/lib/sync/global-kill-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/sync/global-kill-switch")>();
  return {
    ...actual,
    // Lanes default to OFF so a host cannot resume writing before an operator
    // says so. These suites are about the code behind the switch, not the
    // switch itself, which has its own tests.
    assertSyncLaneEnabled: vi.fn(() => ({
      lane: "meta_sync" as const,
      enabled: true,
      reason: "enabled" as const,
    })),
  };
});

vi.mock("@/lib/db", () => ({
  getDbWithTimeout,
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady,
}));

vi.mock("@/lib/sync/retention-readiness", () => ({
  assertSyncRetentionExecutionReady,
}));

vi.mock("@/lib/sync/worker-health", () => ({
  acquireSyncRunnerLease,
  releaseSyncRunnerLease,
}));

const retention = await import("@/lib/sync/retention");

/**
 * The retention client is used two ways: tagged templates for the sweeps whose
 * SQL is fully static, and `.query(text, params)` for the raw-content and
 * receipt sweeps, whose candidate SQL is a shared exported constant. This
 * recorder captures both in call order, so the ORDER of the sweeps — which is
 * load-bearing, receipts before content — can be asserted, not just their text.
 */
function installRecorder(counts: number[]) {
  const seen: string[] = [];
  let index = 0;
  const next = () => {
    const value = counts[index] ?? 0;
    index += 1;
    return Promise.resolve([{ count: value }]);
  };
  const sql = vi.fn((strings: TemplateStringsArray) => {
    seen.push(strings.join(""));
    return next();
  });
  (sql as unknown as { query: unknown }).query = vi.fn((text: string) => {
    seen.push(text);
    return next();
  });
  vi.mocked(getDbWithTimeout).mockReturnValue(sql as never);
  return { sql, seen };
}

describe("pruneSyncLifecycleData", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(assertDbSchemaReady).mockResolvedValue(undefined);
    vi.mocked(assertSyncRetentionExecutionReady).mockResolvedValue(undefined);
    delete process.env.SYNC_RETENTION_QUERY_TIMEOUT_MS;
    delete process.env.SYNC_RETENTION_BATCH_SIZE;
    delete process.env.SYNC_RETENTION_LEASE_MINUTES;
  });

  it("refuses with zero mutation when the execution schema has drifted", async () => {
    const { sql } = installRecorder([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    vi.mocked(acquireSyncRunnerLease).mockResolvedValue(true);
    vi.mocked(assertSyncRetentionExecutionReady).mockRejectedValue(
      new Error("sync retention execution schema is not ready"),
    );

    await expect(retention.pruneSyncLifecycleData()).rejects.toThrow(
      "sync retention execution schema is not ready",
    );

    // Zero mutation means zero of everything: no claim, no delete, and no
    // lease taken that a crash could leave stranded.
    expect(sql).not.toHaveBeenCalled();
    expect(
      (sql as unknown as { query: ReturnType<typeof vi.fn> }).query,
    ).not.toHaveBeenCalled();
    expect(acquireSyncRunnerLease).not.toHaveBeenCalled();
    expect(releaseSyncRunnerLease).not.toHaveBeenCalled();
  });

  it("skips pruning when another retention lease is active", async () => {
    const { sql } = installRecorder([]);
    vi.mocked(acquireSyncRunnerLease).mockResolvedValue(false);

    const result = await retention.pruneSyncLifecycleData();

    expect(result).toEqual(
      expect.objectContaining({
        googleRawSnapshotsDeleted: 0,
        googleCheckpointsDeleted: 0,
        metaRawSnapshotsDeleted: 0,
        metaRawSnapshotObservationsDeleted: 0,
        shopifyRawSnapshotsDeleted: 0,
        shopifyRawSnapshotObservationsDeleted: 0,
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
    // One batch each: a count below the batch size ends that sweep's loop.
    const { seen } = installRecorder([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    vi.mocked(acquireSyncRunnerLease).mockResolvedValue(true);
    vi.mocked(releaseSyncRunnerLease).mockResolvedValue(undefined);

    const result = await retention.pruneSyncLifecycleData();

    expect(result).toEqual(
      expect.objectContaining({
        googleRawSnapshotsDeleted: 1,
        metaRawSnapshotObservationsDeleted: 1,
        shopifyRawSnapshotObservationsDeleted: 1,
        metaRawSnapshotsDeleted: 1,
        shopifyRawSnapshotsDeleted: 1,
        googleCheckpointsDeleted: 1,
        metaCheckpointsDeleted: 1,
        workerHeartbeatsDeleted: 2,
        reclaimEventsDeleted: 1,
        skippedDueToActiveLease: false,
      }),
    );
    expect(releaseSyncRunnerLease).toHaveBeenCalledTimes(1);

    // Receipt-first is the contract: canonical content is RESTRICT-protected
    // while any receipt points at it, so a content sweep that ran first would
    // collect nothing and leave every shared row immortal for a whole cycle.
    const metaReceipts = seen.findIndex((query) =>
      query.includes("DELETE FROM meta_raw_snapshot_observations"),
    );
    const metaContent = seen.findIndex((query) =>
      query.includes("DELETE FROM meta_raw_snapshots snapshot"),
    );
    const shopifyReceipts = seen.findIndex((query) =>
      query.includes("DELETE FROM shopify_raw_snapshot_observations"),
    );
    const shopifyContent = seen.findIndex((query) =>
      query.includes("DELETE FROM shopify_raw_snapshots snapshot"),
    );
    expect(metaReceipts).toBeGreaterThanOrEqual(0);
    expect(shopifyReceipts).toBeGreaterThanOrEqual(0);
    expect(metaReceipts).toBeLessThan(metaContent);
    expect(shopifyReceipts).toBeLessThan(shopifyContent);
  });
});

describe("retention candidate SQL", () => {
  it("keeps the legacy branch and adds an observation-free new-model branch", () => {
    const sql = retention.META_RAW_SNAPSHOT_RETENTION_CANDIDATE_SQL;
    // Without this branch, new canonical content — which carries no
    // partition_id — would never become collectable.
    expect(sql).toContain("snapshot.content_key IS NOT NULL");
    expect(sql).toContain("FROM meta_raw_snapshot_observations receipt");
    // The legacy branch must survive unchanged, or pre-model rows leak.
    expect(sql).toContain("snapshot.content_key IS NULL");
    expect(sql).toContain("FROM meta_sync_partitions partition");
  });

  it("guards every inbound typed reference before collecting content", () => {
    for (const table of retention.META_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES) {
      // These FKs are ON DELETE SET NULL, so an unguarded delete would not
      // fail — it would silently null a durable row's provenance.
      expect(retention.META_RAW_SNAPSHOT_RETENTION_CANDIDATE_SQL).toContain(
        `FROM ${table} referrer`,
      );
    }
    for (const table of retention.SHOPIFY_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES) {
      expect(retention.SHOPIFY_RAW_SNAPSHOT_RETENTION_CANDIDATE_SQL).toContain(
        `FROM ${table} referrer`,
      );
    }
  });

  it("claims rows with a lock shape PostgreSQL actually permits", () => {
    for (const sql of [
      retention.META_RAW_SNAPSHOT_RETENTION_CANDIDATE_SQL,
      retention.SHOPIFY_RAW_SNAPSHOT_RETENTION_CANDIDATE_SQL,
      retention.META_RAW_SNAPSHOT_OBSERVATION_RETENTION_CANDIDATE_SQL,
      retention.SHOPIFY_RAW_SNAPSHOT_OBSERVATION_RETENTION_CANDIDATE_SQL,
    ]) {
      // FOR UPDATE is rejected over a UNION and over the nullable side of an
      // outer join, so the candidate must stay a single SELECT with EXISTS
      // subqueries and lock exactly one named relation.
      expect(sql).not.toMatch(/\bUNION\b/);
      expect(sql).not.toMatch(/\bLEFT\s+JOIN\b/);
      expect(sql).toMatch(/FOR UPDATE OF \w+ SKIP LOCKED/);
    }
  });

  it("never touches receipts belonging to a live partition", () => {
    const sql = retention.META_RAW_SNAPSHOT_OBSERVATION_RETENTION_CANDIDATE_SQL;
    // A running partition's receipts are its completion evidence.
    expect(sql).toContain("receipt.partition_id IS NULL");
    expect(sql).toContain("partition.status = ANY($2::text[])");
  });
});
