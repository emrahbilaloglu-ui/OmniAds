import type { DbClient } from "@/lib/db";
import { canonicalSha256 } from "../canonical-evaluation";
import type { EngineV3Flags } from "../feature-flags";
import { NATIVE_AD_ENGINE_VERSION } from "../types";
import { AD_DECISION_EVALUATION_CONTRACT_VERSION } from "../evaluation-store";

// Old readers ignore this additive attempt kind and keep the original success
// during image rollback. It is never a published generation or authority.
export const NATIVE_AD_DECISION_REUSE_ATTEMPT_JOB_NAME = "engine_v3_native_ad_decisions_reuse_attempt";

export function nativeDecisionReusePolicyHash(flags: EngineV3Flags, contextMode: string): string {
  return canonicalSha256({ contract: "native-decision-reuse.v3-slot-canonical-producer", engine: NATIVE_AD_ENGINE_VERSION,
    evaluationContract: AD_DECISION_EVALUATION_CONTRACT_VERSION, flags, contextMode });
}

export const NATIVE_AD_SHADOW_SLOT_HOURS = [3, 15] as const;
export function nativeAdShadowSlotStart(now: Date): Date | null {
  const hour = now.getUTCHours();
  let slot: number | null = null;
  for (const candidate of NATIVE_AD_SHADOW_SLOT_HOURS) if (hour >= candidate) slot = candidate;
  if (slot === null) return null;
  const start = new Date(now);
  start.setUTCHours(slot, 0, 0, 0);
  return start;
}

/** Direct invocations before 03:00 can deduplicate only within that UTC day. */
export function nativeGenerationReuseSlotStart(cutoff: string): string {
  const clock = new Date(cutoff);
  const slot = nativeAdShadowSlotStart(clock);
  if (slot) return slot.toISOString();
  clock.setUTCHours(0, 0, 0, 0);
  return clock.toISOString();
}

/** Trusted SQL clock expression; uses the same UTC slot hours as the scheduler. */
export function nativeGenerationReuseSlotStartSql(clock: string): string {
  const utc = `((${clock}) AT TIME ZONE 'UTC')`;
  return `((date_trunc('day', ${utc}) AT TIME ZONE 'UTC') + CASE ${[...NATIVE_AD_SHADOW_SLOT_HOURS].reverse()
    .map(hour => `WHEN EXTRACT(HOUR FROM ${utc}) >= ${hour} THEN INTERVAL '${hour} hours'`).join(" ")}
    ELSE INTERVAL '0 hours' END)`;
}

/** Full current producer computation, never a calibration/source-clock shortcut. */
export interface NativeGenerationReuseCandidate {
  contextHash: string;
  snapshot: Record<string, unknown>;
}

export type NativeGenerationReuseRefusal =
  | "current_candidates_empty"
  | "current_hydration_not_authoritative"
  | "policy_receipt_invalid"
  | "current_identity_duplicated"
  | "no_matching_complete_generation"
  | "generation_size_changed"
  | "account_manifest_changed"
  | "generation_membership_changed"
  | "context_changed"
  | "canonical_evidence_changed"
  | "comparison_query_failed";

// These are invocation/row identities, not verdicts, source evidence or authority.
const VOLATILE_SNAPSHOT_KEYS = new Set(["computed_at", "job_run_id", "evaluation_id"]);
function stableSnapshot(snapshot: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => !VOLATILE_SNAPSHOT_KEYS.has(key)));
}
function identity(snapshot: Record<string, unknown>) {
  return [snapshot.provider_account_ref_id,snapshot.provider_account_id,snapshot.decision_entity_type,
    snapshot.decision_entity_id,snapshot.ad_id,snapshot.scope_type,snapshot.scope_id].join("\u0000");
}

export function authoritativeHydrationReceipts(errorJson: unknown): boolean {
  if (!errorJson || typeof errorJson !== "object") return false;
  const metadata = (errorJson as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const receipts = (metadata as Record<string, unknown>).hydration_receipts;
  if (!Array.isArray(receipts) || receipts.length === 0) return false;
  return receipts.every((receipt) => {
    if (!receipt || typeof receipt !== "object") return false;
    const count = (value: unknown) => {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
      return Number.isInteger(n) && n >= 0 ? n : null;
    };
    const expected = count(receipt.expected_ad_count), hydrated = count(receipt.hydrated_ad_count);
    return receipt.expected_ad_count !== null && receipt.expected_ad_count !== undefined &&
      receipt.hydrated_ad_count !== null && receipt.hydrated_ad_count !== undefined &&
      expected !== null && hydrated === expected &&
      String(receipt.provider_account_ref_id ?? "").trim().length > 0 &&
      String(receipt.provider_account_id ?? "").trim().length > 0 &&
      /^[a-f0-9]{64}$/.test(String(receipt.expected_manifest_hash ?? "")) &&
      receipt.hydrated_manifest_hash === receipt.expected_manifest_hash &&
      [true,"true"].includes(receipt.source_complete) &&
      [true,"true"].includes(receipt.hydration_complete) &&
      [true,"true"].includes(receipt.authoritative_for_prune) && receipt.reason == null;
  });
}

function receiptMembership(errorJson: Record<string, unknown>) {
  const receipts = (errorJson.metadata as Record<string, unknown>).hydration_receipts as Record<string, unknown>[];
  return canonicalSha256(receipts.map(r => [r.provider_account_ref_id,r.provider_account_id,
    Number(r.expected_ad_count),r.expected_manifest_hash]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

export const READ_NATIVE_GENERATION_REUSE_HEADER_SQL = `
/* native-canonical-generation-reuse: choose one immutable complete generation */
SELECT id::text,row_count,error_json FROM engine_v3_job_runs
WHERE business_ref_id=$1::uuid AND business_id=$1::text
  AND as_of_date=$2::date AND engine_version=$3
  AND job_name='engine_v3_native_ad_decisions_shadow_job' AND status='success'
  AND finished_at <= $4::timestamptz AND id <> $5::uuid
  AND error_json#>>'{metadata,reuse_policy_hash}'=$6
  AND started_at >= $7::timestamptz
ORDER BY finished_at DESC NULLS LAST,started_at DESC,id DESC LIMIT 1
`;
export const READ_NATIVE_GENERATION_REUSE_ROWS_SQL = `
/* All current cells, so extra, missing or replaced rows cannot be hidden. */
SELECT to_jsonb(s) AS snapshot,c.context_hash,e.job_run_id::text AS evaluation_job_run_id,
  e.contract_version AS evaluation_contract_version
FROM engine_v3_ad_decision_snapshots_daily s
JOIN engine_v3_ad_decision_evaluations e ON e.id=s.evaluation_id
JOIN engine_v3_ad_decision_evaluation_contexts c ON c.id=e.context_id
WHERE s.business_ref_id=$1::uuid AND s.business_id=$1::text
  AND s.as_of_date=$2::date AND s.engine_version=$3
`;

export async function readEquivalentNativeGeneration(input: {
  businessId: string; asOf: string; currentJobRunId: string; cutoff: string;
  policyHash: string; candidates: NativeGenerationReuseCandidate[];
  slotStart: string;
  hydrationReceiptJson: Record<string, unknown>;
  onRefusal?: (reason: NativeGenerationReuseRefusal) => void;
}, db: DbClient): Promise<{ jobRunId: string; rowCount: number; proofHash: string } | null> {
  const refuse = (reason: NativeGenerationReuseRefusal) => {
    input.onRefusal?.(reason);
    return null;
  };
  if (!input.candidates.length) return refuse("current_candidates_empty");
  if (!authoritativeHydrationReceipts(input.hydrationReceiptJson)) return refuse("current_hydration_not_authoritative");
  if (!/^[a-f0-9]{64}$/.test(input.policyHash)) return refuse("policy_receipt_invalid");
  const candidates = new Map(input.candidates.map(c => [identity(c.snapshot),c]));
  if (candidates.size !== input.candidates.length) return refuse("current_identity_duplicated");
  // Optional optimization must recover its own SQL error before normal writes.
  await db.query("SAVEPOINT native_canonical_generation_reuse");
  try {
    const [header] = await db.query<{ id: string; row_count: unknown; error_json: Record<string, unknown> }>(
      READ_NATIVE_GENERATION_REUSE_HEADER_SQL,[input.businessId,input.asOf,NATIVE_AD_ENGINE_VERSION,
        input.cutoff,input.currentJobRunId,input.policyHash,input.slotStart]);
    if (!header || Number(header.row_count) !== candidates.size ||
      !authoritativeHydrationReceipts(header.error_json) ||
      receiptMembership(header.error_json) !== receiptMembership(input.hydrationReceiptJson)) {
      await db.query("RELEASE SAVEPOINT native_canonical_generation_reuse");
      return refuse(!header ? "no_matching_complete_generation" :
        Number(header.row_count) !== candidates.size ? "generation_size_changed" : "account_manifest_changed");
    }
    const rows = await db.query<{ snapshot: Record<string, unknown>; context_hash: unknown;
      evaluation_job_run_id: unknown; evaluation_contract_version: unknown }>(
      READ_NATIVE_GENERATION_REUSE_ROWS_SQL,[input.businessId,input.asOf,NATIVE_AD_ENGINE_VERSION]);
    let equivalent = rows.length === candidates.size;
    let refusal: NativeGenerationReuseRefusal = "generation_membership_changed";
    const seen = new Set<string>();
    for (const row of rows) {
      const key = identity(row.snapshot), candidate = candidates.get(key);
      if (!candidate || seen.has(key) || row.snapshot.job_run_id !== header.id ||
        row.evaluation_job_run_id !== header.id ||
        row.evaluation_contract_version !== AD_DECISION_EVALUATION_CONTRACT_VERSION) { equivalent=false;break; }
      if (row.context_hash !== candidate.contextHash) { equivalent=false;refusal="context_changed";break; }
      seen.add(key);
      const current = stableSnapshot(candidate.snapshot);
      const prior = Object.fromEntries(Object.keys(current).map(k => [k,row.snapshot[k]]));
      if (canonicalSha256(current) !== canonicalSha256(prior)) { equivalent=false;refusal="canonical_evidence_changed";break; }
    }
    await db.query("RELEASE SAVEPOINT native_canonical_generation_reuse");
    return equivalent ? {jobRunId:header.id,rowCount:rows.length,
      proofHash:canonicalSha256(input.candidates.map(c => ({contextHash:c.contextHash,
        snapshot:stableSnapshot(c.snapshot)})).sort((a,b) => identity(a.snapshot).localeCompare(identity(b.snapshot))))} : refuse(refusal);
  } catch (error) {
    try {
      await db.query("ROLLBACK TO SAVEPOINT native_canonical_generation_reuse");
      await db.query("RELEASE SAVEPOINT native_canonical_generation_reuse");
    } catch { throw error; }
    return refuse("comparison_query_failed");
  }
}

export const READ_NATIVE_REUSE_COMPLETION_SQL = `
SELECT original.id::text AS id,original.started_at,original.finished_at,original.row_count,
  original.error_json,current_cells.total_rows,current_cells.linked_rows
FROM engine_v3_job_runs original
JOIN engine_v3_job_runs attempt ON attempt.id=$2::uuid
  AND attempt.business_ref_id=original.business_ref_id AND attempt.business_id=original.business_id
  AND attempt.as_of_date=original.as_of_date AND attempt.engine_version=original.engine_version
  AND (attempt.job_name=original.job_name OR attempt.job_name='${NATIVE_AD_DECISION_REUSE_ATTEMPT_JOB_NAME}')
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int total_rows,
    COUNT(*) FILTER(WHERE s.job_run_id=original.id AND e.job_run_id=original.id
      AND e.contract_version=$7)::int linked_rows
  FROM engine_v3_ad_decision_snapshots_daily s
  LEFT JOIN engine_v3_ad_decision_evaluations e ON e.id=s.evaluation_id
  WHERE s.business_ref_id=original.business_ref_id AND s.business_id=original.business_id
    AND s.as_of_date=original.as_of_date AND s.engine_version=original.engine_version
) current_cells ON TRUE
WHERE original.id=$1::uuid AND original.business_ref_id=$3::uuid
  AND original.business_id=$3::text AND original.engine_version=$4
  AND original.job_name='engine_v3_native_ad_decisions_shadow_job'
  AND original.status='success' AND original.started_at >= $5::timestamptz
  AND original.finished_at <= attempt.started_at AND attempt.finished_at <= $6::timestamptz
  AND attempt.status='skipped' AND attempt.row_count=0 AND attempt.error_message='unchanged_canonical_generation'
  AND attempt.dependency_run_id=$8::uuid
  AND attempt.error_json#>>'{metadata,reuse_proof_hash}' ~ '^[a-f0-9]{64}$'
  AND attempt.error_json#>>'{metadata,reuse_policy_hash}' ~ '^[a-f0-9]{64}$'
  AND attempt.error_json#>>'{metadata,reuse_basis}'='complete_current_canonical_input_decision_and_snapshot_equality'
  AND attempt.error_json#>>'{metadata,reused_job_run_id}'=original.id::text
  AND attempt.error_json#>'{metadata,authority_granted}'='false'::jsonb
  AND attempt.error_json#>>'{metadata,reuse_policy_hash}'=original.error_json#>>'{metadata,reuse_policy_hash}'
  AND original.row_count > 0 AND current_cells.total_rows=original.row_count
  AND current_cells.linked_rows=original.row_count
  AND jsonb_array_length(CASE
    WHEN jsonb_typeof(original.error_json#>'{metadata,hydration_receipts}')='array'
    THEN original.error_json#>'{metadata,hydration_receipts}' ELSE '[]'::jsonb END) > 0
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(original.error_json#>'{metadata,hydration_receipts}')='array'
      THEN original.error_json#>'{metadata,hydration_receipts}' ELSE '[]'::jsonb END) receipt
    WHERE NOT COALESCE(
      btrim(receipt->>'provider_account_ref_id') <> '' AND btrim(receipt->>'provider_account_id') <> ''
      AND receipt->>'expected_ad_count' ~ '^[0-9]+$' AND receipt->>'hydrated_ad_count' ~ '^[0-9]+$'
      AND receipt->>'expected_ad_count'=receipt->>'hydrated_ad_count'
      AND receipt->>'expected_manifest_hash' ~ '^[a-f0-9]{64}$'
      AND receipt->>'hydrated_manifest_hash'=receipt->>'expected_manifest_hash'
      AND receipt->>'source_complete'='true' AND receipt->>'hydration_complete'='true'
      AND receipt->>'authoritative_for_prune'='true'
      AND COALESCE(receipt->'reason','null'::jsonb)='null'::jsonb, FALSE)
  )
`;

/** Compose only trusted source expressions, retaining the exact shared proof SQL. */
export function nativeReuseCompletionReadSql(expressions: readonly [string,string,string,string,string,string,string,string]): string {
  return READ_NATIVE_REUSE_COMPLETION_SQL.replace(/\$(\d+)\b/g,
    (_parameter, index: string) => `(${expressions[Number(index)-1]})`);
}

/** A proof receipt completes this slot only under the current calibration. */
export async function readCompletedNativeReuse(input: {
  attempt: Record<string, unknown>; businessId: string; calibrationRunId: string;
  cutoff: string; slotStart: string;
}, db: DbClient): Promise<Record<string, unknown> | null> {
  const metadata = (input.attempt.error_json as { metadata?: Record<string, unknown> } | null)?.metadata;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (input.attempt.status !== "skipped" ||
    !uuid.test(input.calibrationRunId) ||
    String(input.attempt.dependency_run_id ?? "") !== input.calibrationRunId ||
    !uuid.test(String(input.attempt.id)) || !uuid.test(String(metadata?.reused_job_run_id ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(metadata?.reuse_proof_hash ?? "")) ||
    !/^[a-f0-9]{64}$/.test(String(metadata?.reuse_policy_hash ?? "")) || metadata?.authority_granted !== false ||
    metadata?.reuse_basis !== "complete_current_canonical_input_decision_and_snapshot_equality") return null;
  const [original] = await db.query<Record<string, unknown>>(READ_NATIVE_REUSE_COMPLETION_SQL,
    [metadata.reused_job_run_id,input.attempt.id,input.businessId,NATIVE_AD_ENGINE_VERSION,
      input.slotStart,input.cutoff,AD_DECISION_EVALUATION_CONTRACT_VERSION,input.calibrationRunId]);
  const count = Number(original?.row_count);
  if (!original || count <= 0 || !Number.isInteger(count) ||
    Number(original.total_rows) !== count || Number(original.linked_rows) !== count ||
    !authoritativeHydrationReceipts(original.error_json)) return null;
  return original;
}
