import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionOriginAdExecutionRequest } from "@/lib/creative-decision-engine/execution-safety";
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

const actionLog = await import("@/lib/meta/ads-action-log");
const controlPlane = await import("@/lib/meta/automation-control-plane");
const adsWrite = await import("@/lib/meta/ads-write");
const { runServerDecisionOriginAdActionPreflight } = await import(
  "./decision-origin-action-preflight"
);

const NOW = new Date("2026-07-12T10:00:00.000Z");
const DECISION_HASH = "d".repeat(64);

function request(
  overrides: Partial<DecisionOriginAdExecutionRequest> = {},
): DecisionOriginAdExecutionRequest {
  return {
    contractVersion: "meta-decision-origin-ad-execution.v1",
    businessId: "business_1",
    providerAccountId: "act_123",
    adId: "ad_1",
    snapshotId: "snapshot_1",
    evaluationId: "evaluation_1",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    decisionHash: DECISION_HASH,
    action: "pause",
    idempotencyKey: "decision-action-1",
    creativeId: "creative_1",
    ...overrides,
  };
}

describe("server decision-origin action preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(
      actionLog.findDecisionOriginActionByIdempotency,
    ).mockResolvedValue(null);
    vi.mocked(controlPlane.getMetaWriteBlockState).mockResolvedValue({
      blocked: false,
      reason: null,
      message: null,
    });
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "ad_1",
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
      decisionEntityId: "ad_1",
      adId: "ad_1",
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
      "ad_1",
    );
    expect(actionLog.readDecisionOriginSourceDecision).toHaveBeenCalledWith({
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
    });
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
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toContain("decision_stale");
  });

  it("fails closed when Meta reports a policy block", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockResolvedValue({
      ok: true,
      adId: "ad_1",
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
      },
      now: NOW,
    });

    expect(result.shouldMutate).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining(["policy_blocked", "ad_status_incompatible"]),
    );
  });

  it("returns an existing receipt without another provider state read", async () => {
    vi.mocked(
      actionLog.findDecisionOriginActionByIdempotency,
    ).mockResolvedValue({
      actionLogId: "log_1",
      businessId: "business_1",
      providerAccountId: "act_123",
      adId: "ad_1",
      snapshotId: "snapshot_1",
      evaluationId: "evaluation_1",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      decisionHash: DECISION_HASH,
      action: "pause",
      idempotencyKey: "decision-action-1",
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
