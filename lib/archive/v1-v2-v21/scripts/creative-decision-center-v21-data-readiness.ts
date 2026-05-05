import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES } from "./creative-decision-center-v21-golden-fixtures";

export const CREATIVE_DECISION_CENTER_V21_GENERATED_DIR =
  "docs/creative-decision-center/generated";

export const CREATIVE_DECISION_CENTER_V21_REQUIRED_FIELDS = [
  "spend",
  "purchases",
  "impressions",
  "roas",
  "cpa",
  "ctr",
  "cpm",
  "frequency",
  "firstSeenAt",
  "firstSpendAt",
  "reviewStatus",
  "effectiveStatus",
  "disapprovalReason",
  "limitedReason",
  "spend24h",
  "impressions24h",
  "campaignStatus",
  "adsetStatus",
  "adStatus",
  "benchmarkReliability",
  "targetSource",
  "dataFreshness",
] as const;

export type CreativeDecisionCenterV21ReadinessField =
  (typeof CREATIVE_DECISION_CENTER_V21_REQUIRED_FIELDS)[number];

export interface CreativeDecisionCenterV21LiveStatus {
  attempted: boolean;
  source: "fixture" | "database";
  readOnly: true;
  reason: string;
  missingEnv: string[];
  generatedAt: string;
  snapshotId: string | null;
  rowCount: number;
}

export interface CreativeDecisionCenterV21CoverageField {
  field: CreativeDecisionCenterV21ReadinessField;
  presentRows: number;
  totalRows: number;
  coveragePct: number;
  status: "ready" | "partial" | "missing";
}

export interface CreativeDecisionCenterV21DataReadinessReport {
  contractVersion: "creative-decision-center.v2.1.data-readiness.v0";
  generatedAt: string;
  source: CreativeDecisionCenterV21LiveStatus["source"];
  readOnly: true;
  liveStatus: CreativeDecisionCenterV21LiveStatus;
  coverage: CreativeDecisionCenterV21CoverageField[];
  blockers: string[];
  notes: string[];
}

type UnknownRow = Record<string, unknown>;

interface SnapshotRow {
  id?: string | null;
  generated_at?: string | Date | null;
  payload?: unknown;
}

function hasValue(value: unknown) {
  return value !== null && value !== undefined && value !== "";
}

function asRecord(value: unknown): UnknownRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRow)
    : {};
}

function rowsFromPayload(payload: unknown): UnknownRow[] {
  const record = asRecord(payload);
  const creatives = record.creatives;
  return Array.isArray(creatives) ? creatives.map(asRecord) : [];
}

function fixtureRows(): UnknownRow[] {
  return CREATIVE_DECISION_CENTER_V21_GOLDEN_CASES.map((item) => {
    const row: UnknownRow = {
      spend: 100,
      purchases: item.expectedMaturity === "too_early" ? 0 : 2,
      impressions: 5000,
      roas: 1.5,
      cpa: 50,
      campaignStatus: item.caseId === "GC-002" ? "PAUSED" : "ACTIVE",
      adsetStatus: item.caseId === "GC-003" ? "PAUSED" : "ACTIVE",
      benchmarkReliability: "medium",
      targetSource: "fixture",
      dataFreshness: "fixture",
    };

    if (
      [
        "GC-012",
        "GC-013",
        "GC-014",
        "GC-015",
        "GC-028",
        "GC-035",
      ].includes(item.caseId)
    ) {
      row.ctr = 1.2;
      row.cpm = 12;
      row.frequency = 2.4;
    }
    if (item.expectedBuyerAction === "fix_delivery") {
      row.adStatus = "ACTIVE";
      row.spend24h = 0;
      row.impressions24h = 0;
    }
    if (item.expectedBuyerAction === "fix_policy") {
      row.reviewStatus = "DISAPPROVED";
      row.effectiveStatus = "DISAPPROVED";
      row.disapprovalReason = "fixture_policy_reason";
      row.limitedReason = "fixture_limited_reason";
    }
    if (item.expectedBuyerAction === "watch_launch") {
      row.firstSeenAt = "2026-04-30T00:00:00.000Z";
      row.firstSpendAt = "2026-04-30T01:00:00.000Z";
    }
    if (["GC-016", "GC-017"].includes(item.caseId)) {
      delete row.benchmarkReliability;
      delete row.targetSource;
    }
    if (["GC-018"].includes(item.caseId)) {
      delete row.dataFreshness;
    }

    return row;
  });
}

function fieldValue(row: UnknownRow, field: CreativeDecisionCenterV21ReadinessField) {
  switch (field) {
    case "benchmarkReliability":
      return asRecord(row.benchmark).reliability ?? row.benchmarkReliability;
    case "targetSource":
      return asRecord(row.economics).targetSource ?? row.targetSource;
    case "dataFreshness":
      return asRecord(row.trust).freshness ?? row.dataFreshness;
    case "adStatus":
      return row.adStatus ?? row.effectiveStatus;
    default:
      return row[field];
  }
}

export function buildCreativeDecisionCenterV21Coverage(
  rows: UnknownRow[],
): CreativeDecisionCenterV21CoverageField[] {
  return CREATIVE_DECISION_CENTER_V21_REQUIRED_FIELDS.map((field) => {
    const presentRows = rows.filter((row) => hasValue(fieldValue(row, field))).length;
    const coveragePct =
      rows.length === 0 ? 0 : Number(((presentRows / rows.length) * 100).toFixed(2));
    return {
      field,
      presentRows,
      totalRows: rows.length,
      coveragePct,
      status:
        presentRows === rows.length && rows.length > 0
          ? "ready"
          : presentRows > 0
            ? "partial"
            : "missing",
    };
  });
}

function coverageStatus(
  coverage: CreativeDecisionCenterV21CoverageField[],
  field: CreativeDecisionCenterV21ReadinessField,
) {
  return coverage.find((item) => item.field === field)?.status ?? "missing";
}

export function buildCreativeDecisionCenterV21Blockers(
  coverage: CreativeDecisionCenterV21CoverageField[],
) {
  const blockers: string[] = [];
  const deliveryFields: CreativeDecisionCenterV21ReadinessField[] = [
    "adStatus",
    "campaignStatus",
    "adsetStatus",
    "spend24h",
    "impressions24h",
  ];
  const policyFields: CreativeDecisionCenterV21ReadinessField[] = [
    "reviewStatus",
    "effectiveStatus",
    "disapprovalReason",
    "limitedReason",
  ];
  const launchFields: CreativeDecisionCenterV21ReadinessField[] = [
    "firstSeenAt",
    "firstSpendAt",
  ];
  const fatigueFields: CreativeDecisionCenterV21ReadinessField[] = [
    "ctr",
    "cpm",
    "frequency",
  ];

  if (deliveryFields.some((field) => coverageStatus(coverage, field) !== "ready")) {
    blockers.push("fix_delivery requires active status plus spend24h/impressions24h proof");
  }
  if (policyFields.some((field) => coverageStatus(coverage, field) !== "ready")) {
    blockers.push("fix_policy requires review/effective status and policy reason proof");
  }
  if (launchFields.some((field) => coverageStatus(coverage, field) !== "ready")) {
    blockers.push("watch_launch requires firstSeenAt/firstSpendAt launch basis");
  }
  if (fatigueFields.some((field) => coverageStatus(coverage, field) !== "ready")) {
    blockers.push("high-confidence fatigue requires CTR/CPM/frequency coverage");
  }
  if (coverageStatus(coverage, "dataFreshness") !== "ready") {
    blockers.push("high-confidence scale/cut requires explicit data freshness");
  }
  if (coverageStatus(coverage, "targetSource") !== "ready") {
    blockers.push("high-confidence scale/cut requires target or benchmark source");
  }

  return blockers;
}

export function buildCreativeDecisionCenterV21DataReadinessReport(input: {
  generatedAt?: string;
  source: CreativeDecisionCenterV21LiveStatus["source"];
  liveStatus: Omit<CreativeDecisionCenterV21LiveStatus, "generatedAt" | "rowCount">;
  rows: UnknownRow[];
}): CreativeDecisionCenterV21DataReadinessReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const coverage = buildCreativeDecisionCenterV21Coverage(input.rows);
  return {
    contractVersion: "creative-decision-center.v2.1.data-readiness.v0",
    generatedAt,
    source: input.source,
    readOnly: true,
    liveStatus: {
      ...input.liveStatus,
      generatedAt,
      rowCount: input.rows.length,
    },
    coverage,
    blockers: buildCreativeDecisionCenterV21Blockers(coverage),
    notes: [
      "This report is read-only planning evidence.",
      "It does not prove production behavior and does not mutate DB/API data.",
    ],
  };
}

async function readLatestSnapshotRows(): Promise<{
  snapshotId: string | null;
  rows: UnknownRow[];
}> {
  const { getDb } = await import("@/lib/db");
  const sql = getDb();
  const rows = (await sql`
    SELECT id, generated_at, payload
    FROM creative_decision_os_snapshots
    WHERE surface = 'creative'
    ORDER BY generated_at DESC
    LIMIT 1
  `) as SnapshotRow[];
  const snapshot = rows[0] ?? null;
  return {
    snapshotId: snapshot?.id ?? null,
    rows: rowsFromPayload(snapshot?.payload),
  };
}

export async function runCreativeDecisionCenterV21DataReadiness(input: {
  outputDir?: string;
  now?: string;
} = {}) {
  const outputDir =
    input.outputDir ?? CREATIVE_DECISION_CENTER_V21_GENERATED_DIR;
  const databaseUrl = process.env.DATABASE_URL?.trim();

  let report: CreativeDecisionCenterV21DataReadinessReport;
  if (!databaseUrl) {
    report = buildCreativeDecisionCenterV21DataReadinessReport({
      generatedAt: input.now,
      source: "fixture",
      liveStatus: {
        attempted: false,
        source: "fixture",
        readOnly: true,
        reason: "DATABASE_URL is not set; no live DB/snapshot read was attempted.",
        missingEnv: ["DATABASE_URL"],
        snapshotId: null,
      },
      rows: fixtureRows(),
    });
  } else {
    const latest = await readLatestSnapshotRows();
    report = buildCreativeDecisionCenterV21DataReadinessReport({
      generatedAt: input.now,
      source: "database",
      liveStatus: {
        attempted: true,
        source: "database",
        readOnly: true,
        reason: latest.snapshotId
          ? "Read latest creative decision snapshot with a SELECT-only query."
          : "DATABASE_URL is set, but no creative snapshot row was found.",
        missingEnv: [],
        snapshotId: latest.snapshotId,
      },
      rows: latest.rows,
    });
  }

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, "live-status.json"),
    `${JSON.stringify(report.liveStatus, null, 2)}\n`,
  );
  writeFileSync(
    join(outputDir, "data-readiness-coverage.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCreativeDecisionCenterV21DataReadiness().then((report) => {
    console.log(JSON.stringify(report.liveStatus, null, 2));
  });
}
