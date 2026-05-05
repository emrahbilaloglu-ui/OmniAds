import { describe, expect, it, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CommandCenterAction, CommandCenterPermissions } from "@/lib/command-center";
import { buildOperatorDecisionMetadata } from "@/lib/operator-decision-metadata";
import { buildOperatorDecisionProvenance } from "@/lib/operator-decision-provenance";
import type { OperatorPolicyAssessment } from "@/src/types/operator-decision";

vi.mock("@/lib/command-center-store", () => ({
  getCommandCenterMutationReceipt: vi.fn(),
  listCommandCenterJournal: vi.fn(),
  syncCommandCenterActionWorkflowStatus: vi.fn(),
  writeCommandCenterMutationReceipt: vi.fn(),
}));

vi.mock("@/lib/command-center-execution-store", () => ({
  appendCommandCenterExecutionAudit: vi.fn(),
  getCommandCenterExecutionState: vi.fn(),
  listCommandCenterExecutionAudit: vi.fn(),
  upsertCommandCenterExecutionState: vi.fn(),
}));

vi.mock("@/lib/command-center-execution-config", () => ({
  getMetaExecutionApplyBoundaryState: vi.fn(),
  isCommandCenterExecutionV1Enabled: vi.fn(),
}));

vi.mock("@/lib/meta/decision-os-source", () => ({
  getMetaDecisionOsForRange: vi.fn(),
}));

vi.mock("@/lib/meta/execution", () => ({
  getMetaAdSetExecutionState: vi.fn(),
  mutateMetaAdSetExecution: vi.fn(),
}));

const commandCenterStore = await import("@/lib/command-center-store");
const executionStore = await import("@/lib/command-center-execution-store");
const executionConfig = await import("@/lib/command-center-execution-config");
const decisionSource = await import("@/lib/meta/decision-os-source");
const metaExecution = await import("@/lib/meta/execution");
const executionService = await import("@/lib/command-center-execution-service");

const permissions: CommandCenterPermissions = {
  canEdit: true,
  reason: null,
  role: "collaborator",
};

function buildActionProvenance() {
  const metadata = buildOperatorDecisionMetadata({
    analyticsStartDate: "2026-04-01",
    analyticsEndDate: "2026-04-10",
    decisionAsOf: "2026-04-10",
  });
  return {
    ...buildOperatorDecisionProvenance({
      businessId: "biz",
      decisionAsOf: "2026-04-10",
      analyticsWindow: metadata.analyticsWindow,
      sourceWindow: metadata.decisionWindows.primary30d,
      sourceRowScope: {
        system: "meta",
        entityType: "adset",
        entityId: "adset_1",
      },
      sourceDecisionId: "decision_1",
      recommendedAction: "scale_budget",
      evidence: ["ROAS is beating target."],
    }),
    actionFingerprint: "cc_meta_1",
  };
}

function buildActionFixture(
  overrides: Partial<CommandCenterAction> = {},
): CommandCenterAction {
  return {
    actionFingerprint: "cc_meta_1",
    provenance: buildActionProvenance(),
    sourceSystem: "meta",
    sourceType: "meta_adset_decision",
    surfaceLane: "action_core",
    queueSection: "default_queue",
    workloadClass: "scale_promotion",
    truthState: "live_confident",
    operatorDisposition: "standard",
    trustReasons: ["ROAS is beating target."],
    title: "Prospecting Wide US",
    recommendedAction: "scale_budget",
    confidence: 0.9,
    priority: "high",
    summary: "ROAS is beating target.",
    decisionSignals: ["ROAS is beating target."],
    evidence: [],
    guardrails: ["Scale in controlled steps."],
    relatedEntities: [
      {
        type: "campaign",
        id: "cmp_1",
        label: "Spring Promo",
      },
      {
        type: "adset",
        id: "adset_1",
        label: "Prospecting Wide US",
      },
    ],
    tags: ["scale_promotions"],
    watchlistOnly: false,
    batchReviewClass: null,
    batchReviewEligible: false,
    calibrationHint: null,
    status: "approved",
    assigneeUserId: null,
    assigneeName: null,
    snoozeUntil: null,
    latestNoteExcerpt: null,
    noteCount: 0,
    lastMutatedAt: null,
    lastMutationId: null,
    createdAt: "2026-04-11T00:00:00.000Z",
    sourceContext: {
      sourceLabel: "Meta Decision OS",
      operatingMode: "Exploit",
      sourceDeepLink: "/platforms/meta",
      sourceDecisionId: "decision_1",
    },
    throughput: {
      priorityScore: 88,
      actionable: true,
      defaultQueueEligible: true,
      selectedInDefaultQueue: true,
      ageHours: 12,
      ageLabel: "12h old",
      ageAnchorAt: "2026-04-10T12:00:00.000Z",
      slaTargetHours: 24,
      slaStatus: "on_track",
    },
    ...overrides,
  };
}

function blockedOperatorPolicy(): OperatorPolicyAssessment {
  return {
    contractVersion: "operator-policy.v1",
    state: "blocked",
    actionClass: "scale",
    pushReadiness: "blocked_from_push",
    queueEligible: false,
    canApply: false,
    reasons: ["Policy blocks this action."],
    blockers: ["Budget is not the binding constraint."],
    missingEvidence: ["budget_binding_evidence"],
    requiredEvidence: ["budget_binding_evidence"],
    explanation: "Budget is not the binding constraint.",
  };
}

function eligibleOperatorPolicy(): OperatorPolicyAssessment {
  return {
    contractVersion: "operator-policy.v1",
    state: "do_now",
    actionClass: "scale",
    pushReadiness: "eligible_for_push_when_enabled",
    queueEligible: true,
    canApply: true,
    reasons: ["Policy allows this action."],
    blockers: [],
    missingEvidence: [],
    requiredEvidence: ["row_provenance", "commercial_truth"],
    explanation: "Deterministic Meta policy allows this action.",
  };
}

function buildMetaDecisionResponse() {
  const metadata = buildOperatorDecisionMetadata({
    analyticsStartDate: "2026-04-01",
    analyticsEndDate: "2026-04-10",
    decisionAsOf: "2026-04-10",
  });
  return {
    contractVersion: "meta-decision-os.v1",
    generatedAt: "2026-04-11T00:00:00.000Z",
    businessId: "biz",
    startDate: "2026-04-01",
    endDate: "2026-04-10",
    analyticsWindow: metadata.analyticsWindow,
    decisionWindows: metadata.decisionWindows,
    historicalMemory: metadata.historicalMemory,
    decisionAsOf: metadata.decisionAsOf,
    summary: {
      todayPlanHeadline: "Today plan",
      todayPlan: [],
      budgetShiftSummary: "0",
      noTouchSummary: "0",
      winnerScaleSummary: {
        candidateCount: 1,
        protectedCount: 0,
        headline: "1 active winner scale candidate is ready for controlled growth.",
      },
      operatingMode: {
        currentMode: "Exploit",
        recommendedMode: "Exploit",
        confidence: 0.88,
      },
      confidence: 0.88,
      surfaceSummary: {
        actionCoreCount: 1,
        watchlistCount: 0,
        archiveCount: 0,
        degradedCount: 0,
      },
    },
    campaigns: [],
    adSets: [
      {
        decisionId: "decision_1",
        adSetId: "adset_1",
        adSetName: "Prospecting Wide US",
        campaignId: "cmp_1",
        campaignName: "Spring Promo",
        actionType: "scale_budget",
        actionSize: "medium",
        priority: "high",
        confidence: 0.91,
        reasons: ["ROAS is beating target."],
        guardrails: ["Scale in controlled steps."],
        relatedCreativeNeeds: [],
        relatedGeoContext: [],
        supportingMetrics: {
          spend: 500,
          revenue: 1700,
          roas: 3.4,
          cpa: 20,
          ctr: 1.8,
          purchases: 24,
          impressions: 12000,
          clicks: 200,
          bidStrategyLabel: "Cost Cap",
          optimizationGoal: "PURCHASE",
          dailyBudget: 100,
          lifetimeBudget: null,
        },
        whatWouldChangeThisDecision: [],
        noTouch: false,
        policy: {
          strategyClass: "scale_budget",
          objectiveFamily: "sales",
          bidRegime: "cost_cap",
          primaryDriver: "roas_outperforming",
          secondaryDrivers: ["signal_density"],
          winnerState: "scale_candidate",
        },
        trust: {
          surfaceLane: "action_core",
          truthState: "live_confident",
          operatorDisposition: "standard",
          reasons: ["ROAS is beating target."],
        },
        operatorPolicy: eligibleOperatorPolicy(),
      },
    ],
    budgetShifts: [],
    geoDecisions: [],
    placementAnomalies: [],
    noTouchList: [],
    winnerScaleCandidates: [
      {
        candidateId: "cmp_1:adset_1",
        campaignId: "cmp_1",
        campaignName: "Spring Promo",
        adSetId: "adset_1",
        adSetName: "Prospecting Wide US",
        confidence: 0.91,
        why: "ROAS is beating target.",
        suggestedMoveBand: "10-15% of current budget load",
        evidence: [],
        guardrails: ["Scale in controlled steps."],
        supportingMetrics: {
          spend: 500,
          revenue: 1700,
          roas: 3.4,
          cpa: 20,
          ctr: 1.8,
          purchases: 24,
          dailyBudget: 100,
          bidStrategyLabel: "Cost Cap",
          optimizationGoal: "PURCHASE",
        },
        policy: {
          strategyClass: "scale_budget",
          objectiveFamily: "sales",
          bidRegime: "cost_cap",
          primaryDriver: "roas_outperforming",
          secondaryDrivers: ["signal_density"],
          winnerState: "scale_candidate",
        },
      },
    ],
    commercialTruthCoverage: {
      mode: "configured_targets",
      targetPackConfigured: true,
      countryEconomicsConfigured: true,
      promoCalendarConfigured: true,
      operatingConstraintsConfigured: true,
      missingInputs: [],
      notes: [],
    },
  };
}

function buildExecutionStateRecord(
  overrides: Partial<
    NonNullable<
      Awaited<ReturnType<typeof executionStore.getCommandCenterExecutionState>>
    >
  > = {},
) {
  return {
    businessId: "biz",
    actionFingerprint: "cc_meta_1",
    executionStatus: "executed",
    supportMode: "supported",
    sourceSystem: "meta",
    sourceType: "meta_adset_decision",
    requestedAction: "scale_budget",
    previewHash: "preview_hash",
    capabilityKey: "meta_adset_decision:scale_budget",
    workflowStatusSnapshot: "executed",
    approvalActorUserId: "user_1",
    approvalActorName: "Operator",
    approvalActorEmail: "operator@adsecute.com",
    approvedAt: "2026-04-11T10:00:00.000Z",
    appliedByUserId: "user_1",
    appliedByName: "Operator",
    appliedByEmail: "operator@adsecute.com",
    appliedAt: "2026-04-11T10:05:00.000Z",
    rollbackKind: "provider_rollback",
    rollbackNote:
      "Rollback restores the captured pre-apply ad set status and daily budget snapshot.",
    lastClientMutationId: "apply_1",
    lastErrorCode: null,
    lastErrorMessage: null,
    currentState: {
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 115,
      lifetimeBudget: null,
      optimizationGoal: "PURCHASE",
      bidStrategyLabel: "Cost Cap",
    },
    requestedState: {
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 115,
      lifetimeBudget: null,
      optimizationGoal: "PURCHASE",
      bidStrategyLabel: "Cost Cap",
    },
    capturedPreApplyState: {
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 100,
      lifetimeBudget: null,
      optimizationGoal: "PURCHASE",
      bidStrategyLabel: "Cost Cap",
    },
    preflight: {
      generatedAt: "2026-04-11T10:04:00.000Z",
      readyForApply: true,
      blockingChecks: [],
      checks: [],
    },
    latestValidation: {
      operation: "apply",
      status: "passed",
      checkedAt: "2026-04-11T10:05:30.000Z",
      matchedRequestedState: true,
      mismatchReasons: [],
    },
    providerDiffEvidence: {
      provider: "meta",
      targetId: "adset_1",
      observedAt: "2026-04-11T10:05:30.000Z",
      baselineState: {
        status: "ACTIVE",
        budgetLevel: "adset",
        dailyBudget: 100,
        lifetimeBudget: null,
        optimizationGoal: "PURCHASE",
        bidStrategyLabel: "Cost Cap",
      },
      requestedState: {
        status: "ACTIVE",
        budgetLevel: "adset",
        dailyBudget: 115,
        lifetimeBudget: null,
        optimizationGoal: "PURCHASE",
        bidStrategyLabel: "Cost Cap",
      },
      observedState: {
        status: "ACTIVE",
        budgetLevel: "adset",
        dailyBudget: 115,
        lifetimeBudget: null,
        optimizationGoal: "PURCHASE",
        bidStrategyLabel: "Cost Cap",
      },
      providerChangeDiff: [],
      remainingDriftDiff: [],
      matchedRequestedState: true,
      mismatchReasons: [],
    },
    providerResponse: {},
    createdAt: "2026-04-11T10:05:00.000Z",
    updatedAt: "2026-04-11T10:05:00.000Z",
    ...overrides,
  } as NonNullable<
    Awaited<ReturnType<typeof executionStore.getCommandCenterExecutionState>>
  >;
}

describe("command center execution service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(executionConfig.isCommandCenterExecutionV1Enabled).mockReturnValue(true);
    vi.mocked(executionConfig.getMetaExecutionApplyBoundaryState).mockReturnValue({
      executionPreviewEnabled: true,
      applyEnabled: true,
      killSwitchActive: false,
      canaryScoped: true,
      businessAllowlisted: true,
      eligible: true,
      blockedReasons: [],
    });
    vi.mocked(commandCenterStore.getCommandCenterMutationReceipt).mockResolvedValue(null);
    vi.mocked(commandCenterStore.writeCommandCenterMutationReceipt).mockResolvedValue(
      undefined,
    );
    vi.mocked(commandCenterStore.listCommandCenterJournal).mockResolvedValue([
      {
        id: "journal_1",
        businessId: "biz",
        actionFingerprint: "cc_meta_1",
        actionTitle: "Prospecting Wide US",
        sourceSystem: "meta",
        sourceType: "meta_adset_decision",
        eventType: "status_changed",
        actorUserId: "user_1",
        actorName: "Operator",
        actorEmail: "operator@adsecute.com",
        message: "Approved Prospecting Wide US.",
        note: null,
        metadata: { mutation: "approve" },
        createdAt: "2026-04-11T10:00:00.000Z",
      },
    ] as never);
    vi.mocked(executionStore.getCommandCenterExecutionState).mockResolvedValue(null);
    vi.mocked(executionStore.listCommandCenterExecutionAudit).mockResolvedValue([]);
    vi.mocked(decisionSource.getMetaDecisionOsForRange).mockResolvedValue(
      buildMetaDecisionResponse() as never,
    );
    vi.mocked(metaExecution.getMetaAdSetExecutionState).mockResolvedValue({
      provider: "meta",
      businessId: "biz",
      adSetId: "adset_1",
      adSetName: "Prospecting Wide US",
      providerAccountId: "act_1",
      providerAccountName: "Account 1",
      currency: "USD",
      campaignId: "cmp_1",
      campaignName: "Spring Promo",
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 100,
      lifetimeBudget: null,
      optimizationGoal: "PURCHASE",
      bidStrategyLabel: "Cost Cap",
      isBudgetMixed: false,
      isConfigMixed: false,
      providerAccessible: true,
      isDemo: false,
    } as never);
  });

  it("builds a supported preview with an exact budget target", async () => {
    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });

    expect(preview.supportMode).toBe("supported");
    expect(preview.status).toBe("ready_for_apply");
    expect(preview.requestedState?.dailyBudget).toBe(115);
    expect(preview.plan?.requestedDailyBudget).toBe(115);
    expect(preview.permission.canApply).toBe(true);
    expect(preview.capability.capabilityKey).toBe(
      "meta_adset_decision:scale_budget",
    );
    expect(preview.preflight.readyForApply).toBe(true);
    expect(preview.supportMatrix.selectedEntry.familyKey).toBe(
      "meta_adset_decision:scale_budget",
    );
    expect(
      preview.supportMatrix.entries.some(
        (entry) =>
          entry.familyKey === "meta_budget_shift:budget_shift" &&
          entry.supportMode === "manual_only",
      ),
    ).toBe(true);
  });

  it("requires recorded approval evidence before apply can become ready", async () => {
    vi.mocked(commandCenterStore.listCommandCenterJournal).mockResolvedValue([]);

    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });

    expect(preview.status).toBe("draft");
    expect(preview.permission.canApply).toBe(false);
    expect(
      preview.preflight.checks.find((check) => check.key === "workflow_approved")
        ?.status,
    ).toBe("fail");
    expect(preview.permission.reason).toContain("no approval event");
  });

  it("binds preview hash to current apply boundary state", async () => {
    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });
    vi.mocked(executionConfig.getMetaExecutionApplyBoundaryState).mockReturnValue({
      executionPreviewEnabled: true,
      applyEnabled: false,
      killSwitchActive: false,
      canaryScoped: true,
      businessAllowlisted: true,
      eligible: false,
      blockedReasons: ["Meta execution apply is disabled."],
    });

    const blockedPreview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });

    expect(blockedPreview.previewHash).not.toBe(preview.previewHash);
    await expect(
      executionService.applyCommandCenterExecution({
        request: new NextRequest("http://localhost/api/command-center/execution/apply", {
          method: "POST",
        }),
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        action: buildActionFixture(),
        permissions,
        actorUserId: "user_1",
        actorName: "Operator",
        actorEmail: "operator@adsecute.com",
        clientMutationId: "apply_1",
        previewHash: preview.previewHash,
      }),
    ).rejects.toThrow("Execution preview is stale");
  });

  it("keeps rows without provenance out of the push path", async () => {
    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture({ provenance: null }),
      permissions,
    });

    expect(preview.supportMode).toBe("manual_only");
    expect(preview.permission.canApply).toBe(false);
    expect(preview.permission.reason).toContain("provenance");
  });

  it("keeps malformed provenance out of the provider apply path", async () => {
    const action = buildActionFixture({
      provenance: {
        ...buildActionProvenance(),
        evidenceHash: "",
      },
    });

    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action,
      permissions,
    });

    expect(preview.supportMode).toBe("manual_only");
    expect(preview.permission.canApply).toBe(false);
    expect(preview.permission.reason).toContain("provenance");
  });

  it("returns only a safe execution audit summary in previews", async () => {
    vi.mocked(executionStore.listCommandCenterExecutionAudit).mockResolvedValue([
      {
        id: "audit_1",
        businessId: "biz_sensitive",
        actionFingerprint: "cc_meta_1",
        operation: "apply",
        executionStatus: "failed",
        supportMode: "supported",
        actorUserId: "user_secret",
        actorName: "Sensitive Operator",
        actorEmail: "operator@example.com",
        approvalActorUserId: "approver_secret",
        approvalActorName: "Approver Name",
        approvalActorEmail: "approver@example.com",
        approvedAt: "2026-04-11T10:00:00.000Z",
        previewHash: "preview_hash",
        capabilityKey: "meta_adset_decision:scale_budget",
        rollbackKind: "provider_rollback",
        rollbackNote: "Rollback restores captured state.",
        currentState: null,
        requestedState: null,
        capturedPreApplyState: null,
        preflight: {
          generatedAt: "2026-04-11T10:00:00.000Z",
          readyForApply: false,
          blockingChecks: ["Live provider state"],
          checks: [],
        },
        validation: {
          operation: "apply",
          status: "failed",
          checkedAt: "2026-04-11T10:01:00.000Z",
          matchedRequestedState: false,
          mismatchReasons: ["Sensitive account act_123 did not match."],
        },
        providerDiffEvidence: null,
        providerResponse: { body: { access_token: "secret_token" } },
        failureReason: "Provider failed for operator@example.com and act_123.",
        externalRefs: {
          provider: "meta",
          providerAccountId: "act_123",
          providerAccountName: null,
          campaignId: "cmp_123",
          campaignName: "Sensitive Campaign",
          adSetId: "adset_123",
          adSetName: "Sensitive Ad Set",
        },
        createdAt: "2026-04-11T10:01:00.000Z",
      },
    ] as never);

    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });

    expect(preview.auditTrail[0]).toMatchObject({
      id: "audit_1",
      approvalStatus: "approved",
      validationStatus: "failed",
      blockedReason:
        "Execution failed; inspect privileged provider logs if deeper detail is required.",
    });
    const serialized = JSON.stringify(preview.auditTrail);
    expect(serialized).not.toContain("operator@example.com");
    expect(serialized).not.toContain("secret_token");
    expect(serialized).not.toContain("act_123");
    expect(serialized).not.toContain("Sensitive Campaign");
  });

  it("keeps operator-policy-blocked rows out of provider apply", async () => {
    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture({ operatorPolicy: blockedOperatorPolicy() }),
      permissions,
    });

    expect(preview.supportMode).toBe("manual_only");
    expect(preview.permission.canApply).toBe(false);
    expect(preview.permission.reason).toContain("Budget is not the binding constraint");
  });

  it("rechecks the resolved source decision operator policy before provider apply", async () => {
    const response = buildMetaDecisionResponse() as any;
    response.adSets[0].operatorPolicy = blockedOperatorPolicy();
    vi.mocked(decisionSource.getMetaDecisionOsForRange).mockResolvedValueOnce(
      response as never,
    );

    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });

    expect(preview.supportMode).toBe("manual_only");
    expect(preview.permission.canApply).toBe(false);
    expect(preview.permission.reason).toContain("Budget is not the binding constraint");
  });

  it("degrades to manual-only for campaign-owned budgets", async () => {
    vi.mocked(metaExecution.getMetaAdSetExecutionState).mockResolvedValue({
      provider: "meta",
      businessId: "biz",
      adSetId: "adset_1",
      adSetName: "Prospecting Wide US",
      providerAccountId: "act_1",
      providerAccountName: "Account 1",
      currency: "USD",
      campaignId: "cmp_1",
      campaignName: "Spring Promo",
      status: "ACTIVE",
      budgetLevel: "campaign",
      dailyBudget: 100,
      lifetimeBudget: null,
      optimizationGoal: "PURCHASE",
      bidStrategyLabel: "Cost Cap",
      isBudgetMixed: false,
      isConfigMixed: false,
      providerAccessible: true,
      isDemo: false,
    } as never);

    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });

    expect(preview.supportMode).toBe("manual_only");
    expect(preview.status).toBe("manual_only");
    expect(preview.permission.canApply).toBe(false);
    expect(preview.supportMatrix.selectedEntry.supportMode).toBe("supported");
  });

  it("keeps apply blocked when the execution kill switch is active", async () => {
    vi.mocked(executionConfig.getMetaExecutionApplyBoundaryState).mockReturnValue({
      executionPreviewEnabled: true,
      applyEnabled: true,
      killSwitchActive: true,
      canaryScoped: true,
      businessAllowlisted: true,
      eligible: false,
      blockedReasons: ["Meta execution kill switch is active."],
    });

    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });

    expect(preview.permission.canApply).toBe(false);
    expect(preview.preflight.readyForApply).toBe(false);
    expect(
      preview.preflight.checks.find((check) => check.key === "kill_switch")?.status,
    ).toBe("fail");
  });

  it("rejects apply when the preview hash is stale", async () => {
    await expect(
      executionService.applyCommandCenterExecution({
        request: new NextRequest("http://localhost/api/command-center/execution/apply", {
          method: "POST",
        }),
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        action: buildActionFixture(),
        permissions,
        actorUserId: "user_1",
        actorName: "Operator",
        actorEmail: "operator@adsecute.com",
        clientMutationId: "apply_1",
        previewHash: "stale_hash",
      }),
    ).rejects.toThrow("Execution preview is stale");
  });

  it("replays a stored terminal apply receipt without issuing a second provider write", async () => {
    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });
    vi.mocked(commandCenterStore.getCommandCenterMutationReceipt).mockResolvedValue({
      kind: "command_center_execution",
      operation: "apply",
      success: true,
      preview,
      error: null,
    } as never);

    const result = await executionService.applyCommandCenterExecution({
      request: new NextRequest("http://localhost/api/command-center/execution/apply", {
        method: "POST",
      }),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
      actorUserId: "user_1",
      actorName: "Operator",
      actorEmail: "operator@adsecute.com",
      clientMutationId: "apply_1",
      previewHash: preview.previewHash,
    });

    expect(result.previewHash).toBe(preview.previewHash);
    expect(metaExecution.mutateMetaAdSetExecution).not.toHaveBeenCalled();
  });

  it("blocks ambiguous duplicate apply retries without issuing a second provider write", async () => {
    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });
    vi.mocked(executionStore.getCommandCenterExecutionState).mockResolvedValue(
      buildExecutionStateRecord({
        executionStatus: "applying",
        workflowStatusSnapshot: "approved",
        lastClientMutationId: "apply_1",
        currentState: {
          status: "ACTIVE",
          budgetLevel: "adset",
          dailyBudget: 100,
          lifetimeBudget: null,
          optimizationGoal: "PURCHASE",
          bidStrategyLabel: "Cost Cap",
        },
      }) as never,
    );
    vi.mocked(metaExecution.getMetaAdSetExecutionState).mockResolvedValue({
      provider: "meta",
      businessId: "biz",
      adSetId: "adset_1",
      adSetName: "Prospecting Wide US",
      providerAccountId: "act_1",
      providerAccountName: "Account 1",
      currency: "USD",
      campaignId: "cmp_1",
      campaignName: "Spring Promo",
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 100,
      lifetimeBudget: null,
      optimizationGoal: "PURCHASE",
      bidStrategyLabel: "Cost Cap",
      isBudgetMixed: false,
      isConfigMixed: false,
      providerAccessible: true,
      isDemo: false,
    } as never);

    await expect(
      executionService.applyCommandCenterExecution({
        request: new NextRequest("http://localhost/api/command-center/execution/apply", {
          method: "POST",
        }),
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        action: buildActionFixture(),
        permissions,
        actorUserId: "user_1",
        actorName: "Operator",
        actorEmail: "operator@adsecute.com",
        clientMutationId: "apply_1",
        previewHash: preview.previewHash,
      }),
    ).rejects.toThrow("Apply is already in progress");

    expect(metaExecution.mutateMetaAdSetExecution).not.toHaveBeenCalled();
  });

  it("fails apply when post-apply validation does not observe the requested state", async () => {
    vi.mocked(metaExecution.mutateMetaAdSetExecution).mockResolvedValue({
      statusCode: 200,
      ok: true,
      traceId: "trace_1",
      body: { success: true },
    } as never);

    await expect(
      executionService.applyCommandCenterExecution({
        request: new NextRequest("http://localhost/api/command-center/execution/apply", {
          method: "POST",
        }),
        businessId: "biz",
        startDate: "2026-04-01",
        endDate: "2026-04-10",
        action: buildActionFixture(),
        permissions,
        actorUserId: "user_1",
        actorName: "Operator",
        actorEmail: "operator@adsecute.com",
        clientMutationId: "apply_validation_1",
        previewHash: (
          await executionService.getCommandCenterExecutionPreview({
            request: new NextRequest("http://localhost/api/command-center/execution"),
            businessId: "biz",
            startDate: "2026-04-01",
            endDate: "2026-04-10",
            action: buildActionFixture(),
            permissions,
          })
        ).previewHash,
      }),
    ).rejects.toThrow("Observed daily budget");
  });

  it("replays a stored terminal rollback receipt without issuing a second provider write", async () => {
    vi.mocked(executionStore.getCommandCenterExecutionState).mockResolvedValue(
      buildExecutionStateRecord({
        executionStatus: "executed",
        workflowStatusSnapshot: "executed",
        lastClientMutationId: "apply_0",
      }) as never,
    );
    const preview = await executionService.getCommandCenterExecutionPreview({
      request: new NextRequest("http://localhost/api/command-center/execution"),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
    });
    vi.mocked(commandCenterStore.getCommandCenterMutationReceipt).mockResolvedValue({
      kind: "command_center_execution",
      operation: "rollback",
      success: true,
      preview,
      error: null,
    } as never);

    const result = await executionService.rollbackCommandCenterExecution({
      request: new NextRequest("http://localhost/api/command-center/execution/rollback", {
        method: "POST",
      }),
      businessId: "biz",
      startDate: "2026-04-01",
      endDate: "2026-04-10",
      action: buildActionFixture(),
      permissions,
      actorUserId: "user_1",
      actorName: "Operator",
      actorEmail: "operator@adsecute.com",
      clientMutationId: "rollback_1",
    });

    expect(result.previewHash).toBe(preview.previewHash);
    expect(metaExecution.mutateMetaAdSetExecution).not.toHaveBeenCalled();
  });
});
