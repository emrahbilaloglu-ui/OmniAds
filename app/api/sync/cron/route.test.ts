import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/sync/active-businesses", () => ({
  getActiveBusinesses: vi.fn(),
}));

vi.mock("@/lib/sync/meta-sync", () => ({
  enqueueMetaScheduledWork: vi.fn(),
}));

vi.mock("@/lib/sync/google-ads-sync", () => ({
  enqueueGoogleAdsScheduledWork: vi.fn(),
}));

vi.mock("@/lib/meta/scheduled", () => ({
  runMetaSnapshotJobIfDue: vi.fn(),
}));

vi.mock("@/lib/meta/decision-responses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/decision-responses")>();
  return {
    ...actual,
    runMetaDecisionIgnoredMarkerIfDue: vi.fn(),
  };
});

vi.mock("@/lib/meta/outcome-accrual", () => ({
  runMetaOutcomeAccrualIfDue: vi.fn(),
}));

vi.mock("@/lib/creative-decision-engine", () => ({
  runAdDecisionOutcomesJobForActiveBusinessesIfDue: vi.fn(),
  runDecisionOutcomesJobForActiveBusinessesIfDue: vi.fn(),
  runEngineV3ProducerChainForActiveBusinessesIfDue: vi.fn(),
  runNativeAdShadowChainForActiveBusinessesIfDue: vi.fn(),
}));

vi.mock("@/lib/sync/ga4-sync", () => ({
  syncGA4Reports: vi.fn(),
}));

vi.mock("@/lib/sync/search-console-sync", () => ({
  syncSearchConsoleReports: vi.fn(),
}));

vi.mock("@/lib/sync/shopify-sync", () => ({
  syncShopifyCommerceReports: vi.fn(),
}));

vi.mock("@/lib/sync/soak-gate", () => ({
  runSyncSoakGate: vi.fn(),
}));

vi.mock("@/lib/sync/release-gates", () => ({
  evaluateAndPersistSyncGates: vi.fn(),
  shouldEnforceSyncGateFailure: vi.fn((records: Array<{ verdict?: string } | null | undefined>) =>
    records.some((record) => record?.verdict === "blocked" || record?.verdict === "misconfigured"),
  ),
}));

vi.mock("@/lib/sync/repair-planner", () => ({
  evaluateAndPersistSyncRepairPlan: vi.fn(),
}));

vi.mock("@/lib/sync/repair-executor", () => ({
  executeAutoSyncRepairPlan: vi.fn(),
}));

vi.mock("@/lib/google-ads/control-plane-runtime", () => ({
  evaluateAndPersistGoogleAdsControlPlane: vi.fn(),
}));

const activeBusinesses = await import("@/lib/sync/active-businesses");
const metaSync = await import("@/lib/sync/meta-sync");
const googleSync = await import("@/lib/sync/google-ads-sync");
const metaScheduled = await import("@/lib/meta/scheduled");
const decisionResponses = await import("@/lib/meta/decision-responses");
const outcomeAccrual = await import("@/lib/meta/outcome-accrual");
vi.mock("@/lib/sync/db-growth-fence", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertSyncGrowthBoundary: vi.fn() };
});

const creativeDecisionEngine = await import("@/lib/creative-decision-engine");
const ga4Sync = await import("@/lib/sync/ga4-sync");
const searchConsoleSync = await import("@/lib/sync/search-console-sync");
const shopifySync = await import("@/lib/sync/shopify-sync");
const soakGate = await import("@/lib/sync/soak-gate");
const releaseGates = await import("@/lib/sync/release-gates");
const repairPlanner = await import("@/lib/sync/repair-planner");
const repairExecutor = await import("@/lib/sync/repair-executor");
const googleControlPlane = await import("@/lib/google-ads/control-plane-runtime");
const dbGrowthFence = await import("@/lib/sync/db-growth-fence");
const { POST } = await import("@/app/api/sync/cron/route");

describe("POST /api/sync/cron", () => {
  const savedCronEnv = { ...process.env };
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "secret";
    // The cron admits ONCE, before any work. These cases exercise what the pass
    // does once admitted; the refusal itself is asserted separately below.
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED = "enabled";
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockResolvedValue({
      allowed: true,
      reason: "ready",
    } as never);
    delete process.env.SYNC_CRON_ENFORCE_SOAK_GATE;
    delete process.env.SHOPIFY_SYNC_ENABLED;
    vi.mocked(activeBusinesses.getActiveBusinesses).mockResolvedValue([
      { id: "biz_1", name: "Biz 1" },
    ] as never);
    vi.mocked(metaSync.enqueueMetaScheduledWork).mockResolvedValue({ queued: 1 } as never);
    vi.mocked(googleSync.enqueueGoogleAdsScheduledWork).mockResolvedValue({ queued: 1 } as never);
    vi.mocked(metaScheduled.runMetaSnapshotJobIfDue).mockResolvedValue({
      skipped: true,
      reason: "outside_slot",
      snapshotDate: "2026-04-15",
    });
    vi.mocked(decisionResponses.runMetaDecisionIgnoredMarkerIfDue).mockResolvedValue({
      skipped: true,
      reason: "not_due",
      snapshotDate: "2026-04-15",
    });
    vi.mocked(outcomeAccrual.runMetaOutcomeAccrualIfDue).mockResolvedValue({
      skipped: true,
      reason: "not_due",
      runDate: "2026-04-15",
    });
    vi.mocked(
      creativeDecisionEngine.runDecisionOutcomesJobForActiveBusinessesIfDue,
    ).mockResolvedValue({
      skipped: true,
      reason: "outside_slot",
      asOf: "2026-04-15",
    });
    vi.mocked(
      creativeDecisionEngine.runEngineV3ProducerChainForActiveBusinessesIfDue,
    ).mockResolvedValue({
      skipped: true,
      reason: "outside_slot",
      asOf: "2026-04-15",
    });
    vi.mocked(
      creativeDecisionEngine.runNativeAdShadowChainForActiveBusinessesIfDue,
    ).mockResolvedValue({
      skipped: true,
      reason: "outside_slot",
      asOf: "2026-04-15",
      engineVersion: "v3-ad-test",
    } as never);
    vi.mocked(
      creativeDecisionEngine.runAdDecisionOutcomesJobForActiveBusinessesIfDue,
    ).mockResolvedValue({
      skipped: true,
      reason: "outside_slot",
      asOf: "2026-04-15",
    });
    vi.mocked(ga4Sync.syncGA4Reports).mockResolvedValue({ synced: true } as never);
    vi.mocked(searchConsoleSync.syncSearchConsoleReports).mockResolvedValue({ synced: true } as never);
    vi.mocked(shopifySync.syncShopifyCommerceReports).mockResolvedValue({
      success: true,
      returns: 2,
    } as never);
    vi.mocked(releaseGates.evaluateAndPersistSyncGates).mockResolvedValue({
      checkedAt: "2026-04-15T00:00:00.000Z",
      deployGate: {
        gateKind: "deploy_gate",
        gateScope: "service_liveness",
        buildId: "sha",
        environment: "test",
        mode: "measure_only",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "ok",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-15T00:00:00.000Z",
      },
      releaseGate: {
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "sha",
        environment: "test",
        mode: "measure_only",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "ok",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-15T00:00:00.000Z",
      },
    } as never);
    vi.mocked(repairPlanner.evaluateAndPersistSyncRepairPlan).mockResolvedValue({
      buildId: "sha",
      environment: "test",
      providerScope: "meta",
      planMode: "dry_run",
      eligible: true,
      blockedReason: null,
      breakGlass: false,
      summary: "no-op",
      recommendations: [],
      emittedAt: "2026-04-15T00:00:00.000Z",
    } as never);
    vi.mocked(repairExecutor.executeAutoSyncRepairPlan).mockResolvedValue({
      releaseGate: null,
      repairPlan: {
        buildId: "sha",
        environment: "test",
        providerScope: "meta",
        planMode: "auto_execute",
        eligible: true,
        blockedReason: null,
        breakGlass: false,
        summary: "no-op",
        recommendations: [],
        emittedAt: "2026-04-15T00:00:00.000Z",
      },
      results: [],
    } as never);
    vi.mocked(googleControlPlane.evaluateAndPersistGoogleAdsControlPlane).mockResolvedValue({
      identity: {
        buildId: "sha",
        environment: "test",
        providerScope: "google_ads",
      },
      checkedAt: "2026-04-15T00:00:00.000Z",
      deployGate: {
        gateKind: "deploy_gate",
        gateScope: "service_liveness",
        buildId: "sha",
        environment: "test",
        mode: "measure_only",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "ok",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-15T00:00:00.000Z",
      },
      releaseGate: {
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "sha",
        environment: "test",
        mode: "measure_only",
        baseResult: "pass",
        verdict: "pass",
        blockerClass: null,
        summary: "ok",
        breakGlass: false,
        overrideReason: null,
        evidence: {
          providerScope: "google_ads",
        },
        emittedAt: "2026-04-15T00:00:00.000Z",
      },
    } as never);
  });

  it("returns 503 when soak enforcement is enabled and the gate fails", async () => {
    process.env.SYNC_CRON_ENFORCE_SOAK_GATE = "true";
    vi.mocked(soakGate.runSyncSoakGate).mockResolvedValue({
      health: {} as never,
      result: {
        outcome: "fail",
        checkedAt: "2026-04-01T00:00:00.000Z",
        thresholds: {
          maxStaleRuns24h: 0,
          maxLeaseConflicts24h: 0,
          maxSkippedActiveLeaseRecoveries24h: 5,
          maxQueueDepth: 25,
          maxDeadLetters: 0,
          maxCriticalIssues: 0,
        },
        checks: [],
        blockingChecks: [{ key: "critical_issue_count", ok: false, actual: 1, threshold: 0 }],
        issueCount: 1,
        criticalIssueCount: 1,
        unresolvedRunbookKeys: [],
        topIssue: "critical",
        releaseReadiness: "blocked",
        summary: "Sync soak gate failed: critical_issue_count",
      },
    } as never);

    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.ok).toBe(true);
    expect(payload.soakGate.outcome).toBe("fail");
  });

  it("returns 200 without a soak payload when soak enforcement is disabled", async () => {
    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.soakGate).toBeUndefined();
    expect(payload.gateVerdicts).toBeDefined();
    expect(payload.repairPlan).toBeDefined();
    expect(soakGate.runSyncSoakGate).not.toHaveBeenCalled();
    expect(payload.results[0].shopify).toEqual({ skipped: true, reason: "disabled" });
    expect(payload.metaSnapshotJob).toEqual({
      skipped: true,
      reason: "outside_slot",
      snapshotDate: "2026-04-15",
    });
    expect(payload.metaIgnoredMarkerJob).toEqual({
      skipped: true,
      reason: "not_due",
      snapshotDate: "2026-04-15",
    });
    expect(payload.metaOutcomeAccrualJob).toEqual({
      skipped: true,
      reason: "not_due",
      runDate: "2026-04-15",
    });
    expect(payload.decisionOutcomesJob).toEqual({
      skipped: true,
      reason: "outside_slot",
      asOf: "2026-04-15",
    });
    expect(payload.decisionProducerJob).toEqual({
      skipped: true,
      reason: "outside_slot",
      asOf: "2026-04-15",
    });
    expect(payload.nativeAdShadowJob).toEqual(
      expect.objectContaining({
        skipped: true,
        reason: "outside_slot",
        asOf: "2026-04-15",
      }),
    );
    expect(payload.nativeAdOutcomesJob).toEqual({
      skipped: true,
      reason: "outside_slot",
      asOf: "2026-04-15",
    });
    expect(
      creativeDecisionEngine.runEngineV3ProducerChainForActiveBusinessesIfDue,
    ).toHaveBeenCalledWith(expect.any(Date));
    expect(
      creativeDecisionEngine.runDecisionOutcomesJobForActiveBusinessesIfDue,
    ).toHaveBeenCalledWith(expect.any(Date), [
      { id: "biz_1", name: "Biz 1" },
    ]);
    expect(
      creativeDecisionEngine.runNativeAdShadowChainForActiveBusinessesIfDue,
    ).toHaveBeenCalledWith(expect.any(Date), [
      { id: "biz_1", name: "Biz 1" },
    ]);
    expect(
      creativeDecisionEngine.runAdDecisionOutcomesJobForActiveBusinessesIfDue,
    ).toHaveBeenCalledWith(expect.any(Date), [
      { id: "biz_1", name: "Biz 1" },
    ]);
    expect(
      vi.mocked(
        creativeDecisionEngine.runEngineV3ProducerChainForActiveBusinessesIfDue,
      ).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(
        creativeDecisionEngine.runDecisionOutcomesJobForActiveBusinessesIfDue,
      ).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("does not fail cron when the Meta snapshot job fails", async () => {
    vi.mocked(metaScheduled.runMetaSnapshotJobIfDue).mockRejectedValue(new Error("snapshot failed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.metaSnapshotJob.skipped).toBe(true);
    expect(payload.metaSnapshotJob.reason).toBe("failed");
    expect(spy).toHaveBeenCalledWith("[sync-cron] meta_snapshot_job_failed", expect.any(Error));

    spy.mockRestore();
  });

  it("does not fail cron when the Meta ignored marker job fails", async () => {
    vi.mocked(decisionResponses.runMetaDecisionIgnoredMarkerIfDue).mockRejectedValue(
      new Error("ignored marker failed"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.metaIgnoredMarkerJob.skipped).toBe(true);
    expect(payload.metaIgnoredMarkerJob.reason).toBe("failed");
    expect(spy).toHaveBeenCalledWith(
      "[sync-cron] meta_decision_ignored_marker_failed",
      expect.any(Error),
    );

    spy.mockRestore();
  });

  it("does not fail cron when the Meta outcome accrual job fails", async () => {
    vi.mocked(outcomeAccrual.runMetaOutcomeAccrualIfDue).mockRejectedValue(
      new Error("outcome accrual failed"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.metaOutcomeAccrualJob.skipped).toBe(true);
    expect(payload.metaOutcomeAccrualJob.reason).toBe("failed");
    expect(spy).toHaveBeenCalledWith(
      "[sync-cron] meta_outcome_accrual_failed",
      expect.any(Error),
    );

    spy.mockRestore();
  });

  it("does not fail cron when the Creative decision outcomes job fails", async () => {
    vi.mocked(
      creativeDecisionEngine.runDecisionOutcomesJobForActiveBusinessesIfDue,
    ).mockRejectedValue(new Error("outcomes failed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionOutcomesJob.skipped).toBe(true);
    expect(payload.decisionOutcomesJob.reason).toBe("failed");
    expect(spy).toHaveBeenCalledWith(
      "[sync-cron] decision_outcomes_job_failed",
      expect.any(Error),
    );

    spy.mockRestore();
  });

  it("does not fail cron when the Creative decision producer job fails", async () => {
    vi.mocked(
      creativeDecisionEngine.runEngineV3ProducerChainForActiveBusinessesIfDue,
    ).mockRejectedValue(new Error("producer failed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decisionProducerJob.skipped).toBe(true);
    expect(payload.decisionProducerJob.reason).toBe("failed");
    expect(spy).toHaveBeenCalledWith(
      "[sync-cron] decision_producer_job_failed",
      expect.any(Error),
    );

    spy.mockRestore();
  });

  it("does not fail cron when the native ad shadow chain fails", async () => {
    vi.mocked(
      creativeDecisionEngine.runNativeAdShadowChainForActiveBusinessesIfDue,
    ).mockRejectedValue(new Error("native shadow failed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.nativeAdShadowJob).toMatchObject({
      skipped: true,
      reason: "failed",
    });
    expect(spy).toHaveBeenCalledWith(
      "[sync-cron] native_ad_shadow_job_failed",
      expect.any(Error),
    );
    spy.mockRestore();
  });

  it("does not fail cron when native ad outcomes fail", async () => {
    vi.mocked(
      creativeDecisionEngine.runAdDecisionOutcomesJobForActiveBusinessesIfDue,
    ).mockRejectedValue(new Error("native outcomes failed"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.nativeAdOutcomesJob).toMatchObject({
      skipped: true,
      reason: "failed",
    });
    expect(spy).toHaveBeenCalledWith(
      "[sync-cron] native_ad_outcomes_job_failed",
      expect.any(Error),
    );
    spy.mockRestore();
  });

  it("runs Shopify sync when enabled", async () => {
    process.env.SHOPIFY_SYNC_ENABLED = "true";

    const request = new NextRequest("http://localhost/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(shopifySync.syncShopifyCommerceReports).toHaveBeenCalledWith("biz_1");
    expect(payload.results[0].shopify).toEqual(expect.objectContaining({ success: true, returns: 2 }));
  });

  it("persists current-build control-plane state without scheduling work", async () => {
    const request = new NextRequest(
      "http://localhost/api/sync/cron?controlPlaneOnly=1&buildId=build-123&enforceDeployGate=1",
      {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      },
    );

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.controlPlaneOnly).toBe(true);
    expect(payload.providerScope).toBe("meta");
    expect(activeBusinesses.getActiveBusinesses).not.toHaveBeenCalled();
    expect(metaSync.enqueueMetaScheduledWork).not.toHaveBeenCalled();
    expect(releaseGates.evaluateAndPersistSyncGates).toHaveBeenCalledWith({
      buildId: "build-123",
      breakGlass: false,
      overrideReason: null,
    });
    expect(repairPlanner.evaluateAndPersistSyncRepairPlan).toHaveBeenCalledWith({
      buildId: "build-123",
      providerScope: "meta",
      releaseGate: expect.objectContaining({
        gateKind: "release_gate",
      }),
      planMode: "auto_execute",
    });
  });

  it("supports provider-scoped control-plane repair plans", async () => {
    const request = new NextRequest(
      "http://localhost/api/sync/cron?controlPlaneOnly=1&buildId=build-123&providerScope=google_ads&enforceDeployGate=1",
      {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      },
    );

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.controlPlaneOnly).toBe(true);
    expect(payload.providerScope).toBe("google_ads");
    expect(googleControlPlane.evaluateAndPersistGoogleAdsControlPlane).toHaveBeenCalledWith({
      buildId: "build-123",
      breakGlass: false,
      overrideReason: null,
    });
    expect(releaseGates.evaluateAndPersistSyncGates).not.toHaveBeenCalled();
    expect(repairPlanner.evaluateAndPersistSyncRepairPlan).toHaveBeenCalledWith({
      buildId: "build-123",
      providerScope: "google_ads",
      releaseGate: expect.objectContaining({
        gateKind: "release_gate",
        evidence: expect.objectContaining({
          providerScope: "google_ads",
        }),
      }),
      planMode: "auto_execute",
    });
  });

  it("rejects unsupported provider scopes in control-plane-only mode", async () => {
    const request = new NextRequest(
      "http://localhost/api/sync/cron?controlPlaneOnly=1&providerScope=shopify",
      {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      },
    );

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe("unsupported_provider_scope");
    expect(releaseGates.evaluateAndPersistSyncGates).not.toHaveBeenCalled();
    expect(googleControlPlane.evaluateAndPersistGoogleAdsControlPlane).not.toHaveBeenCalled();
  });

  it("returns 503 for control-plane-only mode when deploy gate enforcement fails", async () => {
    vi.mocked(releaseGates.evaluateAndPersistSyncGates).mockResolvedValueOnce({
      checkedAt: "2026-04-15T00:00:00.000Z",
      deployGate: {
        gateKind: "deploy_gate",
        gateScope: "service_liveness",
        buildId: "build-123",
        environment: "test",
        mode: "block",
        baseResult: "fail",
        verdict: "blocked",
        blockerClass: "heartbeat_missing",
        summary: "missing heartbeat",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-15T00:00:00.000Z",
      },
      releaseGate: {
        gateKind: "release_gate",
        gateScope: "release_readiness",
        buildId: "build-123",
        environment: "test",
        mode: "measure_only",
        baseResult: "fail",
        verdict: "measure_only",
        blockerClass: "not_release_ready",
        summary: "blocked",
        breakGlass: false,
        overrideReason: null,
        evidence: {},
        emittedAt: "2026-04-15T00:00:00.000Z",
      },
    } as never);

    const request = new NextRequest(
      "http://localhost/api/sync/cron?controlPlaneOnly=1&buildId=build-123&enforceDeployGate=1",
      {
        method: "POST",
        headers: { authorization: "Bearer secret" },
      },
    );

    const response = await POST(request);
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.ok).toBe(false);
    expect(payload.controlPlaneOnly).toBe(true);
    expect(metaSync.enqueueMetaScheduledWork).not.toHaveBeenCalled();
  });
});

describe("sync cron admission happens BEFORE any work", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.CRON_SECRET = "secret";
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockResolvedValue({
      allowed: true,
      reason: "ready",
    } as never);
    vi.mocked(activeBusinesses.getActiveBusinesses).mockResolvedValue([
      { id: "biz_1", name: "Biz 1" },
    ] as never);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const cronRequest = () =>
    new NextRequest("https://example.com/api/sync/cron", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });

  it("does ZERO snapshot, repair and reconciliation writes under global-off", async () => {
    delete process.env.ADSECUTE_SYNC_GLOBAL_ENABLED;
    const response = await POST(cronRequest());
    expect(response.status).toBe(503);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.refusal).not.toBeNull();

    // Every writer the pass would have run. Previously all of these executed and
    // the refusal was reported afterwards.
    expect(metaScheduled.runMetaSnapshotJobIfDue).not.toHaveBeenCalled();
    expect(repairPlanner.evaluateAndPersistSyncRepairPlan).not.toHaveBeenCalled();
    expect(repairExecutor.executeAutoSyncRepairPlan).not.toHaveBeenCalled();
    expect(metaSync.enqueueMetaScheduledWork).not.toHaveBeenCalled();
    expect(googleSync.enqueueGoogleAdsScheduledWork).not.toHaveBeenCalled();
    expect(activeBusinesses.getActiveBusinesses).not.toHaveBeenCalled();
  });

  it("does ZERO work when the growth fence refuses", async () => {
    process.env.ADSECUTE_SYNC_GLOBAL_ENABLED = "enabled";
    process.env.ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED = "enabled";
    vi.mocked(dbGrowthFence.assertSyncGrowthBoundary).mockRejectedValue(
      new dbGrowthFence.DbGrowthFenceRefusal(
        {
          allowed: false,
          reason: "physical_snapshot_stale",
          warning: false,
          databaseBytes: 1,
          databaseBudgetBytes: 2,
          tableBytes: {},
          offender: null,
          evaluatedAt: new Date(0).toISOString(),
          errorMessage: "sampler stopped",
          overridden: false,
          physical: null,
        },
        "sync_cron_tick",
      ),
    );
    const response = await POST(cronRequest());
    expect(response.status).toBe(503);
    expect(activeBusinesses.getActiveBusinesses).not.toHaveBeenCalled();
  });
});
