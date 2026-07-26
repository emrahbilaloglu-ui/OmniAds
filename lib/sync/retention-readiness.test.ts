import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SYNC_RETENTION_EXECUTION_COLUMN_SPECS,
  SYNC_RETENTION_EXECUTION_INDEX_SPECS,
} from "@/lib/sync/retention-schema-contract";

const query = vi.fn();

vi.mock("@/lib/db", () => ({
  getDbWithTimeout: vi.fn(() => ({ query })),
}));

const readiness = await import("@/lib/sync/retention-readiness");

interface TestIndexReadinessRow {
  index_name: string;
  expected_table: string;
  actual_table: string | null;
  access_method: string | null;
  key_count: number | null;
  key_definitions: string[] | null;
  is_unique: boolean | null;
  predicate: string | null;
  is_valid: boolean | null;
  is_ready: boolean | null;
}

function readyIndexRows(): TestIndexReadinessRow[] {
  return SYNC_RETENTION_EXECUTION_INDEX_SPECS.map((spec) => ({
    index_name: spec.name,
    expected_table: spec.table,
    actual_table: spec.table,
    access_method: spec.accessMethod,
    key_count: spec.keyDefinitions.length,
    key_definitions: [...spec.keyDefinitions],
    is_unique: spec.unique,
    predicate: spec.predicate,
    is_valid: true,
    is_ready: true,
  }));
}

function readyColumnRows() {
  return SYNC_RETENTION_EXECUTION_COLUMN_SPECS.map((spec) => ({
    table_name: spec.table,
    column_name: spec.column,
    is_ready: true,
  }));
}

/**
 * Specs are addressed by NAME, never by array position.
 *
 * These cases previously indexed into SYNC_RETENTION_EXECUTION_INDEX_SPECS
 * positionally, so adding an index silently re-pointed every drift case at a
 * different spec and the expectations had to be renumbered to stay green. That
 * made the array order load-bearing for a destructive path and actively
 * discouraged adding indexes to the contract. Addressing by declared identity
 * removes the coupling entirely.
 */
function driftRow(
  rows: TestIndexReadinessRow[],
  indexName: string,
  overrides: Partial<TestIndexReadinessRow>,
): string {
  const position = rows.findIndex((row) => row.index_name === indexName);
  if (position < 0) {
    throw new Error(
      `No retention index spec named ${indexName}; the contract and the test have diverged.`,
    );
  }
  rows[position] = { ...rows[position]!, ...overrides };
  return indexName;
}

describe("sync retention execution readiness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("accepts only valid, ready indexes on their expected tables", async () => {
    query
      .mockResolvedValueOnce(readyIndexRows())
      .mockResolvedValueOnce(readyColumnRows())
      .mockResolvedValueOnce([]);

    const result = await readiness.getSyncRetentionExecutionReadiness();

    expect(result.ready).toBe(true);
    expect(result.missingOrInvalidIndexes).toEqual([]);
    expect(result.missingColumns).toEqual([]);
    expect(result.unexpectedGoogleRunReferenceColumns).toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
    const indexCatalogQuery = String(query.mock.calls[0]?.[0] ?? "");
    expect(indexCatalogQuery).toContain("access_method.amname");
    expect(indexCatalogQuery).toContain("index_catalog.indnkeyatts");
    expect(indexCatalogQuery).toContain("pg_get_indexdef");
    expect(indexCatalogQuery).toContain("index_catalog.indisunique");
    expect(indexCatalogQuery).toContain("pg_get_expr");
  });

  it("fails closed for missing, invalid, wrong-table, or missing-column catalog state", async () => {
    const indexRows = readyIndexRows();
    const drifted = [
      driftRow(indexRows, "idx_provider_sync_jobs_retention_due", {
        actual_table: null,
        is_valid: null,
        is_ready: null,
      }),
      driftRow(indexRows, "idx_provider_sync_jobs_owner_expiry", {
        actual_table: "wrong_table",
      }),
      driftRow(indexRows, "idx_google_ads_raw_snapshots_retention", {
        is_valid: false,
      }),
    ];
    query
      .mockResolvedValueOnce(indexRows)
      .mockResolvedValueOnce(
        readyColumnRows().map((row) => ({
          ...row,
          is_ready: false,
        })),
      )
      .mockResolvedValueOnce([
        {
          table_name: "google_ads_future_daily",
          column_name: "source_run_id",
        },
      ]);

    const result = await readiness.getSyncRetentionExecutionReadiness();

    expect(result.ready).toBe(false);
    expect(result.missingOrInvalidIndexes).toEqual([...drifted].sort());
    expect(result.missingColumns).toEqual(["provider_sync_jobs.progress_json"]);
    expect(result.unexpectedGoogleRunReferenceColumns).toEqual([
      "google_ads_future_daily.source_run_id",
    ]);
    query
      .mockResolvedValueOnce(indexRows)
      .mockResolvedValueOnce(
        readyColumnRows().map((row) => ({
          ...row,
          is_ready: false,
        })),
      )
      .mockResolvedValueOnce([
        {
          table_name: "google_ads_future_daily",
          column_name: "source_run_id",
        },
      ]);
    await expect(
      readiness.assertSyncRetentionExecutionReady(),
    ).rejects.toMatchObject({
      code: "SYNC_RETENTION_EXECUTION_NOT_READY",
    });
  });

  it("fails closed for access method, ordered key, uniqueness, predicate, or key-count drift", async () => {
    const indexRows = readyIndexRows();
    const drifted = [
      // missing predicate
      driftRow(indexRows, "idx_provider_sync_jobs_retention_due", {
        predicate: null,
      }),
      // wrong key order
      driftRow(indexRows, "idx_google_ads_raw_snapshots_retention", {
        key_definitions: [
          "partition_id ASC NULLS LAST",
          "id ASC NULLS LAST",
          "fetched_at ASC NULLS LAST",
        ],
      }),
      // wrong access method
      driftRow(indexRows, "idx_google_ads_sync_checkpoints_raw_snapshot_ids", {
        access_method: "btree",
      }),
      // wrong columns
      driftRow(indexRows, "idx_sync_worker_heartbeats_partition_activity", {
        key_definitions: [
          "last_partition_id ASC NULLS LAST",
          "last_heartbeat_at ASC NULLS LAST",
        ],
      }),
      // unexpected uniqueness
      driftRow(indexRows, "idx_sync_runtime_instances_retention", {
        is_unique: true,
      }),
      // wrong key count
      driftRow(indexRows, "idx_shopify_sync_execution_receipts_retention", {
        key_count: 1,
      }),
      // the observation-retention index is under the same contract as every
      // other destructive-path index
      driftRow(indexRows, "idx_meta_raw_snapshot_observations_retention", {
        key_definitions: ["id ASC NULLS LAST"],
      }),
    ];
    query
      .mockResolvedValueOnce(indexRows)
      .mockResolvedValueOnce(readyColumnRows())
      .mockResolvedValueOnce([]);

    const result = await readiness.getSyncRetentionExecutionReadiness();

    expect(result.ready).toBe(false);
    expect(result.missingOrInvalidIndexes).toEqual([...drifted].sort());
    expect(result.missingColumns).toEqual([]);
    expect(result.unexpectedGoogleRunReferenceColumns).toEqual([]);
  });
});
