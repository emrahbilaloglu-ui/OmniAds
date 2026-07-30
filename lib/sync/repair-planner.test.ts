import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sync/runtime-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/runtime-contract")>();
  return {
    ...actual,
    getRuntimeRegistryStatus: vi.fn(),
  };
});

vi.mock("@/lib/sync/release-gates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/release-gates")>();
  return {
    ...actual,
    getLatestSyncGateRecords: vi.fn(),
  };
});

const runtimeContract = await import("@/lib/sync/runtime-contract");
const releaseGates = await import("@/lib/sync/release-gates");
const repairPlanner = await import("@/lib/sync/repair-planner");

const healthyRuntimeRegistry = {
  sampledAt: "2026-04-15T00:00:00.000Z",
  buildId: "dev-build",
  freshnessWindowMinutes: 10,
  contractValid: true,
  serviceHealth: {
    web: null,
    worker: null,
  },
  webPresent: true,
  workerPresent: true,
  workerActive: true,
  dbFingerprintMatch: true,
  configFingerprintMatch: true,
  issues: [],
};

const baseReleaseGate = {
  gateKind: "release_gate",
  gateScope: "release_readiness",
  buildId: "dev-build",
  environment: "test",
  mode: "measure_only",
  baseResult: "fail",
  verdict: "measure_only",
  blockerClass: "queue_blocked",
  summary: "failed",
  breakGlass: false,
  overrideReason: null,
  evidence: {
    canaries: [
      {
        businessId: "biz-1",
        businessName: "TheSwaf",
        pass: false,
        blockerClass: "queue_blocked",
        evidence: {
          activityState: "stalled",
          progressState: "partial_stuck",
          queueDepth: 9,
          leasedPartitions: 0,
          retryableFailedPartitions: 0,
          deadLetterPartitions: 0,
          staleLeasePartitions: 0,
          repairBacklog: 0,
          validationFailures24h: 0,
          d1FinalizeNonTerminalCount: 0,
          truthReady: false,
          stallFingerprints: ["checkpoint_not_advancing"],
        },
      },
    ],
  },
  emittedAt: "2026-04-15T00:00:00.000Z",
} as const;

describe("sync repair planner", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, NODE_ENV: "test" };
    vi.mocked(runtimeContract.getRuntimeRegistryStatus).mockResolvedValue(healthyRuntimeRegistry as never);
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: null,
      releaseGate: baseReleaseGate as never,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("hard-stops dry-run planning when runtime contract is invalid", async () => {
    vi.mocked(runtimeContract.getRuntimeRegistryStatus).mockResolvedValue({
      sampledAt: "2026-04-15T00:00:00.000Z",
      buildId: "dev-build",
      freshnessWindowMinutes: 10,
      contractValid: false,
      serviceHealth: {
        web: null,
        worker: null,
      },
      webPresent: true,
      workerPresent: true,
      workerActive: true,
      dbFingerprintMatch: false,
      configFingerprintMatch: true,
      issues: ["mismatch"],
    });

    const plan = await repairPlanner.evaluateAndPersistSyncRepairPlan({ persist: false });

    expect(plan.eligible).toBe(false);
    expect(plan.blockedReason).toBe("runtime_contract_invalid");
    expect(plan.recommendations).toHaveLength(0);
  });

  it("hard-stops dry-run planning when release gate is misconfigured", async () => {
    vi.mocked(releaseGates.getLatestSyncGateRecords).mockResolvedValue({
      deployGate: null,
      releaseGate: {
        ...baseReleaseGate,
        baseResult: "misconfigured",
        verdict: "misconfigured",
        blockerClass: "misconfigured",
        evidence: {},
      } as never,
    });

    const plan = await repairPlanner.evaluateAndPersistSyncRepairPlan({
      persist: false,
      releaseGate: {
        ...baseReleaseGate,
        baseResult: "misconfigured",
        verdict: "misconfigured",
        blockerClass: "misconfigured",
        evidence: {},
      },
      runtimeRegistry: healthyRuntimeRegistry,
    });

    expect(plan.eligible).toBe(false);
    expect(plan.blockedReason).toBe("release_gate_misconfigured");
  });

  it("proposes replay_dead_letter before lower-risk queue actions", async () => {
    const plan = await repairPlanner.evaluateAndPersistSyncRepairPlan({
      persist: false,
      releaseGate: {
        ...baseReleaseGate,
        evidence: {
          canaries: [
            {
              businessId: "biz-1",
              businessName: "TheSwaf",
              pass: false,
              blockerClass: "queue_blocked",
              evidence: {
                queueDepth: 4,
                leasedPartitions: 0,
                deadLetterPartitions: 2,
                staleLeasePartitions: 1,
                truthReady: false,
              },
            },
          ],
        },
      },
      runtimeRegistry: healthyRuntimeRegistry,
    });

    expect(plan.eligible).toBe(true);
    expect(plan.recommendations[0]?.recommendedAction).toBe("replay_dead_letter");
    expect(plan.recommendations[0]?.safetyClassification).toBe("safe_guarded");
  });

  it("does not propose Google Ads replay when terminal account action is required", async () => {
    const plan = await repairPlanner.evaluateAndPersistSyncRepairPlan({
      persist: false,
      providerScope: "google_ads",
      releaseGate: {
        ...baseReleaseGate,
        evidence: {
          canaries: [
            {
              businessId: "biz-1",
              businessName: "TheSwaf",
              pass: false,
              blockerClass: "queue_blocked",
              evidence: {
                queueDepth: 4,
                leasedPartitions: 0,
                deadLetterPartitions: 1,
                actionRequiredDeadLetterPartitions: 1,
                replayableDeadLetterPartitions: 0,
                staleLeasePartitions: 0,
                truthReady: false,
              },
            },
          ],
        },
      } as never,
      runtimeRegistry: healthyRuntimeRegistry as never,
    });

    expect(plan.eligible).toBe(false);
    expect(plan.blockedReason).toBe("account_action_required");
    expect(plan.recommendations).toHaveLength(0);
  });

  it("proposes stale_lease_reclaim when reclaim candidates are present", async () => {
    const plan = await repairPlanner.evaluateAndPersistSyncRepairPlan({
      persist: false,
      releaseGate: {
        ...baseReleaseGate,
        evidence: {
          canaries: [
            {
              businessId: "biz-1",
              businessName: "TheSwaf",
              pass: false,
              blockerClass: "queue_blocked",
              evidence: {
                queueDepth: 0,
                leasedPartitions: 0,
                deadLetterPartitions: 0,
                staleLeasePartitions: 0,
                reclaimCandidateCount: 2,
                staleRunCount24h: 0,
                truthReady: false,
              },
            },
          ],
        },
      },
      runtimeRegistry: healthyRuntimeRegistry,
    });

    expect(plan.eligible).toBe(true);
    expect(plan.recommendations[0]?.recommendedAction).toBe("stale_lease_reclaim");
    expect(plan.recommendations[0]?.safetyClassification).toBe("safe_guarded");
  });

  it("does not propose stale_lease_reclaim for stale runs alone", async () => {
    const plan = await repairPlanner.evaluateAndPersistSyncRepairPlan({
      persist: false,
      releaseGate: {
        ...baseReleaseGate,
        evidence: {
          canaries: [
            {
              businessId: "biz-1",
              businessName: "Grandmix",
              pass: false,
              blockerClass: "queue_blocked",
              evidence: {
                queueDepth: 2,
                leasedPartitions: 0,
                deadLetterPartitions: 0,
                staleLeasePartitions: 0,
                reclaimCandidateCount: 0,
                staleRunCount24h: 3,
                truthReady: false,
              },
            },
          ],
        },
      },
      runtimeRegistry: healthyRuntimeRegistry,
    });

    expect(plan.eligible).toBe(true);
    expect(plan.recommendations[0]?.recommendedAction).toBe("reschedule");
    expect(plan.recommendations[0]?.safetyClassification).toBe("safe_idempotent");
  });

  it("proposes reschedule for queued work without leases", async () => {
    const plan = await repairPlanner.evaluateAndPersistSyncRepairPlan({
      persist: false,
      releaseGate: baseReleaseGate,
      runtimeRegistry: healthyRuntimeRegistry,
    });

    expect(plan.eligible).toBe(true);
    expect(plan.recommendations[0]?.recommendedAction).toBe("reschedule");
    expect(plan.recommendations[0]?.safetyClassification).toBe("safe_idempotent");
  });

  it("does not propose reschedule for queued work that is making real progress between batches", async () => {
    const plan = await repairPlanner.evaluateAndPersistSyncRepairPlan({
      persist: false,
      releaseGate: {
        ...baseReleaseGate,
        evidence: {
          canaries: [
            {
              businessId: "biz-1",
              businessName: "TheSwaf",
              pass: false,
              blockerClass: "not_release_ready",
              evidence: {
                activityState: "busy",
                progressState: "partial_progressing",
                queueDepth: 534,
                leasedPartitions: 0,
                retryableFailedPartitions: 0,
                deadLetterPartitions: 0,
                staleLeasePartitions: 0,
                reclaimCandidateCount: 0,
                repairBacklog: 0,
                validationFailures24h: 0,
                d1FinalizeNonTerminalCount: 0,
                truthReady: false,
                stallFingerprints: [],
              },
            },
          ],
        },
      },
      runtimeRegistry: healthyRuntimeRegistry,
    });

    expect(plan.eligible).toBe(true);
    expect(plan.recommendations).toHaveLength(0);
  });

  it("stops recommendation generation while break-glass is active", async () => {
    const plan = await repairPlanner.evaluateAndPersistSyncRepairPlan({
      persist: false,
      releaseGate: {
        ...baseReleaseGate,
        breakGlass: true,
        overrideReason: "drill",
        evidence: {},
      },
      runtimeRegistry: healthyRuntimeRegistry,
    });

    expect(plan.eligible).toBe(false);
    expect(plan.blockedReason).toBe("break_glass_active");
    expect(plan.recommendations).toHaveLength(0);
  });
});
