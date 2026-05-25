import { describe, expect, it } from "vitest";
import { creativeAutomationReadiness } from "../automation-readiness";
import {
  buildCreativeRollbackPlan,
  createCreativeActionIdempotencyKey,
  createCreativePostActionMonitorPlan,
  evaluateCreativeExecutionReadiness,
  evaluateCreativeMutationPreflight,
} from "../execution-safety";
import type { DecisionOutput } from "../types";

function decision(overrides: Partial<DecisionOutput> = {}): DecisionOutput {
  return {
    creativeId: "creative-1",
    creativeName: "Creative 1",
    label: "cut",
    reason: "Clear loser.",
    confidence: 82,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 0.4,
    badges: [],
    metrics: {
      spend: 500,
      purchases: 1,
      roas: 0.8,
      recent7dRoas: 0.7,
    },
    campaignLabelStatus: "labeled",
    campaignKind: "main",
    blockedActionType: null,
    engineVersion: "v3-test",
    generatedAt: "2026-05-24T06:00:00.000Z",
    ...overrides,
  };
}

describe("creative execution safety", () => {
  it("builds stable idempotency keys and changes them across actions", () => {
    const first = createCreativeActionIdempotencyKey({
      businessId: "biz 1",
      creativeId: "creative-1",
      action: "cut",
      asOfDate: "2026-05-24T00:00:00.000Z",
      engineVersion: "v3-test",
    });
    const second = createCreativeActionIdempotencyKey({
      businessId: "biz 1",
      creativeId: "creative-1",
      action: "cut",
      asOfDate: "2026-05-24",
      engineVersion: "v3-test",
    });
    const changed = createCreativeActionIdempotencyKey({
      businessId: "biz 1",
      creativeId: "creative-1",
      action: "scale",
      asOfDate: "2026-05-24",
      engineVersion: "v3-test",
    });

    expect(first).toBe(second);
    expect(first).not.toBe(changed);
    expect(first).toBe("creative-action:biz_1:creative-1:cut:2026-05-24:v3-test");
  });

  it("can scope scale idempotency to the shared budget owner", () => {
    const first = createCreativeActionIdempotencyKey({
      businessId: "biz-1",
      creativeId: "creative-1",
      targetEntityId: "adset-1",
      action: "scale",
      asOfDate: "2026-05-24",
      engineVersion: "v3-test",
    });
    const second = createCreativeActionIdempotencyKey({
      businessId: "biz-1",
      creativeId: "creative-2",
      targetEntityId: "adset-1",
      action: "scale",
      asOfDate: "2026-05-24",
      engineVersion: "v3-test",
    });

    expect(first).toBe(second);
    expect(first).toBe("creative-action:biz-1:adset-1:scale:2026-05-24:v3-test");
  });

  it("passes preflight only when the current decision still matches the scheduled decision", () => {
    const scheduled = decision();
    const current = decision({ confidence: 79 });
    const preflight = evaluateCreativeMutationPreflight({
      scheduledDecision: scheduled,
      currentDecision: current,
      now: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(preflight.ok).toBe(true);
    expect(preflight.blockers).toEqual([]);
    expect(preflight.currentDecisionAgeHours).toBe(6);
    expect(preflight.currentDecisionAgeStatus).toBe("fresh");
  });

  it("blocks execution preflight when label, confidence, or freshness drift", () => {
    const scheduled = decision();
    const current = decision({
      label: "keep",
      confidence: 65,
      generatedAt: "2026-05-22T00:00:00.000Z",
    });

    const preflight = evaluateCreativeMutationPreflight({
      scheduledDecision: scheduled,
      currentDecision: current,
      now: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(preflight.ok).toBe(false);
    expect(preflight.blockers).toEqual(
      expect.arrayContaining([
        "label_drift",
        "confidence_regressed",
        "decision_stale",
      ]),
    );
    expect(preflight.drift).toEqual(
      expect.arrayContaining(["label", "confidence", "generated_at"]),
    );
    expect(preflight.currentDecisionAgeStatus).toBe("stale");
  });

  it("blocks preflight when decision basis or material performance context drift", () => {
    const scheduled = decision({
      decisionKindSource: "kind_main",
      labelTransform: "test_cohort_refresh_to_cut",
      metrics: {
        spend: 500,
        purchases: 1,
        roas: 0.8,
        recent7dRoas: 0.7,
      },
    });
    const current = decision({
      engineVersion: "v3-next",
      truthSource: "account_baseline_thin",
      effectiveTargetRoas: 2.3,
      ratioToTarget: 0.65,
      decisionKindSource: "all_fallback",
      labelTransform: null,
      metrics: {
        spend: 500,
        purchases: 1,
        roas: 0.8,
        recent7dRoas: 1.4,
      },
    });

    const preflight = evaluateCreativeMutationPreflight({
      scheduledDecision: scheduled,
      currentDecision: current,
      now: new Date("2026-05-24T12:00:00.000Z"),
    });

    expect(preflight.ok).toBe(false);
    expect(preflight.blockers).toEqual(
      expect.arrayContaining([
        "engine_version_drift",
        "truth_source_drift",
        "target_roas_drift",
        "ratio_to_target_drift",
        "recent_hold_drift",
        "decision_kind_source_drift",
        "label_transform_drift",
      ]),
    );
    expect(preflight.drift).toEqual(
      expect.arrayContaining([
        "engine_version",
        "truth_source",
        "effective_target_roas",
        "ratio_to_target",
        "recent_hold",
        "decision_kind_source",
        "label_transform",
      ]),
    );
  });

  it("requires enough prior state to build a rollback plan", () => {
    const blocked = buildCreativeRollbackPlan({
      action: "scale",
      beforeState: { effectiveStatus: "ACTIVE" },
    });
    const safe = buildCreativeRollbackPlan({
      action: "scale",
      beforeState: {
        effectiveStatus: "ACTIVE",
        budgetOwnerId: "adset-1",
        budgetAmount: 100,
      },
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.blockers).toContain("missing_prior_budget");
    expect(safe.ok).toBe(true);
    expect(safe.restoreSteps).toEqual([
      "restore_effective_status:ACTIVE",
      "restore_budget:adset-1:100",
    ]);
  });

  it("requires and emits created entity cleanup for refresh rollback", () => {
    const blocked = buildCreativeRollbackPlan({
      action: "refresh",
      beforeState: { effectiveStatus: "ACTIVE", createdEntityIds: [] },
    });
    const safe = buildCreativeRollbackPlan({
      action: "refresh",
      beforeState: {
        effectiveStatus: "ACTIVE",
        createdEntityIds: ["ad-2", "creative-2"],
      },
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.blockers).toContain("missing_created_entity_snapshot");
    expect(safe.ok).toBe(true);
    expect(safe.restoreSteps).toEqual([
      "restore_effective_status:ACTIVE",
      "delete_created_entities:ad-2,creative-2",
    ]);
  });

  it("creates a monitor plan with 7d and 14d realized-outcome windows", () => {
    const plan = createCreativePostActionMonitorPlan({
      businessId: "biz-1",
      creativeId: "creative-1",
      action: "cut",
      actionIdempotencyKey: "key-1",
      startDate: "2026-05-24",
    });

    expect(plan.outcomeWindowsDays).toEqual([1, 3, 7, 14]);
    expect(plan.metricChecks).toEqual(
      expect.arrayContaining(["spend_leak_after_cut"]),
    );
  });

  it("keeps creative execution blocked while the base readiness tier is read-only", () => {
    const scheduled = decision();
    const preflight = evaluateCreativeMutationPreflight({
      scheduledDecision: scheduled,
      currentDecision: scheduled,
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const rollbackPlan = buildCreativeRollbackPlan({
      action: "cut",
      beforeState: { effectiveStatus: "ACTIVE" },
    });
    const key = createCreativeActionIdempotencyKey({
      businessId: "biz-1",
      creativeId: scheduled.creativeId,
      action: "cut",
      asOfDate: "2026-05-24",
      engineVersion: scheduled.engineVersion,
    });
    const monitorPlan = createCreativePostActionMonitorPlan({
      businessId: "biz-1",
      creativeId: scheduled.creativeId,
      action: "cut",
      actionIdempotencyKey: key,
      startDate: "2026-05-24",
    });
    const readiness = creativeAutomationReadiness({
      decision: scheduled,
      executorAvailable: true,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
      postActionMonitorAvailable: true,
      holdoutPlanAvailable: true,
      operatorEnablementRecorded: true,
      backtestSummary: {
        hardActionPrecision: 0.91,
        hardActionRecall: 0.86,
        expectedCalibrationError: 0.04,
        criticalFalsePositiveRate: 0,
        highSeverityMissedOpportunityRate: 0.04,
        activeDecisionCoverage: 0.96,
        dataFreshnessPass: true,
        persistedCoveragePass: true,
        conflictFreePass: true,
        sampleSize: 200,
      },
    });

    const execution = evaluateCreativeExecutionReadiness({
      readiness,
      preflight,
      rollbackPlan,
      postActionMonitorPlan: monitorPlan,
      idempotencyKey: key,
      expectedIdempotencyKey: key,
    });

    expect(readiness.blockers).toEqual([]);
    expect(readiness.autoExecuteEligible).toBe(false);
    expect(execution.ok).toBe(false);
    expect(execution.blockers).toEqual(["base_readiness_not_auto_eligible"]);
  });

  it("blocks execution when the supplied idempotency key does not match the expected key", () => {
    const scheduled = decision();
    const preflight = evaluateCreativeMutationPreflight({
      scheduledDecision: scheduled,
      currentDecision: scheduled,
      now: new Date("2026-05-24T12:00:00.000Z"),
    });
    const rollbackPlan = buildCreativeRollbackPlan({
      action: "cut",
      beforeState: { effectiveStatus: "ACTIVE" },
    });
    const monitorPlan = createCreativePostActionMonitorPlan({
      businessId: "biz-1",
      creativeId: scheduled.creativeId,
      action: "cut",
      actionIdempotencyKey: "expected-key",
      startDate: "2026-05-24",
    });
    const readiness = creativeAutomationReadiness({
      decision: scheduled,
      livePreflightAvailable: true,
      rollbackPlanAvailable: true,
      postActionMonitorAvailable: true,
      backtestSummary: {
        hardActionPrecision: 0.91,
        hardActionRecall: 0.86,
        expectedCalibrationError: 0.04,
        criticalFalsePositiveRate: 0,
        highSeverityMissedOpportunityRate: 0.04,
        activeDecisionCoverage: 0.96,
        dataFreshnessPass: true,
        persistedCoveragePass: true,
        conflictFreePass: true,
        sampleSize: 200,
      },
    });

    const execution = evaluateCreativeExecutionReadiness({
      readiness,
      preflight,
      rollbackPlan,
      postActionMonitorPlan: monitorPlan,
      idempotencyKey: "wrong-key",
      expectedIdempotencyKey: "expected-key",
    });

    expect(execution.ok).toBe(false);
    expect(execution.blockers).toEqual(
      expect.arrayContaining([
        "idempotency_key_mismatch",
        "base_readiness_not_auto_eligible",
      ]),
    );
  });
});
