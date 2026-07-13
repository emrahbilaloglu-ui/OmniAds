import { describe, expect, it, vi } from "vitest";
import { creativeAutomationReadiness } from "../automation-readiness";
import {
  buildCreativeRollbackPlan,
  createCreativeActionIdempotencyKey,
  createDecisionOriginAdActionIdempotencyKey,
  createCreativePostActionMonitorPlan,
  evaluateDecisionOriginAdExecutionPreflight,
  evaluateCreativeExecutionReadiness,
  evaluateCreativeMutationPreflight,
  runDecisionOriginAdExecutionPreflight,
  validateDecisionOriginProviderVerification,
} from "../execution-safety";
import type {
  DecisionOriginAdExecutionEvidence,
  DecisionOriginAdExecutionRequest,
} from "../execution-safety";
import { NATIVE_AD_ENGINE_VERSION, type DecisionOutput } from "../types";

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
        hardActionKnownSampleSize: 200,
        hardConfidenceBuckets: [],
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
        hardActionKnownSampleSize: 200,
        hardConfidenceBuckets: [],
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

const NATIVE_DECISION_HASH = "b".repeat(64);

function nativeRequest(
  overrides: Partial<DecisionOriginAdExecutionRequest> = {},
): DecisionOriginAdExecutionRequest {
  const base = {
    contractVersion: "meta-decision-origin-ad-execution.v1" as const,
    businessId: "biz-1",
    providerAccountId: "act-1",
    adId: "ad-1",
    snapshotId: "snapshot-1",
    evaluationId: "evaluation-1",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    decisionHash: NATIVE_DECISION_HASH,
    action: "pause",
    idempotencyKey: "decision-action-1",
    creativeId: "shared-creative",
  };
  return { ...base, ...overrides };
}

function nativeEvidence(
  overrides: {
    currentAd?: Partial<DecisionOriginAdExecutionEvidence["currentAd"]>;
    sourceDecision?: Partial<
      DecisionOriginAdExecutionEvidence["sourceDecision"]
    >;
    receipt?: DecisionOriginAdExecutionEvidence["idempotencyReceipt"];
    killSwitch?: Partial<DecisionOriginAdExecutionEvidence["killSwitch"]>;
  } = {},
): DecisionOriginAdExecutionEvidence {
  return {
    killSwitch: {
      verified: true,
      engaged: false,
      ...overrides.killSwitch,
    },
    currentAccount: {
      found: true,
      businessId: "biz-1",
      providerAccountId: "act-1",
      writable: true,
    },
    currentAd: {
      found: true,
      businessId: "biz-1",
      providerAccountId: "act-1",
      adId: "ad-1",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: "APPROVED",
      observedAt: "2026-07-12T09:59:00.000Z",
      ...overrides.currentAd,
    },
    sourceDecision: {
      found: true,
      businessId: "biz-1",
      providerAccountId: "act-1",
      decisionEntityType: "ad",
      decisionEntityId: "ad-1",
      adId: "ad-1",
      creativeId: "shared-creative",
      snapshotId: "snapshot-1",
      evaluationId: "evaluation-1",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      decisionHash: NATIVE_DECISION_HASH,
      decisionLabel: "cut",
      blockedActionType: null,
      explicitAuthorizedAction: "pause",
      computedAt: "2026-07-12T09:30:00.000Z",
      ...overrides.sourceDecision,
    },
    idempotencyReceipt: overrides.receipt ?? null,
  };
}

describe("exact native-ad decision execution", () => {
  it("builds idempotency from exact account, ad, source, epoch, hash, and action", () => {
    const first = createDecisionOriginAdActionIdempotencyKey(nativeRequest());
    const sameCreativeOtherAd = createDecisionOriginAdActionIdempotencyKey(
      nativeRequest({ adId: "ad-2" }),
    );
    const changedHash = createDecisionOriginAdActionIdempotencyKey(
      nativeRequest({ decisionHash: "c".repeat(64) }),
    );

    expect(first).toContain("decision-ad-action:biz-1:act-1:ad-1:pause");
    expect(first).not.toBe(sameCreativeOtherAd);
    expect(first).not.toBe(changedHash);
  });

  it("passes only with exact current state and source lineage", () => {
    const result = evaluateDecisionOriginAdExecutionPreflight({
      request: nativeRequest(),
      evidence: nativeEvidence(),
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      disposition: "proceed",
      shouldMutate: true,
      blockers: [],
      decisionAgeHours: 0.5,
      currentAdStateAgeMinutes: 1,
    });
  });

  it("same creative on two ads cannot authorize the other ad", () => {
    const result = evaluateDecisionOriginAdExecutionPreflight({
      request: nativeRequest({ adId: "ad-1", creativeId: "shared-creative" }),
      evidence: nativeEvidence({
        currentAd: { adId: "ad-2" },
        sourceDecision: {
          decisionEntityId: "ad-2",
          adId: "ad-2",
          creativeId: "shared-creative",
        },
      }),
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result.disposition).toBe("reject");
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "ad_identity_mismatch",
        "source_decision_lineage_mismatch",
      ]),
    );
    expect(result.shouldMutate).toBe(false);
  });

  it("rejects same-account wrong-ad evidence instead of falling back", () => {
    const result = evaluateDecisionOriginAdExecutionPreflight({
      request: nativeRequest(),
      evidence: nativeEvidence({ currentAd: { adId: "alternate-ad" } }),
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result.blockers).toContain("ad_identity_mismatch");
    expect(result.shouldMutate).toBe(false);
  });

  it("rejects missing snapshot/evaluation before any evidence read", async () => {
    const rereadEvidence = vi.fn(async () => nativeEvidence());

    const result = await runDecisionOriginAdExecutionPreflight({
      request: nativeRequest({ snapshotId: "", evaluationId: "" }),
      rereadEvidence,
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result.blockers).toEqual([
      "missing_snapshot_id",
      "missing_evaluation_id",
    ]);
    expect(result.shouldMutate).toBe(false);
    expect(rereadEvidence).not.toHaveBeenCalled();
  });

  it("rejects source hash drift and stale decisions", () => {
    const result = evaluateDecisionOriginAdExecutionPreflight({
      request: nativeRequest(),
      evidence: nativeEvidence({
        sourceDecision: {
          decisionHash: "d".repeat(64),
          computedAt: "2026-07-10T00:00:00.000Z",
        },
      }),
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result.blockers).toEqual(
      expect.arrayContaining(["decision_hash_mismatch", "decision_stale"]),
    );
    expect(result.shouldMutate).toBe(false);
  });

  it("rejects a matching source from a different engine epoch", () => {
    const request = nativeRequest({ engineVersion: "v3-ad-old-epoch" });
    const result = evaluateDecisionOriginAdExecutionPreflight({
      request,
      evidence: nativeEvidence({
        sourceDecision: { engineVersion: "v3-ad-old-epoch" },
      }),
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result.blockers).toContain("engine_version_drift");
    expect(result.shouldMutate).toBe(false);
  });

  it("rejects budget/promote labels at ad execution grain", async () => {
    const rereadEvidence = vi.fn(async () => nativeEvidence());
    const result = await runDecisionOriginAdExecutionPreflight({
      request: nativeRequest({ action: "scale_budget" }),
      rereadEvidence,
    });

    expect(result.blockers).toEqual(["unsupported_action"]);
    expect(rereadEvidence).not.toHaveBeenCalled();
  });

  it("requires an explicit source authorization for resume", () => {
    const request = nativeRequest({ action: "resume" });
    const result = evaluateDecisionOriginAdExecutionPreflight({
      request,
      evidence: nativeEvidence({
        currentAd: {
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
        },
        sourceDecision: { explicitAuthorizedAction: null },
      }),
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result.blockers).toContain("action_not_authorized");
  });

  it("fails closed on kill-switch, policy, and status evidence", () => {
    const result = evaluateDecisionOriginAdExecutionPreflight({
      request: nativeRequest(),
      evidence: nativeEvidence({
        killSwitch: { engaged: true },
        currentAd: {
          policyEligible: null,
          configuredStatus: "UNKNOWN",
          effectiveStatus: null,
        },
      }),
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "kill_switch_engaged",
        "policy_state_unverified",
        "ad_status_incompatible",
      ]),
    );
  });

  it("treats an exact duplicate receipt as inert", () => {
    const request = nativeRequest();
    const result = evaluateDecisionOriginAdExecutionPreflight({
      request,
      evidence: nativeEvidence({
        receipt: {
          actionLogId: "log-1",
          businessId: request.businessId,
          providerAccountId: request.providerAccountId,
          adId: request.adId,
          snapshotId: request.snapshotId,
          evaluationId: request.evaluationId,
          engineVersion: request.engineVersion,
          decisionHash: request.decisionHash,
          action: request.action,
          idempotencyKey: request.idempotencyKey,
          status: "success",
          dryRun: false,
          providerVerified: true,
          treatmentEligible: true,
        },
      }),
      now: new Date("2026-07-12T10:00:00.000Z"),
    });

    expect(result).toMatchObject({
      ok: true,
      disposition: "duplicate",
      shouldMutate: false,
      duplicateReceipt: { actionLogId: "log-1" },
    });
  });

  it("rejects an idempotency key reused for another ad", () => {
    const request = nativeRequest();
    const result = evaluateDecisionOriginAdExecutionPreflight({
      request,
      evidence: nativeEvidence({
        receipt: {
          actionLogId: "log-1",
          businessId: request.businessId,
          providerAccountId: request.providerAccountId,
          adId: "ad-2",
          snapshotId: request.snapshotId,
          evaluationId: request.evaluationId,
          engineVersion: request.engineVersion,
          decisionHash: request.decisionHash,
          action: request.action,
          idempotencyKey: request.idempotencyKey,
          status: "success",
          dryRun: false,
          providerVerified: true,
          treatmentEligible: true,
        },
      }),
    });

    expect(result.blockers).toEqual(["idempotency_conflict"]);
    expect(result.shouldMutate).toBe(false);
  });

  it("counts provider verification only for the exact ad/action and never for dry-run", () => {
    const exact = validateDecisionOriginProviderVerification({
      request: nativeRequest(),
      verifiedAt: "2026-07-12T10:00:01.000Z",
      verificationPayload: {
        id: "ad-1",
        status: "PAUSED",
        effective_status: "PAUSED",
      },
    });
    const wrongAd = validateDecisionOriginProviderVerification({
      request: nativeRequest(),
      verifiedAt: "2026-07-12T10:00:01.000Z",
      verificationPayload: { id: "ad-2", status: "PAUSED" },
    });
    const dryRun = validateDecisionOriginProviderVerification({
      request: nativeRequest({ dryRun: true }),
      verifiedAt: "2026-07-12T10:00:01.000Z",
      verificationPayload: { id: "ad-1", status: "PAUSED" },
    });

    expect(exact).toMatchObject({
      providerVerified: true,
      treatmentEligible: true,
      blockers: [],
    });
    expect(wrongAd.providerVerified).toBe(false);
    expect(wrongAd.blockers).toContain("verification_ad_mismatch");
    expect(dryRun).toMatchObject({
      providerVerified: false,
      treatmentEligible: false,
    });
  });
});
