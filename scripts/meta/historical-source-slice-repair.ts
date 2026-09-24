/**
 * Rebind one finalized Ad day to the exact completed source capture that
 * produced its current rows. Dry-run by default. This never rewrites Ad facts,
 * raw pages, manifest clocks, or historical publication timestamps. It may
 * only append a slice and publish a new pointer at the actual repair time.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx scripts/meta/historical-source-slice-repair.ts
 *     --business ID --account act_ID --day YYYY-MM-DD --cutoff ISOZ --out plan.json
 *   ADSECUTE_META_SLICE_REPAIR_APPLY=1 node ... --apply --expected-hash SHA256
 *
 * The current repair contract handles complete single-page captures. Multi-
 * page and legacy captures without a causal receipt are explicit holds. No
 * latest-manifest shortcut is permitted.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { getDb, runDbTransaction } from "@/lib/db";
import {
  createMetaAuthoritativeSliceVersion,
  publishMetaAuthoritativeSliceVersion,
  updateMetaAuthoritativeSliceVersion,
} from "@/lib/meta/warehouse";
import { configureOperationalScriptRuntime } from "../_operational-runtime";

const CONTRACT = "meta-historical-source-slice-repair.v1";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/i;

export type Options = {
  businessId: string;
  accountId: string;
  day: string;
  cutoff: string;
  out: string | null;
  apply: boolean;
  expectedHash: string | null;
};

function parseArgs(argv: string[]): Options {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === "--apply") { apply = true; continue; }
    const value = argv[index + 1];
    if (!key.startsWith("--") || !value || value.startsWith("--") || values.has(key)) {
      throw new Error(`invalid_argument:${key}`);
    }
    values.set(key, value);
    index += 1;
  }
  for (const key of values.keys()) {
    if (!["--business", "--account", "--day", "--cutoff", "--out", "--expected-hash"].includes(key)) {
      throw new Error(`unknown_argument:${key}`);
    }
  }
  const businessId = values.get("--business") ?? "";
  const accountId = values.get("--account") ?? "";
  const day = values.get("--day") ?? "";
  const cutoff = values.get("--cutoff") ?? "";
  if (!businessId || !accountId || !DAY.test(day) ||
      new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day ||
      !Number.isFinite(Date.parse(cutoff)) || !/Z$/.test(cutoff)) {
    throw new Error("business_account_real_day_and_utc_cutoff_required");
  }
  const expectedHash = values.get("--expected-hash") ?? null;
  if (apply && (!expectedHash || !SHA.test(expectedHash) || !values.get("--out") ||
      process.env.ADSECUTE_META_SLICE_REPAIR_APPLY !== "1")) {
    throw new Error("apply_requires_opt_in_reviewed_plan_hash_and_ledger_path");
  }
  return { businessId, accountId, day, cutoff, out: values.get("--out") ?? null,
    apply, expectedHash };
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function numeric(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function time(value: string | null | undefined): number {
  return value ? Date.parse(value) : Number.NaN;
}

export type RepairPointer = {
  id: string; activeSliceId: string; activeManifestId: string | null;
  publishedByRunId: string | null; publishedAt: string;
  publicationReason: string; createdAt: string; updatedAt: string;
  businessRefId: string | null; providerAccountRefId: string | null;
};
export type RepairAd = {
  id: string; adId: string; sourceRunId: string | null;
  sourceSnapshotId: string | null; payload: unknown;
  spend: number; accountTimezone: string; truthState: string;
  validationStatus: string; createdAt: string; updatedAt: string;
  businessRefId: string | null; providerAccountRefId: string | null;
};
export type RepairManifest = {
  id: string; runId: string | null; surface: string; fetchStatus: string;
  accountTimezone: string; watermark: string | null; sourceSpend: number | null;
  rowsFetchedTotal: unknown; partitionId: string | null;
  freshStartApplied: boolean; checkpointResetApplied: boolean;
  startedAt: string | null; completedAt: string | null;
  createdAt: string; updatedAt: string;
  businessRefId: string | null; providerAccountRefId: string | null;
};
export type RepairRawPage = {
  id: string; businessId: string; accountId: string;
  partitionId: string | null; runId: string | null;
  endpointName: string; entityScope: string; startDate: string;
  endDate: string; pageIndex: number | null; status: string;
  httpStatus: number | null; requestContext: unknown; payload: unknown;
  contentKey: string | null; fetchedAt: string; createdAt: string;
};
export type RepairObservation = {
  id: string; snapshotId: string; partitionId: string | null;
  runId: string | null; endpointName: string; entityScope: string;
  pageIndex: number | null; status: string; httpStatus: number | null;
  requestContext: unknown; observedAt: string; createdAt: string;
};
export type RepairReconciliation = {
  id: string; manifestId: string; surface: string; eventKind: string;
  result: string; sourceSpend: number | null;
  warehouseAccountSpend: number | null; createdAt: string;
};
export type RepairEvidence = {
  pointer: RepairPointer | null;
  ads: RepairAd[];
  manifests: RepairManifest[];
  raw: RepairRawPage | null;
  observations: RepairObservation[];
  reconciliations: RepairReconciliation[];
};

export function evaluateHistoricalSourceSlice(input: {
  businessId: string; accountId: string; day: string; cutoff: string;
  evidence: RepairEvidence;
}) {
  const { pointer, ads, manifests, raw, observations, reconciliations } = input.evidence;
  const blockers: string[] = [];
  const cutoff = time(input.cutoff);
  if (!pointer || !pointer.publishedByRunId) blockers.push("ad_pointer_or_run_missing");
  if (pointer && (![pointer.publishedAt, pointer.createdAt, pointer.updatedAt]
    .every((value) => Number.isFinite(time(value)) && time(value) <= cutoff) ||
    time(pointer.createdAt) > time(pointer.publishedAt))) {
    blockers.push("pointer_after_cutoff_or_clock_invalid");
  }
  if (ads.length === 0) blockers.push("no_ad_rows");
  const snapshots = new Set(ads.map((ad) => ad.sourceSnapshotId));
  if (snapshots.size !== 1 || !raw || !snapshots.has(raw.id)) {
    blockers.push("not_one_exact_source_page");
  }
  const runId = pointer?.publishedByRunId ?? null;
  const eligible = manifests.filter((manifest) => pointer && runId &&
    manifest.runId === runId && manifest.surface === "account_daily" &&
    manifest.fetchStatus === "completed" && manifest.watermark === raw?.id &&
    Number.isFinite(time(manifest.completedAt)) &&
    time(manifest.completedAt) <= Math.min(time(pointer?.publishedAt), cutoff));
  eligible.sort((left, right) => time(right.completedAt) - time(left.completedAt));
  const target = eligible[0] ?? null;
  if (!target) blockers.push("matching_completed_manifest_before_pointer_missing");
  if (target && manifests.some((manifest) =>
    manifest.runId === runId && manifest.surface === "account_daily" &&
    manifest.fetchStatus === "completed" && manifest.watermark !== target.watermark &&
    time(manifest.completedAt) > time(target.completedAt) &&
    time(manifest.completedAt) <= time(pointer?.publishedAt))) {
    blockers.push("intervening_different_capture");
  }
  if (target && (!target.freshStartApplied || !target.checkpointResetApplied)) {
    blockers.push("manifest_not_fresh_capture");
  }
  if (target && (!target.businessRefId || !target.providerAccountRefId ||
      target.businessRefId !== pointer?.businessRefId ||
      target.providerAccountRefId !== pointer?.providerAccountRefId)) {
    blockers.push("reference_identity_mismatch");
  }
  if (target && (![target.startedAt, target.completedAt, target.createdAt, target.updatedAt]
    .every((value) => Number.isFinite(time(value)) && time(value) <= cutoff))) {
    blockers.push("manifest_clock_invalid");
  }
  if (raw) {
    const request = asRecord(raw.requestContext);
    const fields = typeof request.fields === "string" ? request.fields.split(",") : null;
    if (raw.businessId !== input.businessId || raw.accountId !== input.accountId ||
        raw.startDate !== input.day || raw.endDate !== input.day ||
        raw.endpointName !== "ad_insights_bulk" || raw.entityScope !== "ad" ||
        raw.status !== "fetched" || raw.httpStatus !== 200 || raw.pageIndex !== 0 ||
        request.source !== "bulk_core_sync" || request.level !== "ad" ||
        (fields && !fields.includes("actions")) || !Array.isArray(raw.payload) ||
        !Number.isFinite(time(raw.fetchedAt)) || time(raw.fetchedAt) > cutoff ||
        !Number.isFinite(time(raw.createdAt)) || time(raw.createdAt) > cutoff) {
      blockers.push("raw_page_scope_or_request_invalid");
    }
  }
  let receiptKind: "run_observation" | "legacy_run_bound_raw" | null = null;
  if (raw && target) {
    const scoped = observations.filter((observation) =>
      observation.snapshotId === raw.id && observation.runId === runId &&
      observation.partitionId === target.partitionId &&
      observation.endpointName === "ad_insights_bulk" &&
      observation.entityScope === "ad" && observation.pageIndex === 0 &&
      time(observation.observedAt) <= time(pointer?.publishedAt));
    scoped.sort((left, right) => time(right.observedAt) - time(left.observedAt));
    const latest = scoped[0] ?? null;
    if (latest) {
      const request = asRecord(latest.requestContext);
      const fields = typeof request.fields === "string" ? request.fields.split(",") : null;
      if (latest.status !== "fetched" || latest.httpStatus !== 200 ||
          request.source !== "bulk_core_sync" || request.level !== "ad" ||
          (fields && !fields.includes("actions")) ||
          time(latest.observedAt) > time(target.completedAt) ||
          time(latest.observedAt) < time(target.startedAt) ||
          time(latest.createdAt) > time(target.completedAt) ||
          time(latest.observedAt) < time(raw.fetchedAt) ||
          !Number.isFinite(time(latest.observedAt))) {
        blockers.push("observation_not_causal_or_superseded");
      } else {
        receiptKind = "run_observation";
      }
    } else if (raw.contentKey !== null || raw.runId !== runId ||
        raw.partitionId !== target.partitionId ||
        time(raw.fetchedAt) > time(target.completedAt) ||
        time(raw.createdAt) > time(target.completedAt) ||
        time(raw.fetchedAt) < time(target.startedAt)) {
      blockers.push("legacy_run_bound_receipt_missing");
    } else {
      receiptKind = "legacy_run_bound_raw";
    }
  }
  const payload = raw && Array.isArray(raw.payload) ? raw.payload : [];
  const rawByAd = new Map<string, unknown>();
  for (const row of payload) {
    const id = asRecord(row).ad_id;
    if (typeof id !== "string" || !id || rawByAd.has(id)) {
      blockers.push("raw_ad_identity_duplicate_or_missing");
      break;
    }
    rawByAd.set(id, row);
  }
  const adIds = new Set<string>();
  for (const ad of ads) {
    if (adIds.has(ad.adId)) blockers.push("stored_ad_identity_duplicate");
    adIds.add(ad.adId);
    if (ad.sourceRunId !== runId || ad.sourceSnapshotId !== raw?.id ||
        ad.truthState !== "finalized" || ad.validationStatus !== "passed" ||
        ad.accountTimezone !== target?.accountTimezone ||
        ad.businessRefId !== pointer?.businessRefId ||
        ad.providerAccountRefId !== pointer?.providerAccountRefId ||
        !Number.isFinite(time(ad.createdAt)) || !Number.isFinite(time(ad.updatedAt)) ||
        time(ad.createdAt) > time(pointer?.publishedAt) ||
        time(ad.updatedAt) > time(pointer?.publishedAt)) {
      blockers.push("stored_ad_lineage_invalid");
    }
    if (!rawByAd.has(ad.adId) || digest(rawByAd.get(ad.adId)) !== digest(ad.payload)) {
      blockers.push("stored_ad_payload_not_exact_raw");
    }
  }
  if (rawByAd.size !== ads.length || payload.length !== ads.length ||
      (target && Number(target.rowsFetchedTotal) !== ads.length)) {
    blockers.push("ad_population_or_page_count_mismatch");
  }
  const spend = ads.reduce((sum, ad) => sum + ad.spend, 0);
  const sourceSpend = numeric(target?.sourceSpend);
  if (sourceSpend === null || ads.some((ad) => numeric(ad.spend) === null) ||
      Math.abs(spend - sourceSpend) > 0.01) {
    blockers.push("source_spend_mismatch");
  }
  if (target) {
    const events = reconciliations.filter((event) =>
      event.manifestId === target.id && event.surface === "account_daily" &&
      Number.isFinite(time(event.createdAt)) &&
      time(event.createdAt) <= Math.min(time(pointer?.publishedAt), cutoff));
    const passed = events.find((event) =>
      event.eventKind === "validation_passed" && event.result === "passed" &&
      numeric(event.sourceSpend) !== null &&
      Math.abs(event.sourceSpend! - (sourceSpend ?? NaN)) <= 0.01 &&
      numeric(event.warehouseAccountSpend) !== null &&
      Math.abs(event.warehouseAccountSpend! - spend) <= 0.01);
    if (!passed || events.some((event) =>
      event.result === "repair_required" || event.result === "failed")) {
      blockers.push("exact_manifest_validation_receipt_missing_or_failed");
    }
  }
  const state = blockers.length > 0 ? "blocked" :
    pointer?.activeManifestId === target?.id ? "already_bound" : "repairable";
  return {
    contract: CONTRACT,
    scope: { businessId: input.businessId, accountId: input.accountId,
      day: input.day, cutoff: input.cutoff },
    state,
    blockers: [...new Set(blockers)],
    old: pointer ? {
      pointerId: pointer.id, activeSliceId: pointer.activeSliceId,
      manifestId: pointer.activeManifestId, publishedAt: pointer.publishedAt,
      publicationReason: pointer.publicationReason, runId,
    } : null,
    next: target ? {
      manifestId: target.id, sourceSnapshotId: target.watermark,
      manifestCompletedAt: target.completedAt, sourceRunId: runId,
      partitionId: target.partitionId,
      rowCount: ads.length, aggregatedSpend: spend,
      sourceSpend, receiptKind,
    } : null,
    evidenceHash: digest({ pointer, ads, manifests, raw, observations, reconciliations }),
  };
}

async function readEvidence(options: Options, lockPointer: boolean): Promise<RepairEvidence> {
  const sql = getDb();
  const pointerRows = await sql.query(`
    SELECT pointer.id, pointer.active_slice_version_id AS active_slice_id,
      slice.manifest_id AS active_manifest_id,
      pointer.published_by_run_id, pointer.published_at::text,
      pointer.publication_reason, pointer.created_at::text, pointer.updated_at::text,
      pointer.business_ref_id::text, pointer.provider_account_ref_id::text
    FROM meta_authoritative_publication_pointers pointer
    JOIN meta_authoritative_slice_versions slice ON slice.id = pointer.active_slice_version_id
    WHERE pointer.business_id = $1 AND pointer.provider_account_id = $2
      AND pointer.day = $3::date AND pointer.surface = 'ad_daily'
    ${lockPointer ? "FOR UPDATE OF pointer" : ""}
  `, [options.businessId, options.accountId, options.day]);
  const pointerRow = pointerRows[0] as Record<string, unknown> | undefined;
  const pointer: RepairPointer | null = pointerRow ? {
    id: String(pointerRow.id), activeSliceId: String(pointerRow.active_slice_id),
    activeManifestId: pointerRow.active_manifest_id == null ? null : String(pointerRow.active_manifest_id),
    publishedByRunId: pointerRow.published_by_run_id == null ? null : String(pointerRow.published_by_run_id),
    publishedAt: String(pointerRow.published_at), publicationReason: String(pointerRow.publication_reason),
    createdAt: String(pointerRow.created_at), updatedAt: String(pointerRow.updated_at),
    businessRefId: pointerRow.business_ref_id == null ? null : String(pointerRow.business_ref_id),
    providerAccountRefId: pointerRow.provider_account_ref_id == null ? null : String(pointerRow.provider_account_ref_id),
  } : null;
  const adResult = await sql.query(`
    SELECT id, ad_id, source_run_id, source_snapshot_id::text, payload_json,
      spend, account_timezone, truth_state, validation_status,
      created_at::text, updated_at::text,
      business_ref_id::text, provider_account_ref_id::text
    FROM meta_ad_daily WHERE business_id = $1 AND provider_account_id = $2
      AND date = $3::date ORDER BY ad_id
    ${lockPointer ? "FOR SHARE" : ""}
  `, [options.businessId, options.accountId, options.day]);
  const ads: RepairAd[] = adResult.map((row) => ({
    id: String(row.id), adId: String(row.ad_id),
    sourceRunId: row.source_run_id == null ? null : String(row.source_run_id),
    sourceSnapshotId: row.source_snapshot_id == null ? null : String(row.source_snapshot_id),
    payload: row.payload_json, spend: Number(row.spend),
    accountTimezone: String(row.account_timezone), truthState: String(row.truth_state),
    validationStatus: String(row.validation_status), createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    businessRefId: row.business_ref_id == null ? null : String(row.business_ref_id),
    providerAccountRefId: row.provider_account_ref_id == null ? null : String(row.provider_account_ref_id),
  }));
  const manifestResult = await sql.query(`
    SELECT id, run_id, surface, fetch_status, account_timezone,
      raw_snapshot_watermark, source_spend,
      meta_json->>'rowsFetchedTotal' AS rows_fetched_total,
      meta_json->>'partitionId' AS partition_id,
      fresh_start_applied, checkpoint_reset_applied,
      started_at::text, completed_at::text, created_at::text, updated_at::text,
      business_ref_id::text, provider_account_ref_id::text
    FROM meta_authoritative_source_manifests
    WHERE business_id = $1 AND provider_account_id = $2 AND day = $3::date
      AND run_id = $4 AND surface = 'account_daily'
      AND completed_at <= $5::timestamptz
    ORDER BY completed_at DESC, id DESC
  `, [options.businessId, options.accountId, options.day,
    pointer?.publishedByRunId, pointer?.publishedAt]);
  const manifests: RepairManifest[] = manifestResult.map((row) => ({
    id: String(row.id), runId: row.run_id == null ? null : String(row.run_id),
    surface: String(row.surface), fetchStatus: String(row.fetch_status),
    accountTimezone: String(row.account_timezone),
    watermark: row.raw_snapshot_watermark == null ? null : String(row.raw_snapshot_watermark),
    sourceSpend: row.source_spend == null ? null : Number(row.source_spend),
    rowsFetchedTotal: row.rows_fetched_total,
    partitionId: row.partition_id == null ? null : String(row.partition_id),
    freshStartApplied: Boolean(row.fresh_start_applied),
    checkpointResetApplied: Boolean(row.checkpoint_reset_applied),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    businessRefId: row.business_ref_id == null ? null : String(row.business_ref_id),
    providerAccountRefId: row.provider_account_ref_id == null ? null : String(row.provider_account_ref_id),
  }));
  const snapshotIds = [...new Set(ads.map((ad) => ad.sourceSnapshotId).filter((id): id is string => Boolean(id)))];
  const rawResult = snapshotIds.length === 1 && UUID.test(snapshotIds[0]!)
    ? await sql.query(`
      SELECT id, business_id, provider_account_id, partition_id::text,
        run_id, endpoint_name, entity_scope, start_date::text, end_date::text,
        page_index, status, provider_http_status, request_context,
        payload_json, content_key, fetched_at::text, created_at::text
      FROM meta_raw_snapshots WHERE id = $1::uuid
    `, [snapshotIds[0]])
    : [] as Record<string, unknown>[];
  const rawRow = rawResult[0] as Record<string, unknown> | undefined;
  const raw: RepairRawPage | null = rawRow ? {
    id: String(rawRow.id), businessId: String(rawRow.business_id),
    accountId: String(rawRow.provider_account_id),
    partitionId: rawRow.partition_id == null ? null : String(rawRow.partition_id),
    runId: rawRow.run_id == null ? null : String(rawRow.run_id),
    endpointName: String(rawRow.endpoint_name), entityScope: String(rawRow.entity_scope),
    startDate: String(rawRow.start_date), endDate: String(rawRow.end_date),
    pageIndex: rawRow.page_index == null ? null : Number(rawRow.page_index),
    status: String(rawRow.status),
    httpStatus: rawRow.provider_http_status == null ? null : Number(rawRow.provider_http_status),
    requestContext: rawRow.request_context, payload: rawRow.payload_json,
    contentKey: rawRow.content_key == null ? null : String(rawRow.content_key),
    fetchedAt: String(rawRow.fetched_at), createdAt: String(rawRow.created_at),
  } : null;
  const observationResult = raw && pointer ? await sql.query(`
    SELECT id, snapshot_id::text, partition_id::text, run_id,
      endpoint_name, entity_scope, page_index, status, provider_http_status,
      request_context, observed_at::text, created_at::text
    FROM meta_raw_snapshot_observations
    WHERE snapshot_id = $1::uuid AND run_id = $2
      AND observed_at <= $3::timestamptz
    ORDER BY observed_at DESC, id DESC
  `, [raw.id, pointer.publishedByRunId, pointer.publishedAt]) : [];
  const observations: RepairObservation[] = observationResult.map((row) => ({
    id: String(row.id), snapshotId: String(row.snapshot_id),
    partitionId: row.partition_id == null ? null : String(row.partition_id),
    runId: row.run_id == null ? null : String(row.run_id),
    endpointName: String(row.endpoint_name), entityScope: String(row.entity_scope),
    pageIndex: row.page_index == null ? null : Number(row.page_index),
    status: String(row.status),
    httpStatus: row.provider_http_status == null ? null : Number(row.provider_http_status),
    requestContext: row.request_context, observedAt: String(row.observed_at),
    createdAt: String(row.created_at),
  }));
  const targetManifestIds = manifests
    .filter((manifest) => manifest.watermark === raw?.id && UUID.test(manifest.id))
    .map((manifest) => manifest.id);
  const reconciliationRows = targetManifestIds.length > 0
    ? await sql.query(`
      SELECT id::text, manifest_id::text, surface, event_kind, result,
        source_spend, warehouse_account_spend, created_at::text
      FROM meta_authoritative_reconciliation_events
      WHERE business_id=$1 AND provider_account_id=$2 AND day=$3::date
        AND manifest_id = ANY($4::uuid[])
      ORDER BY created_at DESC, id DESC
    `, [options.businessId, options.accountId, options.day, targetManifestIds])
    : [];
  const reconciliations: RepairReconciliation[] = reconciliationRows.map((row) => ({
    id: String(row.id), manifestId: String(row.manifest_id),
    surface: String(row.surface), eventKind: String(row.event_kind),
    result: String(row.result),
    sourceSpend: row.source_spend == null ? null : Number(row.source_spend),
    warehouseAccountSpend: row.warehouse_account_spend == null
      ? null : Number(row.warehouse_account_spend),
    createdAt: String(row.created_at),
  }));
  return { pointer, ads, manifests, raw, observations, reconciliations };
}

export async function runHistoricalSourceSliceRepair(options: Options) {
  const planFor = async (lockPointer: boolean) =>
    evaluateHistoricalSourceSlice({ ...options,
      evidence: await readEvidence(options, lockPointer) });
  const initial = await planFor(false);
  const planHash = digest(initial);
  if (!options.apply) {
    if (options.out) writeFileSync(options.out, `${JSON.stringify({ ...initial, planHash }, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...initial, planHash })}\n`);
    return;
  }
  if (process.env.ADSECUTE_META_SLICE_REPAIR_APPLY !== "1") {
    throw new Error("apply_requires_explicit_environment_opt_in");
  }
  const reviewed = JSON.parse(readFileSync(options.out!, "utf8")) as Record<string, unknown>;
  if (reviewed.planHash !== planHash ||
      digest(Object.fromEntries(Object.entries(reviewed)
        .filter(([key]) => key !== "planHash"))) !== planHash) {
    throw new Error("reviewed_plan_file_changed_or_stale");
  }
  if (planHash !== options.expectedHash || initial.state !== "repairable" || !initial.next) {
    throw new Error("reviewed_plan_no_longer_repairable_or_hash_mismatch");
  }
  const result = await runDbTransaction(async () => {
    // Every normal writer owns a partition lease before touching this day.
    // Lock its rows so a new lease cannot be claimed while this pointer is
    // rebound. The Ad-row FOR SHARE below blocks updates/deletes of the
    // existing population; the second in-transaction proof catches inserts.
    const partitions = await getDb().query(`
      SELECT id::text, status, lease_owner, lease_expires_at::text
      FROM meta_sync_partitions
      WHERE business_id = $1 AND provider_account_id = $2
        AND partition_date = $3::date
      FOR UPDATE
    `, [options.businessId, options.accountId, options.day]);
    if (partitions.length === 0 || partitions.some((partition) =>
      partition.status === "leased" || partition.status === "running" ||
      (partition.lease_owner && time(String(partition.lease_expires_at)) > Date.now()))) {
      throw new Error("active_or_unlocked_day_partition");
    }
    const current = await planFor(true);
    if (digest(current) !== planHash || current.state !== "repairable" || !current.next) {
      throw new Error("source_or_pointer_changed_since_review");
    }
    if (!current.next.partitionId ||
        !partitions.some((partition) => partition.id === current.next?.partitionId)) {
      throw new Error("source_partition_not_locked");
    }
    const candidate = await createMetaAuthoritativeSliceVersion({
      businessId: options.businessId, providerAccountId: options.accountId,
      day: options.day, surface: "ad_daily", manifestId: current.next.manifestId,
      state: "finalizing", truthState: "finalized", validationStatus: "pending",
      status: "staging", stagedRowCount: current.next.rowCount,
      aggregatedSpend: current.next.aggregatedSpend,
      validationSummary: { repairContract: CONTRACT, reviewedPlanHash: planHash,
        sourceSnapshotId: current.next.sourceSnapshotId,
        receiptKind: current.next.receiptKind },
      sourceRunId: current.next.sourceRunId, stageStartedAt: new Date().toISOString(),
    });
    if (!candidate?.id || candidate.manifestId !== current.next.manifestId ||
        candidate.sourceRunId !== current.next.sourceRunId ||
        candidate.stagedRowCount !== current.next.rowCount ||
        candidate.aggregatedSpend == null ||
        Math.abs(candidate.aggregatedSpend - current.next.aggregatedSpend) > 0.01 ||
        candidate.truthState !== "finalized" ||
        candidate.status === "superseded" || candidate.status === "failed" ||
        (candidate.status === "staging" &&
          candidate.validationSummary?.reviewedPlanHash !== planHash)) {
      throw new Error("writer_did_not_create_exact_manifest_candidate");
    }
    await updateMetaAuthoritativeSliceVersion({
      sliceVersionId: candidate.id, state: "finalizing", truthState: "finalized",
      validationStatus: "passed", status: "staging",
      stagedRowCount: current.next.rowCount,
      aggregatedSpend: current.next.aggregatedSpend,
      validationSummary: { repairContract: CONTRACT, reviewedPlanHash: planHash },
      stageCompletedAt: new Date().toISOString(),
    });
    const pointer = await publishMetaAuthoritativeSliceVersion({
      businessId: options.businessId, providerAccountId: options.accountId,
      day: options.day, surface: "ad_daily", sliceVersionId: candidate.id,
      publishedByRunId: current.next.sourceRunId,
      publicationReason: "manifest_rebind_repair",
    });
    if (!pointer || pointer.activeSliceVersionId !== candidate.id) {
      throw new Error("repair_pointer_publish_failed");
    }
    // The repair publication is a NEW observation, after the reviewed
    // historical cutoff. Verify it at the actual transaction time; never
    // backdate it into the dry-run's point-in-time plan.
    const verifiedBeforeCommit = evaluateHistoricalSourceSlice({
      businessId: options.businessId, accountId: options.accountId,
      day: options.day,
      cutoff: new Date(Date.now() + 30_000).toISOString(),
      evidence: await readEvidence(options, false),
    });
    if (verifiedBeforeCommit.state !== "already_bound" ||
        verifiedBeforeCommit.next?.manifestId !== current.next.manifestId ||
        verifiedBeforeCommit.next?.rowCount !== current.next.rowCount ||
        Math.abs((verifiedBeforeCommit.next?.aggregatedSpend ?? NaN) -
          current.next.aggregatedSpend) > 0.01 ||
        verifiedBeforeCommit.blockers.length > 0) {
      throw new Error("repair_in_transaction_population_readback_failed");
    }
    return { old: current.old, candidateId: candidate.id, pointerId: pointer.id,
      publishedAt: pointer.publishedAt, reviewedPlanHash: planHash };
  });
  const readback = await getDb().query(`
    SELECT pointer.active_slice_version_id::text AS slice_id,
      slice.manifest_id::text AS manifest_id,
      pointer.published_by_run_id, pointer.publication_reason,
      pointer.published_at::text
    FROM meta_authoritative_publication_pointers pointer
    JOIN meta_authoritative_slice_versions slice
      ON slice.id = pointer.active_slice_version_id
    WHERE pointer.business_id = $1 AND pointer.provider_account_id = $2
      AND pointer.day = $3::date AND pointer.surface = 'ad_daily'
  `, [options.businessId, options.accountId, options.day]);
  const after = readback[0];
  if (!after || after.slice_id !== result.candidateId ||
      after.manifest_id !== initial.next.manifestId ||
      after.published_by_run_id !== initial.next.sourceRunId ||
      after.publication_reason !== "manifest_rebind_repair" ||
      time(String(after.published_at)) < time(result.publishedAt)) {
    throw new Error("repair_post_readback_did_not_bind_exact_manifest");
  }
  const receipt = { contract: CONTRACT, result,
    readback: { sliceId: after.slice_id, manifestId: after.manifest_id,
      publishedAt: after.published_at } };
  writeFileSync(`${options.out}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1]?.endsWith("historical-source-slice-repair.ts")) {
  configureOperationalScriptRuntime();
  runHistoricalSourceSliceRepair(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
