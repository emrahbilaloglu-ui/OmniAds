#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { getDemoMetaCreatives, DEMO_BUSINESS_ID } from "@/lib/demo-business";
import {
  adDecisionStabilityKey,
  type PreviousAdPublishedLabel,
} from "@/lib/creative-decision-engine/decision-stability";
import {
  computeNativeAdDecisions,
  type AdDecisionComputation,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import type { CampaignContextLabelMap } from "@/lib/creative-decision-engine/campaign-context/source";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AdDecisionInput,
} from "@/lib/creative-decision-engine/types";
import {
  makeAccountDecisionProfile,
  makeDataHealth,
} from "@/lib/creative-decision-engine/__tests__/helpers";
import {
  finalizeDemoNativeCanonicalFixture,
  stableDemoFixtureJson,
  type DemoNativeCanonicalFixtureDraftItem,
} from "@/lib/meta/demo-native-canonical-contract";
import { projectCanonicalMetaDecisionPresentation } from "@/lib/meta/canonical-decision-presentation";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";

const PROVIDER_ACCOUNT_ID = "act_210009998877";
const PROVIDER_ACCOUNT_REF_ID =
  "demo-synthetic-provider-account-ref-urbantrail-dtc";
const AS_OF_DATE = "2026-04-12";
const COMPUTED_AT = "2026-04-12T03:05:00.000Z";
const JOB_RUN_ID = "demo-synthetic-native-ad-generation-v1";
const TARGET_ROAS = 2.5;
const BREAK_EVEN_ROAS = 1.5;

const recentRoasByAdId: Record<string, number> = {
  "m-ad-1": 4.2,
  "m-ad-2": 3.4,
  "m-ad-3": 2.0,
  "m-ad-4": 0.45,
  "m-ad-5": 1.55,
  "m-ad-6": 0,
  "m-ad-7": 0.65,
  "m-ad-8": 2.5,
};

const lifecycleByCampaignId: Record<string, "main" | "test"> = {
  "m-c1": "main",
  "m-c2": "test",
  "m-c4": "main",
  "m-c5": "test",
};

function daysBetween(startDate: string, endDate: string) {
  return Math.max(
    0,
    Math.floor(
      (Date.parse(`${endDate}T00:00:00.000Z`) -
        Date.parse(`${startDate}T00:00:00.000Z`)) /
        86_400_000,
    ),
  );
}

function campaignContext(
  rows: ReturnType<typeof getDemoMetaCreatives>["rows"],
): CampaignContextLabelMap {
  return new Map(
    rows.map((row) => {
      const kind = lifecycleByCampaignId[row.campaign_id] ?? "main";
      return [
        row.campaign_id,
        {
          kind,
          testDimension: kind === "test" ? "creative" : null,
          contextTrust: "override" as const,
          provenance: {
            mode: "automatic" as const,
            source: "user_override" as const,
            campaignId: row.campaign_id,
            kind,
            testDimension: kind === "test" ? "creative" : null,
            contextTrust: "override" as const,
            sourceRecordType: "meta_campaign_label" as const,
            sourceRecordId: `demo-context-${row.campaign_id}`,
            sourceAsOfDate: AS_OF_DATE,
            sourceUpdatedAt: COMPUTED_AT,
            sourceHash: "d".repeat(64),
          },
        },
      ] as const;
    }),
  );
}

function toAdDecisionInput(
  row: ReturnType<typeof getDemoMetaCreatives>["rows"][number],
): AdDecisionInput {
  const spend = Number(row.spend);
  const purchases = Number(row.purchases);
  const recent7dSpend = Math.min(spend, Math.max(0, spend * 0.35));
  const recent7dPurchases = Math.max(0, Math.round(purchases * 0.3));
  return {
    businessId: DEMO_BUSINESS_ID,
    decisionEntityType: "ad",
    decisionEntityId: row.real_ad_id,
    adId: row.real_ad_id,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    accountTimezone: "America/Los_Angeles",
    accountCurrency: row.currency,
    adsetId: row.adset_id,
    creativeId: row.creative_id,
    creativeName: row.name,
    campaignId: row.campaign_id,
    objective: "OUTCOME_SALES",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    customEventType: "PURCHASE",
    contextGrain: {
      providerAccountCount: 1,
      campaignCount: 1,
      adsetCount: 1,
      optimizationContextCount: 1,
      objectiveCount: 1,
      contextIdentityUnknown: false,
    },
    effectiveCohort: "purchase",
    spend,
    purchases,
    purchaseValue: Number(row.purchase_value),
    impressions: Number(row.impressions),
    linkClicks: Number(row.link_clicks),
    roas: Number(row.roas),
    cpa: Number(row.cpa),
    ctr: Number(row.ctr_all),
    frequency: Number(row.frequency),
    recent7dSpend,
    recent7dPurchases,
    recent7dRoas: recentRoasByAdId[row.real_ad_id] ?? Number(row.roas),
    recent7dImpressions: Math.round(Number(row.impressions) * 0.35),
    effectiveStatus:
      String(row.effective_status).toUpperCase() === "ACTIVE"
        ? "ACTIVE"
        : "PAUSED",
    ageDays: daysBetween(row.launch_date, AS_OF_DATE),
    lastSpendAt: AS_OF_DATE,
    policyReason: null,
    reviewStatus: "APPROVED",
    disapprovalReason: null,
    limitedReason: null,
    dataFreshnessHours: 2,
    fatigueStatus: "none",
    targetRoas: TARGET_ROAS,
    breakevenRoas: BREAK_EVEN_ROAS,
    commercialTargetFreshness: "fresh",
    cpm: Number(row.cpm),
    outboundClicks: Number(row.link_clicks),
    landingPageViews: Number(row.landing_page_views),
    addToCart: Number(row.add_to_cart),
    initiateCheckout: Number(row.initiate_checkout),
    thumbstop: Number(row.thumbstop),
    video25Rate: Number(row.video25),
    video50Rate: Number(row.video50),
    video75Rate: Number(row.video75),
    video100Rate: Number(row.video100),
    qualityRanking: "average",
    engagementRateRanking: "average",
    conversionRateRanking: "average",
    creativeFormat: row.format === "video" ? "video" : "image",
    metricEvidence: {
      sourceRowCount: 28,
      performanceMetricsObserved: true,
      eventMetricsObserved: true,
    },
    statusEvidence: {
      source: "entity_state_history",
      sourceRecordId: `demo-state-${row.real_ad_id}`,
      observedAt: `${AS_OF_DATE}T02:00:00.000Z`,
      capturedAt: `${AS_OF_DATE}T02:01:00.000Z`,
    },
    creativeEvidence: {
      sourceLifecycleRowId: null,
      sourceAsOfDate: null,
      sourceComputedAt: null,
      sourceMaxUpdatedAt: null,
      lifecyclePosition: null,
      daysSincePeak: null,
      peakRoas30d: null,
      peakConfidence: null,
      spendTrajectory30d: null,
      spendSlope7d: null,
      spendSlope30d: null,
      roasSlope7d: null,
      roasSlope30d: null,
      fatigueStatus: null,
      qualityRanking: null,
      engagementRateRanking: null,
      conversionRateRanking: null,
      creativeFormat: null,
    },
  };
}

function previousLabelsFrom(
  computations: readonly AdDecisionComputation[],
): Map<string, PreviousAdPublishedLabel> {
  return new Map(
    computations.map((computation) => {
      const input = computation.input;
      const key = adDecisionStabilityKey({
        businessId: DEMO_BUSINESS_ID,
        providerAccountRefId: input.providerAccountRefId,
        providerAccountId: input.providerAccountId,
        decisionEntityType: "ad",
        decisionEntityId: input.decisionEntityId,
        scopeType: "account",
        scopeId: PROVIDER_ACCOUNT_ID,
      });
      return [
        key,
        {
          businessId: DEMO_BUSINESS_ID,
          providerAccountRefId: input.providerAccountRefId,
          providerAccountId: input.providerAccountId,
          decisionEntityType: "ad" as const,
          decisionEntityId: input.decisionEntityId,
          sourceSnapshotId: `demo-prior-snapshot-${input.adId}`,
          sourceEvaluationId: `demo-prior-evaluation-${input.adId}`,
          sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
          sourceAsOfDate: "2026-04-11",
          sourceComputedAt: "2026-04-11T03:05:00.000Z",
          sourceInputHash: "a".repeat(64),
          sourceDecisionHash: "b".repeat(64),
          publishedLabel: computation.decision.label,
          rawLabel: computation.rawLabel,
        },
      ] as const;
    }),
  );
}

function draftItem(
  computation: AdDecisionComputation,
): DemoNativeCanonicalFixtureDraftItem {
  const decision = computation.decision;
  const lifecycleRole =
    lifecycleByCampaignId[computation.input.campaignId!] ?? "main";
  const blockerCodes = Array.from(
    new Set((decision.blockers ?? []).map((blocker) => blocker.predicate)),
  ).sort();
  const creativeId = computation.input.creativeId;
  if (!creativeId) {
    throw new Error(
      `Demo canonical presentation requires creative identity for ${computation.input.adId}`,
    );
  }
  const presentation = projectCanonicalMetaDecisionPresentation({
    decision: { ...decision, creativeId },
    context: {
      creativeId,
      rowId: computation.input.adId,
      identityGrain: "ad",
      familyId: null,
      campaignKind: lifecycleRole,
    },
    lifecycleRole,
    blockerCodes,
    reviewOnly: true,
  });
  if (presentation.kind === "omitted") {
    throw new Error(
      `Demo canonical presentation omitted ${computation.input.adId}: ${presentation.bridge.omitReason}`,
    );
  }
  return {
    adId: computation.input.adId,
    creativeId,
    campaignId: computation.input.campaignId!,
    adsetId: computation.input.adsetId!,
    sourceLabel: decision.label,
    preAuthorityLabel: decision.preAuthorityLabel,
    authorityBlocker: decision.authorityBlocker,
    rawLabel: computation.rawLabel,
    reason: decision.reason,
    confidence: decision.confidence,
    truthSource: decision.truthSource,
    badges: decision.badges.map((badge) => badge.type),
    effectiveTargetRoas: decision.effectiveTargetRoas,
    ratioToTarget: decision.ratioToTarget,
    spend: computation.input.spend,
    purchases: computation.input.purchases ?? 0,
    roas: computation.input.roas,
    recent7dRoas: computation.input.recent7dRoas,
    currency: computation.input.accountCurrency!,
    lifecycleRole,
    assessment: presentation.assessment.value,
    decisionState: presentation.semantics.decisionState,
    heldAction: presentation.heldAction,
    buyerAction: presentation.semantics.buyerAction,
    buyerLabel: presentation.buyerLabel,
    executionAction: presentation.executionAction,
    blockerCodes,
  };
}

export function buildDemoNativeCanonicalFixture() {
  const rows = getDemoMetaCreatives().rows;
  const profile = makeAccountDecisionProfile({
    businessId: DEMO_BUSINESS_ID,
    asOfDate: AS_OF_DATE,
    scope: { type: "account", id: PROVIDER_ACCOUNT_ID },
    spendUnit: 40,
    spendUnitSource: "target_cpa",
    spendUnitConfidence: "high",
    spendUnitEvidence: {
      targetCpa: 40,
      operatorAovAssumption: null,
      metaAttributedAovMean90d: 88,
      metaAttributedAovPurchaseCount90d: 816,
      metaAttributedRevenue90d: 71_808,
      targetRoas: TARGET_ROAS,
      breakEvenRoas: BREAK_EVEN_ROAS,
      accountCpaP50: 36,
      accountCpaSampleCount: 40,
      warnings: [],
    },
    thresholds: {
      zeroConvBurnerSpend: 120,
      cutCandidateSpend: 160,
      sustainedLoserSpend: 240,
      commercialMaturitySpend: 120,
      hardCutSpend: 300,
      recentSampleMinSpend: 40,
      winnerMemoryMinSpend: 120,
      scaleMinPurchases: 10,
      winnerMemoryMinPurchases: 3,
      bottomQuartileRatio: 0.7,
      severeLoserRatio: 0.4,
    },
    expandedEconomicCutAuthority: {
      eligible: true,
      authorityBasis: "commercial_stop_loss",
      reason: null,
    },
  });
  const dataHealth = makeDataHealth({
    calibration: {
      asOfDate: AS_OF_DATE,
      computedAt: COMPUTED_AT,
      sourceFreshnessHours: 2,
      staleTier: "none",
      fallbackMode: "precomputed",
      note: "computed_by_engine",
    },
    lifecycle: {
      asOfDate: AS_OF_DATE,
      computedAt: COMPUTED_AT,
      sourceFreshnessHours: 2,
      staleTier: "none",
      fallbackMode: "precomputed",
      note: "computed_by_engine",
    },
    decisions: {
      asOfDate: AS_OF_DATE,
      computedAt: COMPUTED_AT,
      sourceFreshnessHours: 2,
      staleTier: "none",
      fallbackMode: "precomputed",
      note: "computed_by_engine",
    },
  });
  const adInputs = rows.map(toAdDecisionInput);
  const context = campaignContext(rows);
  const firstPass = computeNativeAdDecisions({
    businessId: DEMO_BUSINESS_ID,
    profile,
    dataHealth,
    adInputs,
    campaignContextMode: "automatic",
    campaignContextById: context,
    previousLabels: new Map(),
  });
  const confirmed = computeNativeAdDecisions({
    businessId: DEMO_BUSINESS_ID,
    profile,
    dataHealth,
    adInputs,
    campaignContextMode: "automatic",
    campaignContextById: context,
    previousLabels: previousLabelsFrom(firstPass),
  });
  const fixture = finalizeDemoNativeCanonicalFixture({
    businessId: DEMO_BUSINESS_ID,
    providerAccountId: PROVIDER_ACCOUNT_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    asOfDate: AS_OF_DATE,
    computedAt: COMPUTED_AT,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    jobRunId: JOB_RUN_ID,
    rows: rows as MetaCreativeApiRow[],
    items: confirmed.map(draftItem),
  });
  return fixture;
}

function main() {
  const fixture = buildDemoNativeCanonicalFixture();
  process.stdout.write(
    `${JSON.stringify(JSON.parse(stableDemoFixtureJson(fixture)), null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
