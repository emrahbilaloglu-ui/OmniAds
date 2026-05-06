import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { mapApiRowToUiRow } from "@/app/(dashboard)/creatives/page-support";
import {
  buildCreativeOperatorItem,
  creativeOperatorSegmentLabel,
  resolveCreativeQuickFilterKey,
} from "@/lib/creative-operator-surface";
import {
  isIntegrationSecretKeyRequiredError,
  isIntegrationSecretUnreadableError,
} from "@/lib/integration-secrets";
import { getIntegration } from "@/lib/integrations";
import type {
  CreativeDecisionOsCreative,
} from "@/lib/creative-decision-os";
import type { CreativeDecisionInputRow } from "@/lib/ai/generate-creative-decisions";
import { getCreativeDecisionOsForRange } from "@/lib/creative-decision-os-source";
import { buildCreativeOldRuleChallenger } from "@/lib/creative-old-rule-challenger";
import { getDb, resetDbClientCache } from "@/lib/db";
import { getMetaCreativesApiPayload } from "@/lib/meta/creatives-api";
import { fetchAssignedAccountIds } from "@/lib/meta/creatives-fetchers";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import { addDaysToIsoDate } from "@/lib/meta/history";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

export type SourceBusinessRow = {
  business_id: string;
  max_end_date: string;
  max_row_count: number;
  latest_synced_at: string;
  connection_status: string | null;
  has_access_token: boolean;
  has_encrypted_access_token: boolean;
  assigned_account_count: number;
};

export type CandidateSkipReason =
  | "no_current_meta_connection"
  | "meta_connection_not_connected"
  | "no_access_token"
  | "no_accounts_assigned";

export type RuntimeCandidateSkipReason =
  | CandidateSkipReason
  | "meta_token_checkpointed"
  | "provider_read_failure"
  | "no_current_creative_activity";

export type RuntimeTokenReadabilityStatus =
  | "not_needed"
  | "missing_key"
  | "unreadable_key"
  | "readable";

type NumericMetricKey =
  | "spend"
  | "purchaseValue"
  | "roas"
  | "cpa"
  | "purchases"
  | "impressions"
  | "linkClicks";

export type BaselineSummary = {
  scope: "account" | "campaign";
  reliability: "strong" | "medium" | "weak" | "unavailable";
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

type SanitizedCalibrationRow = {
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
  spend: number;
  purchases: number;
  cpa: number;
  roas: number;
  value: number;
  recent7d: Partial<Record<NumericMetricKey, number>> | null;
  mid30d: Partial<Record<NumericMetricKey, number>> | null;
  long90d: Partial<Record<NumericMetricKey, number>> | null;
  trendIndicators: {
    fatigueStatus: string | null;
    fatigueConfidence: number | null;
    lifecycleState: string;
    primaryAction: string;
  };
  creativeAgeDays: number;
  frequency: number | null;
  commercialTruthAvailability: {
    targetPackConfigured: boolean;
    missingInputs: string[];
  };
  campaignAdSetContextFlags: {
    campaignPresent: boolean;
    adSetPresent: boolean;
    deploymentCompatibility: string;
    targetLane: string | null;
  };
  evidenceQuality: {
    evidenceSource: string;
    trustState: string;
    surfaceLane: string;
    previewWindow: string | null;
    baselineReliability: string;
  };
  currentPushReadiness: string | null;
  currentInstructionHeadline: string;
  reasonSummary: string;
  missingEvidence: string[];
};

export type LiveMetaAccountProbe = {
  ok: boolean;
  status: number;
  errorCode: number | null;
  errorSubcode: number | null;
  rows: number;
  spendBearingRows: number;
};

export type FetchCreativePayloadResult = {
  status: string | null;
  snapshotSource: string | null;
  rows: MetaCreativeRow[];
};

export type DatasetArtifact = {
  generatedAt: string;
  source: "creative_segmentation_calibration_lab";
  sanitization: {
    rawIdsIncluded: false;
    rawNamesIncluded: false;
    notes: string[];
  };
  dataAccuracyGate: {
    passed: boolean;
    blockers: string[];
    warnings: string[];
    checkedCompanies: number;
    checkedRows: number;
    tableDecisionMismatches: number;
    maxMetricDelta: Record<NumericMetricKey, number>;
    candidateEligibility: {
      historicalSnapshotCandidates: number;
      eligibleCandidates: number;
      runtimeEligibleCandidates: number;
      skippedCandidates: number;
      skippedCandidatesByReason: Record<CandidateSkipReason, number>;
      runtimeSkippedCandidates: number;
      runtimeSkippedCandidatesByReason: Record<RuntimeCandidateSkipReason, number>;
      sampledCandidates: number;
      zeroRowEligibleCandidates: number;
    };
    warehouseCreativeDaily: {
      available: boolean;
      rowCount: number;
      checkedAgainstCurrentPipeline: boolean;
      confidence: "api_payload_parity_only" | "api_payload_parity_plus_warehouse_available";
      status: "empty_table" | "available_not_cross_checked";
    };
  };
  coverage: {
    companies: number;
    creatives: number;
    internalSegments: Record<string, number>;
    quickFilters: Record<string, number>;
    userFacingSegments: Record<string, number>;
    oldRuleSegments: Record<string, number>;
    baselineReliability: Record<string, number>;
    pushReadiness: Record<string, number>;
  };
  rows: SanitizedCalibrationRow[];
};

const OUTPUT_DIR =
  "docs/operator-policy/creative-segmentation-recovery/reports/calibration-lab/artifacts";
const DATASET_PATH = path.join(OUTPUT_DIR, "sanitized-calibration-dataset.json");
const MAX_COMPANIES = Number(process.env.CREATIVE_CALIBRATION_MAX_COMPANIES ?? 3);
const MAX_ROWS_PER_COMPANY = Number(process.env.CREATIVE_CALIBRATION_ROWS_PER_COMPANY ?? 12);
const METRIC_KEYS: NumericMetricKey[] = [
  "spend",
  "purchaseValue",
  "roas",
  "cpa",
  "purchases",
  "impressions",
  "linkClicks",
];

const EMPTY_SKIPPED_CANDIDATES_BY_REASON: Record<CandidateSkipReason, number> = {
  no_current_meta_connection: 0,
  meta_connection_not_connected: 0,
  no_access_token: 0,
  no_accounts_assigned: 0,
};

const EMPTY_RUNTIME_SKIPPED_CANDIDATES_BY_REASON: Record<RuntimeCandidateSkipReason, number> = {
  no_current_meta_connection: 0,
  meta_connection_not_connected: 0,
  no_access_token: 0,
  no_accounts_assigned: 0,
  meta_token_checkpointed: 0,
  provider_read_failure: 0,
  no_current_creative_activity: 0,
};

export function installSanitizedRuntimeGuards() {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const originalWarn = console.warn.bind(console);
  const originalLog = console.log.bind(console);
  const shouldSuppressLog = (args: unknown[]) =>
    typeof args[0] === "string" &&
    (
      args[0].startsWith("[meta-creatives]") ||
      args[0].startsWith("[preview-resolve]") ||
      args[0].startsWith("[meta-serving]")
    );

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url.startsWith("http://localhost/") || url.startsWith("http://127.0.0.1/")) {
      return new Response(JSON.stringify({ status: "suppressed_by_calibration_lab" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  console.warn = (...args: unknown[]) => {
    if (shouldSuppressLog(args)) return;
    originalWarn(...args);
  };
  console.log = (...args: unknown[]) => {
    if (shouldSuppressLog(args)) return;
    originalLog(...args);
  };

  return () => {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.log = originalLog;
  };
}

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

export function createEmptyCoverageSummary(): DatasetArtifact["coverage"] {
  return {
    companies: 0,
    creatives: 0,
    internalSegments: {},
    quickFilters: {},
    userFacingSegments: {},
    oldRuleSegments: {},
    baselineReliability: {},
    pushReadiness: {},
  };
}

export function recordCoverage(input: {
  coverage: DatasetArtifact["coverage"];
  internalSegment: string | null | undefined;
  quickFilter: string | null | undefined;
  userFacingSegment: string | null | undefined;
  oldRuleSegment: string | null | undefined;
  baselineReliability: string | null | undefined;
  pushReadiness: string | null | undefined;
}) {
  increment(input.coverage.internalSegments, input.internalSegment);
  increment(input.coverage.quickFilters, input.quickFilter);
  increment(input.coverage.userFacingSegments, input.userFacingSegment);
  increment(input.coverage.oldRuleSegments, input.oldRuleSegment);
  increment(input.coverage.baselineReliability, input.baselineReliability);
  increment(input.coverage.pushReadiness, input.pushReadiness);
}

export function resolveCandidateSkipReason(candidate: Pick<
  SourceBusinessRow,
  "connection_status" | "has_access_token" | "assigned_account_count"
>): CandidateSkipReason | null {
  const connectionStatus = candidate.connection_status?.trim() || null;
  if (!connectionStatus) return "no_current_meta_connection";
  if (connectionStatus !== "connected") return "meta_connection_not_connected";
  if (!candidate.has_access_token) return "no_access_token";
  if (candidate.assigned_account_count <= 0) return "no_accounts_assigned";
  return null;
}

export function summarizeCandidateEligibility(candidates: SourceBusinessRow[]) {
  const skippedCandidatesByReason = { ...EMPTY_SKIPPED_CANDIDATES_BY_REASON };
  const eligible: SourceBusinessRow[] = [];

  for (const candidate of candidates) {
    const reason = resolveCandidateSkipReason(candidate);
    if (reason) {
      skippedCandidatesByReason[reason] += 1;
      continue;
    }
    eligible.push(candidate);
  }

  return {
    eligible,
    skippedCandidatesByReason,
    skippedCandidates: candidates.length - eligible.length,
  };
}

export function hasIntegrationTokenDecryptionKey(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.INTEGRATION_TOKEN_ENCRYPTION_KEY?.trim());
}

function requiresEncryptedCredentialReadability(
  candidate: Pick<SourceBusinessRow, "has_access_token" | "has_encrypted_access_token">
) {
  return candidate.has_access_token && candidate.has_encrypted_access_token;
}

export function isIntegrationCredentialReadabilityError(error: unknown) {
  if (isIntegrationSecretKeyRequiredError(error) || isIntegrationSecretUnreadableError(error)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("INTEGRATION_TOKEN_ENCRYPTION_KEY") ||
    message.includes("Malformed encrypted integration secret") ||
    message.toLowerCase().includes("authenticate data")
  );
}

export function classifyRuntimeTokenReadabilityError(
  error: unknown,
): Exclude<RuntimeTokenReadabilityStatus, "not_needed" | "readable"> | null {
  if (isIntegrationSecretKeyRequiredError(error)) return "missing_key";
  if (isIntegrationSecretUnreadableError(error)) return "unreadable_key";
  if (!isIntegrationCredentialReadabilityError(error)) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("INTEGRATION_TOKEN_ENCRYPTION_KEY")) return "missing_key";
  return "unreadable_key";
}

export async function assessRuntimeTokenReadability(input: {
  candidates: Pick<
    SourceBusinessRow,
    "business_id" | "has_access_token" | "has_encrypted_access_token"
  >[];
  hasTokenKey?: boolean;
  sampleSize?: number;
  readIntegration?: typeof getIntegration;
}) {
  const encryptedCandidates = input.candidates.filter(requiresEncryptedCredentialReadability);
  const sampledCandidates = encryptedCandidates.slice(0, Math.max(1, input.sampleSize ?? 3));
  if (sampledCandidates.length === 0) {
    return {
      status: "not_needed" as RuntimeTokenReadabilityStatus,
      sampledCandidates: 0,
      readableCandidates: 0,
      unreadableCandidates: 0,
    };
  }

  if (!(input.hasTokenKey ?? hasIntegrationTokenDecryptionKey())) {
    return {
      status: "missing_key" as RuntimeTokenReadabilityStatus,
      sampledCandidates: sampledCandidates.length,
      readableCandidates: 0,
      unreadableCandidates: sampledCandidates.length,
    };
  }

  const readIntegration = input.readIntegration ?? getIntegration;
  let readableCandidates = 0;
  let unreadableCandidates = 0;

  for (const candidate of sampledCandidates) {
    try {
      const integration = await readIntegration(candidate.business_id, "meta");
      if (integration?.access_token) {
        readableCandidates += 1;
        continue;
      }
      unreadableCandidates += 1;
    } catch (error) {
      const errorStatus = classifyRuntimeTokenReadabilityError(error);
      if (errorStatus === "missing_key") {
        return {
          status: "missing_key" as RuntimeTokenReadabilityStatus,
          sampledCandidates: sampledCandidates.length,
          readableCandidates,
          unreadableCandidates: sampledCandidates.length - readableCandidates,
        };
      }
      if (errorStatus === "unreadable_key") {
        unreadableCandidates += 1;
        continue;
      }
      throw error;
    }
  }

  return {
    status:
      readableCandidates > 0
        ? ("readable" as RuntimeTokenReadabilityStatus)
        : ("unreadable_key" as RuntimeTokenReadabilityStatus),
    sampledCandidates: sampledCandidates.length,
    readableCandidates,
    unreadableCandidates,
  };
}

export function buildRuntimeTokenReadabilityBlocker(
  status: RuntimeTokenReadabilityStatus,
) {
  switch (status) {
    case "missing_key":
      return "Calibration helper runtime is missing the integration token decryption key required to verify current Meta connectivity. DATABASE_URL alone is not enough for live Meta cohort recovery.";
    case "unreadable_key":
      return "Calibration helper runtime could not read current encrypted Meta credentials with the provided token decryption key. Treat this as environment mismatch, not as absence of live Meta businesses.";
    default:
      return null;
  }
}

export function countRuntimeSkippedCandidates(
  skippedCandidatesByReason: Record<RuntimeCandidateSkipReason, number>,
) {
  return Object.values(skippedCandidatesByReason).reduce((sum, count) => sum + count, 0);
}

export function shouldReportNoLiveReadableBusinesses(input: {
  runtimeTokenReadabilityStatus: RuntimeTokenReadabilityStatus;
  runtimeEligibleCandidateCount: number;
}) {
  if (
    input.runtimeTokenReadabilityStatus === "missing_key" ||
    input.runtimeTokenReadabilityStatus === "unreadable_key"
  ) {
    return false;
  }
  return input.runtimeEligibleCandidateCount === 0;
}

export function classifyRuntimeCandidateSkip(input: {
  payloadStatus: string | null;
  tableRowCount: number;
  accountProbes: LiveMetaAccountProbe[];
}): RuntimeCandidateSkipReason | null {
  if (input.tableRowCount > 0) return null;
  if (input.payloadStatus === "no_connection") return "no_current_meta_connection";
  if (input.payloadStatus === "no_access_token") return "no_access_token";
  if (input.payloadStatus === "no_accounts_assigned") return "no_accounts_assigned";

  if (input.accountProbes.some((probe) => probe.errorCode === 190 || probe.errorSubcode === 459)) {
    return "meta_token_checkpointed";
  }
  if (input.accountProbes.some((probe) => !probe.ok)) {
    return "provider_read_failure";
  }
  if (
    input.accountProbes.length > 0 &&
    input.accountProbes.every((probe) => probe.ok && probe.rows === 0)
  ) {
    return "no_current_creative_activity";
  }
  if (
    input.accountProbes.length > 0 &&
    input.accountProbes.every((probe) => probe.ok && probe.spendBearingRows === 0)
  ) {
    return "no_current_creative_activity";
  }

  return input.payloadStatus === "no_data" ? "provider_read_failure" : null;
}

function buildRuntimeSkipWarning(alias: string, reason: RuntimeCandidateSkipReason) {
  switch (reason) {
    case "no_current_meta_connection":
      return `${alias}: skipped because the current creative source could not resolve a connected Meta integration.`;
    case "meta_connection_not_connected":
      return `${alias}: skipped because the current creative source reported a non-connected Meta integration state.`;
    case "no_access_token":
      return `${alias}: skipped because the current creative source could not decrypt a usable Meta access token.`;
    case "no_accounts_assigned":
      return `${alias}: skipped because the current creative source resolved no assigned Meta accounts.`;
    case "meta_token_checkpointed":
      return `${alias}: skipped because the assigned Meta account rejected current API reads with an OAuth checkpoint/token error.`;
    case "provider_read_failure":
      return `${alias}: skipped because current Meta API reads failed despite a connected assignment record.`;
    case "no_current_creative_activity":
      return `${alias}: skipped because the assigned Meta account returned no current creative activity in the decision window.`;
  }
}

function median(values: number[]) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (filtered.length === 0) return null;
  const middle = Math.floor(filtered.length / 2);
  if (filtered.length % 2 === 1) return filtered[middle] ?? null;
  const left = filtered[middle - 1] ?? 0;
  const right = filtered[middle] ?? 0;
  return (left + right) / 2;
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
    .map((creative) => creative.cpa);
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
    medianRoas: nullableRound(median(eligible.map((creative) => creative.roas))),
    medianCpa: nullableRound(median(cpaValues)),
    medianSpend: nullableRound(median(eligible.map((creative) => creative.spend))),
    missingContext,
  };
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
    clickToPurchaseRate: creative.linkClicks > 0 ? (creative.purchases / creative.linkClicks) * 100 : 0,
    atcToPurchaseRate: contextRow?.atcToPurchaseRatio ?? 0,
    accountId: contextRow?.accountId ?? null,
    accountName: null,
    campaignId: contextRow?.campaignId ?? null,
    campaignName: null,
    adSetId: contextRow?.adSetId ?? null,
    adSetName: null,
  };
}

export function selectRepresentativeRows(creatives: CreativeDecisionOsCreative[]) {
  const selected = new Map<string, CreativeDecisionOsCreative>();
  const sorted = [...creatives].sort((a, b) => b.spend - a.spend);

  for (const creative of sorted) {
    const segment = creative.operatorPolicy?.segment ?? "missing";
    if (!Array.from(selected.values()).some((row) => (row.operatorPolicy?.segment ?? "missing") === segment)) {
      selected.set(creative.creativeId, creative);
    }
    if (selected.size >= Math.min(MAX_ROWS_PER_COMPANY, 6)) break;
  }

  for (const creative of sorted) {
    if (selected.size >= MAX_ROWS_PER_COMPANY) break;
    selected.set(creative.creativeId, creative);
  }

  return Array.from(selected.values());
}

export function buildAliasFactory(prefix: string) {
  const map = new Map<string, string>();
  return (raw: string | null | undefined) => {
    const key = raw?.trim() || "missing";
    const existing = map.get(key);
    if (existing) return existing;
    const alias = `${prefix}-${String(map.size + 1).padStart(2, "0")}`;
    map.set(key, alias);
    return alias;
  };
}

export function sanitizeText(
  value: string,
  replacements: Array<[string | null | undefined, string]>,
) {
  let output = value;
  for (const [raw, alias] of replacements) {
    const token = raw?.trim();
    if (!token) continue;
    output = output.split(token).join(alias);
  }
  return output;
}

function historyMetric(
  rowsById: Map<string, ReturnType<typeof mapApiRowToUiRow>>,
  creativeId: string,
): Partial<Record<NumericMetricKey, number>> | null {
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

function compareTableAndDecisionRows(input: {
  tableRows: ReturnType<typeof mapApiRowToUiRow>[];
  creatives: CreativeDecisionOsCreative[];
}) {
  const tableById = new Map(input.tableRows.map((row) => [row.id, row]));
  const decisionById = new Map(input.creatives.map((row) => [row.creativeId, row]));
  const maxMetricDelta = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])) as Record<
    NumericMetricKey,
    number
  >;
  let mismatches = 0;

  for (const tableId of tableById.keys()) {
    if (!decisionById.has(tableId)) mismatches += 1;
  }
  for (const decisionId of decisionById.keys()) {
    if (!tableById.has(decisionId)) mismatches += 1;
  }
  for (const [id, tableRow] of tableById.entries()) {
    const decisionRow = decisionById.get(id);
    if (!decisionRow) continue;
    for (const key of METRIC_KEYS) {
      const delta = Math.abs(Number(tableRow[key] ?? 0) - Number(decisionRow[key] ?? 0));
      maxMetricDelta[key] = Math.max(maxMetricDelta[key], round(delta, 4));
    }
  }

  return { mismatches, maxMetricDelta };
}

export async function fetchCreativeRows(input: {
  request: NextRequest;
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  const payload = await fetchCreativePayload(input);
  return payload.rows;
}

export async function fetchCreativePayload(input: {
  request: NextRequest;
  businessId: string;
  startDate: string;
  endDate: string;
  snapshotBypass?: boolean;
}): Promise<FetchCreativePayloadResult> {
  const payload = await getMetaCreativesApiPayload({
    request: input.request,
    requestStartedAt: Date.now(),
    businessId: input.businessId,
    mediaMode: "metadata",
    groupBy: "creative",
    format: "all",
    sort: "spend",
    start: input.startDate,
    end: input.endDate,
    debugPreview: false,
    debugThumbnail: false,
    debugPerf: false,
    snapshotBypass: input.snapshotBypass ?? false,
    snapshotWarm: false,
    enableCopyRecovery: false,
    enableCreativeBasicsFallback: false,
    enableCreativeDetails: false,
    enableThumbnailBackfill: false,
    enableCardThumbnailBackfill: false,
    enableImageHashLookup: false,
    enableMediaRecovery: false,
    enableMediaCache: true,
    enableDeepAudit: false,
    perAccountSampleLimit: 10,
  });

  return {
    status: typeof payload.status === "string" ? payload.status : null,
    snapshotSource:
      typeof (payload as { snapshot_source?: unknown }).snapshot_source === "string"
        ? ((payload as { snapshot_source?: string }).snapshot_source ?? null)
        : null,
    rows: ((payload.rows ?? []) as MetaCreativeApiRow[]).map(mapApiRowToUiRow),
  };
}

export async function probeLiveMetaAccountAccess(input: {
  accessToken: string;
  accountIds: string[];
  startDate: string;
  endDate: string;
}) {
  const probes: LiveMetaAccountProbe[] = [];

  for (const accountId of input.accountIds) {
    const url = new URL(`https://graph.facebook.com/v25.0/${accountId}/insights`);
    url.searchParams.set("fields", "ad_id,spend");
    url.searchParams.set("level", "ad");
    url.searchParams.set(
      "time_range",
      JSON.stringify({ since: input.startDate, until: input.endDate }),
    );
    url.searchParams.set("limit", "5");
    url.searchParams.set("access_token", input.accessToken);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as
        | {
            data?: Array<{ spend?: string | number | null }>;
            error?: { code?: number; error_subcode?: number };
          }
        | null;
      const rows = Array.isArray(body?.data) ? body.data : [];
      probes.push({
        ok: response.ok,
        status: response.status,
        errorCode:
          typeof body?.error?.code === "number" ? body.error.code : null,
        errorSubcode:
          typeof body?.error?.error_subcode === "number"
            ? body.error.error_subcode
            : null,
        rows: rows.length,
        spendBearingRows: rows.filter((row) => Number(row?.spend ?? 0) > 0).length,
      });
    } catch {
      probes.push({
        ok: false,
        status: 0,
        errorCode: null,
        errorSubcode: null,
        rows: 0,
        spendBearingRows: 0,
      });
    }
  }

  return probes;
}

export async function getCandidateBusinesses(): Promise<SourceBusinessRow[]> {
  const sql = getDb();
  return sql.query<SourceBusinessRow>(
    `
      WITH latest AS (
        SELECT DISTINCT ON (business_id)
          business_id,
          end_date::text AS max_end_date,
          row_count AS max_row_count,
          last_synced_at::text AS latest_synced_at
        FROM meta_creatives_snapshots
        WHERE group_by = 'creative'
          AND format = 'all'
          AND sort = 'spend'
          AND row_count > 0
        ORDER BY business_id, end_date DESC, row_count DESC, last_synced_at DESC
      ),
      assignment_counts AS (
        SELECT
          business_id,
          COUNT(DISTINCT provider_account_ref_id)::int AS assigned_account_count
        FROM business_provider_accounts
        WHERE provider = 'meta'
          AND NULLIF(provider_account_id, '') IS NOT NULL
        GROUP BY business_id
      )
      SELECT
        latest.business_id,
        latest.max_end_date,
        latest.max_row_count,
        latest.latest_synced_at,
        pc.status AS connection_status,
        (NULLIF(ic.access_token, '') IS NOT NULL) AS has_access_token,
        (COALESCE(ic.access_token, '') LIKE 'enc:v1:%') AS has_encrypted_access_token,
        COALESCE(assignment_counts.assigned_account_count, 0)::int AS assigned_account_count
      FROM latest
      LEFT JOIN provider_connections pc
        ON pc.business_id = latest.business_id
       AND pc.provider = 'meta'
      LEFT JOIN integration_credentials ic
        ON ic.provider_connection_id = pc.id
      LEFT JOIN assignment_counts
        ON assignment_counts.business_id = latest.business_id
      ORDER BY latest.max_row_count DESC, latest.latest_synced_at DESC
    `,
    [],
  );
}

async function getWarehouseCreativeDailyStatus(): Promise<DatasetArtifact["dataAccuracyGate"]["warehouseCreativeDaily"]> {
  const sql = getDb();
  const [row] = await sql.query<{ row_count: string | number }>(
    "SELECT COUNT(*) AS row_count FROM meta_creative_daily",
    [],
  );
  const rowCount = Number(row?.row_count ?? 0);
  return {
    available: rowCount > 0,
    rowCount,
    checkedAgainstCurrentPipeline: false,
    confidence: rowCount > 0 ? "api_payload_parity_plus_warehouse_available" : "api_payload_parity_only",
    status: rowCount > 0 ? "available_not_cross_checked" : "empty_table",
  };
}

async function persistArtifact(artifact: DatasetArtifact) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(DATASET_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        output: DATASET_PATH,
        gatePassed: artifact.dataAccuracyGate.passed,
        checkedCompanies: artifact.dataAccuracyGate.checkedCompanies,
        checkedRows: artifact.dataAccuracyGate.checkedRows,
        blockers: artifact.dataAccuracyGate.blockers,
        warnings: artifact.dataAccuracyGate.warnings,
        coverage: artifact.coverage,
      },
      null,
      2,
    ),
  );
  return artifact;
}

export async function runCalibrationLab() {
  installSanitizedRuntimeGuards();
  const generatedAt = new Date().toISOString();
  const candidateRows = await getCandidateBusinesses();
  const candidateEligibility = summarizeCandidateEligibility(candidateRows);
  const runtimeTokenReadability = await assessRuntimeTokenReadability({
    candidates: candidateEligibility.eligible,
  });
  const warehouseCreativeDaily = await getWarehouseCreativeDailyStatus();
  const rows: SanitizedCalibrationRow[] = [];
  const warnings: string[] = [
    "Campaign baselines in this artifact are lab-computed only; production campaign segmentation still requires explicit benchmark scope input.",
  ];
  if (candidateEligibility.skippedCandidates > 0) {
    warnings.push(
      "Some historical snapshot businesses were skipped because they are not currently eligible for Creative Decision OS validation.",
    );
  }
  if (!warehouseCreativeDaily.available) {
    warnings.push(
      "meta_creative_daily is empty in the checked database; current verification is API/payload parity only because the product Creative pipeline uses the creative API/snapshot source.",
    );
  } else {
    warnings.push(
      "meta_creative_daily has rows, but this gate does not yet cross-check it against the current Creative API/snapshot source.",
    );
  }
  const blockers: string[] = [];
  const coverage = createEmptyCoverageSummary();
  let tableDecisionMismatches = 0;
  let zeroRowEligibleCandidates = 0;
  const runtimeSkippedCandidatesByReason = {
    ...EMPTY_RUNTIME_SKIPPED_CANDIDATES_BY_REASON,
  };
  const runtimeEligibleBusinesses: Array<{
    business: SourceBusinessRow;
    live30d: FetchCreativePayloadResult;
  }> = [];
  const maxMetricDelta = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])) as Record<
    NumericMetricKey,
    number
  >;

  const runtimeTokenBlocker = buildRuntimeTokenReadabilityBlocker(runtimeTokenReadability.status);
  if (runtimeTokenBlocker) {
    blockers.push(runtimeTokenBlocker);
  }

  if (candidateEligibility.eligible.length === 0) {
    blockers.push("No currently eligible Meta-connected businesses were available for calibration.");
  }

  for (const [candidateIndex, business] of candidateEligibility.eligible.entries()) {
    if (blockers.length > 0) break;
    const candidateAlias = `candidate-${String(candidateIndex + 1).padStart(2, "0")}`;
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
    }).catch((error) => {
      warnings.push(
        `${candidateAlias}: skipped because the live Meta cohort probe failed before rows could be verified (${error instanceof Error ? error.message : "unknown error"}).`,
      );
      runtimeSkippedCandidatesByReason.provider_read_failure += 1;
      return null;
    });
    if (!live30d) continue;

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
      warnings.push(buildRuntimeSkipWarning(candidateAlias, runtimeSkipReason));
      continue;
    }

    runtimeEligibleBusinesses.push({ business, live30d });
  }

  const businessRows = runtimeEligibleBusinesses.slice(0, MAX_COMPANIES);

  if (
    shouldReportNoLiveReadableBusinesses({
      runtimeTokenReadabilityStatus: runtimeTokenReadability.status,
      runtimeEligibleCandidateCount: runtimeEligibleBusinesses.length,
    })
  ) {
    blockers.push("No live Meta-readable businesses were available for calibration.");
  }

  for (const [businessIndex, runtimeEligible] of businessRows.entries()) {
      const business = runtimeEligible.business;
      const companyAlias = `company-${String(businessIndex + 1).padStart(2, "0")}`;
      const decisionAsOf = business.max_end_date;
      const startDate = addDaysToIsoDate(decisionAsOf, -29);
      const endDate = decisionAsOf;
      const request = new NextRequest(
        `http://localhost/api/creatives/decision-os?businessId=${encodeURIComponent(
          business.business_id,
        )}&startDate=${startDate}&endDate=${endDate}&decisionAsOf=${endDate}`,
      );

      let decisionOs: Awaited<ReturnType<typeof getCreativeDecisionOsForRange>>;
      let tableRows: MetaCreativeRow[] = runtimeEligible.live30d.rows;
      let last7Rows: MetaCreativeRow[];
      let last90Rows: MetaCreativeRow[];
      try {
        decisionOs = await getCreativeDecisionOsForRange({
          request,
          businessId: business.business_id,
          startDate,
          endDate,
          analyticsStartDate: startDate,
          analyticsEndDate: endDate,
          decisionAsOf: endDate,
        });
        last7Rows = await fetchCreativeRows({
          request,
          businessId: business.business_id,
          startDate: addDaysToIsoDate(endDate, -6),
          endDate,
        });
        last90Rows = await fetchCreativeRows({
          request,
          businessId: business.business_id,
          startDate: addDaysToIsoDate(endDate, -89),
          endDate,
        });
      } catch (error) {
        blockers.push(
          `${companyAlias}: current Creative source failed before rows could be verified (${error instanceof Error ? error.message : "unknown error"}).`,
        );
        coverage.companies += 1;
        continue;
      }

      const tableCheck = compareTableAndDecisionRows({ tableRows, creatives: decisionOs.creatives });
      tableDecisionMismatches += tableCheck.mismatches;
      for (const key of METRIC_KEYS) {
        maxMetricDelta[key] = Math.max(maxMetricDelta[key], tableCheck.maxMetricDelta[key]);
      }

      if (tableCheck.mismatches > 0) {
        blockers.push(
          `${companyAlias}: Decision OS and Creative table row identifiers diverged (${tableCheck.mismatches} missing rows).`,
        );
      }
      for (const [metric, delta] of Object.entries(tableCheck.maxMetricDelta)) {
        if (delta > 0.02) {
          blockers.push(`${companyAlias}: ${metric} metric delta exceeded tolerance (${delta}).`);
        }
      }

      const accountAlias = buildAliasFactory(`${companyAlias}-account`);
      const campaignAlias = buildAliasFactory(`${companyAlias}-campaign`);
      const adSetAlias = buildAliasFactory(`${companyAlias}-adset`);
      const creativeAlias = buildAliasFactory(`${companyAlias}-creative`);
      const tableById = new Map(tableRows.map((row) => [row.id, row]));
      const oldRuleRows = buildCreativeOldRuleChallenger(
        decisionOs.creatives.map((creative) => toOldRuleInput(creative, tableById.get(creative.creativeId) ?? null)),
      );
      const oldRuleById = new Map(oldRuleRows.map((row) => [row.creativeId, row]));
      const last7ById = new Map(last7Rows.map((row) => [row.id, row]));
      const last30ById = new Map(tableRows.map((row) => [row.id, row]));
      const last90ById = new Map(last90Rows.map((row) => [row.id, row]));
      const sampledRows = selectRepresentativeRows(decisionOs.creatives);

      coverage.companies += 1;
      coverage.creatives += sampledRows.length;

      for (const creative of sampledRows) {
        const contextRow = tableById.get(creative.creativeId) ?? null;
        const rawCampaignId = contextRow?.campaignId ?? null;
        const rawAdSetId = contextRow?.adSetId ?? null;
        const account = accountAlias(contextRow?.accountId ?? null);
        const campaign = campaignAlias(rawCampaignId);
        const adSet = adSetAlias(rawAdSetId);
        const alias = creativeAlias(creative.creativeId);
        const surface = buildCreativeOperatorItem(creative);
        const challenger = oldRuleById.get(creative.creativeId) ?? null;
        const instruction = surface.instruction;
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
        const replacements: Array<[string | null | undefined, string]> = [
          [creative.name, alias],
          [contextRow?.campaignName, campaign],
          [rawCampaignId, campaign],
          [contextRow?.adSetName, adSet],
          [rawAdSetId, adSet],
        ];
        const userFacing = creativeOperatorSegmentLabel(creative);
        const pushReadiness = creative.operatorPolicy?.pushReadiness ?? null;

        recordCoverage({
          coverage,
          internalSegment: creative.operatorPolicy?.segment ?? null,
          quickFilter: resolveCreativeQuickFilterKey(creative),
          userFacingSegment: userFacing,
          oldRuleSegment: challenger?.challengerAction ?? null,
          baselineReliability: creative.relativeBaseline.reliability,
          pushReadiness,
        });

        rows.push({
          companyAlias,
          accountAlias: account,
          campaignAlias: campaign,
          adSetAlias: adSet,
          creativeAlias: alias,
          currentDecisionOsInternalSegment: creative.operatorPolicy?.segment ?? null,
          currentUserFacingSegment: userFacing,
          oldRuleChallengerSegment: challenger?.challengerAction ?? null,
          oldRuleChallengerReason: challenger?.reason ?? null,
          accountBaseline: summarizeAccountBaseline(creative),
          campaignBaseline,
          spend: round(creative.spend),
          purchases: round(creative.purchases),
          cpa: round(creative.cpa),
          roas: round(creative.roas),
          value: round(creative.purchaseValue),
          recent7d: historyMetric(last7ById, creative.creativeId),
          mid30d: historyMetric(last30ById, creative.creativeId),
          long90d: historyMetric(last90ById, creative.creativeId),
          trendIndicators: {
            fatigueStatus: creative.fatigue.status,
            fatigueConfidence: creative.fatigue.confidence,
            lifecycleState: creative.lifecycleState,
            primaryAction: creative.primaryAction,
          },
          creativeAgeDays: creative.creativeAgeDays,
          frequency: null,
          commercialTruthAvailability: {
            targetPackConfigured: decisionOs.commercialTruthCoverage.configuredSections.targetPack,
            missingInputs: decisionOs.commercialTruthCoverage.missingInputs,
          },
          campaignAdSetContextFlags: {
            campaignPresent: Boolean(rawCampaignId),
            adSetPresent: Boolean(rawAdSetId),
            deploymentCompatibility: creative.deployment.compatibility.status,
            targetLane: creative.deployment.targetLane,
          },
          evidenceQuality: {
            evidenceSource: creative.evidenceSource,
            trustState: creative.trust.truthState,
            surfaceLane: creative.trust.surfaceLane,
            previewWindow: creative.previewStatus?.liveDecisionWindow ?? null,
            baselineReliability: creative.relativeBaseline.reliability,
          },
          currentPushReadiness: pushReadiness,
          currentInstructionHeadline: sanitizeText(instruction?.headline ?? "", replacements),
          reasonSummary: sanitizeText(instruction?.reasonSummary ?? "", replacements),
          missingEvidence: (instruction?.missingEvidence ?? []).map((item) =>
            sanitizeText(item, replacements),
          ),
        });
      }

      if (decisionOs.creatives.length === 0) {
        zeroRowEligibleCandidates += 1;
        blockers.push(
          tableRows.length > 0
            ? `${companyAlias}: current Decision OS returned zero rows despite live creative source rows.`
            : `${companyAlias}: current Decision OS returned zero verifiable rows.`,
        );
      }
  }

  if (rows.length === 0) {
    blockers.push("No verifiable current Decision OS creative rows were available; agent calibration must not run.");
  }

  const artifact: DatasetArtifact = {
    generatedAt,
    source: "creative_segmentation_calibration_lab",
    sanitization: {
      rawIdsIncluded: false,
      rawNamesIncluded: false,
      notes: [
        "Business, account, campaign, ad set, and creative identifiers are replaced with deterministic aliases per generated artifact.",
        "Creative names, campaign names, ad set names, preview URLs, copy text, tokens, and customer names are not exported.",
      ],
    },
    dataAccuracyGate: {
      passed: blockers.length === 0 && rows.length > 0,
      blockers,
      warnings,
      checkedCompanies: coverage.companies,
      checkedRows: coverage.creatives,
      tableDecisionMismatches,
      maxMetricDelta,
      candidateEligibility: {
        historicalSnapshotCandidates: candidateRows.length,
        eligibleCandidates: candidateEligibility.eligible.length,
        runtimeEligibleCandidates: runtimeEligibleBusinesses.length,
        skippedCandidates: candidateEligibility.skippedCandidates,
        skippedCandidatesByReason: candidateEligibility.skippedCandidatesByReason,
        runtimeSkippedCandidates: countRuntimeSkippedCandidates(runtimeSkippedCandidatesByReason),
        runtimeSkippedCandidatesByReason,
        sampledCandidates: businessRows.length,
        zeroRowEligibleCandidates,
      },
      warehouseCreativeDaily,
    },
    coverage,
    rows,
  };

  return persistArtifact(artifact);
}

function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isDirectRun()) {
  runCalibrationLab()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    resetDbClientCache();
  });
}
