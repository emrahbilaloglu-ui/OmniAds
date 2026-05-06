import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadEnvConfig } from "@next/env";
import type {
  CreativeDecisionOsV2Input,
  CreativeDecisionOsV2Output,
  CreativeDecisionOsV2PrimaryDecision,
} from "@/lib/creative-decision-os-v2";

const REPORT_DIR =
  "docs/operator-policy/creative-segmentation-recovery/reports/v2-live-audit-2026-04-26";
const COMMAND =
  "<database connection configured via local tunnel; value omitted> DB_QUERY_TIMEOUT_MS=60000 DB_CONNECTION_TIMEOUT_MS=30000 CREATIVE_LIVE_ENV_DIR=/Users/harmelek/Adsecute CREATIVE_LIVE_FIRM_AUDIT_MAX_ROWS=100000 node --import tsx scripts/creative-decision-os-v2-live-audit.ts";

type MetricWindow = {
  spend?: number | null;
  purchaseValue?: number | null;
  roas?: number | null;
  cpa?: number | null;
  purchases?: number | null;
  impressions?: number | null;
  linkClicks?: number | null;
};

type BaselineSummary = {
  reliability?: string | null;
  medianRoas?: number | null;
  medianCpa?: number | null;
  medianSpend?: number | null;
};

type CurrentSanitizedRow = {
  companyAlias: string;
  accountAlias: string;
  campaignAlias: string;
  adSetAlias: string;
  creativeAlias: string;
  activeStatus: boolean;
  activeStatusSource: string;
  campaignStatus: string | null;
  adSetStatus: string | null;
  spend30d: number;
  recent7d: MetricWindow | null;
  mid30d: MetricWindow | null;
  long90d: MetricWindow | null;
  currentDecisionOsInternalSegment: string | null;
  currentUserFacingSegment: string;
  currentInstructionHeadline: string;
  reasonSummary: string;
  nextObservation: string[];
  baselineReliability: string;
  accountBaseline: BaselineSummary;
  campaignBaseline: BaselineSummary | null;
  businessValidationStatus: string;
  pushReadiness: string | null;
  queueEligible: boolean;
  canApply: boolean;
  lifecycleState: string;
  primaryAction: string;
  evidenceSource: string;
  trustState: string;
  deploymentCompatibility: string;
  deploymentTargetLane: string | null;
  campaignContextLimited: boolean;
};

type CurrentSanitizedArtifact = {
  generatedAt: string;
  auditWindow: unknown;
  cohort: {
    runtimeEligibleBusinesses: number;
  };
  businesses: Array<{
    companyAlias: string;
    sampledCreatives: number;
    activeCreativesSampled: number;
  }>;
  rows: CurrentSanitizedRow[];
};

type V2LiveAuditRow = {
  rowId: string;
  companyId: string;
  accountId: string;
  campaignId: string;
  adSetId: string;
  creativeId: string;
  currentOperatorDecision: string;
  currentInternalSegment: string | null;
  currentInstructionHeadline: string;
  currentReasonSummary: string;
  currentQueueEligible: boolean;
  currentApplyEligible: boolean;
  v2PrimaryDecision: CreativeDecisionOsV2PrimaryDecision;
  v2Actionability: CreativeDecisionOsV2Output["actionability"];
  v2Confidence: number;
  v2ReasonTags: string[];
  v2EvidenceSummary: string;
  v2RiskLevel: CreativeDecisionOsV2Output["riskLevel"];
  v2ProblemClass: CreativeDecisionOsV2Output["problemClass"];
  v2QueueEligible: boolean;
  v2ApplyEligible: boolean;
  v2BlockerReasons: string[];
  spend: number;
  purchases: number | null;
  impressions: number | null;
  roas: number | null;
  cpa: number | null;
  recentRoas: number | null;
  recentPurchases: number | null;
  longWindowRoas: number | null;
  activeBenchmarkRoas: number | null;
  activeBenchmarkCpa: number | null;
  peerMedianSpend: number | null;
  activeStatus: boolean;
  campaignStatus: string | null;
  adSetStatus: string | null;
  campaignAdsetBlockerFlags: string[];
  trustSourceProvenanceFlags: string[];
  changedFromCurrent: boolean;
};

type SafetySummary = {
  generatedAt: string;
  branch: string;
  headCommit: string;
  exactCommand: string;
  sourceAuditGeneratedAt: string;
  businessesAudited: number;
  accountsAudited: number;
  creativeRowsAudited: number;
  v2DecisionDistribution: Record<string, number>;
  currentDecisionDistribution: Record<string, number>;
  changedRowCount: number;
  changedRowsByTransition: Record<string, number>;
  directScaleCount: number;
  inactiveDirectScaleCount: number;
  queueEligibleTrueCount: number;
  applyEligibleTrueCount: number;
  watchPrimaryCount: number;
  scaleReviewPrimaryCount: number;
  cutCount: number;
  refreshCount: number;
  diagnoseCount: number;
  rowsWithBlockerReasons: string[];
  directActionDespiteSourceOrCampaignBlockers: string[];
  testMoreDirectOnDegradedOrDataQualityRisk: string[];
  cutOnActiveWithRecentConversions: string[];
  protectDespiteRecentSevereDecay: string[];
  refreshDespiteStableAboveBenchmark: string[];
  top20HighestSpendV2Decisions: Array<Pick<
    V2LiveAuditRow,
    | "rowId"
    | "spend"
    | "currentOperatorDecision"
    | "v2PrimaryDecision"
    | "v2Actionability"
    | "v2RiskLevel"
    | "v2ReasonTags"
  >>;
  top20HighestRiskDecisionChanges: Array<Pick<
    V2LiveAuditRow,
    | "rowId"
    | "spend"
    | "currentOperatorDecision"
    | "v2PrimaryDecision"
    | "v2Actionability"
    | "v2RiskLevel"
    | "v2ReasonTags"
  >>;
};

function gitValue(command: string) {
  return execSync(command, { encoding: "utf8" }).trim();
}

function n(value: number | null | undefined, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function preferredBaseline(row: CurrentSanitizedRow) {
  if (row.campaignBaseline?.medianRoas && row.campaignBaseline.medianRoas > 0) {
    return row.campaignBaseline;
  }
  return row.accountBaseline;
}

function blockerFlags(row: CurrentSanitizedRow) {
  const flags: string[] = [];
  if (!row.activeStatus) flags.push("inactive_creative");
  if (row.campaignStatus && row.campaignStatus !== "ACTIVE") {
    flags.push(`campaign_status_${row.campaignStatus.toLowerCase()}`);
  }
  if (row.adSetStatus && row.adSetStatus !== "ACTIVE") {
    flags.push(`adset_status_${row.adSetStatus.toLowerCase()}`);
  }
  if (row.campaignContextLimited) flags.push("campaign_context_limited");
  if (row.deploymentCompatibility === "blocked") flags.push("deployment_blocked");
  return flags;
}

function trustFlags(row: CurrentSanitizedRow) {
  return [
    `trust_${row.trustState || "missing"}`,
    `evidence_${row.evidenceSource || "missing"}`,
    `baseline_${row.baselineReliability || "missing"}`,
    `validation_${row.businessValidationStatus || "missing"}`,
    `active_source_${row.activeStatusSource || "missing"}`,
    `push_${row.pushReadiness || "missing"}`,
  ];
}

function toInput(row: CurrentSanitizedRow): CreativeDecisionOsV2Input {
  const baseline = preferredBaseline(row);
  return {
    rowId: [
      row.companyAlias,
      row.accountAlias,
      row.campaignAlias,
      row.adSetAlias,
      row.creativeAlias,
    ].join("|"),
    activeStatus: row.activeStatus,
    campaignStatus: row.campaignStatus,
    adsetStatus: row.adSetStatus,
    spend: row.mid30d?.spend ?? row.spend30d,
    purchases: row.mid30d?.purchases,
    impressions: row.mid30d?.impressions,
    roas: row.mid30d?.roas,
    cpa: row.mid30d?.cpa,
    recentRoas: row.recent7d?.roas,
    recentPurchases: row.recent7d?.purchases,
    long90Roas: row.long90d?.roas,
    activeBenchmarkRoas: baseline.medianRoas,
    activeBenchmarkCpa: baseline.medianCpa,
    peerMedianSpend: baseline.medianSpend,
    trustState: row.trustState,
    baselineReliability: row.baselineReliability,
    sourceTrustFlags: trustFlags(row),
    campaignContextBlockerFlags: blockerFlags(row),
    existingQueueEligible: row.queueEligible,
    existingApplyEligible: row.canApply,
  };
}

function increment(map: Record<string, number>, key: string | null | undefined) {
  const normalized = key?.trim() || "missing";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

function transition(row: V2LiveAuditRow) {
  return `${row.currentOperatorDecision} -> ${row.v2PrimaryDecision}`;
}

function riskScore(row: V2LiveAuditRow) {
  const risk = { low: 1, medium: 2, high: 3, critical: 4 }[row.v2RiskLevel] ?? 0;
  const direct = row.v2Actionability === "direct" ? 1 : 0;
  const changed = row.changedFromCurrent ? 1 : 0;
  const blocker = row.v2BlockerReasons.length > 0 ? 1 : 0;
  return risk * 10 + direct * 3 + changed * 2 + blocker;
}

function csvEscape(value: unknown) {
  if (Array.isArray(value)) return csvEscape(value.join(";"));
  if (value == null) return "";
  const stringValue = String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function writeCsv(path: string, rows: V2LiveAuditRow[]) {
  const headers = [
    "rowId",
    "companyId",
    "accountId",
    "campaignId",
    "adSetId",
    "creativeId",
    "currentOperatorDecision",
    "v2PrimaryDecision",
    "v2Actionability",
    "v2Confidence",
    "v2ReasonTags",
    "v2RiskLevel",
    "v2ProblemClass",
    "v2QueueEligible",
    "v2ApplyEligible",
    "spend",
    "purchases",
    "impressions",
    "roas",
    "cpa",
    "recentRoas",
    "recentPurchases",
    "longWindowRoas",
    "activeBenchmarkRoas",
    "activeBenchmarkCpa",
    "peerMedianSpend",
    "activeStatus",
    "campaignStatus",
    "adSetStatus",
    "campaignAdsetBlockerFlags",
    "trustSourceProvenanceFlags",
    "changedFromCurrent",
  ] as const;
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function summarize(rows: V2LiveAuditRow[], artifact: CurrentSanitizedArtifact): SafetySummary {
  const v2DecisionDistribution: Record<string, number> = {};
  const currentDecisionDistribution: Record<string, number> = {};
  const changedRowsByTransition: Record<string, number> = {};
  for (const row of rows) {
    increment(v2DecisionDistribution, row.v2PrimaryDecision);
    increment(currentDecisionDistribution, row.currentOperatorDecision);
    if (row.changedFromCurrent) increment(changedRowsByTransition, transition(row));
  }

  const directAction = (row: V2LiveAuditRow) => row.v2Actionability === "direct";
  const hasSourceOrCampaignBlocker = (row: V2LiveAuditRow) =>
    row.campaignAdsetBlockerFlags.length > 0 ||
    row.trustSourceProvenanceFlags.some((flag) =>
      flag.includes("inactive_or_immaterial") ||
      flag.includes("degraded") ||
      flag.includes("missing") ||
      flag.includes("blocked") ||
      flag.includes("read_only"),
    );
  const degradedOrDataQuality = (row: V2LiveAuditRow) =>
    row.trustSourceProvenanceFlags.some((flag) => flag.includes("degraded")) ||
    row.v2BlockerReasons.includes("benchmark_context_not_strong") ||
    row.v2ProblemClass === "data-quality";
  const recentSevereDecay = (row: V2LiveAuditRow) =>
    row.recentRoas != null &&
    row.activeBenchmarkRoas != null &&
    row.activeBenchmarkRoas > 0 &&
    row.recentRoas / row.activeBenchmarkRoas < 0.55;
  const stableAboveBenchmark = (row: V2LiveAuditRow) =>
    row.roas != null &&
    row.recentRoas != null &&
    row.activeBenchmarkRoas != null &&
    row.activeBenchmarkRoas > 0 &&
    row.roas >= row.activeBenchmarkRoas &&
    row.recentRoas >= row.activeBenchmarkRoas;

  return {
    generatedAt: new Date().toISOString(),
    branch: gitValue("git branch --show-current"),
    headCommit: gitValue("git rev-parse HEAD"),
    exactCommand: COMMAND,
    sourceAuditGeneratedAt: artifact.generatedAt,
    businessesAudited: artifact.cohort.runtimeEligibleBusinesses,
    accountsAudited: new Set(rows.map((row) => row.accountId)).size,
    creativeRowsAudited: rows.length,
    v2DecisionDistribution,
    currentDecisionDistribution,
    changedRowCount: rows.filter((row) => row.changedFromCurrent).length,
    changedRowsByTransition,
    directScaleCount: rows.filter(
      (row) => row.v2PrimaryDecision === "Scale" && row.v2Actionability === "direct",
    ).length,
    inactiveDirectScaleCount: rows.filter(
      (row) => !row.activeStatus && row.v2PrimaryDecision === "Scale" && row.v2Actionability === "direct",
    ).length,
    queueEligibleTrueCount: rows.filter((row) => row.v2QueueEligible).length,
    applyEligibleTrueCount: rows.filter((row) => row.v2ApplyEligible).length,
    watchPrimaryCount: rows.filter((row) => row.v2PrimaryDecision === ("Watch" as CreativeDecisionOsV2PrimaryDecision)).length,
    scaleReviewPrimaryCount: rows.filter(
      (row) => row.v2PrimaryDecision === ("Scale Review" as CreativeDecisionOsV2PrimaryDecision),
    ).length,
    cutCount: rows.filter((row) => row.v2PrimaryDecision === "Cut").length,
    refreshCount: rows.filter((row) => row.v2PrimaryDecision === "Refresh").length,
    diagnoseCount: rows.filter((row) => row.v2PrimaryDecision === "Diagnose").length,
    rowsWithBlockerReasons: rows
      .filter((row) => row.v2BlockerReasons.length > 0)
      .map((row) => row.rowId),
    directActionDespiteSourceOrCampaignBlockers: rows
      .filter((row) => directAction(row) && hasSourceOrCampaignBlocker(row))
      .map((row) => row.rowId),
    testMoreDirectOnDegradedOrDataQualityRisk: rows
      .filter((row) => row.v2PrimaryDecision === "Test More" && directAction(row) && degradedOrDataQuality(row))
      .map((row) => row.rowId),
    cutOnActiveWithRecentConversions: rows
      .filter((row) => row.v2PrimaryDecision === "Cut" && row.activeStatus && n(row.recentPurchases) > 0)
      .map((row) => row.rowId),
    protectDespiteRecentSevereDecay: rows
      .filter((row) => row.v2PrimaryDecision === "Protect" && recentSevereDecay(row))
      .map((row) => row.rowId),
    refreshDespiteStableAboveBenchmark: rows
      .filter((row) => row.v2PrimaryDecision === "Refresh" && stableAboveBenchmark(row))
      .map((row) => row.rowId),
    top20HighestSpendV2Decisions: [...rows]
      .sort((left, right) => right.spend - left.spend)
      .slice(0, 20)
      .map(topRow),
    top20HighestRiskDecisionChanges: rows
      .filter((row) => row.changedFromCurrent)
      .sort((left, right) => riskScore(right) - riskScore(left) || right.spend - left.spend)
      .slice(0, 20)
      .map(topRow),
  };
}

function topRow(row: V2LiveAuditRow) {
  return {
    rowId: row.rowId,
    spend: row.spend,
    currentOperatorDecision: row.currentOperatorDecision,
    v2PrimaryDecision: row.v2PrimaryDecision,
    v2Actionability: row.v2Actionability,
    v2RiskLevel: row.v2RiskLevel,
    v2ReasonTags: row.v2ReasonTags,
  };
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function installLocalhostRefreshGuard() {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl);
    const local =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1";
    if (local && url.pathname.startsWith("/api/")) {
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

async function main() {
  loadEnvConfig(process.env.CREATIVE_LIVE_ENV_DIR ?? process.cwd());
  installLocalhostRefreshGuard();
  const { runCreativeLiveFirmAudit } = await import("./creative-live-firm-audit");
  const { resolveCreativeDecisionOsV2 } = await import("@/lib/creative-decision-os-v2");
  const { sanitizedArtifact } = await runCreativeLiveFirmAudit() as {
    sanitizedArtifact: CurrentSanitizedArtifact;
  };

  const rows = sanitizedArtifact.rows.map((row): V2LiveAuditRow => {
    const input = toInput(row);
    const baseline = preferredBaseline(row);
    const output = resolveCreativeDecisionOsV2(input);
    const rowId = input.rowId ?? [
      row.companyAlias,
      row.accountAlias,
      row.campaignAlias,
      row.adSetAlias,
      row.creativeAlias,
    ].join("|");
    return {
      rowId,
      companyId: row.companyAlias,
      accountId: row.accountAlias,
      campaignId: row.campaignAlias,
      adSetId: row.adSetAlias,
      creativeId: row.creativeAlias,
      currentOperatorDecision: row.currentUserFacingSegment,
      currentInternalSegment: row.currentDecisionOsInternalSegment,
      currentInstructionHeadline: row.currentInstructionHeadline,
      currentReasonSummary: row.reasonSummary,
      currentQueueEligible: row.queueEligible,
      currentApplyEligible: row.canApply,
      v2PrimaryDecision: output.primaryDecision,
      v2Actionability: output.actionability,
      v2Confidence: output.confidence,
      v2ReasonTags: output.reasonTags,
      v2EvidenceSummary: output.evidenceSummary,
      v2RiskLevel: output.riskLevel,
      v2ProblemClass: output.problemClass,
      v2QueueEligible: output.queueEligible,
      v2ApplyEligible: output.applyEligible,
      v2BlockerReasons: output.blockerReasons,
      spend: n(row.mid30d?.spend, row.spend30d),
      purchases: nullableNumber(row.mid30d?.purchases),
      impressions: nullableNumber(row.mid30d?.impressions),
      roas: nullableNumber(row.mid30d?.roas),
      cpa: nullableNumber(row.mid30d?.cpa),
      recentRoas: nullableNumber(row.recent7d?.roas),
      recentPurchases: nullableNumber(row.recent7d?.purchases),
      longWindowRoas: nullableNumber(row.long90d?.roas),
      activeBenchmarkRoas: nullableNumber(baseline.medianRoas),
      activeBenchmarkCpa: nullableNumber(baseline.medianCpa),
      peerMedianSpend: nullableNumber(baseline.medianSpend),
      activeStatus: row.activeStatus,
      campaignStatus: row.campaignStatus,
      adSetStatus: row.adSetStatus,
      campaignAdsetBlockerFlags: blockerFlags(row),
      trustSourceProvenanceFlags: trustFlags(row),
      changedFromCurrent: row.currentUserFacingSegment !== output.primaryDecision,
    };
  });

  const summary = summarize(rows, sanitizedArtifact);
  const diffRows = rows.filter((row) => row.changedFromCurrent);
  mkdirSync(REPORT_DIR, { recursive: true });
  writeJson(`${REPORT_DIR}/live-audit-sanitized.json`, {
    generatedAt: summary.generatedAt,
    source: "creative_decision_os_v2_live_audit",
    branch: summary.branch,
    headCommit: summary.headCommit,
    exactCommand: COMMAND,
    auditWindow: sanitizedArtifact.auditWindow,
    sanitized: {
      rawIdsIncluded: false,
      rawNamesIncluded: false,
    },
    summary,
    rows,
  });
  writeCsv(`${REPORT_DIR}/live-audit-sanitized.csv`, rows);
  writeJson(`${REPORT_DIR}/live-decision-diff-main-vs-v2.json`, {
    generatedAt: summary.generatedAt,
    branch: summary.branch,
    headCommit: summary.headCommit,
    changedRowCount: diffRows.length,
    changedRowsByTransition: summary.changedRowsByTransition,
    rows: diffRows,
  });
  writeJson(`${REPORT_DIR}/live-safety-summary.json`, summary);
  console.log(JSON.stringify({
    reportDir: REPORT_DIR,
    businessesAudited: summary.businessesAudited,
    creativeRowsAudited: summary.creativeRowsAudited,
    changedRowCount: summary.changedRowCount,
    directScaleCount: summary.directScaleCount,
    inactiveDirectScaleCount: summary.inactiveDirectScaleCount,
    queueEligibleTrueCount: summary.queueEligibleTrueCount,
    applyEligibleTrueCount: summary.applyEligibleTrueCount,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
