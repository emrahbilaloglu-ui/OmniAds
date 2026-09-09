import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/db-schema-readiness", () => ({
  getDbSchemaReadiness: vi.fn(async () => ({ ready: true, missingTables: [] })),
}));
vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses: vi.fn(async () => [{ id: "biz_1", name: "Biz 1" }]),
}));
vi.mock("@/lib/meta/calibration", () => ({
  runMetaCalibrationForBusiness: vi.fn(async () => ({}) as never),
}));
vi.mock("@/lib/meta/entity-signals-backfill", () => ({
  runMetaSignalsBackfillForBusiness: vi.fn(async () => null),
}));
vi.mock("@/lib/provider-account-assignments", () => ({
  getProviderAccountAssignments: vi.fn(async () => ({
    account_ids: ["act_1", "act_2"],
  })),
}));

import * as dbModule from "@/lib/db";
import {
  metaProposalAccountsForFulfilledGeneration,
  metaSnapshotRetryAccountsFor,
  runMetaSnapshotForBusiness,
} from "@/lib/meta/snapshot";

/**
 * Which accounts a slot retry re-computes.
 *
 * The record has always been per (business, account, slot); the RE-RUN was
 * not. `runMetaSnapshotForAllBusinesses` named an account only when exactly
 * one was outstanding, so a business owing two — account A succeeded, B and C
 * failed in the same run — fell through to the unqualified call, which
 * regenerates every ASSIGNED account. A was recomputed and its rows rewritten,
 * at the cost of a full generation, for no reason at all.
 */

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a slot retry re-computes the accounts it owes, and only those", () => {
  it("grants proposal scope only to accounts fulfilled in this attempt", () => {
    expect(metaProposalAccountsForFulfilledGeneration([
      { status: "fulfilled", value: { accountId: "act_1" } },
      { status: "rejected", reason: new Error("act_2 failed") },
      { status: "fulfilled", value: { accountId: null } },
      { status: "fulfilled", value: { accountId: " act_1 " } },
    ])).toEqual(["act_1"]);
  });

  it("resolves every outstanding account of the business, not just a lone one", () => {
    expect(
      metaSnapshotRetryAccountsFor(
        [
          { businessId: "biz_1", providerAccountId: "act_2" },
          { businessId: "biz_1", providerAccountId: "act_3" },
          { businessId: "biz_2", providerAccountId: "act_9" },
        ],
        "biz_1",
      ),
    ).toEqual(["act_2", "act_3"]);
  });

  it("resolves an unqualified run to the whole business", () => {
    // Omitted `onlyPairs` has always meant every assigned account.
    expect(metaSnapshotRetryAccountsFor(null, "biz_1")).toBeNull();
  });

  it("resolves the unattributed pair to the whole business", () => {
    // `""` is the single unscoped batch a business with no assignment
    // produces; naming it as an account would refuse the run.
    expect(
      metaSnapshotRetryAccountsFor(
        [{ businessId: "biz_1", providerAccountId: "" }],
        "biz_1",
      ),
    ).toBeNull();
  });

  it("refuses the whole call when any named account is not assigned", async () => {
    // The stale-selection guard must get STRICTER as the parameter widens,
    // never looser: one unassigned member is enough to refuse, because a
    // snapshot minted for an account this workspace no longer has would reach
    // the respond boundary as authority.
    const result = await runMetaSnapshotForBusiness("biz_1", "2026-05-08", [
      "act_1",
      "act_gone",
    ]);

    expect(result.skippedReason).toBe("provider_account_not_assigned");
    expect(result.recommendationsWritten).toBe(0);
    expect(result.succeededAccountIds ?? []).toEqual([]);
  });
});

/**
 * What a slot records about the source it read.
 *
 * `source_max_date` was stamped with `outcome.snapshotDate` — the day the
 * SCHEDULER asked for — so the cut-off moved forward on every successful slot
 * whether or not the warehouse had received a single new day. The column's own
 * doc comment already said it must be the newest source day the run actually
 * read; the code contradicted it. And because the upsert overwrote the column
 * unconditionally, a run that read nothing at all erased the last real
 * observation for that key.
 */
type RecordedRun = {
  businessId: string;
  providerAccountId: string;
  status: string;
  sourceMaxDate: unknown;
  text: string;
};

function schedulerHarness(input: {
  runs: Array<{ business_id: string; provider_account_id: string; slot: number }>;
  dayHasRows?: boolean;
}) {
  const recorded: RecordedRun[] = [];
  const tag = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.from(parts).join("?");
    if (text.includes("INSERT INTO meta_structure_snapshot_runs")) {
      recorded.push({
        businessId: String(values[0]),
        providerAccountId: String(values[1]),
        status: String(values[4]),
        sourceMaxDate: values[5],
        text,
      });
      return Promise.resolve([]);
    }
    if (text.includes("FROM meta_structure_snapshot_runs")) {
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
    if (text.includes("FROM meta_decision_snapshots_daily")) {
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
  }) as never;
  vi.mocked(dbModule.getDb).mockReturnValue(tag);
  return recorded;
}

/**
 * Drive the scheduler with a doubled snapshot module.
 *
 * `@/lib/meta/snapshot` is imported for real at the top of this file, so the
 * double is applied to the scheduler's copy only.
 */
async function runScheduler(input: {
  now: Date;
  runResult: unknown;
}) {
  vi.resetModules();
  vi.doMock("@/lib/meta/snapshot", () => ({
    runMetaSnapshotForAllBusinesses: vi.fn(async () => input.runResult),
  }));
  const { runMetaSnapshotJobIfDue } = await import("@/lib/meta/scheduled");
  return runMetaSnapshotJobIfDue(input.now);
}

function snapshotRunResult(input: {
  succeeded: string[];
  failed: string[];
  sourceMaxDateByAccountId?: Record<string, string | null>;
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
        ...(input.sourceMaxDateByAccountId
          ? { sourceMaxDateByAccountId: input.sourceMaxDateByAccountId }
          : {}),
      },
    }],
  };
}

const AFTERNOON = new Date("2026-05-08T15:10:00.000Z");
const MORNING_DONE = [
  { business_id: "biz_1", provider_account_id: "act_1", slot: 3 },
  { business_id: "biz_1", provider_account_id: "act_2", slot: 3 },
];

describe("a slot records the source day it read, not the one it asked for", () => {
  it("writes the observed maximum, which is older than the requested date", async () => {
    const recorded = schedulerHarness({ runs: MORNING_DONE, dayHasRows: true });

    await runScheduler({
      now: AFTERNOON,
      runResult: snapshotRunResult({
        succeeded: ["act_1", "act_2"],
        failed: [],
        sourceMaxDateByAccountId: { act_1: "2026-05-06", act_2: "2026-05-06" },
      }),
    });

    expect(recorded.map((row) => row.sourceMaxDate)).toEqual([
      "2026-05-06",
      "2026-05-06",
    ]);
  });

  it("writes a smaller observation as-is, with no high-water mark anywhere", async () => {
    // A5.4: an unchanged source may not advance the cut-off, and a smaller
    // observed value is an honest reading rather than an error.
    const recorded = schedulerHarness({ runs: MORNING_DONE, dayHasRows: true });

    await runScheduler({
      now: AFTERNOON,
      runResult: snapshotRunResult({
        succeeded: ["act_1", "act_2"],
        failed: [],
        sourceMaxDateByAccountId: { act_1: "2026-05-05", act_2: "2026-05-05" },
      }),
    });

    expect(recorded[0]?.sourceMaxDate).toBe("2026-05-05");
    expect(recorded[0]?.text).not.toContain("GREATEST");
  });

  it("records an empty source as an observation of its own", async () => {
    const recorded = schedulerHarness({ runs: MORNING_DONE, dayHasRows: true });

    await runScheduler({
      now: AFTERNOON,
      runResult: snapshotRunResult({
        succeeded: ["act_1"],
        failed: ["act_2"],
        sourceMaxDateByAccountId: { act_1: null },
      }),
    });

    expect(recorded[0]).toMatchObject({
      providerAccountId: "act_1",
      status: "success",
      sourceMaxDate: null,
    });
  });

  it("leaves the stored cut-off alone when this attempt read nothing", async () => {
    const recorded = schedulerHarness({ runs: MORNING_DONE, dayHasRows: true });

    await runScheduler({
      now: AFTERNOON,
      runResult: snapshotRunResult({
        succeeded: ["act_1"],
        failed: ["act_2"],
        sourceMaxDateByAccountId: { act_1: "2026-05-06" },
      }),
    });

    // The failed account read nothing, so its upsert must not carry a value
    // and the statement must keep the stored one.
    const failedRun = recorded.find((row) => row.status === "failed");
    expect(failedRun?.sourceMaxDate).toBeNull();
    expect(failedRun?.text).toContain(
      "ELSE meta_structure_snapshot_runs.source_max_date",
    );
  });

  it("does not stamp a cut-off onto a slot inferred from existing rows", async () => {
    // `markSlotCoveredByExistingRows` reads no warehouse day of its own.
    const recorded = schedulerHarness({ runs: [], dayHasRows: true });

    const result = await runScheduler({
      now: AFTERNOON,
      runResult: snapshotRunResult({ succeeded: [], failed: [] }),
    });

    expect(result).toMatchObject({ skipped: true, reason: "already_ran" });
    expect(recorded).not.toHaveLength(0);
    expect(recorded.every((row) => row.sourceMaxDate === null)).toBe(true);
  });
});
