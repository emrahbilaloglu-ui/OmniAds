/**
 * Recompute the current UTC day's native Ad generation for the two release
 * canaries after a source rebind. This deliberately bypasses the scheduler's
 * same-slot success reuse. It never calls the provider or proposal projection.
 *
 * Preview (read only): node --env-file-if-exists=.env.local --import tsx \
 *   scripts/creative-decision-center/native-ad-canary-recompute.ts \
 *   --business <Grandmix-or-TheSwaf-UUID>
 * Apply: add --apply and ADSECUTE_NATIVE_CANARY_RECOMPUTE_APPLY=1.
 */
import { getDb } from "@/lib/db";
import { runAdCalibrationJob } from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import { runAdDecisionsJob } from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { withNativeAdShadowBusinessChainLock } from "@/lib/creative-decision-engine/jobs/native-ad-scheduled";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

import { configureOperationalScriptRuntime } from "../_operational-runtime";

export const NATIVE_AD_RECOMPUTE_CANARIES = {
  "5dbc7147-f051-4681-a4d6-20617170074f": "Grandmix",
  "172d0ab8-495b-4679-a4c6-ffa404c389d3": "TheSwaf",
} as const;
type CanaryId = keyof typeof NATIVE_AD_RECOMPUTE_CANARIES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CanaryArgs {
  businessIds: CanaryId[];
  apply: boolean;
}

export function parseCanaryArgs(argv: string[]): CanaryArgs {
  const ids: string[] = [];
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--apply") {
      if (apply) throw new Error("--apply may be supplied only once.");
      apply = true;
    } else if (argv[index] === "--business") {
      const id = argv[++index];
      if (!id || !UUID.test(id)) throw new Error("--business requires a canonical UUID.");
      ids.push(id);
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length) {
    throw new Error("Supply one or two distinct --business canary IDs.");
  }
  for (const id of ids) {
    if (!(id in NATIVE_AD_RECOMPUTE_CANARIES)) {
      throw new Error(`Business ${id} is outside the Grandmix/TheSwaf canary scope.`);
    }
  }
  return { businessIds: ids as CanaryId[], apply };
}

interface ScopeReadback {
  businessName: string | null;
  selectedMetaAccounts: number;
  sourcePointerUpdatedAt: string | null;
  previousDecisionRunId: string | null;
  previousDecisionFinishedAt: string | null;
}

interface CalibrationReadback {
  status: string;
  engineVersion: string;
  asOf: string;
  startedAt: string | null;
  accountBatchCount: number;
  earliestCutoff: string | null;
  receiptBatchCount: number;
  requestedBatchesMatched: number;
}

interface DecisionReadback {
  status: string;
  engineVersion: string;
  asOf: string;
  dependencyRunId: string | null;
  snapshotCount: number;
  earliestComputedAt: string | null;
  authorizedCount: number;
  rawCutCount: number;
  configAuthorityHoldCount: number;
}

export interface CanaryRecomputeDependencies {
  now: () => Date;
  readScope: (businessId: CanaryId, asOf: string) => Promise<ScopeReadback>;
  withChainLock: typeof withNativeAdShadowBusinessChainLock;
  runCalibration: typeof runAdCalibrationJob;
  readCalibration: (runId: string, batchIds: string[]) => Promise<CalibrationReadback>;
  runDecisions: typeof runAdDecisionsJob;
  readDecision: (runId: string) => Promise<DecisionReadback>;
}

async function readScope(businessId: CanaryId, asOf: string): Promise<ScopeReadback> {
  const [row] = await getDb().query<Record<string, unknown>>(
    `SELECT b.name AS business_name,
       (SELECT COUNT(*)::integer FROM business_provider_accounts a
         WHERE a.business_id = b.id::text AND a.provider = 'meta' AND a.is_selected)
         AS selected_meta_accounts,
       (SELECT MAX(p.updated_at)::text FROM meta_authoritative_publication_pointers p
         WHERE p.business_id = b.id::text AND p.surface = 'ad_daily'
           AND p.day BETWEEN ($2::date - INTERVAL '89 days') AND $2::date)
         AS source_pointer_updated_at,
       (SELECT r.id::text FROM engine_v3_job_runs r
         WHERE r.business_ref_id = b.id AND r.as_of_date = $2::date
           AND r.engine_version = $3 AND r.job_name = 'engine_v3_native_ad_decisions_shadow_job'
           AND r.status = 'success'
         ORDER BY r.finished_at DESC NULLS LAST, r.id DESC LIMIT 1)
         AS previous_decision_run_id,
       (SELECT r.finished_at::text FROM engine_v3_job_runs r
         WHERE r.business_ref_id = b.id AND r.as_of_date = $2::date
           AND r.engine_version = $3 AND r.job_name = 'engine_v3_native_ad_decisions_shadow_job'
           AND r.status = 'success'
         ORDER BY r.finished_at DESC NULLS LAST, r.id DESC LIMIT 1)
         AS previous_decision_finished_at
     FROM businesses b WHERE b.id = $1::uuid`,
    [businessId, asOf, NATIVE_AD_ENGINE_VERSION],
  );
  return {
    businessName: typeof row?.business_name === "string" ? row.business_name : null,
    selectedMetaAccounts: Number(row?.selected_meta_accounts ?? 0),
    sourcePointerUpdatedAt: typeof row?.source_pointer_updated_at === "string"
      ? row.source_pointer_updated_at : null,
    previousDecisionRunId: typeof row?.previous_decision_run_id === "string"
      ? row.previous_decision_run_id : null,
    previousDecisionFinishedAt: typeof row?.previous_decision_finished_at === "string"
      ? row.previous_decision_finished_at : null,
  };
}

async function readCalibration(runId: string, batchIds: string[]): Promise<CalibrationReadback> {
  const [row] = await getDb().query<Record<string, unknown>>(
    `SELECT r.status, r.engine_version, r.as_of_date::text AS as_of,
       r.started_at::text AS started_at,
       COUNT(b.id)::integer AS account_batch_count,
       MIN(b.as_of_cutoff)::text AS earliest_cutoff,
       COUNT(receipt.value)::integer AS receipt_batch_count,
       COUNT(receipt.value) FILTER (
         WHERE receipt.value->>'batch_id' = ANY($2::text[])
       )::integer AS requested_batches_matched
     FROM engine_v3_job_runs r
     LEFT JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(r.error_json#>'{metadata,batches}') = 'array'
         THEN r.error_json#>'{metadata,batches}' ELSE '[]'::jsonb END
     ) receipt(value) ON true
     LEFT JOIN engine_v3_ad_account_calibration_batches b
       ON b.id::text = receipt.value->>'batch_id'
       AND b.business_ref_id = r.business_ref_id
       AND b.as_of_date = r.as_of_date
       AND b.engine_version = r.engine_version
       AND b.completeness_status = 'complete'
     WHERE r.id = $1::uuid AND r.job_name = 'engine_v3_native_ad_calibration_shadow_job'
     GROUP BY r.id`,
    [runId, batchIds],
  );
  if (!row) throw new Error("Calibration job run readback missing.");
  return {
    status: String(row.status), engineVersion: String(row.engine_version),
    asOf: String(row.as_of), accountBatchCount: Number(row.account_batch_count),
    startedAt: typeof row.started_at === "string" ? row.started_at : null,
    earliestCutoff: typeof row.earliest_cutoff === "string" ? row.earliest_cutoff : null,
    receiptBatchCount: Number(row.receipt_batch_count),
    requestedBatchesMatched: Number(row.requested_batches_matched),
  };
}

async function readDecision(runId: string): Promise<DecisionReadback> {
  const [row] = await getDb().query<Record<string, unknown>>(
    `SELECT r.status, r.engine_version, r.as_of_date::text AS as_of,
       r.dependency_run_id::text AS dependency_run_id,
       COUNT(s.id)::integer AS snapshot_count,
       MIN(s.computed_at)::text AS earliest_computed_at,
       COUNT(s.id) FILTER (WHERE s.authorized_action IS NOT NULL)::integer AS authorized_count,
       COUNT(s.id) FILTER (WHERE s.raw_label = 'cut')::integer AS raw_cut_count,
       COUNT(s.id) FILTER (WHERE s.authority_blocker = 'config_source_authority')::integer
         AS config_authority_hold_count
     FROM engine_v3_job_runs r
     LEFT JOIN engine_v3_ad_decision_snapshots_daily s ON s.job_run_id = r.id
     WHERE r.id = $1::uuid AND r.job_name = 'engine_v3_native_ad_decisions_shadow_job'
     GROUP BY r.id`,
    [runId],
  );
  if (!row) throw new Error("Decision job run readback missing.");
  return {
    status: String(row.status), engineVersion: String(row.engine_version),
    asOf: String(row.as_of),
    dependencyRunId: typeof row.dependency_run_id === "string"
      ? row.dependency_run_id : null,
    snapshotCount: Number(row.snapshot_count),
    earliestComputedAt: typeof row.earliest_computed_at === "string"
      ? row.earliest_computed_at : null,
    authorizedCount: Number(row.authorized_count),
    rawCutCount: Number(row.raw_cut_count),
    configAuthorityHoldCount: Number(row.config_authority_hold_count),
  };
}

const DEFAULT_DEPENDENCIES: CanaryRecomputeDependencies = {
  now: () => new Date(), readScope,
  withChainLock: withNativeAdShadowBusinessChainLock,
  runCalibration: runAdCalibrationJob, readCalibration,
  runDecisions: runAdDecisionsJob, readDecision,
};

function assertSameUtcDay(now: Date, asOf: string): void {
  if (!Number.isFinite(now.getTime()) || now.toISOString().slice(0, 10) !== asOf) {
    throw new Error("UTC day changed during the canary recompute; stop and start a new run.");
  }
}

function assertScope(businessId: CanaryId, scope: ScopeReadback): void {
  if (scope.businessName !== NATIVE_AD_RECOMPUTE_CANARIES[businessId] ||
      scope.selectedMetaAccounts < 1) {
    throw new Error(`Canary identity or selected Meta account mismatch for ${businessId}.`);
  }
}

function assertSourceNotNewer(sourcePointerUpdatedAt: string | null, cutoff: string | null) {
  if (!cutoff || !Number.isFinite(Date.parse(cutoff))) {
    throw new Error("The new generation has no readable computation cutoff.");
  }
  if (sourcePointerUpdatedAt && Date.parse(sourcePointerUpdatedAt) > Date.parse(cutoff)) {
    throw new Error("An Ad source pointer changed after the generation cutoff; rerun required.");
  }
}

export async function runCanaryRecompute(
  args: CanaryArgs,
  deps: CanaryRecomputeDependencies = DEFAULT_DEPENDENCIES,
) {
  const startedAt = deps.now();
  const asOf = startedAt.toISOString().slice(0, 10);
  const preview = [];
  for (const businessId of args.businessIds) {
    const scope = await deps.readScope(businessId, asOf);
    assertScope(businessId, scope);
    preview.push({ businessId, name: scope.businessName, ...scope });
  }
  const base = {
    mode: args.apply ? "applied" : "dry_run", asOf,
    requestedAt: startedAt.toISOString(), engineVersion: NATIVE_AD_ENGINE_VERSION,
    scope: preview,
  };
  if (!args.apply) return { ...base, results: [] };
  if (process.env.ADSECUTE_NATIVE_CANARY_RECOMPUTE_APPLY !== "1") {
    throw new Error("Apply requires ADSECUTE_NATIVE_CANARY_RECOMPUTE_APPLY=1.");
  }
  if (process.env.ENABLE_RUNTIME_MIGRATIONS === "1") {
    throw new Error("This recompute must not run with runtime migrations enabled.");
  }

  const results = [];
  for (const businessId of args.businessIds) {
    assertSameUtcDay(deps.now(), asOf);
    const locked = await deps.withChainLock({ businessId, asOf }, async () => {
      const before = await deps.readScope(businessId, asOf);
      assertScope(businessId, before);
      const calibration = await deps.runCalibration({ businessId, asOf });
      if (calibration.status !== "success" || !calibration.jobRunId) {
        throw new Error(`Calibration failed for ${businessId}: ${calibration.reason ?? calibration.status}.`);
      }
      const batchIds = calibration.batches.map((batch) => batch.batchId);
      if (batchIds.length !== before.selectedMetaAccounts ||
          new Set(batchIds).size !== batchIds.length) {
        throw new Error("Calibration returned the wrong number of unique account batches.");
      }
      const calibrationStored = await deps.readCalibration(calibration.jobRunId, batchIds);
      if (calibrationStored.status !== "success" ||
          calibrationStored.engineVersion !== NATIVE_AD_ENGINE_VERSION ||
          calibrationStored.asOf !== asOf ||
          calibrationStored.accountBatchCount !== before.selectedMetaAccounts ||
          calibrationStored.receiptBatchCount !== batchIds.length ||
          calibrationStored.requestedBatchesMatched !== batchIds.length) {
        throw new Error("Calibration run or complete account-batch readback disagrees.");
      }
      // A content-identical recompute may legitimately reference an older
      // immutable batch. The new successful job run, not its batch creation
      // time, proves that this source was observed after the rebind.
      assertSourceNotNewer(before.sourcePointerUpdatedAt, calibrationStored.startedAt);
      const beforeDecision = await deps.readScope(businessId, asOf);
      assertSourceNotNewer(beforeDecision.sourcePointerUpdatedAt, calibrationStored.startedAt);
      assertSameUtcDay(deps.now(), asOf);
      const decision = await deps.runDecisions({ businessId, asOf });
      if (decision.status !== "success" || !decision.jobRunId) {
        throw new Error(`Decision generation failed for ${businessId}: ${decision.reason ?? decision.status}.`);
      }
      const stored = await deps.readDecision(decision.jobRunId);
      if (stored.status !== "success" || stored.engineVersion !== NATIVE_AD_ENGINE_VERSION ||
          stored.asOf !== asOf || stored.dependencyRunId !== calibration.jobRunId ||
          stored.snapshotCount !== decision.snapshotsWritten || stored.snapshotCount < 1) {
        throw new Error("Decision run, dependency, or nonempty snapshot readback disagrees.");
      }
      assertSourceNotNewer(
        (await deps.readScope(businessId, asOf)).sourcePointerUpdatedAt,
        stored.earliestComputedAt,
      );
      assertSameUtcDay(deps.now(), asOf);
      return {
        businessId, calibrationRunId: calibration.jobRunId,
        calibrationIdempotentReplay: calibration.idempotentReplay,
        calibrationStartedAt: calibrationStored.startedAt,
        calibrationBatchCutoff: calibrationStored.earliestCutoff,
        decisionRunId: decision.jobRunId,
        decisionComputedAt: stored.earliestComputedAt,
        dependencyRunId: stored.dependencyRunId,
        snapshotCount: stored.snapshotCount,
        rawCutCount: stored.rawCutCount,
        configAuthorityHoldCount: stored.configAuthorityHoldCount,
        authorizedCount: stored.authorizedCount,
      };
    });
    if (!locked.acquired || !locked.value) {
      throw new Error(`Native business-chain lock unavailable for ${businessId}.`);
    }
    results.push(locked.value);
  }
  return { ...base, results };
}

async function main() {
  const args = parseCanaryArgs(process.argv.slice(2));
  configureOperationalScriptRuntime({ lane: args.apply ? "owner_maintenance" : "read_only_observation" });
  const report = await runCanaryRecompute(args);
  console.log(JSON.stringify(report, null, 2));
}

if ((process.argv[1] ?? "").endsWith("native-ad-canary-recompute.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
