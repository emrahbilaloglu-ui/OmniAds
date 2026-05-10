import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProviderHeartbeatWorkerId,
  createRunnerLeaseGuard,
  getPriorityBusinessIdsForAdapter,
  prioritizeBusinessesForAdapter,
  resolveGoogleAdsControlPlaneBusinessReader,
  resolveTickBusinessesForAdapter,
  resolveConsumeBusinessFallbackDecision,
  runAdapterLifecycleTick,
  resolveAdapterLifecycleSnapshot,
} from "@/lib/sync/worker-runtime";

vi.mock("@/lib/sync/provider-job-lock", () => ({
  getProviderJobLockState: vi.fn(),
}));

vi.mock("@/lib/sync/release-gates", () => ({
  getLatestSyncGateRecords: vi.fn(),
}));

const googleControlPlaneRuntimeMocks = vi.hoisted(() => ({
  readConnectedGoogleAdsControlPlaneBusinesses: vi.fn(),
}));

vi.mock("@/lib/google-ads/control-plane-runtime", () => ({
  readConnectedGoogleAdsControlPlaneBusinesses:
    googleControlPlaneRuntimeMocks.readConnectedGoogleAdsControlPlaneBusinesses,
  default: {
    readConnectedGoogleAdsControlPlaneBusinesses:
      googleControlPlaneRuntimeMocks.readConnectedGoogleAdsControlPlaneBusinesses,
  },
  "module.exports": {
    readConnectedGoogleAdsControlPlaneBusinesses:
      googleControlPlaneRuntimeMocks.readConnectedGoogleAdsControlPlaneBusinesses,
  },
}));

const providerJobLock = await import("@/lib/sync/provider-job-lock");
const releaseGates = await import("@/lib/sync/release-gates");

beforeEach(() => {
  vi.mocked(providerJobLock.getProviderJobLockState).mockReset();
  vi.mocked(releaseGates.getLatestSyncGateRecords).mockReset();
  vi.mocked(
    googleControlPlaneRuntimeMocks.readConnectedGoogleAdsControlPlaneBusinesses,
  ).mockReset();
  vi.mocked(
    googleControlPlaneRuntimeMocks.readConnectedGoogleAdsControlPlaneBusinesses,
  ).mockResolvedValue([]);
});

describe("prioritizeBusinessesForAdapter", () => {
  const businesses = [
    { id: "biz-1", name: "One" },
    { id: "biz-2", name: "Two" },
    { id: "biz-3", name: "Three" },
  ];

  it("prioritizes meta businesses from META_DEBUG_PRIORITY_BUSINESS_IDS", () => {
    const previous = process.env.META_DEBUG_PRIORITY_BUSINESS_IDS;
    const previousCanaries = process.env.SYNC_RELEASE_CANARY_BUSINESSES;
    process.env.META_DEBUG_PRIORITY_BUSINESS_IDS = "biz-3,biz-1";
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "";
    const result = prioritizeBusinessesForAdapter("meta", businesses);
    expect(result.map((row) => row.id)).toEqual(["biz-3", "biz-1", "biz-2"]);
    process.env.META_DEBUG_PRIORITY_BUSINESS_IDS = previous;
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = previousCanaries;
  });

  it("prioritizes release canaries when no adapter debug list is set", () => {
    const previousCanaries = process.env.SYNC_RELEASE_CANARY_BUSINESSES;
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "biz-2,biz-3";
    const result = prioritizeBusinessesForAdapter("google_ads", businesses);
    expect(result.map((row) => row.id)).toEqual(["biz-2", "biz-3", "biz-1"]);
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = previousCanaries;
  });

  it("keeps adapter debug priority ahead of release canaries", () => {
    const previous = process.env.META_DEBUG_PRIORITY_BUSINESS_IDS;
    const previousCanaries = process.env.SYNC_RELEASE_CANARY_BUSINESSES;
    process.env.META_DEBUG_PRIORITY_BUSINESS_IDS = "biz-1";
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "biz-3,biz-2";
    expect(getPriorityBusinessIdsForAdapter("meta")).toEqual([
      "biz-1",
      "biz-2",
      "biz-3",
    ]);
    process.env.META_DEBUG_PRIORITY_BUSINESS_IDS = previous;
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = previousCanaries;
  });

  it("keeps other providers in original order without matching debug ids", () => {
    const result = prioritizeBusinessesForAdapter("other", businesses);
    expect(result.map((row) => row.id)).toEqual(["biz-1", "biz-2", "biz-3"]);
  });
});

describe("resolveTickBusinessesForAdapter", () => {
  const businesses = [
    { id: "biz-priority", name: "Priority" },
    { id: "biz-other", name: "Other" },
  ];

  it("restricts blocked release-gate ticks to prioritized businesses", async () => {
    const previousCanaries = process.env.SYNC_RELEASE_CANARY_BUSINESSES;
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "biz-priority";
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: null,
      releaseGate: {
        id: "gate-1",
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "build-1",
        environment: "test",
        mode: "block",
        baseResult: "fail",
        verdict: "blocked",
        blockerClass: "not_release_ready",
        summary: "blocked",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-20T00:00:00.000Z",
      },
    });

    const result = await resolveTickBusinessesForAdapter({
      providerScope: "meta",
      businesses,
    });

    expect(result).toEqual([{ id: "biz-priority", name: "Priority" }]);
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = previousCanaries;
  });

  it("keeps the full business list when the release gate passes", async () => {
    const previousCanaries = process.env.SYNC_RELEASE_CANARY_BUSINESSES;
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "biz-priority";
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: null,
      releaseGate: {
        id: "gate-1",
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "build-1",
        environment: "test",
        mode: "block",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "pass",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-20T00:00:00.000Z",
      },
    });

    const result = await resolveTickBusinessesForAdapter({
      providerScope: "meta",
      businesses,
    });

    expect(result).toEqual(businesses);
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = previousCanaries;
  });

  it("uses connected Google Ads businesses when the Google release gate passes", async () => {
    const previousCanaries = process.env.SYNC_RELEASE_CANARY_BUSINESSES;
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "biz-priority";
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: null,
      releaseGate: {
        id: "gate-1",
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "build-1",
        environment: "test",
        mode: "block",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "pass",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-20T00:00:00.000Z",
      },
    });
    vi.mocked(
      googleControlPlaneRuntimeMocks.readConnectedGoogleAdsControlPlaneBusinesses,
    ).mockResolvedValue([
      {
        businessId: "biz-google",
        businessName: "Google Connected",
        assignedAccountCount: 1,
        backfillIncomplete: true,
        incompleteScopeCount: 2,
        latestSuccessfulSyncAt: null,
      },
      {
        businessId: "biz-priority",
        businessName: "Priority",
        assignedAccountCount: 1,
        backfillIncomplete: true,
        incompleteScopeCount: 1,
        latestSuccessfulSyncAt: null,
      },
    ]);

    const result = await resolveTickBusinessesForAdapter({
      providerScope: "google_ads",
      businesses,
    });

    expect(result).toEqual([
      { id: "biz-priority", name: "Priority" },
      { id: "biz-google", name: "Google Connected" },
    ]);
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = previousCanaries;
  });

  it("keeps Google ticks scoped to connected businesses even when release canaries are blocked", async () => {
    const previousCanaries = process.env.SYNC_RELEASE_CANARY_BUSINESSES;
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "biz-disconnected";
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: null,
      releaseGate: {
        id: "gate-1",
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "build-1",
        environment: "test",
        mode: "block",
        baseResult: "fail",
        verdict: "blocked",
        blockerClass: "not_release_ready",
        summary: "blocked",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-20T00:00:00.000Z",
      },
    });
    vi.mocked(
      googleControlPlaneRuntimeMocks.readConnectedGoogleAdsControlPlaneBusinesses,
    ).mockResolvedValue([
      {
        businessId: "biz-connected",
        businessName: "Connected",
        assignedAccountCount: 1,
        backfillIncomplete: true,
        incompleteScopeCount: 3,
        latestSuccessfulSyncAt: null,
      },
    ]);

    const result = await resolveTickBusinessesForAdapter({
      providerScope: "google_ads",
      businesses: [
        { id: "biz-disconnected", name: "Disconnected" },
        { id: "biz-connected", name: "Connected" },
      ],
    });

    expect(result).toEqual([{ id: "biz-connected", name: "Connected" }]);
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = previousCanaries;
  });

  it("prioritizes incomplete Google Ads backfill businesses without business-specific ids", async () => {
    const previousCanaries = process.env.SYNC_RELEASE_CANARY_BUSINESSES;
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = "";
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: null,
      releaseGate: {
        id: "gate-1",
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "build-1",
        environment: "test",
        mode: "block",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "pass",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-20T00:00:00.000Z",
      },
    });
    vi.mocked(
      googleControlPlaneRuntimeMocks.readConnectedGoogleAdsControlPlaneBusinesses,
    ).mockResolvedValue([
      {
        businessId: "biz-complete",
        businessName: "Complete",
        assignedAccountCount: 1,
        backfillIncomplete: false,
        incompleteScopeCount: 0,
        latestSuccessfulSyncAt: "2026-04-21T03:00:00.000Z",
      },
      {
        businessId: "biz-incomplete",
        businessName: "Incomplete",
        assignedAccountCount: 1,
        backfillIncomplete: true,
        incompleteScopeCount: 5,
        latestSuccessfulSyncAt: "2026-04-20T23:00:00.000Z",
      },
    ]);

    const result = await resolveTickBusinessesForAdapter({
      providerScope: "google_ads",
      businesses,
    });

    expect(result).toEqual([
      { id: "biz-incomplete", name: "Incomplete" },
      { id: "biz-complete", name: "Complete" },
    ]);
    process.env.SYNC_RELEASE_CANARY_BUSINESSES = previousCanaries;
  });
});

describe("resolveGoogleAdsControlPlaneBusinessReader", () => {
  it("reads named, default, and CommonJS module export shapes", async () => {
    const namedReader = vi.fn().mockResolvedValue([]);
    const defaultReader = vi.fn().mockResolvedValue([]);
    const commonJsReader = vi.fn().mockResolvedValue([]);

    expect(
      resolveGoogleAdsControlPlaneBusinessReader({
        readConnectedGoogleAdsControlPlaneBusinesses: namedReader,
      }),
    ).toBe(namedReader);
    expect(
      resolveGoogleAdsControlPlaneBusinessReader({
        default: {
          readConnectedGoogleAdsControlPlaneBusinesses: defaultReader,
        },
      }),
    ).toBe(defaultReader);
    expect(
      resolveGoogleAdsControlPlaneBusinessReader({
        "module.exports": {
          readConnectedGoogleAdsControlPlaneBusinesses: commonJsReader,
        },
      }),
    ).toBe(commonJsReader);
  });
});

describe("buildProviderHeartbeatWorkerId", () => {
  it("keeps the base worker id for all-scope heartbeats", () => {
    expect(buildProviderHeartbeatWorkerId("worker-1", "all")).toBe("worker-1");
  });

  it("suffixes provider-specific heartbeats", () => {
    expect(buildProviderHeartbeatWorkerId("worker-1", "meta")).toBe("worker-1:meta");
    expect(buildProviderHeartbeatWorkerId("worker-1", "google_ads")).toBe("worker-1:google_ads");
  });
});

describe("createRunnerLeaseGuard", () => {
  it("tracks the first lease-loss reason and stays sticky", () => {
    const guard = createRunnerLeaseGuard();

    expect(guard.isLeaseLost()).toBe(false);
    expect(guard.getLeaseLossReason()).toBeNull();

    guard.markLeaseLost("runner_lease_conflict");
    guard.markLeaseLost("ignored_second_reason");

    expect(guard.isLeaseLost()).toBe(true);
    expect(guard.getLeaseLossReason()).toBe("runner_lease_conflict");
  });
});

describe("resolveConsumeBusinessFallbackDecision", () => {
  it("blocks fallback during cooldown", async () => {
    const decision = await resolveConsumeBusinessFallbackDecision({
      providerScope: "meta",
      businessId: "biz-1",
      lastFallbackAtMs: Date.now(),
      cooldownMs: 60_000,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "compatibility_cooldown",
    });
  });

  it("blocks fallback while auto remediation lock is active", async () => {
    vi.mocked(providerJobLock.getProviderJobLockState).mockResolvedValue({
      id: "lock-1",
      status: "running",
      lockOwner: "worker-1",
      lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
      isExpired: false,
    });

    const decision = await resolveConsumeBusinessFallbackDecision({
      providerScope: "meta",
      businessId: "biz-1",
      cooldownMs: 60_000,
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "repair_workflow_active",
    });
  });

  it("allows fallback when no supported repair lock exists", async () => {
    vi.mocked(providerJobLock.getProviderJobLockState).mockResolvedValue(null);

    const decision = await resolveConsumeBusinessFallbackDecision({
      providerScope: "shopify",
      businessId: "biz-1",
      cooldownMs: 60_000,
    });

    expect(decision).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe("resolveAdapterLifecycleSnapshot", () => {
  it("returns null when the adapter has no readiness hook", async () => {
    const snapshot = await resolveAdapterLifecycleSnapshot({
      adapter: {
        providerScope: "meta",
        planPartitions: async () => ({ partitions: [] }),
        leasePartitions: async () => [],
        getCheckpoint: async () => null,
        fetchChunk: async () => ({}),
        persistChunk: async () => {},
        transformChunk: async () => {},
        writeFacts: async () => {},
        advanceCheckpoint: async () => {},
        completePartition: async () => {},
        classifyFailure: () => "x",
        consumeBusiness: async () => null,
      },
      businessId: "biz-1",
    });

    expect(snapshot).toBeNull();
  });

  it("surfaces shared lifecycle readiness when available", async () => {
    const snapshot = await resolveAdapterLifecycleSnapshot({
      adapter: {
        providerScope: "google_ads",
        planPartitions: async () => ({ partitions: [] }),
        leasePartitions: async () => [],
        getCheckpoint: async () => null,
        fetchChunk: async () => ({}),
        persistChunk: async () => {},
        transformChunk: async () => {},
        writeFacts: async () => {},
        advanceCheckpoint: async () => {},
        completePartition: async () => {},
        classifyFailure: () => "x",
        getReadiness: async () => ({
          readinessLevel: "usable",
          checkpointHealth: {
            latestCheckpointScope: "campaign_daily",
            latestCheckpointPhase: "fetch_raw",
            latestCheckpointStatus: "running",
            latestCheckpointUpdatedAt: "2026-04-02T10:00:00.000Z",
            checkpointLagMinutes: 3,
            lastSuccessfulPageIndex: 2,
            resumeCapable: true,
            checkpointFailures: 0,
          },
          domainReadiness: null,
        }),
        consumeBusiness: async () => null,
      },
      businessId: "biz-1",
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        readinessLevel: "usable",
        checkpointHealth: expect.objectContaining({
          latestCheckpointScope: "campaign_daily",
        }),
      })
    );
  });
});

describe("runAdapterLifecycleTick", () => {
  it("drives the shared lifecycle methods when a partition is leased", async () => {
    const calls: string[] = [];
    const leasePartitions = async (input: { plan?: { kind: string } | null }) => {
      calls.push(`lease:${input.plan?.kind ?? "none"}`);
      return [
        {
          partitionId: "part-1",
          businessId: "biz-1",
          providerAccountId: "act_1",
          scope: "account_daily",
          partitionDate: "2026-04-01",
          lane: "core",
        },
      ];
    };
    const result = await runAdapterLifecycleTick({
      adapter: {
        providerScope: "meta",
        planPartitions: async () => ({ partitions: [] }),
        leasePartitions,
        getCheckpoint: async () => {
          calls.push("getCheckpoint");
          return null;
        },
        fetchChunk: async () => {
          calls.push("fetchChunk");
          return { payload: "chunk" };
        },
        persistChunk: async () => {
          calls.push("persistChunk");
        },
        transformChunk: async () => {
          calls.push("transformChunk");
        },
        advanceCheckpoint: async () => {
          calls.push("advanceCheckpoint");
        },
        writeFacts: async () => {
          calls.push("writeFacts");
        },
        completePartition: async () => {
          calls.push("completePartition");
        },
        classifyFailure: () => "x",
        consumeBusiness: async () => null,
      },
      businessId: "biz-1",
      workerId: "worker-1",
      leaseLimit: 1,
      leasePlan: {
        kind: "meta_policy_lease_plan",
        requestedLimit: 1,
        steps: [],
      },
    });

    expect(result).toMatchObject({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      lastPartitionId: "part-1",
      laneLeaseCounts: { core: 1 },
    });
    expect(calls).toEqual([
      "lease:meta_policy_lease_plan",
      "getCheckpoint",
      "fetchChunk",
      "persistChunk",
      "transformChunk",
      "advanceCheckpoint",
      "writeFacts",
      "completePartition",
    ]);
  });

  it("returns without work when no partitions are leased", async () => {
    const result = await runAdapterLifecycleTick({
      adapter: {
        providerScope: "google_ads",
        planPartitions: async () => ({ partitions: [] }),
        leasePartitions: async () => [],
        getCheckpoint: async () => null,
        fetchChunk: async () => ({ payload: null }),
        persistChunk: async () => {},
        transformChunk: async () => {},
        advanceCheckpoint: async () => {},
        writeFacts: async () => {},
        completePartition: async () => {},
        classifyFailure: () => "x",
        consumeBusiness: async () => null,
      },
      businessId: "biz-1",
      workerId: "worker-1",
      leaseLimit: 1,
    });

    expect(result).toMatchObject({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      leasedPartitionIds: [],
    });
  });
});
