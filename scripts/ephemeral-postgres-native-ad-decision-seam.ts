import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { Client } from "pg";

import type { DbClient } from "@/lib/db";
import { NATIVE_AD_DECISION_SCHEMA_SQL } from "@/lib/creative-decision-engine/ad-evaluation-schema";
import {
  AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
  HYDRATE_AD_DECISION_INPUTS_QUERY,
  READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
  READ_AD_ENTITY_STATE_AS_OF_QUERY,
  hashAdDecisionIdentityManifest,
  type AdDecisionHydrationReceipt,
} from "@/lib/creative-decision-engine/data-source";
import {
  INSERT_AD_DECISION_EVALUATIONS_QUERY,
  inspectEvaluationStoreSchemaCapability,
} from "@/lib/creative-decision-engine/evaluation-store";
import { AD_CALIBRATION_JOB_NAME } from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import {
  pruneStaleNativeAdSnapshots,
  reconcileNativeAdDecisionChangeEvents,
  upsertNativeAdDecisionSnapshots,
  type NativeDecisionChangeEventPayloadRow,
  type NativeSnapshotPayloadRow,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { hasReusableNativeCalibration } from "@/lib/creative-decision-engine/jobs/native-ad-scheduled";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const BUSINESS_ID = "00000000-0000-4000-8000-000000000901";
const ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000902";
const ACCOUNT_ID = "act_native_seam";
const AS_OF = "2026-07-12";
const CUTOFF = `${AS_OF}T03:15:00.000Z`;
const CALIBRATION_ID = "00000000-0000-4000-8000-000000000903";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectPostgresError(
  operation: () => Promise<unknown>,
  expectedCode: string,
  label: string,
) {
  try {
    await operation();
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === expectedCode) return;
    throw error;
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

function resolvePgBinDir() {
  const required = ["initdb", "pg_ctl", "createdb"];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((directory) =>
    required.every((binary) => fs.existsSync(path.join(directory, binary))),
  );
  if (!found) {
    throw new Error(
      `PostgreSQL binaries not found in ${candidates.join(", ")}.`,
    );
  }
  return found;
}

async function freePort() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          address && typeof address === "object"
            ? resolve(address.port)
            : reject(new Error("Could not allocate an ephemeral port.")),
        );
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("Could not allocate a safe ephemeral PostgreSQL port.");
}

function run(binary: string, args: string[], label: string) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status}). ${result.stderr?.trim() ?? ""}`,
    );
  }
}

function dbClient(client: Client): DbClient {
  const query = async <T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => (await client.query<T>(text, params)).rows;
  return Object.assign(async () => [], { query }) as unknown as DbClient;
}

async function createBaseSchema(client: Client) {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE businesses (id UUID PRIMARY KEY);
    CREATE TABLE provider_accounts (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      external_account_id TEXT NOT NULL,
      timezone TEXT,
      currency TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (id, provider, external_account_id)
    );
    CREATE TABLE business_provider_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL,
      UNIQUE (business_id, provider_account_ref_id, provider_account_id)
    );
    CREATE TABLE engine_v3_job_runs (
      id UUID PRIMARY KEY,
      job_name TEXT NOT NULL,
      business_ref_id UUID NOT NULL,
      business_id TEXT,
      as_of_date DATE NOT NULL,
      engine_version TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      error_json JSONB
    );
    CREATE TABLE engine_v3_ad_account_calibration_daily (
      id UUID PRIMARY KEY,
      business_ref_id UUID NOT NULL,
      business_id TEXT NOT NULL,
      provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL,
      as_of_date DATE NOT NULL,
      engine_version TEXT NOT NULL
    );
    CREATE TABLE engine_v3_ad_account_calibration_batches (
      id UUID PRIMARY KEY,
      business_ref_id UUID NOT NULL,
      business_id TEXT NOT NULL,
      provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL,
      as_of_date DATE NOT NULL,
      as_of_cutoff TIMESTAMPTZ NOT NULL,
      engine_version TEXT NOT NULL,
      completeness_status TEXT NOT NULL
    );
    CREATE TABLE business_target_pack_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL
    );
  `);
  await client.query(`INSERT INTO businesses (id) VALUES ($1)`, [BUSINESS_ID]);
  await client.query(
    `INSERT INTO provider_accounts (
       id, provider, external_account_id, timezone, currency
     ) VALUES ($1, 'meta', $2, 'Europe/Istanbul', 'USD')`,
    [ACCOUNT_REF_ID, ACCOUNT_ID],
  );
  await client.query(
    `INSERT INTO business_provider_accounts (
       business_id, provider, provider_account_ref_id, provider_account_id
     ) VALUES ($1, 'meta', $2, $3)`,
    [BUSINESS_ID, ACCOUNT_REF_ID, ACCOUNT_ID],
  );
  await client.query(
    `INSERT INTO engine_v3_ad_account_calibration_daily (
       id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, as_of_date, engine_version
     ) VALUES ($1, $2::uuid, $2::text, $3, $4, $5, $6)`,
    [
      CALIBRATION_ID,
      BUSINESS_ID,
      ACCOUNT_REF_ID,
      ACCOUNT_ID,
      AS_OF,
      NATIVE_AD_ENGINE_VERSION,
    ],
  );
}

async function verifyCalibrationReuseAccountIdentity(
  client: Client,
  db: DbClient,
) {
  const businessId = "00000000-0000-4000-8000-000000000980";
  const calibratedAccountRefId = "00000000-0000-4000-8000-000000000981";
  const replacementAccountRefId = "00000000-0000-4000-8000-000000000982";
  await client.query(`INSERT INTO businesses (id) VALUES ($1)`, [businessId]);
  await client.query(
    `INSERT INTO provider_accounts (
       id, provider, external_account_id, timezone, currency
     ) VALUES
       ($1, 'meta', 'act_calibrated', 'UTC', 'USD'),
       ($2, 'meta', 'act_replacement', 'UTC', 'USD')`,
    [calibratedAccountRefId, replacementAccountRefId],
  );
  await client.query(
    `INSERT INTO business_provider_accounts (
       business_id, provider, provider_account_ref_id, provider_account_id
     ) VALUES ($1::text, 'meta', $2, 'act_calibrated')`,
    [businessId, calibratedAccountRefId],
  );
  const batchId = "00000000-0000-4000-8000-000000000983";
  await client.query(
    `INSERT INTO engine_v3_ad_account_calibration_batches (
       id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, as_of_date, as_of_cutoff, engine_version,
       completeness_status
     ) VALUES (
       $1::uuid, $2::uuid, $2::text, $3::uuid, 'act_calibrated', $4::date,
       $5::timestamptz, $6, 'complete'
     )`,
    [
      batchId,
      businessId,
      calibratedAccountRefId,
      AS_OF,
      CUTOFF,
      NATIVE_AD_ENGINE_VERSION,
    ],
  );
  const oldBatchId = "00000000-0000-4000-8000-000000000985";
  await client.query(
    `INSERT INTO engine_v3_ad_account_calibration_batches (
       id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, as_of_date, as_of_cutoff, engine_version,
       completeness_status
     ) VALUES (
       $1::uuid, $2::uuid, $2::text, $3::uuid, 'act_replacement', $4::date,
       '2026-07-12T03:14:00.000Z', $5, 'complete'
     )`,
    [
      oldBatchId,
      businessId,
      replacementAccountRefId,
      AS_OF,
      NATIVE_AD_ENGINE_VERSION,
    ],
  );
  await client.query(
    `INSERT INTO engine_v3_job_runs (
       id, job_name, business_ref_id, business_id, as_of_date,
       engine_version, status, started_at, finished_at, error_json
     ) VALUES (
       $1::uuid, $2, $3::uuid, $3::text, $4::date, $5, 'success',
       '2026-07-12T03:14:00.000Z', '2026-07-12T03:14:00.000Z', $6::jsonb
     )`,
    [
      "00000000-0000-4000-8000-000000000986",
      AD_CALIBRATION_JOB_NAME,
      businessId,
      AS_OF,
      NATIVE_AD_ENGINE_VERSION,
      JSON.stringify({
        metadata: {
          batches: [
            {
              batch_id: oldBatchId,
              provider_account_ref_id: replacementAccountRefId,
              provider_account_id: "act_replacement",
            },
          ],
        },
      }),
    ],
  );
  await client.query(
    `INSERT INTO engine_v3_job_runs (
       id, job_name, business_ref_id, business_id, as_of_date,
       engine_version, status, started_at, finished_at, error_json
     ) VALUES (
       $1::uuid, $2, $3::uuid, $3::text, $4::date,
       $5, 'success', $6::timestamptz, $6::timestamptz, $7::jsonb
     )`,
    [
      "00000000-0000-4000-8000-000000000984",
      AD_CALIBRATION_JOB_NAME,
      businessId,
      AS_OF,
      NATIVE_AD_ENGINE_VERSION,
      CUTOFF,
      JSON.stringify({
        metadata: {
          batches: [
            {
              batch_id: batchId,
              provider_account_ref_id: calibratedAccountRefId,
              provider_account_id: "act_calibrated",
            },
          ],
        },
      }),
    ],
  );

  const input = {
    businessId,
    asOf: AS_OF,
    decisionCutoff: CUTOFF,
  };
  assert(
    await hasReusableNativeCalibration(input, db),
    "Matching calibrated and assigned account identities were not reusable.",
  );

  await client.query(
    `UPDATE business_provider_accounts
     SET provider_account_id = 'act_corrected'
     WHERE business_id = $1::text AND provider = 'meta'`,
    [businessId],
  );
  assert(
    !(await hasReusableNativeCalibration(input, db)),
    "Same-ref external account correction incorrectly reused the previous calibration.",
  );

  await client.query(
    `UPDATE business_provider_accounts
     SET provider_account_ref_id = $2, provider_account_id = 'act_replacement'
     WHERE business_id = $1::text AND provider = 'meta'`,
    [businessId, replacementAccountRefId],
  );
  assert(
    !(await hasReusableNativeCalibration(input, db)),
    "Same-count account replacement incorrectly reused the previous account calibration.",
  );
}

async function createHydrationSourceSchema(client: Client) {
  await client.query(`
    CREATE TABLE meta_ad_daily (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL, date DATE NOT NULL, ad_id TEXT NOT NULL,
      ad_name_current TEXT, campaign_id TEXT, adset_id TEXT,
      account_timezone TEXT, account_currency TEXT, truth_state TEXT NOT NULL,
      validation_status TEXT NOT NULL, spend DOUBLE PRECISION,
      conversions DOUBLE PRECISION, revenue DOUBLE PRECISION,
      impressions DOUBLE PRECISION, link_clicks DOUBLE PRECISION,
      clicks DOUBLE PRECISION, reach DOUBLE PRECISION,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_ad_dimensions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL, ad_id TEXT NOT NULL,
      ad_name_current TEXT, creative_id TEXT, campaign_id TEXT, adset_id TEXT,
      ad_status TEXT, first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_creative_dimensions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL, creative_id TEXT NOT NULL,
      creative_name TEXT, asset_type TEXT, created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_adset_daily (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL, date DATE NOT NULL, adset_id TEXT NOT NULL,
      optimization_goal TEXT, custom_event_type TEXT, truth_state TEXT NOT NULL,
      validation_status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_campaign_daily (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL, date DATE NOT NULL, campaign_id TEXT NOT NULL,
      objective TEXT, optimization_goal TEXT, custom_event_type TEXT,
      truth_state TEXT NOT NULL, validation_status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_adset_config_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL, adset_id TEXT NOT NULL,
      optimization_goal TEXT, custom_event_type TEXT,
      captured_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_campaign_config_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id TEXT NOT NULL,
      provider_account_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
      objective TEXT, optimization_goal TEXT, custom_event_type TEXT,
      captured_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE meta_entity_observation_runs (
      id UUID PRIMARY KEY, business_ref_id UUID NOT NULL,
      business_id TEXT NOT NULL, provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      endpoint TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL, completeness TEXT NOT NULL,
      page_count INTEGER NOT NULL, row_count INTEGER NOT NULL,
      source_snapshot_id TEXT, payload_hash CHAR(64), run_hash CHAR(64) NOT NULL,
      error_json JSONB, created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE engine_v3_creative_lifecycle_daily (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_ref_id UUID NOT NULL,
      creative_id TEXT NOT NULL, as_of_date DATE NOT NULL, engine_version TEXT NOT NULL,
      computed_at TIMESTAMPTZ NOT NULL, source_max_updated_at TIMESTAMPTZ,
      lifecycle_position TEXT, days_since_peak INTEGER, peak_roas_30d DOUBLE PRECISION,
      peak_confidence DOUBLE PRECISION, spend_trajectory_30d TEXT,
      spend_slope_7d DOUBLE PRECISION, spend_slope_30d DOUBLE PRECISION,
      roas_slope_7d DOUBLE PRECISION, roas_slope_30d DOUBLE PRECISION,
      fatigue_status TEXT, quality_ranking TEXT, engagement_rate_ranking TEXT,
      conversion_rate_ranking TEXT, creative_format TEXT
    );
    CREATE TABLE meta_entity_state_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), run_id UUID,
      business_ref_id UUID NOT NULL, business_id TEXT NOT NULL,
      provider_account_ref_id UUID NOT NULL, provider_account_id TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, entity_name TEXT,
      campaign_id TEXT, adset_id TEXT, creative_id TEXT, configured_status TEXT,
      effective_status TEXT, review_status TEXT, policy_status TEXT,
      policy_reasons_json JSONB, observed_at TIMESTAMPTZ NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      run_completeness TEXT NOT NULL, presence TEXT NOT NULL
    );
    CREATE TABLE meta_entity_tombstones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_ref_id UUID NOT NULL,
      business_id TEXT NOT NULL, provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, reason TEXT NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL, captured_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);
}

async function verifyHydrationReceiptCaptureAxis(client: Client) {
  const sourceRunId = "00000000-0000-4000-8000-000000000904";
  const sourceObservedAt = `${AS_OF}T03:00:00.000Z`;
  const sourceCapturedAt = `${AS_OF}T03:00:05.000Z`;
  await client.query(
    `INSERT INTO meta_entity_observation_runs (
       id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, endpoint, observed_at, captured_at,
       completeness, page_count, row_count, payload_hash, run_hash, created_at
     ) VALUES ($1, $2::uuid, $2::text, $3, $4, 'ad', 'ad_configs', $5, $6,
       'complete', 1, 2, $7, $8, $6)`,
    [
      sourceRunId,
      BUSINESS_ID,
      ACCOUNT_REF_ID,
      ACCOUNT_ID,
      sourceObservedAt,
      sourceCapturedAt,
      "b".repeat(64),
      "a".repeat(64),
    ],
  );
  await client.query(
    `INSERT INTO meta_entity_state_history (
       run_id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, entity_id, creative_id,
       effective_status, observed_at, captured_at, created_at,
       run_completeness, presence
     ) VALUES
       ($1, $2::uuid, $2::text, $3, $4, 'ad', 'ad-old-provider-update',
        'creative-old', 'ACTIVE', '2026-06-01T00:00:00Z', $5, $5,
        'complete', 'present'),
       ($1, $2::uuid, $2::text, $3, $4, 'ad', 'ad-later-tombstone',
        'creative-tombstone', 'ACTIVE', '2026-06-02T00:00:00Z', $5, $5,
        'complete', 'present')`,
    [sourceRunId, BUSINESS_ID, ACCOUNT_REF_ID, ACCOUNT_ID, sourceCapturedAt],
  );
  await client.query(
    `INSERT INTO meta_entity_tombstones (
       business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, entity_id, reason,
       observed_at, captured_at, created_at
     ) VALUES ($1::uuid, $1::text, $2, $3, 'ad', 'ad-later-tombstone',
       'explicit_not_found', $4, $4, $4)`,
    [BUSINESS_ID, ACCOUNT_REF_ID, ACCOUNT_ID, `${AS_OF}T03:05:00.000Z`],
  );

  const receipt = await client.query<{
    source_run_id: string;
    source_expected_row_count: number;
    source_persisted_row_count: number;
    expected_ad_ids: string[];
  }>(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY, [
    BUSINESS_ID,
    AS_OF,
    CUTOFF,
    [],
    false,
  ]);
  assert(
    receipt.rows.length === 1,
    "Hydration receipt account row is missing.",
  );
  assert(
    receipt.rows[0]?.source_run_id === sourceRunId &&
      receipt.rows[0]?.source_expected_row_count === 2 &&
      receipt.rows[0]?.source_persisted_row_count === 2,
    "Hydration receipt lost complete-run lineage.",
  );
  assert(
    JSON.stringify(receipt.rows[0]?.expected_ad_ids) ===
      JSON.stringify(["ad-old-provider-update"]),
    "Hydration receipt dropped an old provider update or ignored a later tombstone.",
  );
}

async function verifyTombstoneAndHistoricalCutoff(client: Client) {
  await client.query(
    `INSERT INTO meta_entity_state_history (
       business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, entity_id, creative_id,
       effective_status, observed_at, captured_at, created_at,
       run_completeness, presence
     ) VALUES ($1::uuid, $1::text, $2, $3, 'ad', 'ad-tombstone', 'creative-old',
       'ACTIVE', $4, $4, $4, 'complete', 'present')`,
    [BUSINESS_ID, ACCOUNT_REF_ID, ACCOUNT_ID, `${AS_OF}T02:00:00.000Z`],
  );
  await client.query(
    `INSERT INTO meta_entity_tombstones (
       business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, entity_id, reason,
       observed_at, captured_at, created_at
     ) VALUES ($1::uuid, $1::text, $2, $3, 'ad', 'ad-tombstone',
       'explicit_not_found', $4, $4, $4)`,
    [BUSINESS_ID, ACCOUNT_REF_ID, ACCOUNT_ID, `${AS_OF}T02:00:00.000Z`],
  );
  const tombstone = await client.query<{ event_kind: string }>(
    READ_AD_ENTITY_STATE_AS_OF_QUERY,
    [BUSINESS_ID, ACCOUNT_ID, ["ad-tombstone"], CUTOFF],
  );
  assert(
    tombstone.rows[0]?.event_kind === "tombstone",
    "Equal-cutoff tombstone did not win over the present state.",
  );

  await client.query(
    `INSERT INTO meta_ad_daily (
       business_id, provider_account_id, date, ad_id, ad_name_current,
       account_timezone, account_currency, truth_state, validation_status,
       spend, conversions, revenue, impressions, link_clicks, clicks, reach,
       created_at, updated_at
     ) VALUES ($1, $2, '2026-07-10', 'ad-historical', 'Historical ad',
       'Europe/Istanbul', 'USD', 'finalized', 'passed', 100, 2, 250,
       1000, 20, 25, 800, '2026-07-10T01:00:00Z', '2026-07-10T02:00:00Z')`,
    [BUSINESS_ID, ACCOUNT_ID],
  );
  await client.query(
    `INSERT INTO meta_ad_dimensions (
       business_id, provider_account_id, ad_id, ad_name_current, creative_id,
       campaign_id, adset_id, ad_status, first_seen_at, last_seen_at,
       created_at, updated_at
     ) VALUES ($1, $2, 'ad-historical', 'Current dimension', 'creative-current',
       'campaign-current', 'adset-current', 'ACTIVE', '2026-06-01',
       '2026-07-12', '2026-06-01', '2026-07-10T02:00:00Z')`,
    [BUSINESS_ID, ACCOUNT_ID],
  );
  await client.query(
    `INSERT INTO meta_creative_dimensions (
       business_id, provider_account_id, creative_id, creative_name,
       asset_type, created_at, updated_at
     ) VALUES ($1, $2, 'creative-current', 'Current creative', 'video',
       '2026-06-01', '2026-07-10T02:00:00Z')`,
    [BUSINESS_ID, ACCOUNT_ID],
  );
  const historical = await client.query<{
    creative_id: string | null;
    current_dimension_id: string | null;
    current_ad_status: string | null;
    lifecycle_row_id: string | null;
  }>(HYDRATE_AD_DECISION_INPUTS_QUERY, [
    BUSINESS_ID,
    "2026-07-10",
    [],
    false,
    [],
    false,
    2,
    1.5,
    "2026-07-10T02:00:00.000Z",
    "legacy-creative-engine",
    "2026-07-10T03:15:00.000Z",
    false,
    "[]",
  ]);
  assert(historical.rows.length === 1, "Historical metric ad disappeared.");
  assert(
    historical.rows[0]?.creative_id === null &&
      historical.rows[0]?.current_dimension_id === null &&
      historical.rows[0]?.current_ad_status === null &&
      historical.rows[0]?.lifecycle_row_id === null,
    "Historical hydration leaked current dimension/creative/lifecycle state.",
  );
}

async function verifyCurrentIdentityAndConfigFallback(client: Client) {
  const adId = "ad-current-context";
  const campaignId = "campaign-current-context";
  const adsetId = "adset-current-context";
  await client.query(
    `INSERT INTO meta_ad_daily (
       business_id, provider_account_id, date, ad_id, ad_name_current,
       campaign_id, adset_id, account_timezone, account_currency,
       truth_state, validation_status, spend, conversions, revenue,
       impressions, link_clicks, clicks, reach, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'Current context ad', $5, $6, 'UTC', 'USD',
       'finalized', 'passed', 100, 2, 250, 1000, 20, 25, 800,
       '2026-07-12T01:00:00Z', '2026-07-12T02:00:00Z')`,
    [BUSINESS_ID, ACCOUNT_ID, AS_OF, adId, campaignId, adsetId],
  );
  await client.query(
    `INSERT INTO meta_campaign_config_history (
       business_id, provider_account_id, campaign_id, objective,
       optimization_goal, custom_event_type, captured_at, created_at
     ) VALUES
       ($1, $2, $3, 'OUTCOME_SALES', 'OFFSITE_CONVERSIONS', 'PURCHASE',
        '2026-07-12T02:30:00Z', '2026-07-12T02:30:00Z'),
       ($1, $2, $3, 'OUTCOME_ENGAGEMENT', 'THRUPLAY', 'VIDEO_VIEW',
        '2026-07-12T04:00:00Z', '2026-07-12T04:00:00Z')`,
    [BUSINESS_ID, ACCOUNT_ID, campaignId],
  );
  await client.query(
    `INSERT INTO meta_adset_config_history (
       business_id, provider_account_id, adset_id, optimization_goal,
       custom_event_type, captured_at, created_at
     ) VALUES
       ($1, $2, $3, 'OFFSITE_CONVERSIONS', 'PURCHASE',
        '2026-07-12T02:30:00Z', '2026-07-12T02:30:00Z'),
       ($1, $2, $3, 'THRUPLAY', 'VIDEO_VIEW',
        '2026-07-12T04:00:00Z', '2026-07-12T04:00:00Z')`,
    [BUSINESS_ID, ACCOUNT_ID, adsetId],
  );

  const params = [
    BUSINESS_ID,
    AS_OF,
    [],
    false,
    [adId],
    true,
    2,
    1.5,
    CUTOFF,
    "legacy-creative-engine",
    CUTOFF,
  ];
  const current = await client.query<{
    account_timezone: string | null;
    objective: string | null;
    optimization_goal: string | null;
    custom_event_type: string | null;
    context_identity_unknown: boolean;
  }>(HYDRATE_AD_DECISION_INPUTS_QUERY, [...params, true, "[]"]);
  assert(current.rows.length === 1, "Current config fallback ad disappeared.");
  assert(
    current.rows[0]?.account_timezone === "Europe/Istanbul",
    "Current hydration did not prefer canonical provider timezone.",
  );
  assert(
    current.rows[0]?.objective === "OUTCOME_SALES" &&
      current.rows[0]?.optimization_goal === "OFFSITE_CONVERSIONS" &&
      current.rows[0]?.custom_event_type === "PURCHASE" &&
      current.rows[0]?.context_identity_unknown === false,
    "Current hydration did not recover cutoff-safe hierarchy config.",
  );

  const historical = await client.query<{
    account_timezone: string | null;
    objective: string | null;
    optimization_goal: string | null;
    context_identity_unknown: boolean;
  }>(HYDRATE_AD_DECISION_INPUTS_QUERY, [...params, false, "[]"]);
  assert(historical.rows.length === 1, "Historical fallback ad disappeared.");
  assert(
    historical.rows[0]?.account_timezone === "UTC" &&
      historical.rows[0]?.objective === null &&
      historical.rows[0]?.optimization_goal === null &&
      historical.rows[0]?.context_identity_unknown === true,
    "Historical hydration leaked present-day provider/config state.",
  );
}

async function insertLineage(
  client: Client,
  input: { jobRunId: string; adId: string; marker: string },
) {
  await client.query(
    `INSERT INTO engine_v3_job_runs (
       id, job_name, business_ref_id, business_id, as_of_date,
       engine_version, status
     ) VALUES ($1, 'native-seam', $2::uuid, $2::text, $3, $4, 'success')`,
    [input.jobRunId, BUSINESS_ID, AS_OF, NATIVE_AD_ENGINE_VERSION],
  );
  const context = await client.query<{ id: string }>(
    `INSERT INTO engine_v3_ad_decision_evaluation_contexts (
       business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, as_of_date, engine_version, scope_type, scope_id,
       contract_version, context_json, account_profile_json, data_health_json,
       flags_json, context_hash, job_run_id, evaluated_at
     ) VALUES ($1::uuid, $1::text, $2, $3, $4, $5, 'account', $3, 'seam.v1',
       '{}', '{}', '{}', '{}', $6, $7, $8) RETURNING id`,
    [
      BUSINESS_ID,
      ACCOUNT_REF_ID,
      ACCOUNT_ID,
      AS_OF,
      NATIVE_AD_ENGINE_VERSION,
      input.marker.repeat(64),
      input.jobRunId,
      CUTOFF,
    ],
  );
  const evaluation = await client.query<{ id: string }>(
    `INSERT INTO engine_v3_ad_decision_evaluations (
       context_id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, decision_entity_type, decision_entity_id, ad_id,
       creative_id, as_of_date, engine_version, scope_type, scope_id,
       contract_version, creative_input_json, campaign_context_json,
       prior_hysteresis_json, decision_output_json, raw_label,
       hysteresis_suppressed, input_hash, decision_hash, job_run_id, evaluated_at
     ) VALUES ($1, $2::uuid, $2::text, $3, $4, 'ad', $5, $5, NULL, $6, $7,
       'account', $4, 'seam.v1', '{}', '{}', '{}', '{}', 'keep', false,
       $8, $9, $10, $11) RETURNING id`,
    [
      context.rows[0]!.id,
      BUSINESS_ID,
      ACCOUNT_REF_ID,
      ACCOUNT_ID,
      input.adId,
      AS_OF,
      NATIVE_AD_ENGINE_VERSION,
      input.marker.repeat(64),
      (input.marker === "a" ? "b" : "d").repeat(64),
      input.jobRunId,
      CUTOFF,
    ],
  );
  return {
    evaluationId: evaluation.rows[0]!.id,
    inputHash: input.marker.repeat(64),
    decisionHash: (input.marker === "a" ? "b" : "d").repeat(64),
  };
}

async function verifyFirstWriteEvaluationLinkage(client: Client) {
  const jobRunId = "00000000-0000-4000-8000-000000000940";
  await client.query(
    `INSERT INTO engine_v3_job_runs (
       id, job_name, business_ref_id, business_id, as_of_date,
       engine_version, status
     ) VALUES ($1, 'native-evaluation-linkage-seam', $2::uuid, $2::text,
       $3, $4, 'success')`,
    [jobRunId, BUSINESS_ID, AS_OF, NATIVE_AD_ENGINE_VERSION],
  );
  const context = await client.query<{ id: string }>(
    `INSERT INTO engine_v3_ad_decision_evaluation_contexts (
       business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, as_of_date, engine_version, scope_type, scope_id,
       contract_version, context_json, account_profile_json, data_health_json,
       flags_json, context_hash, job_run_id, evaluated_at
     ) VALUES ($1::uuid, $1::text, $2, $3, $4, $5, 'account', $3,
       'seam.v1', '{}', '{}', '{}', '{}', $6, $7, $8) RETURNING id`,
    [
      BUSINESS_ID,
      ACCOUNT_REF_ID,
      ACCOUNT_ID,
      AS_OF,
      NATIVE_AD_ENGINE_VERSION,
      "9".repeat(64),
      jobRunId,
      CUTOFF,
    ],
  );
  const payload = [
    {
      context_id: context.rows[0]!.id,
      business_ref_id: BUSINESS_ID,
      business_id: BUSINESS_ID,
      provider_account_ref_id: ACCOUNT_REF_ID,
      provider_account_id: ACCOUNT_ID,
      decision_entity_type: "ad",
      decision_entity_id: "ad-first-write-linkage",
      ad_id: "ad-first-write-linkage",
      creative_id: "creative-first-write-linkage",
      as_of_date: AS_OF,
      engine_version: NATIVE_AD_ENGINE_VERSION,
      scope_type: "account",
      scope_id: ACCOUNT_ID,
      contract_version: "seam.v1",
      creative_input_json: {},
      campaign_context_json: {},
      prior_hysteresis_json: {},
      decision_output_json: {},
      raw_label: "keep",
      hysteresis_suppressed: false,
      input_hash: "7".repeat(64),
      decision_hash: "8".repeat(64),
      job_run_id: jobRunId,
      evaluated_at: CUTOFF,
    },
  ];
  const first = await client.query<{
    id: string;
    decision_entity_id: string;
  }>(INSERT_AD_DECISION_EVALUATIONS_QUERY, [JSON.stringify(payload)]);
  assert(
    first.rows.length === 1 && Boolean(first.rows[0]?.id),
    "First evaluation write did not return its immutable linkage row.",
  );
  const retry = await client.query<{ id: string }>(
    INSERT_AD_DECISION_EVALUATIONS_QUERY,
    [JSON.stringify(payload)],
  );
  assert(
    retry.rows.length === 1 && retry.rows[0]?.id === first.rows[0]?.id,
    "Idempotent evaluation retry did not resolve the existing linkage row.",
  );
  const mixedPayload = [
    ...payload,
    {
      ...payload[0]!,
      decision_entity_id: "ad-mixed-new-linkage",
      ad_id: "ad-mixed-new-linkage",
      creative_id: "creative-mixed-new-linkage",
      input_hash: "5".repeat(64),
      decision_hash: "6".repeat(64),
    },
  ];
  const mixed = await client.query<{
    id: string;
    decision_entity_id: string;
  }>(INSERT_AD_DECISION_EVALUATIONS_QUERY, [JSON.stringify(mixedPayload)]);
  assert(
    mixed.rows.length === 2 &&
      new Set(mixed.rows.map((row) => row.decision_entity_id)).size === 2,
    "Mixed existing/new evaluation batch did not resolve every linkage row.",
  );
  const count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM engine_v3_ad_decision_evaluations
     WHERE job_run_id = $1`,
    [jobRunId],
  );
  assert(
    count.rows[0]?.count === "2",
    "Idempotent evaluation retry created duplicate rows.",
  );
}

function snapshotPayload(input: {
  jobRunId: string;
  adId: string;
  evaluationId: string;
  inputHash: string;
  decisionHash: string;
  label: "diagnose" | "keep" | "cut";
}): NativeSnapshotPayloadRow {
  const hard = input.label === "cut";
  const soft = input.label === "diagnose";
  return {
    business_ref_id: BUSINESS_ID,
    business_id: BUSINESS_ID,
    provider_account_ref_id: ACCOUNT_REF_ID,
    provider_account_id: ACCOUNT_ID,
    decision_entity_type: "ad",
    decision_entity_id: input.adId,
    ad_id: input.adId,
    creative_id: null,
    as_of_date: AS_OF,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: ACCOUNT_ID,
    label: input.label,
    raw_label: input.label,
    pre_authority_label: input.label,
    authority_blocker: soft ? "native_profile_unavailable" : null,
    confidence: soft ? 0 : hard ? 80 : 60,
    truth_source: soft ? "global_default" : "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: null,
    badges: soft
      ? [
          {
            type: "native_calibration_unavailable",
            label: "Native calibration is unavailable.",
            severity: "warning",
          },
        ]
      : [],
    reason: "Native seam row.",
    spend: 0,
    purchases: 0,
    roas: null,
    recent7d_roas: null,
    label_transform: null,
    blocked_action_type: null,
    authorized_action: hard ? "cut" : null,
    job_run_id: input.jobRunId,
    creative_evidence_lifecycle_row_id: null,
    calibration_row_id: soft ? null : CALIBRATION_ID,
    evaluation_id: input.evaluationId,
    input_hash: input.inputHash,
    decision_hash: input.decisionHash,
    computed_at: CUTOFF,
  };
}

function receipt(
  adIds: string[],
  authoritative: boolean,
): AdDecisionHydrationReceipt {
  const ids = [...adIds].sort();
  const hash = hashAdDecisionIdentityManifest({
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    asOfDate: AS_OF,
    adIds: ids,
  });
  return {
    contractVersion: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
    businessId: BUSINESS_ID,
    providerAccountRefId: ACCOUNT_REF_ID,
    providerAccountId: ACCOUNT_ID,
    scopeType: "account",
    scopeId: ACCOUNT_ID,
    asOfDate: AS_OF,
    decisionCutoff: CUTOFF,
    sourceRunId: "00000000-0000-4000-8000-000000000999",
    sourceObservedAt: `${AS_OF}T02:00:00.000Z`,
    sourceCapturedAt: `${AS_OF}T02:01:00.000Z`,
    sourceRunHash: "f".repeat(64),
    sourcePayloadHash: "e".repeat(64),
    sourceExpectedRowCount: ids.length,
    sourcePersistedRowCount: ids.length,
    expectedAdCount: ids.length,
    expectedAdIds: ids,
    expectedManifestHash: hash,
    hydratedAdCount: ids.length,
    hydratedManifestHash: hash,
    sourceComplete: authoritative,
    hydrationComplete: authoritative,
    authoritativeForPrune: authoritative,
    reason: authoritative ? null : "partial_source_receipt",
  };
}

function computationIdentity(adId: string) {
  return {
    input: {
      providerAccountRefId: ACCOUNT_REF_ID,
      providerAccountId: ACCOUNT_ID,
      decisionEntityId: adId,
      adId,
    },
  } as never;
}

function eventPayload(input: {
  jobRunId: string;
  adId: string;
  snapshotId: string;
  previous: "diagnose" | "keep";
  current: "keep" | "cut";
  previousConfidence: number;
  currentConfidence: number;
}): NativeDecisionChangeEventPayloadRow {
  return {
    business_ref_id: BUSINESS_ID,
    business_id: BUSINESS_ID,
    provider_account_ref_id: ACCOUNT_REF_ID,
    provider_account_id: ACCOUNT_ID,
    decision_entity_type: "ad",
    decision_entity_id: input.adId,
    ad_id: input.adId,
    creative_id: null,
    event_date: AS_OF,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: ACCOUNT_ID,
    previous_label: input.previous,
    current_label: input.current,
    previous_confidence: input.previousConfidence,
    current_confidence: input.currentConfidence,
    previous_decision_snapshot_id: "00000000-0000-4000-8000-000000000998",
    decision_snapshot_id: input.snapshotId,
    job_run_id: input.jobRunId,
  };
}

async function verifyPruneRetryAndConstraints(client: Client, db: DbClient) {
  const pruneLineage = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000910",
    adId: "ad-prune",
    marker: "a",
  });
  await upsertNativeAdDecisionSnapshots(
    [
      snapshotPayload({
        jobRunId: "00000000-0000-4000-8000-000000000910",
        adId: "ad-prune",
        label: "diagnose",
        ...pruneLineage,
      }),
    ],
    db,
  );
  await pruneStaleNativeAdSnapshots(
    {
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      scope: { type: "account", id: ACCOUNT_ID },
      currentInputs: [],
      receipt: receipt([], false),
    },
    db,
  );
  let count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM engine_v3_ad_decision_snapshots_daily
     WHERE decision_entity_id = 'ad-prune'`,
  );
  assert(count.rows[0]?.count === "1", "Partial receipt pruned authority.");
  await pruneStaleNativeAdSnapshots(
    {
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      scope: { type: "account", id: ACCOUNT_ID },
      currentInputs: [],
      receipt: receipt([], true),
    },
    db,
  );
  count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM engine_v3_ad_decision_snapshots_daily
     WHERE decision_entity_id = 'ad-prune'`,
  );
  assert(count.rows[0]?.count === "0", "Authoritative zero did not prune.");

  const first = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000920",
    adId: "ad-retry",
    marker: "b",
  });
  const firstSnapshots = await upsertNativeAdDecisionSnapshots(
    [
      snapshotPayload({
        jobRunId: "00000000-0000-4000-8000-000000000920",
        adId: "ad-retry",
        label: "keep",
        ...first,
      }),
    ],
    db,
  );
  const snapshotId = firstSnapshots.get(`${ACCOUNT_ID}:ad:ad-retry`)!.id;
  await reconcileNativeAdDecisionChangeEvents(
    {
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      scope: { type: "account", id: ACCOUNT_ID },
      decisions: [computationIdentity("ad-retry")],
      rows: [
        eventPayload({
          jobRunId: "00000000-0000-4000-8000-000000000920",
          adId: "ad-retry",
          snapshotId,
          previous: "diagnose",
          current: "keep",
          previousConfidence: 0,
          currentConfidence: 60,
        }),
      ],
    },
    db,
  );
  const second = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000921",
    adId: "ad-retry",
    marker: "c",
  });
  await upsertNativeAdDecisionSnapshots(
    [
      snapshotPayload({
        jobRunId: "00000000-0000-4000-8000-000000000921",
        adId: "ad-retry",
        label: "cut",
        ...second,
      }),
    ],
    db,
  );
  const replacement = eventPayload({
    jobRunId: "00000000-0000-4000-8000-000000000921",
    adId: "ad-retry",
    snapshotId,
    previous: "keep",
    current: "cut",
    previousConfidence: 60,
    currentConfidence: 80,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await reconcileNativeAdDecisionChangeEvents(
      {
        businessId: BUSINESS_ID,
        asOf: AS_OF,
        scope: { type: "account", id: ACCOUNT_ID },
        decisions: [computationIdentity("ad-retry")],
        rows: [replacement],
      },
      db,
    );
  }
  const events = await client.query<{
    previous_label: string;
    current_label: string;
    job_run_id: string;
  }>(
    `SELECT previous_label, current_label, job_run_id::text
     FROM engine_v3_ad_decision_events
     WHERE decision_entity_id = 'ad-retry' AND event_type = 'decision_changed'`,
  );
  assert(
    events.rows.length === 1 &&
      events.rows[0]?.previous_label === "keep" &&
      events.rows[0]?.current_label === "cut" &&
      events.rows[0]?.job_run_id === "00000000-0000-4000-8000-000000000921",
    "Same-day retry left contradictory change events.",
  );

  const invalid = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000930",
    adId: "ad-invalid-hard",
    marker: "e",
  });
  const invalidHard = snapshotPayload({
    jobRunId: "00000000-0000-4000-8000-000000000930",
    adId: "ad-invalid-hard",
    label: "cut",
    ...invalid,
  });
  invalidHard.calibration_row_id = null;
  await expectPostgresError(
    () => upsertNativeAdDecisionSnapshots([invalidHard], db),
    "23514",
    "null-calibration hard authority check",
  );

  const reviewOnly = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000931",
    adId: "ad-review-only-cut",
    marker: "f",
  });
  const reviewOnlyHard = snapshotPayload({
    jobRunId: "00000000-0000-4000-8000-000000000931",
    adId: "ad-review-only-cut",
    label: "cut",
    ...reviewOnly,
  });
  reviewOnlyHard.authority_blocker = "source_freshness";
  reviewOnlyHard.blocked_action_type = "cut";
  reviewOnlyHard.authorized_action = null;
  await upsertNativeAdDecisionSnapshots([reviewOnlyHard], db);
  const persistedReviewOnly = await client.query<{
    authority_blocker: string | null;
    authorized_action: string | null;
  }>(
    `SELECT authority_blocker, authorized_action
     FROM engine_v3_ad_decision_snapshots_daily
     WHERE decision_entity_id = 'ad-review-only-cut'`,
  );
  assert(
    persistedReviewOnly.rows[0]?.authority_blocker === "source_freshness" &&
      persistedReviewOnly.rows[0]?.authorized_action === null,
    "Review-only hard label did not persist with authority cleared.",
  );

  const pending = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000933",
    adId: "ad-pending-cut",
    marker: "1",
  });
  const pendingHard = snapshotPayload({
    jobRunId: "00000000-0000-4000-8000-000000000933",
    adId: "ad-pending-cut",
    label: "cut",
    ...pending,
  });
  pendingHard.label = "keep";
  pendingHard.blocked_action_type = "cut";
  pendingHard.authorized_action = null;
  pendingHard.badges = [
    {
      type: "pending_transition",
      label: "Hard action pending.",
      severity: "info",
    },
  ];
  await upsertNativeAdDecisionSnapshots([pendingHard], db);

  const pendingWithoutProof = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000934",
    adId: "ad-invalid-pending-cut",
    marker: "2",
  });
  const invalidPendingHard = snapshotPayload({
    jobRunId: "00000000-0000-4000-8000-000000000934",
    adId: "ad-invalid-pending-cut",
    label: "cut",
    ...pendingWithoutProof,
  });
  invalidPendingHard.label = "keep";
  invalidPendingHard.blocked_action_type = "cut";
  invalidPendingHard.authorized_action = null;
  await expectPostgresError(
    () => upsertNativeAdDecisionSnapshots([invalidPendingHard], db),
    "23514",
    "pending hard action requires explicit hysteresis proof",
  );

  const blockedButAuthorized = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000932",
    adId: "ad-invalid-blocked-authority",
    marker: "0",
  });
  const invalidBlockedAuthority = snapshotPayload({
    jobRunId: "00000000-0000-4000-8000-000000000932",
    adId: "ad-invalid-blocked-authority",
    label: "cut",
    ...blockedButAuthorized,
  });
  invalidBlockedAuthority.authority_blocker = "source_freshness";
  invalidBlockedAuthority.blocked_action_type = "cut";
  await expectPostgresError(
    () => upsertNativeAdDecisionSnapshots([invalidBlockedAuthority], db),
    "23514",
    "authority blocker clears native action authority",
  );

  await expectPostgresError(
    () =>
      client.query(
        `UPDATE engine_v3_ad_decision_events
         SET current_label = 'refresh'
         WHERE decision_entity_id = 'ad-retry'
           AND event_type = 'decision_changed'`,
      ),
    "23503",
    "event exact snapshot lineage FK",
  );
}

async function runSeam(client: Client) {
  await createBaseSchema(client);
  await createHydrationSourceSchema(client);
  for (const statement of NATIVE_AD_DECISION_SCHEMA_SQL) {
    await client.query(statement);
  }
  const db = dbClient(client);
  const capability = await inspectEvaluationStoreSchemaCapability(db);
  assert(
    capability.ready,
    `Exact native schema capability failed: ${capability.missing.join(", ")}`,
  );
  await verifyHydrationReceiptCaptureAxis(client);
  await verifyTombstoneAndHistoricalCutoff(client);
  await verifyCurrentIdentityAndConfigFallback(client);
  await verifyFirstWriteEvaluationLinkage(client);
  await verifyPruneRetryAndConstraints(client, db);
  await verifyCalibrationReuseAccountIdentity(client, db);
}

async function main() {
  const pgBinDir = resolvePgBinDir();
  const port = await freePort();
  assert(!FORBIDDEN_PORTS.has(port), `Unsafe PostgreSQL port ${port}.`);
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsecute-native-ad-seam-"),
  );
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  let started = false;
  try {
    run(
      path.join(pgBinDir, "initdb"),
      ["-D", dataDir, "-U", "postgres", "--auth=trust", "--no-locale"],
      "initdb",
    );
    run(
      path.join(pgBinDir, "pg_ctl"),
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-w",
        "-o",
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`,
        "start",
      ],
      "pg_ctl start",
    );
    started = true;
    run(
      path.join(pgBinDir, "createdb"),
      [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        "postgres",
        "native_ad_seam",
      ],
      "createdb",
    );
    const client = new Client({
      connectionString: `postgresql://postgres@127.0.0.1:${port}/native_ad_seam`,
    });
    await client.connect();
    try {
      await runSeam(client);
    } finally {
      await client.end();
    }
    console.log(
      "[native-ad-seam] PASS capture-axis receipt, tombstone, historical cutoff, first-write linkage, receipt prune, retry, account-identity reuse, FK and soft-only checks",
    );
  } finally {
    if (started) {
      run(
        path.join(pgBinDir, "pg_ctl"),
        ["-D", dataDir, "-m", "immediate", "-w", "stop"],
        "pg_ctl stop",
      );
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
