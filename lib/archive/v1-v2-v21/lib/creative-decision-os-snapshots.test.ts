import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(() => sql),
}));

vi.mock("@/lib/db-schema-readiness", () => ({
  assertDbSchemaReady: vi.fn(),
  getDbSchemaReadiness: vi.fn(),
}));

const readiness = await import("@/lib/db-schema-readiness");
const snapshots = await import("@/lib/creative-decision-os-snapshots");

function payload() {
  return {
    contractVersion: "creative-decision-os.v1",
    engineVersion: "engine-v1",
    businessId: "biz",
    generatedAt: "2026-04-10T00:00:00.000Z",
    startDate: "2026-04-01",
    endDate: "2026-04-10",
    analyticsWindow: {
      startDate: "2026-03-01",
      endDate: "2026-03-31",
      role: "analysis_only",
    },
    decisionAsOf: "2026-04-10",
    decisionWindows: {
      primary30d: {
        label: "primary 30d",
        startDate: "2026-03-12",
        endDate: "2026-04-10",
      },
    },
    summary: {
      totalCreatives: 1,
      surfaceSummary: { actionCoreCount: 0, watchlistCount: 1, archiveCount: 0, degradedCount: 0 },
      benchmarkScope: {
        benchmarkScope: "account",
        benchmarkScopeLabel: "Account-wide",
        benchmarkReliability: "strong",
      },
    },
    creatives: [
      {
        creativeId: "cr_1",
        lifecycleState: "validating",
        spend: 100,
        purchases: 2,
        roas: 1.2,
        operatorPolicy: {
          segment: "hold_monitor",
          policyVersion: "creative-operator-policy.v1",
        },
      },
    ],
  } as never;
}

describe("creative decision os snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sql.mockResolvedValue([]);
    vi.mocked(readiness.assertDbSchemaReady).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-10T00:00:00.000Z",
    });
    vi.mocked(readiness.getDbSchemaReadiness).mockResolvedValue({
      ready: true,
      missingTables: [],
      checkedAt: "2026-04-10T00:00:00.000Z",
    });
  });

  it("normalizes account and campaign snapshot scope identities", () => {
    expect(snapshots.resolveCreativeDecisionOsSnapshotScope(null)).toEqual({
      analysisScope: "account",
      analysisScopeId: null,
      analysisScopeLabel: "Account-wide",
      benchmarkScope: "account",
      benchmarkScopeId: null,
      benchmarkScopeLabel: "Account-wide",
    });

    expect(
      snapshots.resolveCreativeDecisionOsSnapshotScope({
        scope: "campaign",
        scopeId: "cmp_1",
        scopeLabel: "Test Campaign",
      }),
    ).toEqual({
      analysisScope: "campaign",
      analysisScopeId: "cmp_1",
      analysisScopeLabel: "Test Campaign",
      benchmarkScope: "campaign",
      benchmarkScopeId: "cmp_1",
      benchmarkScopeLabel: "Test Campaign",
    });
  });

  it("saves a ready snapshot without using reporting dates as scope identity", async () => {
    const snapshot = await snapshots.saveCreativeDecisionOsSnapshot({
      businessId: "biz",
      payload: payload(),
      generatedBy: "user_1",
      analyticsStartDate: "2026-03-01",
      analyticsEndDate: "2026-03-31",
      reportingStartDate: "2026-04-01",
      reportingEndDate: "2026-04-10",
    });

    expect(snapshot.status).toBe("ready");
    expect(snapshot.scope.analysisScope).toBe("account");
    expect(snapshot.scope.benchmarkScope).toBe("account");
    expect(snapshot.sourceWindow.reportingStartDate).toBe("2026-04-01");
    expect(snapshot.sourceWindow.analyticsStartDate).toBe("2026-03-01");
    expect(snapshot.payload?.contractVersion).toBe("creative-decision-os.v1");
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("returns not found instead of computing when the snapshot table is unavailable", async () => {
    vi.mocked(readiness.getDbSchemaReadiness).mockResolvedValue({
      ready: false,
      missingTables: ["creative_decision_os_snapshots"],
      checkedAt: "2026-04-10T00:00:00.000Z",
    });

    await expect(
      snapshots.getLatestCreativeDecisionOsSnapshot({ businessId: "biz" }),
    ).resolves.toBeNull();
    expect(sql).not.toHaveBeenCalled();
  });
});
