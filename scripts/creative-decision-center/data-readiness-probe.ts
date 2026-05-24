import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_DATA_READINESS_SOURCE =
  "docs/creative-decision-center/generated/data-readiness-coverage.json";

const FIELD_STATUSES = ["ready", "partial", "missing"] as const;
const KNOWN_COVERAGE_FIELDS = [
  "adStatus",
  "adsetStatus",
  "benchmarkReliability",
  "campaignStatus",
  "cpa",
  "cpm",
  "ctr",
  "dataFreshness",
  "disapprovalReason",
  "effectiveStatus",
  "firstSeenAt",
  "firstSpendAt",
  "frequency",
  "impressions",
  "impressions24h",
  "limitedReason",
  "purchases",
  "reviewStatus",
  "roas",
  "spend",
  "spend24h",
  "targetSource",
] as const;

export type FieldCoverageStatus = (typeof FIELD_STATUSES)[number];

export type DataReadinessStatus = "ready" | "blocked" | "confidence_capped";

export type LiveEvidenceStatus = "live_read" | "fixture_only" | "not_attempted" | "unknown";

export interface FieldCoverage {
  field: string;
  presentRows: number;
  totalRows: number;
  coveragePct: number;
  status: FieldCoverageStatus;
  sourceHasField: boolean;
}

export interface NormalizedDataReadinessArtifact {
  contractVersion: string;
  generatedAt: string | null;
  source: string;
  readOnly: boolean;
  sourcePath: string;
  totalRows: number;
  liveStatus: {
    attempted: boolean | null;
    source: string | null;
    readOnly: boolean | null;
    reason: string | null;
    missingEnv: string[];
    snapshotId: string | null;
    generatedAt: string | null;
    rowCount: number | null;
  };
  coverageByField: Map<string, FieldCoverage>;
  unknownCoverageFields: string[];
  artifactBlockers: string[];
  notes: string[];
}

export interface DataReadinessActionRequirement {
  action: string;
  description: string;
  requiredFields: readonly string[];
  notReadyStatus: Exclude<DataReadinessStatus, "ready">;
}

export interface ActionReadinessResult {
  action: string;
  description: string;
  requiredFields: string[];
  readyFields: string[];
  partialFields: string[];
  missingFields: string[];
  fieldsMissingFromArtifact: string[];
  readinessStatus: DataReadinessStatus;
  coverageComplete: boolean;
  reason: string;
  fieldCoverage: FieldCoverage[];
}

export interface DataReadinessProbeReport {
  contractVersion: "creative-decision-center.v2.1.data-readiness.probe.v1";
  sourceArtifact: {
    path: string;
    contractVersion: string;
    source: string;
    generatedAt: string | null;
    readOnly: boolean;
  };
  readOnly: true;
  mutatesData: false;
  liveEvidence: {
    status: LiveEvidenceStatus;
    attempted: boolean | null;
    source: string | null;
    reason: string | null;
    missingEnv: string[];
    snapshotId: string | null;
    rowCount: number | null;
  };
  summary: {
    totalRows: number;
    requiredFieldCount: number;
    readyFieldCount: number;
    partialFieldCount: number;
    missingFieldCount: number;
    fieldsMissingFromArtifactCount: number;
    unknownCoverageFieldCount: number;
    readyActionCount: number;
    blockedActionCount: number;
    confidenceCappedActionCount: number;
  };
  fields: FieldCoverage[];
  unknownCoverageFields: string[];
  actions: ActionReadinessResult[];
  blockers: string[];
  notes: string[];
}

export interface ParsedDataReadinessProbeArgs {
  sourcePath: string;
  pretty: boolean;
  strict: boolean;
}

export const DATA_READINESS_ACTION_REQUIREMENTS = [
  {
    action: "fix_delivery",
    description: "Active hierarchy plus 24h no-spend/no-impression proof.",
    requiredFields: [
      "campaignStatus",
      "adsetStatus",
      "adStatus",
      "spend24h",
      "impressions24h",
    ],
    notReadyStatus: "blocked",
  },
  {
    action: "fix_policy",
    description: "Review/effective status plus disapproval or limited-delivery reason proof.",
    requiredFields: [
      "reviewStatus",
      "effectiveStatus",
      "disapprovalReason",
      "limitedReason",
    ],
    notReadyStatus: "blocked",
  },
  {
    action: "watch_launch",
    description: "Launch basis from first seen/spend timestamps.",
    requiredFields: ["firstSeenAt", "firstSpendAt"],
    notReadyStatus: "blocked",
  },
  {
    action: "high_confidence_fatigue",
    description: "CTR, CPM, and frequency trend coverage for fatigue claims.",
    requiredFields: ["ctr", "cpm", "frequency"],
    notReadyStatus: "confidence_capped",
  },
  {
    action: "high_confidence_scale_cut",
    description: "Fresh data plus explicit target or benchmark source for hard scale/cut.",
    requiredFields: ["dataFreshness", "targetSource", "benchmarkReliability"],
    notReadyStatus: "confidence_capped",
  },
] as const satisfies readonly DataReadinessActionRequirement[];

export const REQUIRED_DATA_READINESS_FIELDS = Array.from(
  new Set(DATA_READINESS_ACTION_REQUIREMENTS.flatMap((entry) => entry.requiredFields)),
).sort();

const KNOWN_COVERAGE_FIELD_SET = new Set<string>(KNOWN_COVERAGE_FIELDS);

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

function normalizeStatus(input: unknown, presentRows: number, totalRows: number): FieldCoverageStatus {
  if (typeof input === "string" && FIELD_STATUSES.includes(input as FieldCoverageStatus)) {
    return input as FieldCoverageStatus;
  }
  if (presentRows <= 0) return "missing";
  if (totalRows > 0 && presentRows >= totalRows) return "ready";
  return "partial";
}

function normalizeFieldCoverage(
  field: string,
  value: Record<string, unknown> | null,
  fallbackTotalRows: number,
): FieldCoverage {
  const presentRows = optionalNumber(value?.presentRows) ?? 0;
  const totalRows = optionalNumber(value?.totalRows) ?? fallbackTotalRows;
  const coveragePct =
    optionalNumber(value?.coveragePct) ??
    (totalRows > 0 ? Math.round((presentRows / totalRows) * 10_000) / 100 : 0);

  return {
    field,
    presentRows,
    totalRows,
    coveragePct,
    status: normalizeStatus(value?.status, presentRows, totalRows),
    sourceHasField: value !== null,
  };
}

function classifyLiveEvidence(
  liveStatus: NormalizedDataReadinessArtifact["liveStatus"],
): LiveEvidenceStatus {
  if (liveStatus.attempted === true) return "live_read";
  if (liveStatus.attempted === false && liveStatus.source === "fixture") return "fixture_only";
  if (liveStatus.attempted === false) return "not_attempted";
  return "unknown";
}

export function normalizeCoverageArtifact(
  input: unknown,
  sourcePath = DEFAULT_DATA_READINESS_SOURCE,
): NormalizedDataReadinessArtifact {
  if (!isObject(input)) {
    throw new Error("Data readiness artifact must be a JSON object.");
  }

  const liveStatusRaw = isObject(input.liveStatus) ? input.liveStatus : {};
  const rawCoverage = Array.isArray(input.coverage) ? input.coverage : [];
  const rowCount = optionalNumber(liveStatusRaw.rowCount);
  const inferredTotalRows =
    rowCount ??
    rawCoverage.reduce((maxRows, entry) => {
      if (!isObject(entry)) return maxRows;
      return Math.max(maxRows, optionalNumber(entry.totalRows) ?? 0);
    }, 0);

  const coverageByField = new Map<string, FieldCoverage>();
  for (const entry of rawCoverage) {
    if (!isObject(entry) || typeof entry.field !== "string") continue;
    coverageByField.set(
      entry.field,
      normalizeFieldCoverage(entry.field, entry, inferredTotalRows),
    );
  }
  const unknownCoverageFields = Array.from(coverageByField.keys())
    .filter((field) => !KNOWN_COVERAGE_FIELD_SET.has(field))
    .sort();

  for (const field of REQUIRED_DATA_READINESS_FIELDS) {
    if (!coverageByField.has(field)) {
      coverageByField.set(field, normalizeFieldCoverage(field, null, inferredTotalRows));
    }
  }

  return {
    contractVersion: optionalString(input.contractVersion) ?? "unknown",
    generatedAt: optionalString(input.generatedAt),
    source: optionalString(input.source) ?? "unknown",
    readOnly: input.readOnly === true,
    sourcePath,
    totalRows: inferredTotalRows,
    liveStatus: {
      attempted: optionalBoolean(liveStatusRaw.attempted),
      source: optionalString(liveStatusRaw.source),
      readOnly: optionalBoolean(liveStatusRaw.readOnly),
      reason: optionalString(liveStatusRaw.reason),
      missingEnv: stringArray(liveStatusRaw.missingEnv),
      snapshotId: optionalString(liveStatusRaw.snapshotId),
      generatedAt: optionalString(liveStatusRaw.generatedAt),
      rowCount,
    },
    coverageByField,
    unknownCoverageFields,
    artifactBlockers: stringArray(input.blockers),
    notes: stringArray(input.notes),
  };
}

export function evaluateActionReadiness(
  artifact: NormalizedDataReadinessArtifact,
  requirement: DataReadinessActionRequirement,
): ActionReadinessResult {
  const fieldCoverage = requirement.requiredFields.map((field) => {
    return (
      artifact.coverageByField.get(field) ??
      normalizeFieldCoverage(field, null, artifact.totalRows)
    );
  });
  const readyFields = fieldCoverage
    .filter((entry) => entry.status === "ready")
    .map((entry) => entry.field);
  const partialFields = fieldCoverage
    .filter((entry) => entry.status === "partial")
    .map((entry) => entry.field);
  const missingFields = fieldCoverage
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.field);
  const fieldsMissingFromArtifact = fieldCoverage
    .filter((entry) => !entry.sourceHasField)
    .map((entry) => entry.field);
  const isReady = fieldCoverage.every((entry) => entry.status === "ready");
  const readinessStatus = isReady ? "ready" : requirement.notReadyStatus;
  const reason = isReady
    ? "all_required_fields_ready"
    : [
        partialFields.length > 0 ? `partial:${partialFields.join(",")}` : null,
        missingFields.length > 0 ? `missing:${missingFields.join(",")}` : null,
        fieldsMissingFromArtifact.length > 0
          ? `absent_from_artifact:${fieldsMissingFromArtifact.join(",")}`
          : null,
      ]
        .filter((entry): entry is string => entry !== null)
        .join("; ");

  return {
    action: requirement.action,
    description: requirement.description,
    requiredFields: [...requirement.requiredFields],
    readyFields,
    partialFields,
    missingFields,
    fieldsMissingFromArtifact,
    readinessStatus,
    coverageComplete: readinessStatus === "ready",
    reason,
    fieldCoverage,
  };
}

export function buildDataReadinessProbeReport(
  artifact: NormalizedDataReadinessArtifact,
): DataReadinessProbeReport {
  const actions = DATA_READINESS_ACTION_REQUIREMENTS.map((requirement) =>
    evaluateActionReadiness(artifact, requirement),
  );
  const fields = REQUIRED_DATA_READINESS_FIELDS.map((field) => {
    return artifact.coverageByField.get(field) ?? normalizeFieldCoverage(field, null, artifact.totalRows);
  });
  const blockers = actions
    .filter((entry) => entry.readinessStatus !== "ready")
    .map((entry) => `${entry.action}: ${entry.reason}`);

  return {
    contractVersion: "creative-decision-center.v2.1.data-readiness.probe.v1",
    sourceArtifact: {
      path: artifact.sourcePath,
      contractVersion: artifact.contractVersion,
      source: artifact.source,
      generatedAt: artifact.generatedAt,
      readOnly: artifact.readOnly,
    },
    readOnly: true,
    mutatesData: false,
    liveEvidence: {
      status: classifyLiveEvidence(artifact.liveStatus),
      attempted: artifact.liveStatus.attempted,
      source: artifact.liveStatus.source,
      reason: artifact.liveStatus.reason,
      missingEnv: artifact.liveStatus.missingEnv,
      snapshotId: artifact.liveStatus.snapshotId,
      rowCount: artifact.liveStatus.rowCount,
    },
    summary: {
      totalRows: artifact.totalRows,
      requiredFieldCount: fields.length,
      readyFieldCount: fields.filter((entry) => entry.status === "ready").length,
      partialFieldCount: fields.filter((entry) => entry.status === "partial").length,
      missingFieldCount: fields.filter((entry) => entry.status === "missing").length,
      fieldsMissingFromArtifactCount: fields.filter((entry) => !entry.sourceHasField).length,
      unknownCoverageFieldCount: artifact.unknownCoverageFields.length,
      readyActionCount: actions.filter((entry) => entry.readinessStatus === "ready").length,
      blockedActionCount: actions.filter((entry) => entry.readinessStatus === "blocked").length,
      confidenceCappedActionCount: actions.filter(
        (entry) => entry.readinessStatus === "confidence_capped",
      ).length,
    },
    fields,
    unknownCoverageFields: artifact.unknownCoverageFields,
    actions,
    blockers,
    notes: [
      ...artifact.notes,
      "Probe is read-only planning evidence and does not emit production decisions.",
      ...artifact.artifactBlockers.map((entry) => `source_artifact_blocker: ${entry}`),
    ],
  };
}

export function validateDataReadinessProbeReport(report: DataReadinessProbeReport): string[] {
  const failures: string[] = [];
  if (report.readOnly !== true) failures.push("probe_not_read_only");
  if (report.mutatesData !== false) failures.push("probe_mutates_data");
  if (!report.sourceArtifact.readOnly) failures.push("source_artifact_not_read_only");
  if (report.liveEvidence.status === "unknown") failures.push("live_evidence_status_unknown");

  for (const field of report.fields) {
    if (!field.sourceHasField) {
      failures.push(`critical_field_absent_from_artifact:${field.field}`);
    }
  }
  for (const field of report.unknownCoverageFields) {
    failures.push(`unknown_coverage_field:${field}`);
  }

  for (const action of report.actions) {
    if (action.requiredFields.length === 0) {
      failures.push(`action_without_required_fields:${action.action}`);
    }
  }

  return failures;
}

export function loadDataReadinessCoverageArtifact(
  sourcePath = DEFAULT_DATA_READINESS_SOURCE,
): NormalizedDataReadinessArtifact {
  const absoluteSourcePath = resolve(sourcePath);
  return normalizeCoverageArtifact(
    JSON.parse(readFileSync(absoluteSourcePath, "utf8")) as unknown,
    sourcePath,
  );
}

function parseArgs(argv: string[]): ParsedDataReadinessProbeArgs {
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
      "usage: node --import tsx scripts/creative-decision-center/data-readiness-probe.ts [--source <path>] [--pretty] [--strict]",
    );
  }

  return {
    sourcePath: args.get("source") ?? DEFAULT_DATA_READINESS_SOURCE,
    pretty: args.get("pretty") === "true",
    strict: args.get("strict") === "true",
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const artifact = loadDataReadinessCoverageArtifact(parsed.sourcePath);
  const report = buildDataReadinessProbeReport(artifact);
  const strictFailures = validateDataReadinessProbeReport(report);

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
