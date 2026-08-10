import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { Client } from "pg";

import { resetDbClientCache, type DbClient } from "@/lib/db";
import {
  ALTER_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_SQL,
  NATIVE_AD_DECISION_SCHEMA_SQL,
} from "@/lib/creative-decision-engine/ad-evaluation-schema";
import {
  AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
  HYDRATE_AD_DECISION_INPUTS_QUERY,
  READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
  READ_AD_ENTITY_STATE_AS_OF_QUERY,
  WarehouseDataSource,
  hashAdDecisionIdentityManifest,
  type AdDecisionHydrationResult,
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
  runAdDecisionsJob,
  upsertNativeAdDecisionSnapshots,
  type AdDecisionsJobRuntimeOptions,
  type NativeDecisionChangeEventPayloadRow,
  type NativeSnapshotPayloadRow,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { hasReusableNativeCalibration } from "@/lib/creative-decision-engine/jobs/native-ad-scheduled";
import type { EngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AdDecisionInput,
} from "@/lib/creative-decision-engine/types";
import { upsertMetaAdDailyRows } from "@/lib/meta/warehouse";
import type { MetaAdDailyRow } from "@/lib/meta/warehouse-types";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const BUSINESS_ID = "00000000-0000-4000-8000-000000000901";
const ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000902";
const ACCOUNT_ID = "act_native_seam";
const AS_OF = "2026-07-12";
const CUTOFF = `${AS_OF}T03:15:00.000Z`;
const CALIBRATION_ID = "00000000-0000-4000-8000-000000000903";
const LEGACY_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK = `(
  (
    calibration_row_id IS NULL AND
    label IN ('diagnose', 'out_of_scope', 'keep') AND
    raw_label IN ('diagnose', 'out_of_scope', 'keep') AND
    confidence <= 40 AND
    authorized_action IS NULL AND
    blocked_action_type IS NULL AND
    badges @> '[{"type":"native_calibration_unavailable"}]'::jsonb
  ) OR (
    calibration_row_id IS NOT NULL AND
    (
      (raw_label IN ('scale', 'cut', 'refresh') AND authorized_action = raw_label) OR
      (raw_label NOT IN ('scale', 'cut', 'refresh') AND authorized_action IS NULL)
    ) AND (
      label NOT IN ('scale', 'cut', 'refresh') OR
      (label = raw_label AND authorized_action = label)
    )
  )
)`;

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
  const linuxVersionedDirs = fs.existsSync("/usr/lib/postgresql")
    ? fs
        .readdirSync("/usr/lib/postgresql", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
        .map((version) => path.join("/usr/lib/postgresql", version, "bin"))
    : [];
  const candidates = Array.from(new Set([
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    ...linuxVersionedDirs,
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter((value): value is string => Boolean(value))));
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
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL,
      external_account_id TEXT NOT NULL,
      account_name TEXT,
      timezone TEXT,
      currency TEXT,
      is_manager BOOLEAN,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (id, provider, external_account_id),
      UNIQUE (provider, external_account_id)
    );
    CREATE TABLE business_provider_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_account_ref_id UUID NOT NULL,
      provider_account_id TEXT NOT NULL,
      -- Selection, mirroring production. The decision engine's hydration and
      -- manifest CTEs filter on binding.is_selected, so a fixture without it
      -- does not describe the schema this code runs against, and the seam fails
      -- with a missing-column error rather than proving anything about
      -- decisions.
      is_selected BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (business_id, provider_account_ref_id, provider_account_id)
    );
    CREATE TABLE engine_v3_job_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_name TEXT NOT NULL,
      business_ref_id UUID NOT NULL,
      business_id TEXT,
      as_of_date DATE NOT NULL,
      engine_version TEXT NOT NULL,
      status TEXT NOT NULL,
      dependency_run_id UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      row_count INTEGER,
      source_min_date DATE,
      source_max_date DATE,
      source_max_updated_at TIMESTAMPTZ,
      input_hash TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      error_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
       business_id, provider, provider_account_ref_id, provider_account_id, is_selected
     ) VALUES ($1, 'meta', $2, $3, TRUE)`,
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
       business_id, provider, provider_account_ref_id, provider_account_id, is_selected
     ) VALUES ($1::text, 'meta', $2, 'act_calibrated', TRUE)`,
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
      business_ref_id UUID, provider_account_id TEXT NOT NULL,
      provider_account_ref_id UUID, date DATE NOT NULL, ad_id TEXT NOT NULL,
      ad_name_current TEXT, ad_name_historical TEXT, campaign_id TEXT,
      adset_id TEXT, ad_status TEXT, destination_url TEXT,
      destination_url_raw TEXT, destination_url_source TEXT,
      destination_url_confidence TEXT, cta_type TEXT, object_story_id TEXT,
      effective_object_story_id TEXT, account_timezone TEXT,
      account_currency TEXT, truth_state TEXT NOT NULL,
      truth_version INTEGER NOT NULL DEFAULT 1, finalized_at TIMESTAMPTZ,
      validation_status TEXT NOT NULL, spend DOUBLE PRECISION,
      conversions DOUBLE PRECISION, revenue DOUBLE PRECISION,
      impressions BIGINT, link_clicks BIGINT, clicks BIGINT, reach BIGINT,
      frequency DOUBLE PRECISION, roas DOUBLE PRECISION, cpa DOUBLE PRECISION,
      ctr DOUBLE PRECISION, cpc DOUBLE PRECISION, source_snapshot_id UUID,
      source_run_id TEXT, metric_schema_version INTEGER NOT NULL DEFAULT 1,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (business_id, provider_account_id, date, ad_id)
    );
    CREATE TABLE meta_ad_dimensions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id TEXT NOT NULL,
      business_ref_id UUID, provider_account_id TEXT NOT NULL,
      provider_account_ref_id UUID, ad_id TEXT NOT NULL,
      ad_name_current TEXT, ad_name_historical TEXT, creative_id TEXT,
      campaign_id TEXT, adset_id TEXT, ad_status TEXT,
      projection_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      first_seen_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
      source_updated_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      UNIQUE (business_id, provider_account_id, ad_id)
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

async function createMetaWarehouseMutationReadinessSchema(client: Client) {
  const readinessOnlyTables = [
    "meta_authoritative_source_manifests",
    "meta_authoritative_slice_versions",
    "meta_authoritative_reconciliation_events",
    "meta_authoritative_day_state",
    "meta_sync_jobs",
    "meta_sync_partitions",
    "meta_sync_runs",
    "meta_sync_checkpoints",
    "meta_sync_phase_timings",
    "meta_sync_state",
    "meta_raw_snapshots",
    "meta_account_daily",
    "meta_breakdown_daily",
    "meta_creative_daily",
    "meta_creative_media",
    "meta_campaign_dimensions",
    "meta_adset_dimensions",
  ] as const;
  for (const table of readinessOnlyTables) {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid()
      )`,
    );
  }
}

function metaAdDailyAuthorityInput(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  adId: string;
  truthState?: MetaAdDailyRow["truthState"];
  truthVersion?: number;
  validationStatus?: MetaAdDailyRow["validationStatus"];
  finalizedAt?: string | null;
}): MetaAdDailyRow {
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    date: input.date,
    campaignId: "campaign-adversarial",
    adsetId: "adset-adversarial",
    adId: input.adId,
    adNameCurrent: "Enriched current name",
    adNameHistorical: "Enriched historical name",
    adStatus: "PAUSED",
    destinationUrl: "https://example.com/enriched",
    destinationUrlRaw: "https://example.com/raw-enriched",
    destinationUrlSource: "creative_api",
    destinationUrlConfidence: "high",
    ctaType: "SHOP_NOW",
    objectStoryId: "story-enriched",
    effectiveObjectStoryId: "story-effective-enriched",
    accountTimezone: "UTC",
    accountCurrency: "EUR",
    spend: 999,
    impressions: 999,
    clicks: 999,
    reach: 999,
    frequency: 9,
    conversions: 9,
    revenue: 999,
    roas: 1,
    cpa: 111,
    ctr: 1,
    cpc: 1,
    linkClicks: 999,
    sourceSnapshotId: null,
    truthState: input.truthState ?? "finalized",
    truthVersion: input.truthVersion ?? 99,
    finalizedAt:
      input.finalizedAt === undefined
        ? "2030-01-01T00:00:00.000Z"
        : input.finalizedAt,
    validationStatus: input.validationStatus ?? "passed",
    sourceRunId: "creative-enrichment-adversarial-run",
    metricSchemaVersion: 99,
    payloadJson: { adversarial: true, creative_id: "creative-adversarial" },
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-02T00:00:00.000Z",
  };
}

async function verifyMetaAdDailyWriteOwnershipAuthority(
  client: Client,
) {
  await createMetaWarehouseMutationReadinessSchema(client);
  const businessId = "00000000-0000-4000-8000-000000000970";
  const providerAccountRefId =
    "00000000-0000-4000-8000-000000000971";
  const providerAccountId = "act_creative_enrichment_authority";
  const adId = "ad-creative-enrichment";
  const sourceSnapshotId = "00000000-0000-4000-8000-000000000972";

  await client.query(`INSERT INTO businesses (id) VALUES ($1)`, [
    businessId,
  ]);
  await client.query(
    `INSERT INTO provider_accounts (
       id, provider, external_account_id, account_name, timezone, currency,
       is_manager, metadata, created_at, updated_at
     ) VALUES (
       $1, 'meta', $2, 'Authoritative account', 'America/Chicago', 'USD',
       false, '{"sentinel":"provider"}'::jsonb,
       '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'
     )`,
    [providerAccountRefId, providerAccountId],
  );
  await client.query(
    `INSERT INTO business_provider_accounts (
       business_id, provider, provider_account_ref_id, provider_account_id
     ) VALUES ($1, 'meta', $2, $3)`,
    [businessId, providerAccountRefId, providerAccountId],
  );
  await client.query(
    `INSERT INTO meta_ad_daily (
       business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, date, campaign_id, adset_id, ad_id,
       ad_name_current, ad_name_historical, ad_status, destination_url,
       destination_url_raw, destination_url_source,
       destination_url_confidence, cta_type, object_story_id,
       effective_object_story_id, account_timezone, account_currency,
       spend, impressions, clicks, reach, frequency, conversions, revenue,
       roas, cpa, ctr, cpc, link_clicks, source_snapshot_id, truth_state,
       truth_version, finalized_at, validation_status, source_run_id,
       metric_schema_version, payload_json, created_at, updated_at
     )
     SELECT
       $1::text, $1::uuid, $2, $3::uuid, fixture.date_value, 'campaign-original',
       'adset-original', $4, 'Original current ' || fixture.date_value::text,
       'Original historical', 'ACTIVE', 'https://example.com/original',
       'https://example.com/raw-original', 'authoritative_sync', 'exact',
       'LEARN_MORE', 'story-original', 'story-effective-original',
       'America/Chicago', 'USD', fixture.spend, 100, 10, 90, 1.1, 2, 250,
       2.5, 50, 10, 5, 8, $5::uuid, fixture.truth_state,
       7, fixture.finalized_at, fixture.validation_status,
       'authoritative-source-run', 1,
       jsonb_build_object('sentinel', fixture.date_value::text),
       '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'
     FROM (
       VALUES
         ('2026-07-01'::date, 'finalized', 'passed',
          '2026-07-02T00:00:00Z'::timestamptz, 10::double precision),
         ('2026-07-02'::date, 'provisional', 'passed',
          NULL::timestamptz, 20::double precision),
         ('2026-07-03'::date, 'finalized', 'failed',
          '2026-07-04T00:00:00Z'::timestamptz, 30::double precision)
     ) AS fixture(
       date_value, truth_state, validation_status, finalized_at, spend
     )`,
    [
      businessId,
      providerAccountId,
      providerAccountRefId,
      adId,
      sourceSnapshotId,
    ],
  );
  await client.query(
    `INSERT INTO meta_ad_dimensions (
       business_id, business_ref_id, provider_account_id,
       provider_account_ref_id, campaign_id, adset_id, ad_id,
       ad_name_current, ad_name_historical, ad_status, creative_id,
       projection_json, first_seen_at, last_seen_at, source_updated_at,
       created_at, updated_at
     ) VALUES (
       $1::text, $1::uuid, $2, $3::uuid, 'campaign-original', 'adset-original',
       $4, 'Dimension original', 'Dimension historical', 'ACTIVE',
       'creative-original', '{"sentinel":"dimension"}'::jsonb,
       '2026-06-01T00:00:00Z', '2026-07-03T00:00:00Z',
       '2026-06-02T00:00:00Z', '2026-06-01T00:00:00Z',
       '2026-06-02T00:00:00Z'
     )`,
    [businessId, providerAccountId, providerAccountRefId, adId],
  );

  type DailyHashRow = {
    date: string;
    full_hash: string;
  };
  const readDailyHashes = async () =>
    (
      await client.query<DailyHashRow>(
        `SELECT
           date::text AS date,
           encode(digest(to_jsonb(d)::text, 'sha256'), 'hex') AS full_hash
         FROM meta_ad_daily d
         WHERE business_id = $1 AND provider_account_id = $2
           AND ad_id = $3
         ORDER BY date`,
        [businessId, providerAccountId, adId],
      )
    ).rows;
  const readSingleHash = async (table: "provider_accounts" | "meta_ad_dimensions") => {
    const filter =
      table === "provider_accounts"
        ? "provider = 'meta' AND external_account_id = $1"
        : "business_id = $1 AND provider_account_id = $2 AND ad_id = $3";
    const params =
      table === "provider_accounts"
        ? [providerAccountId]
        : [businessId, providerAccountId, adId];
    const result = await client.query<{ row_hash: string }>(
      `SELECT encode(digest(to_jsonb(row_value)::text, 'sha256'), 'hex') AS row_hash
       FROM ${table} AS row_value
       WHERE ${filter}`,
      params,
    );
    assert(result.rows.length === 1, `${table} sentinel row is missing.`);
    return result.rows[0]!.row_hash;
  };

  const beforeDaily = await readDailyHashes();
  const beforeProviderHash = await readSingleHash("provider_accounts");
  const beforeDimensionHash = await readSingleHash("meta_ad_dimensions");
  const creativeRows = [
    "2026-07-01",
    "2026-07-02",
    "2026-07-03",
    "2026-07-04",
  ].map((date) =>
    metaAdDailyAuthorityInput({
      businessId,
      providerAccountId,
      date,
      adId,
    }),
  );

  await upsertMetaAdDailyRows(
    creativeRows,
    { writeMode: "creative_enrichment" } as never,
  ).then(
    () => {
      throw new Error(
        "Creative enrichment unexpectedly acquired Meta Ad fact authority.",
      );
    },
    (error) => {
      assert(
        error instanceof Error &&
          error.message ===
            "Unsupported Meta Ad daily write mode: creative_enrichment",
        `Creative enrichment did not fail closed at the ownership boundary: ${String(error)}`,
      );
    },
  );

  const afterDaily = await readDailyHashes();
  const beforeByDate = new Map(beforeDaily.map((row) => [row.date, row]));
  const afterByDate = new Map(afterDaily.map((row) => [row.date, row]));
  assert(
    afterDaily.length === 3 && !afterByDate.has("2026-07-04"),
    "Creative enrichment inserted a missing canonical Meta Ad fact row.",
  );
  for (const date of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
    assert(
      afterByDate.get(date)?.full_hash === beforeByDate.get(date)?.full_hash,
      `Rejected creative enrichment changed ${date} fact bytes.`,
    );
  }
  const enriched = await client.query<{
    ad_name_current: string | null;
    ad_name_historical: string | null;
    ad_status: string | null;
    destination_url: string | null;
    destination_url_raw: string | null;
    destination_url_source: string | null;
    destination_url_confidence: string | null;
    cta_type: string | null;
    object_story_id: string | null;
    effective_object_story_id: string | null;
  }>(
    `SELECT
       ad_name_current, ad_name_historical, ad_status, destination_url,
       destination_url_raw, destination_url_source,
       destination_url_confidence, cta_type, object_story_id,
       effective_object_story_id
     FROM meta_ad_daily
     WHERE business_id = $1 AND provider_account_id = $2
       AND date = '2026-07-01' AND ad_id = $3`,
    [businessId, providerAccountId, adId],
  );
  assert(
    JSON.stringify(enriched.rows[0]) ===
      JSON.stringify({
        ad_name_current: "Original current 2026-07-01",
        ad_name_historical: "Original historical",
        ad_status: "ACTIVE",
        destination_url: "https://example.com/original",
        destination_url_raw: "https://example.com/raw-original",
        destination_url_source: "authoritative_sync",
        destination_url_confidence: "exact",
        cta_type: "LEARN_MORE",
        object_story_id: "story-original",
        effective_object_story_id: "story-effective-original",
      }),
    "Rejected creative enrichment changed presentation bytes on a Meta Ad fact.",
  );
  assert(
    (await readSingleHash("provider_accounts")) === beforeProviderHash,
    "Creative enrichment changed provider-account identity metadata.",
  );
  assert(
    (await readSingleHash("meta_ad_dimensions")) === beforeDimensionHash,
    "Creative enrichment changed the authoritative Meta Ad dimension.",
  );

  const authoritativeA = {
    ...metaAdDailyAuthorityInput({
      businessId,
      providerAccountId,
      date: "2026-07-01",
      adId,
      truthState: "provisional",
      truthVersion: 9,
      validationStatus: "pending",
      finalizedAt: null,
    }),
    campaignId: "campaign-authoritative",
    adsetId: "adset-authoritative",
    adNameCurrent: "Authoritative A",
    adNameHistorical: "Authoritative A historical",
    adStatus: "PAUSED",
    accountTimezone: "America/New_York",
    accountCurrency: "CAD",
    spend: 111,
    payloadJson: {
      source: "authoritative",
      creative_id: "creative-authoritative-a",
    },
  } satisfies MetaAdDailyRow;
  const authoritativeE = {
    ...metaAdDailyAuthorityInput({
      businessId,
      providerAccountId,
      date: "2026-07-05",
      adId: "ad-authoritative-new",
      truthState: "finalized",
      truthVersion: 1,
      validationStatus: "passed",
      finalizedAt: "2026-07-06T00:00:00.000Z",
    }),
    campaignId: "campaign-authoritative-new",
    adsetId: "adset-authoritative-new",
    adNameCurrent: "Authoritative E",
    adStatus: "ACTIVE",
    accountTimezone: "America/New_York",
    accountCurrency: "CAD",
    spend: 222,
    payloadJson: {
      source: "authoritative-new",
      creative_id: "creative-authoritative-e",
    },
  } satisfies MetaAdDailyRow;

  await upsertMetaAdDailyRows([authoritativeA, authoritativeE], {
    writeMode: "authoritative_fact",
  });

  const authoritative = await client.query<{
    date: string;
    ad_id: string;
    campaign_id: string | null;
    adset_id: string | null;
    ad_status: string | null;
    account_timezone: string | null;
    account_currency: string | null;
    spend: number;
    truth_state: string;
    truth_version: number;
    validation_status: string;
    payload_json: Record<string, unknown>;
  }>(
    `SELECT
       date::text AS date, ad_id, campaign_id, adset_id, ad_status,
       account_timezone, account_currency, spend, truth_state, truth_version,
       validation_status, payload_json
     FROM meta_ad_daily
     WHERE business_id = $1 AND provider_account_id = $2
       AND (
         (date = '2026-07-01' AND ad_id = $3) OR
         (date = '2026-07-05' AND ad_id = 'ad-authoritative-new')
       )
     ORDER BY date`,
    [businessId, providerAccountId, adId],
  );
  assert(
    authoritative.rows.length === 2,
    "Default authoritative mode did not update and insert canonical rows.",
  );
  const updatedA = authoritative.rows[0];
  assert(
    updatedA?.campaign_id === "campaign-authoritative" &&
      updatedA.adset_id === "adset-authoritative" &&
      updatedA.ad_status === "PAUSED" &&
      updatedA.account_timezone === "America/New_York" &&
      updatedA.account_currency === "CAD" &&
      Number(updatedA.spend) === 111 &&
      updatedA.truth_state === "provisional" &&
      updatedA.truth_version === 10 &&
      updatedA.validation_status === "pending" &&
      updatedA.payload_json.source === "authoritative",
    "Default authoritative mode no longer owns fact and lifecycle updates.",
  );
  const insertedE = authoritative.rows[1];
  assert(
    insertedE?.ad_id === "ad-authoritative-new" &&
      insertedE.truth_state === "finalized" &&
      insertedE.validation_status === "passed" &&
      Number(insertedE.spend) === 222,
    "Default authoritative mode no longer inserts new canonical facts.",
  );
  const provider = await client.query<{
    timezone: string | null;
    currency: string | null;
  }>(
    `SELECT timezone, currency
     FROM provider_accounts
     WHERE provider = 'meta' AND external_account_id = $1`,
    [providerAccountId],
  );
  assert(
    provider.rows[0]?.timezone === "America/New_York" &&
      provider.rows[0]?.currency === "CAD",
    "Default authoritative mode stopped updating provider-account metadata.",
  );
  const dimensions = await client.query<{
    ad_id: string;
    campaign_id: string | null;
    adset_id: string | null;
    ad_status: string | null;
    creative_id: string | null;
  }>(
    `SELECT ad_id, campaign_id, adset_id, ad_status, creative_id
     FROM meta_ad_dimensions
     WHERE business_id = $1 AND provider_account_id = $2
       AND ad_id IN ($3, 'ad-authoritative-new')
     ORDER BY ad_id`,
    [businessId, providerAccountId, adId],
  );
  assert(
    dimensions.rows.length === 2 &&
      dimensions.rows.some(
        (row) =>
          row.ad_id === adId &&
          row.campaign_id === "campaign-authoritative" &&
          row.adset_id === "adset-authoritative" &&
          row.ad_status === "PAUSED" &&
          row.creative_id === "creative-authoritative-a",
      ) &&
      dimensions.rows.some(
        (row) =>
          row.ad_id === "ad-authoritative-new" &&
          row.campaign_id === "campaign-authoritative-new" &&
          row.ad_status === "ACTIVE" &&
          row.creative_id === "creative-authoritative-e",
      ),
    "Default authoritative mode no longer owns Meta Ad dimensions.",
  );
}

async function verifyHydrationReceiptCaptureAxis(client: Client) {
  const sourceRunId = "00000000-0000-4000-8000-000000000904";
  const compactedDuplicateRunId = "00000000-0000-4000-8000-000000000905";
  const emptyRunId = "00000000-0000-4000-8000-000000000906";
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

  await client.query(
    `INSERT INTO meta_entity_observation_runs (
       id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, endpoint, observed_at, captured_at,
       completeness, page_count, row_count, payload_hash, run_hash, created_at
     ) VALUES ($1, $2::uuid, $2::text, $3, $4, 'ad', 'ad_configs', $5, $6,
       'complete', 1, 2, $7, $8, $6)`,
    [
      compactedDuplicateRunId,
      BUSINESS_ID,
      ACCOUNT_REF_ID,
      ACCOUNT_ID,
      `${AS_OF}T03:10:00.000Z`,
      `${AS_OF}T03:10:05.000Z`,
      "b".repeat(64),
      "c".repeat(64),
    ],
  );
  const afterCompactedDuplicate = await client.query<{
    source_run_id: string;
    source_expected_row_count: number;
    source_persisted_row_count: number;
  }>(READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY, [
    BUSINESS_ID,
    AS_OF,
    CUTOFF,
    [],
    false,
  ]);
  assert(
    afterCompactedDuplicate.rows[0]?.source_run_id === sourceRunId &&
      afterCompactedDuplicate.rows[0]?.source_expected_row_count === 2 &&
      afterCompactedDuplicate.rows[0]?.source_persisted_row_count === 2,
    "Compacted duplicate run without retained state caused a receipt mismatch.",
  );

  await client.query(
    `INSERT INTO meta_entity_observation_runs (
       id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, endpoint, observed_at, captured_at,
       completeness, page_count, row_count, payload_hash, run_hash, created_at
     ) VALUES ($1, $2::uuid, $2::text, $3, $4, 'ad', 'ad_configs', $5, $6,
       'complete', 1, 0, $7, $8, $6)`,
    [
      emptyRunId,
      BUSINESS_ID,
      ACCOUNT_REF_ID,
      ACCOUNT_ID,
      `${AS_OF}T03:12:00.000Z`,
      `${AS_OF}T03:12:05.000Z`,
      "d".repeat(64),
      "e".repeat(64),
    ],
  );
  const emptyReceipt = await client.query<{
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
    emptyReceipt.rows[0]?.source_run_id === emptyRunId &&
      emptyReceipt.rows[0]?.source_expected_row_count === 0 &&
      emptyReceipt.rows[0]?.source_persisted_row_count === 0 &&
      emptyReceipt.rows[0]?.expected_ad_ids.length === 0,
    "Legitimate zero-row complete run was not selected as an empty receipt.",
  );
}

interface GenerationBoundLargeManifestFixture {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  asOf: string;
  inputs: AdDecisionInput[];
}

async function verifyGenerationBoundLargeManifestHydration(
  client: Client,
): Promise<GenerationBoundLargeManifestFixture> {
  const businessId = "00000000-0000-4000-8000-000000000990";
  const providerAccountRefId = "00000000-0000-4000-8000-000000000991";
  const providerAccountId = "act_generation_bound_scale";
  const sourceRunId = "00000000-0000-4000-8000-000000000992";
  const asOf = new Date().toISOString().slice(0, 10);
  const decisionCutoff = `${asOf}T12:00:00.000Z`;
  const sourceObservedAt = `${asOf}T03:00:00.000Z`;
  const sourceCapturedAt = `${asOf}T03:00:05.000Z`;
  const preGenerationTombstoneAt = `${asOf}T02:30:00.000Z`;
  const expectedAdCount = 501;
  const reappearedAdId = "ad-scale-0001";

  await client.query(`INSERT INTO businesses (id) VALUES ($1)`, [businessId]);
  await client.query(
    `INSERT INTO provider_accounts (
       id, provider, external_account_id, timezone, currency
     ) VALUES ($1, 'meta', $2, 'UTC', 'USD')`,
    [providerAccountRefId, providerAccountId],
  );
  await client.query(
    `INSERT INTO business_provider_accounts (
       business_id, provider, provider_account_ref_id, provider_account_id, is_selected
     ) VALUES ($1, 'meta', $2, $3, TRUE)`,
    [businessId, providerAccountRefId, providerAccountId],
  );
  await client.query(
    `INSERT INTO meta_entity_observation_runs (
       id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, endpoint, observed_at, captured_at,
       completeness, page_count, row_count, payload_hash, run_hash, created_at
     ) VALUES (
       $1, $2::uuid, $2::text, $3, $4, 'ad', 'ad_configs', $5, $6,
       'complete', 2, $7, $8, $9, $6
     )`,
    [
      sourceRunId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      sourceObservedAt,
      sourceCapturedAt,
      expectedAdCount,
      "1".repeat(64),
      "2".repeat(64),
    ],
  );
  await client.query(
    `INSERT INTO meta_entity_state_history (
       run_id, business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, entity_id, entity_name, campaign_id,
       adset_id, creative_id, configured_status, effective_status,
       observed_at, captured_at, created_at, run_completeness, presence
     )
     SELECT
       $1::uuid,
       $2::uuid,
       $2::text,
       $3::uuid,
       $4,
       'ad',
       'ad-scale-' || LPAD(sequence::text, 4, '0'),
       'Scale ad ' || sequence,
       'campaign-scale',
       'adset-scale',
       'creative-scale-' || LPAD(sequence::text, 4, '0'),
       'ACTIVE',
       'ACTIVE',
       CASE
         WHEN sequence = 1 THEN '2000-01-01T00:00:00.000Z'::timestamptz
         ELSE $5::timestamptz
       END,
       $6::timestamptz,
       $6::timestamptz,
       'complete',
       'present'
     FROM generate_series(1, $7::integer) AS sequence`,
    [
      sourceRunId,
      businessId,
      providerAccountRefId,
      providerAccountId,
      sourceObservedAt,
      sourceCapturedAt,
      expectedAdCount,
    ],
  );
  await client.query(
    `INSERT INTO meta_entity_tombstones (
       business_ref_id, business_id, provider_account_ref_id,
       provider_account_id, entity_type, entity_id, reason,
       observed_at, captured_at, created_at
     ) VALUES (
       $1::uuid, $1::text, $2, $3, 'ad', $4, 'explicit_not_found',
       $5, $5, $5
     )`,
    [
      businessId,
      providerAccountRefId,
      providerAccountId,
      reappearedAdId,
      preGenerationTombstoneAt,
    ],
  );
  await client.query(
    `INSERT INTO meta_ad_dimensions (
       business_id, provider_account_id, ad_id, ad_name_current, creative_id,
       campaign_id, adset_id, ad_status, first_seen_at, last_seen_at,
       created_at, updated_at
     )
     SELECT
       $1,
       $2,
       'ad-scale-' || LPAD(sequence::text, 4, '0'),
       'Scale ad ' || sequence,
       'creative-scale-' || LPAD(sequence::text, 4, '0'),
       'campaign-scale',
       'adset-scale',
       'ACTIVE',
       $3::timestamptz,
       $3::timestamptz,
       $3::timestamptz,
       $3::timestamptz
     FROM generate_series(1, $4::integer) AS sequence`,
    [businessId, providerAccountId, sourceCapturedAt, expectedAdCount],
  );

  const result = await new WarehouseDataSource().hydrateAdDecisionInputs({
    businessId,
    asOf,
    decisionCutoff,
    providerAccountIds: [providerAccountId],
  });
  const reappeared = result.inputs.find((row) => row.adId === reappearedAdId);
  assert(
    result.inputs.length === expectedAdCount,
    `Complete 501-row manifest hydrated ${result.inputs.length} rows.`,
  );
  assert(
    result.accountCoverageComplete &&
      result.receipts.length === 1 &&
      result.receipts[0]?.expectedAdCount === expectedAdCount &&
      result.receipts[0]?.hydratedAdCount === expectedAdCount &&
      result.receipts[0]?.authoritativeForPrune === true,
    "Complete 501-row manifest did not retain authoritative hydration proof.",
  );
  assert(
    reappeared?.effectiveStatus === "ACTIVE" &&
      reappeared.statusEvidence.source === "entity_state_history" &&
      reappeared.statusEvidence.capturedAt ===
        new Date(sourceCapturedAt).toISOString(),
    "A pre-generation tombstone overrode the current complete-run state.",
  );
  return {
    businessId,
    providerAccountRefId,
    providerAccountId,
    asOf,
    inputs: result.inputs,
  };
}

function rollbackJobInputs(
  fixture: GenerationBoundLargeManifestFixture,
  mode: "baseline" | "non_purchase",
): AdDecisionInput[] {
  const contextReady = mode === "non_purchase";
  return fixture.inputs.map((row) => ({
    ...row,
    accountTimezone: "UTC",
    accountCurrency: "USD",
    campaignId: null,
    adsetId: null,
    creativeId: null,
    objective: contextReady ? "OUTCOME_TRAFFIC" : null,
    effectiveCohort: contextReady ? "traffic" : null,
    optimizationGoal: contextReady ? "LINK_CLICKS" : null,
    customEventType: null,
    contextGrain: {
      providerAccountCount: 1,
      campaignCount: 0,
      adsetCount: 0,
      optimizationContextCount: contextReady ? 1 : 0,
      objectiveCount: contextReady ? 1 : 0,
      contextIdentityUnknown: !contextReady,
    },
    creativeEvidence: {
      sourceLifecycleRowId: null,
      sourceAsOfDate: null,
      sourceComputedAt: null,
      sourceMaxUpdatedAt: null,
      lifecyclePosition: null,
      daysSincePeak: null,
      peakRoas30d: null,
      peakConfidence: null,
      spendTrajectory30d: null,
      spendSlope7d: null,
      spendSlope30d: null,
      roasSlope7d: null,
      roasSlope30d: null,
      fatigueStatus: null,
      qualityRanking: null,
      engagementRateRanking: null,
      conversionRateRanking: null,
      creativeFormat: null,
    },
  }));
}

function rollbackJobHydration(input: {
  fixture: GenerationBoundLargeManifestFixture;
  inputs: AdDecisionInput[];
  asOf: string;
  decisionCutoff: string;
}): AdDecisionHydrationResult {
  const expectedAdIds = input.inputs.map((row) => row.adId).sort();
  const manifestHash = hashAdDecisionIdentityManifest({
    businessId: input.fixture.businessId,
    providerAccountId: input.fixture.providerAccountId,
    asOfDate: input.asOf,
    adIds: expectedAdIds,
  });
  const sourceTimestamp = `${input.asOf}T00:00:00.000Z`;
  return {
    inputs: input.inputs,
    receipts: [
      {
        contractVersion: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
        businessId: input.fixture.businessId,
        providerAccountRefId: input.fixture.providerAccountRefId,
        providerAccountId: input.fixture.providerAccountId,
        scopeType: "account",
        scopeId: input.fixture.providerAccountId,
        asOfDate: input.asOf,
        decisionCutoff: input.decisionCutoff,
        sourceRunId: "00000000-0000-4000-8000-000000000993",
        sourceObservedAt: sourceTimestamp,
        sourceCapturedAt: sourceTimestamp,
        sourceRunHash: "3".repeat(64),
        sourcePayloadHash: "4".repeat(64),
        sourceExpectedRowCount: expectedAdIds.length,
        sourcePersistedRowCount: expectedAdIds.length,
        expectedAdCount: expectedAdIds.length,
        expectedAdIds,
        expectedManifestHash: manifestHash,
        hydratedAdCount: expectedAdIds.length,
        hydratedManifestHash: manifestHash,
        sourceComplete: true,
        hydrationComplete: true,
        authoritativeForPrune: true,
        reason: null,
      },
    ],
    accountCoverageComplete: true,
  };
}

async function verifyRunAdDecisionsJobSecondEventBatchRollback(
  client: Client,
  fixture: GenerationBoundLargeManifestFixture,
) {
  const db = dbClient(client);
  const currentAsOf = fixture.asOf;
  const baselineDate = new Date(`${currentAsOf}T00:00:00.000Z`);
  baselineDate.setUTCDate(baselineDate.getUTCDate() - 1);
  const baselineAsOf = baselineDate.toISOString().slice(0, 10);
  const baselineInputs = rollbackJobInputs(fixture, "baseline");
  const currentInputs = rollbackJobInputs(fixture, "non_purchase");
  assert(
    baselineInputs.length === 501 && currentInputs.length === 501,
    "Rollback seam requires exactly 501 native ad inputs.",
  );

  const dataSource: Pick<WarehouseDataSource, "hydrateAdDecisionInputs"> = {
    async hydrateAdDecisionInputs(input) {
      const inputs =
        input.asOf === baselineAsOf
          ? baselineInputs
          : input.asOf === currentAsOf
            ? currentInputs
            : null;
      if (inputs === null) {
        throw new Error(`Unexpected rollback seam asOf ${input.asOf}.`);
      }
      return rollbackJobHydration({
        fixture,
        inputs,
        asOf: input.asOf,
        decisionCutoff: input.decisionCutoff,
      });
    },
  };
  const flags: EngineV3Flags = {
    businessId: fixture.businessId,
    enabled: true,
    surfaceVisible: false,
    shadowOnly: true,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    },
  };
  const transaction = async <T>(fn: () => Promise<T>) => {
    await client.query("BEGIN");
    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  };
  const options: AdDecisionsJobRuntimeOptions = {
    db,
    transaction,
    businessGuard: async () => null,
    resolveFlags: async () => flags,
    dataSource,
    inspectProfileSchema: async () => ({ ready: true, missing: [] }),
  };

  const baseline = await runAdDecisionsJob(
    { businessId: fixture.businessId, asOf: baselineAsOf },
    options,
  );
  assert(
    baseline.status === "success" &&
      baseline.snapshotsWritten === 501 &&
      baseline.changeEventsWritten === 0,
    `Rollback baseline job failed: ${baseline.errorMessage ?? baseline.status}.`,
  );
  const baselineRows = await client.query<{
    snapshot_count: string;
    diagnose_count: string;
  }>(
    `SELECT
       COUNT(*)::text AS snapshot_count,
       COUNT(*) FILTER (WHERE label = 'diagnose')::text AS diagnose_count
     FROM engine_v3_ad_decision_snapshots_daily
     WHERE job_run_id = $1::uuid`,
    [baseline.jobRunId],
  );
  assert(
    baselineRows.rows[0]?.snapshot_count === "501" &&
      baselineRows.rows[0]?.diagnose_count === "501",
    "Rollback baseline did not persist 501 diagnose snapshots.",
  );

  await client.query(`
    CREATE SEQUENCE native_ad_rollback_event_attempt_seq;
    CREATE SEQUENCE native_ad_rollback_event_statement_seq;
    CREATE FUNCTION native_ad_count_event_insert_statements()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM nextval('native_ad_rollback_event_statement_seq');
      RETURN NULL;
    END
    $$;
    CREATE FUNCTION native_ad_fail_second_event_batch()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM nextval('native_ad_rollback_event_attempt_seq');
      IF NEW.decision_entity_id = 'ad-scale-0501' THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'forced native-ad second event batch failure';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER native_ad_fail_second_event_batch_trigger
    BEFORE INSERT ON engine_v3_ad_decision_events
    FOR EACH ROW EXECUTE FUNCTION native_ad_fail_second_event_batch();
    CREATE TRIGGER native_ad_count_event_insert_statements_trigger
    BEFORE INSERT ON engine_v3_ad_decision_events
    FOR EACH STATEMENT EXECUTE FUNCTION native_ad_count_event_insert_statements();
  `);

  const failed = await runAdDecisionsJob(
    { businessId: fixture.businessId, asOf: currentAsOf },
    options,
  );
  assert(
    failed.status === "failed" &&
      failed.snapshotsWritten === 0 &&
      failed.changeEventsWritten === 0 &&
      failed.errorMessage?.includes(
        "forced native-ad second event batch failure",
      ),
    `Second event batch did not fail closed: ${failed.errorMessage ?? failed.status}.`,
  );

  const attemptSequence = await client.query<{
    last_value: string;
    is_called: boolean;
  }>(
    `SELECT last_value::text AS last_value, is_called
     FROM native_ad_rollback_event_attempt_seq`,
  );
  assert(
    attemptSequence.rows[0]?.is_called === true &&
      attemptSequence.rows[0]?.last_value === "501",
    "The forced failure did not occur after the first 500-row event batch.",
  );

  const statementSequence = await client.query<{
    last_value: string;
    is_called: boolean;
  }>(
    `SELECT last_value::text AS last_value, is_called
     FROM native_ad_rollback_event_statement_seq`,
  );
  assert(
    statementSequence.rows[0]?.is_called === true &&
      statementSequence.rows[0]?.last_value === "2",
    "The rollback seam did not execute distinct 500-row and 1-row event batches.",
  );

  const failedRun = await client.query<{
    status: string;
    row_count: number | null;
    error_message: string | null;
  }>(
    `SELECT status, row_count, error_message
     FROM engine_v3_job_runs
     WHERE id = $1::uuid`,
    [failed.jobRunId],
  );
  assert(
    failedRun.rows[0]?.status === "failed" &&
      failedRun.rows[0]?.row_count === 0 &&
      failedRun.rows[0]?.error_message?.includes(
        "forced native-ad second event batch failure",
      ),
    "The failed native ad job attempt was not committed durably.",
  );

  const failedWrites = await client.query<{
    context_count: string;
    evaluation_count: string;
    snapshot_count: string;
    event_count: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text
        FROM engine_v3_ad_decision_evaluation_contexts
        WHERE job_run_id = $1::uuid) AS context_count,
       (SELECT COUNT(*)::text
        FROM engine_v3_ad_decision_evaluations
        WHERE job_run_id = $1::uuid) AS evaluation_count,
       (SELECT COUNT(*)::text
        FROM engine_v3_ad_decision_snapshots_daily
        WHERE job_run_id = $1::uuid) AS snapshot_count,
       (SELECT COUNT(*)::text
        FROM engine_v3_ad_decision_events
        WHERE job_run_id = $1::uuid) AS event_count`,
    [failed.jobRunId],
  );
  assert(
    failedWrites.rows[0]?.context_count === "0" &&
      failedWrites.rows[0]?.evaluation_count === "0" &&
      failedWrites.rows[0]?.snapshot_count === "0" &&
      failedWrites.rows[0]?.event_count === "0",
    "Savepoint rollback left failed-job native authority writes behind.",
  );

  const dayAndBaselineCounts = await client.query<{
    failed_day_snapshot_count: string;
    failed_day_event_count: string;
    retained_baseline_count: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text
        FROM engine_v3_ad_decision_snapshots_daily
        WHERE business_ref_id = $1::uuid
          AND as_of_date = $2::date
          AND decision_entity_id LIKE 'ad-scale-%') AS failed_day_snapshot_count,
       (SELECT COUNT(*)::text
        FROM engine_v3_ad_decision_events
        WHERE business_ref_id = $1::uuid
          AND event_date = $2::date
          AND decision_entity_id LIKE 'ad-scale-%') AS failed_day_event_count,
       (SELECT COUNT(*)::text
        FROM engine_v3_ad_decision_snapshots_daily
        WHERE job_run_id = $3::uuid) AS retained_baseline_count`,
    [fixture.businessId, currentAsOf, baseline.jobRunId],
  );
  assert(
    dayAndBaselineCounts.rows[0]?.failed_day_snapshot_count === "0" &&
      dayAndBaselineCounts.rows[0]?.failed_day_event_count === "0" &&
      dayAndBaselineCounts.rows[0]?.retained_baseline_count === "501",
    "Rollback either leaked current-day authority or damaged the baseline.",
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
    [
      BUSINESS_ID,
      ACCOUNT_REF_ID,
      ACCOUNT_ID,
      ["ad-tombstone"],
      CUTOFF,
      `${AS_OF}T02:00:00.000Z`,
    ],
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
    current.rows[0]?.account_timezone === "UTC",
    "Current hydration did not preserve the cutoff-safe immutable fact timezone.",
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
  const snapshotId = firstSnapshots.get(
    [ACCOUNT_REF_ID, ACCOUNT_ID, "ad", "ad-retry", "account", ACCOUNT_ID].join(
      "\u0000",
    ),
  )!.id;
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

  const heldEconomicCutLineage = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000935",
    adId: "ad-held-economic-cut",
    marker: "3",
  });
  const heldEconomicCut = snapshotPayload({
    jobRunId: "00000000-0000-4000-8000-000000000935",
    adId: "ad-held-economic-cut",
    label: "cut",
    ...heldEconomicCutLineage,
  });
  heldEconomicCut.label = "test_more";
  heldEconomicCut.raw_label = "test_more";
  heldEconomicCut.pre_authority_label = "cut";
  heldEconomicCut.authority_blocker = "recent_recovery_unverifiable";
  heldEconomicCut.blocked_action_type = "cut";
  heldEconomicCut.authorized_action = null;
  heldEconomicCut.badges = [];
  await upsertNativeAdDecisionSnapshots([heldEconomicCut], db);
  const persistedHeldEconomicCut = await client.query<{
    pre_authority_label: string | null;
    label: string;
    raw_label: string;
    authority_blocker: string | null;
    blocked_action_type: string | null;
    authorized_action: string | null;
    has_pending_transition: boolean;
  }>(
    `SELECT pre_authority_label, label, raw_label, authority_blocker,
       blocked_action_type, authorized_action,
       badges @> '[{"type":"pending_transition"}]'::jsonb AS has_pending_transition
     FROM engine_v3_ad_decision_snapshots_daily
     WHERE decision_entity_id = 'ad-held-economic-cut'`,
  );
  const heldRow = persistedHeldEconomicCut.rows[0];
  assert(
    heldRow?.pre_authority_label === "cut" &&
      heldRow.label === "test_more" &&
      heldRow.raw_label === "test_more" &&
      heldRow.authority_blocker === "recent_recovery_unverifiable" &&
      heldRow.blocked_action_type === "cut" &&
      heldRow.authorized_action === null &&
      heldRow.has_pending_transition === false,
    "D063 unverifiable-recovery Cut hold did not persist as the exact non-pending authority tuple.",
  );

  const invalidHeldEconomicCutLineage = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000936",
    adId: "ad-invalid-held-economic-cut",
    marker: "4",
  });
  const invalidHeldEconomicCut = snapshotPayload({
    jobRunId: "00000000-0000-4000-8000-000000000936",
    adId: "ad-invalid-held-economic-cut",
    label: "cut",
    ...invalidHeldEconomicCutLineage,
  });
  invalidHeldEconomicCut.label = "test_more";
  invalidHeldEconomicCut.raw_label = "test_more";
  invalidHeldEconomicCut.pre_authority_label = "cut";
  invalidHeldEconomicCut.authority_blocker =
    "recent_recovery_unverifiable";
  invalidHeldEconomicCut.blocked_action_type = "cut";
  invalidHeldEconomicCut.authorized_action = "cut";
  invalidHeldEconomicCut.badges = [];
  await expectPostgresError(
    () => upsertNativeAdDecisionSnapshots([invalidHeldEconomicCut], db),
    "23514",
    "D063 held economic Cut cannot retain action authority",
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

  const authorizedAndBlocked = await insertLineage(client, {
    jobRunId: "00000000-0000-4000-8000-000000000937",
    adId: "ad-authorized-and-blocked",
    marker: "5",
  });
  const invalidAuthorizedAndBlocked = snapshotPayload({
    jobRunId: "00000000-0000-4000-8000-000000000937",
    adId: "ad-authorized-and-blocked",
    label: "cut",
    ...authorizedAndBlocked,
  });
  invalidAuthorizedAndBlocked.blocked_action_type = "cut";
  await expectPostgresError(
    () => upsertNativeAdDecisionSnapshots([invalidAuthorizedAndBlocked], db),
    "23514",
    "authorized native action cannot retain a blocked action",
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

  // Recreate the preceding image's authority contract around a real pending
  // row, then prove the production migration clears legacy raw-label
  // authorization before installing the stricter CHECK.
  await client.query(
    `DELETE FROM engine_v3_ad_decision_snapshots_daily
     WHERE decision_entity_id = 'ad-review-only-cut'`,
  );
  await client.query(
    `ALTER TABLE engine_v3_ad_decision_snapshots_daily
     DROP CONSTRAINT engine_v3_ad_snapshots_authority_check`,
  );
  await client.query(
    `UPDATE engine_v3_ad_decision_snapshots_daily
     SET authorized_action = 'cut'
     WHERE decision_entity_id = 'ad-pending-cut'`,
  );
  await client.query(
    `ALTER TABLE engine_v3_ad_decision_snapshots_daily
     ADD CONSTRAINT engine_v3_ad_snapshots_authority_check
     CHECK ${LEGACY_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK}`,
  );
  await upsertNativeAdDecisionSnapshots([invalidAuthorizedAndBlocked], db);
  await expectPostgresError(
    () => client.query(ALTER_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_SQL),
    "23514",
    "legacy contradictory authority upgrade fails closed",
  );
  await client.query(
    `DELETE FROM engine_v3_ad_decision_snapshots_daily
     WHERE decision_entity_id = 'ad-authorized-and-blocked'`,
  );
  await client.query(ALTER_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_SQL);
  const upgradedPending = await client.query<{
    authorized_action: string | null;
    blocked_action_type: string | null;
  }>(
    `SELECT authorized_action, blocked_action_type
     FROM engine_v3_ad_decision_snapshots_daily
     WHERE decision_entity_id = 'ad-pending-cut'`,
  );
  assert(
    upgradedPending.rows[0]?.authorized_action === null &&
      upgradedPending.rows[0]?.blocked_action_type === "cut",
    "Legacy pending authorization was not cleared before the stricter CHECK.",
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
  const largeManifestFixture =
    await verifyGenerationBoundLargeManifestHydration(client);
  await verifyTombstoneAndHistoricalCutoff(client);
  await verifyCurrentIdentityAndConfigFallback(client);
  await verifyFirstWriteEvaluationLinkage(client);
  await verifyPruneRetryAndConstraints(client, db);
  await verifyCalibrationReuseAccountIdentity(client, db);
  await verifyRunAdDecisionsJobSecondEventBatchRollback(
    client,
    largeManifestFixture,
  );
  await verifyMetaAdDailyWriteOwnershipAuthority(client);
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
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/native_ad_seam`;
    process.env.DATABASE_URL = connectionString;
    resetDbClientCache();
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await runSeam(client);
    } finally {
      await client.end();
      resetDbClientCache();
    }
    console.log(
      "[native-ad-seam] PASS capture-axis and compaction-aware receipts, generation-bound 501-row hydration, second-event-batch rollback, tombstone, historical cutoff, first-write linkage, receipt prune, retry, account-identity reuse, D063 held Cut authority, three-valued legacy authority upgrade, FK, soft-only, and daily-fact owner fail-closed checks",
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
