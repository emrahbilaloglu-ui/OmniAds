import { createHash, randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import {
  assertDbSchemaReady,
  getDbSchemaReadiness,
} from "@/lib/db-schema-readiness";
import type {
  CreativeDecisionBenchmarkScope,
  CreativeDecisionBenchmarkScopeInput,
  CreativeDecisionOsV1Response,
} from "@/lib/creative-decision-os";
import type { DecisionCenterSnapshot } from "@/lib/creative-decision-center/contracts";

export const CREATIVE_DECISION_OS_SNAPSHOT_CONTRACT_VERSION =
  "creative-decision-os-snapshot.v1";
export const CREATIVE_DECISION_OS_SNAPSHOT_TABLE =
  "creative_decision_os_snapshots";

export type CreativeDecisionOsSnapshotStatus =
  | "not_run"
  | "running"
  | "ready"
  | "error"
  | "stale_scope";

export type CreativeDecisionOsAnalysisScope = "account" | "campaign";

export interface CreativeDecisionOsSnapshotScope {
  analysisScope: CreativeDecisionOsAnalysisScope;
  analysisScopeId: string | null;
  analysisScopeLabel: string;
  benchmarkScope: CreativeDecisionBenchmarkScope;
  benchmarkScopeId: string | null;
  benchmarkScopeLabel: string;
}

export interface CreativeDecisionOsSnapshotSourceWindow {
  analyticsStartDate: string | null;
  analyticsEndDate: string | null;
  reportingStartDate: string | null;
  reportingEndDate: string | null;
  decisionWindowStartDate: string | null;
  decisionWindowEndDate: string | null;
  decisionWindowLabel: string | null;
}

export interface CreativeDecisionOsSnapshotVersions {
  operatorDecisionVersion: string | null;
  policyVersion: string | null;
  instructionVersion: string | null;
}

export interface CreativeDecisionOsSnapshotError {
  code: string;
  message: string;
}

export interface CreativeDecisionOsSnapshot {
  snapshotId: string;
  surface: "creative";
  businessId: string;
  scope: CreativeDecisionOsSnapshotScope;
  decisionAsOf: string | null;
  generatedAt: string;
  generatedBy: string | null;
  sourceWindow: CreativeDecisionOsSnapshotSourceWindow;
  versions: CreativeDecisionOsSnapshotVersions;
  inputHash: string | null;
  evidenceHash: string | null;
  summaryCounts: Record<string, unknown>;
  status: Exclude<CreativeDecisionOsSnapshotStatus, "not_run" | "running" | "stale_scope">;
  error: CreativeDecisionOsSnapshotError | null;
  payload: CreativeDecisionOsV1Response | null;
}

export interface CreativeDecisionOsSnapshotApiResponse {
  contractVersion: typeof CREATIVE_DECISION_OS_SNAPSHOT_CONTRACT_VERSION;
  status: CreativeDecisionOsSnapshotStatus;
  scope: CreativeDecisionOsSnapshotScope;
  snapshot: CreativeDecisionOsSnapshot | null;
  decisionOs: CreativeDecisionOsV1Response | null;
  decisionCenter: DecisionCenterSnapshot | null;
  error: CreativeDecisionOsSnapshotError | null;
}

interface SnapshotDbRow {
  id?: string;
  surface?: string;
  business_id?: string;
  analysis_scope?: CreativeDecisionOsAnalysisScope;
  analysis_scope_id?: string | null;
  analysis_scope_label?: string | null;
  benchmark_scope?: CreativeDecisionBenchmarkScope;
  benchmark_scope_id?: string | null;
  benchmark_scope_label?: string | null;
  decision_as_of?: string | Date | null;
  generated_at?: string | Date;
  generated_by?: string | null;
  source_window?: unknown;
  operator_decision_version?: string | null;
  policy_version?: string | null;
  instruction_version?: string | null;
  input_hash?: string | null;
  evidence_hash?: string | null;
  summary_counts?: unknown;
  status?: "ready" | "error";
  error_json?: unknown;
  payload?: unknown;
}

function isoDate(value: string | Date | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isoDateTime(value: string | Date | null | undefined) {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function trimToNull(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stableHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function resolveCreativeDecisionOsSnapshotScope(
  benchmarkScope?: CreativeDecisionBenchmarkScopeInput | null,
): CreativeDecisionOsSnapshotScope {
  const requestedScope = benchmarkScope?.scope === "campaign" ? "campaign" : "account";
  const requestedScopeId = trimToNull(benchmarkScope?.scopeId ?? null);
  const requestedScopeLabel = trimToNull(benchmarkScope?.scopeLabel ?? null);

  if (requestedScope === "campaign") {
    return {
      analysisScope: "campaign",
      analysisScopeId: requestedScopeId,
      analysisScopeLabel: requestedScopeLabel ?? "Selected campaign",
      benchmarkScope: "campaign",
      benchmarkScopeId: requestedScopeId,
      benchmarkScopeLabel: requestedScopeLabel ?? "Selected campaign",
    };
  }

  return {
    analysisScope: "account",
    analysisScopeId: null,
    analysisScopeLabel: "Account-wide",
    benchmarkScope: "account",
    benchmarkScopeId: null,
    benchmarkScopeLabel: "Account-wide",
  };
}

function buildSourceWindow(input: {
  payload?: CreativeDecisionOsV1Response | null;
  analyticsStartDate?: string | null;
  analyticsEndDate?: string | null;
  reportingStartDate?: string | null;
  reportingEndDate?: string | null;
}): CreativeDecisionOsSnapshotSourceWindow {
  const primary = input.payload?.decisionWindows?.primary30d;
  return {
    analyticsStartDate: input.analyticsStartDate ?? input.payload?.analyticsWindow?.startDate ?? null,
    analyticsEndDate: input.analyticsEndDate ?? input.payload?.analyticsWindow?.endDate ?? null,
    reportingStartDate: input.reportingStartDate ?? input.payload?.startDate ?? null,
    reportingEndDate: input.reportingEndDate ?? input.payload?.endDate ?? null,
    decisionWindowStartDate: primary?.startDate ?? null,
    decisionWindowEndDate: primary?.endDate ?? null,
    decisionWindowLabel: primary?.label ?? null,
  };
}

function buildVersions(payload: CreativeDecisionOsV1Response | null): CreativeDecisionOsSnapshotVersions {
  const firstPolicy = payload?.creatives.find((creative) => creative.operatorPolicy?.policyVersion)?.operatorPolicy;
  return {
    operatorDecisionVersion: payload?.engineVersion ?? null,
    policyVersion: firstPolicy?.policyVersion ?? null,
    instructionVersion: null,
  };
}

function buildSummaryCounts(payload: CreativeDecisionOsV1Response | null) {
  if (!payload) return {};
  const userFacingSegments = payload.creatives.reduce<Record<string, number>>((acc, creative) => {
    const segment = creative.operatorPolicy?.segment ?? creative.lifecycleState ?? "unknown";
    acc[segment] = (acc[segment] ?? 0) + 1;
    return acc;
  }, {});
  return {
    totalCreatives: payload.summary.totalCreatives,
    userFacingSegments,
    surfaceSummary: payload.summary.surfaceSummary ?? null,
    benchmarkScope: payload.summary.benchmarkScope ?? null,
  };
}

async function ensureSnapshotTable() {
  await assertDbSchemaReady({
    tables: [CREATIVE_DECISION_OS_SNAPSHOT_TABLE],
    context: "creative_decision_os_snapshots",
  });
}

function hydrateSnapshot(row: SnapshotDbRow): CreativeDecisionOsSnapshot | null {
  if (!row.id || row.surface !== "creative" || !row.business_id) return null;
  const benchmarkScope =
    row.benchmark_scope === "campaign" ? "campaign" : "account";
  const analysisScope =
    row.analysis_scope === "campaign" ? "campaign" : "account";
  const scope: CreativeDecisionOsSnapshotScope = {
    analysisScope,
    analysisScopeId: row.analysis_scope_id ?? null,
    analysisScopeLabel:
      row.analysis_scope_label ?? (analysisScope === "campaign" ? "Selected campaign" : "Account-wide"),
    benchmarkScope,
    benchmarkScopeId: row.benchmark_scope_id ?? null,
    benchmarkScopeLabel:
      row.benchmark_scope_label ?? (benchmarkScope === "campaign" ? "Selected campaign" : "Account-wide"),
  };
  const payload = parseJsonValue<CreativeDecisionOsV1Response | null>(row.payload, null);
  return {
    snapshotId: row.id,
    surface: "creative",
    businessId: row.business_id,
    scope,
    decisionAsOf: isoDate(row.decision_as_of),
    generatedAt: isoDateTime(row.generated_at),
    generatedBy: row.generated_by ?? null,
    sourceWindow: parseJsonValue<CreativeDecisionOsSnapshotSourceWindow>(
      row.source_window,
      buildSourceWindow({ payload }),
    ),
    versions: {
      operatorDecisionVersion: row.operator_decision_version ?? null,
      policyVersion: row.policy_version ?? null,
      instructionVersion: row.instruction_version ?? null,
    },
    inputHash: row.input_hash ?? null,
    evidenceHash: row.evidence_hash ?? null,
    summaryCounts: parseJsonValue<Record<string, unknown>>(row.summary_counts, {}),
    status: row.status === "error" ? "error" : "ready",
    error: parseJsonValue<CreativeDecisionOsSnapshotError | null>(row.error_json, null),
    payload,
  };
}

export async function getLatestCreativeDecisionOsSnapshot(input: {
  businessId: string;
  benchmarkScope?: CreativeDecisionBenchmarkScopeInput | null;
}): Promise<CreativeDecisionOsSnapshot | null> {
  const readiness = await getDbSchemaReadiness({
    tables: [CREATIVE_DECISION_OS_SNAPSHOT_TABLE],
  });
  if (!readiness.ready) return null;

  const scope = resolveCreativeDecisionOsSnapshotScope(input.benchmarkScope);
  const sql = getDb();
  const rows = (await sql`
    SELECT
      id,
      surface,
      business_id,
      analysis_scope,
      analysis_scope_id,
      analysis_scope_label,
      benchmark_scope,
      benchmark_scope_id,
      benchmark_scope_label,
      decision_as_of,
      generated_at,
      generated_by,
      source_window,
      operator_decision_version,
      policy_version,
      instruction_version,
      input_hash,
      evidence_hash,
      summary_counts,
      status,
      error_json,
      payload
    FROM creative_decision_os_snapshots
    WHERE business_id = ${input.businessId}
      AND surface = 'creative'
      AND analysis_scope = ${scope.analysisScope}
      AND COALESCE(analysis_scope_id, '') = ${scope.analysisScopeId ?? ""}
      AND benchmark_scope = ${scope.benchmarkScope}
      AND COALESCE(benchmark_scope_id, '') = ${scope.benchmarkScopeId ?? ""}
    ORDER BY generated_at DESC
    LIMIT 1
  `) as SnapshotDbRow[];

  return rows[0] ? hydrateSnapshot(rows[0]) : null;
}

export async function saveCreativeDecisionOsSnapshot(input: {
  businessId: string;
  benchmarkScope?: CreativeDecisionBenchmarkScopeInput | null;
  payload: CreativeDecisionOsV1Response;
  generatedBy?: string | null;
  analyticsStartDate?: string | null;
  analyticsEndDate?: string | null;
  reportingStartDate?: string | null;
  reportingEndDate?: string | null;
}): Promise<CreativeDecisionOsSnapshot> {
  await ensureSnapshotTable();
  const scope = resolveCreativeDecisionOsSnapshotScope(input.benchmarkScope);
  const sourceWindow = buildSourceWindow({
    payload: input.payload,
    analyticsStartDate: input.analyticsStartDate,
    analyticsEndDate: input.analyticsEndDate,
    reportingStartDate: input.reportingStartDate,
    reportingEndDate: input.reportingEndDate,
  });
  const versions = buildVersions(input.payload);
  const summaryCounts = buildSummaryCounts(input.payload);
  const payloadJson = JSON.stringify(input.payload);
  const inputHash = stableHash({
    businessId: input.businessId,
    scope,
    sourceWindow,
    decisionAsOf: input.payload.decisionAsOf,
    versions,
  });
  const evidenceHash = stableHash({
    decisionAsOf: input.payload.decisionAsOf,
    creativeCount: input.payload.creatives.length,
    creatives: input.payload.creatives.map((creative) => ({
      creativeId: creative.creativeId,
      segment: creative.operatorPolicy?.segment ?? creative.lifecycleState,
      spend: creative.spend,
      purchases: creative.purchases,
      roas: creative.roas,
    })),
  });
  const snapshotId = randomUUID();
  const generatedAt = new Date().toISOString();

  const sql = getDb();
  await sql`
    INSERT INTO creative_decision_os_snapshots (
      id,
      surface,
      business_id,
      analysis_scope,
      analysis_scope_id,
      analysis_scope_label,
      benchmark_scope,
      benchmark_scope_id,
      benchmark_scope_label,
      decision_as_of,
      generated_at,
      generated_by,
      source_window,
      operator_decision_version,
      policy_version,
      instruction_version,
      input_hash,
      evidence_hash,
      summary_counts,
      status,
      error_json,
      payload,
      updated_at
    )
    VALUES (
      ${snapshotId},
      'creative',
      ${input.businessId},
      ${scope.analysisScope},
      ${scope.analysisScopeId},
      ${scope.analysisScopeLabel},
      ${scope.benchmarkScope},
      ${scope.benchmarkScopeId},
      ${scope.benchmarkScopeLabel},
      ${input.payload.decisionAsOf},
      ${generatedAt},
      ${input.generatedBy ?? null},
      ${JSON.stringify(sourceWindow)}::jsonb,
      ${versions.operatorDecisionVersion},
      ${versions.policyVersion},
      ${versions.instructionVersion},
      ${inputHash},
      ${evidenceHash},
      ${JSON.stringify(summaryCounts)}::jsonb,
      'ready',
      ${null}::jsonb,
      ${payloadJson}::jsonb,
      now()
    )
  `;

  return {
    snapshotId,
    surface: "creative",
    businessId: input.businessId,
    scope,
    decisionAsOf: input.payload.decisionAsOf,
    generatedAt,
    generatedBy: input.generatedBy ?? null,
    sourceWindow,
    versions,
    inputHash,
    evidenceHash,
    summaryCounts,
    status: "ready",
    error: null,
    payload: input.payload,
  };
}

export function buildCreativeDecisionOsSnapshotResponse(input: {
  status?: CreativeDecisionOsSnapshotStatus;
  scope: CreativeDecisionOsSnapshotScope;
  snapshot?: CreativeDecisionOsSnapshot | null;
  decisionCenter?: DecisionCenterSnapshot | null;
  error?: CreativeDecisionOsSnapshotError | null;
}): CreativeDecisionOsSnapshotApiResponse {
  const snapshot = input.snapshot ?? null;
  const status = input.status ?? snapshot?.status ?? "not_run";
  return {
    contractVersion: CREATIVE_DECISION_OS_SNAPSHOT_CONTRACT_VERSION,
    status,
    scope: snapshot?.scope ?? input.scope,
    snapshot,
    decisionOs: snapshot?.status === "ready" ? snapshot.payload : null,
    decisionCenter: input.decisionCenter ?? null,
    error: input.error ?? snapshot?.error ?? null,
  };
}
