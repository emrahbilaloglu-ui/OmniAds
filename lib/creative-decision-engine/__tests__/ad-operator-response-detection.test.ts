import { describe, expect, it } from "vitest";

import {
  NATIVE_AD_DELIVERY_OBSERVATION_CONTRACT_VERSION,
  NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION,
  buildAdRecommendationEpisode,
  buildExactMetaAdsActionReceiptHash,
  detectAdOperatorResponse,
  type AdEntityStateObservation,
  type AdEntityTombstoneObservation,
  type AdRecommendationEpisode,
  type ExactMetaAdsActionLineage,
} from "../ad-operator-response-detection";
import { DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION } from "../execution-safety";
import { NATIVE_AD_ENGINE_VERSION } from "../types";

const RECOMMENDED_AT = "2026-07-12T03:00:00.000Z";
const CUTOFF = "2026-07-13T03:00:00.000Z";

function episode(input: {
  businessId?: string;
  providerAccountId?: string;
  adId?: string;
  creativeId?: string | null;
  snapshotId?: string;
  evaluationId?: string;
} = {}): AdRecommendationEpisode {
  const adId = input.adId ?? "ad-a";
  return buildAdRecommendationEpisode({
    businessId: input.businessId ?? "business-a",
    businessDisplayId: input.businessId ?? "business-a",
    providerAccountRefId: "provider-ref-a",
    providerAccountId: input.providerAccountId ?? "act-a",
    adId,
    creativeId:
      input.creativeId === undefined ? "shared-creative" : input.creativeId,
    asOfDate: "2026-07-12",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    scopeType: "account",
    scopeId: "*",
    snapshotId: input.snapshotId ?? `snapshot-${adId}`,
    evaluationId: input.evaluationId ?? `evaluation-${adId}`,
    inputHash: "1".repeat(64),
    decisionHash: "2".repeat(64),
    decisionLabel: "cut",
    sourceCampaignId: "campaign-a",
    sourceAdsetId: "adset-a",
    recommendedAt: RECOMMENDED_AT,
  });
}

function action(
  target: AdRecommendationEpisode,
  input: Partial<ExactMetaAdsActionLineage> = {},
): ExactMetaAdsActionLineage {
  const semantic = input.action ?? "pause";
  const resultingAdId = input.resultingAdId ?? null;
  const targetEntityId =
    input.targetEntityId ??
    (semantic === "duplicate" || semantic === "rebuild"
      ? resultingAdId ?? "ad-successor"
      : target.adId);
  const { receiptHash: receiptHashOverride, ...overrides } = input;
  const receipt: Omit<ExactMetaAdsActionLineage, "receiptHash"> = {
    receiptId:
      overrides.receiptId ?? `receipt-${input.actionLogId ?? semantic}`,
    actionLogId: input.actionLogId ?? `log-${semantic}`,
    contractVersion:
      input.contractVersion ?? DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: input.businessId ?? target.businessId,
    providerAccountRefId:
      input.providerAccountRefId ?? target.providerAccountRefId,
    providerAccountId:
      input.providerAccountId ?? target.providerAccountId,
    sourceAdId: input.sourceAdId ?? target.adId,
    sourceSnapshotId: input.sourceSnapshotId ?? target.snapshotId,
    sourceEvaluationId: input.sourceEvaluationId ?? target.evaluationId,
    sourceEngineVersion: input.sourceEngineVersion ?? target.engineVersion,
    sourceDecisionHash: input.sourceDecisionHash ?? target.decisionHash,
    targetEntityType: input.targetEntityType ?? "ad",
    targetEntityId,
    action: semantic,
    successorKind: input.successorKind ?? null,
    resultingAdId,
    idempotencyKey: input.idempotencyKey ?? `idem-${semantic}`,
    status: input.status ?? "success",
    dryRun: input.dryRun ?? false,
    providerVerified: input.providerVerified ?? true,
    requestedAt: input.requestedAt ?? "2026-07-12T04:00:00.000Z",
    verifiedAt:
      input.verifiedAt === undefined
        ? "2026-07-12T04:01:00.000Z"
        : input.verifiedAt,
    finalizedAt:
      input.finalizedAt ??
      input.capturedAt ??
      "2026-07-12T04:02:00.000Z",
    capturedAt: input.capturedAt ?? "2026-07-12T04:03:00.000Z",
    verificationEntityId:
      input.verificationEntityId === undefined
        ? targetEntityId
        : input.verificationEntityId,
    verificationStatus:
      input.verificationStatus === undefined
        ? semantic === "resume"
          ? "ACTIVE"
          : "PAUSED"
        : input.verificationStatus,
    verificationLineage:
      input.verificationLineage === undefined
        ? {
            sourceCreativeId: target.creativeId,
            sourceCampaignId: target.sourceCampaignId,
            sourceAdsetId: target.sourceAdsetId,
            verifiedProviderAccountId:
              overrides.providerAccountId ?? target.providerAccountId,
            verifiedCreativeId: target.creativeId,
            verifiedCampaignId: target.sourceCampaignId,
            verifiedAdsetId: target.sourceAdsetId,
          }
        : input.verificationLineage,
  };
  return {
    ...receipt,
    receiptHash:
      receiptHashOverride ?? buildExactMetaAdsActionReceiptHash(receipt),
  };
}

function state(input: {
  id: string;
  observedAt: string;
  capturedAt?: string;
  businessId?: string;
  providerAccountId?: string;
  entityType?: "ad" | "adset" | "campaign";
  entityId?: string;
  adId?: string | null;
  creativeId?: string | null;
  configuredStatus?: string | null;
  effectiveStatus?: string | null;
  campaignDailyBudgetRaw?: string | null;
  campaignLifetimeBudgetRaw?: string | null;
  adsetDailyBudgetRaw?: string | null;
  adsetLifetimeBudgetRaw?: string | null;
  priorWindowSpend?: number | null;
  currentWindowSpend?: number | null;
  deliveryWindowEnd?: string;
  runCompleteness?: "complete" | "partial" | "point_lookup";
  providerAccountRefId?: string;
  budgetOrigin?: "campaign" | "adset" | "not_observed" | "not_applicable";
  fieldCoverage?: Record<string, unknown>;
  confirmedUntil?: string;
}): AdEntityStateObservation {
  const entityType = input.entityType ?? "ad";
  const entityId = input.entityId ?? "ad-a";
  return {
    stateHistoryId: input.id,
    runId: `run-${input.id}`,
    runHash: "b".repeat(64),
    runCompleteness: input.runCompleteness ?? "complete",
    businessId: input.businessId ?? "business-a",
    providerAccountRefId: input.providerAccountRefId ?? "provider-ref-a",
    providerAccountId: input.providerAccountId ?? "act-a",
    entityType,
    entityId,
    campaignId:
      entityType === "campaign" ? entityId : "campaign-a",
    adsetId: entityType === "adset" ? entityId : "adset-a",
    adId: input.adId === undefined ? (entityType === "ad" ? entityId : null) : input.adId,
    creativeId:
      input.creativeId === undefined ? "shared-creative" : input.creativeId,
    configuredStatus: input.configuredStatus ?? "ACTIVE",
    effectiveStatus: input.effectiveStatus ?? "ACTIVE",
    campaignDailyBudgetRaw: input.campaignDailyBudgetRaw ?? null,
    campaignLifetimeBudgetRaw: input.campaignLifetimeBudgetRaw ?? null,
    adsetDailyBudgetRaw: input.adsetDailyBudgetRaw ?? null,
    adsetLifetimeBudgetRaw: input.adsetLifetimeBudgetRaw ?? null,
    budgetOrigin:
      input.budgetOrigin ??
      (entityType === "campaign" &&
      (input.campaignDailyBudgetRaw != null ||
        input.campaignLifetimeBudgetRaw != null)
        ? "campaign"
        : entityType === "adset" &&
            (input.adsetDailyBudgetRaw != null ||
              input.adsetLifetimeBudgetRaw != null)
          ? "adset"
          : "not_applicable"),
    presence: "present",
    fieldCoverage:
      input.fieldCoverage ??
      {
        configuredStatus: true,
        effectiveStatus: true,
        campaignDailyBudgetRaw: true,
        campaignLifetimeBudgetRaw: true,
        adsetDailyBudgetRaw: true,
        adsetLifetimeBudgetRaw: true,
      },
    observedAt: input.observedAt,
    capturedAt: input.capturedAt ?? input.observedAt,
    ...(input.confirmedUntil ? { confirmedUntil: input.confirmedUntil } : {}),
    stateHash: "c".repeat(64),
    delivery:
      input.currentWindowSpend == null
        ? null
        : {
            contractVersion:
              NATIVE_AD_DELIVERY_OBSERVATION_CONTRACT_VERSION,
            priorWindowSpend: input.priorWindowSpend ?? null,
            currentWindowSpend: input.currentWindowSpend,
            windowStart: "2026-07-12T03:00:00.001Z",
            windowEnd:
              input.deliveryWindowEnd ?? "2026-07-13T02:30:00.000Z",
          },
  };
}

function activeBaseline(adId = "ad-a") {
  return state({
    id: `state-${adId}-before`,
    entityId: adId,
    adId,
    observedAt: "2026-07-12T02:55:00.000Z",
    capturedAt: "2026-07-12T02:56:00.000Z",
  });
}

function tombstone(input: {
  id: string;
  observedAt: string;
  capturedAt?: string;
  entityType?: "ad" | "adset" | "campaign";
  entityId?: string;
}): AdEntityTombstoneObservation {
  return {
    tombstoneId: input.id,
    runId: `run-${input.id}`,
    runHash: "d".repeat(64),
    runCompleteness: "point_lookup",
    businessId: "business-a",
    providerAccountRefId: "provider-ref-a",
    providerAccountId: "act-a",
    entityType: input.entityType ?? "ad",
    entityId: input.entityId ?? "ad-a",
    reason: "explicit_not_found",
    providerEvidence: { status: 404, endpoint: "exact_entity_lookup" },
    observedAt: input.observedAt,
    capturedAt: input.capturedAt ?? input.observedAt,
    tombstoneHash: "e".repeat(64),
  };
}

function completeClosedWindowStates() {
  const terminalCapturedAt = "2026-07-13T03:00:00.000Z";
  return [
    activeBaseline(),
    state({
      id: "state-ad-terminal",
      observedAt: "2026-07-12T02:55:00.000Z",
      capturedAt: terminalCapturedAt,
    }),
    state({
      id: "state-campaign-before",
      entityType: "campaign",
      entityId: "campaign-a",
      observedAt: "2026-07-12T02:50:00.000Z",
      capturedAt: "2026-07-12T02:51:00.000Z",
    }),
    state({
      id: "state-campaign-terminal",
      entityType: "campaign",
      entityId: "campaign-a",
      observedAt: "2026-07-12T02:50:00.000Z",
      capturedAt: terminalCapturedAt,
    }),
    state({
      id: "state-adset-before",
      entityType: "adset",
      entityId: "adset-a",
      observedAt: "2026-07-12T02:52:00.000Z",
      capturedAt: "2026-07-12T02:53:00.000Z",
    }),
    state({
      id: "state-adset-terminal",
      entityType: "adset",
      entityId: "adset-a",
      observedAt: "2026-07-12T02:52:00.000Z",
      capturedAt: terminalCapturedAt,
    }),
  ];
}

describe("native ad operator-response detection", () => {
  it("does not attribute a sibling ad action even when creative grouping matches", () => {
    const target = episode();
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [
        action(target, {
          actionLogId: "log-sibling",
          sourceAdId: "ad-b",
          targetEntityId: "ad-b",
          verificationEntityId: "ad-b",
        }),
      ],
      states: [
        activeBaseline(),
        state({
          id: "state-ad-b-paused",
          entityId: "ad-b",
          adId: "ad-b",
          creativeId: "shared-creative",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
        }),
      ],
    });

    expect(result.responseType).toBe("unknown_incomplete");
    expect(result.operatorResponseDetected).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ignored_action_lineage_mismatch" }),
      ]),
    );
  });

  it("isolates same-account episodes by exact snapshot and evaluation", () => {
    const target = episode();
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [
        action(target, {
          actionLogId: "log-other-episode",
          sourceSnapshotId: "snapshot-other",
          sourceEvaluationId: "evaluation-other",
        }),
      ],
      states: [activeBaseline()],
    });

    expect(result.responseType).toBe("unknown_incomplete");
    expect(result.actionLogId).toBeNull();
  });

  it("isolates identical ad ids across provider accounts", () => {
    const target = episode();
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [
        action(target, {
          actionLogId: "log-cross-account",
          providerAccountId: "act-b",
        }),
      ],
      states: [
        activeBaseline(),
        state({
          id: "state-cross-account",
          providerAccountId: "act-b",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
        }),
      ],
    });

    expect(result.responseType).toBe("unknown_incomplete");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "engine_v3_ad_operator_action_receipt",
          treatmentEligible: false,
        }),
      ]),
    );
  });

  it("enforces requested, verified, observed, and captured cutoff ordering", () => {
    const target = episode();
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: "2026-07-12T05:00:00.000Z",
      actions: [
        action(target, {
          actionLogId: "log-captured-late",
          capturedAt: "2026-07-12T05:00:00.001Z",
        }),
        action(target, {
          actionLogId: "log-verified-late",
          verifiedAt: "2026-07-12T05:00:00.001Z",
          capturedAt: "2026-07-12T04:59:00.000Z",
        }),
      ],
      states: [
        activeBaseline(),
        state({
          id: "state-captured-late",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
          capturedAt: "2026-07-12T05:00:00.001Z",
        }),
      ],
    });

    expect(result.responseType).toBe("unknown_incomplete");
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "ignored_action_outside_episode_window",
        "unverified_action_log",
      ]),
    );
  });

  it("keeps dry-run, failed, and unverified logs as non-treatment diagnostics", () => {
    const target = episode();
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [
        action(target, { actionLogId: "log-dry", dryRun: true }),
        action(target, {
          actionLogId: "log-failed",
          status: "failure",
          requestedAt: "2026-07-12T04:10:00.000Z",
          capturedAt: "2026-07-12T04:11:00.000Z",
        }),
        action(target, {
          actionLogId: "log-unverified",
          providerVerified: false,
          verifiedAt: null,
          requestedAt: "2026-07-12T04:20:00.000Z",
          capturedAt: "2026-07-12T04:21:00.000Z",
        }),
      ],
      states: [activeBaseline()],
    });

    expect(result.responseType).toBe("unknown_incomplete");
    expect(result.adTreatmentDetected).toBe(false);
    expect(
      result.evidence.filter(
        (entry) => entry.kind === "engine_v3_ad_operator_action_receipt",
      ),
    ).toHaveLength(3);
    expect(result.evidence.every((entry) => !entry.treatmentEligible)).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "dry_run_action_log",
        "failed_action_log",
        "unverified_action_log",
      ]),
    );
  });

  it("detects a provider-verified pause only with exact pre/post ad states", () => {
    const target = episode();
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [action(target)],
      states: [
        activeBaseline(),
        state({
          id: "state-ad-a-paused",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
          capturedAt: "2026-07-12T04:03:00.000Z",
        }),
      ],
    });

    expect(result).toMatchObject({
      responseType: "verified_pause",
      operatorResponseDetected: true,
      adTreatmentDetected: true,
      actionLogId: "log-pause",
      detectedAt: "2026-07-12T04:01:00.000Z",
    });
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "engine_v3_ad_operator_action_receipt",
          treatmentEligible: true,
        }),
      ]),
    );
  });

  it("detects a provider-verified resume only from the exact paused ad", () => {
    const target = episode();
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [
        action(target, {
          actionLogId: "log-resume",
          action: "resume",
          verificationStatus: "ACTIVE",
        }),
      ],
      states: [
        state({
          id: "state-ad-a-before-resume",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T02:55:00.000Z",
          capturedAt: "2026-07-12T02:56:00.000Z",
        }),
        state({
          id: "state-ad-a-active",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          observedAt: "2026-07-12T04:02:00.000Z",
          capturedAt: "2026-07-12T04:03:00.000Z",
        }),
      ],
    });

    expect(result).toMatchObject({
      responseType: "verified_resume",
      operatorResponseDetected: true,
      adTreatmentDetected: true,
      actionLogId: "log-resume",
    });
  });

  it("classifies exact active-state delivery cessation as natural, never treatment", () => {
    const target = episode();
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [],
      states: [
        activeBaseline(),
        state({
          id: "state-natural-cessation",
          observedAt: "2026-07-13T02:31:00.000Z",
          capturedAt: "2026-07-13T02:32:00.000Z",
          priorWindowSpend: 120,
          currentWindowSpend: 0,
        }),
      ],
    });

    expect(result).toMatchObject({
      responseType: "natural_spend_cessation",
      operatorResponseDetected: false,
      adTreatmentDetected: false,
      actionLogId: null,
    });
  });

  it("does not treat zero spend without a positive baseline as response", () => {
    const target = episode();
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [],
      states: [
        activeBaseline(),
        state({
          id: "state-zero-only",
          observedAt: "2026-07-13T02:31:00.000Z",
          priorWindowSpend: null,
          currentWindowSpend: 0,
        }),
      ],
    });

    expect(result.responseType).toBe("unknown_incomplete");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "zero_spend_without_positive_baseline" }),
      ]),
    );
  });

  it("detects an exact duplicate successor independently of creative id", () => {
    const target = episode({ creativeId: "shared-creative" });
    const duplicate = action(target, {
      actionLogId: "log-duplicate",
      contractVersion: NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION,
      action: "duplicate",
      targetEntityType: "ad",
      targetEntityId: "ad-successor",
      resultingAdId: "ad-successor",
      successorKind: "duplicate",
      verificationEntityId: "ad-successor",
      verificationStatus: "PAUSED",
    });
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [duplicate],
      states: [
        activeBaseline(),
        state({
          id: "state-successor",
          entityId: "ad-successor",
          adId: "ad-successor",
          creativeId: "different-creative",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
        }),
      ],
    });

    expect(result).toMatchObject({
      responseType: "duplicate_successor",
      actionLogId: "log-duplicate",
      successorAdId: "ad-successor",
      successorKind: "duplicate",
      adTreatmentDetected: true,
    });
  });

  it("keeps a typed rebuild successor distinct from a duplicate", () => {
    const target = episode();
    const rebuild = action(target, {
      actionLogId: "log-rebuild",
      contractVersion: NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION,
      action: "rebuild",
      targetEntityType: "ad",
      targetEntityId: "ad-rebuild",
      resultingAdId: "ad-rebuild",
      successorKind: "rebuild",
      verificationEntityId: "ad-rebuild",
      verificationStatus: "PAUSED",
    });
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [rebuild],
      states: [
        activeBaseline(),
        state({
          id: "state-rebuild",
          entityId: "ad-rebuild",
          adId: "ad-rebuild",
          creativeId: "new-creative",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
        }),
      ],
    });

    expect(result).toMatchObject({
      responseType: "rebuild_successor",
      successorAdId: "ad-rebuild",
      successorKind: "rebuild",
    });
  });

  it("keeps exact budget-owner action as context outside the ad", () => {
    const target = episode();
    const budgetAction = action(target, {
      actionLogId: "log-budget",
      contractVersion: NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION,
      action: "budget_increase",
      targetEntityType: "campaign",
      targetEntityId: "campaign-a",
      verificationEntityId: "campaign-a",
      verificationStatus: "ACTIVE",
    });
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [budgetAction],
      states: [
        activeBaseline(),
        state({
          id: "state-campaign-before",
          entityType: "campaign",
          entityId: "campaign-a",
          observedAt: "2026-07-12T02:50:00.000Z",
          campaignDailyBudgetRaw: "10000",
        }),
        state({
          id: "state-campaign-after",
          entityType: "campaign",
          entityId: "campaign-a",
          observedAt: "2026-07-12T04:02:00.000Z",
          campaignDailyBudgetRaw: "12000",
        }),
      ],
    });

    expect(result).toMatchObject({
      responseType: "budget_owner_action_context",
      operatorResponseDetected: true,
      adTreatmentDetected: false,
      budgetOwnerType: "campaign",
      budgetOwnerId: "campaign-a",
    });
  });

  it("marks conflicting verified responses ambiguous", () => {
    const target = episode();
    const pause = action(target, { actionLogId: "log-pause" });
    const resume = action(target, {
      actionLogId: "log-resume",
      action: "resume",
      requestedAt: "2026-07-12T05:00:00.000Z",
      verifiedAt: "2026-07-12T05:01:00.000Z",
      capturedAt: "2026-07-12T05:02:00.000Z",
      verificationStatus: "ACTIVE",
    });
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [pause, resume],
      states: [
        activeBaseline(),
        state({
          id: "state-paused",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
        }),
        state({
          id: "state-active-again",
          configuredStatus: "ACTIVE",
          effectiveStatus: "ACTIVE",
          observedAt: "2026-07-12T05:02:00.000Z",
        }),
      ],
    });

    expect(result.responseType).toBe("ambiguous_conflicting");
    expect(result.adTreatmentDetected).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "multiple_verified_responses",
    );
  });

  it("is deterministic and keeps same-creative ads as independent episodes", () => {
    const adA = episode({ adId: "ad-a", creativeId: "shared-creative" });
    const adB = episode({ adId: "ad-b", creativeId: "shared-creative" });
    const input = {
      episode: adA,
      cutoff: CUTOFF,
      actions: [] as ExactMetaAdsActionLineage[],
      states: [activeBaseline()],
    };

    expect(adA.episodeKey).not.toBe(adB.episodeKey);
    expect(detectAdOperatorResponse(input)).toEqual(
      detectAdOperatorResponse(input),
    );
  });

  it("keeps empty open-window evidence unknown instead of inferring no response", () => {
    const result = detectAdOperatorResponse({
      episode: episode(),
      cutoff: CUTOFF,
      actions: [],
      states: [],
      sourceReads: {
        actionReceiptsComplete: true,
        stateHistoryComplete: true,
        tombstonesComplete: true,
      },
    });

    expect(result).toMatchObject({
      observationStatus: "unknown_incomplete",
      responseType: "unknown_incomplete",
      operatorResponseDetected: false,
      adTreatmentDetected: false,
      sourceProof: { windowClosed: false, sourceComplete: false },
    });
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "attribution_window_open",
    );
  });

  it("certifies window-end truth from confirmedUntil for unchanged entities (D075 consumer sweep)", () => {
    // Under heartbeat/delta manifests an unchanged entity's newest row keeps
    // its first-capture clock; only the run heartbeat / later delta runs
    // re-confirm it. Pre-fix, terminal truth filtered on capturedAt alone,
    // so this exact shape stayed unknown_incomplete forever.
    const terminalCapturedAt = "2026-07-12T02:56:00.000Z";
    const confirmedUntil = "2026-07-13T03:00:00.000Z";
    const states = [
      activeBaseline(),
      state({
        id: "state-ad-terminal",
        observedAt: "2026-07-12T02:55:00.000Z",
        capturedAt: terminalCapturedAt,
        confirmedUntil,
      }),
      state({
        id: "state-campaign-terminal",
        entityType: "campaign",
        entityId: "campaign-a",
        observedAt: "2026-07-12T02:50:00.000Z",
        capturedAt: "2026-07-12T02:51:00.000Z",
        confirmedUntil,
      }),
      state({
        id: "state-adset-terminal",
        entityType: "adset",
        entityId: "adset-a",
        observedAt: "2026-07-12T02:52:00.000Z",
        capturedAt: "2026-07-12T02:53:00.000Z",
        confirmedUntil,
      }),
    ];
    const result = detectAdOperatorResponse({
      episode: episode(),
      cutoff: CUTOFF,
      responseWindowDays: 1,
      actions: [],
      states,
      sourceReads: {
        actionReceiptsComplete: true,
        stateHistoryComplete: true,
        tombstonesComplete: true,
      },
    });
    expect(result).toMatchObject({
      observationStatus: "observed_no_response",
      responseType: "no_response_observed",
      sourceProof: { windowClosed: true, sourceComplete: true },
    });
  });

  it("classifies no response only after a closed, complete exact hierarchy window", () => {
    const result = detectAdOperatorResponse({
      episode: episode(),
      cutoff: CUTOFF,
      responseWindowDays: 1,
      actions: [],
      states: completeClosedWindowStates(),
      sourceReads: {
        actionReceiptsComplete: true,
        stateHistoryComplete: true,
        tombstonesComplete: true,
      },
    });

    expect(result).toMatchObject({
      observationStatus: "observed_no_response",
      responseType: "no_response_observed",
      operatorResponseDetected: false,
      adTreatmentDetected: false,
      sourceProof: {
        windowClosed: true,
        sourceComplete: true,
        requiredStateTargetCount: 3,
        completeStateTargetCount: 3,
      },
    });
    expect(result.evidence.filter((entry) => entry.role === "window_end_state"))
      .toHaveLength(3);
  });

  it("lets an explicit tombstone supersede old ACTIVE state instead of proving no response", () => {
    const result = detectAdOperatorResponse({
      episode: episode(),
      cutoff: CUTOFF,
      responseWindowDays: 1,
      actions: [],
      states: completeClosedWindowStates(),
      tombstones: [
        tombstone({
          id: "tombstone-ad-terminal",
          observedAt: "2026-07-13T02:59:00.000Z",
          capturedAt: CUTOFF,
        }),
      ],
      sourceReads: {
        actionReceiptsComplete: true,
        stateHistoryComplete: true,
        tombstonesComplete: true,
      },
    });

    expect(result.observationStatus).toBe("unknown_incomplete");
    expect(result.responseType).toBe("ambiguous_conflicting");
    expect(result.sourceProof.sourceComplete).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "explicit_tombstone_without_typed_receipt",
    );
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "meta_entity_tombstones",
          sourceId: "tombstone-ad-terminal",
        }),
      ]),
    );
  });

  it("allows a later exact state to rehydrate an entity after an older tombstone", () => {
    const result = detectAdOperatorResponse({
      episode: episode(),
      cutoff: CUTOFF,
      responseWindowDays: 1,
      actions: [],
      states: [
        ...completeClosedWindowStates(),
        state({
          id: "state-ad-rehydrated",
          observedAt: "2026-07-13T02:59:00.000Z",
          capturedAt: CUTOFF,
        }),
      ],
      tombstones: [
        tombstone({
          id: "tombstone-ad-stale",
          observedAt: "2026-07-12T12:00:00.000Z",
          capturedAt: "2026-07-12T12:01:00.000Z",
        }),
      ],
      sourceReads: {
        actionReceiptsComplete: true,
        stateHistoryComplete: true,
        tombstonesComplete: true,
      },
    });

    expect(result.responseType).toBe("no_response_observed");
    expect(result.sourceProof.sourceComplete).toBe(true);
  });

  it("keeps a closed window unknown when one terminal run is partial", () => {
    const states = completeClosedWindowStates().map((entry) =>
      entry.stateHistoryId === "state-adset-terminal"
        ? { ...entry, runCompleteness: "partial" as const }
        : entry,
    );
    const result = detectAdOperatorResponse({
      episode: episode(),
      cutoff: CUTOFF,
      responseWindowDays: 1,
      actions: [],
      states,
      sourceReads: {
        actionReceiptsComplete: true,
        stateHistoryComplete: true,
        tombstonesComplete: true,
      },
    });

    expect(result.responseType).toBe("unknown_incomplete");
    expect(result.sourceProof).toMatchObject({
      windowClosed: true,
      sourceComplete: false,
      completeStateTargetCount: 2,
    });
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "state_coverage_incomplete",
    );
  });

  it("does not call a complete fetch complete evidence when status fields were absent", () => {
    const states = completeClosedWindowStates().map((entry) =>
      entry.stateHistoryId === "state-ad-terminal"
        ? {
            ...entry,
            fieldCoverage: {
              ...entry.fieldCoverage,
              effectiveStatus: false,
            },
          }
        : entry,
    );
    const result = detectAdOperatorResponse({
      episode: episode(),
      cutoff: CUTOFF,
      responseWindowDays: 1,
      actions: [],
      states,
      sourceReads: {
        actionReceiptsComplete: true,
        stateHistoryComplete: true,
        tombstonesComplete: true,
      },
    });

    expect(result.responseType).toBe("unknown_incomplete");
    expect(result.sourceProof.completeStateTargetCount).toBe(2);
  });

  it("fails a tampered immutable receipt hash closed", () => {
    const target = episode();
    const tampered = action(target, { receiptHash: "f".repeat(64) });
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [tampered],
      states: [
        activeBaseline(),
        state({
          id: "state-tampered-paused",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
        }),
      ],
    });

    expect(result.responseType).toBe("ambiguous_conflicting");
    expect(result.adTreatmentDetected).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "receipt_integrity_mismatch",
    );
  });

  it("keeps legacy null verification lineage on its original immutable hash contract", () => {
    const target = episode();
    const legacy = action(target, {
      receiptId: "receipt-legacy-null-lineage",
      actionLogId: "log-legacy-null-lineage",
      idempotencyKey: "idem-legacy-null-lineage",
      verificationLineage: null,
    });

    expect(legacy.receiptHash).toBe(
      "636cd618145fd9812d10f860063950fa8fafdee8e1c96947a8e08c56bb3040bb",
    );

    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [legacy],
      states: [
        activeBaseline(),
        state({
          id: "state-legacy-null-lineage-paused",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
          capturedAt: "2026-07-12T04:03:00.000Z",
        }),
      ],
    });

    expect(result).toMatchObject({
      responseType: "verified_pause",
      adTreatmentDetected: true,
      actionLogId: "log-legacy-null-lineage",
    });
    expect(result.diagnostics.map((entry) => entry.code)).not.toContain(
      "receipt_integrity_mismatch",
    );
  });

  it("fails a hash-bound verification-lineage identity tamper closed", () => {
    const target = episode();
    const original = action(target, {
      actionLogId: "log-lineage-tamper",
    });
    const tampered = {
      ...original,
      verificationLineage: {
        ...original.verificationLineage!,
        verifiedCampaignId: "campaign-tampered",
      },
    };

    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [tampered],
      states: [
        activeBaseline(),
        state({
          id: "state-lineage-tamper-paused",
          configuredStatus: "PAUSED",
          effectiveStatus: "PAUSED",
          observedAt: "2026-07-12T04:02:00.000Z",
          capturedAt: "2026-07-12T04:03:00.000Z",
        }),
      ],
    });

    expect(result.responseType).toBe("ambiguous_conflicting");
    expect(result.adTreatmentDetected).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "receipt_integrity_mismatch",
    );
  });

  it("does not attribute a correctly typed action after the episode window", () => {
    const target = episode();
    const lateAction = action(target, {
      actionLogId: "log-after-window",
      requestedAt: "2026-07-13T03:00:00.001Z",
      verifiedAt: "2026-07-13T03:01:00.000Z",
      finalizedAt: "2026-07-13T03:02:00.000Z",
      capturedAt: "2026-07-13T03:03:00.000Z",
    });
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: "2026-07-14T03:00:00.000Z",
      responseWindowDays: 1,
      actions: [lateAction],
      states: completeClosedWindowStates(),
      sourceReads: {
        actionReceiptsComplete: true,
        stateHistoryComplete: true,
        tombstonesComplete: true,
      },
    });

    expect(result.responseType).toBe("no_response_observed");
    expect(result.operatorResponseDetected).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "ignored_action_outside_episode_window",
    );
  });

  it("does not attribute a pre-decision receipt to a later episode", () => {
    const target = episode();
    const preDecision = action(target, {
      actionLogId: "log-before-decision",
      requestedAt: "2026-07-12T02:59:00.000Z",
      verifiedAt: "2026-07-12T02:59:10.000Z",
      finalizedAt: "2026-07-12T02:59:20.000Z",
      capturedAt: "2026-07-12T02:59:30.000Z",
    });
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      responseWindowDays: 1,
      actions: [preDecision],
      states: completeClosedWindowStates(),
      sourceReads: {
        actionReceiptsComplete: true,
        stateHistoryComplete: true,
        tombstonesComplete: true,
      },
    });

    expect(result.responseType).toBe("no_response_observed");
    expect(result.actionReceiptId).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "ignored_action_outside_episode_window",
    );
  });

  it("rejects a same-external-account receipt with a different physical account ref", () => {
    const target = episode();
    const wrongPhysicalAccount = action(target, {
      actionLogId: "log-wrong-account-ref",
      providerAccountRefId: "provider-ref-b",
    });
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [wrongPhysicalAccount],
      states: [activeBaseline()],
    });

    expect(result.responseType).toBe("unknown_incomplete");
    expect(result.operatorResponseDetected).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "ignored_action_lineage_mismatch",
    );
  });

  it("rejects a budget-increase receipt when exact owner state decreased", () => {
    const target = episode();
    const budgetAction = action(target, {
      actionLogId: "log-budget-wrong-direction",
      contractVersion: NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION,
      action: "budget_increase",
      targetEntityType: "campaign",
      targetEntityId: "campaign-a",
      verificationEntityId: "campaign-a",
      verificationStatus: "ACTIVE",
    });
    const result = detectAdOperatorResponse({
      episode: target,
      cutoff: CUTOFF,
      actions: [budgetAction],
      states: [
        activeBaseline(),
        state({
          id: "state-campaign-budget-before",
          entityType: "campaign",
          entityId: "campaign-a",
          observedAt: "2026-07-12T02:50:00.000Z",
          campaignDailyBudgetRaw: "12000",
        }),
        state({
          id: "state-campaign-budget-after",
          entityType: "campaign",
          entityId: "campaign-a",
          observedAt: "2026-07-12T04:02:00.000Z",
          campaignDailyBudgetRaw: "10000",
        }),
      ],
    });

    expect(result.responseType).toBe("ambiguous_conflicting");
    expect(result.diagnostics.map((entry) => entry.code)).toContain(
      "budget_change_direction_conflict",
    );
  });
});
