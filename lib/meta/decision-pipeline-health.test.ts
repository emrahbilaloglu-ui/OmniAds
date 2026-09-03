import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-contract";

const dbMock = vi.hoisted(() => ({
  query: vi.fn(),
  getDbWithTimeout: vi.fn(),
}));
const fenceMock = vi.hoisted(() => ({
  evaluateDbGrowthFence: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDbWithTimeout: dbMock.getDbWithTimeout,
}));

vi.mock("@/lib/sync/db-growth-fence", () => ({
  evaluateDbGrowthFence: fenceMock.evaluateDbGrowthFence,
}));

import {
  buildMetaDecisionPipelineHealth,
  readMetaDecisionPipelineOperationalHealth,
} from "@/lib/meta/decision-pipeline-health";

const NOW = new Date("2026-08-29T16:20:00.000Z");

function admittedFence(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true,
    reason: "ready",
    warning: false,
    databaseBytes: 100,
    databaseBudgetBytes: 1_000,
    tableBytes: {},
    offender: null,
    evaluatedAt: NOW.toISOString(),
    errorMessage: null,
    overridden: false,
    physical: null,
    ...overrides,
  };
}

function readModel(overrides: {
  status?: "available" | "unavailable";
  authority?: "native_ad" | "legacy_creative" | "unavailable";
  sourceStatus?: "available" | "unavailable";
  computedAt?: string | null;
  generation?: MetaDecisionsWorkspaceReadModel["source"]["generation"];
  fallbackReason?: string | null;
} = {}): MetaDecisionsWorkspaceReadModel {
  return {
    contractVersion: "meta-decisions-workspace.read.v4",
    status: overrides.status ?? "available",
    generatedAt: NOW.toISOString(),
    scope: {
      businessId: "biz_1",
      providerAccountId: "act_1",
      decisionMode: "current",
      metricsRangeAffectsDecisionSnapshot: false,
    },
    unavailable:
      overrides.status === "unavailable"
        ? { code: "snapshot_unavailable", message: "missing" }
        : null,
    source: {
      status: overrides.sourceStatus ?? "available",
      authority: overrides.authority ?? "native_ad",
      table: "engine_v3_ad_decision_snapshots_daily",
      snapshotAsOf: "2026-08-29",
      computedAt:
        overrides.computedAt === undefined
          ? "2026-08-29T12:00:00.000Z"
          : overrides.computedAt,
      engineVersion: "v3-ad-current",
      fallbackReason: overrides.fallbackReason ?? null,
      generation:
        overrides.generation === undefined
          ? {
              jobRunId: "job_1",
              providerAccountRefId: "account_ref_1",
              manifestHash: "a".repeat(64),
              expectedAdCount: 12,
            }
          : overrides.generation,
    },
    queue: {
      deduplicationGrain: "ad",
      sourcePreCapCount: 0,
      queuedPreCapCount: 0,
      sections: {} as MetaDecisionsWorkspaceReadModel["queue"]["sections"],
      omittedFromQueue: { count: 0, reasons: [] },
    },
    capabilities: {} as MetaDecisionsWorkspaceReadModel["capabilities"],
  };
}

describe("Meta decision pipeline health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getDbWithTimeout.mockReturnValue({ query: dbMock.query });
    dbMock.query.mockResolvedValue([
      {
        latest_job_status: "succeeded",
        latest_job_at: "2026-08-29T16:00:00.000Z",
        latest_run_status: "succeeded",
        latest_run_at: "2026-08-29T16:01:00.000Z",
        latest_success_at: "2026-08-29T16:01:00.000Z",
        latest_finalized_date: "2026-08-28",
        account_timezone: "Europe/Istanbul",
      },
    ]);
    fenceMock.evaluateDbGrowthFence.mockResolvedValue(admittedFence());
  });

  it("reports a healthy operational path only when durable activity, finalized truth and admission are current", async () => {
    const result = await readMetaDecisionPipelineOperationalHealth({
      businessId: "biz_1",
      providerAccountId: "act_1",
      now: NOW,
    });

    expect(result.overall).toBe("healthy");
    expect(result.executionReady).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.syncActivity).toMatchObject({
      status: "fresh",
      latestAt: "2026-08-29T16:01:00.000Z",
    });
    expect(result.warehouse).toMatchObject({
      status: "fresh",
      latestFinalizedDate: "2026-08-28",
      expectedFinalizedDate: "2026-08-28",
    });
    expect(dbMock.query.mock.calls[0]?.[1]).toEqual(["biz_1", "act_1"]);
  });

  it("calls a live growth-fence refusal blocked instead of inferring that cron stopped", async () => {
    fenceMock.evaluateDbGrowthFence.mockResolvedValue(
      admittedFence({
        allowed: false,
        reason: "table_budget_exceeded",
        offender: {
          table: "meta_entity_state_history",
          bytes: 5_368_750_080,
          budget: 5_368_709_120,
        },
      }),
    );

    const result = await readMetaDecisionPipelineOperationalHealth({
      businessId: "biz_1",
      providerAccountId: "act_1",
      now: NOW,
    });

    expect(result.overall).toBe("blocked");
    expect(result.executionReady).toBe(false);
    expect(result.blockers).toContain("sync_admission_blocked");
    expect(result.syncActivity.status).toBe("blocked");
    expect(result.admission.offender).toEqual({
      table: "meta_entity_state_history",
      bytes: 5_368_750_080,
      budget: 5_368_709_120,
      overByBytes: 40_960,
    });
  });

  it("keeps sync activity and warehouse cutoff as separate stale dimensions", async () => {
    dbMock.query.mockResolvedValue([
      {
        latest_job_status: "succeeded",
        latest_job_at: "2026-08-22T14:00:00.000Z",
        latest_run_status: "succeeded",
        latest_run_at: "2026-08-22T14:00:00.000Z",
        latest_success_at: "2026-08-22T14:00:00.000Z",
        latest_finalized_date: "2026-08-21",
        account_timezone: "Europe/Istanbul",
      },
    ]);

    const result = await readMetaDecisionPipelineOperationalHealth({
      businessId: "biz_1",
      providerAccountId: "act_1",
      now: NOW,
    });

    expect(result.overall).toBe("degraded");
    expect(result.blockers).toEqual([
      "sync_activity_stale",
      "warehouse_cutoff_stale",
    ]);
    expect(result.syncActivity.status).toBe("stale");
    expect(result.warehouse).toMatchObject({ status: "stale", lagDays: 7 });
  });

  it("joins current exact-generation and manifest truth before declaring execution ready", async () => {
    const operational = await readMetaDecisionPipelineOperationalHealth({
      businessId: "biz_1",
      providerAccountId: "act_1",
      now: NOW,
    });
    const result = buildMetaDecisionPipelineHealth({
      operational,
      decisionReadModel: readModel(),
      now: NOW,
    });

    expect(result.overall).toBe("healthy");
    expect(result.executionReady).toBe(true);
    expect(result.decisionGeneration.status).toBe("fresh");
    expect(result.manifest.status).toBe("fresh");
  });

  it("withholds readiness for a stale generation and legacy/incomplete manifest", async () => {
    const operational = await readMetaDecisionPipelineOperationalHealth({
      businessId: "biz_1",
      providerAccountId: "act_1",
      now: NOW,
    });
    const result = buildMetaDecisionPipelineHealth({
      operational,
      decisionReadModel: readModel({
        authority: "legacy_creative",
        computedAt: "2026-08-22T14:00:00.000Z",
        generation: null,
        fallbackReason: "native_account_manifest_incomplete",
      }),
      now: NOW,
    });

    expect(result.overall).toBe("degraded");
    expect(result.executionReady).toBe(false);
    expect(result.blockers).toEqual([
      "decision_generation_stale",
      "decision_manifest_invalid",
    ]);
    expect(result.decisionGeneration.status).toBe("stale");
    expect(result.manifest).toMatchObject({
      status: "invalid",
      reason: "native_account_manifest_incomplete",
    });
  });
});
