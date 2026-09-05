import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDecisionOriginAdActionIdempotencyKey,
  type DecisionOriginAdExecutionRequest,
} from "@/lib/creative-decision-engine/execution-safety";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

vi.mock("@/lib/meta/ads-action-log", () => ({
  findDecisionOriginActionByIdempotency: vi.fn(),
  readDecisionOriginSourceDecision: vi.fn(),
}));

vi.mock("@/lib/meta/automation-control-plane", () => ({
  getMetaWriteBlockState: vi.fn(),
}));

vi.mock("@/lib/meta/ads-write", () => ({
  readMetaAdExecutionState: vi.fn(),
}));

vi.mock("@/lib/meta/decision-pipeline-health", () => ({
  readMetaDecisionPipelineOperationalHealth: vi.fn(),
  buildMetaDecisionPipelineHealth: vi.fn(),
}));

vi.mock("@/lib/meta/decisions-workspace-read-model", () => ({
  readMetaDecisionsWorkspaceReadModel: vi.fn(),
}));

const actionLog = await import("@/lib/meta/ads-action-log");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const adsWrite = await import("@/lib/meta/ads-write");
const pipelineHealth = await import("@/lib/meta/decision-pipeline-health");
const decisionReadModel = await import(
  "@/lib/meta/decisions-workspace-read-model"
);
const { runServerDecisionOriginAdActionPreflight } =
  await import("./decision-origin-action-preflight");

const NOW = new Date("2026-07-12T10:00:00.000Z");
const DECISION_HASH = "d".repeat(64);

function request(
  overrides: Partial<DecisionOriginAdExecutionRequest> = {},
): DecisionOriginAdExecutionRequest {
  const base = {
    contractVersion: "meta-decision-origin-ad-execution.v1" as const,
    businessId: "business_1",
    providerAccountId: "act_123",
    adId: "123456789012345",
    snapshotId: "snapshot_1",
    evaluationId: "evaluation_1",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    decisionHash: DECISION_HASH,
    action: "pause",
    idempotencyKey: "",
    creativeId: "creative_1",
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "idempotencyKey")) {
    base.idempotencyKey =
      createDecisionOriginAdActionIdempotencyKey(base);
  }
  return base;
}

describe("server decision-origin action preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(
      actionLog.findDecisionOriginActionByIdempotency,
    ).mockResolvedValue(null);
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({ blocked: false, reason: null, message: null, rehearsal: false });
    vi.mocked(
      pipelineHealth.readMetaDecisionPipelineOperationalHealth,
    ).mockResolvedValue({} as never);
    vi.mocked(
      decisionReadModel.readMetaDecisionsWorkspaceReadModel,
    ).mockResolvedValue({} as never);
    vi.mocked(pipelineHealth.buildMetaDecisionPipelineHealth).mockReturnValue({
      overall: "healthy",
      executionReady: true,
    } as never);
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "123456789012345",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-12T09:59:00.000Z",
    });
    vi.mocked(actionLog.readDecisionOriginSourceDecision).mockResolvedValue({
      found: true,
      businessId: "business_1",
      providerAccountId: "act_123",
      decisionEntityType: "ad",
      decisionEntityId: "123456789012345",
      adId: "123456789012345",
      campaignId: "campaign_1",
      adsetId: "adset_1",
      creativeId: "creative_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      decisionHash: DECISION_HASH,
      decisionLabel: "cut",
      blockedActionType: null,
      explicitAuthorizedAction: "pause",
      computedAt: "2026-07-12T09:30:00.000Z",
    });
  });

  it("re-reads live ad state and exact source authority before proceeding", async () => {
    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result).toMatchObject({
      disposition: "proceed",
      shouldMutate: true,
      blockers: [],
      decisionAgeHours: 0.5,
      currentAdStateAgeMinutes: 1,
    });
    expect(adsWrite.readMetaAdExecutionState).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_123" }),
      "123456789012345",
    );
    expect(actionLog.readDecisionOriginSourceDecision).toHaveBeenCalledWith({
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
    });
  });

  it("rejects at the server boundary when the current source pipeline is not execution-ready", async () => {
    vi.mocked(pipelineHealth.buildMetaDecisionPipelineHealth).mockReturnValue({
      overall: "blocked",
      executionReady: false,
    } as never);

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result).toMatchObject({
      disposition: "reject",
      shouldMutate: false,
      errorCode: "source_pipeline_unready",
    });
    expect(result.blockers).toContain("source_pipeline_unready");
  });

  it("rejects a non-canonical native tuple key before any evidence read", async () => {
    const result = await runServerDecisionOriginAdActionPreflight({
      request: request({ idempotencyKey: "alternate-attempt-key" }),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toContain("idempotency_key_mismatch");
    expect(
      actionLog.findDecisionOriginActionByIdempotency,
    ).not.toHaveBeenCalled();
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
  });

  it("keeps missing source or live creative identity review-only", async () => {
    vi.mocked(actionLog.readDecisionOriginSourceDecision).mockResolvedValue({
      ...(await actionLog.readDecisionOriginSourceDecision({
        snapshotId: "snapshot_1",
        evaluationId: "evaluation_1",
      })),
      creativeId: null,
    });
    const missingSource = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    vi.mocked(actionLog.readDecisionOriginSourceDecision).mockResolvedValue({
      found: true,
      businessId: "business_1",
      providerAccountId: "act_123",
      decisionEntityType: "ad",
      decisionEntityId: "123456789012345",
      adId: "123456789012345",
      campaignId: "campaign_1",
      adsetId: "adset_1",
      creativeId: "creative_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      decisionHash: DECISION_HASH,
      decisionLabel: "cut",
      blockedActionType: null,
      explicitAuthorizedAction: "pause",
      computedAt: "2026-07-12T09:30:00.000Z",
    });
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "123456789012345",
      providerAccountId: "act_123",
      creativeId: null,
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-12T09:59:00.000Z",
    });
    const missingLive = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(missingSource.shouldMutate).toBe(false);
    expect(missingSource.blockers).toContain(
      "source_decision_lineage_mismatch",
    );
    expect(missingLive.shouldMutate).toBe(false);
    expect(missingLive.blockers).toContain("ad_identity_mismatch");
  });

  it("fails closed on a stale source decision", async () => {
    vi.mocked(actionLog.readDecisionOriginSourceDecision).mockResolvedValue({
      ...(await actionLog.readDecisionOriginSourceDecision({
        snapshotId: "snapshot_1",
        evaluationId: "evaluation_1",
      })),
      computedAt: "2026-07-11T20:00:00.000Z",
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toContain("decision_stale");
  });

  it("blocks a hysteresis-pending hard raw action even if stale data carries authorization", async () => {
    vi.mocked(actionLog.readDecisionOriginSourceDecision).mockResolvedValue({
      ...(await actionLog.readDecisionOriginSourceDecision({
        snapshotId: "snapshot_1",
        evaluationId: "evaluation_1",
      })),
      decisionLabel: "keep",
      blockedActionType: "cut",
      explicitAuthorizedAction: "pause",
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toContain("action_not_authorized");
  });

  it("blocks a Cut whose exact persisted tuple has no explicit pause authorization", async () => {
    vi.mocked(actionLog.readDecisionOriginSourceDecision).mockResolvedValue({
      ...(await actionLog.readDecisionOriginSourceDecision({
        snapshotId: "snapshot_1",
        evaluationId: "evaluation_1",
      })),
      decisionLabel: "cut",
      blockedActionType: null,
      explicitAuthorizedAction: null,
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request({ action: "pause" }),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toContain("action_not_authorized");
  });

  it("blocks a Cut whose exact persisted tuple has no explicit pause authorization", async () => {
    vi.mocked(actionLog.readDecisionOriginSourceDecision).mockResolvedValue({
      ...(await actionLog.readDecisionOriginSourceDecision({
        snapshotId: "snapshot_1",
        evaluationId: "evaluation_1",
      })),
      decisionLabel: "cut",
      blockedActionType: null,
      explicitAuthorizedAction: null,
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request({ action: "pause" }),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toContain("action_not_authorized");
  });

  it("fails closed when Meta reports a policy block", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "123456789012345",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "ACTIVE",
      effectiveStatus: "DISAPPROVED",
      policyEligible: false,
      reviewStatus: "DISAPPROVED",
      observedAt: "2026-07-12T09:59:00.000Z",
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining(["policy_blocked", "ad_status_incompatible"]),
    );
  });

  it("fails closed when the current parent hierarchy is not exactly ACTIVE", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "123456789012345",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_1",
      campaignConfiguredStatus: "PAUSED",
      campaignEffectiveStatus: "PAUSED",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-12T09:59:00.000Z",
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toContain(
      "current_hierarchy_state_incompatible",
    );
  });

  it("fails closed when the current parent identity differs from the decision input", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "123456789012345",
      providerAccountId: "act_123",
      creativeId: "creative_1",
      campaignId: "campaign_other",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: "ACTIVE",
      effectiveStatus: "ACTIVE",
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-12T09:59:00.000Z",
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toContain(
      "current_hierarchy_identity_mismatch",
    );
  });

  it("preserves a transient Meta read failure as unverified state", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: false,
      adId: "123456789012345",
      httpStatus: null,
      preflightBlocker: "current_ad_state_unverified",
      error: {
        code: "network_error",
        message: "Meta current ad state could not be read.",
      },
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.errorCode).toBe("current_ad_state_unverified");
    expect(result.blockers).toContain("current_ad_state_unverified");
    expect(result.blockers).not.toContain("ad_not_found");
  });

  it("preserves a permanent Meta read failure instead of returning retryable state", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: false,
      adId: "123456789012345",
      httpStatus: 400,
      preflightBlocker: "meta_account_unresolved",
      error: {
        code: "190",
        message: "Invalid OAuth access token.",
      },
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.errorCode).toBe("meta_account_unresolved");
    expect(result.blockers).toEqual(["meta_account_unresolved"]);
    expect(result.blockers).not.toContain("current_ad_state_unverified");
  });

  it("returns an existing receipt without another provider state read", async () => {
    vi.mocked(
      actionLog.findDecisionOriginActionByIdempotency,
    ).mockResolvedValue({
      actionLogId: "log_1",
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "123456789012345",
      creativeId: "creative_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      decisionHash: DECISION_HASH,
      action: "pause",
      idempotencyKey: request().idempotencyKey,
      status: "success",
      dryRun: false,
      providerVerified: true,
      treatmentEligible: true,
    });

    const result = await runServerDecisionOriginAdActionPreflight({
      request: request(),
      ctx: {
        businessId: "business_1",
        providerAccountId: "act_123",
        accessToken: "secret-token",
        // Required by current main's pre-POST authority snapshot; the native
        // branch predates that guard, so its fixtures omitted the field.
        connectionGeneration: "1:connected",
      },
      now: NOW,
    });

    expect(result).toMatchObject({
      disposition: "duplicate",
      shouldMutate: false,
      duplicateReceipt: { actionLogId: "log_1", status: "success" },
    });
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(actionLog.readDecisionOriginSourceDecision).not.toHaveBeenCalled();
    expect(controlPlane.getMetaWriteBlockState).not.toHaveBeenCalled();
  });
});
