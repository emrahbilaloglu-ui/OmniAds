import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));
vi.mock("@/lib/migrations", () => ({
  runMigrations: vi.fn(),
}));
vi.mock("@/lib/reporting-cache-writer", () => ({
  clearCachedReportSnapshots: vi.fn(),
}));
vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn(async () => undefined),
}));

const db = await import("@/lib/db");
const migrations = await import("@/lib/migrations");
const schemaReadiness = await import("@/lib/db-schema-readiness");
const {
  closeSucceededMetaParentRunningCheckpoints,
  pruneMetaCreativeMediaOutsideRetention,
  repairMetaRunningRunsUnderTerminalParents,
} = await import("./cleanup");

describe("closeSucceededMetaParentRunningCheckpoints", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("closes running checkpoints under succeeded parents and returns grouped diagnostics", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      if (queries.length === 1) {
        return [
          {
            summary: {
              businessId: null,
              totalClosed: 3,
              groups: [
                {
                  checkpointScope: "account_daily",
                  phase: "fetch_raw",
                  epochBucket: "epoch_match",
                  timingBucket:
                    "checkpoint_updated_before_or_at_parent_finished",
                  count: 2,
                },
                {
                  checkpointScope: "core_ad_insights",
                  phase: "bulk_upsert",
                  epochBucket: "checkpoint_epoch_null",
                  timingBucket: "checkpoint_updated_after_parent_finished",
                  count: 1,
                },
              ],
            },
          },
        ];
      }
      return [{ count: 0 }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const summary = await closeSucceededMetaParentRunningCheckpoints();

    expect(summary).toEqual({
      businessId: null,
      totalClosed: 3,
      remainingRunningChildrenOfSucceededParents: 0,
      groups: [
        {
          checkpointScope: "account_daily",
          phase: "fetch_raw",
          epochBucket: "epoch_match",
          timingBucket: "checkpoint_updated_before_or_at_parent_finished",
          count: 2,
        },
        {
          checkpointScope: "core_ad_insights",
          phase: "bulk_upsert",
          epochBucket: "checkpoint_epoch_null",
          timingBucket: "checkpoint_updated_after_parent_finished",
          count: 1,
        },
      ],
    });
    expect(
      queries.some((query) =>
        query.includes("partition.status = 'succeeded'"),
      ),
    ).toBe(true);
    expect(
      queries.some((query) =>
        query.includes("checkpoint.status = 'running'"),
      ),
    ).toBe(true);
    expect(queries.some((query) => query.includes("phase = 'finalize'"))).toBe(
      true,
    );
    expect(queries.some((query) => query.includes("epoch_match"))).toBe(true);
    expect(
      queries.some((query) =>
        query.includes(
          "checkpoint_updated_before_or_at_parent_finished",
        ),
      ),
    ).toBe(true);
    expect(queries).toHaveLength(2);
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("repairs running runs under terminal parents and returns grouped diagnostics", async () => {
    const queries: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      queries.push(strings.join(" "));
      if (queries.length === 1) {
        return [
          {
            summary: {
              businessId: null,
              totalRepaired: 2,
              groups: [
                {
                  partitionStatus: "succeeded",
                  runStatus: "succeeded",
                  lane: "core",
                  scope: "account_daily",
                  count: 1,
                },
                {
                  partitionStatus: "dead_letter",
                  runStatus: "failed",
                  lane: "extended",
                  scope: "ad_daily",
                  count: 1,
                },
              ],
            },
          },
        ];
      }
      return [{ count: 0 }];
    });
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const summary = await repairMetaRunningRunsUnderTerminalParents();

    expect(summary).toEqual({
      businessId: null,
      totalRepaired: 2,
      remainingRunningRunsUnderTerminalParents: 0,
      groups: [
        {
          partitionStatus: "succeeded",
          runStatus: "succeeded",
          lane: "core",
          scope: "account_daily",
          count: 1,
        },
        {
          partitionStatus: "dead_letter",
          runStatus: "failed",
          lane: "extended",
          scope: "ad_daily",
          count: 1,
        },
      ],
    });
    expect(
      queries.some((query) =>
        query.includes(
          "partition.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')",
        ),
      ),
    ).toBe(true);
    expect(
      queries.some((query) =>
        query.includes("partition_already_dead_letter"),
      ),
    ).toBe(true);
    expect(queries).toHaveLength(2);
    expect(migrations.runMigrations).not.toHaveBeenCalled();
  });

  it("is a no-op on clean state", async () => {
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          summary: {
            businessId: null,
            totalRepaired: 0,
            groups: [],
          },
        },
      ])
      .mockResolvedValueOnce([{ count: 0 }]);
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const summary = await repairMetaRunningRunsUnderTerminalParents();

    expect(summary).toEqual({
      businessId: null,
      totalRepaired: 0,
      remainingRunningRunsUnderTerminalParents: 0,
      groups: [],
    });
  });
});

describe("Meta creative-media cleanup ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never mutates immutable meta_ad_daily decision facts", async () => {
    const queries: string[] = [];
    const sql = vi.fn(
      async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        queries.push(strings.join("?"));
        return [{ count: 0 }];
      },
    );
    vi.mocked(db.getDb).mockReturnValue(sql as never);

    const result = await pruneMetaCreativeMediaOutsideRetention({
      businessId: "biz-1",
      keepFromDate: "2026-04-20",
    });

    expect(schemaReadiness.assertDbSchemaReady).toHaveBeenCalledWith({
      context: "meta_creative_media_prune",
      tables: ["meta_creative_media", "meta_creative_daily"],
    });
    expect(queries).toHaveLength(2);
    expect(queries.join("\n")).not.toContain("meta_ad_daily");
    expect(queries.join("\n")).toContain("DELETE FROM meta_creative_media");
    expect(queries.join("\n")).toContain("UPDATE meta_creative_daily");
    expect(result).toEqual({
      metaCreativeMediaDeleted: 0,
      metaAdDailyUpdated: 0,
      metaCreativeDailyUpdated: 0,
    });
  });
});
