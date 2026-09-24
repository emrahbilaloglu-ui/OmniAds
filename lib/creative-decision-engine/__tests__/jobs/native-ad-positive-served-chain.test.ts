import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/creative-decision-engine/campaign-context/source", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/creative-decision-engine/campaign-context/source")>(),
  isCampaignContextResolverAuthorityValidated: () => true,
}));

import { projectCanonicalNativeAdDecisionToBriefing } from "@/app/api/creatives/briefing/canonical-projection";
import { adDecisionStabilityKey, type PreviousAdPublishedLabel } from "@/lib/creative-decision-engine/decision-stability";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import {
  computeNativeAdDecisions,
  toNativeSnapshotPayload,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { resolveHydratedConfigAuthority, type HydratedConfigAuthorityRow } from "@/lib/creative-decision-engine/native-ad-hydration-authority";
import { META_AD_SOURCE_COVERAGE_FRESHNESS_CONTRACT_VERSION, NATIVE_AD_ENGINE_VERSION, type AdDecisionInput } from "@/lib/creative-decision-engine/types";
import { makeAccountDecisionProfile, makeCreativeInput, makeDataHealth } from "@/lib/creative-decision-engine/__tests__/helpers";
import { buildMetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-presentation";
import { configReceiptManifestLine, hashConfigReceiptManifest } from "@/lib/meta/config-field-evidence-ref";
import {
  applyMetaExecutionGovernanceToReadModel,
  buildNativeMetaDecisionsWorkspaceReadModel,
  type MetaNativeDecisionSnapshotSourceRow,
} from "@/lib/meta/decisions-workspace-read-model";

// Synthetic only: this connects real producer and serving functions. It does
// not claim that a provider receipt or a positive live Cut exists historically.
const BUSINESS = "biz-native-positive-chain";
const ACCOUNT = "act_1";
const ACCOUNT_REF = "00000000-0000-4000-8000-000000000740";
const AD = "120000000000000901";
const CAMPAIGN = "campaign-main";
const AS_OF = "2026-07-12";
const COMPUTED_AT = "2026-07-12T03:20:00.000Z";
const RUN = "00000000-0000-4000-8000-000000000763";
const BRACKETED = "provider_receipt_legacy_bracketed";
const POINT = "provider_receipt_point_in_day";

function receipt(field: string, tier: typeof BRACKETED | typeof POINT) {
  const bracketed = tier === BRACKETED;
  return {
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field,
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: 1,
    tier,
    readiness: bracketed ? "decision_authority" : "review_only",
    sourceClass: bracketed ? "legacy_observed" : "modern",
    pitClass: "as_of_known",
    sourceSnapshotId: "11111111-1111-4111-8111-111111111111",
    observationId: "33333333-3333-4333-8333-333333333333",
    observedAt: bracketed ? "2026-07-11T09:00:00.000Z" : "2026-07-12T02:00:00.000Z",
    fieldScopeHash: "a".repeat(64),
    corroboratingSnapshotId: bracketed ? "11111111-1111-4111-8111-111111111111" : null,
    corroboratingObservationId: bracketed ? "55555555-5555-4555-8555-555555555555" : null,
    corroboratingObservedAt: bracketed ? "2026-07-12T02:05:00.000Z" : null,
  };
}

function unknownConversionReceipt() {
  return {
    refContractVersion: "meta-config-field-evidence-ref.v1",
    field: "custom_conversion_id",
    sourceContractVersion: "meta-config-field-source.v1",
    normalizationVersion: null,
    tier: "unknown",
    readiness: "none",
    sourceClass: "none",
    pitClass: null,
    sourceSnapshotId: null,
    observationId: null,
    observedAt: null,
    fieldScopeHash: null,
    corroboratingSnapshotId: null,
    corroboratingObservationId: null,
    corroboratingObservedAt: null,
  };
}

function configAuthority(objectiveReceiptPresent: boolean) {
  const historicalRefs = {
    objective: receipt("objective", BRACKETED),
    optimization_goal: receipt("optimization_goal", BRACKETED),
    custom_event_type: receipt("custom_event_type", BRACKETED),
    custom_conversion_id: unknownConversionReceipt(),
  };
  const historicalManifestHash = hashConfigReceiptManifest([
    configReceiptManifestLine("2026-07-11", historicalRefs),
  ]);
  const refs = {
    objective: objectiveReceiptPresent ? receipt("objective", POINT) : null,
    optimization_goal: receipt("optimization_goal", POINT),
    custom_event_type: receipt("custom_event_type", POINT),
    custom_conversion_id: unknownConversionReceipt(),
  };
  const row: HydratedConfigAuthorityRow = {
    latestContextDate: "2026-07-11",
    providerLocalAsOfDate: AS_OF,
    objectiveTier: BRACKETED,
    objectiveReadiness: "decision_authority",
    optimizationGoalTier: BRACKETED,
    optimizationGoalReadiness: "decision_authority",
    customEventTypeTier: BRACKETED,
    customEventTypeReadiness: "decision_authority",
    customEventType: "PURCHASE",
    customConversionId: null,
    customConversionIdReadiness: "none",
    authorityDates: ["2026-07-11"],
    authoritySpend: [900],
    authorityConversions: [3],
    authorityRevenue: [540],
    authorityObjectiveTier: [BRACKETED],
    authorityObjectiveReadiness: ["decision_authority"],
    authorityGoalTier: [BRACKETED],
    authorityGoalReadiness: ["decision_authority"],
    authorityEventTier: [BRACKETED],
    authorityEventReadiness: ["decision_authority"],
    authorityEventValue: ["PURCHASE"],
    authorityCustomConversionId: [null],
    authorityCustomConversionReadiness: ["none"],
    currentConfigDay: AS_OF,
    currentObjectiveTier: POINT,
    currentObjectiveReadiness: "review_only",
    currentOptimizationGoalTier: POINT,
    currentOptimizationGoalReadiness: "review_only",
    currentCustomEventTypeTier: POINT,
    currentCustomEventTypeReadiness: "review_only",
    currentCustomEventType: "PURCHASE",
    currentCustomConversionId: null,
    currentCustomConversionIdReadiness: "none",
    currentEvidenceRefs: refs,
    authorityReceiptManifest: {
      hash: historicalManifestHash,
      economicDayCount: 1,
      nullObservationIdCount: 0,
      incoherentDayCount: 0,
    },
    objectiveReceiptDisagreements: 0,
    optimizationGoalReceiptDisagreements: 0,
  };
  return resolveHydratedConfigAuthority({ cohort: "purchase", asOfDate: AS_OF, row });
}

function adInput(input: { objectiveReceiptPresent: boolean; coverageComplete: boolean }): AdDecisionInput {
  const creative = makeCreativeInput({
    businessId: BUSINESS,
    creativeId: "creative-901",
    campaignId: CAMPAIGN,
    objective: "OUTCOME_SALES",
    effectiveCohort: "purchase",
    contextGrain: {
      providerAccountCount: 1, campaignCount: 1, adsetCount: 1,
      optimizationContextCount: 1, objectiveCount: 1, contextIdentityUnknown: false,
    },
    spend: 900, purchases: 3, purchaseValue: 540, roas: 0.6, cpa: 300,
    recent7dSpend: 210, recent7dPurchases: 1, recent7dRoas: 0.55,
    linkClicks: 200, landingPageViews: 180, addToCart: 30, initiateCheckout: 9,
    targetRoas: 2, breakevenRoas: 1.5, ageDays: 21,
    dataFreshnessHours: input.coverageComplete ? 6 : null,
  });
  return {
    ...creative,
    configAuthority: configAuthority(input.objectiveReceiptPresent),
    decisionEntityType: "ad",
    decisionEntityId: AD,
    adId: AD,
    providerAccountRefId: ACCOUNT_REF,
    providerAccountId: ACCOUNT,
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    adsetId: "adset-901",
    optimizationGoal: "PURCHASE",
    customEventType: "PURCHASE",
    metricEvidence: {
      sourceRowCount: 28,
      performanceMetricsObserved: true,
      eventMetricsObserved: true,
      sourceCoverage: {
        contractVersion: META_AD_SOURCE_COVERAGE_FRESHNESS_CONTRACT_VERSION,
        status: input.coverageComplete ? "complete" : "partial",
        expectedThroughDay: "2026-07-11",
        coverageThroughDay: input.coverageComplete ? "2026-07-11" : "2026-07-10",
        sourceCompletedAt: "2026-07-11T21:05:00.000Z",
        publishedAt: "2026-07-12T02:00:00.000Z",
      },
    },
    statusEvidence: {
      source: "entity_state_history",
      sourceRecordId: "state-901",
      observedAt: "2026-07-12T02:00:00.000Z",
      capturedAt: "2026-07-12T02:01:00.000Z",
    },
    creativeEvidence: {
      sourceLifecycleRowId: null, sourceAsOfDate: null, sourceComputedAt: null,
      sourceMaxUpdatedAt: null,
      lifecyclePosition: creative.lifecyclePosition ?? null,
      daysSincePeak: creative.daysSincePeak ?? null,
      peakRoas30d: creative.peakRoas30d ?? null,
      peakConfidence: creative.peakConfidence ?? null,
      spendTrajectory30d: creative.spendTrajectory30d ?? null,
      spendSlope7d: creative.spendSlope7d ?? null,
      spendSlope30d: creative.spendSlope30d ?? null,
      roasSlope7d: creative.roasSlope7d ?? null,
      roasSlope30d: creative.roasSlope30d ?? null,
      fatigueStatus: creative.fatigueStatus,
      qualityRanking: creative.qualityRanking,
      engagementRateRanking: creative.engagementRateRanking,
      conversionRateRanking: creative.conversionRateRanking,
      creativeFormat: creative.creativeFormat,
    },
  };
}

function produce(input: { objectiveReceiptPresent: boolean; coverageComplete: boolean }) {
  const base = makeAccountDecisionProfile({
    businessId: BUSINESS,
    asOfDate: AS_OF,
    scope: { type: "account", id: ACCOUNT },
    thresholds: { bottomQuartileRatio: null },
    hardActionEligibility: {
      scale: false, cut: true, refresh: false, reason: "Only Cut has calibrated economic authority",
      reasons: { scale: "sample thin", cut: null, refresh: "sample thin" },
    },
  });
  const profile = {
    ...base,
    spendUnitEvidence: { ...base.spendUnitEvidence, targetRoas: 2, breakEvenRoas: 1.5 },
  };
  const prior: PreviousAdPublishedLabel = {
    businessId: BUSINESS, providerAccountRefId: ACCOUNT_REF, providerAccountId: ACCOUNT,
    decisionEntityType: "ad", decisionEntityId: AD,
    sourceSnapshotId: "snapshot-prior", sourceEvaluationId: "evaluation-prior",
    sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
    sourceAsOfDate: "2026-07-11", sourceComputedAt: "2026-07-11T03:15:00.000Z",
    sourceInputHash: "7".repeat(64), sourceDecisionHash: "8".repeat(64),
    publishedLabel: "keep", rawLabel: "cut",
  };
  const key = adDecisionStabilityKey({
    businessId: BUSINESS, providerAccountRefId: ACCOUNT_REF, providerAccountId: ACCOUNT,
    decisionEntityType: "ad", decisionEntityId: AD,
    scopeType: "account", scopeId: ACCOUNT,
  });
  const [computation] = computeNativeAdDecisions({
    businessId: BUSINESS,
    profile,
    dataHealth: makeDataHealth(),
    adInputs: [adInput(input)],
    campaignContextMode: "automatic",
    campaignContextById: new Map([[CAMPAIGN, {
      kind: "main", testDimension: null, contextTrust: "high",
      provenance: {
        mode: "automatic", source: "system_inferred", campaignId: CAMPAIGN,
        kind: "main", testDimension: null, contextTrust: "high",
        sourceRecordType: "engine_v3_campaign_context_daily", sourceRecordId: "context-901",
        sourceAsOfDate: AS_OF, sourceUpdatedAt: "2026-07-12T02:00:00.000Z",
        sourceHash: "a".repeat(64),
      },
    }]]),
    previousLabels: new Map([[key, prior]]),
  });
  if (!computation) throw new Error("Native producer did not return the Ad");
  const payload = toNativeSnapshotPayload({
    businessId: BUSINESS, asOf: AS_OF, jobRunId: RUN, scope: profile.scope,
    computation,
    stored: {
      evaluationId: "00000000-0000-4000-8000-000000000764",
      providerAccountRefId: ACCOUNT_REF, providerAccountId: ACCOUNT,
      decisionEntityId: AD, inputHash: "9".repeat(64), decisionHash: "a".repeat(64),
    },
    calibrationRowId: "00000000-0000-4000-8000-000000000744",
    hardActionEligibility: profile.hardActionEligibility,
    computedAt: COMPUTED_AT,
  });
  const config = computation.input.configAuthority;
  const row: MetaNativeDecisionSnapshotSourceRow = {
    ...payload,
    snapshot_id: "00000000-0000-4000-8000-000000000765",
    episode_started_at: "2026-07-11",
    lineage_valid: true,
    creative_name: "Synthetic loss creative",
    campaign_id: CAMPAIGN, campaign_name: "Main Sales",
    adset_id: "adset-901", adset_name: "Broad",
    ad_name: "Synthetic loss Ad",
    campaign_status: "ACTIVE", adset_status: "ACTIVE", ad_status: "ACTIVE",
    currency: "USD", thumbnail_url: "https://example.com/ad-901.jpg",
    media_source_present: true, media_available: true, media_source: "meta_creative_media",
    source_updated_at: "2026-07-12T02:00:00.000Z",
    config_authority_verified: config.currentValueEvidence.observed && config.decisionEconomics.fullyVerified,
    config_evidence_lineage: {
      contractVersion: "engine-v3-canonical-ad-evaluation.v16",
      refs: config.currentValueEvidence.refs,
      refRefusals: config.currentValueEvidence.refRefusals,
      lineageSupplied: config.currentValueEvidence.lineageSupplied,
      receiptManifest: config.decisionEconomics.receiptManifest,
      currentConfigDay: config.currentConfigDay,
      metricContract: { sourceCoverage: META_AD_SOURCE_COVERAGE_FRESHNESS_CONTRACT_VERSION },
    },
  };
  const rawModel = buildNativeMetaDecisionsWorkspaceReadModel({
    businessId: BUSINESS, providerAccountId: ACCOUNT,
    generation: {
      jobRunId: RUN, asOfDate: AS_OF, providerAccountRefId: ACCOUNT_REF,
      manifestHash: hashAdDecisionIdentityManifest({
        businessId: BUSINESS, providerAccountId: ACCOUNT, asOfDate: AS_OF, adIds: [AD],
      }),
      expectedAdCount: 1,
    },
    snapshotRows: [row],
    campaignContextRows: [{
      campaignId: CAMPAIGN, kind: "main", source: "system_inferred",
      confidenceClass: "high", sourceUpdatedAt: "2026-07-12T02:00:00.000Z",
      resolverVersion: "campaign-context-v2-account-scoped",
    }],
    generatedAt: "2026-07-12T03:30:00.000Z",
  });
  const model = applyMetaExecutionGovernanceToReadModel({
    model: rawModel,
    governance: {
      verified: true, controlsConfigured: true, writeBlocked: false, blockReason: null,
    },
    pipeline: { verified: true, executionReady: true },
    now: new Date("2026-07-12T03:30:00.000Z"),
  });
  const decision = model.queue.adCandidates?.items[0];
  if (!decision) throw new Error("Served read model omitted the native Ad");
  const briefing = projectCanonicalNativeAdDecisionToBriefing({ decision });
  const os = buildMetaOsDecisionsPresentation({
    actionNow: [], watching: [], nonSales: [], decisionReadModel: model, currency: "USD",
    generatedAt: "2026-07-12T03:30:00.000Z",
  });
  return { computation, payload, decision, briefing, os };
}

describe("native economic Cut reaches Decisions and Briefing only with source authority", () => {
  it("serves an economic Cut when the current objective receipt, historical config window and D101 day are proven", () => {
    const result = produce({ objectiveReceiptPresent: true, coverageComplete: true });
    expect(result.computation.input.configAuthority).toMatchObject({
      currentValueEvidence: { observed: true, lineageSupplied: true, refRefusals: {} },
      decisionEconomics: { fullyVerified: true, economicDayCount: 1, unverifiedEconomicDayCount: 0 },
    });
    expect(result.computation.input.metricEvidence.sourceCoverage).toMatchObject({
      status: "complete", expectedThroughDay: "2026-07-11", coverageThroughDay: "2026-07-11",
    });
    expect(result.computation.rawLabel).toBe("cut");
    expect(result.payload).toMatchObject({
      label: "cut", raw_label: "cut", authorized_action: "cut", blocked_action_type: null,
    });
    expect(result.decision).toMatchObject({
      sourceAuthority: { authorizedAction: "cut", actionEligible: true },
      classification: { decisionState: "act", buyerAction: "cut", heldAction: null },
    });
    expect(result.briefing).toMatchObject({
      lane: "action", card: { sourceDecisionAuthorizedAction: "cut" },
    });
    expect(result.os.ads.items[0]).toMatchObject({
      lane: "act", action: { code: "cut", intent: "execute", providerMutation: "pause" },
    });
  });

  it.each([
    ["objective receipt", false, true],
    ["D101 closed-day publication", true, false],
  ])("keeps the same loss review-only when %s is missing", (_gap, objectiveReceiptPresent, coverageComplete) => {
    const result = produce({ objectiveReceiptPresent, coverageComplete });
    if (!objectiveReceiptPresent) {
      expect(result.computation.input.configAuthority.currentValueEvidence).toMatchObject({
        observed: false, refRefusals: { objective: "absent" },
      });
    } else {
      expect(result.computation.input.metricEvidence.sourceCoverage?.status).toBe("partial");
    }
    expect(result.computation.rawLabel).toBe("cut");
    expect(result.payload.authorized_action).toBeNull();
    expect(result.payload.blocked_action_type).toBe("cut");
    expect(result.decision.sourceAuthority?.authorizedAction).toBeNull();
    expect(result.briefing?.lane).not.toBe("action");
    expect(result.os.ads.items[0]).toMatchObject({
      lane: "blocked", action: { providerMutation: null },
    });
  });
});
