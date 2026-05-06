import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvConfig } from "@next/env";
import { NextRequest } from "next/server";
import type { CreativeDecisionInputRow } from "@/lib/ai/generate-creative-decisions";
import type {
  CreativeDecisionDeliveryContext,
  CreativeDecisionOsCreative,
  CreativeDecisionRelativeBaseline,
} from "@/lib/creative-decision-os";
import { CREATIVE_DECISION_OS_ENGINE_VERSION } from "@/lib/creative-decision-os";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import { buildCreativeOldRuleChallenger } from "@/lib/creative-old-rule-challenger";
import { getCreativeDecisionOsForRange } from "@/lib/creative-decision-os-source";
import { CREATIVE_MEDIA_BUYER_SCORING_VERSION } from "@/lib/creative-media-buyer-scoring";
import { CREATIVE_OPERATOR_POLICY_VERSION } from "@/lib/creative-operator-policy";
import {
  buildCreativeOperatorItem,
  creativeOperatorSegmentLabel,
} from "@/lib/creative-operator-surface";
import { getDb, resetDbClientCache } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { mapApiRowToUiRow } from "@/app/(dashboard)/creatives/page-support";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { addDaysToIsoDate } from "@/lib/meta/history";
import {
  assessRuntimeTokenReadability,
  buildAliasFactory,
  buildRuntimeTokenReadabilityBlocker,
  classifyRuntimeCandidateSkip,
  countRuntimeSkippedCandidates,
  fetchCreativePayload,
  getCandidateBusinesses,
  installSanitizedRuntimeGuards,
  probeLiveMetaAccountAccess,
  sanitizeText,
  shouldReportNoLiveReadableBusinesses,
  summarizeCandidateEligibility,
  type FetchCreativePayloadResult,
  type RuntimeCandidateSkipReason,
  type RuntimeTokenReadabilityStatus,
  type SourceBusinessRow,
} from "./creative-segmentation-calibration-lab";
import { assignStableCompanyAliases } from "./creative-segmentation-holdout-validation";

loadEnvConfig(process.cwd());

export type AuditWindow = {
  todayReference: string;
  startDate: string;
  endDate: string;
  days: number;
  excludesToday: true;
};

type ActiveContext = {
  isActive: boolean;
  campaignStatus: string | null;
  adSetStatus: string | null;
  source: "campaign_and_adset" | "campaign_only" | "missing_context";
};

type AuditBaselineSummary = {
  scope: "account" | "campaign";
  reliability: "strong" | "medium" | "weak" | "unavailable";
  sampleSize: number;
  creativeCount: number;
  eligibleCreativeCount: number;
  spendBasis: number;
  purchaseBasis: number;
  weightedRoas: number | null;
  weightedCpa: number | null;
  medianRoas: number | null;
  medianCpa: number | null;
  medianSpend: number | null;
  missingContext: string[];
};

export type AuditSampleCandidate = {
  creativeId: string;
  spend: number;
  isActive: boolean;
};

type SanitizedAuditRow = {
  companyAlias: string;
  accountAlias: string;
  campaignAlias: string;
  adSetAlias: string;
  creativeAlias: string;
  activeStatus: boolean;
  activeStatusSource: ActiveContext["source"];
  campaignStatus: string | null;
  adSetStatus: string | null;
  spend30d: number;
  recent7d: Record<string, number> | null;
  mid30d: Record<string, number> | null;
  long90d: Record<string, number> | null;
  currentDecisionOsInternalSegment: string | null;
  currentUserFacingSegment: string;
  mediaBuyerScorecard: {
    relativePerformanceClass: string;
    evidenceMaturity: string;
    trendState: string;
    efficiencyRisk: string;
    winnerSignal: string;
    loserSignal: string;
    contextState: string;
    businessValidation: string;
    recommendedSegment: string;
    confidence: number;
    reasons: string[];
    reviewOnly: boolean;
    blockedActions: string[];
    metrics: {
      roasToBenchmark: number | null;
      cpaToBenchmark: number | null;
      trendRoasRatio: number | null;
      spendToMedian: number | null;
    };
  } | null;
  currentInstructionHeadline: string;
  reasonSummary: string;
  nextObservation: string[];
  benchmarkScope: string;
  benchmarkScopeLabel: string;
  baselineReliability: string;
  accountBaseline: AuditBaselineSummary;
  campaignBaseline: AuditBaselineSummary | null;
  commercialTruthAvailability: {
    targetPackConfigured: boolean;
    missingInputs: string[];
  };
  businessValidationStatus: "favorable" | "missing" | "unfavorable";
  pushReadiness: string | null;
  queueEligible: boolean;
  canApply: boolean;
  lifecycleState: string;
  primaryAction: string;
  evidenceSource: string;
  trustState: string;
  previewWindow: string | null;
  deploymentCompatibility: string;
  deploymentTargetLane: string | null;
  oldRuleChallengerAction: string | null;
  oldRuleChallengerSegment: string | null;
  oldRuleChallengerReason: string | null;
  relativeStrengthClass:
    | "true_scale_candidate"
    | "review_only_scale_candidate"
    | "strong_relative"
    | "none";
  campaignContextLimited: boolean;
};

type PrivateAuditRow = SanitizedAuditRow & {
  businessId: string;
  businessName: string | null;
  accountName: string | null;
  campaignName: string | null;
  adSetName: string | null;
  creativeName: string;
  creativeId: string;
};

type BusinessAuditSummary = {
  companyAlias: string;
  evaluationStatus?: "evaluated" | "failed";
  failureReason?: string;
  screeningLiveRows: number;
  currentDecisionOsRows: number;
  sampledCreatives: number;
  activeCreativesSampled: number;
  userFacingSegments: Record<string, number>;
  oldChallengerSegments: Record<string, number>;
  zeroScale: boolean;
  zeroScaleReview: boolean;
};

type SanitizedAuditArtifact = {
  generatedAt: string;
  source: "creative_live_firm_audit";
  auditWindow: AuditWindow;
  sanitization: {
    rawIdsIncluded: false;
    rawNamesIncluded: false;
    notes: string[];
  };
  cohort: {
    historicalSnapshotCandidates: number;
    eligibleCandidates: number;
    runtimeEligibleBusinesses: number;
    runtimeSkippedCandidates: number;
    runtimeSkippedCandidatesByReason: Record<
      RuntimeCandidateSkipReason,
      number
    >;
    runtimeTokenReadabilityStatus: RuntimeTokenReadabilityStatus;
  };
  globalSummary: {
    sampledCreatives: number;
    businessesWithZeroScale: number;
    businessesWithZeroScaleReview: number;
    userFacingSegments: Record<string, number>;
  };
  businesses: BusinessAuditSummary[];
  rows: SanitizedAuditRow[];
};

type PrivateAuditArtifact = Omit<
  SanitizedAuditArtifact,
  "sanitization" | "rows" | "businesses"
> & {
  rows: PrivateAuditRow[];
  businesses: Array<
    BusinessAuditSummary & { businessId: string; businessName: string | null }
  >;
};

type Pr65CurrentOutputArtifact = {
  generatedAt: string;
  source: "pr65_current_output_fresh";
  artifactStatus: "complete_current_output" | "blocked";
  prBranchCommit: string;
  decisionOsEngineVersion: typeof CREATIVE_DECISION_OS_ENGINE_VERSION;
  scoringEngineVersion: typeof CREATIVE_MEDIA_BUYER_SCORING_VERSION;
  policyVersion: typeof CREATIVE_OPERATOR_POLICY_VERSION;
  valid_for_acceptance: false;
  valid_for_claude_review: boolean;
  validForClaudeReview: boolean;
  acceptanceBlockers: string[];
  runtimeBlockers: string[];
  auditWindow: AuditWindow;
  sanitization: SanitizedAuditArtifact["sanitization"];
  cohort: SanitizedAuditArtifact["cohort"];
  globalSummary: SanitizedAuditArtifact["globalSummary"];
  businesses: BusinessAuditSummary[];
  rows: Array<{
    companyAlias: string;
    accountAlias: string;
    campaignAlias: string;
    adSetAlias: string;
    creativeAlias: string;
    activeStatus: boolean;
    currentAdsecuteSegment: string;
    currentInternalSegment: string | null;
    currentPrimaryDecision: string | null;
    instruction: string;
    benchmarkSummary: {
      scope: string;
      label: string;
      reliability: string;
      accountBaseline: AuditBaselineSummary;
      campaignBaseline: AuditBaselineSummary | null;
    };
    evidenceSummary: {
      spend30d: number;
      recent7d: Record<string, number> | null;
      mid30d: Record<string, number> | null;
      long90d: Record<string, number> | null;
      lifecycleState: string;
      primaryAction: string;
      commercialTruthAvailability: SanitizedAuditRow["commercialTruthAvailability"];
      businessValidationStatus: SanitizedAuditRow["businessValidationStatus"];
      pushReadiness: string | null;
      queueEligible: boolean;
      canApply: boolean;
      evidenceSource: string;
      trustState: string;
      previewWindow: string | null;
      deploymentCompatibility: string;
      deploymentTargetLane: string | null;
    };
    scorecardSummary: SanitizedAuditRow["mediaBuyerScorecard"];
  }>;
};

type RuntimeEligibleBusiness = {
  business: SourceBusinessRow;
  companyAlias: string;
  businessName: string | null;
  live30d: FetchCreativePayloadResult;
};

const OUTPUT_DIR =
  "docs/operator-policy/creative-segmentation-recovery/reports/live-firm-audit";
const ARTIFACT_DIR = path.join(OUTPUT_DIR, "artifacts");
const SANITIZED_ARTIFACT_PATH = path.join(
  ARTIFACT_DIR,
  "sanitized-live-firm-audit.json",
);
const PR65_CURRENT_OUTPUT_ARTIFACT_PATH =
  "docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/artifacts/pr65-current-output-fresh.json";
const LOCAL_PRIVATE_ARTIFACT_PATH =
  "/tmp/adsecute-creative-live-firm-audit-local.json";
const MAX_ROWS_PER_BUSINESS = Number(
  process.env.CREATIVE_LIVE_FIRM_AUDIT_MAX_ROWS ?? 10,
);
const SCREEN_TIMEOUT_MS = Number(
  process.env.CREATIVE_LIVE_FIRM_AUDIT_SCREEN_TIMEOUT_MS ?? 90_000,
);
const DEBUG = process.env.CREATIVE_LIVE_FIRM_AUDIT_DEBUG?.trim() === "1";
const DEFAULT_AUDIT_BASE_URL = "http://127.0.0.1:3000";

const EMPTY_RUNTIME_SKIPS: Record<RuntimeCandidateSkipReason, number> = {
  no_current_meta_connection: 0,
  meta_connection_not_connected: 0,
  no_access_token: 0,
  no_accounts_assigned: 0,
  meta_token_checkpointed: 0,
  provider_read_failure: 0,
  no_current_creative_activity: 0,
};

function round(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nullableRound(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  return round(value, digits);
}

function increment(
  map: Record<string, number>,
  key: string | null | undefined,
) {
  const normalized = key?.trim() || "missing";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

function debug(message: string, extra?: Record<string, unknown>) {
  if (!DEBUG) return;
  console.error(
    `[creative-live-firm-audit] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`,
  );
}

function getCurrentGitCommitHash() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.env.GITHUB_SHA?.trim() || "unknown";
  }
}

function classifyAuditRuntimeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/127\.0\.0\.1:15432|port 15432|ECONNREFUSED/i.test(message)) {
    return "db_tunnel_connection_refused";
  }
  if (/connection terminated due to connection timeout/i.test(message)) {
    return "db_tunnel_connection_timeout";
  }
  if (/timed out/i.test(message)) return "database_query_timeout";
  if (/fetch failed/i.test(message) || /ECONNREFUSED/i.test(message)) {
    return "local_refresh_fetch_failed";
  }
  return "audit_source_read_failed";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string,
) {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(errorMessage)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function currentLocalIsoDate(
  timezone = process.env.CREATIVE_LIVE_FIRM_AUDIT_TIMEZONE ?? "Europe/Istanbul",
) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
    new Date(),
  );
}

export function resolveAuditWindow(
  todayReference = currentLocalIsoDate(),
): AuditWindow {
  const endDate = addDaysToIsoDate(todayReference, -1);
  return {
    todayReference,
    startDate: addDaysToIsoDate(endDate, -29),
    endDate,
    days: 30,
    excludesToday: true,
  };
}

function normalizeStatus(value: string | null | undefined) {
  return value?.trim().toUpperCase() || null;
}

function isActiveMetaStatus(value: string | null | undefined) {
  return normalizeStatus(value) === "ACTIVE";
}

export function deriveCurrentActiveContext(input: {
  contextRow: Pick<MetaCreativeRow, "campaignId" | "adSetId"> | null;
  deliveryContext?: Pick<
    CreativeDecisionDeliveryContext,
    "campaignStatus" | "adSetStatus" | "activeDelivery" | "pausedDelivery"
  > | null;
  campaignStatusById?: Map<string, string | null>;
  adSetStatusById?: Map<string, string | null>;
}): ActiveContext {
  const campaignStatus =
    normalizeStatus(input.deliveryContext?.campaignStatus) ??
    (input.contextRow?.campaignId
      ? (input.campaignStatusById?.get(input.contextRow.campaignId) ?? null)
      : null);
  const adSetStatus =
    normalizeStatus(input.deliveryContext?.adSetStatus) ??
    (input.contextRow?.adSetId
      ? (input.adSetStatusById?.get(input.contextRow.adSetId) ?? null)
      : null);
  const hasDeliveryActivity =
    typeof input.deliveryContext?.activeDelivery === "boolean" ||
    typeof input.deliveryContext?.pausedDelivery === "boolean";
  const deliveryAllowsActive =
    Boolean(input.deliveryContext?.activeDelivery) &&
    !Boolean(input.deliveryContext?.pausedDelivery);

  if (adSetStatus) {
    const statusIsActive =
      isActiveMetaStatus(adSetStatus) &&
      (campaignStatus == null || isActiveMetaStatus(campaignStatus));
    return {
      isActive: hasDeliveryActivity
        ? deliveryAllowsActive && statusIsActive
        : statusIsActive,
      campaignStatus,
      adSetStatus,
      source: "campaign_and_adset",
    };
  }

  if (campaignStatus) {
    const statusIsActive = isActiveMetaStatus(campaignStatus);
    return {
      isActive: hasDeliveryActivity
        ? deliveryAllowsActive && statusIsActive
        : statusIsActive,
      campaignStatus,
      adSetStatus,
      source: "campaign_only",
    };
  }

  return {
    isActive: false,
    campaignStatus,
    adSetStatus,
    source: "missing_context",
  };
}

export function selectDeterministicAuditSample<T extends AuditSampleCandidate>(
  rows: T[],
  limit = MAX_ROWS_PER_BUSINESS,
) {
  const sortRows = (input: T[]) =>
    [...input].sort(
      (left, right) =>
        right.spend - left.spend ||
        left.creativeId.localeCompare(right.creativeId),
    );

  const active = sortRows(rows.filter((row) => row.isActive));
  const inactive = sortRows(rows.filter((row) => !row.isActive));
  return [...active, ...inactive].slice(0, limit);
}

function metricWindow(
  rowsById: Map<string, MetaCreativeRow>,
  creativeId: string,
) {
  const row = rowsById.get(creativeId);
  if (!row) return null;
  return {
    spend: round(row.spend),
    purchaseValue: round(row.purchaseValue),
    roas: round(row.roas),
    cpa: round(row.cpa),
    purchases: round(row.purchases),
    impressions: round(row.impressions),
    linkClicks: round(row.linkClicks),
  };
}

function summarizeBaseline(
  baseline: CreativeDecisionRelativeBaseline,
): AuditBaselineSummary {
  return {
    scope: baseline.scope,
    reliability: baseline.reliability,
    sampleSize: baseline.sampleSize,
    creativeCount: baseline.creativeCount,
    eligibleCreativeCount: baseline.eligibleCreativeCount,
    spendBasis: round(baseline.spendBasis),
    purchaseBasis: round(baseline.purchaseBasis),
    weightedRoas: nullableRound(baseline.weightedRoas),
    weightedCpa: nullableRound(baseline.weightedCpa),
    medianRoas: nullableRound(baseline.medianRoas),
    medianCpa: nullableRound(baseline.medianCpa),
    medianSpend: nullableRound(baseline.medianSpend),
    missingContext: baseline.missingContext,
  };
}

function summarizeCampaignBaseline(
  creative: CreativeDecisionOsCreative,
): AuditBaselineSummary | null {
  if (creative.benchmarkScope !== "campaign") return null;
  return summarizeBaseline(creative.relativeBaseline);
}

function toOldRuleInput(
  creative: CreativeDecisionOsCreative,
  contextRow: MetaCreativeRow | null,
): CreativeDecisionInputRow {
  return {
    creativeId: creative.creativeId,
    name: creative.name,
    creativeFormat: creative.creativeFormat,
    creativeAgeDays: creative.creativeAgeDays,
    spendVelocity: creative.spend / Math.max(1, creative.creativeAgeDays || 1),
    frequency:
      contextRow?.impressions && contextRow.impressions > 0
        ? round(contextRow.clicks / Math.max(1, contextRow.impressions), 4)
        : 0,
    spend: creative.spend,
    purchaseValue: creative.purchaseValue,
    roas: creative.roas,
    cpa: creative.cpa,
    ctr: creative.ctr,
    cpm: contextRow?.cpm ?? 0,
    cpc: contextRow?.cpcLink ?? 0,
    purchases: creative.purchases,
    impressions: creative.impressions,
    linkClicks: creative.linkClicks,
    hookRate: contextRow?.thumbstop ?? 0,
    holdRate: contextRow?.video100 ?? 0,
    video25Rate: contextRow?.video25 ?? 0,
    watchRate: contextRow?.video50 ?? 0,
    video75Rate: contextRow?.video75 ?? 0,
    clickToPurchaseRate:
      creative.linkClicks > 0
        ? (creative.purchases / creative.linkClicks) * 100
        : 0,
    atcToPurchaseRate: contextRow?.atcToPurchaseRatio ?? 0,
    accountId: contextRow?.accountId ?? null,
    accountName: contextRow?.accountName ?? null,
    campaignId: contextRow?.campaignId ?? null,
    campaignName: contextRow?.campaignName ?? null,
    adSetId: contextRow?.adSetId ?? null,
    adSetName: contextRow?.adSetName ?? null,
  };
}

function hasNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasRelativeBaselineContext(creative: CreativeDecisionOsCreative) {
  const baseline = creative.relativeBaseline;
  const reliable =
    baseline.reliability === "strong" || baseline.reliability === "medium";
  return (
    reliable &&
    baseline.sampleSize >= 3 &&
    baseline.eligibleCreativeCount >= 3 &&
    hasNumber(baseline.spendBasis) &&
    baseline.spendBasis >= 150 &&
    hasNumber(baseline.purchaseBasis) &&
    baseline.purchaseBasis >= 3 &&
    hasNumber(baseline.medianRoas) &&
    baseline.medianRoas > 0 &&
    hasNumber(baseline.medianSpend) &&
    baseline.medianSpend > 0
  );
}

function hasStrongRelativeBaselineContext(
  creative: CreativeDecisionOsCreative,
) {
  const baseline = creative.relativeBaseline;
  return (
    hasRelativeBaselineContext(creative) &&
    baseline.reliability === "strong" &&
    baseline.sampleSize >= 6 &&
    baseline.eligibleCreativeCount >= 6 &&
    (baseline.spendBasis ?? 0) >= 500 &&
    (baseline.purchaseBasis ?? 0) >= 8
  );
}

function hasRelativeScaleReviewEvidence(creative: CreativeDecisionOsCreative) {
  const baseline = creative.relativeBaseline;
  const medianSpend = baseline.medianSpend ?? 0;
  const medianRoas = baseline.medianRoas ?? 0;
  const medianCpa = baseline.medianCpa ?? null;
  if (!hasRelativeBaselineContext(creative)) return false;
  if (
    !hasNumber(creative.spend) ||
    !hasNumber(creative.purchases) ||
    !hasNumber(creative.roas)
  ) {
    return false;
  }
  if (creative.spend < Math.max(80, medianSpend * 0.2)) return false;
  if (creative.purchases < 2) return false;
  if (creative.roas < medianRoas * 1.4) return false;
  if (
    hasNumber(creative.cpa) &&
    creative.cpa > 0 &&
    hasNumber(medianCpa) &&
    medianCpa > 0 &&
    creative.cpa > medianCpa * 1.2
  ) {
    return false;
  }
  return true;
}

function hasTrueScaleEvidence(creative: CreativeDecisionOsCreative) {
  const baseline = creative.relativeBaseline;
  const medianRoas = baseline.medianRoas ?? 0;
  const medianCpa = baseline.medianCpa ?? null;
  const medianSpend = baseline.medianSpend ?? 0;
  if (!hasStrongRelativeBaselineContext(creative)) return false;
  if (creative.economics.status !== "eligible") return false;
  if (!hasRelativeScaleReviewEvidence(creative)) return false;
  if (
    !hasNumber(creative.spend) ||
    creative.spend < Math.max(300, medianSpend * 1.3)
  ) {
    return false;
  }
  if (!hasNumber(creative.purchases) || creative.purchases < 6) return false;
  if (!hasNumber(creative.roas) || creative.roas < medianRoas * 1.6)
    return false;
  if (
    hasNumber(creative.cpa) &&
    creative.cpa > 0 &&
    hasNumber(medianCpa) &&
    medianCpa > 0 &&
    creative.cpa > medianCpa
  ) {
    return false;
  }
  return true;
}

function resolveBusinessValidationStatus(input: {
  creative: CreativeDecisionOsCreative;
  commercialTruthConfigured: boolean;
}) {
  if (
    !input.commercialTruthConfigured ||
    input.creative.trust.truthState === "degraded_missing_truth" ||
    input.creative.trust.operatorDisposition === "profitable_truth_capped"
  ) {
    return "missing" as const;
  }

  if (
    input.creative.economics.status !== "eligible" ||
    input.creative.trust.truthState !== "live_confident" ||
    input.creative.trust.evidence?.aggressiveActionBlocked === true ||
    input.creative.trust.evidence?.suppressed === true
  ) {
    return "unfavorable" as const;
  }

  return "favorable" as const;
}

function hasWeakCampaignContext(creative: CreativeDecisionOsCreative) {
  return creative.deployment.compatibility.status === "blocked";
}

function isReviewOnlyScaleCandidate(input: {
  creative: CreativeDecisionOsCreative;
  commercialTruthConfigured: boolean;
}) {
  const businessValidationStatus = resolveBusinessValidationStatus(input);
  return (
    businessValidationStatus === "missing" &&
    hasTrueScaleEvidence(input.creative) &&
    input.creative.primaryAction !== "refresh_replace" &&
    input.creative.primaryAction !== "block_deploy" &&
    input.creative.lifecycleState !== "fatigued_winner" &&
    input.creative.fatigue.status !== "fatigued" &&
    !hasWeakCampaignContext(input.creative)
  );
}

function mapOldRuleSegmentLabel(action: string | null | undefined) {
  switch (action) {
    case "scale":
    case "scale_hard":
      return "Scale";
    case "test_more":
      return "Test More";
    case "watch":
      return "Watch";
    case "pause":
    case "kill":
      return "Cut";
    default:
      return null;
  }
}

async function resolveBusinessNames(businessIds: string[]) {
  const sql = getDb();
  if (businessIds.length === 0) return new Map<string, string | null>();
  const rows = await sql.query<{ id: string; name: string | null }>(
    `SELECT id, name FROM businesses WHERE id = ANY($1::uuid[])`,
    [businessIds],
  );
  return new Map(rows.map((row) => [row.id, row.name ?? null]));
}

export function resolveAuditBaseUrl(
  raw = process.env.CREATIVE_LIVE_FIRM_AUDIT_BASE_URL,
) {
  const value = raw?.trim();
  if (!value) return DEFAULT_AUDIT_BASE_URL;
  return value.replace(/\/+$/, "");
}

export function isAuditLocalRefreshUrl(input: string | URL) {
  const url = new URL(input.toString());
  const isLocalHost =
    url.hostname === "127.0.0.1" || url.hostname === "localhost";
  return isLocalHost && url.pathname === "/api/creatives/decision-os";
}

function installAuditLocalRefreshGuard() {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (isAuditLocalRefreshUrl(url)) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return nativeFetch(input, init);
  };
  return () => {
    globalThis.fetch = nativeFetch;
  };
}

async function waitForAuditSnapshotRefreshes(timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const refreshState = (
      globalThis as typeof globalThis & {
        __omniadsMetaCreativesRefreshState?: Set<string>;
      }
    ).__omniadsMetaCreativesRefreshState;
    if (!refreshState || refreshState.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function buildRequestUrl(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  decisionAsOf?: string;
  baseUrl?: string;
}) {
  const url = new URL(
    "/api/creatives/decision-os",
    input.baseUrl ?? resolveAuditBaseUrl(),
  );
  url.searchParams.set("businessId", input.businessId);
  url.searchParams.set("startDate", input.startDate);
  url.searchParams.set("endDate", input.endDate);
  if (input.decisionAsOf)
    url.searchParams.set("decisionAsOf", input.decisionAsOf);
  return url.toString();
}

async function fetchWindowRows(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  const request = new NextRequest(
    buildRequestUrl({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      decisionAsOf: input.endDate,
    }),
  );
  return fetchCreativePayload({
    request,
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
  });
}

async function discoverRuntimeEligibleBusinesses(auditWindow: AuditWindow) {
  const candidateRows = await getCandidateBusinesses();
  const candidateEligibility = summarizeCandidateEligibility(candidateRows);
  const runtimeTokenReadability = await assessRuntimeTokenReadability({
    candidates: candidateEligibility.eligible,
  });
  const runtimeSkippedCandidatesByReason = { ...EMPTY_RUNTIME_SKIPS };
  const runtimeTokenReadabilityBlocker = buildRuntimeTokenReadabilityBlocker(
    runtimeTokenReadability.status,
  );
  if (runtimeTokenReadabilityBlocker) {
    throw new Error(runtimeTokenReadabilityBlocker);
  }

  const runtimeEligibleBusinesses: Array<{
    business: SourceBusinessRow;
    live30d: FetchCreativePayloadResult;
  }> = [];

  for (const [
    candidateIndex,
    business,
  ] of candidateEligibility.eligible.entries()) {
    debug("screening-candidate", {
      candidate: candidateIndex + 1,
      total: candidateEligibility.eligible.length,
    });
    const request = new NextRequest(
      buildRequestUrl({
        businessId: business.business_id,
        startDate: auditWindow.startDate,
        endDate: auditWindow.endDate,
        decisionAsOf: auditWindow.endDate,
      }),
    );

    const live30d = await withTimeout(
      fetchCreativePayload({
        request,
        businessId: business.business_id,
        startDate: auditWindow.startDate,
        endDate: auditWindow.endDate,
        snapshotBypass: true,
      }),
      SCREEN_TIMEOUT_MS,
      "Timed out reading live creative payload for runtime eligibility.",
    ).catch(() => null);
    if (!live30d) {
      runtimeSkippedCandidatesByReason.provider_read_failure += 1;
      debug("screening-skip", {
        candidate: candidateIndex + 1,
        reason: "provider_read_failure",
      });
      continue;
    }

    const integration = await getIntegration(
      business.business_id,
      "meta",
    ).catch(() => null);
    const assignedAccountIds = await fetchAssignedAccountIds(
      business.business_id,
    ).catch(() => []);
    const accountProbes =
      live30d.rows.length === 0 && integration?.access_token
        ? await probeLiveMetaAccountAccess({
            accessToken: integration.access_token,
            accountIds: assignedAccountIds,
            startDate: auditWindow.startDate,
            endDate: auditWindow.endDate,
          })
        : [];
    const runtimeSkipReason = classifyRuntimeCandidateSkip({
      payloadStatus: live30d.status,
      tableRowCount: live30d.rows.length,
      accountProbes,
    });
    if (runtimeSkipReason) {
      runtimeSkippedCandidatesByReason[runtimeSkipReason] += 1;
      debug("screening-skip", {
        candidate: candidateIndex + 1,
        reason: runtimeSkipReason,
      });
      continue;
    }

    runtimeEligibleBusinesses.push({ business, live30d });
    debug("screening-eligible", {
      candidate: candidateIndex + 1,
      rows: live30d.rows.length,
    });
  }

  if (
    shouldReportNoLiveReadableBusinesses({
      runtimeTokenReadabilityStatus: runtimeTokenReadability.status,
      runtimeEligibleCandidateCount: runtimeEligibleBusinesses.length,
    })
  ) {
    throw new Error(
      "No live Meta-readable businesses were available for the live-firm audit.",
    );
  }

  resetDbClientCache();
  const businessNames = await resolveBusinessNames(
    runtimeEligibleBusinesses.map(({ business }) => business.business_id),
  ).catch((error) => {
    debug("business-name-resolution-failed", {
      failureReason: classifyAuditRuntimeError(error),
    });
    return new Map<string, string | null>();
  });
  const assigned = assignStableCompanyAliases(
    runtimeEligibleBusinesses.map(({ business, live30d }) => ({
      businessId: business.business_id,
      business,
      live30d,
    })),
  ).map((row) => ({
    business: row.business,
    companyAlias: row.companyAlias,
    businessName: businessNames.get(row.business.business_id) ?? null,
    live30d: row.live30d,
  }));

  return {
    candidateRows,
    candidateEligibility,
    runtimeTokenReadability,
    runtimeSkippedCandidatesByReason,
    runtimeEligibleBusinesses: assigned,
  };
}

function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

async function persistArtifacts(input: {
  sanitized: SanitizedAuditArtifact;
  localPrivate: PrivateAuditArtifact;
  pr65CurrentOutput?: Pr65CurrentOutputArtifact;
}) {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    SANITIZED_ARTIFACT_PATH,
    `${JSON.stringify(input.sanitized, null, 2)}\n`,
    "utf8",
  );
  if (input.pr65CurrentOutput)
    await persistPr65CurrentOutputArtifact(input.pr65CurrentOutput);
  await writeFile(
    LOCAL_PRIVATE_ARTIFACT_PATH,
    `${JSON.stringify(input.localPrivate, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        sanitizedArtifact: SANITIZED_ARTIFACT_PATH,
        pr65CurrentOutputArtifact: input.pr65CurrentOutput
          ? PR65_CURRENT_OUTPUT_ARTIFACT_PATH
          : null,
        localPrivateArtifact: LOCAL_PRIVATE_ARTIFACT_PATH,
        businesses: input.sanitized.cohort.runtimeEligibleBusinesses,
        sampledCreatives: input.sanitized.globalSummary.sampledCreatives,
        userFacingSegments: input.sanitized.globalSummary.userFacingSegments,
      },
      null,
      2,
    ),
  );
}

async function persistPr65CurrentOutputArtifact(
  artifact: Pr65CurrentOutputArtifact,
) {
  await mkdir(path.dirname(PR65_CURRENT_OUTPUT_ARTIFACT_PATH), {
    recursive: true,
  });
  await writeFile(
    PR65_CURRENT_OUTPUT_ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  console.log(
    JSON.stringify(
      {
        pr65CurrentOutputArtifact: PR65_CURRENT_OUTPUT_ARTIFACT_PATH,
        valid_for_claude_review: artifact.valid_for_claude_review,
        validForClaudeReview: artifact.validForClaudeReview,
        valid_for_acceptance: artifact.valid_for_acceptance,
        runtimeBlockers: artifact.runtimeBlockers,
      },
      null,
      2,
    ),
  );
}

function buildPr65CurrentOutputArtifact(
  sanitizedArtifact: SanitizedAuditArtifact,
): Pr65CurrentOutputArtifact {
  const failedBusinesses = sanitizedArtifact.businesses.filter(
    (business) => business.evaluationStatus === "failed",
  );
  const runtimeBlockers = [
    ...(sanitizedArtifact.rows.length === 0
      ? ["no_current_output_rows_generated"]
      : []),
    ...failedBusinesses.map(
      (business) =>
        `${business.companyAlias}:${business.failureReason ?? "audit_source_read_failed"}`,
    ),
  ];
  return {
    generatedAt: sanitizedArtifact.generatedAt,
    source: "pr65_current_output_fresh",
    artifactStatus: "complete_current_output",
    prBranchCommit: getCurrentGitCommitHash(),
    decisionOsEngineVersion: CREATIVE_DECISION_OS_ENGINE_VERSION,
    scoringEngineVersion: CREATIVE_MEDIA_BUYER_SCORING_VERSION,
    policyVersion: CREATIVE_OPERATOR_POLICY_VERSION,
    valid_for_acceptance: false,
    valid_for_claude_review: runtimeBlockers.length === 0,
    validForClaudeReview: runtimeBlockers.length === 0,
    acceptanceBlockers: [
      "fresh_expected_labels_not_regenerated_in_this_artifact",
      "artifact_contains_current_adsecute_outputs_only",
    ],
    runtimeBlockers,
    auditWindow: sanitizedArtifact.auditWindow,
    sanitization: sanitizedArtifact.sanitization,
    cohort: sanitizedArtifact.cohort,
    globalSummary: sanitizedArtifact.globalSummary,
    businesses: sanitizedArtifact.businesses,
    rows: sanitizedArtifact.rows.map((row) => ({
      companyAlias: row.companyAlias,
      accountAlias: row.accountAlias,
      campaignAlias: row.campaignAlias,
      adSetAlias: row.adSetAlias,
      creativeAlias: row.creativeAlias,
      activeStatus: row.activeStatus,
      currentAdsecuteSegment: row.currentUserFacingSegment,
      currentInternalSegment: row.currentDecisionOsInternalSegment,
      currentPrimaryDecision:
        row.mediaBuyerScorecard?.recommendedSegment ?? null,
      instruction: row.currentInstructionHeadline,
      benchmarkSummary: {
        scope: row.benchmarkScope,
        label: row.benchmarkScopeLabel,
        reliability: row.baselineReliability,
        accountBaseline: row.accountBaseline,
        campaignBaseline: row.campaignBaseline,
      },
      evidenceSummary: {
        spend30d: row.spend30d,
        recent7d: row.recent7d,
        mid30d: row.mid30d,
        long90d: row.long90d,
        lifecycleState: row.lifecycleState,
        primaryAction: row.primaryAction,
        commercialTruthAvailability: row.commercialTruthAvailability,
        businessValidationStatus: row.businessValidationStatus,
        pushReadiness: row.pushReadiness,
        queueEligible: row.queueEligible,
        canApply: row.canApply,
        evidenceSource: row.evidenceSource,
        trustState: row.trustState,
        previewWindow: row.previewWindow,
        deploymentCompatibility: row.deploymentCompatibility,
        deploymentTargetLane: row.deploymentTargetLane,
      },
      scorecardSummary: row.mediaBuyerScorecard,
    })),
  };
}

function buildBlockedPr65CurrentOutputArtifact(input: {
  generatedAt: string;
  auditWindow: AuditWindow;
  blocker: string;
}): Pr65CurrentOutputArtifact {
  return {
    generatedAt: input.generatedAt,
    source: "pr65_current_output_fresh",
    artifactStatus: "blocked",
    prBranchCommit: getCurrentGitCommitHash(),
    decisionOsEngineVersion: CREATIVE_DECISION_OS_ENGINE_VERSION,
    scoringEngineVersion: CREATIVE_MEDIA_BUYER_SCORING_VERSION,
    policyVersion: CREATIVE_OPERATOR_POLICY_VERSION,
    valid_for_acceptance: false,
    valid_for_claude_review: false,
    validForClaudeReview: false,
    acceptanceBlockers: [
      "fresh_current_output_not_generated",
      "fresh_expected_labels_not_regenerated",
    ],
    runtimeBlockers: [input.blocker],
    auditWindow: input.auditWindow,
    sanitization: {
      rawIdsIncluded: false,
      rawNamesIncluded: false,
      notes: [
        "No raw business IDs, account IDs, or names are included.",
        "This artifact records a runtime block before current-output rows could be generated.",
      ],
    },
    cohort: {
      historicalSnapshotCandidates: 0,
      eligibleCandidates: 0,
      runtimeEligibleBusinesses: 0,
      runtimeSkippedCandidates: 0,
      runtimeSkippedCandidatesByReason: EMPTY_RUNTIME_SKIPS,
      runtimeTokenReadabilityStatus: "not_needed",
    },
    globalSummary: {
      sampledCreatives: 0,
      businessesWithZeroScale: 0,
      businessesWithZeroScaleReview: 0,
      userFacingSegments: {},
    },
    businesses: [],
    rows: [],
  };
}

export async function runCreativeLiveFirmAudit() {
  const restoreRuntime = installSanitizedRuntimeGuards();
  const restoreFetch = installAuditLocalRefreshGuard();
  try {
    const generatedAt = new Date().toISOString();
    const auditWindow = resolveAuditWindow();
    const discovery = await discoverRuntimeEligibleBusinesses(
      auditWindow,
    ).catch(async (error) => {
      const blocker = `discovery:${classifyAuditRuntimeError(error)}`;
      await persistPr65CurrentOutputArtifact(
        buildBlockedPr65CurrentOutputArtifact({
          generatedAt,
          auditWindow,
          blocker,
        }),
      );
      return null;
    });
    if (!discovery) {
      return {
        sanitizedArtifact: null,
        privateArtifact: null,
      };
    }
    const sanitizedRows: SanitizedAuditRow[] = [];
    const localPrivateRows: PrivateAuditRow[] = [];
    const businessSummaries: BusinessAuditSummary[] = [];
    const globalSegments: Record<string, number> = {};

    for (const runtimeEligible of discovery.runtimeEligibleBusinesses) {
      const businessId = runtimeEligible.business.business_id;
      debug("evaluating-business", {
        companyAlias: runtimeEligible.companyAlias,
      });
      try {
        const request = new NextRequest(
          buildRequestUrl({
            businessId,
            startDate: auditWindow.startDate,
            endDate: auditWindow.endDate,
            decisionAsOf: auditWindow.endDate,
          }),
        );
        const decisionOs = await getCreativeDecisionOsForRange({
          request,
          businessId,
          startDate: auditWindow.startDate,
          endDate: auditWindow.endDate,
          analyticsStartDate: auditWindow.startDate,
          analyticsEndDate: auditWindow.endDate,
          decisionAsOf: auditWindow.endDate,
        });

        const last7 = await fetchWindowRows({
          businessId,
          startDate: addDaysToIsoDate(auditWindow.endDate, -6),
          endDate: auditWindow.endDate,
        });
        const last90 = await fetchWindowRows({
          businessId,
          startDate: addDaysToIsoDate(auditWindow.endDate, -89),
          endDate: auditWindow.endDate,
        });
        const live30d = runtimeEligible.live30d;

        const currentRowsById = new Map(
          live30d.rows.map((row) => [row.id, row]),
        );
        const last7ById = new Map(last7.rows.map((row) => [row.id, row]));
        const last90ById = new Map(last90.rows.map((row) => [row.id, row]));

        const sampled = selectDeterministicAuditSample(
          decisionOs.creatives.map((creative) => {
            const contextRow = currentRowsById.get(creative.creativeId) ?? null;
            const active = deriveCurrentActiveContext({
              contextRow,
              deliveryContext: creative.deliveryContext ?? null,
            });
            return {
              creativeId: creative.creativeId,
              spend: creative.spend,
              isActive: active.isActive,
              creative,
              contextRow,
              active,
            };
          }),
        );

        const accountAliasFactory = buildAliasFactory(
          `${runtimeEligible.companyAlias}-account`,
        );
        const campaignAliasFactory = buildAliasFactory(
          `${runtimeEligible.companyAlias}-campaign`,
        );
        const adSetAliasFactory = buildAliasFactory(
          `${runtimeEligible.companyAlias}-adset`,
        );
        const creativeAliasFactory = buildAliasFactory(
          `${runtimeEligible.companyAlias}-creative`,
        );

        const allOldRule = buildCreativeOldRuleChallenger(
          decisionOs.creatives.map((creative) =>
            toOldRuleInput(
              creative,
              currentRowsById.get(creative.creativeId) ?? null,
            ),
          ),
        );
        const oldRuleById = new Map(
          allOldRule.map((row) => [row.creativeId, row]),
        );

        const segmentCounts: Record<string, number> = {};
        const oldChallengerCounts: Record<string, number> = {};

        for (const entry of sampled) {
          const creative = entry.creative;
          const operatorItem = buildCreativeOperatorItem(creative);
          const oldRule = oldRuleById.get(creative.creativeId) ?? null;
          const companyAlias = runtimeEligible.companyAlias;
          const accountAlias = accountAliasFactory(
            entry.contextRow?.accountId ?? entry.contextRow?.accountName,
          );
          const campaignAlias = campaignAliasFactory(
            entry.contextRow?.campaignName ?? entry.contextRow?.campaignId,
          );
          const adSetAlias = adSetAliasFactory(
            entry.contextRow?.adSetName ?? entry.contextRow?.adSetId,
          );
          const creativeAlias = creativeAliasFactory(creative.name);
          const replacements: Array<[string | null | undefined, string]> = [
            [entry.contextRow?.accountName, accountAlias],
            [entry.contextRow?.accountId, accountAlias],
            [entry.contextRow?.campaignName, campaignAlias],
            [entry.contextRow?.campaignId, campaignAlias],
            [entry.contextRow?.adSetName, adSetAlias],
            [entry.contextRow?.adSetId, adSetAlias],
            [creative.name, creativeAlias],
            [creative.creativeId, creativeAlias],
          ];
          const userFacingSegment = creativeOperatorSegmentLabel(creative);
          const oldRuleSegment = oldRule?.challengerAction ?? null;
          const commercialTruthConfigured =
            decisionOs.commercialTruthCoverage.configuredSections.targetPack;
          const businessValidationStatus = resolveBusinessValidationStatus({
            creative,
            commercialTruthConfigured,
          });
          const relativeStrengthClass = hasTrueScaleEvidence(creative)
            ? isReviewOnlyScaleCandidate({
                creative,
                commercialTruthConfigured,
              })
              ? "review_only_scale_candidate"
              : "true_scale_candidate"
            : hasRelativeScaleReviewEvidence(creative)
              ? "strong_relative"
              : "none";

          const sanitizedRow: SanitizedAuditRow = {
            companyAlias,
            accountAlias,
            campaignAlias,
            adSetAlias,
            creativeAlias,
            activeStatus: entry.active.isActive,
            activeStatusSource: entry.active.source,
            campaignStatus: entry.active.campaignStatus,
            adSetStatus: entry.active.adSetStatus,
            spend30d: round(creative.spend),
            recent7d: metricWindow(last7ById, creative.creativeId),
            mid30d: metricWindow(currentRowsById, creative.creativeId),
            long90d: metricWindow(last90ById, creative.creativeId),
            currentDecisionOsInternalSegment:
              creative.operatorPolicy?.segment ?? null,
            currentUserFacingSegment: userFacingSegment,
            mediaBuyerScorecard: creative.operatorPolicy?.mediaBuyerScorecard
              ? {
                  relativePerformanceClass:
                    creative.operatorPolicy.mediaBuyerScorecard
                      .relativePerformanceClass,
                  evidenceMaturity:
                    creative.operatorPolicy.mediaBuyerScorecard
                      .evidenceMaturity,
                  trendState:
                    creative.operatorPolicy.mediaBuyerScorecard.trendState,
                  efficiencyRisk:
                    creative.operatorPolicy.mediaBuyerScorecard.efficiencyRisk,
                  winnerSignal:
                    creative.operatorPolicy.mediaBuyerScorecard.winnerSignal,
                  loserSignal:
                    creative.operatorPolicy.mediaBuyerScorecard.loserSignal,
                  contextState:
                    creative.operatorPolicy.mediaBuyerScorecard.contextState,
                  businessValidation:
                    creative.operatorPolicy.mediaBuyerScorecard
                      .businessValidation,
                  recommendedSegment:
                    creative.operatorPolicy.mediaBuyerScorecard
                      .recommendedSegment,
                  confidence: round(
                    creative.operatorPolicy.mediaBuyerScorecard.confidence,
                    3,
                  ),
                  reasons: creative.operatorPolicy.mediaBuyerScorecard.reasons,
                  reviewOnly:
                    creative.operatorPolicy.mediaBuyerScorecard.reviewOnly,
                  blockedActions:
                    creative.operatorPolicy.mediaBuyerScorecard.blockedActions,
                  metrics: {
                    roasToBenchmark: nullableRound(
                      creative.operatorPolicy.mediaBuyerScorecard.metrics
                        .roasToBenchmark,
                      3,
                    ),
                    cpaToBenchmark: nullableRound(
                      creative.operatorPolicy.mediaBuyerScorecard.metrics
                        .cpaToBenchmark,
                      3,
                    ),
                    trendRoasRatio: nullableRound(
                      creative.operatorPolicy.mediaBuyerScorecard.metrics
                        .trendRoasRatio,
                      3,
                    ),
                    spendToMedian: nullableRound(
                      creative.operatorPolicy.mediaBuyerScorecard.metrics
                        .spendToMedian,
                      3,
                    ),
                  },
                }
              : null,
            currentInstructionHeadline: sanitizeText(
              operatorItem.instruction?.headline ?? "",
              replacements,
            ),
            reasonSummary: sanitizeText(operatorItem.reason, replacements),
            nextObservation: (
              operatorItem.instruction?.nextObservation ?? []
            ).map((value) => sanitizeText(value, replacements)),
            benchmarkScope: creative.benchmarkScope,
            benchmarkScopeLabel: sanitizeText(
              creative.benchmarkScopeLabel,
              replacements,
            ),
            baselineReliability: creative.benchmarkReliability,
            accountBaseline: summarizeBaseline(creative.relativeBaseline),
            campaignBaseline: summarizeCampaignBaseline(creative),
            commercialTruthAvailability: {
              targetPackConfigured: commercialTruthConfigured,
              missingInputs: decisionOs.commercialTruthCoverage.missingInputs,
            },
            businessValidationStatus,
            pushReadiness: creative.operatorPolicy?.pushReadiness ?? null,
            queueEligible: creative.operatorPolicy?.queueEligible ?? false,
            canApply: creative.operatorPolicy?.canApply ?? false,
            lifecycleState: creative.lifecycleState,
            primaryAction: creative.primaryAction,
            evidenceSource: creative.evidenceSource,
            trustState: creative.trust.truthState,
            previewWindow: creative.previewStatus?.liveDecisionWindow ?? null,
            deploymentCompatibility: creative.deployment.compatibility.status,
            deploymentTargetLane: creative.deployment.targetLane ?? null,
            oldRuleChallengerAction: oldRule?.challengerAction ?? null,
            oldRuleChallengerSegment: mapOldRuleSegmentLabel(
              oldRule?.challengerAction,
            ),
            oldRuleChallengerReason: oldRule
              ? sanitizeText(oldRule.reason, replacements)
              : null,
            relativeStrengthClass,
            campaignContextLimited: hasWeakCampaignContext(creative),
          };

          const privateRow: PrivateAuditRow = {
            ...sanitizedRow,
            businessId,
            businessName: runtimeEligible.businessName,
            accountName: entry.contextRow?.accountName ?? null,
            campaignName: entry.contextRow?.campaignName ?? null,
            adSetName: entry.contextRow?.adSetName ?? null,
            creativeName: creative.name,
            creativeId: creative.creativeId,
          };

          sanitizedRows.push(sanitizedRow);
          localPrivateRows.push(privateRow);
          increment(segmentCounts, userFacingSegment);
          increment(oldChallengerCounts, oldRuleSegment);
          increment(globalSegments, userFacingSegment);
        }

        businessSummaries.push({
          companyAlias: runtimeEligible.companyAlias,
          evaluationStatus: "evaluated",
          screeningLiveRows: runtimeEligible.live30d.rows.length,
          currentDecisionOsRows: decisionOs.creatives.length,
          sampledCreatives: sampled.length,
          activeCreativesSampled: sampled.filter((row) => row.isActive).length,
          userFacingSegments: segmentCounts,
          oldChallengerSegments: oldChallengerCounts,
          zeroScale: (segmentCounts.Scale ?? 0) === 0,
          zeroScaleReview: (segmentCounts["Scale Review"] ?? 0) === 0,
        });
        debug("evaluated-business", {
          companyAlias: runtimeEligible.companyAlias,
          creatives: decisionOs.creatives.length,
          sampled: sampled.length,
        });
      } catch (error) {
        const failureReason = classifyAuditRuntimeError(error);
        businessSummaries.push({
          companyAlias: runtimeEligible.companyAlias,
          evaluationStatus: "failed",
          failureReason,
          screeningLiveRows: runtimeEligible.live30d.rows.length,
          currentDecisionOsRows: 0,
          sampledCreatives: 0,
          activeCreativesSampled: 0,
          userFacingSegments: {},
          oldChallengerSegments: {},
          zeroScale: true,
          zeroScaleReview: true,
        });
        debug("business-evaluation-failed", {
          companyAlias: runtimeEligible.companyAlias,
          failureReason,
        });
      }
    }

    const sanitizedArtifact: SanitizedAuditArtifact = {
      generatedAt,
      source: "creative_live_firm_audit",
      auditWindow,
      sanitization: {
        rawIdsIncluded: false,
        rawNamesIncluded: false,
        notes: [
          "Company, campaign, ad set, account, and creative identifiers are replaced with stable aliases.",
          "A local private reference artifact with raw names is written to /tmp and is not committed.",
        ],
      },
      cohort: {
        historicalSnapshotCandidates: discovery.candidateRows.length,
        eligibleCandidates: discovery.candidateEligibility.eligible.length,
        runtimeEligibleBusinesses: discovery.runtimeEligibleBusinesses.length,
        runtimeSkippedCandidates: countRuntimeSkippedCandidates(
          discovery.runtimeSkippedCandidatesByReason,
        ),
        runtimeSkippedCandidatesByReason:
          discovery.runtimeSkippedCandidatesByReason,
        runtimeTokenReadabilityStatus: discovery.runtimeTokenReadability.status,
      },
      globalSummary: {
        sampledCreatives: sanitizedRows.length,
        businessesWithZeroScale: businessSummaries.filter(
          (row) => row.zeroScale,
        ).length,
        businessesWithZeroScaleReview: businessSummaries.filter(
          (row) => row.zeroScaleReview,
        ).length,
        userFacingSegments: globalSegments,
      },
      businesses: businessSummaries,
      rows: sanitizedRows,
    };

    const privateArtifact: PrivateAuditArtifact = {
      ...sanitizedArtifact,
      businesses: discovery.runtimeEligibleBusinesses.map((business) => {
        const summary = businessSummaries.find(
          (row) => row.companyAlias === business.companyAlias,
        ) ?? {
          companyAlias: business.companyAlias,
          screeningLiveRows: business.live30d.rows.length,
          currentDecisionOsRows: 0,
          sampledCreatives: 0,
          activeCreativesSampled: 0,
          userFacingSegments: {},
          oldChallengerSegments: {},
          zeroScale: true,
          zeroScaleReview: true,
        };
        return {
          ...summary,
          businessId: business.business.business_id,
          businessName: business.businessName,
        };
      }),
      rows: localPrivateRows,
    };

    const pr65CurrentOutputArtifact =
      buildPr65CurrentOutputArtifact(sanitizedArtifact);

    await persistArtifacts({
      sanitized: sanitizedArtifact,
      localPrivate: privateArtifact,
      pr65CurrentOutput: pr65CurrentOutputArtifact,
    });

    return {
      sanitizedArtifact,
      privateArtifact,
    };
  } finally {
    await waitForAuditSnapshotRefreshes().catch(() => null);
    restoreFetch();
    restoreRuntime();
  }
}

if (isDirectRun()) {
  runCreativeLiveFirmAudit()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      resetDbClientCache();
    });
}
