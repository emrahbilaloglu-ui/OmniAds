import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sync/soak-gate", () => ({
  runSyncSoakGate: vi.fn(),
}));

vi.mock("@/lib/sync/worker-health", () => ({
  getSyncWorkerHealthSummary: vi.fn(),
  getProviderScopeWorkerObservation: vi.fn(),
}));

vi.mock("@/lib/sync/runtime-contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/runtime-contract")>();
  return {
    ...actual,
    getRuntimeRegistryStatus: vi.fn(),
  };
});

const soakGate = await import("@/lib/sync/soak-gate");
const runtimeContract = await import("@/lib/sync/runtime-contract");
const workerHealth = await import("@/lib/sync/worker-health");
const releaseGates = await import("@/lib/sync/release-gates");

describe("sync release gates", () => {
  it("passes release truth when serving data is ready and background backfill is progressing", () => {
    expect(
      releaseGates.classifyProviderReleaseTruth({
        activityState: "busy",
        progressState: "partial_progressing",
        workerOnline: true,
        queueDepth: 1400,
        leasedPartitions: 0,
        truthReady: true,
      }),
    ).toMatchObject({
      pass: true,
      blockerClass: "none",
    });
  });

  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, NODE_ENV: "test" };
    process.env.SYNC_DEPLOY_GATE_MODE = "block";
    process.env.SYNC_RELEASE_GATE_MODE = "measure_only";
    vi.mocked(runtimeContract.getRuntimeRegistryStatus).mockResolvedValue({
      sampledAt: "2026-04-15T00:00:00.000Z",
      buildId: "dev-build",
      freshnessWindowMinutes: 10,
      contractValid: true,
      serviceHealth: {
        web: {
          instanceId: "web:test:1",
          service: "web",
          runtimeRole: "web",
          buildId: "dev-build",
          providerScopes: ["meta"],
          dbFingerprint: "db",
          configFingerprint: "cfg",
          healthState: "healthy",
          startedAt: "2026-04-15T00:00:00.000Z",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          contract: null,
          fresh: true,
        },
        worker: {
          instanceId: "worker:test:1",
          service: "worker",
          runtimeRole: "worker",
          buildId: "dev-build",
          providerScopes: ["meta"],
          dbFingerprint: "db",
          configFingerprint: "cfg",
          healthState: "healthy",
          startedAt: "2026-04-15T00:00:00.000Z",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          contract: null,
          fresh: true,
        },
      },
      webPresent: true,
      workerPresent: true,
      dbFingerprintMatch: true,
      configFingerprintMatch: true,
      issues: [],
    });
    vi.mocked(workerHealth.getSyncWorkerHealthSummary).mockResolvedValue({
      onlineWorkers: 1,
      workerInstances: 1,
      lastHeartbeatAt: "2026-04-15T00:00:00.000Z",
      lastProgressHeartbeatAt: null,
      workers: [],
    } as never);
    vi.mocked(workerHealth.getProviderScopeWorkerObservation).mockReturnValue({
      workerId: "sync-worker:test:meta",
      workerFreshnessState: "online",
      lastHeartbeatAt: "2026-04-15T00:00:00.000Z",
      heartbeatAgeMs: 1_000,
      hasFreshHeartbeat: true,
      metaJson: null,
    } as never);
    vi.mocked(soakGate.runSyncSoakGate).mockResolvedValue({
      health: {} as never,
      result: {
        outcome: "fail",
        checkedAt: "2026-04-15T00:00:00.000Z",
        thresholds: {
          maxStaleRuns24h: 0,
          maxLeaseConflicts24h: 0,
          maxSkippedActiveLeaseRecoveries24h: 5,
          maxQueueDepth: 25,
          maxDeadLetters: 0,
          maxCriticalIssues: 0,
        },
        checks: [],
        blockingChecks: [{ key: "queue_depth", ok: false, actual: 99, threshold: 25 }],
        issueCount: 1,
        criticalIssueCount: 1,
        unresolvedRunbookKeys: [],
        topIssue: "queue_depth",
        releaseReadiness: "blocked",
        summary: "blocked",
      },
    } as never);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("classifies a ready provider release truth as pass", () => {
    expect(
      releaseGates.classifyProviderReleaseTruth({
        activityState: "busy",
        progressState: "syncing",
        workerOnline: true,
        queueDepth: 6,
        leasedPartitions: 1,
        truthReady: true,
        recentTruthState: "finalized_verified",
        priorityTruthState: "finalized_verified",
      })
    ).toMatchObject({
      pass: true,
      blockerClass: "none",
      evidence: {
        truthReady: true,
        queueDepth: 6,
        leasedPartitions: 1,
      },
    });
  });

  it("refuses the pass when the measured range was never re-read after it closed", () => {
    expect(
      releaseGates.classifyProviderReleaseTruth({
        // Everything else that has ever been read as "ready": healthy activity,
        // a draining queue, a caller asserting truthReady.
        activityState: "busy",
        progressState: "syncing",
        workerOnline: true,
        queueDepth: 6,
        leasedPartitions: 1,
        truthReady: true,
        freshnessPostCloseObserved: false,
        freshnessState: "provisional",
        freshnessEvidenceAvailable: true,
      }),
    ).toMatchObject({
      pass: false,
      // Non-terminal and retryable: more observation clears it.
      blockerClass: "not_release_ready",
      evidence: {
        freshnessPostCloseObserved: false,
        freshnessState: "provisional",
      },
    });
  });

  it("fails closed when the freshness verdict could not be read at all", () => {
    expect(
      releaseGates.classifyProviderReleaseTruth({
        activityState: "busy",
        progressState: "syncing",
        workerOnline: true,
        queueDepth: 0,
        leasedPartitions: 0,
        truthReady: true,
        freshnessPostCloseObserved: false,
        freshnessState: "unknown",
        freshnessEvidenceAvailable: false,
      }),
    ).toMatchObject({
      pass: false,
      blockerClass: "not_release_ready",
      evidence: {
        freshnessState: "unknown",
        freshnessEvidenceAvailable: false,
      },
    });
  });

  it("passes on converging without recording it as settled", () => {
    const verdict = releaseGates.classifyProviderReleaseTruth({
      activityState: "busy",
      progressState: "syncing",
      workerOnline: true,
      queueDepth: 6,
      leasedPartitions: 1,
      truthReady: true,
      freshnessPostCloseObserved: true,
      freshnessState: "converging",
      freshnessEvidenceAvailable: true,
    });

    expect(verdict).toMatchObject({ pass: true, blockerClass: "none" });
    expect(verdict.evidence.freshnessState).toBe("converging");
    expect(verdict.evidence.freshnessState).not.toBe("settled");
    expect(JSON.stringify(verdict)).not.toMatch(/\b(final|immutable)\b/i);
  });

  it("keeps an independently observed incident winning over unknown freshness", () => {
    expect(
      releaseGates.classifyProviderReleaseTruth({
        activityState: "blocked",
        progressState: "blocked",
        workerOnline: true,
        queueDepth: 9,
        leasedPartitions: 0,
        truthReady: false,
        deadLetterPartitions: 4,
        freshnessPostCloseObserved: false,
        freshnessState: "unknown",
        freshnessEvidenceAvailable: false,
      }),
    ).toMatchObject({
      pass: false,
      // The dead-lettered queue names itself. Suppressing a real incident
      // because freshness was unreadable would be the regression.
      blockerClass: "queue_blocked",
    });
  });

  it("leaves a provider that supplies no post-close evidence to truthReady alone", () => {
    // Meta's finality model is not Google's, so an omitted flag must not
    // silently block every Meta gate.
    expect(
      releaseGates.classifyProviderReleaseTruth({
        activityState: "busy",
        progressState: "syncing",
        workerOnline: true,
        queueDepth: 6,
        leasedPartitions: 1,
        truthReady: true,
      }),
    ).toMatchObject({
      pass: true,
      evidence: { freshnessPostCloseObserved: null },
    });
  });

  it("classifies queued work without a worker as worker_unavailable", () => {
    expect(
      releaseGates.classifyProviderReleaseTruth({
        activityState: "busy",
        progressState: "syncing",
        workerOnline: false,
        queueDepth: 3,
        leasedPartitions: 0,
        truthReady: true,
      })
    ).toMatchObject({
      pass: false,
      blockerClass: "worker_unavailable",
      evidence: {
        truthReady: true,
        queueDepth: 3,
        leasedPartitions: 0,
      },
    });
  });

  it("prefers google-scoped release gates over meta and legacy rows", () => {
    const selected = releaseGates.selectLatestSyncGateRecords(
      [
        {
          id: "deploy-1",
          gateKind: "deploy_gate",
          gateScope: "service_liveness",
          buildId: "build-1",
          environment: "production",
          mode: "block",
          baseResult: "pass",
          verdict: "pass",
          blockerClass: null,
          summary: "deploy ok",
          breakGlass: false,
          overrideReason: null,
          evidence: {},
          emittedAt: "2026-04-20T00:00:00.000Z",
        },
        {
          id: "meta-1",
          gateKind: "release_gate",
          gateScope: "release_readiness",
          buildId: "build-1",
          environment: "production",
          mode: "block",
          baseResult: "fail",
          verdict: "blocked",
          blockerClass: "not_release_ready",
          summary: "meta failed",
          breakGlass: false,
          overrideReason: null,
          evidence: {},
          emittedAt: "2026-04-20T00:02:00.000Z",
        },
        {
          id: "google-1",
          gateKind: "release_gate",
          gateScope: "release_readiness",
          buildId: "build-1",
          environment: "production",
          mode: "block",
          baseResult: "pass",
          verdict: "pass",
          blockerClass: null,
          summary: "google ok",
          breakGlass: false,
          overrideReason: null,
          evidence: {
            providerScope: "google_ads",
          },
          emittedAt: "2026-04-20T00:01:00.000Z",
        },
      ],
      {
        providerScope: "google_ads",
      },
    );

    expect(selected.deployGate?.id).toBe("deploy-1");
    expect(selected.releaseGate?.id).toBe("google-1");
  });

  it("treats unscoped legacy release gates as meta-only", () => {
    const selected = releaseGates.selectLatestSyncGateRecords(
      [
        {
          id: "legacy-meta-1",
          gateKind: "release_gate",
          gateScope: "release_readiness",
          buildId: "build-1",
          environment: "production",
          mode: "block",
          baseResult: "pass",
          verdict: "pass",
          blockerClass: null,
          summary: "legacy meta ok",
          breakGlass: false,
          overrideReason: null,
          evidence: {},
          emittedAt: "2026-04-20T00:00:00.000Z",
        },
      ],
      {
        providerScope: "meta",
      },
    );

    expect(selected.releaseGate?.id).toBe("legacy-meta-1");
  });

  it("never falls back to a cross-environment release gate", () => {
    const merged = releaseGates.mergeLatestSyncGateRecords({
      environment: "production",
      exact: {
        deployGate: {
          id: "deploy-prod",
          gateKind: "deploy_gate",
          gateScope: "service_liveness",
          buildId: "build-1",
          environment: "production",
          mode: "block",
          baseResult: "pass",
          verdict: "pass",
          blockerClass: null,
          summary: "deploy ok",
          breakGlass: false,
          overrideReason: null,
          evidence: {},
          emittedAt: "2026-04-20T00:00:00.000Z",
        },
        releaseGate: null,
      },
      fallbackByBuild: {
        deployGate: null,
        releaseGate: {
          id: "release-test",
          gateKind: "release_gate",
          gateScope: "release_readiness",
          buildId: "build-1",
          environment: "test",
          mode: "block",
          baseResult: "fail",
          verdict: "blocked",
          blockerClass: "not_release_ready",
          summary: "test release",
          breakGlass: false,
          overrideReason: null,
          evidence: {
            providerScope: "google_ads",
          },
          emittedAt: "2026-04-20T00:00:00.000Z",
        },
      },
    });

    expect(merged.deployGate?.id).toBe("deploy-prod");
    expect(merged.releaseGate).toBeNull();
  });

  it("falls back to an unknown-environment release gate", () => {
    const merged = releaseGates.mergeLatestSyncGateRecords({
      environment: "production",
      exact: {
        deployGate: null,
        releaseGate: null,
      },
      fallbackByBuild: {
        deployGate: null,
        releaseGate: {
          id: "release-unknown",
          gateKind: "release_gate",
          gateScope: "release_readiness",
          buildId: "build-1",
          environment: "unknown",
          mode: "block",
          baseResult: "pass",
          verdict: "pass",
          blockerClass: null,
          summary: "legacy release",
          breakGlass: false,
          overrideReason: null,
          evidence: {
            providerScope: "google_ads",
          },
          emittedAt: "2026-04-20T00:00:00.000Z",
        },
      },
    });

    expect(merged.releaseGate?.id).toBe("release-unknown");
  });

  it("blocks deploy gate when runtime contract evidence fails under block mode", async () => {
    vi.mocked(runtimeContract.getRuntimeRegistryStatus).mockResolvedValue({
      sampledAt: "2026-04-15T00:00:00.000Z",
      buildId: "dev-build",
      freshnessWindowMinutes: 10,
      contractValid: false,
      serviceHealth: {
        web: {
          instanceId: "web:test:1",
          service: "web",
          runtimeRole: "web",
          buildId: "dev-build",
          providerScopes: ["meta"],
          dbFingerprint: "db",
          configFingerprint: "cfg",
          healthState: "invalid",
          startedAt: "2026-04-15T00:00:00.000Z",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          contract: null,
          fresh: true,
        },
        worker: {
          instanceId: "worker:test:1",
          service: "worker",
          runtimeRole: "worker",
          buildId: "dev-build",
          providerScopes: ["meta"],
          dbFingerprint: "db",
          configFingerprint: "cfg",
          healthState: "healthy",
          startedAt: "2026-04-15T00:00:00.000Z",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          contract: null,
          fresh: true,
        },
      },
      webPresent: true,
      workerPresent: true,
      dbFingerprintMatch: false,
      configFingerprintMatch: true,
      issues: ["Web and worker DB fingerprints do not match."],
    });

    const verdict = await releaseGates.evaluateDeployGate({ persist: false });

    expect(verdict.baseResult).toBe("fail");
    expect(verdict.verdict).toBe("blocked");
    expect(verdict.blockerClass).toBe("runtime_contract_invalid");
    expect(verdict.gateScope).toBe("runtime_contract");
  });

  it("keeps deploy gate synthetic even when operator soak health is failing", async () => {
    const verdict = await releaseGates.evaluateDeployGate({ persist: false });

    expect(verdict.baseResult).toBe("pass");
    expect(verdict.verdict).toBe("pass");
    expect(verdict.blockerClass).toBeNull();
    expect(verdict.gateScope).toBe("service_liveness");
    expect(verdict.evidence).not.toHaveProperty("soakGate");
  });

  it("fails deploy gate when fresh Meta heartbeat is absent", async () => {
    vi.mocked(workerHealth.getProviderScopeWorkerObservation).mockReturnValue({
      workerId: "sync-worker:test:meta",
      workerFreshnessState: "stale",
      lastHeartbeatAt: "2026-04-15T00:00:00.000Z",
      heartbeatAgeMs: 900_000,
      hasFreshHeartbeat: false,
      metaJson: null,
    } as never);

    const verdict = await releaseGates.evaluateDeployGate({ persist: false });

    expect(verdict.baseResult).toBe("fail");
    expect(verdict.verdict).toBe("blocked");
    expect(verdict.blockerClass).toBe("heartbeat_missing");
    expect(verdict.gateScope).toBe("service_liveness");
  });

  it("passes release gate from runtime serving readiness without sync canaries", async () => {
    delete process.env.SYNC_RELEASE_CANARY_BUSINESSES;
    process.env.SYNC_RELEASE_GATE_MODE = "block";

    const verdict = await releaseGates.evaluateReleaseGate({ persist: false });

    expect(verdict.baseResult).toBe("pass");
    expect(verdict.verdict).toBe("pass");
    expect(verdict.blockerClass).toBeNull();
    expect(verdict.gateScope).toBe("release_readiness");
    expect(verdict.summary).toBe("Release gate serving readiness passed.");
    expect(verdict.evidence).toMatchObject({
      buildId: "dev-build",
      runtimeRegistry: expect.objectContaining({
        webPresent: true,
        workerPresent: true,
        contractValid: true,
      }),
    });
    expect(verdict.evidence).not.toHaveProperty("canaryBusinessIds");
    expect(verdict.evidence).not.toHaveProperty("canaries");
    expect(JSON.stringify(verdict.evidence)).not.toMatch(/canary|queue|deadLetter/i);
  });

  it("blocks release gate when runtime contract evidence fails under block mode", async () => {
    process.env.SYNC_RELEASE_GATE_MODE = "block";
    vi.mocked(runtimeContract.getRuntimeRegistryStatus).mockResolvedValue({
      sampledAt: "2026-04-15T00:00:00.000Z",
      buildId: "dev-build",
      freshnessWindowMinutes: 10,
      contractValid: false,
      serviceHealth: {
        web: {
          instanceId: "web:test:1",
          service: "web",
          runtimeRole: "web",
          buildId: "dev-build",
          providerScopes: ["meta"],
          dbFingerprint: "db",
          configFingerprint: "cfg",
          healthState: "invalid",
          startedAt: "2026-04-15T00:00:00.000Z",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          contract: null,
          fresh: true,
        },
        worker: {
          instanceId: "worker:test:1",
          service: "worker",
          runtimeRole: "worker",
          buildId: "dev-build",
          providerScopes: ["meta"],
          dbFingerprint: "db",
          configFingerprint: "cfg",
          healthState: "healthy",
          startedAt: "2026-04-15T00:00:00.000Z",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          contract: null,
          fresh: true,
        },
      },
      webPresent: true,
      workerPresent: true,
      dbFingerprintMatch: false,
      configFingerprintMatch: true,
      issues: ["Web and worker DB fingerprints do not match."],
    });

    const verdict = await releaseGates.evaluateReleaseGate({ persist: false });

    expect(verdict.baseResult).toBe("fail");
    expect(verdict.verdict).toBe("blocked");
    expect(verdict.blockerClass).toBe("runtime_contract_invalid");
    expect(verdict.gateScope).toBe("runtime_contract");
    expect(verdict.summary).toContain("Release gate serving readiness failed");
    expect(verdict.evidence).not.toHaveProperty("canaries");
  });

  it("keeps serving release gate read-only under measure_only mode", async () => {
    process.env.SYNC_RELEASE_GATE_MODE = "measure_only";
    vi.mocked(runtimeContract.getRuntimeRegistryStatus).mockResolvedValue({
      sampledAt: "2026-04-15T00:00:00.000Z",
      buildId: "dev-build",
      freshnessWindowMinutes: 10,
      contractValid: true,
      serviceHealth: {
        web: {
          instanceId: "web:test:1",
          service: "web",
          runtimeRole: "web",
          buildId: "dev-build",
          providerScopes: ["meta"],
          dbFingerprint: "db",
          configFingerprint: "cfg",
          healthState: "healthy",
          startedAt: "2026-04-15T00:00:00.000Z",
          lastSeenAt: "2026-04-15T00:00:00.000Z",
          contract: null,
          fresh: true,
        },
        worker: null,
      },
      webPresent: true,
      workerPresent: false,
      dbFingerprintMatch: true,
      configFingerprintMatch: true,
      issues: ["Worker runtime registry heartbeat missing."],
    });

    const verdict = await releaseGates.evaluateReleaseGate({ persist: false });

    expect(verdict.baseResult).toBe("fail");
    expect(verdict.verdict).toBe("measure_only");
    expect(verdict.blockerClass).toBe("service_unavailable");
    expect(verdict.gateScope).toBe("release_readiness");
    expect(verdict.evidence).not.toHaveProperty("canaries");
  });

  describe("gate scope identity", () => {
    it("files a deploy gate under the GLOBAL scope, never under a provider", () => {
      // A deploy gate measures the runtime contract and service liveness — one
      // verdict for the deployment. Filing it as 'meta' made it invisible to the
      // Google control plane, which asks for 'google_ads' and received no deploy
      // gate at all: reported as absent, which reads as "never evaluated".
      expect(
        releaseGates.resolveSyncGateProviderScope({
          gateKind: "deploy_gate",
          evidence: { providerScope: "google_ads" },
        }),
      ).toBe("global");
    });

    it("keeps a release gate on the provider its evidence records", () => {
      expect(
        releaseGates.resolveSyncGateProviderScope({
          gateKind: "release_gate",
          evidence: { providerScope: "google_ads" },
        }),
      ).toBe("google_ads");
      expect(
        releaseGates.resolveSyncGateProviderScope({
          gateKind: "release_gate",
          evidence: {},
        }),
      ).toBe("meta");
    });

    it("resolves the same deploy gate for every provider reader", () => {
      for (const providerScope of ["meta", "google_ads", "shopify", undefined]) {
        expect(
          releaseGates.resolveSyncGateReadProviderScope({
            gateKind: "deploy_gate",
            providerScope,
          }),
        ).toBe("global");
      }
      expect(
        releaseGates.resolveSyncGateReadProviderScope({
          gateKind: "release_gate",
          providerScope: "google_ads",
        }),
      ).toBe("google_ads");
    });
  });

  describe("environment merge", () => {
    const row = (environment: string, id: string) =>
      ({
        id,
        gateKind: "deploy_gate",
        gateScope: "service_liveness",
        buildId: "b",
        environment,
        mode: "block",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: id,
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-01-01T00:00:00.000Z",
      }) as never;

    it("refuses a staging fallback for a production read", () => {
      const merged = releaseGates.mergeLatestSyncGateRecords({
        environment: "production",
        exact: { deployGate: null, releaseGate: null },
        fallbackByBuild: {
          deployGate: row("staging", "staging-row"),
          releaseGate: row("staging", "staging-release"),
        },
      });
      expect(merged.deployGate).toBeNull();
      expect(merged.releaseGate).toBeNull();
    });

    it("refuses to treat an unknown-environment PASS as authoritative", () => {
      // The gate was emitted by a process that could not tell which environment
      // it was in. A `fail` from it is still worth honouring; a `pass` says only
      // "whatever environment that was, it looked fine" — which is exactly the
      // reasoning a gate exists to prevent.
      const merged = releaseGates.mergeLatestSyncGateRecords({
        environment: "production",
        exact: { deployGate: null, releaseGate: null },
        fallbackByBuild: {
          deployGate: row("unknown", "unknown-pass"),
          releaseGate: null,
        },
      });
      expect(merged.deployGate?.verdict).toBe("misconfigured");
      expect(merged.deployGate?.summary).toMatch(/not authoritative/i);
      // ...and it is therefore enforced, rather than quietly allowing a deploy.
      expect(
        releaseGates.shouldEnforceSyncGateFailure([merged.deployGate]),
      ).toBe(true);
    });

    it("still honours an unknown-environment FAILURE", () => {
      const failing = {
        ...(row("unknown", "unknown-fail") as unknown as Record<string, unknown>),
        verdict: "blocked",
        baseResult: "fail",
      } as never;
      const merged = releaseGates.mergeLatestSyncGateRecords({
        environment: "production",
        exact: { deployGate: null, releaseGate: null },
        fallbackByBuild: { deployGate: failing, releaseGate: null },
      });
      expect(merged.deployGate?.verdict).toBe("blocked");
    });

    it("accepts an environment-less fallback and prefers the exact row", () => {
      expect(
        releaseGates.mergeLatestSyncGateRecords({
          environment: "production",
          exact: { deployGate: null, releaseGate: null },
          fallbackByBuild: {
            deployGate: row("unknown", "unknown-row"),
            releaseGate: null,
          },
        }).deployGate?.verdict,
      ).toBe("misconfigured");
      expect(
        releaseGates.mergeLatestSyncGateRecords({
          environment: "production",
          exact: { deployGate: row("production", "exact-row"), releaseGate: null },
          fallbackByBuild: {
            deployGate: row("unknown", "unknown-row"),
            releaseGate: null,
          },
        }).deployGate?.id,
      ).toBe("exact-row");
    });
  });

  it("enforces only blocked or misconfigured verdicts", () => {
    expect(
      releaseGates.shouldEnforceSyncGateFailure([
        { verdict: "measure_only" },
        { verdict: "warn_only" },
      ] as never),
    ).toBe(false);
    expect(
      releaseGates.shouldEnforceSyncGateFailure([
        { verdict: "blocked" },
      ] as never),
    ).toBe(true);
    expect(
      releaseGates.shouldEnforceSyncGateFailure([
        { verdict: "misconfigured" },
      ] as never),
    ).toBe(true);
  });
});
