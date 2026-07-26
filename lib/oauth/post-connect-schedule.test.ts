import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The OAuth callbacks did four things wrong at once.
 *
 * The discovery refresh was `.catch(() => null)`, so a failed discovery was
 * indistinguishable from a successful one. Scheduling then read the OLD
 * canonical selection and enqueued work for it — including accounts the NEW
 * principal cannot see, because a reconnect by a different user leaves the
 * previous selection rows in place. The enqueue was `.catch(() => null)` too, so
 * a lane or capacity refusal vanished. And none of it was bound to the
 * connection generation the grant produced.
 */

const getProviderAccountAssignments = vi.fn();
const replaceProviderAccountSelection = vi.fn();
const forceProviderAccountSnapshotRefresh = vi.fn();
const readProviderConnectionGenerationToken = vi.fn();
const assertSyncGrowthBoundary = vi.fn();

/**
 * A partition table that behaves like the real one for the one question the
 * receipt asks: which rows exist, for which account, stamped with which
 * scheduling attempt.
 *
 * Modelled rather than asserted-on, because the defect being closed is
 * precisely that "the enqueue returned" was accepted as "work exists". A mock
 * that returns a fixed row count would reproduce the same lie.
 */
type FakePartition = {
  table: "meta" | "google";
  business_id: string;
  provider_account_id: string;
  status: string;
  scheduling_attempt_id: string | null;
};
let partitions: FakePartition[] = [];
let readbackError: Error | null = null;
/** Every statement the fake pool saw, in order, so lock ordering is provable. */
let statements: string[] = [];

const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join(" ");
  statements.push(text.replace(/\s+/g, " ").trim());
  // Advisory locks and anything else the real selection lock issues.
  if (!text.includes("_sync_partitions")) return Promise.resolve([]);
  if (readbackError) throw readbackError;
  const table = text.includes("meta_sync_partitions") ? "meta" : "google";
  // The real statement interpolates the attempt id FIRST (inside the FILTER),
  // then the business id and the account list.
  const [attemptId, businessId, accountIds] = values as [string, string, string[]];
  const matched = partitions.filter(
    (row) =>
      row.table === table &&
      row.business_id === businessId &&
      accountIds.includes(row.provider_account_id) &&
      ["queued", "leased", "running"].includes(row.status),
  );
  const grouped = new Map<string, { runnable: number; this_attempt: number }>();
  for (const row of matched) {
    const entry = grouped.get(row.provider_account_id) ?? { runnable: 0, this_attempt: 0 };
    entry.runnable += 1;
    if (row.scheduling_attempt_id === attemptId) entry.this_attempt += 1;
    grouped.set(row.provider_account_id, entry);
  }
  return Promise.resolve(
    [...grouped].map(([provider_account_id, counts]) => ({
      provider_account_id,
      ...counts,
    })),
  );
};

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDb: () => sqlTag,
    getDbWithTimeout: () => sqlTag,
    // The real helper opens a transaction; joining it is what the nested
    // production call does too.
    runDbTransaction: async (fn: () => Promise<unknown>) => fn(),
  };
});

vi.mock("@/lib/provider-account-assignments", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getProviderAccountAssignments, replaceProviderAccountSelection };
});

vi.mock("@/lib/provider-account-snapshots", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    forceProviderAccountSnapshotRefresh,
    readProviderConnectionGenerationToken,
  };
});

vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertSyncGrowthBoundary };
});

const { scheduleAfterProviderConnect } = await import(
  "@/lib/oauth/post-connect-schedule"
);
const { ProviderAccountSelectionError } = await import(
  "@/lib/provider-account-assignments"
);
const { DbGrowthFenceRefusal } = await import("@/lib/sync/db-growth-fence");
const { getCurrentSchedulingAttemptId } = await import(
  "@/lib/sync/scheduling-attempt"
);

const liveLoader = vi.fn();
const enqueue = vi.fn();

const run = () =>
  scheduleAfterProviderConnect({
    businessId: "biz-1",
    provider: "meta",
    growthScope: "meta_oauth_post_connect",
    grantConnectionGeneration: "2:connected",
    liveLoader,
    enqueue,
  });

describe("scheduleAfterProviderConnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readProviderConnectionGenerationToken.mockResolvedValue("2:connected");
    getProviderAccountAssignments.mockResolvedValue({
      account_ids: ["act_1", "act_2"],
    });
    forceProviderAccountSnapshotRefresh.mockResolvedValue({
      accounts: [
        { id: "act_1", name: "One" },
        { id: "act_2", name: "Two" },
      ],
      meta: {},
    });
    assertSyncGrowthBoundary.mockResolvedValue({ allowed: true, reason: "ready" });
    replaceProviderAccountSelection.mockResolvedValue(["act_1"]);
    partitions = [];
    readbackError = null;
    statements = [];
    // The default enqueue does what the real one does: it creates partitions,
    // and they carry the ambient scheduling attempt id.
    enqueue.mockImplementation(
      async ({ businessId, accountIds }: { businessId: string; accountIds: string[] }) => {
        const attemptId = getCurrentSchedulingAttemptId();
        for (const accountId of accountIds) {
          partitions.push({
            table: "meta",
            business_id: businessId,
            provider_account_id: accountId,
            status: "queued",
            scheduling_attempt_id: attemptId,
          });
        }
      },
    );
  });

  it("schedules for the intersection when everything is accessible", async () => {
    const result = await run();
    expect(result).toMatchObject({ scheduled: true, reason: "scheduled" });
    expect(result.scheduledPartitionCount).toBe(2);
    expect(result.preexistingAccountIds).toEqual([]);
    expect(result.retainedAccountIds).toEqual(["act_1", "act_2"]);
    expect(enqueue).toHaveBeenCalledWith({
      businessId: "biz-1",
      accountIds: ["act_1", "act_2"],
    });
  });

  it("takes the canonical selection lock before deciding or narrowing", async () => {
    // The read, the intersect and the narrowing write used to be three
    // unsynchronised steps, so an explicit selection saved in another tab
    // between the read and the write was overwritten by a set computed from a
    // selection that no longer existed.
    forceProviderAccountSnapshotRefresh.mockResolvedValue({
      accounts: [{ id: "act_2", name: "Two" }],
      meta: {},
    });
    let selectionReadStatementIndex = -1;
    getProviderAccountAssignments.mockImplementation(async () => {
      selectionReadStatementIndex = statements.length;
      return { account_ids: ["act_1", "act_2"] };
    });
    let narrowStatementIndex = -1;
    replaceProviderAccountSelection.mockImplementation(async () => {
      narrowStatementIndex = statements.length;
      return ["act_2"];
    });

    await run();

    const lockIndex = statements.findIndex((statement) =>
      /pg_advisory(_xact)?_lock/i.test(statement),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(selectionReadStatementIndex).toBeGreaterThan(lockIndex);
    expect(narrowStatementIndex).toBeGreaterThan(lockIndex);
  });

  it("enqueues NOTHING when discovery fails", async () => {
    // The `.catch(() => null)` case. A failed discovery used to be silent, and
    // scheduling ran anyway against a selection nothing had verified.
    forceProviderAccountSnapshotRefresh.mockRejectedValue(new Error("meta is down"));
    const result = await run();
    expect(result).toMatchObject({
      scheduled: false,
      reason: "discovery_failed",
      recoverable: true,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("drops accounts the new principal cannot see and narrows the selection", async () => {
    forceProviderAccountSnapshotRefresh.mockResolvedValue({
      accounts: [{ id: "act_2", name: "Two" }],
      meta: {},
    });
    const result = await run();
    expect(result.retainedAccountIds).toEqual(["act_2"]);
    expect(result.droppedAccountIds).toEqual(["act_1"]);
    expect(replaceProviderAccountSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: ["act_2"],
        expectedConnectionGeneration: "2:connected",
      }),
    );
    expect(enqueue).toHaveBeenCalledWith({
      businessId: "biz-1",
      accountIds: ["act_2"],
    });
  });

  it("enqueues NOTHING when the new principal shares no account with the old selection", async () => {
    // A reconnect as a different user. Every previously selected account is
    // inaccessible, so scheduling any of them would call the provider for
    // accounts this credential has no rights to.
    forceProviderAccountSnapshotRefresh.mockResolvedValue({
      accounts: [{ id: "act_999", name: "Someone else" }],
      meta: {},
    });
    const result = await run();
    expect(result).toMatchObject({
      scheduled: false,
      reason: "no_accessible_selection",
    });
    expect(result.droppedAccountIds).toEqual(["act_1", "act_2"]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses when a second reconnect lands before the enqueue", async () => {
    // The grant generation is now supplied by the caller, taken from the row its
    // upsert returned. A reconnect after that shows up as the pre-enqueue read
    // disagreeing with it.
    readProviderConnectionGenerationToken.mockResolvedValue("3:connected");
    const result = await run();
    expect(result).toMatchObject({
      scheduled: false,
      reason: "generation_changed",
      recoverable: true,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses when the selection narrowing hits a generation conflict", async () => {
    forceProviderAccountSnapshotRefresh.mockResolvedValue({
      accounts: [{ id: "act_2", name: "Two" }],
      meta: {},
    });
    replaceProviderAccountSelection.mockRejectedValue(
      new ProviderAccountSelectionError(
        "connection_generation_changed",
        "the connection changed",
      ),
    );
    const result = await run();
    expect(result).toMatchObject({
      scheduled: false,
      reason: "generation_changed",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("keeps a capacity refusal as structure and enqueues nothing", async () => {
    assertSyncGrowthBoundary.mockRejectedValue(
      new DbGrowthFenceRefusal(
        {
          allowed: false,
          reason: "physical_free_space_low",
          warning: false,
          databaseBytes: 1,
          databaseBudgetBytes: 2,
          tableBytes: {},
          offender: null,
          evaluatedAt: new Date(0).toISOString(),
          errorMessage: "disk full",
          overridden: false,
          physical: null,
        },
        "meta_oauth_post_connect",
      ),
    );
    const result = await run();
    expect(result).toMatchObject({
      scheduled: false,
      reason: "capacity_refused",
      recoverable: true,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reports a failed enqueue rather than swallowing it", async () => {
    enqueue.mockRejectedValue(new Error("queue write failed"));
    const result = await run();
    expect(result).toMatchObject({ scheduled: false, reason: "schedule_failed" });
    expect(result.detail).toMatch(/queue write failed/);
  });

  it("refuses when the enqueue returns normally having created nothing", async () => {
    // Both provider enqueues return normally when they decide there is nothing
    // due. `syncScheduled=1` then sent the user to a dashboard that never
    // filled in, and the connection looked healthy while no work existed.
    enqueue.mockResolvedValue(undefined);
    const result = await run();
    expect(result).toMatchObject({ scheduled: false, reason: "schedule_failed" });
    expect(result.detail).toMatch(/no sync work was created/i);
  });

  it("refuses a partial enqueue rather than reporting the whole selection scheduled", async () => {
    enqueue.mockImplementation(
      async ({ businessId }: { businessId: string; accountIds: string[] }) => {
        partitions.push({
          table: "meta",
          business_id: businessId,
          provider_account_id: "act_1",
          status: "queued",
          scheduling_attempt_id: getCurrentSchedulingAttemptId(),
        });
      },
    );
    const result = await run();
    expect(result).toMatchObject({ scheduled: false, reason: "schedule_failed" });
    expect(result.detail).toMatch(/1 of 2/);
    expect(result.scheduledPartitionCount).toBe(1);
  });

  it("never credits this connect with work another operation created", async () => {
    // A backfill already draining for the same accounts. The dashboard WILL
    // fill in, so this is not a failure — but the exact receipt must not claim
    // this connect scheduled any of it.
    partitions.push(
      {
        table: "meta",
        business_id: "biz-1",
        provider_account_id: "act_1",
        status: "running",
        scheduling_attempt_id: "00000000-0000-4000-8000-000000000999",
      },
      {
        table: "meta",
        business_id: "biz-1",
        provider_account_id: "act_2",
        status: "queued",
        scheduling_attempt_id: null,
      },
    );
    enqueue.mockResolvedValue(undefined);
    const result = await run();
    expect(result).toMatchObject({ scheduled: true, reason: "already_scheduled" });
    expect(result.scheduledPartitionCount).toBe(0);
    expect(result.preexistingAccountIds).toEqual(["act_1", "act_2"]);
  });

  it("does not let another account's work cover an account with none", async () => {
    // The business-wide count this replaces was satisfied by any partition for
    // any account. Coverage is per-account, so act_2 having work says nothing
    // about act_1.
    partitions.push({
      table: "meta",
      business_id: "biz-1",
      provider_account_id: "act_2",
      status: "running",
      scheduling_attempt_id: "00000000-0000-4000-8000-000000000999",
    });
    enqueue.mockResolvedValue(undefined);
    const result = await run();
    expect(result).toMatchObject({ scheduled: false, reason: "schedule_failed" });
    expect(result.detail).toMatch(/1 of 2/);
  });

  it("refuses when the receipt itself cannot be read", async () => {
    readbackError = new Error("partition table unreadable");
    const result = await run();
    expect(result).toMatchObject({
      scheduled: false,
      reason: "schedule_failed",
      recoverable: true,
    });
    expect(result.detail).toMatch(/could not be confirmed/i);
  });

  it("propagates an unreadable selection instead of treating it as empty", async () => {
    // `.catch(() => null)` on an authority read turns "I cannot tell" into
    // "there is nothing selected", which reads downstream as a clean no-op.
    getProviderAccountAssignments.mockRejectedValue(new Error("db down"));
    await expect(run()).rejects.toThrow(/db down/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("propagates an unreadable generation instead of disabling the check", async () => {
    readProviderConnectionGenerationToken.mockRejectedValue(new Error("db down"));
    await expect(run()).rejects.toThrow(/db down/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
