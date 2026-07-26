import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Admin recovery had no admission at all.
 *
 * Every action this endpoint dispatches mutates durable state — cleanup rewrites
 * partition orchestration, replay requeues dead letters, auto-repair writes
 * incidents and executions — and none of it asked whether sync was allowed to
 * run. A lane closed for a cutover, or a database already over its capacity
 * budget, was undone by one operator clicking a recovery button, and the audit
 * log recorded it as a completed recovery.
 *
 * Operator authority is not capacity authority. These cases call the REAL POST
 * handler and assert that a refusal produces zero recovery calls and a
 * structured 503 rather than a partial recovery reported as success.
 */

vi.mock("@/lib/admin-auth", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/admin-logger", () => ({ logAdminAction: vi.fn() }));
vi.mock("@/lib/admin-operations-health", () => ({ getAdminOperationsHealth: vi.fn() }));
vi.mock("@/lib/sync/provider-repair-engine", () => ({
  runGoogleAdsRepairCycle: vi.fn(),
  runMetaRepairCycle: vi.fn(),
}));
vi.mock("@/lib/sync/meta-sync", () => ({
  enqueueMetaScheduledWork: vi.fn(),
  refreshMetaSyncStateForBusiness: vi.fn(),
}));
vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertSyncGrowthBoundary: vi.fn() };
});

const metaWarehouse = vi.hoisted(() => ({
  cleanupMetaPartitionOrchestration: vi.fn(),
  replayMetaDeadLetterPartitions: vi.fn(),
  requeueMetaRetryableFailedPartitions: vi.fn(),
  getMetaAuthoritativeBusinessOpsSnapshot: vi.fn(),
}));
const googleWarehouse = vi.hoisted(() => ({
  cleanupGoogleAdsPartitionOrchestration: vi.fn(),
  replayGoogleAdsDeadLetterPartitions: vi.fn(),
  forceReplayGoogleAdsPoisonedPartitions: vi.fn(),
  requeueGoogleAdsRetryableFailedPartitions: vi.fn(),
}));

vi.mock("@/lib/meta/warehouse", () => metaWarehouse);
vi.mock("@/lib/google-ads/warehouse", () => googleWarehouse);

const { POST } = await import("@/app/api/admin/sync-health/route");
const adminAuth = await import("@/lib/admin-auth");
const dbGrowthFence = await import("@/lib/sync/db-growth-fence");

const buildRequest = (body: unknown) =>
  new NextRequest("http://localhost/api/admin/sync-health", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

/** Every recovery call the handler can make, so "nothing ran" is checkable. */
const recoveryCalls = () => [
  ...Object.values(metaWarehouse),
  ...Object.values(googleWarehouse),
];

describe("POST /api/admin/sync-health recovery admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED = "enabled";
    vi.mocked(adminAuth.requireAdmin).mockResolvedValue({
      error: null,
      session: { user: { id: "admin-1" } },
    } as never);
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockResolvedValue({
      allowed: true,
      reason: "ready",
    } as never);
    metaWarehouse.cleanupMetaPartitionOrchestration.mockResolvedValue({
      stalePartitionCount: 0,
    });
    metaWarehouse.getMetaAuthoritativeBusinessOpsSnapshot.mockResolvedValue(null);
    googleWarehouse.cleanupGoogleAdsPartitionOrchestration.mockResolvedValue({
      stalePartitionCount: 0,
    });
  });

  it("performs the recovery when admitted", async () => {
    const response = await POST(
      buildRequest({ provider: "meta", action: "cleanup", businessId: "biz-1" }),
    );
    expect(response.status).toBe(200);
    expect(metaWarehouse.cleanupMetaPartitionOrchestration).toHaveBeenCalledWith({
      businessId: "biz-1",
    });
  });

  it("refuses every recovery action with the Meta lane closed", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED;
    for (const action of [
      "cleanup",
      "replay_dead_letter",
      "requeue_failed",
      "auto_repair",
    ]) {
      vi.clearAllMocks();
      const response = await POST(
        buildRequest({ provider: "meta", action, businessId: "biz-1" }),
      );
      const payload = await response.json();
      expect(response.status).toBe(503);
      expect(payload.error).toBe("lane_disabled");
      expect(payload.refusal).toMatchObject({ scope: "meta_sync" });
      for (const call of recoveryCalls()) expect(call).not.toHaveBeenCalled();
    }
  });

  it("refuses a Google recovery with the Google lane closed", async () => {
    delete process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED;
    const response = await POST(
      buildRequest({ provider: "google_ads", action: "cleanup", businessId: "biz-1" }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).refusal).toMatchObject({ scope: "google_sync" });
    for (const call of recoveryCalls()) expect(call).not.toHaveBeenCalled();
  });

  it("does not let the Meta lane admit a Google recovery", async () => {
    // One shared "sync is on" check would let a Google recovery run off Meta's
    // permission. The lanes are individually addressable for exactly this.
    delete process.env.ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED;
    const response = await POST(
      buildRequest({ provider: "google_ads", action: "cleanup", businessId: "biz-1" }),
    );
    expect(response.status).toBe(503);
    expect(googleWarehouse.cleanupGoogleAdsPartitionOrchestration).not.toHaveBeenCalled();
    // ...and Meta, whose lane is open, still works.
    const metaResponse = await POST(
      buildRequest({ provider: "meta", action: "cleanup", businessId: "biz-1" }),
    );
    expect(metaResponse.status).toBe(200);
  });

  it("refuses when capacity cannot be proven, and asks for a FRESH sample", async () => {
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockRejectedValue(
      new dbGrowthFence.DbGrowthFenceRefusal(
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
        "admin_sync_recovery",
      ),
    );
    const response = await POST(
      buildRequest({ provider: "meta", action: "cleanup", businessId: "biz-1" }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("capacity_refused");
    expect(dbGrowthFence.assertSyncGrowthBoundary).toHaveBeenCalledWith(
      "admin_sync_recovery",
      // A cached sample is the one taken before the database filled up.
      { fresh: true },
    );
    for (const call of recoveryCalls()) expect(call).not.toHaveBeenCalled();
  });

  it("records the refusal in the admin audit log rather than silently dropping it", async () => {
    const { logAdminAction } = await import("@/lib/admin-logger");
    delete process.env.ADSECUTE_SYNC_LANE_META_SYNC_ENABLED;
    await POST(buildRequest({ provider: "meta", action: "cleanup", businessId: "biz-1" }));
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sync.recovery",
        meta: expect.objectContaining({ outcome: "rejected" }),
      }),
    );
  });
});
