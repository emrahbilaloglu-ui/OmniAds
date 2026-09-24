/** Real migrated-Postgres dry-run, apply, readback, and replay seam. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { runHistoricalSourceSliceRepair, type Options } from "./meta/historical-source-slice-repair";

const BUSINESS = "d1120000-0000-4000-8000-000000000001";
const ACCOUNT_REF = "d1120000-0000-4000-8000-000000000002";
const USER = "d1120000-0000-4000-8000-000000000003";
const OLD_MANIFEST = "d1120000-0000-4000-8000-000000000004";
const TARGET_MANIFEST = "d1120000-0000-4000-8000-000000000005";
const RAW = "d1120000-0000-4000-8000-000000000006";
const ACCOUNT = "act_d112_repair_seam";
const DAY = "2026-09-21";
const CUTOFF = "2026-09-24T14:15:00.000Z";
const PAYLOAD = { ad_id: "ad-d112", spend: "50.00", impressions: "500", actions: [] };

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`historical slice repair seam: ${message}`);
}

async function main() {
  if (process.env.ADSECUTE_EPHEMERAL_DB_SEAM !== "1" ||
      !process.env.DATABASE_URL?.includes("127.0.0.1") ||
      process.env.DATABASE_URL.includes(":15432")) {
    throw new Error("historical slice repair seam requires migrated ephemeral PostgreSQL");
  }
  const sql = getDb();
  await sql.query(`
    INSERT INTO users (id, name, email, password_hash)
    VALUES ($1::uuid, 'D112 slice repair', 'd112-repair@adsecute.local', 'x')
  `, [USER]);
  await sql.query(`
    INSERT INTO businesses (id, name, owner_id)
    VALUES ($1::uuid, 'D112 slice repair', $2::uuid)
  `, [BUSINESS, USER]);
  await sql.query(`
    INSERT INTO provider_accounts
      (id, provider, external_account_id, account_name, currency, timezone)
    VALUES ($1::uuid, 'meta', $2, 'D112 slice repair', 'USD', 'Europe/Istanbul')
  `, [ACCOUNT_REF, ACCOUNT]);
  await sql.query(`
    INSERT INTO business_provider_accounts
      (business_id, provider, provider_account_ref_id, provider_account_id,
       position, is_selected)
    VALUES ($1::uuid, 'meta', $2::uuid, $3, 0, TRUE)
  `, [BUSINESS, ACCOUNT_REF, ACCOUNT]);
  const [partition] = await sql.query<{ id: string }>(`
    INSERT INTO meta_sync_partitions
      (business_id, provider_account_id, lane, scope, partition_date, status, source)
    VALUES ($1, $2, 'maintenance', 'account_daily', $3::date, 'failed', 'finalize_day')
    RETURNING id::text
  `, [BUSINESS, ACCOUNT, DAY]);
  assert(partition?.id, "partition missing");
  const run = partition.id;
  const meta = JSON.stringify({ partitionId: run, rowsFetchedTotal: 1 });
  await sql.query(`
    INSERT INTO meta_raw_snapshots
      (id, business_id, provider_account_id, partition_id, run_id,
       endpoint_name, entity_scope, page_index, start_date, end_date,
       payload_json, payload_hash, content_key, request_context,
       provider_http_status, status, fetched_at, created_at, updated_at)
    VALUES ($1::uuid, $2, $3, $4::uuid, $4, 'ad_insights_bulk', 'ad', 0,
      $5::date, $5::date, $6::jsonb, 'raw-hash-d112', NULL,
      '{"source":"bulk_core_sync","level":"ad","fields":"ad_id,spend,actions"}'::jsonb,
      200, 'superseded', '2026-09-23T06:50:31.800Z',
      '2026-09-23T06:50:31.800Z', '2026-09-23T08:00:00.000Z')
  `, [RAW, BUSINESS, ACCOUNT, run, DAY, JSON.stringify([PAYLOAD])]);
  for (const [id, clock, watermark] of [
    [OLD_MANIFEST, "2026-09-22T08:04:59.000Z", null],
    [TARGET_MANIFEST, "2026-09-23T06:50:32.437Z", RAW],
  ] as const) {
    await sql.query(`
      INSERT INTO meta_authoritative_source_manifests
        (id, business_id, business_ref_id, provider_account_id,
         provider_account_ref_id, day, surface, account_timezone,
         source_kind, source_window_kind, run_id, fetch_status,
         fresh_start_applied, checkpoint_reset_applied,
         raw_snapshot_watermark, source_spend, validation_basis_version,
         meta_json, started_at, completed_at, created_at, updated_at)
      VALUES ($1::uuid, ($2::uuid)::text, $2::uuid, $3, $4::uuid, $5::date,
        'account_daily', 'Europe/Istanbul', 'finalize_day', 'historical',
        $6, 'completed', TRUE, TRUE, $7, 50,
        'meta-authoritative-finalization-v2', $8::jsonb,
        $9::timestamptz, $10::timestamptz,
        ($10::timestamptz + interval '12 milliseconds'),
        ($10::timestamptz + interval '12 milliseconds'))
    `, [id, BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, run, watermark, meta,
      id === OLD_MANIFEST ? "2026-09-22T08:04:58.000Z" : "2026-09-23T06:50:31.000Z", clock]);
  }
  await sql.query(`
    INSERT INTO meta_authoritative_reconciliation_events
      (business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, day, surface, manifest_id,
       event_kind, severity, source_spend, warehouse_account_spend,
       tolerance_applied, result, details_json, created_at)
    VALUES (($1::uuid)::text, $1::uuid, $2, $3::uuid, $4::date, 'account_daily',
      $5::uuid, 'validation_passed', 'info', 50, 50, 0.01,
      'passed', '{}'::jsonb, '2026-09-23T06:50:32.900Z')
  `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, TARGET_MANIFEST]);
  const [oldSlice] = await sql.query<{ id: string }>(`
    INSERT INTO meta_authoritative_slice_versions
      (business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, day, surface, manifest_id,
       candidate_version, state, truth_state, validation_status, status,
       staged_row_count, aggregated_spend, source_run_id,
       stage_started_at, stage_completed_at, published_at,
       created_at, updated_at)
    VALUES (($1::uuid)::text, $1::uuid, $2, $3::uuid, $4::date, 'ad_daily', $5::uuid,
      1, 'finalized_verified', 'finalized', 'passed', 'published',
      1, 50, $6, '2026-09-22T08:05:00.000Z',
      '2026-09-22T08:05:00.000Z', '2026-09-23T06:50:32.997Z',
      '2026-09-22T08:05:00.000Z', '2026-09-23T06:50:33.000Z')
    RETURNING id::text
  `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, OLD_MANIFEST, run]);
  assert(oldSlice?.id, "old slice missing");
  await sql.query(`
    INSERT INTO meta_authoritative_publication_pointers
      (business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, day, surface, active_slice_version_id,
       published_by_run_id, publication_reason, published_at,
       created_at, updated_at)
    VALUES (($1::uuid)::text, $1::uuid, $2, $3::uuid, $4::date, 'ad_daily',
      $5::uuid, $6, 'authoritative_refresh',
      '2026-09-23T06:50:33.000Z', '2026-09-22T08:05:00.000Z',
      '2026-09-23T06:50:33.000Z')
  `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, oldSlice.id, run]);
  await sql.query(`
    INSERT INTO meta_ad_daily
      (business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, date, ad_id, account_timezone,
       account_currency, spend, impressions, clicks, reach,
       source_snapshot_id, source_run_id, payload_json, truth_state,
       validation_status, created_at, updated_at)
    VALUES (($1::uuid)::text, $1::uuid, $2, $3::uuid, $4::date, 'ad-d112',
      'Europe/Istanbul', 'USD', 50, 500, 10, 400,
      $5::uuid, $6, $7::jsonb, 'finalized', 'passed',
      '2026-09-23T06:50:32.700Z', '2026-09-23T06:50:32.700Z')
  `, [BUSINESS, ACCOUNT, ACCOUNT_REF, DAY, RAW, run, JSON.stringify(PAYLOAD)]);

  const temp = mkdtempSync(join(tmpdir(), "adsecute-d112-seam-"));
  try {
    const out = join(temp, "plan.json");
    const base: Options = { businessId: BUSINESS, accountId: ACCOUNT,
      day: DAY, cutoff: CUTOFF, out, apply: false, expectedHash: null };
    await runHistoricalSourceSliceRepair(base);
    const plan = JSON.parse(readFileSync(out, "utf8")) as {
      state: string; planHash: string; next?: { manifestId?: string };
    };
    assert(plan.state === "repairable" && plan.next?.manifestId === TARGET_MANIFEST,
      "dry run must identify the exact target");
    const before = await sql.query<{ n: number }>(`
      SELECT COUNT(*)::int AS n FROM meta_authoritative_slice_versions
      WHERE business_id=$1 AND provider_account_id=$2 AND day=$3::date
        AND surface='ad_daily'
    `, [BUSINESS, ACCOUNT, DAY]);
    assert(before[0]?.n === 1, "dry run wrote a slice");
    process.env.ADSECUTE_META_SLICE_REPAIR_APPLY = "1";
    await runHistoricalSourceSliceRepair({ ...base, apply: true,
      expectedHash: plan.planHash });
    const after = await sql.query<{
      slice_id: string; manifest_id: string; reason: string;
    }>(`
      SELECT pointer.active_slice_version_id::text AS slice_id,
        slice.manifest_id::text AS manifest_id,
        pointer.publication_reason AS reason
      FROM meta_authoritative_publication_pointers pointer
      JOIN meta_authoritative_slice_versions slice
        ON slice.id=pointer.active_slice_version_id
      WHERE pointer.business_id=$1 AND pointer.provider_account_id=$2
        AND pointer.day=$3::date AND pointer.surface='ad_daily'
    `, [BUSINESS, ACCOUNT, DAY]);
    assert(after[0]?.manifest_id === TARGET_MANIFEST &&
      after[0]?.slice_id !== oldSlice.id &&
      after[0]?.reason === "manifest_rebind_repair", "apply pointer readback mismatch");
    const fact = await sql.query<{ n: number; spend: number; raw_id: string }>(`
      SELECT COUNT(*)::int AS n, SUM(spend)::float8 AS spend,
        MIN(source_snapshot_id::text) AS raw_id
      FROM meta_ad_daily WHERE business_id=$1 AND provider_account_id=$2
        AND date=$3::date
    `, [BUSINESS, ACCOUNT, DAY]);
    assert(fact[0]?.n === 1 && fact[0]?.spend === 50 && fact[0]?.raw_id === RAW,
      "apply changed the Ad fact");
    const prior = await sql.query<{ status: string }>(`
      SELECT status FROM meta_authoritative_slice_versions WHERE id=$1::uuid
    `, [oldSlice.id]);
    assert(prior[0]?.status === "superseded", "old slice not preserved as superseded");
    await runHistoricalSourceSliceRepair({ ...base,
      cutoff: new Date().toISOString(), out: join(temp, "after.json") });
    const repeat = JSON.parse(readFileSync(join(temp, "after.json"), "utf8")) as {
      state: string;
    };
    assert(repeat.state === "already_bound", "rerun was not idempotent");
    console.log("historical source slice repair real-PG seam: PASS");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
