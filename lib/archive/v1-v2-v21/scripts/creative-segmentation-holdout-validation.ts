import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { buildCreativeOperatorItem, creativeOperatorSegmentLabel } from "@/lib/creative-operator-surface";
import type { CreativeDecisionInputRow } from "@/lib/ai/generate-creative-decisions";
import type { CreativeDecisionOsCreative } from "@/lib/creative-decision-os";
import { getCreativeDecisionOsForRange } from "@/lib/creative-decision-os-source";
import { buildCreativeOldRuleChallenger } from "@/lib/creative-old-rule-challenger";
import { resetDbClientCache } from "@/lib/db";
import { getIntegration } from "@/lib/integrations";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import { addDaysToIsoDate } from "@/lib/meta/history";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
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
  selectRepresentativeRows,
  shouldReportNoLiveReadableBusinesses,
  summarizeCandidateEligibility,
  sanitizeText,
  type BaselineSummary,
  type CandidateSkipReason,
  type FetchCreativePayloadResult,
  type RuntimeCandidateSkipReason,
  type RuntimeTokenReadabilityStatus,
  type SourceBusinessRow,
} from "./creative-segmentation-calibration-lab";

type HoldoutCohort = "calibration" | "holdout";

type RuntimeEligibleBusiness = {
  business: SourceBusinessRow;
  live30d: FetchCreativePayloadResult;
};

type HoldoutPanelRow = {
  cohort: HoldoutCohort;
  companyAlias: string;
  accountAlias: string;
  campaignAlias: string;
  adSetAlias: string;
  creativeAlias: string;
  currentDecisionOsInternalSegment: string | null;
  currentUserFacingSegment: string;
  oldRuleChallengerSegment: string | null;
  oldRuleChallengerReason: string | null;
  accountBaseline: BaselineSummary;
  campaignBaseline: BaselineSummary | null;
  benchmarkScope: string;
  benchmarkScopeLabel: string;
  benchmarkReliability: string;
  commercialTruthAvailability: {
    targetPackConfigured: boolean;
    missingInputs: string[];
  };
  businessValidationStatus: "favorable" | "missing" | "unfavorable";
  evidenceQuality: {
    evidenceSource: string;
    trustState: string;
    surfaceLane: string;
    previewWindow: string | null;
    baselineReliability: string;
  };
  currentPushReadiness: string | null;
  lifecycleState: string;
  primaryAction: string;
  fatigueStatus: string | null;
  fatigueConfidence: number | null;
  spend: number;
  purchases: number;
  roas: number;
  cpa: number;
  value: number;
  currentInstructionHeadline: string;
  reasonSummary: string;
  missingEvidence: string[];
};

type CohortEvaluationSummary = {
  companies: number;
  creatives: number;
  userFacingSegments: Record<string, number>;
  internalSegments: Record<string, number>;
  benchmarkScopeUsage: Record<string, number>;
  baselineReliability: Record<string, number>;
  businessValidationAvailability: Record<string, number>;
  pushReadiness: Record<string, number>;
  strongRelativeWinnersNotSurfacing: {
    count: number;
    examples: string[];
  };
  contextBlockedQualityRows: {
    count: number;
    examples: string[];
  };
  evidenceThinActionRows: {
    count: number;
    examples: string[];
  };
  trueScaleConfirmedRows: {
    count: number;
    examples: string[];
  };
  trueScaleMissingBusinessValidationRows: {
    count: number;
    examples: string[];
  };
};

type HoldoutSplitResult = {
  enabled: boolean;
  disabledReason: "cohort_too_small" | null;
  logicVersion: "creative-holdout-v1";
  logicSummary: string;
  totalCompanies: number;
  calibrationAliases: string[];
  holdoutAliases: string[];
};

type HoldoutValidationArtifact = {
  generatedAt: string;
  source: "creative_segmentation_holdout_validation";
  sanitization: {
    rawIdsIncluded: false;
    rawNamesIncluded: false;
    notes: string[];
  };
  cohortHealth: {
    runtimeTokenReadabilityStatus: RuntimeTokenReadabilityStatus;
    runtimeTokenReadabilityBlocker: string | null;
    candidateEligibility: {
      historicalSnapshotCandidates: number;
      eligibleCandidates: number;
      runtimeEligibleCandidates: number;
      skippedCandidates: number;
      skippedCandidatesByReason: Record<CandidateSkipReason, number>;
      runtimeSkippedCandidates: number;
      runtimeSkippedCandidatesByReason: Record<RuntimeCandidateSkipReason, number>;
    };
  };
  split: HoldoutSplitResult;
  currentEvaluation: Record<HoldoutCohort | "all", CohortEvaluationSummary>;
  representativeHoldoutRows: HoldoutPanelRow[];
};

const OUTPUT_DIR =
  "docs/operator-policy/creative-segmentation-recovery/reports/calibration-lab/artifacts";
const OUTPUT_PATH = path.join(OUTPUT_DIR, "sanitized-holdout-validation.json");
const HOLDOUT_PANEL_ROW_LIMIT = Number(process.env.CREATIVE_HOLDOUT_PANEL_ROWS ?? 8);
const DEBUG = Boolean(process.env.CREATIVE_HOLDOUT_DEBUG?.trim());

function round(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nullableRound(value: number | null | undefined, digits = 2) {
  if (value == null || !Number.isFinite(value)) return null;
  return round(value, digits);
}

function increment(map: Record<string, number>, key: string | null | undefined) {
  const normalized = key?.trim() || "missing";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

function summarizePeerBaseline(
  peers: CreativeDecisionOsCreative[],
  scope: "account" | "campaign",
): BaselineSummary {
  const eligible = peers.filter(
    (creative) =>
      creative.spend > 0 &&
      (creative.purchaseValue > 0 || creative.roas > 0 || creative.purchases > 0),
  );
  const spendBasis = eligible.reduce((sum, creative) => sum + creative.spend, 0);
  const purchaseBasis = eligible.reduce((sum, creative) => sum + creative.purchases, 0);
  const valueBasis = eligible.reduce((sum, creative) => sum + creative.purchaseValue, 0);
  const cpaValues = eligible
    .filter((creative) => creative.purchases > 0 && creative.cpa > 0)
    .map((creative) => creative.cpa)
    .sort((left, right) => left - right);
  const roasValues = eligible
    .map((creative) => creative.roas)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const spendValues = eligible
    .map((creative) => creative.spend)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const missingContext: string[] = [];

  if (eligible.length < 3) missingContext.push("fewer than 3 eligible peer creatives");
  if (spendBasis < 120) missingContext.push("peer spend basis below calibration floor");
  if (purchaseBasis < 2) missingContext.push("peer purchase basis below calibration floor");

  let reliability: BaselineSummary["reliability"] = "medium";
  if (eligible.length === 0) reliability = "unavailable";
  else if (eligible.length < 3 || spendBasis < 120 || purchaseBasis < 2) reliability = "weak";
  else if (eligible.length >= 6 && spendBasis >= 500 && purchaseBasis >= 8) reliability = "strong";

  return {
    scope,
    reliability,
    creativeCount: peers.length,
    eligibleCreativeCount: eligible.length,
    spendBasis: round(spendBasis),
    purchaseBasis: round(purchaseBasis),
    weightedRoas: spendBasis > 0 ? nullableRound(valueBasis / spendBasis) : null,
    weightedCpa: purchaseBasis > 0 ? nullableRound(spendBasis / purchaseBasis) : null,
    medianRoas: nullableRound(median(roasValues)),
    medianCpa: nullableRound(median(cpaValues)),
    medianSpend: nullableRound(median(spendValues)),
    missingContext,
  };
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle] ?? null;
  const left = values[middle - 1] ?? 0;
  const right = values[middle] ?? 0;
  return (left + right) / 2;
}

function summarizeAccountBaseline(creative: CreativeDecisionOsCreative): BaselineSummary {
  return {
    scope: creative.relativeBaseline.scope,
    reliability: creative.relativeBaseline.reliability,
    creativeCount: creative.relativeBaseline.creativeCount,
    eligibleCreativeCount: creative.relativeBaseline.eligibleCreativeCount,
    spendBasis: round(creative.relativeBaseline.spendBasis),
    purchaseBasis: round(creative.relativeBaseline.purchaseBasis),
    weightedRoas: nullableRound(creative.relativeBaseline.weightedRoas),
    weightedCpa: nullableRound(creative.relativeBaseline.weightedCpa),
    medianRoas: nullableRound(creative.relativeBaseline.medianRoas),
    medianCpa: nullableRound(creative.relativeBaseline.medianCpa),
    medianSpend: nullableRound(creative.relativeBaseline.medianSpend),
    missingContext: creative.relativeBaseline.missingContext,
  };
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
    frequency: 0,
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
      creative.linkClicks > 0 ? (creative.purchases / creative.linkClicks) * 100 : 0,
    atcToPurchaseRate: contextRow?.atcToPurchaseRatio ?? 0,
    accountId: contextRow?.accountId ?? null,
    accountName: null,
    campaignId: contextRow?.campaignId ?? null,
    campaignName: null,
    adSetId: contextRow?.adSetId ?? null,
    adSetName: null,
  };
}

function hasNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasRelativeBaselineContext(creative: CreativeDecisionOsCreative) {
  const baseline = creative.relativeBaseline;
  const reliable = baseline.reliability === "strong" || baseline.reliability === "medium";
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

function hasStrongRelativeBaselineContext(creative: CreativeDecisionOsCreative) {
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
  if (!hasNumber(creative.spend) || !hasNumber(creative.purchases) || !hasNumber(creative.roas)) {
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
  if (!hasNumber(creative.spend) || creative.spend < Math.max(300, medianSpend * 1.3)) {
    return false;
  }
  if (!hasNumber(creative.purchases) || creative.purchases < 6) return false;
  if (!hasNumber(creative.roas) || creative.roas < medianRoas * 1.6) return false;
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

export function isReviewOnlyScaleCandidateForHoldout(input: {
  creative: CreativeDecisionOsCreative;
  commercialTruthConfigured: boolean;
}) {
  const businessValidationStatus = resolveBusinessValidationStatus(input);
  return (
    businessValidationStatus === "missing" &&
    hasTrueScaleEvidence(input.creative) &&
    input.creative.primaryAction !== "hold_no_touch" &&
    input.creative.primaryAction !== "refresh_replace" &&
    input.creative.primaryAction !== "block_deploy" &&
    input.creative.lifecycleState !== "fatigued_winner" &&
    input.creative.fatigue.status !== "fatigued" &&
    !hasWeakCampaignContext(input.creative)
  );
}

function isUnderSampled(creative: CreativeDecisionOsCreative) {
  return (
    creative.spend < 120 ||
    creative.purchases < 2 ||
    creative.impressions < 5_000 ||
    creative.creativeAgeDays <= 10
  );
}

function hasWeakCampaignContext(creative: CreativeDecisionOsCreative) {
  return (
    creative.deployment.compatibility.status === "limited" ||
    creative.deployment.compatibility.status === "blocked"
  );
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

function createEmptyCohortSummary(): CohortEvaluationSummary {
  return {
    companies: 0,
    creatives: 0,
    userFacingSegments: {},
    internalSegments: {},
    benchmarkScopeUsage: {},
    baselineReliability: {},
    businessValidationAvailability: {},
    pushReadiness: {},
    strongRelativeWinnersNotSurfacing: { count: 0, examples: [] },
    contextBlockedQualityRows: { count: 0, examples: [] },
    evidenceThinActionRows: { count: 0, examples: [] },
    trueScaleConfirmedRows: { count: 0, examples: [] },
    trueScaleMissingBusinessValidationRows: { count: 0, examples: [] },
  };
}

function pushExample(target: { count: number; examples: string[] }, example: string) {
  target.count += 1;
  if (target.examples.length < 5 && !target.examples.includes(example)) {
    target.examples.push(example);
  }
}

export function buildDeterministicHoldoutSplit(
  companies: Array<{ companyAlias: string; businessId: string }>,
): HoldoutSplitResult {
  const totalCompanies = companies.length;
  const logicSummary =
    "Stable business-level split. Rank runtime-eligible businesses by sha256(creative-holdout-v1:business_id); send the first rounded 25% to holdout, with at least 1 and at least 2 companies left in calibration. Disable holdout below 5 eligible businesses.";

  if (totalCompanies < 5) {
    return {
      enabled: false,
      disabledReason: "cohort_too_small",
      logicVersion: "creative-holdout-v1",
      logicSummary,
      totalCompanies,
      calibrationAliases: companies.map((company) => company.companyAlias),
      holdoutAliases: [],
    };
  }

  const ranked = companies
    .map((company) => ({
      ...company,
      rankKey: createHash("sha256")
        .update(`creative-holdout-v1:${company.businessId}`)
        .digest("hex"),
    }))
    .sort((left, right) =>
      left.rankKey.localeCompare(right.rankKey) || left.companyAlias.localeCompare(right.companyAlias),
    );
  const holdoutCount = Math.max(1, Math.min(totalCompanies - 2, Math.round(totalCompanies * 0.25)));
  const holdoutAliases = new Set(
    ranked.slice(0, holdoutCount).map((company) => company.companyAlias),
  );

  return {
    enabled: true,
    disabledReason: null,
    logicVersion: "creative-holdout-v1",
    logicSummary,
    totalCompanies,
    calibrationAliases: companies
      .map((company) => company.companyAlias)
      .filter((alias) => !holdoutAliases.has(alias)),
    holdoutAliases: companies
      .map((company) => company.companyAlias)
      .filter((alias) => holdoutAliases.has(alias)),
  };
}

export function assignStableCompanyAliases<T extends { businessId: string }>(companies: T[]) {
  return [...companies]
    .map((company) => ({
      ...company,
      aliasRank: createHash("sha256")
        .update(`creative-company-alias-v1:${company.businessId}`)
        .digest("hex"),
    }))
    .sort((left, right) => left.aliasRank.localeCompare(right.aliasRank))
    .map((company, index) => ({
      ...company,
      companyAlias: `company-${String(index + 1).padStart(2, "0")}`,
    }));
}

function selectHoldoutPanelRows(rows: HoldoutPanelRow[]) {
  const priorities = [
    "Scale",
    "Scale Review",
    "Campaign Check",
    "Refresh",
    "Protect",
    "Test More",
    "Not Enough Data",
    "Watch",
  ];
  const sorted = [...rows].sort((left, right) => right.spend - left.spend);
  const selected = new Map<string, HoldoutPanelRow>();

  for (const segment of priorities) {
    const row = sorted.find(
      (candidate) =>
        candidate.currentUserFacingSegment === segment &&
        !selected.has(candidate.creativeAlias),
    );
    if (row) selected.set(row.creativeAlias, row);
  }

  for (const row of sorted) {
    if (selected.size >= HOLDOUT_PANEL_ROW_LIMIT) break;
    selected.set(row.creativeAlias, row);
  }

  return Array.from(selected.values()).slice(0, HOLDOUT_PANEL_ROW_LIMIT);
}

function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

function debug(message: string, extra?: Record<string, unknown>) {
  if (!DEBUG) return;
  console.error(
    `[holdout-validation] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`,
  );
}

async function persistArtifact(artifact: HoldoutValidationArtifact) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        output: OUTPUT_PATH,
        split: artifact.split,
        allCreatives: artifact.currentEvaluation.all.creatives,
        holdoutCreatives: artifact.currentEvaluation.holdout.creatives,
        holdoutPanelRows: artifact.representativeHoldoutRows.length,
      },
      null,
      2,
    ),
  );
  return artifact;
}

export async function runHoldoutValidation() {
  installSanitizedRuntimeGuards();
  const candidateRows = await getCandidateBusinesses();
  const candidateEligibility = summarizeCandidateEligibility(candidateRows);
  const runtimeTokenReadability = await assessRuntimeTokenReadability({
    candidates: candidateEligibility.eligible,
  });
  const runtimeSkippedCandidatesByReason: Record<RuntimeCandidateSkipReason, number> = {
    no_current_meta_connection: 0,
    meta_connection_not_connected: 0,
    no_access_token: 0,
    no_accounts_assigned: 0,
    meta_token_checkpointed: 0,
    provider_read_failure: 0,
    no_current_creative_activity: 0,
  };
  const runtimeEligibleBusinesses: RuntimeEligibleBusiness[] = [];
  debug("candidate-eligibility", {
    historicalSnapshotCandidates: candidateRows.length,
    eligibleCandidates: candidateEligibility.eligible.length,
  });

  for (const [candidateIndex, business] of candidateEligibility.eligible.entries()) {
    const decisionAsOf = business.max_end_date;
    const startDate = addDaysToIsoDate(decisionAsOf, -29);
    const endDate = decisionAsOf;
    const request = new NextRequest(
      `http://localhost/api/creatives/decision-os?businessId=${encodeURIComponent(
        business.business_id,
      )}&startDate=${startDate}&endDate=${endDate}&decisionAsOf=${endDate}`,
    );

    const live30d = await fetchCreativePayload({
      request,
      businessId: business.business_id,
      startDate,
      endDate,
      snapshotBypass: true,
    }).catch(() => null);
    if (!live30d) {
      runtimeSkippedCandidatesByReason.provider_read_failure += 1;
      debug("runtime-skip", {
        candidate: candidateIndex + 1,
        reason: "provider_read_failure",
      });
      continue;
    }

    const integration = await getIntegration(business.business_id, "meta").catch(() => null);
    const assignedAccountIds = await fetchAssignedAccountIds(business.business_id).catch(
      () => [],
    );
    const accountProbes =
      live30d.rows.length === 0 && integration?.access_token
        ? await probeLiveMetaAccountAccess({
            accessToken: integration.access_token,
            accountIds: assignedAccountIds,
            startDate,
            endDate,
          })
        : [];
    const runtimeSkipReason = classifyRuntimeCandidateSkip({
      payloadStatus: live30d.status,
      tableRowCount: live30d.rows.length,
      accountProbes,
    });
    if (runtimeSkipReason) {
      runtimeSkippedCandidatesByReason[runtimeSkipReason] += 1;
      debug("runtime-skip", {
        candidate: candidateIndex + 1,
        reason: runtimeSkipReason,
      });
      continue;
    }
    runtimeEligibleBusinesses.push({ business, live30d });
    debug("runtime-eligible", {
      candidate: candidateIndex + 1,
      rows: live30d.rows.length,
    });
  }

  const runtimeTokenReadabilityBlocker = buildRuntimeTokenReadabilityBlocker(
    runtimeTokenReadability.status,
  );
  if (
    shouldReportNoLiveReadableBusinesses({
      runtimeTokenReadabilityStatus: runtimeTokenReadability.status,
      runtimeEligibleCandidateCount: runtimeEligibleBusinesses.length,
    })
  ) {
    throw new Error("No live Meta-readable businesses were available for holdout validation.");
  }
  if (runtimeTokenReadabilityBlocker) {
    throw new Error(runtimeTokenReadabilityBlocker);
  }

  const companyAssignments = assignStableCompanyAliases(
    runtimeEligibleBusinesses.map((runtimeEligible) => ({
      businessId: runtimeEligible.business.business_id,
      business: runtimeEligible.business,
      live30d: runtimeEligible.live30d,
    })),
  );
  const split = buildDeterministicHoldoutSplit(
    companyAssignments.map((company) => ({
      companyAlias: company.companyAlias,
      businessId: company.business.business_id,
    })),
  );
  const calibrationAliases = new Set(split.calibrationAliases);
  const holdoutAliases = new Set(split.holdoutAliases);
  const currentEvaluation = {
    all: createEmptyCohortSummary(),
    calibration: createEmptyCohortSummary(),
    holdout: createEmptyCohortSummary(),
  };
  const holdoutPanelCandidateRows: HoldoutPanelRow[] = [];
  debug("split-ready", {
    runtimeEligibleBusinesses: runtimeEligibleBusinesses.length,
    holdoutAliases: split.holdoutAliases,
    calibrationAliases: split.calibrationAliases,
  });

  for (const assignment of companyAssignments) {
    const cohort: HoldoutCohort = holdoutAliases.has(assignment.companyAlias)
      ? "holdout"
      : "calibration";
    const decisionAsOf = assignment.business.max_end_date;
    const startDate = addDaysToIsoDate(decisionAsOf, -29);
    const endDate = decisionAsOf;
    const request = new NextRequest(
      `http://localhost/api/creatives/decision-os?businessId=${encodeURIComponent(
        assignment.business.business_id,
      )}&startDate=${startDate}&endDate=${endDate}&decisionAsOf=${endDate}`,
    );
    const decisionOs = await getCreativeDecisionOsForRange({
      request,
      businessId: assignment.business.business_id,
      startDate,
      endDate,
      analyticsStartDate: startDate,
      analyticsEndDate: endDate,
      decisionAsOf: endDate,
    });
    debug("decision-os", {
      companyAlias: assignment.companyAlias,
      cohort,
      creatives: decisionOs.creatives.length,
    });
    const tableRows = assignment.live30d.rows;
    const tableById = new Map(tableRows.map((row) => [row.id, row]));
    const representativeRows = cohort === "holdout" ? selectRepresentativeRows(decisionOs.creatives) : [];
    const oldRuleById =
      cohort === "holdout"
        ? new Map(
            buildCreativeOldRuleChallenger(
              representativeRows.map((creative) =>
                toOldRuleInput(creative, tableById.get(creative.creativeId) ?? null),
              ),
            ).map((row) => [row.creativeId, row]),
          )
        : new Map();
    const accountAlias = buildAliasFactory(`${assignment.companyAlias}-account`);
    const campaignAlias = buildAliasFactory(`${assignment.companyAlias}-campaign`);
    const adSetAlias = buildAliasFactory(`${assignment.companyAlias}-adset`);
    const creativeAlias = buildAliasFactory(`${assignment.companyAlias}-creative`);
    currentEvaluation.all.companies += 1;
    currentEvaluation[cohort].companies += 1;
    currentEvaluation.all.creatives += decisionOs.creatives.length;
    currentEvaluation[cohort].creatives += decisionOs.creatives.length;

    for (const creative of decisionOs.creatives) {
      const contextRow = tableById.get(creative.creativeId) ?? null;
      const userFacingSegment = creativeOperatorSegmentLabel(creative);
      const businessValidationStatus = resolveBusinessValidationStatus({
        creative,
        commercialTruthConfigured: decisionOs.commercialTruthCoverage.configuredSections.targetPack,
      });
      const reviewOnlyScaleCandidate = isReviewOnlyScaleCandidateForHoldout({
        creative,
        commercialTruthConfigured:
          decisionOs.commercialTruthCoverage.configuredSections.targetPack,
      });
      const pushReadiness = creative.operatorPolicy?.pushReadiness ?? null;
      const strongRelativeWinner = hasRelativeScaleReviewEvidence(creative);
      const trueScaleCandidate = hasTrueScaleEvidence(creative);
      const scaleReviewEligibleSignal =
        strongRelativeWinner &&
        !hasWeakCampaignContext(creative) &&
        creative.primaryAction !== "hold_no_touch" &&
        creative.primaryAction !== "refresh_replace" &&
        creative.primaryAction !== "block_deploy";
      const rowAlias = `${assignment.companyAlias}/${creativeAlias(creative.creativeId)}`;

      for (const summary of [currentEvaluation.all, currentEvaluation[cohort]]) {
        increment(summary.userFacingSegments, userFacingSegment);
        increment(summary.internalSegments, creative.operatorPolicy?.segment ?? null);
        increment(summary.benchmarkScopeUsage, creative.benchmarkScope);
        increment(summary.baselineReliability, creative.relativeBaseline.reliability);
        increment(summary.businessValidationAvailability, businessValidationStatus);
        increment(summary.pushReadiness, pushReadiness);

        if (
          scaleReviewEligibleSignal &&
          userFacingSegment !== "Scale" &&
          userFacingSegment !== "Scale Review"
        ) {
          pushExample(
            summary.strongRelativeWinnersNotSurfacing,
            `${rowAlias} -> ${userFacingSegment}`,
          );
        }
        if (strongRelativeWinner && hasWeakCampaignContext(creative) && userFacingSegment === "Campaign Check") {
          pushExample(summary.contextBlockedQualityRows, rowAlias);
        }
        if (
          isUnderSampled(creative) &&
          userFacingSegment !== "Not Enough Data" &&
          userFacingSegment !== "Test More" &&
          userFacingSegment !== "Campaign Check" &&
          userFacingSegment !== "Not eligible for evaluation"
        ) {
          pushExample(
            summary.evidenceThinActionRows,
            `${rowAlias} -> ${userFacingSegment}`,
          );
        }
        if (trueScaleCandidate && businessValidationStatus === "favorable" && userFacingSegment === "Scale") {
          pushExample(summary.trueScaleConfirmedRows, rowAlias);
        }
        if (reviewOnlyScaleCandidate) {
          pushExample(
            summary.trueScaleMissingBusinessValidationRows,
            `${rowAlias} -> ${userFacingSegment}`,
          );
        }
      }

      if (cohort !== "holdout") continue;
    }

    if (cohort !== "holdout") continue;

    for (const creative of representativeRows) {
      const contextRow = tableById.get(creative.creativeId) ?? null;
      const rawCampaignId = contextRow?.campaignId ?? null;
      const rawAdSetId = contextRow?.adSetId ?? null;
      const replacements: Array<[string | null | undefined, string]> = [
        [creative.name, creativeAlias(creative.creativeId)],
        [contextRow?.campaignName, campaignAlias(rawCampaignId)],
        [rawCampaignId, campaignAlias(rawCampaignId)],
        [contextRow?.adSetName, adSetAlias(rawAdSetId)],
        [rawAdSetId, adSetAlias(rawAdSetId)],
      ];
      const surface = buildCreativeOperatorItem(creative);
      const challenger = oldRuleById.get(creative.creativeId) ?? null;
      const sameCampaignPeers = decisionOs.creatives.filter(
        (peer) =>
          peer.creativeId !== creative.creativeId &&
          rawCampaignId != null &&
          (tableById.get(peer.creativeId)?.campaignId ?? null) === rawCampaignId,
      );
      const campaignBaseline =
        rawCampaignId && sameCampaignPeers.length > 0
          ? summarizePeerBaseline(sameCampaignPeers, "campaign")
          : null;

      holdoutPanelCandidateRows.push({
        cohort,
        companyAlias: assignment.companyAlias,
        accountAlias: accountAlias(contextRow?.accountId ?? null),
        campaignAlias: campaignAlias(rawCampaignId),
        adSetAlias: adSetAlias(rawAdSetId),
        creativeAlias: creativeAlias(creative.creativeId),
        currentDecisionOsInternalSegment: creative.operatorPolicy?.segment ?? null,
        currentUserFacingSegment: creativeOperatorSegmentLabel(creative),
        oldRuleChallengerSegment: challenger?.challengerAction ?? null,
        oldRuleChallengerReason: challenger?.reason ?? null,
        accountBaseline: summarizeAccountBaseline(creative),
        campaignBaseline,
        benchmarkScope: creative.benchmarkScope,
        benchmarkScopeLabel: creative.benchmarkScopeLabel,
        benchmarkReliability: creative.benchmarkReliability,
        commercialTruthAvailability: {
          targetPackConfigured: decisionOs.commercialTruthCoverage.configuredSections.targetPack,
          missingInputs: decisionOs.commercialTruthCoverage.missingInputs,
        },
        businessValidationStatus: resolveBusinessValidationStatus({
          creative,
          commercialTruthConfigured:
            decisionOs.commercialTruthCoverage.configuredSections.targetPack,
        }),
        evidenceQuality: {
          evidenceSource: creative.evidenceSource,
          trustState: creative.trust.truthState,
          surfaceLane: creative.trust.surfaceLane,
          previewWindow: creative.previewStatus?.liveDecisionWindow ?? null,
          baselineReliability: creative.relativeBaseline.reliability,
        },
        currentPushReadiness: creative.operatorPolicy?.pushReadiness ?? null,
        lifecycleState: creative.lifecycleState,
        primaryAction: creative.primaryAction,
        fatigueStatus: creative.fatigue.status,
        fatigueConfidence: nullableRound(creative.fatigue.confidence),
        spend: round(creative.spend),
        purchases: round(creative.purchases),
        roas: round(creative.roas),
        cpa: round(creative.cpa),
        value: round(creative.purchaseValue),
        currentInstructionHeadline: sanitizeText(surface.instruction?.headline ?? "", replacements),
        reasonSummary: sanitizeText(surface.instruction?.reasonSummary ?? "", replacements),
        missingEvidence: (surface.instruction?.missingEvidence ?? []).map((item) =>
          sanitizeText(item, replacements),
        ),
      });
    }
  }

  const artifact: HoldoutValidationArtifact = {
    generatedAt: new Date().toISOString(),
    source: "creative_segmentation_holdout_validation",
    sanitization: {
      rawIdsIncluded: false,
      rawNamesIncluded: false,
      notes: [
        "Business, account, campaign, ad set, and creative identifiers are replaced with deterministic aliases per generated artifact.",
        "Creative names, campaign names, ad set names, tokens, URLs, and customer-identifying fields are not exported.",
      ],
    },
    cohortHealth: {
      runtimeTokenReadabilityStatus: runtimeTokenReadability.status,
      runtimeTokenReadabilityBlocker,
      candidateEligibility: {
        historicalSnapshotCandidates: candidateRows.length,
        eligibleCandidates: candidateEligibility.eligible.length,
        runtimeEligibleCandidates: runtimeEligibleBusinesses.length,
        skippedCandidates: candidateEligibility.skippedCandidates,
        skippedCandidatesByReason: candidateEligibility.skippedCandidatesByReason,
        runtimeSkippedCandidates: countRuntimeSkippedCandidates(runtimeSkippedCandidatesByReason),
        runtimeSkippedCandidatesByReason,
      },
    },
    split,
    currentEvaluation,
    representativeHoldoutRows: selectHoldoutPanelRows(holdoutPanelCandidateRows),
  };

  return persistArtifact(artifact);
}

if (isDirectRun()) {
  runHoldoutValidation()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => {
      resetDbClientCache();
    });
}
