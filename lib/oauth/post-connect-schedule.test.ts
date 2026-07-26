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

const liveLoader = vi.fn();
const enqueue = vi.fn();

const run = () =>
  scheduleAfterProviderConnect({
    businessId: "biz-1",
    provider: "meta",
    growthScope: "meta_oauth_post_connect",
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
    enqueue.mockResolvedValue(undefined);
  });

  it("schedules for the intersection when everything is accessible", async () => {
    const result = await run();
    expect(result).toMatchObject({ scheduled: true, reason: "scheduled" });
    expect(result.retainedAccountIds).toEqual(["act_1", "act_2"]);
    expect(enqueue).toHaveBeenCalledWith({
      businessId: "biz-1",
      accountIds: ["act_1", "act_2"],
    });
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
    let reads = 0;
    readProviderConnectionGenerationToken.mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? "2:connected" : "3:connected";
    });
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
});
