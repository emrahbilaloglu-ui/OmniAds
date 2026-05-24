import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_SHADOW_ARTIFACT_SOURCE =
  "docs/creative-decision-center/generated/before-after-shadow.json";

export const DEFAULT_SHADOW_REPORT_DOC_SOURCE =
  "docs/creative-decision-center/03-before-after-shadow-report.md";

const REQUIRED_SUMMARY_KEYS = [
  "totalCreativesCompared",
  "unchangedDecisions",
  "saferMoreSpecific",
  "aggressiveChanges",
  "fallbackDueToMissingData",
  "conflictCount",
  "diagnoseDataRate",
  "highConfidenceRate",
] as const;

const REQUIRED_ROW_FIELDS = [
  "creativeId",
  "creativeName",
  "familyId",
  "beforePrimaryDecision",
  "beforeOperatorBucket",
  "beforeUserLabel",
  "v2PrimaryDecision",
  "afterBuyerAction",
  "afterProblemClass",
  "afterActionability",
  "afterPriorityBand",
  "afterConfidenceBand",
  "topReasonTag",
  "missingData",
  "decisionChanged",
  "changeType",
  "riskLevel",
  "notes",
] as const;

const DOC_SUMMARY_LABEL_TO_KEY = {
  "Total creatives compared": "totalCreativesCompared",
  "Unchanged decisions": "unchangedDecisions",
  "Safer/more specific": "saferMoreSpecific",
  "More aggressive": "aggressiveChanges",
  "Fallback due to missing data": "fallbackDueToMissingData",
  Conflicts: "conflictCount",
  "Diagnose data rate": "diagnoseDataRate",
  "High confidence rate": "highConfidenceRate",
} as const satisfies Record<string, ShadowSummaryKey>;

const BEFORE_SCALE_OR_PROTECT_VALUES = new Set([
  "promote_to_scaling",
  "protect",
  "scale",
  "scale_hard",
  "scale_in_test",
  "scale_with_eligibility",
]);

const BEFORE_CUT_OR_KILL_VALUES = new Set(["cut", "cut_now", "kill", "kill_now"]);

export type ShadowSummaryKey = (typeof REQUIRED_SUMMARY_KEYS)[number];

export type LiveComparisonStatus = "not_run" | "fixture_only" | "live_run" | "unknown";

export interface ShadowComparisonRow {
  creativeId: string;
  creativeName: string;
  familyId: string;
  beforePrimaryDecision: string;
  beforeOperatorBucket: string;
  beforeUserLabel: string;
  v2PrimaryDecision: string;
  afterBuyerAction: string;
  afterProblemClass: string;
  afterActionability: string;
  afterPriorityBand: string;
  afterConfidenceBand: string;
  topReasonTag: string;
  missingData: string[];
  decisionChanged: boolean | null;
  changeType: string;
  riskLevel: string;
  notes: string;
}

export type ShadowSummary = Record<ShadowSummaryKey, number | null> & {
  top10Disagreements: ShadowComparisonRow[];
};

export interface NormalizedShadowComparisonArtifact {
  sourcePath: string;
  summary: ShadowSummary;
  rows: ShadowComparisonRow[];
  missingSummaryKeys: string[];
  missingRowFieldCounts: Record<string, number>;
}

export interface ParsedShadowReportDoc {
  sourcePath: string;
  liveComparisonStatus: LiveComparisonStatus;
  reason: string | null;
  fallback: string | null;
  productionBehaviorChanged: boolean | null;
  summary: Partial<Record<ShadowSummaryKey, number>>;
  unsupportedSummaryLabels: UnsupportedDocSummaryLabel[];
}

export interface ShadowParityDifference {
  key: ShadowSummaryKey;
  artifact: number | null;
  reportDoc: number | null;
}

export interface UnsupportedDocSummaryLabel {
  label: string;
  value: number | null;
}

export interface ShadowRowExample {
  creativeId: string;
  beforePrimaryDecision: string;
  beforeOperatorBucket: string;
  afterBuyerAction: string;
  afterConfidenceBand: string;
  missingData: string[];
}

export interface ShadowCheckResult {
  name: string;
  count: number;
  examples: ShadowRowExample[];
}

export interface ShadowReportProbeReport {
  contractVersion: "creative-decision-center.v2.1.shadow-report.probe.v1";
  sourceArtifact: {
    path: string;
    readOnly: true;
    rowCount: number;
    summaryTotal: number | null;
  };
  sourceReportDoc: {
    path: string | null;
    readOnly: true;
    parsed: boolean;
  };
  readOnly: true;
  mutatesData: false;
  liveComparison: {
    status: LiveComparisonStatus;
    productionBehaviorChanged: boolean | null;
    reason: string | null;
    fallback: string | null;
  };
  summary: {
    artifact: Record<ShadowSummaryKey, number | null>;
    rowCountMatchesSummary: boolean;
    top10DisagreementCount: number;
  };
  summaryParity: {
    docsMatchArtifact: boolean | null;
    differences: ShadowParityDifference[];
    unsupportedDocSummaryLabels: string[];
    nonZeroUnsupportedDocSummaryLabels: UnsupportedDocSummaryLabel[];
  };
  dangerousConflicts: ShadowCheckResult[];
  invariantViolations: ShadowCheckResult[];
  artifactContract: {
    missingSummaryKeys: string[];
    missingRowFieldCounts: Record<string, number>;
  };
  notes: string[];
}

export interface ParsedShadowReportProbeArgs {
  sourcePath: string;
  docPath: string | null;
  pretty: boolean;
  strict: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function normalizeShadowComparisonRow(value: unknown): ShadowComparisonRow {
  const row = isObject(value) ? value : {};

  return {
    creativeId: optionalString(row.creativeId) ?? "",
    creativeName: optionalString(row.creativeName) ?? "",
    familyId: optionalString(row.familyId) ?? "",
    beforePrimaryDecision: optionalString(row.beforePrimaryDecision) ?? "",
    beforeOperatorBucket: optionalString(row.beforeOperatorBucket) ?? "",
    beforeUserLabel: optionalString(row.beforeUserLabel) ?? "",
    v2PrimaryDecision: optionalString(row.v2PrimaryDecision) ?? "",
    afterBuyerAction: optionalString(row.afterBuyerAction) ?? "",
    afterProblemClass: optionalString(row.afterProblemClass) ?? "",
    afterActionability: optionalString(row.afterActionability) ?? "",
    afterPriorityBand: optionalString(row.afterPriorityBand) ?? "",
    afterConfidenceBand: optionalString(row.afterConfidenceBand) ?? "",
    topReasonTag: optionalString(row.topReasonTag) ?? "",
    missingData: stringArray(row.missingData),
    decisionChanged: optionalBoolean(row.decisionChanged),
    changeType: optionalString(row.changeType) ?? "",
    riskLevel: optionalString(row.riskLevel) ?? "",
    notes: optionalString(row.notes) ?? "",
  };
}

function getMissingRowFieldCounts(rows: unknown[]): Record<string, number> {
  const counts = Object.fromEntries(REQUIRED_ROW_FIELDS.map((field) => [field, 0]));

  for (const row of rows) {
    const rawRow = isObject(row) ? row : {};
    for (const field of REQUIRED_ROW_FIELDS) {
      if (!(field in rawRow)) {
        counts[field] += 1;
      }
    }
  }

  return counts;
}

export function normalizeShadowComparisonArtifact(
  input: unknown,
  sourcePath = DEFAULT_SHADOW_ARTIFACT_SOURCE,
): NormalizedShadowComparisonArtifact {
  if (!isObject(input)) {
    throw new Error("Shadow comparison artifact must be a JSON object.");
  }

  const rawSummary = isObject(input.summary) ? input.summary : {};
  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  const rows = rawRows.map(normalizeShadowComparisonRow);
  const summaryEntries = Object.fromEntries(
    REQUIRED_SUMMARY_KEYS.map((key) => [key, optionalNumber(rawSummary[key])]),
  ) as Record<ShadowSummaryKey, number | null>;
  const missingSummaryKeys = REQUIRED_SUMMARY_KEYS.filter((key) => !(key in rawSummary));
  const top10Disagreements = Array.isArray(rawSummary.top10Disagreements)
    ? rawSummary.top10Disagreements.map(normalizeShadowComparisonRow)
    : [];

  return {
    sourcePath,
    summary: {
      ...summaryEntries,
      top10Disagreements,
    },
    rows,
    missingSummaryKeys,
    missingRowFieldCounts: getMissingRowFieldCounts(rawRows),
  };
}

function parseDocNumericValue(value: string): number | null {
  const normalized = value.replace(/`/g, "").replace(/%/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLiveComparisonStatus(value: string | null): LiveComparisonStatus {
  if (value === null) return "unknown";
  const normalized = value.replace(/`/g, "").trim().toLowerCase();
  if (normalized === "not run") return "not_run";
  if (normalized.includes("fixture")) return "fixture_only";
  if (normalized.includes("live")) return "live_run";
  return "unknown";
}

function parseProductionBehaviorChanged(value: string | null): boolean | null {
  if (value === null) return null;
  const normalized = value.replace(/`/g, "").trim().toLowerCase();
  if (normalized === "yes") return true;
  if (normalized === "no") return false;
  return null;
}

export function parseShadowReportDoc(
  markdown: string,
  sourcePath = DEFAULT_SHADOW_REPORT_DOC_SOURCE,
): ParsedShadowReportDoc {
  const liveStatusRows = new Map<string, string>();
  const summary: Partial<Record<ShadowSummaryKey, number>> = {};
  const unsupportedSummaryLabels: UnsupportedDocSummaryLabel[] = [];
  let inLiveStatus = false;
  let inShadowSummary = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      inLiveStatus = line === "## Live Status";
      inShadowSummary = line === "## Shadow Summary";
      continue;
    }
    if (!line.startsWith("|")) continue;
    if (line.includes("---")) continue;

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length < 2) continue;

    if (inLiveStatus && cells[0] !== "Item") {
      liveStatusRows.set(cells[0], cells[1]);
    }

    if (inShadowSummary && cells[0] !== "Metric") {
      const key = DOC_SUMMARY_LABEL_TO_KEY[cells[0] as keyof typeof DOC_SUMMARY_LABEL_TO_KEY];
      if (!key) {
        unsupportedSummaryLabels.push({ label: cells[0], value: parseDocNumericValue(cells[1]) });
        continue;
      }
      const value = parseDocNumericValue(cells[1]);
      if (value !== null) summary[key] = value;
    }
  }

  return {
    sourcePath,
    liveComparisonStatus: parseLiveComparisonStatus(
      liveStatusRows.get("Live snapshot comparison") ?? null,
    ),
    reason: liveStatusRows.get("Reason") ?? null,
    fallback: liveStatusRows.get("Fallback") ?? null,
    productionBehaviorChanged: parseProductionBehaviorChanged(
      liveStatusRows.get("Production behavior changed") ?? null,
    ),
    summary,
    unsupportedSummaryLabels,
  };
}

function shadowRowExample(row: ShadowComparisonRow): ShadowRowExample {
  return {
    creativeId: row.creativeId,
    beforePrimaryDecision: row.beforePrimaryDecision,
    beforeOperatorBucket: row.beforeOperatorBucket,
    afterBuyerAction: row.afterBuyerAction,
    afterConfidenceBand: row.afterConfidenceBand,
    missingData: row.missingData,
  };
}

function hasAnyBeforeValue(row: ShadowComparisonRow, values: Set<string>): boolean {
  return values.has(row.beforePrimaryDecision) || values.has(row.beforeOperatorBucket);
}

function buildCheckResult(
  name: string,
  rows: ShadowComparisonRow[],
  predicate: (row: ShadowComparisonRow) => boolean,
): ShadowCheckResult {
  const matches = rows.filter(predicate);

  return {
    name,
    count: matches.length,
    examples: matches.slice(0, 5).map(shadowRowExample),
  };
}

function buildSummaryParity(
  artifact: NormalizedShadowComparisonArtifact,
  reportDoc: ParsedShadowReportDoc | null,
): ShadowReportProbeReport["summaryParity"] {
  if (reportDoc === null) {
    return {
      docsMatchArtifact: null,
      differences: [],
      unsupportedDocSummaryLabels: [],
      nonZeroUnsupportedDocSummaryLabels: [],
    };
  }

  const differences: ShadowParityDifference[] = [];
  for (const key of REQUIRED_SUMMARY_KEYS) {
    const docValue = reportDoc.summary[key] ?? null;
    const artifactValue = artifact.summary[key];
    if (docValue === null) continue;
    if (artifactValue === null || Math.abs(artifactValue - docValue) > 0.001) {
      differences.push({ key, artifact: artifactValue, reportDoc: docValue });
    }
  }

  return {
    docsMatchArtifact: differences.length === 0,
    differences,
    unsupportedDocSummaryLabels: reportDoc.unsupportedSummaryLabels.map((entry) => entry.label),
    nonZeroUnsupportedDocSummaryLabels: reportDoc.unsupportedSummaryLabels.filter(
      (entry) => entry.value !== null && entry.value !== 0,
    ),
  };
}

export function buildShadowReportProbeReport(
  artifact: NormalizedShadowComparisonArtifact,
  reportDoc: ParsedShadowReportDoc | null = null,
): ShadowReportProbeReport {
  const dangerousConflicts = [
    buildCheckResult(
      "before_scale_or_protect_after_cut",
      artifact.rows,
      (row) => hasAnyBeforeValue(row, BEFORE_SCALE_OR_PROTECT_VALUES) && row.afterBuyerAction === "cut",
    ),
    buildCheckResult(
      "before_cut_or_kill_after_scale",
      artifact.rows,
      (row) => hasAnyBeforeValue(row, BEFORE_CUT_OR_KILL_VALUES) && row.afterBuyerAction === "scale",
    ),
  ];
  const invariantViolations = [
    buildCheckResult(
      "row_level_brief_variation",
      artifact.rows,
      (row) => row.afterBuyerAction === "brief_variation",
    ),
    buildCheckResult(
      "high_confidence_with_missing_data",
      artifact.rows,
      (row) => row.afterConfidenceBand === "high" && row.missingData.length > 0,
    ),
  ];
  const artifactSummary = Object.fromEntries(
    REQUIRED_SUMMARY_KEYS.map((key) => [key, artifact.summary[key]]),
  ) as Record<ShadowSummaryKey, number | null>;

  const summaryParity = buildSummaryParity(artifact, reportDoc);
  const notes = [
    "Probe reads existing shadow artifacts only.",
    "Probe does not compute adapter output, update generated files, or import runtime decision code.",
  ];
  if (summaryParity.unsupportedDocSummaryLabels.length > 0) {
    notes.push(
      `Report doc has summary labels that the artifact schema does not represent: ${summaryParity.unsupportedDocSummaryLabels.join(", ")}`,
    );
  }

  return {
    contractVersion: "creative-decision-center.v2.1.shadow-report.probe.v1",
    sourceArtifact: {
      path: artifact.sourcePath,
      readOnly: true,
      rowCount: artifact.rows.length,
      summaryTotal: artifact.summary.totalCreativesCompared,
    },
    sourceReportDoc: {
      path: reportDoc?.sourcePath ?? null,
      readOnly: true,
      parsed: reportDoc !== null,
    },
    readOnly: true,
    mutatesData: false,
    liveComparison: {
      status: reportDoc?.liveComparisonStatus ?? "fixture_only",
      productionBehaviorChanged: reportDoc?.productionBehaviorChanged ?? null,
      reason: reportDoc?.reason ?? null,
      fallback: reportDoc?.fallback ?? null,
    },
    summary: {
      artifact: artifactSummary,
      rowCountMatchesSummary: artifact.summary.totalCreativesCompared === artifact.rows.length,
      top10DisagreementCount: artifact.summary.top10Disagreements.length,
    },
    summaryParity,
    dangerousConflicts,
    invariantViolations,
    artifactContract: {
      missingSummaryKeys: artifact.missingSummaryKeys,
      missingRowFieldCounts: artifact.missingRowFieldCounts,
    },
    notes,
  };
}

export function validateShadowReportProbeReport(report: ShadowReportProbeReport): string[] {
  const failures: string[] = [];
  if (report.readOnly !== true) failures.push("probe_not_read_only");
  if (report.mutatesData !== false) failures.push("probe_mutates_data");
  if (report.sourceArtifact.rowCount !== report.sourceArtifact.summaryTotal) {
    failures.push("row_count_summary_mismatch");
  }
  if (!["not_run", "fixture_only"].includes(report.liveComparison.status)) {
    failures.push(`live_comparison_status_not_fixture:${report.liveComparison.status}`);
  }
  if (report.liveComparison.productionBehaviorChanged === true) {
    failures.push("production_behavior_changed");
  }
  if (report.summaryParity.docsMatchArtifact === false) {
    failures.push("doc_summary_artifact_mismatch");
  }
  for (const entry of report.summaryParity.nonZeroUnsupportedDocSummaryLabels) {
    failures.push(`non_zero_unsupported_doc_summary_label:${entry.label}:${entry.value}`);
  }

  for (const key of report.artifactContract.missingSummaryKeys) {
    failures.push(`missing_summary_key:${key}`);
  }
  for (const [field, count] of Object.entries(report.artifactContract.missingRowFieldCounts)) {
    if (count > 0) failures.push(`missing_row_field:${field}:${count}`);
  }
  for (const check of [...report.dangerousConflicts, ...report.invariantViolations]) {
    if (check.count > 0) failures.push(`${check.name}:${check.count}`);
  }

  return failures;
}

export function loadShadowComparisonArtifact(
  sourcePath = DEFAULT_SHADOW_ARTIFACT_SOURCE,
): NormalizedShadowComparisonArtifact {
  const absoluteSourcePath = resolve(sourcePath);
  return normalizeShadowComparisonArtifact(
    JSON.parse(readFileSync(absoluteSourcePath, "utf8")) as unknown,
    sourcePath,
  );
}

export function loadShadowReportDoc(
  sourcePath = DEFAULT_SHADOW_REPORT_DOC_SOURCE,
): ParsedShadowReportDoc {
  const absoluteSourcePath = resolve(sourcePath);
  return parseShadowReportDoc(readFileSync(absoluteSourcePath, "utf8"), sourcePath);
}

function parseArgs(argv: string[]): ParsedShadowReportProbeArgs {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value =
      argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : "true";
    args.set(key, value);
    if (value !== "true") index += 1;
  }

  if (args.has("help")) {
    throw new Error(
      "usage: node --import tsx scripts/creative-decision-center/shadow-report-probe.ts [--source <path>] [--doc <path>] [--no-doc] [--pretty] [--strict]",
    );
  }

  return {
    sourcePath: args.get("source") ?? DEFAULT_SHADOW_ARTIFACT_SOURCE,
    docPath: args.has("no-doc")
      ? null
      : args.get("doc") ?? DEFAULT_SHADOW_REPORT_DOC_SOURCE,
    pretty: args.get("pretty") === "true",
    strict: args.get("strict") === "true",
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const artifact = loadShadowComparisonArtifact(parsed.sourcePath);
  const reportDoc = parsed.docPath ? loadShadowReportDoc(parsed.docPath) : null;
  const report = buildShadowReportProbeReport(artifact, reportDoc);
  const strictFailures = validateShadowReportProbeReport(report);

  console.log(JSON.stringify(report, null, parsed.pretty ? 2 : 0));
  if (parsed.strict && strictFailures.length > 0) {
    console.error(JSON.stringify({ strictFailures }, null, 2));
    process.exit(1);
  }
}

if (process.argv[1]) {
  const entryHref = pathToFileURL(resolve(process.argv[1])).href;
  if (import.meta.url === entryHref) {
    main().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
