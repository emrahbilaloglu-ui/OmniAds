import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true, missingTables: [] })),
}));
vi.mock("@/lib/meta/snapshot", () => ({
  runMetaSnapshotForAllBusinesses: vi.fn(),
}));
vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses: vi.fn(async () => [{ id: "biz_1", name: "Biz 1" }]),
}));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(async () => ({
    account_ids: ["act_1", "act_2"],
  })),
}));

import * as assignments from "@/lib/provider-account-assignments";
import * as db from "@/lib/db";
import * as snapshot from "@/lib/meta/snapshot";
import { runMetaSnapshotJobIfDue } from "@/lib/meta/scheduled";

/**
 * Slot completion, recorded from the attempt.
 *
 * The previous version asked `meta_decision_snapshots_daily` which pairs had
 * rows for the DAY and stamped every one as this slot's success. Rows written
 * at 03:00 are still there at 15:00, so a failed afternoon run was closed by
 * the morning's own output and its retry suppressed — with nothing on any
 * surface to say the afternoon had not run.
 */
type Recorded = {
  businessId: string;
  providerAccountId: string;
  slot: number;
  status: string;
};

function harness(input: {
  /** Rows already in `meta_structure_snapshot_runs`. */
  runs: Array<{ business_id: string; provider_account_id: string; slot: number }>;
  /** Whether the day already has decision rows (the second defence). */
  dayHasRows?: boolean;
}) {
  const recorded: Recorded[] = [];
  const tag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = Array.from(parts).join("?");
    if (query.includes("INSERT INTO meta_structure_snapshot_runs")) {
      recorded.push({
        businessId: String(values[0]),
        providerAccountId: String(values[1]),
        slot: Number(values[3]),
        status: String(values[4]),
      });
      return Promise.resolve([]);
    }
    if (query.includes("FROM meta_structure_snapshot_runs")) {
      const slot = Number(values[1]);
      return Promise.resolve(
        input.runs
          .filter((row) => row.slot === slot)
          .map((row) => ({
            business_id: row.business_id,
            provider_account_id: row.provider_account_id,
          })),
      );
    }
    if (query.includes("FROM meta_decision_snapshots_daily")) {
      // The day-coverage query behind the first-slot second defence.
      return Promise.resolve(
        input.dayHasRows
          ? [
            { business_id: "biz_1", provider_account_id: "act_1",
              has_campaign_rows: true, has_adset_rows: true },
            { business_id: "biz_1", provider_account_id: "act_2",
              has_campaign_rows: true, has_adset_rows: true },
          ]
          : [],
      );
    }
    return Promise.resolve([]);
  }) as unknown as ReturnType<typeof db.getDb>;
  (tag as unknown as { query: unknown }).query = vi.fn(async () => []);
  vi.mocked(db.getDb).mockReturnValue(tag);
  return recorded;
}

/** A run where one named account failed and the rest succeeded. */
function runResult(input: {
  succeeded: string[];
  failed: string[];
}) {
  return {
    snapshotDate: "2026-05-08",
    businessCount: 1,
    results: [{
      businessId: "biz_1",
      status: "fulfilled" as const,
      value: {
        businessId: "biz_1",
        snapshotDate: "2026-05-08",
        calibration: {} as never,
        recommendationsWritten: 1,
        anomaliesWritten: 0,
        proposals: null,
        succeededAccountIds: input.succeeded,
        failedAccountIds: input.failed,
      },
    }],
  };
}

const AFTERNOON = new Date("2026-05-08T15:10:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a failed afternoon slot is never closed by the morning's rows", () => {
  it("records only the accounts this attempt actually generated for", async () => {
    // The morning slot completed for both accounts.
    const recorded = harness({
      runs: [
        { business_id: "biz_1", provider_account_id: "act_1", slot: 3 },
        { business_id: "biz_1", provider_account_id: "act_2", slot: 3 },
      ],
      dayHasRows: true,
    });
    vi.mocked(snapshot.runMetaSnapshotForAllBusinesses).mockResolvedValue(
      runResult({ succeeded: ["act_1"], failed: ["act_2"] }) as never,
    );

    const result = await runMetaSnapshotJobIfDue(AFTERNOON);

    expect(result.skipped).toBe(false);
    expect(result.slot).toBe(15);
    // One success and one failure — not two successes inferred from the
    // morning's rows, which are still sitting in the table.
    expect(recorded).toEqual([
      { businessId: "biz_1", providerAccountId: "act_1", slot: 15, status: "success" },
      { businessId: "biz_1", providerAccountId: "act_2", slot: 15, status: "failed" },
    ]);
  });

  it("retries only the account that failed, on the next tick", async () => {
    const recorded = harness({
      runs: [
        { business_id: "biz_1", provider_account_id: "act_1", slot: 3 },
        { business_id: "biz_1", provider_account_id: "act_2", slot: 3 },
        // The afternoon succeeded for act_1 only.
        { business_id: "biz_1", provider_account_id: "act_1", slot: 15 },
      ],
      dayHasRows: true,
    });
    vi.mocked(snapshot.runMetaSnapshotForAllBusinesses).mockResolvedValue(
      runResult({ succeeded: ["act_2"], failed: [] }) as never,
    );

    await runMetaSnapshotJobIfDue(AFTERNOON);

    // The generator is asked for the ONE outstanding pair. Re-running act_1
    // would cost a full generation and rewrite truth that was already right.
    expect(snapshot.runMetaSnapshotForAllBusinesses).toHaveBeenCalledWith(
      "2026-05-08",
      { onlyPairs: [{ businessId: "biz_1", providerAccountId: "act_2" }] },
    );
    expect(recorded).toEqual([
      { businessId: "biz_1", providerAccountId: "act_2", slot: 15, status: "success" },
    ]);
  });

  it("skips only when every required pair has succeeded in that slot", async () => {
    harness({
      runs: [
        { business_id: "biz_1", provider_account_id: "act_1", slot: 3 },
        { business_id: "biz_1", provider_account_id: "act_2", slot: 3 },
        { business_id: "biz_1", provider_account_id: "act_1", slot: 15 },
        { business_id: "biz_1", provider_account_id: "act_2", slot: 15 },
      ],
      dayHasRows: true,
    });

    const result = await runMetaSnapshotJobIfDue(AFTERNOON);

    expect(result).toMatchObject({ skipped: true, reason: "already_ran" });
    expect(snapshot.runMetaSnapshotForAllBusinesses).not.toHaveBeenCalled();
  });

  it("runs the outstanding MORNING slot first when the clock has reached the afternoon", async () => {
    // A missed 03:00 tick is not lost: the day's first production is what
    // every downstream freshness check is measured against.
    harness({ runs: [], dayHasRows: false });
    vi.mocked(snapshot.runMetaSnapshotForAllBusinesses).mockResolvedValue(
      runResult({ succeeded: ["act_1", "act_2"], failed: [] }) as never,
    );

    const result = await runMetaSnapshotJobIfDue(AFTERNOON);

    expect(result.slot).toBe(3);
  });

  it("records a whole-business rejection as a failure for every pair it attempted", async () => {
    // Nothing had run in this slot, so attempted and required are the same
    // set here and both accounts are failed. The test below is the case where
    // they differ.
    const recorded = harness({
      runs: [
        { business_id: "biz_1", provider_account_id: "act_1", slot: 3 },
        { business_id: "biz_1", provider_account_id: "act_2", slot: 3 },
      ],
      dayHasRows: true,
    });
    vi.mocked(snapshot.runMetaSnapshotForAllBusinesses).mockResolvedValue({
      snapshotDate: "2026-05-08",
      businessCount: 1,
      results: [{ businessId: "biz_1", status: "rejected", reason: "boom" }],
    } as never);

    await runMetaSnapshotJobIfDue(AFTERNOON);

    expect(recorded.every((row) => row.status === "failed")).toBe(true);
    expect(recorded).toHaveLength(2);
  });
});

/**
 * A rejected retry fails what it RAN, and nothing else.
 *
 * This used to fail every account the slot REQUIRES. On a retry that is a
 * different set: account A succeeded, B and C did not, the tick runs B and C
 * alone, and a shared failure — the calibration pass at the top of the
 * business run is not wrapped in a catch — then overwrote A's `success` for
 * the slot with `failed`. The next tick found A outstanding and regenerated
 * it, at the cost of a full generation, over a failure A had no part in.
 *
 * The real database seam for this is
 * `scripts/ephemeral-postgres-slot-retry-scope-seam-child.ts`, which drives
 * four consecutive ticks through the migrated run table. This file holds the
 * scheduler's own half: what it asks the generator for, and what it writes
 * back.
 */
describe("a rejected partial retry keeps the accounts it did not attempt", () => {
  it("fails only the attempted accounts and leaves the successful one alone", async () => {
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2", "act_3"],
    } as never);
    const recorded = harness({
      runs: [
        { business_id: "biz_1", provider_account_id: "act_1", slot: 3 },
        { business_id: "biz_1", provider_account_id: "act_2", slot: 3 },
        { business_id: "biz_1", provider_account_id: "act_3", slot: 3 },
        // The afternoon slot succeeded for act_1 and owes the other two.
        { business_id: "biz_1", provider_account_id: "act_1", slot: 15 },
      ],
      dayHasRows: true,
    });
    vi.mocked(snapshot.runMetaSnapshotForAllBusinesses).mockResolvedValue({
      snapshotDate: "2026-05-08",
      businessCount: 1,
      // No account outcome exists at all: the failure is upstream of the
      // per-account loop, which is the case that used to be answered with the
      // required set.
      results: [{ businessId: "biz_1", status: "rejected", reason: "boom" }],
    } as never);

    await runMetaSnapshotJobIfDue(AFTERNOON);

    expect(snapshot.runMetaSnapshotForAllBusinesses).toHaveBeenCalledWith(
      "2026-05-08",
      {
        onlyPairs: [
          { businessId: "biz_1", providerAccountId: "act_2" },
          { businessId: "biz_1", providerAccountId: "act_3" },
        ],
      },
    );
    expect(recorded).toEqual([
      { businessId: "biz_1", providerAccountId: "act_2", slot: 15, status: "failed" },
      { businessId: "biz_1", providerAccountId: "act_3", slot: 15, status: "failed" },
    ]);
    // Stated as its own expectation because this is the whole finding: the
    // account that was not attempted is not written about.
    expect(recorded.some((row) => row.providerAccountId === "act_1")).toBe(false);
  });

  it("writes nothing for a business the tick never asked for", async () => {
    // A generator that reports on a business outside the attempted set leaves
    // no honest account key to record under, and inventing one is how the
    // defect above happened.
    // Set explicitly rather than inherited: `clearAllMocks` keeps the previous
    // test's implementation, so the assignment this case runs under has to be
    // stated where it is read.
    vi.mocked(assignments.getProviderAccountAssignments).mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    } as never);
    const recorded = harness({
      runs: [
        { business_id: "biz_1", provider_account_id: "act_1", slot: 3 },
        { business_id: "biz_1", provider_account_id: "act_2", slot: 3 },
        { business_id: "biz_1", provider_account_id: "act_1", slot: 15 },
      ],
      dayHasRows: true,
    });
    vi.mocked(snapshot.runMetaSnapshotForAllBusinesses).mockResolvedValue({
      snapshotDate: "2026-05-08",
      businessCount: 1,
      results: [{ businessId: "biz_other", status: "rejected", reason: "boom" }],
    } as never);

    await runMetaSnapshotJobIfDue(AFTERNOON);

    expect(recorded).toEqual([]);
  });
});
