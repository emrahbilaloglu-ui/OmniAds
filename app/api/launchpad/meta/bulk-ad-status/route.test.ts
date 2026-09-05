import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { createDecisionOriginAdActionIdempotencyKey } from "@/lib/creative-decision-engine/execution-safety";

vi.mock("@/lib/access", () => ({
  requireBusinessAccess: vi.fn(),
}));

// The demo refusal is a SERVER rule (rejectIfLaunchpadDemoWrite reads
// businesses.is_demo_business). Mocked here so these cases exercise the rest
// of the route; the refusal itself is asserted in demo-write-authority.test.ts
// and in the per-route demo case below.
vi.mock("../demo-write-authority", () => ({
  rejectIfLaunchpadDemoWrite: vi.fn(async () => null),
}));

vi.mock("@/lib/meta/ads-action-log", () => ({
  DECISION_ORIGIN_PENDING_RECONCILIATION_CODE:
    "decision_origin_pending_reconciliation_required",
  DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE:
    "provider_verification_persistence_failed",
  META_AD_STATUS_ACTION_IN_FLIGHT_CODE: "action_in_flight",
  META_AD_STATUS_RECONCILIATION_REQUIRED_CODE:
    "meta_ad_status_reconciliation_required",
  MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION:
    "meta-manual-ad-status-mutation-attempt.v1",
  appendManualMetaAdStatusMutationAttemptCompleted: vi.fn(),
  appendManualMetaAdStatusMutationAttemptStarted: vi.fn(),
  completeDecisionOriginMetaAdsActionLog: vi.fn(),
  completeMetaAdsActionLog: vi.fn(),
  createDecisionOriginMetaAdsActionLog: vi.fn(),
  createMetaAdsActionLog: vi.fn(),
  decisionOriginIdempotencyReceiptFromLog: vi.fn(
    (row: {
      id?: string;
      actionLogId?: string;
      status?: string;
      errorCode?: string | null;
      payloadResponse?: Record<string, unknown> | null;
    }) => {
      const marker = row.payloadResponse?.decision_origin_reconciliation as
        | Record<string, unknown>
        | undefined;
      return {
        ...row,
        actionLogId: row.actionLogId ?? row.id,
        reconciliationRequired:
          row.status === "pending" &&
          marker?.reconciliation_required === true,
        retryAllowed: false,
        reconciliationOutcome:
          typeof marker?.outcome === "string" ? marker.outcome : null,
        providerMutationAttempted:
          typeof marker?.provider_mutation_attempted === "boolean"
            ? marker.provider_mutation_attempted
            : null,
        providerMutationSucceeded:
          typeof marker?.provider_mutation_succeeded === "boolean"
            ? marker.provider_mutation_succeeded
            : null,
        providerOutcomeAmbiguous:
          typeof marker?.provider_outcome_ambiguous === "boolean"
            ? marker.provider_outcome_ambiguous
            : null,
      };
    },
  ),
  findUnresolvedMetaAdStatusActionLog: vi.fn(),
  markDecisionOriginActionReconciliationRequired: vi.fn(),
  readLaunchpadCreatedAdIds: vi.fn(),
  resolveExactMetaAdActionTarget: vi.fn(),
  resolveMetaAdActionTarget: vi.fn(),
}));

vi.mock("@/lib/meta/ads-write", () => ({
  hasSuccessfulMetaProviderMutationAttempt: vi.fn(
    (result: {
      mutationAttempt?: { providerResponseSuccessful?: boolean } | null;
    }) => result.mutationAttempt?.providerResponseSuccessful === true,
  ),
  pauseAd: vi.fn(),
  readMetaAdExecutionState: vi.fn(),
  resumeAd: vi.fn(),
}));

vi.mock("@/lib/meta/manual-ad-status-reconciliation", () => ({
  reconcileManualMetaAdStatusBlocker: vi.fn(),
}));

vi.mock("@/lib/meta/automation-write-guard", () => ({
  rejectIfMetaWritesBlocked: vi.fn(),
  // The shared posture every write family now reads. Unblocked and NOT
  // rehearsing: these suites assert on real provider calls, and a rehearsing
  // posture would turn every one of them into a dry run.
  readMetaWritePosture: vi.fn(async () => ({
    blocked: false, rehearsal: false, reason: null, message: null,
  })),
  metaWriteBlockedResponse: vi.fn((posture: { reason: string | null; message: string | null }) =>
    // The real refusal envelope, so a caller reading `error.code` sees what the
    // shipped helper actually answers with.
    new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "kill_switch_engaged",
          message: posture?.message ?? "Meta writes are disabled by kill switch.",
          reason: posture?.reason ?? null,
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    )),
  metaWriteIsRehearsal: (input: { posture: { rehearsal: boolean }; requestedDryRun: boolean }) =>
    input.posture.rehearsal || input.requestedDryRun === true,
}));

vi.mock("@/lib/meta/decision-origin-action-preflight", () => ({
  runServerDecisionOriginAdActionPreflight: vi.fn(),
}));

vi.mock("@/lib/launchpad/meta-validation", () => ({
  metaLaunchAccountBlockerHttpStatus: vi.fn((code: string) =>
    code === "provider_account_not_assigned" ? 403 : 400,
  ),
  normalizeMetaLaunchProviderAccountId: vi.fn((value: string | null | undefined) =>
    value?.trim() || "",
  ),
  resolveAssignedMetaLaunchAccount: vi.fn(),
  resolveMetaLaunchWriteContext: vi.fn(),
  validateMetaBulkResumePreflight: vi.fn(),
}));

const access = await import("@/lib/access");
const actionLog = await import("@/lib/meta/ads-action-log");
const adsWrite = await import("@/lib/meta/ads-write");
const manualReconciliation = await import(
  "@/lib/meta/manual-ad-status-reconciliation"
);
const writeGuard = await import("@/lib/meta/automation-write-guard");
const decisionPreflight = await import(
  "@/lib/meta/decision-origin-action-preflight"
);
const validation = await import("@/lib/launchpad/meta-validation");
const { POST } = await import("./route");

const BUSINESS_ID = "172d0ab8-495b-4679-a4c6-ffa404c389d3";
const USER_ID = "272d0ab8-495b-4679-a4c6-ffa404c389d3";
const NATIVE_AD_ID_1 = "100000000000001";
const NATIVE_AD_ID_2 = "100000000000002";
const NATIVE_AD_ID_3 = "100000000000003";

function request(body: unknown) {
  const scopedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? { providerAccountId: "act_123", ...body }
      : body;
  return new NextRequest("http://localhost/api/launchpad/meta/bulk-ad-status", {
    method: "POST",
    body: JSON.stringify(scopedBody),
    headers: { "Content-Type": "application/json" },
  });
}

function body() {
  return {
    actionOrigin: "manual_operator_v1",
    manualConfirmation: "explicit_operator_confirmation",
    businessId: BUSINESS_ID,
    providerAccountId: "act_123",
    action: "pause",
    ads: [
      {
        adId: "ad_1",
        providerAccountId: "act_123",
        creativeId: "creative_1",
        name: "Creative 1",
      },
      {
        adId: "ad_2",
        providerAccountId: "act_123",
        creativeId: "creative_2",
        name: "Creative 2",
      },
    ],
    idempotencyKey: "bulk_1",
  };
}

function decisionBody() {
  return {
    actionOrigin: "native_decision_v1",
    contractVersion: "meta-decision-origin-ad-execution.v1",
    businessId: BUSINESS_ID,
    providerAccountId: "act_123",
    action: "pause" as const,
    idempotencyKey: "decision-bulk-1",
    ads: [NATIVE_AD_ID_1, NATIVE_AD_ID_2].map((adId, index) => {
      const base = {
        contractVersion: "meta-decision-origin-ad-execution.v1" as const,
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId,
        snapshotId: `00000000-0000-4000-8000-0000000000${index + 11}`,
        evaluationId: `00000000-0000-4000-8000-0000000000${index + 21}`,
        engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: String(index + 1).repeat(64),
        action: "pause" as const,
        creativeId: `creative_${index + 1}`,
      };
      return {
        ...base,
        idempotencyKey: createDecisionOriginAdActionIdempotencyKey(base),
        name: `Creative ${index + 1}`,
      };
    }),
  };
}

function mockManualLiveStatus(status: "ACTIVE" | "PAUSED") {
  vi.mocked(adsWrite.readMetaAdExecutionState).mockImplementation(
    async (_ctx, adId) => ({
      ok: true,
      adId,
      providerAccountId: "act_123",
      creativeId: adId.replace(/^ad_/, "creative_"),
      campaignId: "campaign_1",
      campaignConfiguredStatus: "ACTIVE",
      campaignEffectiveStatus: "ACTIVE",
      adsetId: "adset_1",
      adsetConfiguredStatus: "ACTIVE",
      adsetEffectiveStatus: "ACTIVE",
      configuredStatus: status,
      effectiveStatus: status,
      policyEligible: true,
      reviewStatus: null,
      observedAt: "2026-07-18T14:00:00.000Z",
    }),
  );
}

function liveMutationAttempt(
  adId: string,
  input: {
    providerResponseSuccessful?: boolean;
    httpStatus?: number;
    outcome?: "provider_response_received" | "outcome_ambiguous";
  } = {},
) {
  const outcome = input.outcome ?? "provider_response_received";
  const providerResponseReceived =
    outcome === "provider_response_received";
  return {
    attemptCount: 1 as const,
    method: "POST" as const,
    path: adId,
    attemptedAt: "2026-07-18T14:00:01.000Z",
    completedAt: "2026-07-18T14:00:02.000Z",
    providerResponseReceived,
    providerResponseSuccessful:
      input.providerResponseSuccessful ??
      providerResponseReceived,
    httpStatus:
      input.httpStatus ??
      (providerResponseReceived ? 200 : null),
    outcome,
    automaticRetryAttempted: false as const,
    transportError:
      outcome === "outcome_ambiguous"
        ? { code: "provider_timeout", message: "Timed out." }
        : null,
  };
}

function manualCandidate(adId: string, action: "pause" | "resume") {
  return {
    businessId: BUSINESS_ID,
    providerAccountId: "act_123",
    adId,
    unresolvedSourceCount: 1,
    sourceActionLogId: `source_${adId}`,
    action,
    creativeId: adId.replace(/^ad_/, "creative_"),
    readyForProviderRead: true,
    settlementNotBefore: "2026-07-18T13:55:00.000Z",
    authorityKind: "completed_attempt" as const,
    outcome: "provider_response_verified_success" as const,
    providerAccountRefId: "00000000-0000-4000-8000-000000000001",
    campaignId: "campaign_1",
    adsetId: "adset_1",
    blockerReason: null,
  };
}

function exactManualState(
  adId: string,
  status: "ACTIVE" | "PAUSED",
) {
  return {
    ok: true as const,
    adId,
    providerAccountId: "act_123",
    creativeId: adId.replace(/^ad_/, "creative_"),
    campaignId: "campaign_1",
    campaignConfiguredStatus: "ACTIVE",
    campaignEffectiveStatus: "ACTIVE",
    adsetId: "adset_1",
    adsetConfiguredStatus: "ACTIVE",
    adsetEffectiveStatus: "ACTIVE",
    configuredStatus: status,
    effectiveStatus: status,
    policyEligible: true,
    reviewStatus: null,
    observedAt: "2026-07-18T14:00:00.000Z",
    providerGetEvidence: {
      id: adId,
      account_id: "123",
      status,
      effective_status: status,
    },
  };
}

const simulatedProviderPostIds: string[] = [];

async function runBeforeMutationAttemptHook(
  adId: string,
  options:
    | {
        beforeMutationAttempt?: (baseline: {
          businessId: string;
          providerAccountId: string;
          adId: string;
          creativeId: string;
          campaignId: string;
          adsetId: string;
        }) => Promise<void>;
      }
    | undefined,
) {
  try {
    await options?.beforeMutationAttempt?.({
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId,
      creativeId: adId.replace(/^ad_/, "creative_"),
      campaignId: "campaign_1",
      adsetId: "adset_1",
    });
    return null;
  } catch (error) {
    const typed =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string; message?: unknown })
        : null;
    return {
      ok: false as const,
      httpStatus: 503,
      providerMutationAttempted: false,
      error: {
        code: typed?.code ?? "before_mutation_attempt_failed",
        message:
          typed && typeof typed.message === "string"
            ? typed.message
            : error instanceof Error
              ? error.message
              : "The pre-provider mutation hook failed.",
      },
      responsePayload: null,
      verificationPayload: null,
    };
  }
}

function mockPauseAdResultsAfterHook(...results: unknown[]) {
  const queuedResults = [...results];
  vi.mocked(adsWrite.pauseAd).mockReset().mockImplementation(
    async (_ctx, adId, options) => {
      const blocked = await runBeforeMutationAttemptHook(
        adId,
        options,
      );
      if (blocked) return blocked as never;
      simulatedProviderPostIds.push(adId);
      const result = queuedResults.shift();
      if (result instanceof Error) throw result;
      return result as never;
    },
  );
}

describe("POST /api/launchpad/meta/bulk-ad-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    simulatedProviderPostIds.length = 0;
    vi.mocked(access.requireBusinessAccess).mockResolvedValue({
      session: { user: { id: USER_ID } },
      membership: { businessId: BUSINESS_ID },
    } as never);
    vi.mocked(validation.resolveMetaLaunchWriteContext).mockResolvedValue({
      ok: true,
      ctx: {
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        accessToken: "secret-token",
      },
    } as never);
    vi.mocked(validation.resolveAssignedMetaLaunchAccount).mockResolvedValue({
      ok: true,
      providerAccountId: "act_123",
    });
    vi.mocked(writeGuard.rejectIfMetaWritesBlocked).mockResolvedValue(null);
    vi.mocked(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).mockImplementation(async ({ adId }) => {
      const createManualMock = vi.mocked(
        actionLog.createMetaAdsActionLog,
      );
      const manualClaimIndex = createManualMock.mock.calls.findIndex(
        ([claim]) => claim.adId === adId,
      );
      if (manualClaimIndex >= 0) {
        const claim =
          createManualMock.mock.calls[manualClaimIndex]![0];
        const result = await Promise.resolve(
          createManualMock.mock.results[manualClaimIndex]?.value,
        ).catch(() => null);
        const logId =
          result &&
          typeof result === "object" &&
          "id" in result &&
          typeof result.id === "string"
            ? result.id
            : null;
        return logId
          ? ({
              id: logId,
              businessId: claim.businessId,
              providerAccountId: claim.providerAccountId ?? null,
              adId: claim.adId,
              creativeId: claim.creativeId ?? null,
              action: claim.action,
              source: claim.source ?? "manual_operator_v1",
              status: "pending",
              dryRun: claim.payloadRequest?.dry_run === true,
            } as never)
          : null;
      }

      const createNativeMock = vi.mocked(
        actionLog.createDecisionOriginMetaAdsActionLog,
      );
      const nativeClaimIndex = createNativeMock.mock.calls.findIndex(
        ([claim]) => claim.request.adId === adId,
      );
      if (nativeClaimIndex < 0) return null;
      const claim =
        createNativeMock.mock.calls[nativeClaimIndex]![0];
      const result = await Promise.resolve(
        createNativeMock.mock.results[nativeClaimIndex]?.value,
      ).catch(() => null);
      const logId =
        result &&
        typeof result === "object" &&
        "id" in result &&
        typeof result.id === "string"
          ? result.id
          : null;
      return logId
        ? ({
            id: logId,
            businessId: claim.request.businessId,
            providerAccountId: claim.request.providerAccountId,
            adId: claim.request.adId,
            creativeId: claim.request.creativeId,
            action: claim.request.action,
            source: "decision_origin",
            status: "pending",
            dryRun: claim.request.dryRun === true,
            idempotencyKey: claim.request.idempotencyKey,
            decisionSnapshotId: claim.request.snapshotId,
            decisionEvaluationId: claim.request.evaluationId,
            decisionEngineVersion: claim.request.engineVersion,
            decisionHash: claim.request.decisionHash,
          } as never)
        : null;
    });
    vi.mocked(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).mockImplementation(async ({ businessId, providerAccountId, adId }) => ({
      disposition: "not_needed",
      candidate: {
        businessId,
        providerAccountId,
        adId,
        unresolvedSourceCount: 0,
        sourceActionLogId: null,
        action: null,
        creativeId: null,
        readyForProviderRead: false,
        settlementNotBefore: null,
        authorityKind: null,
        outcome: null,
        providerAccountRefId: null,
        campaignId: null,
        adsetId: null,
        blockerReason: "no_unresolved_manual_source",
      },
    }));
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).mockImplementation(async ({ sourceActionLogId, target, action }) => ({
      id: `attempt-start-${sourceActionLogId}`,
      sourceActionLogId,
      attemptId: `attempt-${sourceActionLogId}`,
      action,
      businessId: target.businessId,
      providerAccountId: target.providerAccountId,
      adId: target.adId,
      creativeId: target.creativeId,
      campaignId: target.campaignId,
      adsetId: target.adsetId,
    }) as never);
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).mockResolvedValue({ id: "attempt-completed" } as never);
    vi.mocked(adsWrite.readMetaAdExecutionState).mockImplementation(
      async (_ctx, adId) => ({
        ok: true,
        adId,
        providerAccountId: "act_123",
        creativeId: adId.replace(/^ad_/, "creative_"),
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
        observedAt: "2026-07-18T14:00:00.000Z",
      }),
    );
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "proceed",
      shouldMutate: true,
      blockers: [],
      errorCode: null,
      duplicateReceipt: null,
      decisionAgeHours: 1,
      currentAdStateAgeMinutes: 0,
    });
    vi.mocked(actionLog.readLaunchpadCreatedAdIds).mockResolvedValue(
      new Set(["ad_1", "ad_2"]),
    );
    vi.mocked(validation.validateMetaBulkResumePreflight).mockResolvedValue({
      ok: true,
      blockers: [],
    });
    vi.mocked(actionLog.createMetaAdsActionLog).mockImplementation(async () => ({
      id: `log_${vi.mocked(actionLog.createMetaAdsActionLog).mock.calls.length}`,
    }) as never);
    vi.mocked(actionLog.createDecisionOriginMetaAdsActionLog).mockImplementation(
      async () => ({
        id: `decision_log_${
          vi.mocked(actionLog.createDecisionOriginMetaAdsActionLog).mock.calls
            .length
        }`,
      }) as never,
    );
    vi.mocked(actionLog.completeMetaAdsActionLog).mockResolvedValue({ id: "log" } as never);
    vi.mocked(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).mockResolvedValue({ id: "decision_log" } as never);
    vi.mocked(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).mockResolvedValue({ id: "decision_log", status: "pending" } as never);
    vi.mocked(actionLog.resolveMetaAdActionTarget).mockImplementation(async (input) => ({
      ok: true,
      target: {
        businessId: BUSINESS_ID,
        adId: input.adId,
        creativeId: input.adId === "ad_1" ? "creative_1" : "creative_2",
        providerAccountId: "act_123",
      },
    }) as never);
    vi.mocked(actionLog.resolveExactMetaAdActionTarget).mockImplementation(
      async (input) => ({
        ok: true,
        target: {
          businessId: BUSINESS_ID,
          adId: input.adId,
          creativeId:
            input.adId === NATIVE_AD_ID_1 || input.adId === "ad_1"
              ? "creative_1"
              : input.adId === NATIVE_AD_ID_2 || input.adId === "ad_2"
                ? "creative_2"
                : "creative_3",
          providerAccountId: input.providerAccountId,
        },
      }) as never,
    );
    vi.mocked(adsWrite.pauseAd).mockImplementation(
      async (_ctx, adId, options) => {
        const blocked = await runBeforeMutationAttemptHook(
          adId,
          options,
        );
        if (blocked) return blocked as never;
        simulatedProviderPostIds.push(adId);
        return {
        ok: true,
        verifiedStatus: "PAUSED",
        responsePayload: { success: true },
        verificationPayload: {
          id: adId,
          status: "PAUSED",
          observedAt:
            adId === "ad_1"
              ? "2026-07-18T14:00:01.000Z"
              : "2026-07-18T14:00:02.000Z",
        },
        mutationAttempt: liveMutationAttempt(adId),
        providerHttpStatus: 200,
        } as never;
      },
    );
    vi.mocked(adsWrite.resumeAd).mockImplementation(
      async (_ctx, adId, options) => {
        const blocked = await runBeforeMutationAttemptHook(
          adId,
          options,
        );
        if (blocked) return blocked as never;
        simulatedProviderPostIds.push(adId);
        return {
          ok: true,
          verifiedStatus: "ACTIVE",
          responsePayload: { success: true },
          verificationPayload: {
            id: adId,
            status: "ACTIVE",
            observedAt: "2026-07-18T14:00:03.000Z",
          },
          mutationAttempt: liveMutationAttempt(adId),
          providerHttpStatus: 200,
        } as never;
      },
    );
  });

  it("rejects a stripped action origin instead of silently using the manual branch", async () => {
    const stripped = body();
    delete (stripped as { actionOrigin?: string }).actionOrigin;
    const response = await POST(request(stripped));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_decision_origin_batch");
    expect(payload.error.blockers).toContainEqual({
      code: "action_origin_required",
    });
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("does not expose durable reconciliation query internals", async () => {
    vi.mocked(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).mockRejectedValueOnce(
      new Error(
        'relation "meta_ads_action_log" is unavailable at postgres://internal',
      ),
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      error: {
        code: "reconciliation_state_unavailable",
        message:
          "The durable Ad-action reconciliation state is temporarily unavailable.",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("meta_ads_action_log");
    expect(JSON.stringify(payload)).not.toContain("postgres://internal");
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("rejects decision fields under an explicit manual origin", async () => {
    const response = await POST(
      request({
        ...body(),
        ads: [
          {
            adId: "ad_1",
            creativeId: "creative_1",
            snapshotId: "00000000-0000-4000-8000-000000000011",
          },
        ],
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.blockers).toContainEqual({
      code: "mixed_action_origin_contract",
    });
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it.each([
    ["contractVersion", null],
    ["snapshot_id", ""],
    ["evaluationId", null],
    ["engine_version", ""],
    ["decisionHash", null],
    ["decision_action", ""],
  ])(
    "rejects explicit manual/native bulk field %s=%j",
    async (field, value) => {
      const manual = body();
      manual.ads = [
        {
          ...manual.ads[0]!,
          [field]: value,
        },
      ];
      const response = await POST(request(manual));
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.blockers).toContainEqual({
        code: "mixed_action_origin_contract",
      });
      expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
      expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["manualConfirmation", null],
    ["manual_confirmation", ""],
    ["launchIntentId", null],
    ["execution_authority", ""],
  ])(
    "rejects explicit native/manual bulk field %s=%j",
    async (field, value) => {
      const response = await POST(
        request({
          ...decisionBody(),
          [field]: value,
        }),
      );
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.blockers).toContainEqual({
        code: "mixed_action_origin_contract",
      });
      expect(
        actionLog.createDecisionOriginMetaAdsActionLog,
      ).not.toHaveBeenCalled();
      expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    },
  );

  it("rejects a conflicting action-origin alias", async () => {
    const response = await POST(
      request({
        ...body(),
        action_origin: "native_decision_v1",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.blockers).toContainEqual({
      code: "mixed_action_origin_contract",
    });
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it.each([
    ["actionOrigin", null],
    ["action_origin", ""],
    ["executionOrigin", "manual_operator_v1"],
    ["execution_origin", "native_decision_v1"],
  ])(
    "rejects nested bulk-item origin field %s=%j before side effects",
    async (field, value) => {
      const manual = body();
      manual.ads = [
        {
          ...manual.ads[0]!,
          [field]: value,
        },
      ];
      const response = await POST(request(manual));
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe("invalid_decision_origin_batch");
      expect(payload.error.blockers).toContainEqual({
        adId: "ad_1",
        code: "mixed_action_origin_contract",
        fields: [field],
      });
      expect(
        validation.resolveAssignedMetaLaunchAccount,
      ).not.toHaveBeenCalled();
      expect(validation.resolveMetaLaunchWriteContext).not.toHaveBeenCalled();
      expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
      expect(
        actionLog.createDecisionOriginMetaAdsActionLog,
      ).not.toHaveBeenCalled();
      expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    },
  );

  it.each(["malformed-first", "malformed-last"])(
    "rejects a valid plus missing-id target before every read/log/write (%s)",
    async (order) => {
      const manual = body();
      const valid = manual.ads[0]!;
      const malformed = {
        ...manual.ads[1]!,
        adId: "   ",
        candidateAdIds: ["ad_2"],
      };
      const response = await POST(
        request({
          ...manual,
          ads:
            order === "malformed-first"
              ? [malformed, valid]
              : [valid, malformed],
        }),
      );
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe("invalid_decision_origin_batch");
      expect(payload.error.blockers).toContainEqual(
        expect.objectContaining({ adId: null, code: "missing_ad_id" }),
      );
      expect(access.requireBusinessAccess).not.toHaveBeenCalled();
      expect(writeGuard.rejectIfMetaWritesBlocked).not.toHaveBeenCalled();
      expect(
        validation.resolveAssignedMetaLaunchAccount,
      ).not.toHaveBeenCalled();
      expect(validation.resolveMetaLaunchWriteContext).not.toHaveBeenCalled();
      expect(actionLog.resolveExactMetaAdActionTarget).not.toHaveBeenCalled();
      expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
      expect(
        decisionPreflight.runServerDecisionOriginAdActionPreflight,
      ).not.toHaveBeenCalled();
      expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
      expect(
        actionLog.createDecisionOriginMetaAdsActionLog,
      ).not.toHaveBeenCalled();
      expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    },
  );

  it("rejects identical duplicate ad targets before every read/log/write", async () => {
    const manual = body();
    const duplicate = { ...manual.ads[0]! };
    const response = await POST(
      request({
        ...manual,
        ads: [manual.ads[0]!, duplicate],
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_decision_origin_batch");
    expect(payload.error.blockers).toContainEqual(
      expect.objectContaining({
        adId: "ad_1",
        code: "duplicate_ad_target",
        firstIndex: 0,
        index: 1,
      }),
    );
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(actionLog.resolveExactMetaAdActionTarget).not.toHaveBeenCalled();
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it.each(["original-first", "conflict-first"])(
    "rejects conflicting native lineage for the same ad independent of order (%s)",
    async (order) => {
      const native = decisionBody();
      const original = native.ads[0]!;
      const conflictingBase = {
        contractVersion: original.contractVersion,
        businessId: original.businessId,
        providerAccountId: original.providerAccountId,
        adId: original.adId,
        snapshotId: "00000000-0000-4000-8000-000000000099",
        evaluationId: "00000000-0000-4000-8000-000000000098",
        engineVersion: original.engineVersion,
        decisionHash: "f".repeat(64),
        action: original.action,
        creativeId: original.creativeId,
      };
      const conflicting = {
        ...conflictingBase,
        idempotencyKey:
          createDecisionOriginAdActionIdempotencyKey(conflictingBase),
        name: "Conflicting lineage",
      };
      const response = await POST(
        request({
          ...native,
          ads:
            order === "original-first"
              ? [original, conflicting]
              : [conflicting, original],
        }),
      );
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe("invalid_decision_origin_batch");
      expect(payload.error.blockers).toContainEqual(
        expect.objectContaining({
          adId: NATIVE_AD_ID_1,
          code: "duplicate_ad_target",
          firstIndex: 0,
          index: 1,
        }),
      );
      expect(access.requireBusinessAccess).not.toHaveBeenCalled();
      expect(actionLog.resolveExactMetaAdActionTarget).not.toHaveBeenCalled();
      expect(
        decisionPreflight.runServerDecisionOriginAdActionPreflight,
      ).not.toHaveBeenCalled();
      expect(
        actionLog.createDecisionOriginMetaAdsActionLog,
      ).not.toHaveBeenCalled();
      expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    },
  );

  it("pauses selected ads only in the explicitly selected provider account", async () => {
    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      action: "pause",
      status: "PAUSED",
      successCount: 2,
      failedCount: 0,
      adIds: ["ad_1", "ad_2"],
    });
    expect(adsWrite.pauseAd).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerAccountId: "act_123" }),
      "ad_1",
      expect.objectContaining({
        beforeMutationAttempt: expect.any(Function),
      }),
    );
    expect(adsWrite.pauseAd).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerAccountId: "act_123" }),
      "ad_2",
      expect.objectContaining({
        beforeMutationAttempt: expect.any(Function),
      }),
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "pause",
        providerAccountId: "act_123",
        adId: "ad_1",
        creativeId: "creative_1",
        source: "manual_operator_v1",
        payloadRequest: expect.objectContaining({
          action_origin: "manual_operator_v1",
          manual_confirmation: "explicit_operator_confirmation",
          mutation_journal_contract_version:
            "meta-manual-ad-status-mutation-attempt.v1",
          mutation_journal_required: true,
          manual_status_mutation_target: {
            businessId: BUSINESS_ID,
            providerAccountId: "act_123",
            adId: "ad_1",
            creativeId: "creative_1",
            campaignId: "campaign_1",
            adsetId: "adset_1",
          },
        }),
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "success",
        payloadResponse: { success: true },
        verifiedAt: "2026-07-18T14:00:01.000Z",
        verificationPayload: expect.objectContaining({
          id: "ad_1",
          status: "PAUSED",
          observedAt: "2026-07-18T14:00:01.000Z",
        }),
      }),
    );
  });

  it("reconciles every live item before claiming and blocks every POST when one item is still settling", async () => {
    vi.mocked(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).mockImplementation(async ({ businessId, providerAccountId, adId }) =>
      adId === "ad_2"
        ? {
            disposition: "waiting",
            candidate: {
              ...manualCandidate(adId, "pause"),
              businessId,
              providerAccountId,
              readyForProviderRead: false,
              blockerReason: "settlement_not_elapsed",
              settlementNotBefore:
                "2026-07-18T14:05:00.000Z",
            },
          }
        : {
            disposition: "not_needed",
            candidate: {
              ...manualCandidate(adId, "pause"),
              businessId,
              providerAccountId,
              unresolvedSourceCount: 0,
              sourceActionLogId: null,
              action: null,
              creativeId: null,
              readyForProviderRead: false,
              settlementNotBefore: null,
              authorityKind: null,
              outcome: null,
              providerAccountRefId: null,
              campaignId: null,
              adsetId: null,
              blockerReason: "no_unresolved_manual_source",
            },
          },
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "meta_ad_status_reconciliation_waiting",
        reconciliationRequired: true,
        retryAllowed: false,
        blockers: [
          expect.objectContaining({
            adId: "ad_2",
            code: "meta_ad_status_reconciliation_waiting",
            settlementNotBefore: "2026-07-18T14:05:00.000Z",
          }),
        ],
      },
    });
    expect(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).toHaveBeenCalledTimes(2);
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("returns a reconciled manual no-op and writes only the exact precondition item", async () => {
    vi.mocked(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).mockImplementation(async ({ businessId, providerAccountId, adId }) =>
      adId === "ad_1"
        ? {
            disposition: "reconciled",
            candidate: {
              ...manualCandidate(adId, "pause"),
              businessId,
              providerAccountId,
            },
            event: { id: "reconciliation_ad_1" } as never,
            state: exactManualState(adId, "PAUSED"),
            resolution: "current_state_matches_requested",
          }
        : {
            disposition: "not_needed",
            candidate: {
              ...manualCandidate(adId, "pause"),
              businessId,
              providerAccountId,
              unresolvedSourceCount: 0,
              sourceActionLogId: null,
              action: null,
              creativeId: null,
              readyForProviderRead: false,
              settlementNotBefore: null,
              authorityKind: null,
              outcome: null,
              providerAccountRefId: null,
              campaignId: null,
              adsetId: null,
              blockerReason: "no_unresolved_manual_source",
            },
          },
    );
    vi.mocked(adsWrite.pauseAd).mockReset().mockImplementation(
      async (_ctx, adId, options) => {
        const blocked = await runBeforeMutationAttemptHook(
          adId,
          options,
        );
        if (blocked) return blocked as never;
        simulatedProviderPostIds.push(adId);
        return {
          ok: true,
          verifiedStatus: "PAUSED",
          responsePayload: { success: true },
          verificationPayload: { id: adId, status: "PAUSED" },
          mutationAttempt: liveMutationAttempt(adId),
          providerHttpStatus: 200,
        } as never;
      },
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      successCount: 2,
      failedCount: 0,
      results: [
        {
          inputAdId: "ad_1",
          adId: "ad_1",
          ok: true,
          status: "PAUSED",
          reconciled: true,
          noOp: true,
          providerWriteAttempted: false,
        },
        expect.objectContaining({
          inputAdId: "ad_2",
          adId: "ad_2",
          ok: true,
        }),
      ],
    });
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledTimes(1);
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ adId: "ad_2" }),
    );
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(adsWrite.pauseAd).toHaveBeenCalledWith(
      expect.any(Object),
      "ad_2",
      expect.objectContaining({
        beforeMutationAttempt: expect.any(Function),
      }),
    );
  });

  it("claims and post-claim preflights the whole batch before the first provider POST", async () => {
    const ordering: string[] = [];
    vi.mocked(actionLog.createMetaAdsActionLog).mockImplementation(
      async ({ adId }) => {
        ordering.push(`claim:${adId}`);
        return { id: `log_${adId}` } as never;
      },
    );
    vi.mocked(adsWrite.readMetaAdExecutionState).mockImplementation(
      async (_ctx, adId) => {
        ordering.push(`get:${adId}`);
        return exactManualState(adId, "ACTIVE");
      },
    );
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).mockImplementation(async ({ sourceActionLogId, target, action }) => {
      ordering.push(`attempt-start:${target.adId}`);
      return {
        id: `attempt-start-${sourceActionLogId}`,
        sourceActionLogId,
        attemptId: `attempt-${sourceActionLogId}`,
        action,
      } as never;
    });
    vi.mocked(adsWrite.pauseAd).mockReset().mockImplementation(
      async (_ctx, adId, options) => {
        const blocked = await runBeforeMutationAttemptHook(
          adId,
          options,
        );
        if (blocked) return blocked as never;
        ordering.push(`post:${adId}`);
        simulatedProviderPostIds.push(adId);
        return {
          ok: true,
          verifiedStatus: "PAUSED",
          responsePayload: { success: true },
          verificationPayload: { id: adId, status: "PAUSED" },
          mutationAttempt: liveMutationAttempt(adId),
        } as never;
      },
    );
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).mockImplementation(async ({ sourceActionLogId }) => {
      ordering.push(`attempt-complete:${sourceActionLogId}`);
      return { id: `completed-${sourceActionLogId}` } as never;
    });
    vi.mocked(actionLog.completeMetaAdsActionLog).mockImplementation(
      async ({ id }) => {
        ordering.push(`terminal:${id}`);
        return { id } as never;
      },
    );

    const response = await POST(request(body()));

    expect(response.status).toBe(200);
    expect(ordering.indexOf("claim:ad_2")).toBeLessThan(
      ordering.indexOf("post:ad_1"),
    );
    const beforeFirstProviderPost = ordering.slice(
      0,
      ordering.indexOf("post:ad_1"),
    );
    expect(
      beforeFirstProviderPost.filter(
        (entry) => entry === "get:ad_2",
      ),
    ).toHaveLength(2);
    expect(
      ordering.filter((entry) => entry.startsWith("get:ad_")).length,
    ).toBe(6);
    expect(ordering.lastIndexOf("get:ad_1")).toBeLessThan(
      ordering.indexOf("attempt-start:ad_1"),
    );
    expect(ordering.lastIndexOf("get:ad_2")).toBeLessThan(
      ordering.indexOf("attempt-start:ad_2"),
    );
    expect(ordering.indexOf("attempt-start:ad_1")).toBeLessThan(
      ordering.indexOf("post:ad_1"),
    );
    expect(ordering.indexOf("post:ad_1")).toBeLessThan(
      ordering.indexOf("attempt-complete:log_ad_1"),
    );
    expect(ordering.indexOf("attempt-complete:log_ad_1")).toBeLessThan(
      ordering.indexOf("terminal:log_ad_1"),
    );
  });

  it("aborts every prepared claim and performs zero POSTs when a later claim races", async () => {
    vi.mocked(actionLog.createMetaAdsActionLog)
      .mockResolvedValueOnce({ id: "log_ad_1" } as never)
      .mockRejectedValueOnce(
        Object.assign(new Error("action_in_flight"), {
          code: "action_in_flight",
          blockingActionLogId: "raced_ad_2",
          blockingOrigin: "native_decision_v1",
          reconciliationRequired: false,
          reconciliationReceipt: null,
        }),
      );

    const response = await POST(request(body()));

    expect(response.status).toBe(409);
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_ad_1",
        status: "failure",
        errorCode: "action_in_flight",
      }),
    );
  });

  it("stops before the next POST when its source is reconciled while the first item waits", async () => {
    const findUnresolved =
      vi.mocked(actionLog.findUnresolvedMetaAdStatusActionLog);
    const defaultFindUnresolved =
      findUnresolved.getMockImplementation();
    if (!defaultFindUnresolved) {
      throw new Error("default unresolved-owner mock is required");
    }

    let secondSourceReconciled = false;
    findUnresolved.mockImplementation(async (input) => {
      const unresolved = await defaultFindUnresolved(input);
      return input.adId === "ad_2" &&
        secondSourceReconciled &&
        unresolved
        ? null
        : unresolved;
    });

    let notifyFirstProviderStarted!: () => void;
    const firstProviderStarted = new Promise<void>((resolve) => {
      notifyFirstProviderStarted = resolve;
    });
    let releaseFirstProvider!: () => void;
    const firstProviderGate = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    vi.mocked(adsWrite.pauseAd).mockReset().mockImplementation(
      async (_ctx, adId, options) => {
        if (adId !== "ad_1") {
          throw new Error("a second provider POST must never start");
        }
        const blocked = await runBeforeMutationAttemptHook(
          adId,
          options,
        );
        if (blocked) return blocked as never;
        simulatedProviderPostIds.push(adId);
        notifyFirstProviderStarted();
        await firstProviderGate;
        return {
          ok: true,
          verifiedStatus: "PAUSED",
          responsePayload: { success: true },
          verificationPayload: { id: adId, status: "PAUSED" },
          mutationAttempt: liveMutationAttempt(adId),
          providerHttpStatus: 200,
        } as never;
      },
    );

    const responsePromise = POST(
      request({
        ...body(),
        idempotencyKey: "mid-batch-source-reconciled",
      }),
    );
    await firstProviderStarted;
    secondSourceReconciled = true;
    releaseFirstProvider();

    const response = await responsePromise;
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 0,
      haltedReason: {
        code: "manual_action_claim_ownership_changed",
        reconciliationRequired: true,
        retryAllowed: false,
      },
      results: [
        expect.objectContaining({
          inputAdId: "ad_1",
          ok: true,
          status: "PAUSED",
        }),
        expect.objectContaining({
          inputAdId: "ad_2",
          ok: false,
          providerWriteAttempted: false,
          reconciliationRequired: true,
          retryAllowed: false,
          error: expect.objectContaining({
            code: "manual_action_claim_ownership_changed",
          }),
        }),
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(adsWrite.pauseAd).toHaveBeenCalledWith(
      expect.any(Object),
      "ad_1",
      expect.objectContaining({
        beforeMutationAttempt: expect.any(Function),
      }),
    );
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).toHaveBeenCalledTimes(1);
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceActionLogId: "log_1",
        target: expect.objectContaining({ adId: "ad_1" }),
      }),
    );
    const terminalCalls = vi.mocked(
      actionLog.completeMetaAdsActionLog,
    ).mock.calls;
    expect(
      terminalCalls.some(
        ([completion]) =>
          completion.id === "log_1" &&
          completion.status === "success",
      ),
    ).toBe(true);
    expect(
      terminalCalls.some(
        ([completion]) =>
          completion.id === "log_1" &&
          completion.status === "failure",
      ),
    ).toBe(false);
    expect(
      terminalCalls.some(
        ([completion]) => completion.id === "log_2",
      ),
    ).toBe(false);
  });

  it("never calls the provider when the immutable attempt start cannot be persisted", async () => {
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).mockRejectedValueOnce(new Error("db unavailable"));

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.haltedReason).toMatchObject({
      code: "manual_mutation_attempt_start_persistence_failed",
      retryAllowed: false,
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(simulatedProviderPostIds).toEqual([]);
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledTimes(2);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalled();
  });

  it("never reissues a provider POST from an idempotent immutable attempt start", async () => {
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).mockResolvedValueOnce({
      id: "existing-start",
      sourceActionLogId: "log_1",
      attemptId: "existing-attempt",
      eventKind: "attempt_started",
      idempotentReplay: true,
    } as never);

    const response = await POST(
      request({ ...body(), idempotencyKey: "attempt-start-replay" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      haltedReason: {
        code:
          "manual_mutation_attempt_replay_requires_reconciliation",
        reconciliationRequired: true,
        retryAllowed: false,
      },
      results: [
        expect.objectContaining({
          inputAdId: "ad_1",
          ok: false,
          reconciliationRequired: true,
          retryAllowed: false,
          providerWriteAttempted: false,
        }),
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(simulatedProviderPostIds).toEqual([]);
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).not.toHaveBeenCalled();
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "log_2", status: "failure" }),
    );
    expect(
      vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls.some(
        ([completion]) => completion.id === "log_1",
      ),
    ).toBe(false);
  });

  it("terminalizes immediate adapter target drift with zero attempt events and zero provider POSTs", async () => {
    vi.mocked(adsWrite.pauseAd).mockReset().mockImplementation(
      async (_ctx, adId, options) => {
        try {
          await options?.beforeMutationAttempt?.({
            businessId: BUSINESS_ID,
            providerAccountId: "act_123",
            adId,
            creativeId: "creative_drift",
            campaignId: "campaign_1",
            adsetId: "adset_1",
          });
        } catch (error) {
          return {
            ok: false,
            httpStatus: 409,
            providerMutationAttempted: false,
            error: {
              code:
                error !== null &&
                typeof error === "object" &&
                "code" in error &&
                typeof (error as { code?: unknown }).code ===
                  "string"
                  ? (error as { code: string }).code
                  : "before_mutation_attempt_failed",
              message:
                error instanceof Error
                  ? error.message
                  : "The mutation target changed.",
            },
            responsePayload: null,
            verificationPayload: null,
          } as never;
        }
        throw new Error("target drift must stop before provider POST");
      },
    );

    const response = await POST(
      request({ ...body(), idempotencyKey: "adapter-target-drift" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      halted: true,
      omittedCount: 1,
      results: [
        {
          inputAdId: "ad_1",
          ok: false,
          error: { code: "manual_mutation_target_drift" },
        },
      ],
    });
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).not.toHaveBeenCalled();
    expect(simulatedProviderPostIds).toEqual([]);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "failure",
        errorCode: "manual_mutation_target_drift",
        payloadResponse: {
          adapter_pre_provider_abort: {
            code: "manual_mutation_target_drift",
            provider_mutation_attempted: false,
          },
        },
        verificationPayload: null,
        verifiedAt: null,
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_2",
        status: "failure",
        errorCode: "bulk_execution_halted_before_provider",
      }),
    );
  });

  it("terminalizes an adapter precondition stop when the start hook is never reached", async () => {
    vi.mocked(adsWrite.pauseAd).mockReset().mockResolvedValueOnce({
      ok: false,
      httpStatus: 409,
      providerMutationAttempted: false,
      error: {
        code: "ad_already_paused",
        message: "The immediate adapter baseline is already paused.",
      },
      responsePayload: null,
      verificationPayload: {
        reason: "configured_status_not_active",
      },
    } as never);

    const response = await POST(
      request({
        ...body(),
        idempotencyKey: "adapter-precondition-no-hook",
      }),
    );

    expect(response.status).toBe(502);
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).not.toHaveBeenCalled();
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "failure",
        errorCode: "ad_already_paused",
        payloadResponse: {
          adapter_pre_provider_abort: {
            code: "ad_already_paused",
            provider_mutation_attempted: false,
          },
        },
        verificationPayload: null,
        verifiedAt: null,
      }),
    );
  });

  it("halts after exactly one POST when immutable attempt completion persistence fails", async () => {
    vi.mocked(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).mockRejectedValueOnce(new Error("db unavailable"));

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      haltedReason: {
        code:
          "manual_mutation_attempt_completion_persistence_failed",
        reconciliationRequired: true,
        retryAllowed: false,
      },
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_2",
        status: "failure",
        errorCode: "bulk_execution_halted_before_provider",
        payloadResponse: {
          bulk_pre_provider_abort: {
            code: "bulk_execution_halted_before_provider",
            provider_mutation_attempted: false,
          },
        },
      }),
    );
  });

  it("journals a definite empty-body rejection with sanitized fallback evidence", async () => {
    mockPauseAdResultsAfterHook({
      ok: false,
      httpStatus: 503,
      providerOutcome: "definite_failure",
      error: {
        code: "provider_http_error",
        message: "Provider rejected the request.",
      },
      responsePayload: null,
      verificationPayload: null,
      mutationAttempt: liveMutationAttempt("ad_1", {
        providerResponseSuccessful: false,
        httpStatus: 503,
      }),
    });
    const single = body();
    single.ads = [single.ads[0]!];

    const response = await POST(
      request({ ...single, idempotencyKey: "empty-body-rejection" }),
    );

    expect(response.status).toBe(502);
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        completionOutcome: "provider_definite_failure",
        providerResponse: {
          provider_response_evidence: {
            code: "provider_http_error",
            message: "Provider rejected the request.",
            httpStatus: 503,
            bodyPresent: false,
          },
        },
        verification: null,
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        errorCode: "provider_http_error",
      }),
    );
    expect(
      vi.mocked(
        actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
      ).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(actionLog.completeMetaAdsActionLog).mock
        .invocationCallOrder[0]!,
    );
  });

  it("retries a commit-ack-lost manual failure with the identical frozen terminal fact", async () => {
    mockPauseAdResultsAfterHook({
      ok: false,
      httpStatus: 400,
      providerOutcome: "definite_failure",
      error: { code: "100", message: "Cannot pause ad." },
      responsePayload: { error: { code: 100 } },
      mutationAttempt: liveMutationAttempt("ad_1", {
        providerResponseSuccessful: false,
        httpStatus: 400,
      }),
    });
    const single = body();
    single.ads = [single.ads[0]!];
    let firstCommittedFact:
      | Parameters<
          typeof actionLog.completeMetaAdsActionLog
        >[0]
      | null = null;
    vi.mocked(actionLog.completeMetaAdsActionLog).mockImplementation(
      async (completion) => {
        if (!firstCommittedFact) {
          firstCommittedFact = structuredClone(completion);
          throw new Error(
            "commit succeeded but acknowledgement was lost",
          );
        }
        expect(completion).toEqual(firstCommittedFact);
        return { id: completion.id } as never;
      },
    );

    const response = await POST(
      request({
        ...single,
        idempotencyKey: "failure-terminal-ack-lost",
      }),
    );

    expect(response.status).toBe(502);
    const currentCalls = vi
      .mocked(actionLog.completeMetaAdsActionLog)
      .mock.calls.filter(([completion]) => completion.id === "log_1");
    expect(currentCalls).toHaveLength(2);
    expect(currentCalls[0]![0].durationMs).toBe(
      currentCalls[1]![0].durationMs,
    );
  });

  it("blocks the entire batch when a later target has an old unresolved status action", async () => {
    vi.mocked(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).mockImplementation(async ({ adId }) =>
      adId === "ad_2"
        ? ({
            id: "old_manual_pending",
            source: "manual_operator_v1",
            status: "pending",
            idempotencyKey: null,
          } as never)
        : null,
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "bulk_action_in_flight",
        blockers: [
          expect.objectContaining({
            adId: "ad_2",
            code: "action_in_flight",
            blockingActionLogId: "old_manual_pending",
            blockingOrigin: "manual_operator_v1",
            retryAllowed: false,
          }),
        ],
      },
    });
    expect(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).toHaveBeenNthCalledWith(1, {
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: "ad_1",
    });
    expect(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).toHaveBeenNthCalledWith(2, {
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: "ad_2",
    });
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("blocks the entire batch behind an unresolved manual live silent failure", async () => {
    vi.mocked(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).mockImplementation(async ({ adId }) =>
      adId === "ad_1"
        ? ({
            id: "manual_ambiguous_terminal",
            source: "manual_operator_v1",
            status: "silent_failure",
            dryRun: false,
            errorCode: "provider_outcome_ambiguous",
            idempotencyKey: null,
          } as never)
        : null,
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toMatchObject({
      code: "bulk_reconciliation_required",
      reconciliationRequired: true,
      providerOutcomeAmbiguous: true,
      retryAllowed: false,
      blockers: [
        expect.objectContaining({
          adId: "ad_1",
          code: "meta_ad_status_reconciliation_required",
          blockingActionLogId: "manual_ambiguous_terminal",
          blockingOrigin: "manual_operator_v1",
          reconciliationRequired: true,
          providerOutcomeAmbiguous: true,
          retryAllowed: false,
        }),
      ],
    });
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("halts the batch on a typed cross-origin claim conflict before any provider POST", async () => {
    vi.mocked(actionLog.createMetaAdsActionLog).mockRejectedValueOnce(
      Object.assign(new Error("action_in_flight"), {
        code: "action_in_flight",
        blockingActionLogId: "blocking_native_log",
        blockingOrigin: "native_decision_v1",
        reconciliationRequired: false,
        reconciliationReceipt: null,
      }),
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "bulk_action_in_flight",
        retryAllowed: false,
        blockers: [
          expect.objectContaining({
            adId: "ad_1",
            code: "action_in_flight",
            blockingActionLogId: "blocking_native_log",
            blockingOrigin: "native_decision_v1",
            retryAllowed: false,
          }),
        ],
      },
    });
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledTimes(1);
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("halts the batch when manual post-claim live state changed and persists a DB-only failure", async () => {
    let stateReadCount = 0;
    vi.mocked(adsWrite.readMetaAdExecutionState).mockImplementation(
      async (_ctx, adId) => {
        stateReadCount += 1;
        const status = stateReadCount <= 2 ? "ACTIVE" : "PAUSED";
        return {
          ok: true,
          adId,
          providerAccountId: "act_123",
          creativeId: adId.replace(/^ad_/, "creative_"),
          campaignId: "campaign_1",
          campaignConfiguredStatus: "ACTIVE",
          campaignEffectiveStatus: "ACTIVE",
          adsetId: "adset_1",
          adsetConfiguredStatus: "ACTIVE",
          adsetEffectiveStatus: "ACTIVE",
          configuredStatus: status,
          effectiveStatus: status,
          policyEligible: true,
          reviewStatus: null,
          observedAt: "2026-07-18T14:00:00.000Z",
        };
      },
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "bulk_post_claim_preflight_blocked",
        retryAllowed: false,
        blockers: expect.arrayContaining([
          expect.objectContaining({
            adId: "ad_1",
            code: "ad_status_incompatible",
          }),
        ]),
      },
    });
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledTimes(2);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        errorCode: "bulk_post_claim_preflight_blocked",
      }),
    );
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("preflights every manual target before the first bulk write", async () => {
    vi.mocked(adsWrite.readMetaAdExecutionState).mockImplementation(
      async (_ctx, adId) =>
        adId === "ad_2"
          ? {
              ok: false,
              adId,
              error: {
                code: "network_error",
                message: "connection reset",
              },
              httpStatus: null,
              preflightBlocker: "current_ad_state_unverified",
            }
          : {
              ok: true,
              adId,
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
              observedAt: "2026-07-18T14:00:00.000Z",
            },
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("bulk_live_preflight_blocked");
    expect(payload.error.blockers).toContainEqual({
      adId: "ad_2",
      code: "current_ad_state_unverified",
    });
    expect(adsWrite.readMetaAdExecutionState).toHaveBeenCalledTimes(2);
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("uses exact targets and atomic receipts for every decision-origin bulk item", async () => {
    vi.mocked(adsWrite.pauseAd).mockReset().mockImplementation(
      async (_ctx, adId, options) => {
        const blocked = await runBeforeMutationAttemptHook(
          adId,
          options,
        );
        if (blocked) return blocked as never;
        simulatedProviderPostIds.push(adId);
        const creativeId =
          adId === NATIVE_AD_ID_1 ? "creative_1" : "creative_2";
        const providerGetEvidence = {
          id: adId,
          account_id: "123",
          status: "PAUSED",
          effective_status: "PAUSED",
          creative: { id: creativeId },
          campaign: {
            id: "campaign_1",
            status: "ACTIVE",
            effective_status: "ACTIVE",
          },
          adset: {
            id: "adset_1",
            status: "ACTIVE",
            effective_status: "ACTIVE",
          },
        };
        return {
          ok: true,
          verifiedStatus: "PAUSED",
          responsePayload: { success: true },
          verificationPayload: {
            contractVersion: "meta-ad-status-write-verification.v1",
            adId,
            providerAccountId: "act_123",
            creativeId,
            campaignId: "campaign_1",
            adsetId: "adset_1",
            configuredStatus: "PAUSED",
            effectiveStatus: "PAUSED",
            campaignConfiguredStatus: "ACTIVE",
            campaignEffectiveStatus: "ACTIVE",
            adsetConfiguredStatus: "ACTIVE",
            adsetEffectiveStatus: "ACTIVE",
            policyEligible: true,
            reviewStatus: null,
            observedAt: "2026-07-18T14:00:03.000Z",
            providerGetEvidence,
          },
          mutationAttempt: liveMutationAttempt(adId),
          providerHttpStatus: 200,
        } as never;
      },
    );

    const response = await POST(request(decisionBody()));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, successCount: 2, failedCount: 0 });
    expect(actionLog.resolveExactMetaAdActionTarget).toHaveBeenCalledTimes(2);
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).toHaveBeenCalledTimes(
      2,
    );
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledTimes(2);
    for (const [index, [completion]] of vi
      .mocked(actionLog.completeDecisionOriginMetaAdsActionLog)
      .mock.calls.entries()) {
      expect(completion).toMatchObject({
        id: `decision_log_${index + 1}`,
        status: "success",
        providerCompletedAt: "2026-07-18T14:00:02.000Z",
        verificationPayload: {
          contractVersion: "meta-ad-status-write-verification.v1",
          adId: index === 0 ? NATIVE_AD_ID_1 : NATIVE_AD_ID_2,
          providerAccountId: "act_123",
          creativeId: `creative_${index + 1}`,
          campaignId: "campaign_1",
          adsetId: "adset_1",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          campaignConfiguredStatus: "ACTIVE",
          campaignEffectiveStatus: "ACTIVE",
          adsetConfiguredStatus: "ACTIVE",
          adsetEffectiveStatus: "ACTIVE",
          policyEligible: true,
          reviewStatus: null,
          observedAt: "2026-07-18T14:00:03.000Z",
        },
      });
    }
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it.each([
    {
      changedAuthority: "preflight",
      expectedCode: "decision_stale",
      secondClaimTerminalized: true,
    },
    {
      changedAuthority: "ownership",
      expectedCode: "native_action_claim_ownership_changed",
      secondClaimTerminalized: false,
    },
  ] as const)(
    "stops a long native batch after one POST when the second item loses $changedAuthority authority",
    async ({
      changedAuthority,
      expectedCode,
      secondClaimTerminalized,
    }) => {
      const native = decisionBody();
      const thirdBase = {
        contractVersion:
          "meta-decision-origin-ad-execution.v1" as const,
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: NATIVE_AD_ID_3,
        snapshotId: "00000000-0000-4000-8000-000000000013",
        evaluationId: "00000000-0000-4000-8000-000000000023",
        engineVersion:
          "v3-ad-2026-07-12-native-provenance-shadow",
        decisionHash: "3".repeat(64),
        action: "pause" as const,
        creativeId: "creative_3",
      };
      native.ads.push({
        ...thirdBase,
        idempotencyKey:
          createDecisionOriginAdActionIdempotencyKey(thirdBase),
        name: "Creative 3",
      });

      const defaultPreflight = vi
        .mocked(
          decisionPreflight.runServerDecisionOriginAdActionPreflight,
        )
        .getMockImplementation();
      const defaultFindUnresolved = vi
        .mocked(actionLog.findUnresolvedMetaAdStatusActionLog)
        .getMockImplementation();
      if (!defaultPreflight || !defaultFindUnresolved) {
        throw new Error(
          "default native authority mocks are required",
        );
      }

      let raceArmed = false;
      let secondJitPreflightChecked = false;
      let secondJitOwnerChecked = false;
      vi.mocked(
        decisionPreflight.runServerDecisionOriginAdActionPreflight,
      ).mockImplementation(async (input) => {
        if (
          raceArmed &&
          input.request.adId === NATIVE_AD_ID_2
        ) {
          secondJitPreflightChecked = true;
          if (changedAuthority === "preflight") {
            return {
              ok: false,
              disposition: "reject",
              shouldMutate: false,
              blockers: ["decision_stale"],
              errorCode: "decision_stale",
              duplicateReceipt: null,
              decisionAgeHours: 13,
              currentAdStateAgeMinutes: 0,
            };
          }
        }
        return defaultPreflight(input);
      });
      vi.mocked(
        actionLog.findUnresolvedMetaAdStatusActionLog,
      ).mockImplementation(async (input) => {
        const unresolved = await defaultFindUnresolved(input);
        if (
          raceArmed &&
          input.adId === NATIVE_AD_ID_2
        ) {
          secondJitOwnerChecked = true;
          if (changedAuthority === "ownership" && unresolved) {
            return null;
          }
        }
        return unresolved;
      });

      let notifyFirstProviderStarted!: () => void;
      const firstProviderStarted = new Promise<void>((resolve) => {
        notifyFirstProviderStarted = resolve;
      });
      let releaseFirstProvider!: () => void;
      const firstProviderGate = new Promise<void>((resolve) => {
        releaseFirstProvider = resolve;
      });
      vi.mocked(adsWrite.pauseAd).mockReset().mockImplementation(
        async (_ctx, adId) => {
          if (adId !== NATIVE_AD_ID_1) {
            throw new Error(
              "a later native provider POST must never start",
            );
          }
          notifyFirstProviderStarted();
          await firstProviderGate;
          return {
            ok: true,
            verifiedStatus: "PAUSED",
            responsePayload: { success: true },
            verificationPayload: {
              id: adId,
              status: "PAUSED",
            },
            mutationAttempt: liveMutationAttempt(adId),
            providerHttpStatus: 200,
          } as never;
        },
      );

      const responsePromise = POST(
        request({
          ...native,
          idempotencyKey: `native-mid-batch-${changedAuthority}-change`,
        }),
      );
      await firstProviderStarted;
      raceArmed = true;
      releaseFirstProvider();

      const response = await responsePromise;
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload).toMatchObject({
        ok: false,
        halted: true,
        omittedCount: 1,
        successCount: 1,
        failedCount: 1,
        haltedReason: expect.objectContaining({
          code: expectedCode,
          retryAllowed: false,
          providerWriteAttempted: false,
        }),
        results: [
          expect.objectContaining({
            inputAdId: NATIVE_AD_ID_1,
            ok: true,
            status: "PAUSED",
          }),
          expect.objectContaining({
            inputAdId: NATIVE_AD_ID_2,
            ok: false,
            providerWriteAttempted: false,
            retryAllowed: false,
            error: expect.objectContaining({
              code: expectedCode,
            }),
          }),
        ],
      });
      expect(secondJitPreflightChecked).toBe(true);
      expect(secondJitOwnerChecked).toBe(true);
      expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
      expect(adsWrite.pauseAd).toHaveBeenCalledWith(
        expect.any(Object),
        NATIVE_AD_ID_1,
      );

      const terminalCalls = vi.mocked(
        actionLog.completeDecisionOriginMetaAdsActionLog,
      ).mock.calls;
      expect(
        terminalCalls.some(
          ([completion]) =>
            completion.id === "decision_log_1" &&
            completion.status === "success",
        ),
      ).toBe(true);
      expect(
        terminalCalls.some(
          ([completion]) =>
            completion.id === "decision_log_1" &&
            completion.status !== "success",
        ),
      ).toBe(false);
      expect(
        terminalCalls.some(
          ([completion]) =>
            completion.id === "decision_log_2",
        ),
      ).toBe(secondClaimTerminalized);
      expect(
        terminalCalls.some(
          ([completion]) =>
            completion.id === "decision_log_3" &&
            completion.status === "failure",
        ),
      ).toBe(true);
    },
  );

  it("halts the native batch when durable completion rejects the verified lineage", async () => {
    vi.mocked(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Provider verification did not preserve the exact native Ad lineage.",
        ),
        { code: "decision_origin_provider_verification_mismatch" },
      ),
    );

    const response = await POST(request(decisionBody()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      successCount: 0,
      failedCount: 1,
      haltedReason: {
        code: "provider_verification_persistence_failed",
        reconciliationRequired: true,
        reconciliationOutcome:
          "provider_response_succeeded_verification_failed",
      },
      results: [
        {
          inputAdId: NATIVE_AD_ID_1,
          adId: NATIVE_AD_ID_1,
          ok: false,
          reconciliationRequired: true,
          reconciliationOutcome:
            "provider_response_succeeded_verification_failed",
          error: { code: "provider_verification_persistence_failed" },
        },
      ],
      steps: [
        {
          kind: "ad",
          id: NATIVE_AD_ID_1,
          status: "failure",
          reconciliationRequired: true,
          reconciliationOutcome:
            "provider_response_succeeded_verification_failed",
          error: { code: "provider_verification_persistence_failed" },
        },
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledTimes(2);
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "decision_log_2",
        status: "failure",
        errorCode: "bulk_execution_halted_before_provider",
      }),
    );
    expect(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "decision_log_1",
        outcome: "provider_response_succeeded_verification_failed",
      }),
    );
  });

  it("marks exact reconciliation and halts when verified provider success cannot finalize its receipt", async () => {
    vi.mocked(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).mockRejectedValueOnce(new Error("terminal receipt persistence unavailable"));

    const response = await POST(request(decisionBody()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      successCount: 0,
      failedCount: 1,
      haltedReason: {
        code: "provider_verification_persistence_failed",
        reconciliationRequired: true,
        retryAllowed: false,
        providerMutationSucceeded: true,
        markerPersisted: true,
      },
      results: [
        {
          inputAdId: NATIVE_AD_ID_1,
          adId: NATIVE_AD_ID_1,
          ok: false,
          reconciliationRequired: true,
          retryAllowed: false,
          providerMutationSucceeded: true,
          markerPersisted: true,
          error: { code: "provider_verification_persistence_failed" },
        },
      ],
      steps: [
        {
          kind: "ad",
          id: NATIVE_AD_ID_1,
          status: "failure",
          reconciliationRequired: true,
          retryAllowed: false,
          providerMutationSucceeded: true,
          markerPersisted: true,
          error: { code: "provider_verification_persistence_failed" },
        },
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledTimes(2);
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "decision_log_2",
        status: "failure",
        errorCode: "bulk_execution_halted_before_provider",
      }),
    );
    expect(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "decision_log_1",
        errorMessage: "terminal receipt persistence unavailable",
        providerCompletedAt: "2026-07-18T14:00:02.000Z",
        mutationAttempt: expect.objectContaining({
          attemptCount: 1,
          method: "POST",
          completedAt: "2026-07-18T14:00:02.000Z",
        }),
        verificationPayload: expect.objectContaining({ status: "PAUSED" }),
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("quarantines an unexpected native provider throw and halts before the next item", async () => {
    vi.mocked(adsWrite.pauseAd)
      .mockReset()
      .mockRejectedValueOnce(new Error("unexpected provider adapter throw"));

    const response = await POST(request(decisionBody()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      successCount: 0,
      failedCount: 1,
      haltedReason: {
        code: "provider_verification_persistence_failed",
        reconciliationRequired: true,
        retryAllowed: false,
        providerOutcomeAmbiguous: true,
        reconciliationOutcome: "provider_outcome_ambiguous",
        markerPersisted: true,
      },
      results: [
        {
          inputAdId: NATIVE_AD_ID_1,
          ok: false,
          reconciliationRequired: true,
          providerOutcomeAmbiguous: true,
          reconciliationOutcome: "provider_outcome_ambiguous",
          error: { code: "provider_verification_persistence_failed" },
        },
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "decision_log_2",
        status: "failure",
        errorCode: "bulk_execution_halted_before_provider",
      }),
    );
    expect(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "decision_log_1",
        outcome: "provider_outcome_ambiguous",
        providerErrorCode: "provider_write_unexpected_exception",
      }),
    );
  });

  it("fails closed when the reconciliation marker cannot be persisted", async () => {
    vi.mocked(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).mockRejectedValueOnce(new Error("terminal receipt persistence unavailable"));
    vi.mocked(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).mockRejectedValueOnce(new Error("marker persistence unavailable"));

    const response = await POST(request(decisionBody()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      haltedReason: {
        code: "provider_verification_persistence_failed",
        reconciliationRequired: true,
        retryAllowed: false,
        providerMutationSucceeded: true,
        markerPersisted: false,
      },
      results: [
        {
          inputAdId: NATIVE_AD_ID_1,
          ok: false,
          markerPersisted: false,
        },
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(
      actionLog.markDecisionOriginActionReconciliationRequired,
    ).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("blocks stale exact bulk actions before any provider write", async () => {
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: false,
      disposition: "reject",
      shouldMutate: false,
      blockers: ["decision_stale"],
      errorCode: "decision_stale",
      duplicateReceipt: null,
      decisionAgeHours: 13,
      currentAdStateAgeMinutes: 0,
    });

    const response = await POST(request(decisionBody()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("bulk_live_preflight_blocked");
    expect(payload.error.blockers).toHaveLength(2);
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("replays an exact bulk receipt without another provider write", async () => {
    const retryBody = decisionBody();
    retryBody.ads = retryBody.ads.slice(0, 1);
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "duplicate",
      shouldMutate: false,
      blockers: [],
      errorCode: null,
      duplicateReceipt: {
        actionLogId: "decision_log_1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: NATIVE_AD_ID_1,
        creativeId: "creative_1",
        snapshotId: retryBody.ads[0]!.snapshotId,
        evaluationId: retryBody.ads[0]!.evaluationId,
        engineVersion: retryBody.ads[0]!.engineVersion,
        decisionHash: retryBody.ads[0]!.decisionHash,
        action: "pause",
        idempotencyKey: retryBody.ads[0]!.idempotencyKey,
        status: "success",
        dryRun: false,
        providerVerified: true,
        treatmentEligible: true,
      },
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(request(retryBody));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, successCount: 1, failedCount: 0 });
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("does not infer provider success from a sparse reconciliation receipt", async () => {
    const retryBody = decisionBody();
    retryBody.ads = retryBody.ads.slice(0, 1);
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: false,
      disposition: "duplicate",
      shouldMutate: false,
      blockers: [],
      errorCode: null,
      duplicateReceipt: {
        actionLogId: "decision_log_1",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: NATIVE_AD_ID_1,
        creativeId: "creative_1",
        snapshotId: retryBody.ads[0]!.snapshotId,
        evaluationId: retryBody.ads[0]!.evaluationId,
        engineVersion: retryBody.ads[0]!.engineVersion,
        decisionHash: retryBody.ads[0]!.decisionHash,
        action: "pause",
        idempotencyKey: retryBody.ads[0]!.idempotencyKey,
        status: "pending",
        dryRun: false,
        providerVerified: false,
        treatmentEligible: false,
        errorCode: "provider_verification_persistence_failed",
        reconciliationRequired: true,
        retryAllowed: false,
      },
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(request(retryBody));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "bulk_live_preflight_blocked",
        reconciliationRequired: true,
        retryAllowed: false,
        markerPersisted: true,
        blockers: [
          {
            adId: NATIVE_AD_ID_1,
            code: "provider_verification_persistence_failed",
            reconciliationRequired: true,
            retryAllowed: false,
            markerPersisted: true,
          },
        ],
      },
    });
    expect(payload.error).not.toHaveProperty("providerMutationSucceeded");
    expect(payload.error.blockers[0]).not.toHaveProperty(
      "providerMutationSucceeded",
    );
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      outcome: "provider_outcome_ambiguous",
      providerOutcomeAmbiguous: true,
    },
    {
      outcome: "pre_provider_terminal_persistence_failed",
      providerOutcomeAmbiguous: false,
    },
  ] as const)(
    "does not overstate provider success for a $outcome preflight marker",
    async ({ outcome, providerOutcomeAmbiguous }) => {
      const retryBody = decisionBody();
      retryBody.ads = retryBody.ads.slice(0, 1);
      vi.mocked(
        decisionPreflight.runServerDecisionOriginAdActionPreflight,
      ).mockResolvedValue({
        ok: false,
        disposition: "duplicate",
        shouldMutate: false,
        blockers: [],
        errorCode: null,
        duplicateReceipt: {
          actionLogId: "decision_log_1",
          businessId: BUSINESS_ID,
          providerAccountId: "act_123",
          adId: NATIVE_AD_ID_1,
          creativeId: "creative_1",
          snapshotId: retryBody.ads[0]!.snapshotId,
          evaluationId: retryBody.ads[0]!.evaluationId,
          engineVersion: retryBody.ads[0]!.engineVersion,
          decisionHash: retryBody.ads[0]!.decisionHash,
          action: "pause",
          idempotencyKey: retryBody.ads[0]!.idempotencyKey,
          status: "pending",
          dryRun: false,
          providerVerified: false,
          treatmentEligible: false,
          errorCode: "provider_verification_persistence_failed",
          reconciliationRequired: true,
          reconciliationOutcome: outcome,
          providerMutationSucceeded: false,
          providerOutcomeAmbiguous,
          retryAllowed: false,
        },
        decisionAgeHours: null,
        currentAdStateAgeMinutes: null,
      });

      const response = await POST(request(retryBody));
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload.error).toMatchObject({
        code: "bulk_live_preflight_blocked",
        reconciliationRequired: true,
        retryAllowed: false,
        markerPersisted: true,
        ...(providerOutcomeAmbiguous
          ? { providerOutcomeAmbiguous: true }
          : {}),
      });
      expect(payload.error).not.toHaveProperty("providerMutationSucceeded");
      expect(payload.error.blockers[0]).not.toHaveProperty(
        "providerMutationSucceeded",
      );
      expect(adsWrite.pauseAd).not.toHaveBeenCalled();
      expect(
        actionLog.createDecisionOriginMetaAdsActionLog,
      ).not.toHaveBeenCalled();
    },
  );

  it("quarantines an old different-key pending attempt before every bulk provider read and write", async () => {
    vi.mocked(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).mockImplementation(async ({ adId }) =>
      adId === NATIVE_AD_ID_1
        ? ({
            id: "old_pending_log",
            source: "decision_origin",
            businessId: BUSINESS_ID,
            providerAccountId: "act_123",
            adId,
            creativeId: "creative_1",
            snapshotId: "00000000-0000-4000-8000-000000000091",
            evaluationId: "00000000-0000-4000-8000-000000000092",
            engineVersion: "v3-ad-2026-07-12-native-provenance-shadow",
            decisionHash: "a".repeat(64),
            action: "resume",
            idempotencyKey: "different-old-canonical-key",
            status: "pending",
            dryRun: false,
            providerVerified: false,
            treatmentEligible: false,
            errorCode: null,
            reconciliationRequired: false,
            retryAllowed: null,
          } as never)
        : null,
    );

    const response = await POST(request(decisionBody()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toMatchObject({
      code: "bulk_reconciliation_required",
      reconciliationRequired: true,
      retryAllowed: false,
      blockers: [
        expect.objectContaining({
          adId: NATIVE_AD_ID_1,
          code: "decision_origin_pending_reconciliation_required",
          reconciliationRequired: true,
          retryAllowed: false,
          blockingActionLogId: "old_pending_log",
          blockingOrigin: "native_decision_v1",
        }),
      ],
    });
    expect(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("returns action_in_flight for an unmarked native same-key pending receipt", async () => {
    const native = decisionBody();
    native.ads = native.ads.slice(0, 1);
    vi.mocked(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).mockResolvedValue({
      id: "same_key_pending",
      source: "decision_origin",
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: NATIVE_AD_ID_1,
      creativeId: "creative_1",
      snapshotId: native.ads[0]!.snapshotId,
      evaluationId: native.ads[0]!.evaluationId,
      engineVersion: native.ads[0]!.engineVersion,
      decisionHash: native.ads[0]!.decisionHash,
      action: "pause",
      idempotencyKey: native.ads[0]!.idempotencyKey,
      status: "pending",
      errorCode: null,
      payloadResponse: null,
    } as never);

    const response = await POST(request(native));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toMatchObject({
      code: "bulk_action_in_flight",
      retryAllowed: false,
      blockers: [
        expect.objectContaining({
          adId: NATIVE_AD_ID_1,
          code: "action_in_flight",
          blockingActionLogId: "same_key_pending",
          blockingOrigin: "native_decision_v1",
          retryAllowed: false,
        }),
      ],
    });
    expect(payload.error).not.toHaveProperty("reconciliationRequired");
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("preserves a same-key reconciliation marker's common error code", async () => {
    const native = decisionBody();
    native.ads = native.ads.slice(0, 1);
    vi.mocked(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).mockResolvedValue({
      id: "same_key_marked",
      source: "decision_origin",
      businessId: BUSINESS_ID,
      providerAccountId: "act_123",
      adId: NATIVE_AD_ID_1,
      creativeId: "creative_1",
      snapshotId: native.ads[0]!.snapshotId,
      evaluationId: native.ads[0]!.evaluationId,
      engineVersion: native.ads[0]!.engineVersion,
      decisionHash: native.ads[0]!.decisionHash,
      action: "pause",
      idempotencyKey: native.ads[0]!.idempotencyKey,
      status: "pending",
      errorCode: "provider_verification_persistence_failed",
      payloadResponse: {
        decision_origin_reconciliation: {
          reconciliation_required: true,
          retry_allowed: false,
          outcome: "pre_provider_terminal_persistence_failed",
          provider_mutation_succeeded: false,
        },
      },
    } as never);

    const response = await POST(request(native));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toMatchObject({
      code: "bulk_reconciliation_required",
      reconciliationRequired: true,
      retryAllowed: false,
      blockers: [
        expect.objectContaining({
          code: "provider_verification_persistence_failed",
          blockingActionLogId: "same_key_marked",
          blockingOrigin: "native_decision_v1",
          reconciliationRequired: true,
        }),
      ],
    });
    expect(payload.error).not.toHaveProperty("providerMutationSucceeded");
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("keeps a marked native pending row as action_in_flight for a manual batch", async () => {
    vi.mocked(
      actionLog.findUnresolvedMetaAdStatusActionLog,
    ).mockImplementation(async ({ adId }) =>
      adId === "ad_1"
        ? ({
            id: "marked_native_pending",
            source: "decision_origin",
            businessId: BUSINESS_ID,
            providerAccountId: "act_123",
            adId: "ad_1",
            creativeId: "creative_1",
            action: "pause",
            idempotencyKey: "native-key",
            status: "pending",
            errorCode: "provider_verification_persistence_failed",
            payloadResponse: {
              decision_origin_reconciliation: {
                reconciliation_required: true,
                retry_allowed: false,
                outcome: "provider_outcome_ambiguous",
                provider_mutation_succeeded: false,
                provider_outcome_ambiguous: true,
              },
            },
          } as never)
        : null,
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toMatchObject({
      code: "bulk_action_in_flight",
      reconciliationRequired: true,
      retryAllowed: false,
      providerOutcomeAmbiguous: true,
      blockers: [
        expect.objectContaining({
          adId: "ad_1",
          code: "action_in_flight",
          blockingActionLogId: "marked_native_pending",
          blockingOrigin: "native_decision_v1",
          reconciliationRequired: true,
          providerOutcomeAmbiguous: true,
        }),
      ],
    });
    expect(payload.error).not.toHaveProperty("providerMutationSucceeded");
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("halts a create-time idempotency race on a pending reconciliation marker", async () => {
    vi.mocked(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).mockResolvedValueOnce({
      id: "decision_log_1",
      status: "pending",
      errorCode: "provider_verification_persistence_failed",
      payloadResponse: {
        decision_origin_reconciliation: {
          reconciliation_required: true,
          retry_allowed: false,
          outcome:
            "provider_write_verified_receipt_persistence_failed",
          provider_mutation_attempted: true,
          provider_mutation_succeeded: true,
          provider_outcome_ambiguous: false,
        },
      },
      idempotentReplay: true,
    } as never);

    const response = await POST(request(decisionBody()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "bulk_reconciliation_required",
        blockers: [
          expect.objectContaining({
            adId: NATIVE_AD_ID_1,
            code: "provider_verification_persistence_failed",
            reconciliationRequired: true,
            retryAllowed: false,
            providerMutationSucceeded: true,
            markerPersisted: true,
          }),
        ],
        reconciliationRequired: true,
        retryAllowed: false,
        providerMutationSucceeded: true,
        markerPersisted: true,
      },
    });
    expect(payload.error).not.toHaveProperty("receipt");
    expect(payload.error).not.toHaveProperty("payloadResponse");
    expect(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledTimes(1);
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    expect(
      actionLog.completeDecisionOriginMetaAdsActionLog,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "failure",
      errorCode: "idempotent_action_failed",
    },
    {
      status: "success",
      errorCode: "idempotent_receipt_not_treatment_eligible",
    },
  ] as const)(
    "halts a create-time terminal $status replay before later provider writes",
    async ({ status, errorCode }) => {
      vi.mocked(
        actionLog.createDecisionOriginMetaAdsActionLog,
      ).mockResolvedValueOnce({
        id: "decision_log_1",
        status,
        idempotentReplay: true,
      } as never);

      const response = await POST(request(decisionBody()));
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload).toMatchObject({
        ok: false,
        error: {
          code: "bulk_action_in_flight",
          blockers: [
            expect.objectContaining({
              adId: NATIVE_AD_ID_1,
              code: errorCode,
              retryAllowed: false,
            }),
          ],
          retryAllowed: false,
        },
      });
      expect(
        actionLog.createDecisionOriginMetaAdsActionLog,
      ).toHaveBeenCalledTimes(1);
      expect(adsWrite.pauseAd).not.toHaveBeenCalled();
      expect(
        actionLog.completeDecisionOriginMetaAdsActionLog,
      ).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed manual item dryRun before every read/log/write", async () => {
    const manual = body();
    const response = await POST(
      request({
        ...manual,
        ads: [{ ...manual.ads[0]!, dryRun: "true" }],
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_decision_origin_batch");
    expect(payload.error.blockers).toContainEqual(
      expect.objectContaining({ adId: "ad_1", code: "invalid_dry_run" }),
    );
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(actionLog.resolveExactMetaAdActionTarget).not.toHaveBeenCalled();
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(actionLog.createMetaAdsActionLog).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("honors manual item dryRun without presenting or logging a live write", async () => {
    const manual = body();
    const dryRunItem = { ...manual.ads[0]!, dryRun: true };
    vi.mocked(adsWrite.pauseAd).mockReset().mockResolvedValue({
      ok: true,
      verifiedStatus: "PAUSED",
      dryRun: true,
      wouldHaveWritten: {
        method: "POST",
        path: "ad_1",
        body: { status: "PAUSED" },
      },
      responsePayload: {
        dryRun: true,
        wouldHaveWritten: {
          method: "POST",
          path: "ad_1",
          body: { status: "PAUSED" },
        },
      },
      verificationPayload: { id: "ad_1", status: "ACTIVE" },
    } as never);

    const response = await POST(
      request({
        ...manual,
        ads: [dryRunItem],
        idempotencyKey: "manual-dry-run",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(adsWrite.pauseAd).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "act_123" }),
      "ad_1",
      { dryRun: true },
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "manual_operator_v1",
        payloadRequest: expect.objectContaining({ dry_run: true }),
      }),
    );
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "success",
        verifiedAt: null,
        payloadResponse: expect.objectContaining({ dryRun: true }),
      }),
    );
    expect(payload).toMatchObject({
      ok: true,
      action: "pause",
      status: null,
      dryRun: true,
      executionMode: "dry_run",
      successCount: 1,
      failedCount: 0,
      results: [
        {
          inputAdId: "ad_1",
          adId: "ad_1",
          ok: true,
          dryRun: true,
          wouldHaveWritten: {
            method: "POST",
            path: "ad_1",
            body: { status: "PAUSED" },
          },
        },
      ],
      steps: [
        {
          kind: "ad",
          status: "success",
          dryRun: true,
          wouldHaveWritten: {
            method: "POST",
            path: "ad_1",
            body: { status: "PAUSED" },
          },
        },
      ],
    });
    expect(payload.results[0]).not.toHaveProperty("status");
    expect(payload.steps[0]).not.toHaveProperty("adsManagerUrl");
    expect(
      manualReconciliation.reconcileManualMetaAdStatusBlocker,
    ).not.toHaveBeenCalled();
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).not.toHaveBeenCalled();
    const dryRunClaim = vi.mocked(
      actionLog.createMetaAdsActionLog,
    ).mock.calls[0]?.[0];
    expect(dryRunClaim?.payloadRequest).not.toHaveProperty(
      "mutation_journal_contract_version",
    );
  });

  it("halts a mixed manual batch after a dry-run just-in-time failure", async () => {
    const manual = body();
    const mixedManual = {
      ...manual,
      ads: manual.ads.map((ad, index) =>
        index === 0 ? { ...ad, dryRun: true } : ad
      ),
    };
    mockPauseAdResultsAfterHook(
      {
        ok: false,
        error: {
          code: "current_ad_state_unverified",
          message: "Current Ad state could not be verified.",
        },
        responsePayload: null,
      },
      {
        ok: true,
        verifiedStatus: "PAUSED",
        responsePayload: { success: true },
        verificationPayload: { id: "ad_2", status: "PAUSED" },
      },
    );

    const response = await POST(request(mixedManual));
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      successCount: 0,
      failedCount: 1,
      dryRun: false,
      executionMode: "mixed",
      haltedReason: {
        code: "current_ad_state_unverified",
      },
      results: [
        expect.objectContaining({
          inputAdId: "ad_1",
          ok: false,
          dryRun: true,
          error: expect.objectContaining({
            code: "current_ad_state_unverified",
          }),
        }),
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(adsWrite.pauseAd).toHaveBeenCalledWith(
      expect.anything(),
      "ad_1",
      { dryRun: true },
    );
    expect(actionLog.createMetaAdsActionLog).toHaveBeenCalledTimes(2);
  });

  it("honors native item dryRun and binds it into the decision request", async () => {
    const native = decisionBody();
    const { idempotencyKey: _idempotencyKey, name, ...base } = native.ads[0]!;
    const dryRunBase = { ...base, dryRun: true as const };
    native.ads = [
      {
        ...dryRunBase,
        idempotencyKey:
          createDecisionOriginAdActionIdempotencyKey(dryRunBase),
        name,
      },
    ];
    vi.mocked(adsWrite.pauseAd).mockReset().mockResolvedValue({
      ok: true,
      verifiedStatus: "PAUSED",
      dryRun: true,
      wouldHaveWritten: {
        method: "POST",
        path: NATIVE_AD_ID_1,
        body: { status: "PAUSED" },
      },
      responsePayload: { dryRun: true },
      verificationPayload: { id: NATIVE_AD_ID_1, status: "ACTIVE" },
    } as never);

    const response = await POST(request(native));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          adId: NATIVE_AD_ID_1,
          dryRun: true,
        }),
        payloadRequest: expect.objectContaining({ dry_run: true }),
      }),
    );
    expect(adsWrite.pauseAd).toHaveBeenCalledWith(
      expect.anything(),
      NATIVE_AD_ID_1,
      { dryRun: true },
    );
    expect(payload).toMatchObject({
      ok: true,
      status: null,
      dryRun: true,
      executionMode: "dry_run",
      results: [
        {
          adId: NATIVE_AD_ID_1,
          ok: true,
          dryRun: true,
        },
      ],
    });
    expect(payload.results[0]).not.toHaveProperty("status");
  });

  it("halts a mixed native batch after a dry-run just-in-time failure", async () => {
    const native = decisionBody();
    const { idempotencyKey: _idempotencyKey, name, ...base } = native.ads[0]!;
    const dryRunBase = { ...base, dryRun: true as const };
    native.ads[0] = {
      ...dryRunBase,
      idempotencyKey: createDecisionOriginAdActionIdempotencyKey(dryRunBase),
      name,
    };
    mockPauseAdResultsAfterHook(
      {
        ok: false,
        error: {
          code: "current_ad_state_unverified",
          message: "Current Ad state could not be verified.",
        },
        responsePayload: null,
      },
      {
        ok: true,
        verifiedStatus: "PAUSED",
        responsePayload: { success: true },
        verificationPayload: { id: NATIVE_AD_ID_2, status: "PAUSED" },
      },
    );

    const response = await POST(request(native));
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      successCount: 0,
      failedCount: 1,
      dryRun: false,
      executionMode: "mixed",
      haltedReason: {
        code: "current_ad_state_unverified",
      },
      results: [
        expect.objectContaining({
          inputAdId: NATIVE_AD_ID_1,
          ok: false,
          dryRun: true,
          error: expect.objectContaining({
            code: "current_ad_state_unverified",
          }),
        }),
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(adsWrite.pauseAd).toHaveBeenCalledWith(
      expect.anything(),
      NATIVE_AD_ID_1,
      { dryRun: true },
    );
    expect(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a terminal native receipt that is not treatment eligible", async () => {
    const native = decisionBody();
    const { idempotencyKey: _idempotencyKey, name, ...base } = native.ads[0]!;
    const dryRunBase = { ...base, dryRun: true as const };
    const dryRunItem = {
      ...dryRunBase,
      idempotencyKey: createDecisionOriginAdActionIdempotencyKey(dryRunBase),
      name,
    };
    native.ads = [dryRunItem];
    vi.mocked(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).mockResolvedValue({
      ok: true,
      disposition: "duplicate",
      shouldMutate: false,
      blockers: [],
      errorCode: null,
      duplicateReceipt: {
        actionLogId: "decision_log_dry_run",
        businessId: BUSINESS_ID,
        providerAccountId: "act_123",
        adId: NATIVE_AD_ID_1,
        creativeId: "creative_1",
        snapshotId: dryRunItem.snapshotId,
        evaluationId: dryRunItem.evaluationId,
        engineVersion: dryRunItem.engineVersion,
        decisionHash: dryRunItem.decisionHash,
        action: "pause",
        idempotencyKey: dryRunItem.idempotencyKey,
        status: "success",
        dryRun: true,
        providerVerified: false,
        treatmentEligible: false,
      },
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    });

    const response = await POST(request(native));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: "bulk_live_preflight_blocked",
        blockers: [
          {
            adId: NATIVE_AD_ID_1,
            code: "idempotent_receipt_not_treatment_eligible",
          },
        ],
      },
    });
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    expect(actionLog.createDecisionOriginMetaAdsActionLog).not.toHaveBeenCalled();
  });

  it("rejects malformed item dryRun before live preflight or provider write", async () => {
    const malformed = decisionBody();
    malformed.ads[0] = { ...malformed.ads[0]!, dryRun: "true" } as never;

    const response = await POST(request(malformed));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("invalid_decision_origin_batch");
    expect(payload.error.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adId: NATIVE_AD_ID_1,
          code: "invalid_dry_run",
        }),
      ]),
    );
    expect(
      decisionPreflight.runServerDecisionOriginAdActionPreflight,
    ).not.toHaveBeenCalled();
    expect(access.requireBusinessAccess).not.toHaveBeenCalled();
    expect(
      validation.resolveAssignedMetaLaunchAccount,
    ).not.toHaveBeenCalled();
    expect(adsWrite.readMetaAdExecutionState).not.toHaveBeenCalled();
    expect(
      actionLog.createDecisionOriginMetaAdsActionLog,
    ).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("halts after the first definite provider failure and omits later writes", async () => {
    const mutationAttempt = {
      attemptCount: 1 as const,
      method: "POST" as const,
      path: "ad_1",
      attemptedAt: "2026-07-18T15:00:00.000Z",
      completedAt: "2026-07-18T15:00:01.000Z",
      providerResponseReceived: true,
      providerResponseSuccessful: false,
      httpStatus: 400,
      outcome: "provider_response_received" as const,
      automaticRetryAttempted: false as const,
      transportError: null,
    };
    mockPauseAdResultsAfterHook(
      {
        ok: false,
        httpStatus: 400,
        providerOutcome: "definite_failure",
        mutationAttempt,
        error: { code: "100", message: "Cannot pause ad." },
        responsePayload: { error: { code: 100 } },
      },
      {
        ok: true,
        verifiedStatus: "PAUSED",
        responsePayload: { success: true },
        verificationPayload: { id: "ad_2", status: "PAUSED" },
      },
    );

    const response = await POST(request({ ...body(), idempotencyKey: "bulk_2" }));
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.ok).toBe(false);
    expect(payload.failedCount).toBe(1);
    expect(payload.successCount).toBe(0);
    expect(payload.halted).toBe(true);
    expect(payload.haltedReason).toEqual({
      code: "100",
      message: "Cannot pause ad.",
    });
    expect(payload.omittedCount).toBe(1);
    expect(payload.results).toEqual([
      {
        inputAdId: "ad_1",
        adId: "ad_1",
        creativeId: "creative_1",
        ok: false,
        attemptedIds: ["ad_1"],
        providerOutcome: "definite_failure",
        mutationAttempt,
        error: { code: "100", message: "Cannot pause ad." },
      },
    ]);
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
  });

  it("durably aborts every untouched later manual claim after a provider failure", async () => {
    const threeAds = body();
    threeAds.ads.push({
      adId: "ad_3",
      providerAccountId: "act_123",
      creativeId: "creative_3",
      name: "Creative 3",
    });
    mockPauseAdResultsAfterHook({
      ok: false,
      httpStatus: 400,
      providerOutcome: "definite_failure",
      mutationAttempt: liveMutationAttempt("ad_1", {
        providerResponseSuccessful: false,
        httpStatus: 400,
      }),
      error: { code: "100", message: "Cannot pause ad." },
      responsePayload: { error: { code: 100 } },
    });

    const response = await POST(
      request({ ...threeAds, idempotencyKey: "bulk_manual_three_halt" }),
    );

    expect(response.status).toBe(502);
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    for (const logId of ["log_2", "log_3"]) {
      expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
        expect.objectContaining({
          id: logId,
          status: "failure",
          errorCode: "bulk_execution_halted_before_provider",
          payloadResponse: {
            bulk_pre_provider_abort: {
              code: "bulk_execution_halted_before_provider",
              provider_mutation_attempted: false,
            },
          },
        }),
      );
    }
  });

  it("durably aborts every untouched later native claim after a provider failure", async () => {
    const native = decisionBody();
    const thirdBase = {
      ...native.ads[0]!,
      adId: NATIVE_AD_ID_3,
      creativeId: "creative_3",
      snapshotId: "00000000-0000-4000-8000-000000000013",
      evaluationId: "00000000-0000-4000-8000-000000000023",
      decisionHash: "3".repeat(64),
      name: "Creative 3",
    };
    native.ads.push({
      ...thirdBase,
      idempotencyKey: createDecisionOriginAdActionIdempotencyKey(thirdBase),
    });
    vi.mocked(adsWrite.pauseAd).mockReset().mockResolvedValueOnce({
      ok: false,
      httpStatus: 400,
      providerOutcome: "definite_failure",
      mutationAttempt: liveMutationAttempt(NATIVE_AD_ID_1, {
        providerResponseSuccessful: false,
        httpStatus: 400,
      }),
      error: { code: "100", message: "Cannot pause ad." },
      responsePayload: { error: { code: 100 } },
    } as never);

    const response = await POST(request(native));

    expect(response.status).toBe(502);
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    for (const logId of ["decision_log_2", "decision_log_3"]) {
      expect(
        actionLog.completeDecisionOriginMetaAdsActionLog,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          id: logId,
          status: "failure",
          errorCode: "bulk_execution_halted_before_provider",
          payloadResponse: {
            bulk_pre_provider_abort: {
              code: "bulk_execution_halted_before_provider",
              provider_mutation_attempted: false,
            },
          },
        }),
      );
    }
  });

  it("halts and omits later writes when a successful status POST cannot be verified", async () => {
    const mutationAttempt = {
      attemptCount: 1 as const,
      method: "POST" as const,
      path: "ad_1",
      attemptedAt: "2026-07-18T15:00:00.000Z",
      completedAt: "2026-07-18T15:00:01.000Z",
      providerResponseReceived: true,
      providerResponseSuccessful: true,
      httpStatus: 200,
      outcome: "provider_response_received" as const,
      automaticRetryAttempted: false as const,
      transportError: null,
    };
    mockPauseAdResultsAfterHook(
      {
        ok: false,
        httpStatus: 502,
        providerOutcome: "definite_failure",
        mutationAttempt,
        error: {
          code: "network_error",
          message: "verification connection reset",
        },
        responsePayload: { success: true },
        verificationPayload: null,
      },
      {
        ok: true,
        verifiedStatus: "PAUSED",
      },
    );

    const response = await POST(
      request({ ...body(), idempotencyKey: "bulk_post_verify_failure" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      failedCount: 1,
      successCount: 0,
      halted: true,
      omittedCount: 1,
      haltedReason: {
        code: "network_error",
        message: "verification connection reset",
        reconciliationRequired: true,
        providerMutationSucceeded: true,
      },
      results: [
        {
          inputAdId: "ad_1",
          ok: false,
          providerOutcome: "definite_failure",
          mutationAttempt,
          reconciliationRequired: true,
          retryAllowed: false,
          providerMutationSucceeded: true,
          error: { code: "network_error" },
        },
      ],
      steps: [
        {
          kind: "ad",
          status: "silent_failure",
          mutationAttempt,
          reconciliationRequired: true,
          retryAllowed: false,
          providerMutationSucceeded: true,
          error: { code: "network_error" },
        },
      ],
    });
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "silent_failure",
        errorCode: "network_error",
        payloadResponse: { success: true },
        verifiedAt: null,
        verificationPayload: {
          verification_error: {
            code: "network_error",
            message: "verification connection reset",
          },
        },
      }),
    );
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
  });

  it("halts after an ambiguous POST and persists the unknown outcome receipt", async () => {
    mockPauseAdResultsAfterHook(
      {
        ok: false,
        httpStatus: 502,
        providerOutcome: "outcome_ambiguous",
        error: {
          code: "provider_outcome_ambiguous",
          message:
            "Meta POST transport failed after the single mutation attempt began.",
        },
        mutationAttempt: {
          attemptCount: 1,
          method: "POST",
          path: "ad_1",
          attemptedAt: "2026-07-18T15:00:00.000Z",
          completedAt: "2026-07-18T15:00:01.000Z",
          providerResponseReceived: false,
          httpStatus: null,
          outcome: "outcome_ambiguous",
          automaticRetryAttempted: false,
          transportError: {
            code: "network_error",
            message: "connection closed after request upload",
          },
        },
        responsePayload: {
          provider_outcome: "outcome_ambiguous",
          reconciliation_required: true,
          retry_disposition:
            "do_not_retry_before_exact_provider_reconciliation",
        },
      },
      {
        ok: true,
        verifiedStatus: "PAUSED",
      },
    );

    const response = await POST(
      request({ ...body(), idempotencyKey: "bulk_ambiguous" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      haltedReason: {
        code: "provider_outcome_ambiguous",
        reconciliationRequired: true,
        providerOutcomeAmbiguous: true,
      },
      results: [
        {
          inputAdId: "ad_1",
          ok: false,
          providerOutcome: "outcome_ambiguous",
          reconciliationRequired: true,
          providerOutcomeAmbiguous: true,
          retryAllowed: false,
          error: { code: "provider_outcome_ambiguous" },
        },
      ],
      steps: [
        {
          kind: "ad",
          status: "silent_failure",
          providerOutcome: "outcome_ambiguous",
          reconciliationRequired: true,
          providerOutcomeAmbiguous: true,
          retryAllowed: false,
        },
      ],
    });
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "silent_failure",
        errorCode: "provider_outcome_ambiguous",
        payloadResponse: null,
        verificationPayload: null,
        verifiedAt: null,
      }),
    );
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
  });

  it("terminalizes a raw manual adapter throw before the hook as an exact zero-write failure", async () => {
    vi.mocked(adsWrite.pauseAd)
      .mockReset()
      .mockRejectedValueOnce(new Error("unexpected provider adapter throw"));

    const response = await POST(
      request({ ...body(), idempotencyKey: "bulk_raw_throw" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      successCount: 0,
      failedCount: 1,
      haltedReason: {
        code: "provider_write_unexpected_exception",
        retryAllowed: false,
      },
      results: [
        {
          inputAdId: "ad_1",
          ok: false,
          providerWriteAttempted: false,
          retryAllowed: false,
          error: {
            code: "provider_write_unexpected_exception",
          },
        },
      ],
      steps: [
        {
          kind: "ad",
          status: "failure",
          providerWriteAttempted: false,
          retryAllowed: false,
        },
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptStarted,
    ).not.toHaveBeenCalled();
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).not.toHaveBeenCalled();
    expect(
      actionLog.completeMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_1",
        status: "failure",
        errorCode: "provider_write_unexpected_exception",
        payloadResponse: {
          adapter_pre_provider_abort: {
            code: "provider_write_unexpected_exception",
            provider_mutation_attempted: false,
          },
        },
        verificationPayload: null,
        verifiedAt: null,
      }),
    );
    expect(
      actionLog.completeMetaAdsActionLog,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_2",
        status: "failure",
        errorCode: "bulk_execution_halted_before_provider",
      }),
    );
  });

  it("treats a raw manual dry-run throw as a definite 502 failure", async () => {
    vi.mocked(adsWrite.pauseAd)
      .mockReset()
      .mockRejectedValueOnce(new Error("unexpected dry-run adapter throw"));
    const dryRunBody = body();
    dryRunBody.ads = dryRunBody.ads.map((ad) => ({ ...ad, dryRun: true }));

    const response = await POST(
      request({ ...dryRunBody, idempotencyKey: "bulk_dry_run_raw_throw" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      successCount: 0,
      failedCount: 1,
      haltedReason: {
        code: "provider_write_unexpected_exception",
      },
      results: [
        {
          inputAdId: "ad_1",
          ok: false,
          dryRun: true,
          error: { code: "provider_write_unexpected_exception" },
        },
      ],
      steps: [
        {
          kind: "ad",
          status: "failure",
          dryRun: true,
          error: { code: "provider_write_unexpected_exception" },
        },
      ],
    });
    expect(payload.haltedReason).not.toHaveProperty(
      "providerOutcomeAmbiguous",
    );
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failure",
        errorCode: "provider_write_unexpected_exception",
        payloadResponse: expect.objectContaining({
          provider_write_exception: expect.objectContaining({
            mutation_attempted: false,
            outcome: "definite_failure",
          }),
        }),
      }),
    );
  });

  it("keeps a raw live throw on the immutable started-only reconciliation path", async () => {
    mockPauseAdResultsAfterHook(
      new Error("unexpected provider adapter throw"),
    );

    const response = await POST(
      request({ ...body(), idempotencyKey: "bulk_raw_throw_db_failure" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      haltedReason: {
        code: "provider_outcome_ambiguous",
        reconciliationRequired: true,
        retryAllowed: false,
      },
      results: [
        {
          inputAdId: "ad_1",
          ok: false,
          reconciliationRequired: true,
          retryAllowed: false,
          error: {
            code: "provider_outcome_ambiguous",
          },
        },
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(
      actionLog.appendManualMetaAdStatusMutationAttemptCompleted,
    ).not.toHaveBeenCalled();
    expect(
      vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls.some(
        ([completion]) => completion.id === "log_1",
      ),
    ).toBe(false);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_2",
        status: "failure",
        errorCode: "bulk_execution_halted_before_provider",
      }),
    );
  });

  it("halts after one verified manual success when terminal persistence fails twice", async () => {
    mockPauseAdResultsAfterHook({
        ok: true,
        verifiedStatus: "PAUSED",
        responsePayload: { success: true },
        verificationPayload: { id: "ad_1", status: "PAUSED" },
        mutationAttempt: liveMutationAttempt("ad_1"),
        providerHttpStatus: 200,
    });
    vi.mocked(actionLog.completeMetaAdsActionLog).mockImplementation(
      async (completion) => {
        if (completion.id === "log_1") {
          throw new Error("terminal persistence unavailable");
        }
        return { id: completion.id } as never;
      },
    );

    const response = await POST(
      request({ ...body(), idempotencyKey: "bulk_success_db_failure" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      successCount: 0,
      failedCount: 1,
      haltedReason: {
        code: "manual_success_terminal_persistence_failed",
        reconciliationRequired: true,
        providerMutationSucceeded: true,
        retryAllowed: false,
      },
      results: [
        {
          inputAdId: "ad_1",
          ok: false,
          reconciliationRequired: true,
          providerMutationSucceeded: true,
          retryAllowed: false,
          error: {
            code: "manual_success_terminal_persistence_failed",
          },
        },
      ],
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls.filter(
        ([completion]) => completion.id === "log_1",
      ),
    ).toHaveLength(2);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_2",
        status: "failure",
        errorCode: "bulk_execution_halted_before_provider",
      }),
    );
  });

  it("halts a definite manual rejection when failure persistence fails twice", async () => {
    mockPauseAdResultsAfterHook({
        ok: false,
        httpStatus: 400,
        providerOutcome: "definite_failure",
        error: { code: "100", message: "Cannot pause ad." },
        responsePayload: { error: { code: 100 } },
        mutationAttempt: liveMutationAttempt("ad_1", {
          providerResponseSuccessful: false,
          httpStatus: 400,
        }),
    });
    vi.mocked(actionLog.completeMetaAdsActionLog).mockImplementation(
      async (completion) => {
        if (completion.id === "log_1") {
          throw new Error("terminal persistence unavailable");
        }
        return { id: completion.id } as never;
      },
    );

    const response = await POST(
      request({ ...body(), idempotencyKey: "bulk_failure_db_failure" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      halted: true,
      omittedCount: 1,
      haltedReason: {
        code: "manual_failure_terminal_persistence_failed",
        reconciliationRequired: true,
        retryAllowed: false,
      },
    });
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(1);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(actionLog.completeMetaAdsActionLog).mock.calls.filter(
        ([completion]) => completion.id === "log_1",
      ),
    ).toHaveLength(2);
    expect(actionLog.completeMetaAdsActionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "log_2",
        status: "failure",
        errorCode: "bulk_execution_halted_before_provider",
      }),
    );
  });

  it("does not write an ad resolved outside the selected provider account", async () => {
    vi.mocked(actionLog.resolveExactMetaAdActionTarget).mockImplementation(
      async (input) => ({
        ok: true,
        target: {
          businessId: BUSINESS_ID,
          adId: input.adId,
          creativeId: input.adId === "ad_1" ? "creative_1" : "creative_2",
          providerAccountId: input.adId === "ad_1" ? "act_123" : "act_456",
        },
      }) as never,
    );

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error.code).toBe("bulk_target_preflight_blocked");
    expect(payload.error.blockers).toContainEqual({
      adId: "ad_2",
      code: "provider_account_mismatch",
    });
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("keeps synthetic and creative fallback candidates review-only", async () => {
    const response = await POST(
      request({
        actionOrigin: "manual_operator_v1",
        manualConfirmation: "explicit_operator_confirmation",
        businessId: BUSINESS_ID,
        action: "pause",
        ads: [
          {
            adId: "stale_row_id",
            providerAccountId: "act_123",
            candidateAdIds: ["stale_row_id", "real_ad_1", "creative_1"],
            creativeId: "creative_1",
            name: "Creative 1",
          },
        ],
        idempotencyKey: "bulk_fallback",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatchObject({
      code: "invalid_decision_origin_batch",
      blockers: [
        {
          adId: "stale_row_id",
          code: "exact_ad_authority_required",
        },
      ],
    });
    expect(actionLog.resolveExactMetaAdActionTarget).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });

  it("resumes selected ads", async () => {
    mockManualLiveStatus("PAUSED");
    const response = await POST(
      request({ ...body(), action: "resume", idempotencyKey: "bulk_3" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ACTIVE");
    expect(adsWrite.resumeAd).toHaveBeenCalledTimes(2);
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
    expect(actionLog.readLaunchpadCreatedAdIds).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      adIds: ["ad_1", "ad_2"],
    });
    expect(validation.validateMetaBulkResumePreflight).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized batches before resolving provider context", async () => {
    const response = await POST(
      request({
        ...body(),
        ads: Array.from({ length: 21 }, (_, index) => ({
          adId: `ad_${index + 1}`,
        })),
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("bulk_limit_exceeded");
    expect(validation.resolveMetaLaunchWriteContext).not.toHaveBeenCalled();
  });

  it("blocks resume outside the verified Launchpad-created scope", async () => {
    mockManualLiveStatus("PAUSED");
    vi.mocked(actionLog.readLaunchpadCreatedAdIds).mockResolvedValue(
      new Set(["ad_1"]),
    );

    const response = await POST(
      request({ ...body(), action: "resume", idempotencyKey: "bulk_scope" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe("resume_scope_blocked");
    expect(adsWrite.resumeAd).not.toHaveBeenCalled();
  });

  it("blocks the whole resume batch when live preflight fails", async () => {
    mockManualLiveStatus("PAUSED");
    vi.mocked(validation.validateMetaBulkResumePreflight).mockResolvedValue({
      ok: false,
      blockers: [{ code: "billing_not_ok", message: "Billing is not active." }],
    });

    const response = await POST(
      request({ ...body(), action: "resume", idempotencyKey: "bulk_preflight" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe("resume_preflight_blocked");
    expect(adsWrite.resumeAd).not.toHaveBeenCalled();
  });

  it("halts the batch when the kill switch engages between mutations", async () => {
    let adapterCallCount = 0;
    vi.mocked(adsWrite.pauseAd).mockReset().mockImplementation(
      async (_ctx, adId, options) => {
        adapterCallCount += 1;
        if (adapterCallCount === 2) {
          return {
            ok: false,
            httpStatus: 503,
            providerMutationAttempted: false,
            error: {
              code: "kill_switch_engaged",
              message: "Owner stopped Meta writes.",
            },
          } as never;
        }
        const blocked = await runBeforeMutationAttemptHook(
          adId,
          options,
        );
        if (blocked) return blocked as never;
        simulatedProviderPostIds.push(adId);
        return {
          ok: true,
          verifiedStatus: "PAUSED",
          responsePayload: { success: true },
          verificationPayload: {
            id: "ad_1",
            status: "PAUSED",
            observedAt: "2026-07-18T14:00:01.000Z",
          },
          mutationAttempt: liveMutationAttempt("ad_1"),
          providerHttpStatus: 200,
        } as never;
      },
    );
    const requestBody = body();
    requestBody.ads.push({
      adId: "ad_3",
      providerAccountId: "act_123",
      creativeId: "creative_3",
      name: "Creative 3",
    });

    const response = await POST(request(requestBody));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.halted).toBe(true);
    expect(payload.omittedCount).toBe(1);
    expect(adsWrite.pauseAd).toHaveBeenCalledTimes(2);
  });

  it("blocks bulk status writes before provider context or target resolution", async () => {
    vi.mocked(writeGuard.readMetaWritePosture).mockResolvedValueOnce({
      // The route reads the whole posture now: blocked, plus whether the
      // business is rehearsing. A blocked posture refuses at the same point.
      blocked: true,
      rehearsal: true,
      reason: "business_kill_switch",
      message: "Meta writes are disabled by kill switch.",
    });

    const response = await POST(request(body()));
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload.error.code).toBe("kill_switch_engaged");
    expect(validation.resolveMetaLaunchWriteContext).not.toHaveBeenCalled();
    expect(actionLog.resolveMetaAdActionTarget).not.toHaveBeenCalled();
    expect(adsWrite.pauseAd).not.toHaveBeenCalled();
  });
});
