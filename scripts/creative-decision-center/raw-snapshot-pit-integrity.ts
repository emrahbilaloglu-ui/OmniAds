#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACT_VERSION = "adsecute.meta.raw-snapshot-pit-integrity.v1" as const;
const MANIFEST_VERSION = "adsecute.meta.raw-snapshot-pit-manifest.v1" as const;
const ENDPOINT_NAME = "ad_insights_bulk" as const;
const QUERY_TIMEOUT_MS = 60_000;

export type GateStatus = "pass" | "fail" | "unknown";

export interface ParsedPitIntegrityArgs {
  decisionDate: string;
  cutoff: string;
  businessId: string | null;
  providerAccountId: string | null;
  jsonOut: string | null;
}

export interface PitRawSnapshotRow {
  id: string;
  businessId: string;
  providerAccountId: string;
  partitionId: string | null;
  checkpointId: string | null;
  runId: string | null;
  endpointName: string;
  entityScope: string;
  pageIndex: number | null;
  providerCursor: string | null;
  startDate: string;
  endDate: string;
  accountTimezone: string | null;
  accountCurrency: string | null;
  payloadJson: unknown;
  payloadHash: string;
  providerHttpStatus: number | null;
  status: string;
  fetchedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface SnapshotValidation {
  row: PitRawSnapshotRow;
  atOrBeforeCutoff: boolean;
  postCutoff: boolean;
  failures: string[];
  generationKey: string | null;
  scopeKey: string;
  observedAt: string | null;
}

interface EvidenceRow {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string | null;
  accountCurrency: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  creativeId: string | null;
  source: {
    snapshotId: string;
    partitionId: string;
    runId: string;
    pageIndex: number;
    payloadIndex: number;
    fetchedAt: string;
    createdAt: string;
  };
  payload: Record<string, unknown>;
}

interface GenerationSummary {
  generationKey: string;
  streamKey: string;
  segmentIndex: number;
  partitionId: string;
  runId: string;
  startDate: string;
  endDate: string;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  snapshotRows: number;
  payloadRows: number;
  pageIndices: number[];
  expectedPageIndices: number[];
  terminalPageCount: number;
  terminalPageIndex: number | null;
  rowValidationFailures: Array<{
    snapshotId: string;
    failures: string[];
  }>;
  exactDuplicatePageRows: number;
  conflictingPageIndices: number[];
  exactDuplicateAdRows: number;
  conflictingAdIds: string[];
  hierarchyConflictAdIds: string[];
  structurallyComplete: boolean;
  conflictFree: boolean;
  reconstructable: boolean;
  snapshotIds: string[];
  evidence: EvidenceRow[];
}

interface CoverageDimension {
  field: "ad_id" | "adset_id" | "campaign_id" | "creative_id";
  requiredForAdGrain: boolean;
  endpointContractProvidesField: boolean;
  presentRows: number;
  totalRows: number;
  coveragePct: number | null;
  status: GateStatus;
}

interface ScopeReport {
  businessId: string;
  providerAccountId: string;
  decisionDate: string;
  observedSnapshotRows: number;
  atCutoffSnapshotRows: number;
  exactDayAtCutoffSnapshotRows: number;
  spanningWindowSnapshotRowsObserved: number;
  postCutoffSnapshotRowsExcluded: number;
  unisolatedAtCutoffSnapshotRows: number;
  unisolatedCanSupersedeLatest: boolean;
  generationStatus: GateStatus;
  generationReason:
    | "latest_generation_complete"
    | "latest_generation_incomplete"
    | "no_exact_day_rows_at_cutoff"
    | "no_isolated_generation"
    | "unisolated_rows_may_be_latest";
  generations: Omit<GenerationSummary, "evidence">[];
  selectedGeneration: Omit<GenerationSummary, "evidence"> | null;
  identityCoverage: {
    status: GateStatus;
    dimensions: CoverageDimension[];
  };
  evidence: EvidenceRow[];
}

export interface PitIntegrityReport {
  contractVersion: typeof CONTRACT_VERSION;
  generatedAt: string;
  readOnly: true;
  mutatesData: false;
  providerCalls: false;
  jobsRun: false;
  input: {
    decisionDate: string;
    cutoff: string;
    businessId: string | null;
    providerAccountId: string | null;
  };
  source: {
    table: "meta_raw_snapshots";
    endpointName: typeof ENDPOINT_NAME;
    transactionReadOnly: true;
    queryWindow: "source_window_contains_decision_date";
  };
  summary: {
    observedSnapshotRows: number;
    atCutoffSnapshotRows: number;
    exactDayAtCutoffSnapshotRows: number;
    spanningWindowSnapshotRowsObserved: number;
    eligibleSnapshotRows: number;
    postCutoffSnapshotRowsExcluded: number;
    scopeCount: number;
    reconstructedScopeCount: number;
    evidenceRows: number;
    rejectionCounts: Record<string, number>;
    generationReasonCounts: Record<string, number>;
  };
  gates: {
    postCutoffRows: {
      status: GateStatus;
      compensable: false;
      includedRows: number;
      observedExcludedRows: number;
      reason: string;
    };
    generationCompleteness: {
      status: GateStatus;
      compensable: false;
      completeScopes: number;
      failedScopes: number;
      unknownScopes: number;
      reason: string;
    };
    conflicts: {
      status: GateStatus;
      compensable: false;
      exactDuplicatePageRows: number;
      conflictingPageIndices: number;
      exactDuplicateAdRows: number;
      conflictingAdIds: number;
      hierarchyConflictAdIds: number;
      reason: string;
    };
    identityCoverage: {
      status: GateStatus;
      compensable: false;
      requiredFields: ["ad_id", "adset_id", "campaign_id"];
      creativeIdentityStatus: "unknown";
      reason: string;
    };
    manifestHash: {
      status: GateStatus;
      compensable: false;
      algorithm: "sha256";
      value: string | null;
      manifestVersion: typeof MANIFEST_VERSION;
      reason: string;
    };
  };
  overallStatus: GateStatus;
  reconstructionEligible: boolean;
  scopes: ScopeReport[];
  caveats: string[];
}

type DbSnapshotRow = {
  id: unknown;
  business_id: unknown;
  provider_account_id: unknown;
  partition_id: unknown;
  checkpoint_id: unknown;
  run_id: unknown;
  endpoint_name: unknown;
  entity_scope: unknown;
  page_index: unknown;
  provider_cursor: unknown;
  start_date: unknown;
  end_date: unknown;
  account_timezone: unknown;
  account_currency: unknown;
  payload_json: unknown;
  payload_hash: unknown;
  provider_http_status: unknown;
  status: unknown;
  fetched_at: unknown;
  created_at: unknown;
  updated_at: unknown;
};

function cliValue(argv: string[], name: string) {
  const prefix = `--${name}=`;
  return argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function assertDateOnly(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} is not a valid calendar date.`);
  }
  return value;
}

function assertTimestamp(value: string, field: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${field} must be a valid ISO timestamp.`);
  }
  return parsed.toISOString();
}

export function parsePitIntegrityArgs(argv: string[]): ParsedPitIntegrityArgs {
  const decisionDateRaw = cliValue(argv, "decisionDate");
  if (!decisionDateRaw) {
    throw new Error("--decisionDate=YYYY-MM-DD is required.");
  }
  const decisionDate = assertDateOnly(decisionDateRaw, "decisionDate");
  const cutoff = assertTimestamp(
    cliValue(argv, "cutoff") ?? `${decisionDate}T03:00:00.000Z`,
    "cutoff",
  );
  return {
    decisionDate,
    cutoff,
    businessId: cliValue(argv, "business"),
    providerAccountId: cliValue(argv, "account"),
    jsonOut: cliValue(argv, "jsonOut"),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

export function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

export function deterministicSha256(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const trimmed = value.trim();
  return trimmed || null;
}

function requiredText(value: unknown, field: string) {
  const text = optionalText(value);
  if (!text) throw new Error(`Database row is missing ${field}.`);
  return text;
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = requiredText(value, "source date");
  return text.slice(0, 10);
}

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function nullableInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePitSnapshotDbRow(row: DbSnapshotRow): PitRawSnapshotRow {
  return {
    id: requiredText(row.id, "id"),
    businessId: requiredText(row.business_id, "business_id"),
    providerAccountId: requiredText(row.provider_account_id, "provider_account_id"),
    partitionId: optionalText(row.partition_id),
    checkpointId: optionalText(row.checkpoint_id),
    runId: optionalText(row.run_id),
    endpointName: requiredText(row.endpoint_name, "endpoint_name"),
    entityScope: requiredText(row.entity_scope, "entity_scope"),
    pageIndex: nullableInteger(row.page_index),
    providerCursor: optionalText(row.provider_cursor),
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    accountTimezone: optionalText(row.account_timezone),
    accountCurrency: optionalText(row.account_currency),
    payloadJson: row.payload_json,
    payloadHash: requiredText(row.payload_hash, "payload_hash"),
    providerHttpStatus: nullableNumber(row.provider_http_status),
    status: requiredText(row.status, "status"),
    fetchedAt: timestamp(row.fetched_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function timestampMs(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function latestIso(values: Array<string | null>) {
  const valid = values
    .filter((value): value is string => timestampMs(value) !== null)
    .sort((left, right) => (timestampMs(left) ?? 0) - (timestampMs(right) ?? 0));
  return valid.at(-1) ?? null;
}

function earliestIso(values: Array<string | null>) {
  const valid = values
    .filter((value): value is string => timestampMs(value) !== null)
    .sort((left, right) => (timestampMs(left) ?? 0) - (timestampMs(right) ?? 0));
  return valid[0] ?? null;
}

function generationKey(row: PitRawSnapshotRow) {
  if (!row.partitionId || !row.runId) return null;
  return [
    row.businessId,
    row.providerAccountId,
    row.startDate,
    row.endDate,
    row.partitionId,
    row.runId,
  ].join("::");
}

function scopeKey(row: PitRawSnapshotRow) {
  return `${row.businessId}::${row.providerAccountId}`;
}

function validateSnapshot(
  row: PitRawSnapshotRow,
  decisionDate: string,
  cutoff: string,
): SnapshotValidation {
  const cutoffMs = new Date(cutoff).getTime();
  const fetchedMs = timestampMs(row.fetchedAt);
  const createdMs = timestampMs(row.createdAt);
  const updatedMs = timestampMs(row.updatedAt);
  const postCutoff =
    (fetchedMs !== null && fetchedMs > cutoffMs) ||
    (createdMs !== null && createdMs > cutoffMs);
  const atOrBeforeCutoff =
    fetchedMs !== null && createdMs !== null && fetchedMs <= cutoffMs && createdMs <= cutoffMs;
  const failures: string[] = [];

  if (fetchedMs === null) failures.push("fetched_at_unprovable");
  if (createdMs === null) failures.push("created_at_unprovable");
  if (row.endpointName !== ENDPOINT_NAME) failures.push("endpoint_mismatch");
  if (row.entityScope !== "ad") failures.push("entity_scope_not_ad");
  if (row.startDate !== decisionDate || row.endDate !== decisionDate) {
    failures.push("source_window_not_single_decision_day");
  }
  const statusEligible =
    row.status === "fetched" ||
    (row.status === "superseded" && updatedMs !== null && updatedMs > cutoffMs);
  if (!statusEligible) failures.push("status_not_valid_at_cutoff");
  if (
    row.providerHttpStatus === null ||
    row.providerHttpStatus < 200 ||
    row.providerHttpStatus >= 300
  ) {
    failures.push("provider_http_not_successful");
  }
  if (!Array.isArray(row.payloadJson)) {
    failures.push("payload_not_array");
  } else {
    const payloadObjects = row.payloadJson.filter(
      (payload): payload is Record<string, unknown> =>
        Boolean(payload) && typeof payload === "object" && !Array.isArray(payload),
    );
    if (payloadObjects.length !== row.payloadJson.length) {
      failures.push("payload_contains_non_object");
    }
    if (
      payloadObjects.some((payload) => {
        const dateStart = optionalText(payload.date_start);
        const dateStop = optionalText(payload.date_stop);
        return (dateStart !== null && dateStart !== decisionDate) ||
          (dateStop !== null && dateStop !== decisionDate);
      })
    ) {
      failures.push("payload_date_mismatch");
    }
  }
  if (row.pageIndex === null || row.pageIndex < 0) failures.push("page_index_unprovable");
  if (!row.partitionId || !row.runId) failures.push("generation_identity_unprovable");

  return {
    row,
    atOrBeforeCutoff,
    postCutoff,
    failures,
    generationKey: generationKey(row),
    scopeKey: scopeKey(row),
    observedAt: latestIso([row.fetchedAt, row.createdAt]),
  };
}

function objectPayloadRows(row: PitRawSnapshotRow) {
  if (!Array.isArray(row.payloadJson)) return [];
  return row.payloadJson.map((payload, payloadIndex) => ({
    payload: payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null,
    payloadIndex,
  }));
}

function payloadIdentity(payload: Record<string, unknown> | null, field: string) {
  return payload ? optionalText(payload[field]) : null;
}

function sequenceBetween(start: number, end: number) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function sameNumbers(left: number[], right: number[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildGenerationSummary(
  validations: SnapshotValidation[],
  segmentIndex: number,
): GenerationSummary {
  const rows = validations.map((entry) => entry.row);
  const first = rows[0];
  if (!first?.partitionId || !first.runId) {
    throw new Error("Generation summary requires partition_id and run_id.");
  }
  const streamKey = validations[0]?.generationKey ?? "unprovable";
  const pageGroups = new Map<number, PitRawSnapshotRow[]>();
  for (const row of rows) {
    if (row.pageIndex === null || row.pageIndex < 0) continue;
    const pageRows = pageGroups.get(row.pageIndex) ?? [];
    pageRows.push(row);
    pageGroups.set(row.pageIndex, pageRows);
  }
  const pageIndices = Array.from(pageGroups.keys()).sort((left, right) => left - right);
  const expectedPageIndices =
    pageIndices.length > 0
      ? sequenceBetween(pageIndices[0] ?? 0, pageIndices.at(-1) ?? 0)
      : [];
  const terminalRows = rows.filter((row) => row.providerCursor === null);
  const terminalPageIndex = terminalRows.length === 1 ? terminalRows[0]?.pageIndex ?? null : null;

  let exactDuplicatePageRows = 0;
  const conflictingPageIndices: number[] = [];
  for (const [pageIndex, pageRows] of pageGroups.entries()) {
    if (pageRows.length <= 1) continue;
    const signatures = new Set(
      pageRows.map((row) =>
        deterministicSha256({
          payload: row.payloadJson,
          providerCursor: row.providerCursor,
          providerHttpStatus: row.providerHttpStatus,
          status: row.status,
        }),
      ),
    );
    if (signatures.size === 1) {
      exactDuplicatePageRows += pageRows.length - 1;
    } else {
      conflictingPageIndices.push(pageIndex);
    }
  }
  conflictingPageIndices.sort((left, right) => left - right);

  const evidence: EvidenceRow[] = [];
  const payloadRowsByAd = new Map<
    string,
    Array<{ payload: Record<string, unknown>; adsetId: string | null; campaignId: string | null }>
  >();
  let payloadRows = 0;
  for (const row of rows) {
    for (const entry of objectPayloadRows(row)) {
      payloadRows += 1;
      const payload = entry.payload;
      const adId = payloadIdentity(payload, "ad_id");
      const adsetId = payloadIdentity(payload, "adset_id");
      const campaignId = payloadIdentity(payload, "campaign_id");
      if (payload && row.pageIndex !== null && row.fetchedAt && row.createdAt) {
        evidence.push({
          businessId: row.businessId,
          providerAccountId: row.providerAccountId,
          date: row.startDate,
          accountTimezone: row.accountTimezone,
          accountCurrency: row.accountCurrency,
          adId,
          adsetId,
          campaignId,
          creativeId: payloadIdentity(payload, "creative_id"),
          source: {
            snapshotId: row.id,
            partitionId: first.partitionId,
            runId: first.runId,
            pageIndex: row.pageIndex,
            payloadIndex: entry.payloadIndex,
            fetchedAt: row.fetchedAt,
            createdAt: row.createdAt,
          },
          payload,
        });
      }
      if (payload && adId) {
        const adRows = payloadRowsByAd.get(adId) ?? [];
        adRows.push({ payload, adsetId, campaignId });
        payloadRowsByAd.set(adId, adRows);
      }
    }
  }

  let exactDuplicateAdRows = 0;
  const conflictingAdIds: string[] = [];
  const hierarchyConflictAdIds: string[] = [];
  for (const [adId, adRows] of payloadRowsByAd.entries()) {
    if (adRows.length > 1) {
      const payloadSignatures = new Set(adRows.map((entry) => deterministicSha256(entry.payload)));
      if (payloadSignatures.size === 1) exactDuplicateAdRows += adRows.length - 1;
      else conflictingAdIds.push(adId);
    }
    const hierarchySignatures = new Set(
      adRows.map((entry) => `${entry.campaignId ?? "<missing>"}::${entry.adsetId ?? "<missing>"}`),
    );
    if (hierarchySignatures.size > 1) hierarchyConflictAdIds.push(adId);
  }
  conflictingAdIds.sort();
  hierarchyConflictAdIds.sort();

  evidence.sort((left, right) => {
    const adOrder = (left.adId ?? "").localeCompare(right.adId ?? "");
    if (adOrder !== 0) return adOrder;
    if (left.source.pageIndex !== right.source.pageIndex) {
      return left.source.pageIndex - right.source.pageIndex;
    }
    if (left.source.payloadIndex !== right.source.payloadIndex) {
      return left.source.payloadIndex - right.source.payloadIndex;
    }
    return left.source.snapshotId.localeCompare(right.source.snapshotId);
  });

  const rowValidationFailures = validations
    .filter((entry) => entry.failures.length > 0)
    .map((entry) => ({ snapshotId: entry.row.id, failures: [...entry.failures].sort() }))
    .sort((left, right) => left.snapshotId.localeCompare(right.snapshotId));
  const structurallyComplete =
    rows.length > 0 &&
    rowValidationFailures.length === 0 &&
    pageIndices.length > 0 &&
    sameNumbers(pageIndices, expectedPageIndices) &&
    terminalRows.length === 1 &&
    terminalPageIndex === pageIndices.at(-1);
  const conflictFree =
    exactDuplicatePageRows === 0 &&
    conflictingPageIndices.length === 0 &&
    exactDuplicateAdRows === 0 &&
    conflictingAdIds.length === 0 &&
    hierarchyConflictAdIds.length === 0;

  return {
    generationKey: `${streamKey}::fetch_generation:${segmentIndex}`,
    streamKey,
    segmentIndex,
    partitionId: first.partitionId,
    runId: first.runId,
    startDate: first.startDate,
    endDate: first.endDate,
    firstObservedAt: earliestIso(rows.flatMap((row) => [row.fetchedAt, row.createdAt])),
    lastObservedAt: latestIso(rows.flatMap((row) => [row.fetchedAt, row.createdAt])),
    snapshotRows: rows.length,
    payloadRows,
    pageIndices,
    expectedPageIndices,
    terminalPageCount: terminalRows.length,
    terminalPageIndex,
    rowValidationFailures,
    exactDuplicatePageRows,
    conflictingPageIndices,
    exactDuplicateAdRows,
    conflictingAdIds,
    hierarchyConflictAdIds,
    structurallyComplete,
    conflictFree,
    reconstructable: structurallyComplete && conflictFree,
    snapshotIds: rows
      .slice()
      .sort((left, right) => {
        const pageOrder = (left.pageIndex ?? Number.MAX_SAFE_INTEGER) -
          (right.pageIndex ?? Number.MAX_SAFE_INTEGER);
        return pageOrder || left.id.localeCompare(right.id);
      })
      .map((row) => row.id),
    evidence,
  };
}

function compareGenerationRows(left: SnapshotValidation, right: SnapshotValidation) {
  const fetchedOrder =
    (timestampMs(left.row.fetchedAt) ?? Number.MAX_SAFE_INTEGER) -
    (timestampMs(right.row.fetchedAt) ?? Number.MAX_SAFE_INTEGER);
  if (fetchedOrder !== 0) return fetchedOrder;
  const createdOrder =
    (timestampMs(left.row.createdAt) ?? Number.MAX_SAFE_INTEGER) -
    (timestampMs(right.row.createdAt) ?? Number.MAX_SAFE_INTEGER);
  return createdOrder || left.row.id.localeCompare(right.row.id);
}

function segmentFetchGenerations(
  streamRows: SnapshotValidation[],
): SnapshotValidation[][] {
  const segments: SnapshotValidation[][] = [];
  let current: SnapshotValidation[] = [];
  for (const validation of [...streamRows].sort(compareGenerationRows)) {
    const currentPage = validation.row.pageIndex;
    if (current.length > 0 && currentPage === 0) {
      segments.push(current);
      current = [];
    }
    current.push(validation);
    if (validation.row.providerCursor === null) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function withoutEvidence(summary: GenerationSummary): Omit<GenerationSummary, "evidence"> {
  const { evidence: _evidence, ...rest } = summary;
  return rest;
}

function coverageDimension(
  evidence: EvidenceRow[],
  field: CoverageDimension["field"],
  value: (row: EvidenceRow) => string | null,
  requiredForAdGrain: boolean,
  endpointContractProvidesField: boolean,
): CoverageDimension {
  const totalRows = evidence.length;
  const presentRows = evidence.filter((row) => Boolean(value(row))).length;
  const coveragePct = totalRows > 0 ? Math.round((presentRows / totalRows) * 10_000) / 100 : null;
  let status: GateStatus = "unknown";
  if (totalRows > 0 && endpointContractProvidesField) {
    status = presentRows === totalRows ? "pass" : "fail";
  }
  return {
    field,
    requiredForAdGrain,
    endpointContractProvidesField,
    presentRows,
    totalRows,
    coveragePct,
    status,
  };
}

function buildIdentityCoverage(evidence: EvidenceRow[]): ScopeReport["identityCoverage"] {
  const dimensions = [
    coverageDimension(evidence, "ad_id", (row) => row.adId, true, true),
    coverageDimension(evidence, "adset_id", (row) => row.adsetId, true, true),
    coverageDimension(evidence, "campaign_id", (row) => row.campaignId, true, true),
    coverageDimension(evidence, "creative_id", (row) => row.creativeId, false, false),
  ];
  const required = dimensions.filter((entry) => entry.requiredForAdGrain);
  const status: GateStatus =
    evidence.length === 0
      ? "unknown"
      : required.some((entry) => entry.status === "fail")
        ? "fail"
        : required.every((entry) => entry.status === "pass")
          ? "pass"
          : "unknown";
  return { status, dimensions };
}

function aggregateGateStatus(statuses: GateStatus[]) {
  if (statuses.some((status) => status === "fail")) return "fail" as const;
  if (statuses.length === 0 || statuses.some((status) => status === "unknown")) {
    return "unknown" as const;
  }
  return "pass" as const;
}

function countRejections(validations: SnapshotValidation[]) {
  const counts: Record<string, number> = {};
  for (const validation of validations) {
    if (validation.postCutoff) counts.post_cutoff = (counts.post_cutoff ?? 0) + 1;
    for (const failure of validation.failures) {
      counts[failure] = (counts[failure] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function gateReason(status: GateStatus, pass: string, fail: string, unknown: string) {
  if (status === "pass") return pass;
  if (status === "fail") return fail;
  return unknown;
}

export function buildPitIntegrityReport(input: {
  rows: PitRawSnapshotRow[];
  decisionDate: string;
  cutoff: string;
  businessId?: string | null;
  providerAccountId?: string | null;
  generatedAt?: string;
}): PitIntegrityReport {
  const decisionDate = assertDateOnly(input.decisionDate, "decisionDate");
  const cutoff = assertTimestamp(input.cutoff, "cutoff");
  const validations = input.rows
    .map((row) => validateSnapshot(row, decisionDate, cutoff))
    .sort((left, right) => {
      const scopeOrder = left.scopeKey.localeCompare(right.scopeKey);
      if (scopeOrder !== 0) return scopeOrder;
      const observedOrder = (timestampMs(left.observedAt) ?? 0) - (timestampMs(right.observedAt) ?? 0);
      return observedOrder || left.row.id.localeCompare(right.row.id);
    });
  const validationsByScope = new Map<string, SnapshotValidation[]>();
  for (const validation of validations) {
    const rows = validationsByScope.get(validation.scopeKey) ?? [];
    rows.push(validation);
    validationsByScope.set(validation.scopeKey, rows);
  }

  const scopes: ScopeReport[] = [];
  for (const [key, scopeValidations] of validationsByScope.entries()) {
    const atCutoff = scopeValidations.filter((entry) => entry.atOrBeforeCutoff);
    const exactDayAtCutoff = atCutoff.filter(
      (entry) =>
        entry.row.startDate === decisionDate && entry.row.endDate === decisionDate,
    );
    const spanningWindowRows = scopeValidations.filter(
      (entry) =>
        entry.row.startDate !== decisionDate || entry.row.endDate !== decisionDate,
    );
    const isolatable = exactDayAtCutoff.filter((entry) => entry.generationKey !== null);
    const unisolated = exactDayAtCutoff.filter((entry) => entry.generationKey === null);
    const byStream = new Map<string, SnapshotValidation[]>();
    for (const validation of isolatable) {
      const streamRows = byStream.get(validation.generationKey as string) ?? [];
      streamRows.push(validation);
      byStream.set(validation.generationKey as string, streamRows);
    }
    const generations = Array.from(byStream.entries())
      .flatMap(([, streamRows]) =>
        segmentFetchGenerations(streamRows).map((segment, segmentIndex) =>
          buildGenerationSummary(segment, segmentIndex),
        ),
      )
      .sort((left, right) => {
        const observedOrder = (timestampMs(right.lastObservedAt) ?? 0) -
          (timestampMs(left.lastObservedAt) ?? 0);
        return observedOrder || right.generationKey.localeCompare(left.generationKey);
      });
    const selected = generations[0] ?? null;
    const latestUnisolatedAt = latestIso(unisolated.map((entry) => entry.observedAt));
    const unisolatedCanSupersedeLatest =
      unisolated.length > 0 &&
      (!selected ||
        (timestampMs(latestUnisolatedAt) ?? Number.POSITIVE_INFINITY) >=
          (timestampMs(selected.lastObservedAt) ?? Number.NEGATIVE_INFINITY));
    const generationStatus: GateStatus =
      exactDayAtCutoff.length === 0 || !selected || unisolatedCanSupersedeLatest
        ? "unknown"
        : selected.structurallyComplete
          ? "pass"
          : "fail";
    const generationReason: ScopeReport["generationReason"] =
      exactDayAtCutoff.length === 0
        ? "no_exact_day_rows_at_cutoff"
        : !selected
          ? "no_isolated_generation"
          : unisolatedCanSupersedeLatest
            ? "unisolated_rows_may_be_latest"
            : selected.structurallyComplete
              ? "latest_generation_complete"
              : "latest_generation_incomplete";
    const evidence =
      selected?.reconstructable && !unisolatedCanSupersedeLatest ? selected.evidence : [];
    const identityCoverage = buildIdentityCoverage(evidence);
    const [businessId, providerAccountId] = key.split("::");
    scopes.push({
      businessId: businessId ?? "",
      providerAccountId: providerAccountId ?? "",
      decisionDate,
      observedSnapshotRows: scopeValidations.length,
      atCutoffSnapshotRows: atCutoff.length,
      exactDayAtCutoffSnapshotRows: exactDayAtCutoff.length,
      spanningWindowSnapshotRowsObserved: spanningWindowRows.length,
      postCutoffSnapshotRowsExcluded: scopeValidations.filter((entry) => entry.postCutoff).length,
      unisolatedAtCutoffSnapshotRows: unisolated.length,
      unisolatedCanSupersedeLatest,
      generationStatus,
      generationReason,
      generations: generations.map(withoutEvidence),
      selectedGeneration: selected ? withoutEvidence(selected) : null,
      identityCoverage,
      evidence,
    });
  }
  scopes.sort((left, right) => {
    const businessOrder = left.businessId.localeCompare(right.businessId);
    return businessOrder || left.providerAccountId.localeCompare(right.providerAccountId);
  });

  const selectedGenerations = scopes
    .map((scope) => scope.selectedGeneration)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const selectedConflictTotals = selectedGenerations.reduce(
    (totals, generation) => {
      totals.exactDuplicatePageRows += generation.exactDuplicatePageRows;
      totals.conflictingPageIndices += generation.conflictingPageIndices.length;
      totals.exactDuplicateAdRows += generation.exactDuplicateAdRows;
      totals.conflictingAdIds += generation.conflictingAdIds.length;
      totals.hierarchyConflictAdIds += generation.hierarchyConflictAdIds.length;
      return totals;
    },
    {
      exactDuplicatePageRows: 0,
      conflictingPageIndices: 0,
      exactDuplicateAdRows: 0,
      conflictingAdIds: 0,
      hierarchyConflictAdIds: 0,
    },
  );
  const totalSelectedConflicts = Object.values(selectedConflictTotals).reduce(
    (sum, value) => sum + value,
    0,
  );
  const generationStatus = aggregateGateStatus(scopes.map((scope) => scope.generationStatus));
  const conflictStatus: GateStatus =
    totalSelectedConflicts > 0
      ? "fail"
      : scopes.length === 0 ||
          scopes.some(
            (scope) =>
              !scope.selectedGeneration || scope.unisolatedCanSupersedeLatest,
          )
        ? "unknown"
        : "pass";
  const identityStatus = aggregateGateStatus(
    scopes.map((scope) => scope.identityCoverage.status),
  );
  const evidence = scopes.flatMap((scope) => scope.evidence);
  const manifestScopes = scopes
    .filter(
      (scope) =>
        scope.selectedGeneration?.reconstructable && !scope.unisolatedCanSupersedeLatest,
    )
    .map((scope) => ({
      businessId: scope.businessId,
      providerAccountId: scope.providerAccountId,
      decisionDate: scope.decisionDate,
      generationKey: scope.selectedGeneration?.generationKey ?? null,
      snapshotIds: scope.selectedGeneration?.snapshotIds ?? [],
      evidence: scope.evidence,
    }));
  const manifestValue =
    manifestScopes.length > 0
      ? deterministicSha256({
          manifestVersion: MANIFEST_VERSION,
          decisionDate,
          cutoff,
          endpointName: ENDPOINT_NAME,
          scopes: manifestScopes,
        })
      : null;
  const manifestStatus: GateStatus =
    manifestValue === null
      ? generationStatus === "fail" || conflictStatus === "fail"
        ? "fail"
        : "unknown"
      : generationStatus === "fail" || conflictStatus === "fail" || identityStatus === "fail"
        ? "fail"
        : generationStatus === "unknown" || conflictStatus === "unknown" || identityStatus === "unknown"
          ? "unknown"
          : "pass";
  const includedPostCutoffRows = scopes
    .flatMap((scope) => scope.evidence)
    .filter(
      (row) =>
        (timestampMs(row.source.fetchedAt) ?? Number.POSITIVE_INFINITY) >
          new Date(cutoff).getTime() ||
        (timestampMs(row.source.createdAt) ?? Number.POSITIVE_INFINITY) >
          new Date(cutoff).getTime(),
    )
    .length;
  const postCutoffStatus: GateStatus = includedPostCutoffRows === 0 ? "pass" : "fail";
  const overallStatus = aggregateGateStatus([
    postCutoffStatus,
    generationStatus,
    conflictStatus,
    identityStatus,
    manifestStatus,
  ]);

  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: input.generatedAt
      ? assertTimestamp(input.generatedAt, "generatedAt")
      : new Date().toISOString(),
    readOnly: true,
    mutatesData: false,
    providerCalls: false,
    jobsRun: false,
    input: {
      decisionDate,
      cutoff,
      businessId: input.businessId ?? null,
      providerAccountId: input.providerAccountId ?? null,
    },
    source: {
      table: "meta_raw_snapshots",
      endpointName: ENDPOINT_NAME,
      transactionReadOnly: true,
      queryWindow: "source_window_contains_decision_date",
    },
    summary: {
      observedSnapshotRows: validations.length,
      atCutoffSnapshotRows: validations.filter((entry) => entry.atOrBeforeCutoff).length,
      exactDayAtCutoffSnapshotRows: validations.filter(
        (entry) =>
          entry.atOrBeforeCutoff &&
          entry.row.startDate === decisionDate &&
          entry.row.endDate === decisionDate,
      ).length,
      spanningWindowSnapshotRowsObserved: validations.filter(
        (entry) =>
          entry.row.startDate !== decisionDate || entry.row.endDate !== decisionDate,
      ).length,
      eligibleSnapshotRows: validations.filter(
        (entry) => entry.atOrBeforeCutoff && entry.failures.length === 0,
      ).length,
      postCutoffSnapshotRowsExcluded: validations.filter((entry) => entry.postCutoff).length,
      scopeCount: scopes.length,
      reconstructedScopeCount: manifestScopes.length,
      evidenceRows: evidence.length,
      rejectionCounts: countRejections(validations),
      generationReasonCounts: Object.fromEntries(
        Array.from(
          scopes.reduce((counts, scope) => {
            counts.set(scope.generationReason, (counts.get(scope.generationReason) ?? 0) + 1);
            return counts;
          }, new Map<string, number>()),
        ).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    gates: {
      postCutoffRows: {
        status: postCutoffStatus,
        compensable: false,
        includedRows: includedPostCutoffRows,
        observedExcludedRows: validations.filter((entry) => entry.postCutoff).length,
        reason: gateReason(
          postCutoffStatus,
          "No snapshot fetched or created after cutoff entered reconstructed evidence.",
          "At least one post-cutoff snapshot entered reconstructed evidence.",
          "Cutoff exclusion could not be established.",
        ),
      },
      generationCompleteness: {
        status: generationStatus,
        compensable: false,
        completeScopes: scopes.filter((scope) => scope.generationStatus === "pass").length,
        failedScopes: scopes.filter((scope) => scope.generationStatus === "fail").length,
        unknownScopes: scopes.filter((scope) => scope.generationStatus === "unknown").length,
        reason: gateReason(
          generationStatus,
          "Every observed scope has an isolated latest exact-day fetch generation with contiguous pages and exactly one terminal page.",
          "At least one latest generation is structurally incomplete or contains an invalid snapshot row.",
          "No exact-day cutoff generation exists, or generation identity/order cannot be proved after terminal-page segmentation.",
        ),
      },
      conflicts: {
        status: conflictStatus,
        compensable: false,
        ...selectedConflictTotals,
        reason: gateReason(
          conflictStatus,
          "Selected generations contain no duplicate pages, duplicate ads, divergent ads, or hierarchy conflicts.",
          "A selected generation contains duplicate or conflicting page/ad evidence.",
          "Conflict freedom cannot be proved without an isolated selected generation.",
        ),
      },
      identityCoverage: {
        status: identityStatus,
        compensable: false,
        requiredFields: ["ad_id", "adset_id", "campaign_id"],
        creativeIdentityStatus: "unknown",
        reason: gateReason(
          identityStatus,
          "All reconstructed rows preserve business/account/date/ad grain and include ad, adset, and campaign ids.",
          "At least one reconstructed row is missing a required ad-grain identity field.",
          "There is no reconstructable payload row, or required identity coverage is not provable.",
        ),
      },
      manifestHash: {
        status: manifestStatus,
        compensable: false,
        algorithm: "sha256",
        value: manifestValue,
        manifestVersion: MANIFEST_VERSION,
        reason: gateReason(
          manifestStatus,
          "The complete, conflict-free, identity-covered manifest has a deterministic canonical SHA-256 hash.",
          "A hash may exist for diagnostic output, but a non-compensable prerequisite failed.",
          "No complete manifest exists, or a prerequisite remains unknown.",
        ),
      },
    },
    overallStatus,
    reconstructionEligible: overallStatus === "pass",
    scopes,
    caveats: [
      "The raw table has no immutable status-history column. Treating superseded rows with updated_at after cutoff as fetched-at-cutoff follows the requested rule but cannot prove their prior status independently.",
      "Contiguous page indexes plus one null provider_cursor prove only the stored pagination chain; they cannot prove Meta did not truncate a response upstream.",
      "Rows whose source window merely spans decisionDate remain visible for scope/rejection inventory but never participate in exact-day generation selection.",
      "ad_insights_bulk requests ad, adset, and campaign ids but not creative_id. Creative identity is therefore unknown and is never backfilled from a later warehouse row.",
      "The utility audits only business/account scopes observed in raw snapshots. Without an explicit account inventory that itself existed by cutoff, it cannot prove that an entirely absent account was expected.",
      "Payload metrics remain raw JSON values. Missing fields stay missing or null and are never converted to numeric zero.",
      "The stored payload_hash was computed before JSONB storage and is not used as an integrity oracle because JSON object key order may change; duplicate/conflict and manifest hashes use canonical key ordering.",
    ],
  };
}

async function readPitSnapshotRows(args: ParsedPitIntegrityArgs) {
  const [{ getDb, resetDbClientCache, runDbTransaction }, operational] = await Promise.all([
    import("@/lib/db"),
    import("@/scripts/_operational-runtime"),
  ]);
  operational.configureOperationalScriptRuntime({ lane: "read_only_observation" });
  try {
    return await operational.withOperationalStartupLogsSilenced(async () =>
      runDbTransaction(
        async () => {
          const sql = getDb();
          await sql.query("SET TRANSACTION READ ONLY");
          const readOnlyState = await sql.query<{ transaction_read_only: string }>(
            "SHOW transaction_read_only",
          );
          if (readOnlyState[0]?.transaction_read_only !== "on") {
            throw new Error("Database transaction is not read-only; refusing to query.");
          }
          const rows = await sql.query<DbSnapshotRow>(
            `
              SELECT
                id::text,
                business_id,
                provider_account_id,
                partition_id::text,
                checkpoint_id::text,
                run_id,
                endpoint_name,
                entity_scope,
                page_index,
                provider_cursor,
                start_date::text AS start_date,
                end_date::text AS end_date,
                account_timezone,
                account_currency,
                payload_json,
                payload_hash,
                provider_http_status,
                status,
                fetched_at,
                created_at,
                updated_at
              FROM meta_raw_snapshots
              WHERE endpoint_name = $1
                AND start_date <= $2::date
                AND end_date >= $2::date
                AND ($3::text IS NULL OR business_id = $3)
                AND ($4::text IS NULL OR provider_account_id = $4)
              ORDER BY
                business_id ASC,
                provider_account_id ASC,
                start_date ASC,
                end_date ASC,
                fetched_at ASC,
                created_at ASC,
                id ASC
            `,
            [ENDPOINT_NAME, args.decisionDate, args.businessId, args.providerAccountId],
          );
          return rows.map(normalizePitSnapshotDbRow);
        },
        { timeoutMs: QUERY_TIMEOUT_MS },
      ),
    );
  } finally {
    resetDbClientCache();
  }
}

export async function runPitIntegrityCli(argv: string[]) {
  const args = parsePitIntegrityArgs(argv);
  const rows = await readPitSnapshotRows(args);
  const report = buildPitIntegrityReport({
    rows,
    decisionDate: args.decisionDate,
    cutoff: args.cutoff,
    businessId: args.businessId,
    providerAccountId: args.providerAccountId,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.jsonOut) {
    const outputPath = resolve(args.jsonOut);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json, "utf8");
  }
  process.stdout.write(json);
  return report;
}

const isMain =
  Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1] as string)).href === import.meta.url;

if (isMain) {
  runPitIntegrityCli(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  });
}
