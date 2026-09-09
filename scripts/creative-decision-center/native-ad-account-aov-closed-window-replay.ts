#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { resolveAccountDecisionProfile } from "@/lib/creative-decision-engine/account-decision-profile";
import {
  canonicalSha256,
  type NativeAdSoftOnlyDecisionProfile,
} from "@/lib/creative-decision-engine/canonical-evaluation";
import type {
  BusinessTargetPack,
  CreativeDecisionDataSource,
} from "@/lib/creative-decision-engine/data-source";
import type { EngineV3Flags } from "@/lib/creative-decision-engine/feature-flags";
import {
  buildNativeAdOptimizationContext,
  computeNativeAdCalibrationBatch,
  mapNativeAdCalibrationSourceRow,
  type NativeAdCalibrationBatch,
  type NativeAdCalibrationCell,
  type NativeAdCalibrationSourceRow,
  type NativeAdTargetAuthorityInput,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import {
  computeNativeAdDecisions,
  computeSoftOnlyNativeAdDecisions,
  type AdDecisionComputation,
} from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION } from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import {
  adDecisionStabilityKey,
  type PreviousAdPublishedLabel,
} from "@/lib/creative-decision-engine/decision-stability";
import type { CampaignContextLabelMap } from "@/lib/creative-decision-engine/campaign-context/source";
import { META_CANONICAL_METRIC_SCHEMA_VERSION } from "@/lib/meta/canonical-metrics";
import { resolveMetaFunnelCohort } from "@/lib/meta/funnel-cohort";
import type {
  AccountDecisionProfile,
  AdDecisionInput,
  CampaignObjective,
  CommercialTargetFreshness,
  DataHealth,
  DecisionProfileScope,
  DecisionLabel,
} from "@/lib/creative-decision-engine/types";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  configureOperationalScriptRuntime,
  withOperationalStartupLogsSilenced,
} from "@/scripts/_operational-runtime";
import {
  outcomeWindowDates,
  selectForwardActionReceipts,
  summarizeActionExposure,
  type ActionReceipt,
} from "@/scripts/creative-decision-center/native-ad-grain-paired-replay";
import {
  D061_CLOSED_OUTCOME_WINDOWS,
  D061_LOCKED_TEST_END,
  D061_LOCKED_TEST_START,
  d061StableHash,
  evaluateD061ClosedWindowGate,
  type D061ClosedOutcome,
  type D061ClosedWindowReplayRow,
  type D061ReplayDecision,
  type D061ExpectedAccountStratum,
} from "@/scripts/creative-decision-center/d061-account-aov-closed-window-gate";
import {
  buildRepositoryContentManifest,
  COMPACT_REPLAY_PROOF_CONTRACT_VERSION,
  REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION,
  REPLAY_CALIBRATION_CONTEXT_PROOF_SET_CONTRACT_VERSION,
} from "@/scripts/creative-decision-center/native-ad-account-aov-authority-replay";

const CONTRACT_VERSION =
  "adsecute.meta.d061-account-aov-closed-window-replay.v3" as const;
// One full D036 cooldown before the locked test window supplies chronological
// prior-label warm-up without evaluating months of out-of-gate opportunities.
const DEFAULT_START_DATE = "2026-05-25";
const DEFAULT_DECISION_END_DATE = "2026-06-27";
const DEFAULT_OUTCOME_CEILING = "2026-07-11";
const DEFAULT_JSON_OUT =
  "/tmp/native-ad-account-aov-closed-window-replay-2026-07-19.json";
const DEFAULT_MD_OUT =
  "/tmp/native-ad-account-aov-closed-window-replay-2026-07-19.md";
const DECISION_COOLDOWN_DAYS = 7;
const TUNNEL_PORT = "15432";
const STATEMENT_TIMEOUT_MS = 30_000;

type DbRow = Record<string, unknown>;

export interface D061ClosedWindowReplayArgs {
  startDate: string;
  decisionEndDate: string;
  outcomeCeiling: string;
  authorityAsOfDate: string;
  businesses: string[];
  accounts: D061ExpectedAccountStratum[];
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
}

interface BusinessIdentity {
  id: string;
  name: string;
}

interface HistoricalTarget extends NativeAdTargetAuthorityInput {
  businessId: string;
}

interface D061ScopedActionReceipt extends ActionReceipt {
  scopeType: "ad" | "adset" | "campaign" | "unknown";
  scopeId: string;
}

interface LegacyTargetDisplayCorroboration {
  businessId: string;
  businessName: string;
  snapshotRows: number;
  targetRoasDisplays: string[];
  breakEvenRoasDisplays: string[];
  firstCreatedAt: string | null;
  lastCreatedAt: string | null;
}

interface AggregateMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  // Nullable alongside the other optional provider metrics below: one
  // unreported contributing row makes the population's total unknown.
  linkClicks: number | null;
  conversions: number;
  revenue: number;
  landingPageViews: number | null;
  addToCart: number | null;
  initiateCheckout: number | null;
  thumbstop: number | null;
  sourceRowCount: number;
  firstDate: string | null;
  lastSpendDate: string | null;
  roas: number | null;
  cpa: number | null;
  ctr: number | null;
}

interface FixedOpportunityCandidate {
  fixedKey: string;
  scoreEligible: boolean;
  business: BusinessIdentity;
  providerAccountRefId: string;
  providerAccountId: string;
  accountTimezone: string;
  accountCurrency: string;
  adId: string;
  campaignId: string;
  adsetId: string;
  objective: CampaignObjective;
  optimizationGoal: string | null;
  customEventType: string | null;
  asOfDate: string;
  cutoff: string;
  /** Immutable history row with its actual recorded_at retained for audit. */
  target: HistoricalTarget;
  /** Review-only target restatement supplied to the calculation. */
  productionTarget: HistoricalTarget;
  targetRecordedAfterCutoff: boolean;
  targetAgeDays: number;
  targetFreshness: CommercialTargetFreshness;
  currentDay: AggregateMetrics;
  window7: AggregateMetrics;
  window28: AggregateMetrics;
  allHistory: AggregateMetrics;
  sourceRows: NativeAdCalibrationSourceRow[];
  actionReceipts: D061ScopedActionReceipt[];
  actionCoverageStatus:
    "complete_ad_and_parent_scopes" | "unknown_parent_scopes";
  decisionStatusProof: {
    mode: "restated_daily_delivery";
    exactAtCutoff: false;
    effectiveStatus: "ACTIVE";
    sourceRowId: string;
    sourceDate: string;
    proofHash: string;
  };
  decisionCampaignContextProof: {
    mode: "restated_neutral_medium";
    exactAtCutoff: false;
    campaignId: string;
    kind: null;
    contextTrust: "medium";
    proofHash: string;
  };
}

interface LoadedReplayData {
  businesses: BusinessIdentity[];
  targets: Map<string, HistoricalTarget[]>;
  sourceRows: NativeAdCalibrationSourceRow[];
  completeness: Map<string, boolean>;
  actionReceipts: D061ScopedActionReceipt[];
  legacyTargetDisplayCorroboration: LegacyTargetDisplayCorroboration[];
  transaction: {
    isolation: "repeatable read";
    readOnly: true;
    statementTimeoutMs: 30_000;
    applicationName: string;
  };
}

interface CachedSourceSlice {
  rows: NativeAdCalibrationSourceRow[];
  restatedRows: NativeAdCalibrationSourceRow[];
  excludedNonFinalizedOrHierarchyRowCount: number;
  restatementProofHash: string;
  sourceRowsUpdatedAfterCutoff: number;
  sourceAvailabilityManifestHash: string;
  hierarchyManifestHash: string;
  hierarchyRowsAfterCutoff: number;
}

const REPLAY_DATA_HEALTH: DataHealth = {
  calibration: {
    asOfDate: null,
    computedAt: null,
    sourceFreshnessHours: 0,
    staleTier: "none",
    fallbackMode: "precomputed",
    note: "D061 paired fixed-input restated replay",
  },
  lifecycle: {
    asOfDate: null,
    computedAt: null,
    sourceFreshnessHours: null,
    staleTier: "unknown",
    fallbackMode: "insufficient",
    note: "No historical native-ad lifecycle authority is projected",
  },
  decisions: {
    asOfDate: null,
    computedAt: null,
    sourceFreshnessHours: 0,
    staleTier: "none",
    fallbackMode: "precomputed",
    note: "D061 paired fixed-input restated replay",
  },
  worstTier: "unknown",
  degraded: false,
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const normalized = value.trim();
  return normalized || null;
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function diffDays(later: string, earlier: string): number {
  return Math.round(
    (Date.parse(`${later}T00:00:00.000Z`) -
      Date.parse(`${earlier}T00:00:00.000Z`)) /
      86_400_000,
  );
}

function dateRange(start: string, end: string): string[] {
  const result: string[] = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    result.push(cursor);
  }
  return result;
}

function validDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} is invalid: ${value}`);
  }
}

export function parseD061ClosedWindowReplayArgs(
  argv: string[],
): D061ClosedWindowReplayArgs {
  const value = (name: string) =>
    argv
      .find((token) => token.startsWith(`--${name}=`))
      ?.slice(name.length + 3) ?? null;
  const businesses = argv
    .filter((token) => token.startsWith("--business="))
    .flatMap((token) => token.slice(11).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  const accounts = argv
    .filter((token) => token.startsWith("--account="))
    .map((token) => token.slice(10))
    .map((value) => {
      const separator = value.lastIndexOf(":");
      const label = separator > 0 ? value.slice(0, separator).trim() : "";
      const providerAccountId =
        separator > 0 ? value.slice(separator + 1).trim() : "";
      if (!label || !providerAccountId) {
        throw new Error("--account must be Label:provider_account_id");
      }
      return {
        key: `account_${d061StableHash({ label, providerAccountId }).slice(0, 12)}`,
        label,
        providerAccountId,
      } satisfies D061ExpectedAccountStratum;
    });
  if (
    new Set(accounts.map((account) => account.providerAccountId)).size !==
    accounts.length
  ) {
    throw new Error("--account provider_account_id values must be unique");
  }
  const authorityAsOfValues = argv
    .filter((token) => token.startsWith("--authority-as-of="))
    .map((token) => token.slice("--authority-as-of=".length));
  if (authorityAsOfValues.length === 0 || !authorityAsOfValues[0]) {
    throw new Error(
      "--authority-as-of=YYYY-MM-DD is required for current-day cross-artifact proof",
    );
  }
  if (authorityAsOfValues.length !== 1) {
    throw new Error("--authority-as-of must be provided exactly once");
  }
  const authorityAsOfDate = authorityAsOfValues[0];
  const args = {
    startDate: value("start") ?? DEFAULT_START_DATE,
    decisionEndDate: value("end") ?? DEFAULT_DECISION_END_DATE,
    outcomeCeiling: value("outcome-ceiling") ?? DEFAULT_OUTCOME_CEILING,
    authorityAsOfDate,
    businesses: [...new Set(businesses)].sort(),
    accounts,
    jsonOut: value("json-out") ?? DEFAULT_JSON_OUT,
    mdOut: value("md-out") ?? DEFAULT_MD_OUT,
    writeFiles: argv.includes("--write-files"),
  };
  validDate(args.startDate, "--start");
  validDate(args.decisionEndDate, "--end");
  validDate(args.outcomeCeiling, "--outcome-ceiling");
  validDate(args.authorityAsOfDate, "--authority-as-of");
  if (args.startDate > args.decisionEndDate) {
    throw new Error("--start must be on or before --end");
  }
  if (addDays(args.decisionEndDate, 14) > args.outcomeCeiling) {
    throw new Error(
      "--outcome-ceiling must close the 14-day window after --end",
    );
  }
  return args;
}

function assertTunnelReadOnlyRuntime(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    url.port !== TUNNEL_PORT
  ) {
    throw new Error(
      "D061 closed-window replay requires the existing tunnel at 127.0.0.1:15432",
    );
  }
  const appName = process.env.PGAPPNAME?.trim();
  if (!appName) throw new Error("PGAPPNAME is required");
  const pgOptions = process.env.PGOPTIONS ?? "";
  if (!pgOptions.includes("default_transaction_read_only=on")) {
    throw new Error("PGOPTIONS must include default_transaction_read_only=on");
  }
  return appName;
}

function mapHistoricalTarget(row: DbRow): HistoricalTarget | null {
  const businessId = text(row.business_id);
  const sourceRowId = text(row.source_row_id);
  const effectiveAt = timestamp(row.effective_at);
  const recordedAt = timestamp(row.recorded_at);
  const operation = row.operation === "delete" ? "delete" : "upsert";
  if (!businessId || !sourceRowId) return null;
  const risk = text(row.default_risk_posture);
  return {
    businessId,
    sourceRowId,
    operation,
    targetCpa: numberOrNull(row.target_cpa),
    targetRoas: numberOrNull(row.target_roas),
    breakEvenCpa: numberOrNull(row.break_even_cpa),
    breakEvenRoas: numberOrNull(row.break_even_roas),
    operatorAovAssumption: numberOrNull(row.operator_aov_assumption),
    defaultRiskPosture:
      risk === "aggressive" || risk === "balanced" || risk === "conservative"
        ? risk
        : null,
    effectiveAt,
    recordedAt,
  };
}

async function loadReplayData(
  args: D061ClosedWindowReplayArgs,
): Promise<LoadedReplayData> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const applicationName = assertTunnelReadOnlyRuntime(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: applicationName,
  });
  await client.connect();
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const businessFilter = args.businesses.length > 0 ? args.businesses : null;
    const accountFilter =
      args.accounts.length > 0
        ? args.accounts.map((account) => account.providerAccountId)
        : null;
    const businessResult = await client.query<DbRow>(
      `
      SELECT DISTINCT business.id::text AS id, business.name
      FROM businesses business
      JOIN meta_ad_daily ad ON ad.business_id = business.id::text
      WHERE COALESCE(business.is_demo_business, FALSE) = FALSE
        AND ad.date BETWEEN $2::date AND $3::date
        AND (
          $1::text[] IS NULL
          OR business.id::text = ANY($1::text[])
          OR business.name = ANY($1::text[])
        )
        AND (
          $4::text[] IS NULL
          OR ad.provider_account_id = ANY($4::text[])
        )
      ORDER BY business.name, business.id::text
      `,
      [businessFilter, args.startDate, args.outcomeCeiling, accountFilter],
    );
    const businesses = businessResult.rows.flatMap((row) => {
      const id = text(row.id);
      const name = text(row.name);
      return id && name ? [{ id, name }] : [];
    });
    if (businesses.length === 0) throw new Error("No businesses matched");
    const businessIds = businesses.map((business) => business.id);

    const targetResult = await client.query<DbRow>(
      `
      SELECT
        history.id::text AS source_row_id,
        history.business_id::text AS business_id,
        history.operation,
        history.target_cpa,
        history.target_roas,
        history.break_even_cpa,
        history.break_even_roas,
        history.aov_assumption AS operator_aov_assumption,
        history.default_risk_posture,
        history.effective_at,
        history.recorded_at
      FROM business_target_pack_history history
      WHERE history.business_id = ANY($1::uuid[])
      ORDER BY
        history.business_id,
        history.effective_at,
        history.recorded_at,
        history.id
      `,
      [businessIds],
    );
    const targets = new Map<string, HistoricalTarget[]>();
    for (const row of targetResult.rows) {
      const target = mapHistoricalTarget(row);
      if (!target) continue;
      const list = targets.get(target.businessId) ?? [];
      list.push(target);
      targets.set(target.businessId, list);
    }

    const historyStart = addDays(args.startDate, -89);
    const sourceResult = await client.query<DbRow>(
      `
      SELECT
        ad.id::text AS source_row_id,
        COALESCE(ad.business_ref_id::text, ad.business_id) AS business_id,
        ad.provider_account_ref_id::text AS provider_account_ref_id,
        ad.provider_account_id,
        ad.date::text AS date,
        ad.campaign_id,
        ad.adset_id,
        ad.ad_id,
        NULLIF(BTRIM(ad.account_timezone), '') AS account_timezone,
        NULLIF(BTRIM(ad.account_currency), '') AS account_currency,
        NULLIF(BTRIM(ad.account_timezone), '') AS source_account_timezone,
        NULLIF(BTRIM(ad.account_currency), '') AS source_account_currency,
        ad.metric_schema_version,
        campaign.objective,
        COALESCE(adset.optimization_goal, campaign.optimization_goal) AS optimization_goal,
        COALESCE(adset.custom_event_type, campaign.custom_event_type) AS custom_event_type,
        ad.spend,
        ad.impressions,
        ad.clicks,
        ad.link_clicks,
        ad.conversions,
        ad.revenue,
        (NULLIF(ad.payload_json->>'landing_page_views', ''))::double precision AS landing_page_views,
        (NULLIF(ad.payload_json->>'add_to_cart', ''))::double precision AS add_to_cart,
        (NULLIF(ad.payload_json->>'initiate_checkout', ''))::double precision AS initiate_checkout,
        (NULLIF(ad.payload_json->>'thumbstop', ''))::double precision AS thumbstop,
        ad.truth_state,
        ad.validation_status,
        ad.finalized_at,
        ad.created_at,
        ad.updated_at,
        campaign.id::text AS campaign_source_row_id,
        campaign.truth_state AS campaign_truth_state,
        campaign.validation_status AS campaign_validation_status,
        campaign.created_at AS campaign_created_at,
        campaign.updated_at AS campaign_updated_at,
        adset.id::text AS adset_source_row_id,
        adset.truth_state AS adset_truth_state,
        adset.validation_status AS adset_validation_status,
        adset.created_at AS adset_created_at,
        adset.updated_at AS adset_updated_at
      FROM meta_ad_daily ad
      LEFT JOIN LATERAL (
        SELECT campaign_day.*
        FROM meta_campaign_daily campaign_day
        WHERE campaign_day.business_id = ad.business_id
          AND campaign_day.provider_account_ref_id = ad.provider_account_ref_id
          AND campaign_day.provider_account_id = ad.provider_account_id
          AND campaign_day.campaign_id = ad.campaign_id
          AND campaign_day.date = ad.date
        ORDER BY campaign_day.updated_at DESC, campaign_day.id DESC
        LIMIT 1
      ) campaign ON TRUE
      LEFT JOIN LATERAL (
        SELECT adset_day.*
        FROM meta_adset_daily adset_day
        WHERE adset_day.business_id = ad.business_id
          AND adset_day.provider_account_ref_id = ad.provider_account_ref_id
          AND adset_day.provider_account_id = ad.provider_account_id
          AND adset_day.adset_id = ad.adset_id
          AND adset_day.date = ad.date
        ORDER BY adset_day.updated_at DESC, adset_day.id DESC
        LIMIT 1
      ) adset ON TRUE
      WHERE ad.business_id = ANY($1::text[])
        AND ad.provider_account_ref_id IS NOT NULL
        AND ad.date BETWEEN $2::date AND $3::date
        AND (
          $4::text[] IS NULL
          OR ad.provider_account_id = ANY($4::text[])
        )
      ORDER BY
        ad.business_ref_id,
        ad.provider_account_ref_id,
        ad.provider_account_id,
        ad.ad_id,
        ad.date,
        ad.id
      `,
      [businessIds, historyStart, args.outcomeCeiling, accountFilter],
    );
    const sourceRows = sourceResult.rows.map(mapNativeAdCalibrationSourceRow);

    const completenessResult = await client.query<DbRow>(
      `
      SELECT
        account.business_id::text AS business_id,
        account.provider_account_id,
        account.date::text AS date,
        BOOL_AND(
          UPPER(account.truth_state) = 'FINALIZED'
          AND UPPER(account.validation_status) = 'PASSED'
        ) AS complete
      FROM meta_account_daily account
      WHERE account.business_id = ANY($1::text[])
        AND account.date BETWEEN $2::date AND $3::date
        AND (
          $4::text[] IS NULL
          OR account.provider_account_id = ANY($4::text[])
        )
      GROUP BY
        account.business_id,
        account.provider_account_id,
        account.date
      `,
      [businessIds, args.startDate, args.outcomeCeiling, accountFilter],
    );
    const completeness = new Map<string, boolean>();
    for (const row of completenessResult.rows) {
      const businessId = text(row.business_id);
      const accountId = text(row.provider_account_id);
      const date = text(row.date)?.slice(0, 10) ?? null;
      if (!businessId || !accountId || !date) continue;
      completeness.set(
        `${businessId}::${accountId}::${date}`,
        row.complete === true,
      );
    }

    const actionResult = await client.query<DbRow>(
      `
      SELECT
        action.id::text,
        action.business_id::text,
        action.ad_id,
        action.resulting_ad_id,
        action.action,
        action.status,
        action.requested_at,
        action.verified_at,
        action.payload_request
      FROM meta_ads_action_log action
      WHERE action.business_id = ANY($1::uuid[])
        AND action.ad_id IS NOT NULL
        AND action.requested_at <= ($2::date + INTERVAL '1 day')
      ORDER BY action.business_id, action.ad_id, action.requested_at, action.id
      `,
      [businessIds, args.outcomeCeiling],
    );
    const actionReceipts = actionResult.rows.flatMap((row) => {
      const id = text(row.id);
      const businessId = text(row.business_id);
      const adId = text(row.ad_id);
      const requestedAt = timestamp(row.requested_at);
      if (!id || !businessId || !adId || !requestedAt) return [];
      const payload =
        row.payload_request &&
        typeof row.payload_request === "object" &&
        !Array.isArray(row.payload_request)
          ? (row.payload_request as Record<string, unknown>)
          : {};
      const requestedScope = text(payload.scope_type);
      const action = text(row.action) ?? "unknown";
      const scopeType: D061ScopedActionReceipt["scopeType"] =
        requestedScope === "campaign" || action === "launch_campaign"
          ? "campaign"
          : requestedScope === "adset" || action === "launch_adset"
            ? "adset"
            : requestedScope === null || requestedScope === "ad"
              ? "ad"
              : "unknown";
      const scopeId = text(row.resulting_ad_id) ?? adId;
      return [
        {
          id,
          businessId,
          adId,
          action,
          status: text(row.status) ?? "unknown",
          requestedAt,
          verifiedAt: timestamp(row.verified_at),
          dryRun: payload.dry_run === true,
          scopeType,
          scopeId,
        } satisfies D061ScopedActionReceipt,
      ];
    });

    const legacyCorroborationResult = await client.query<DbRow>(
      `
      WITH per_snapshot AS (
        SELECT
          business.id::text AS business_id,
          business.name AS business_name,
          snapshot.snapshot_date,
          snapshot.rec_id,
          snapshot.created_at,
          MAX(item->>'value') FILTER (
            WHERE item->>'label' = 'Target ROAS'
          ) AS target_roas_display,
          MAX(item->>'value') FILTER (
            WHERE item->>'label' = 'Break-even ROAS'
          ) AS break_even_roas_display
        FROM meta_decision_snapshots_daily snapshot
        JOIN businesses business
          ON business.id::text = snapshot.business_id
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(snapshot.evidence->'items', '[]'::jsonb)
        ) item
        WHERE business.id = ANY($1::uuid[])
          AND snapshot.snapshot_date BETWEEN $2::date AND $3::date
          AND snapshot.created_at < (
            snapshot.snapshot_date + INTERVAL '1 day'
          )
        GROUP BY
          business.id,
          business.name,
          snapshot.snapshot_date,
          snapshot.rec_id,
          snapshot.created_at
      )
      SELECT
        business_id,
        business_name,
        COUNT(*) FILTER (
          WHERE target_roas_display IS NOT NULL
            AND break_even_roas_display IS NOT NULL
        )::integer AS snapshot_rows,
        ARRAY_REMOVE(
          ARRAY_AGG(DISTINCT target_roas_display), NULL
        ) AS target_roas_displays,
        ARRAY_REMOVE(
          ARRAY_AGG(DISTINCT break_even_roas_display), NULL
        ) AS break_even_roas_displays,
        MIN(created_at) AS first_created_at,
        MAX(created_at) AS last_created_at
      FROM per_snapshot
      GROUP BY business_id, business_name
      ORDER BY business_name, business_id
      `,
      [businessIds, D061_LOCKED_TEST_START, D061_LOCKED_TEST_END],
    );
    const legacyTargetDisplayCorroboration =
      legacyCorroborationResult.rows.flatMap((row) => {
        const businessId = text(row.business_id);
        const businessName = text(row.business_name);
        if (!businessId || !businessName) return [];
        const strings = (value: unknown) =>
          Array.isArray(value)
            ? value.flatMap((item) => {
                const parsed = text(item);
                return parsed ? [parsed] : [];
              })
            : [];
        return [
          {
            businessId,
            businessName,
            snapshotRows: numberOrNull(row.snapshot_rows) ?? 0,
            targetRoasDisplays: strings(row.target_roas_displays),
            breakEvenRoasDisplays: strings(row.break_even_roas_displays),
            firstCreatedAt: timestamp(row.first_created_at),
            lastCreatedAt: timestamp(row.last_created_at),
          } satisfies LegacyTargetDisplayCorroboration,
        ];
      });

    await client.query("ROLLBACK");
    return {
      businesses,
      targets,
      sourceRows,
      completeness,
      actionReceipts,
      legacyTargetDisplayCorroboration,
      transaction: {
        isolation: "repeatable read",
        readOnly: true,
        statementTimeoutMs: STATEMENT_TIMEOUT_MS,
        applicationName,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function normalizedStatus(value: string | null | undefined) {
  return value?.trim().toUpperCase() ?? "";
}

function normalizedCalibrationToken(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized
    ? normalized.replace(/[\s-]+/g, "_").toUpperCase()
    : null;
}

function normalizedCalibrationText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized || null;
}

function normalizedCalibrationDate(value: string) {
  const normalized = normalizedCalibrationText(value);
  const match = normalized?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  if (!match) return null;
  const parsed = new Date(`${match}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === match
    ? match
    : null;
}

function normalizedCalibrationTimestamp(
  value: string | null | undefined,
) {
  const normalized = normalizedCalibrationText(value);
  if (!normalized) return null;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function calibrationManifestNumber(
  value: number | null | undefined,
): number | string | null {
  if (value == null) return null;
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return value;
}

function normalizeD061RestatedFactRow(
  row: NativeAdCalibrationSourceRow,
): NativeAdCalibrationSourceRow {
  return {
    ...row,
    sourceRowId: normalizedCalibrationText(row.sourceRowId) ?? "",
    businessId: normalizedCalibrationText(row.businessId) ?? "",
    providerAccountRefId:
      normalizedCalibrationText(row.providerAccountRefId) ?? "",
    providerAccountId:
      normalizedCalibrationText(row.providerAccountId) ?? "",
    date: normalizedCalibrationDate(row.date) ?? "",
    campaignId: normalizedCalibrationText(row.campaignId),
    adsetId: normalizedCalibrationText(row.adsetId),
    adId: normalizedCalibrationText(row.adId) ?? "",
    accountTimezone: normalizedCalibrationText(row.accountTimezone),
    accountCurrency: normalizedCalibrationToken(row.accountCurrency),
    sourceAccountTimezone: normalizedCalibrationText(
      row.sourceAccountTimezone,
    ),
    sourceAccountCurrency: normalizedCalibrationToken(
      row.sourceAccountCurrency,
    ),
    objective: normalizedCalibrationToken(row.objective),
    optimizationGoal: normalizedCalibrationToken(row.optimizationGoal),
    customEventType: normalizedCalibrationToken(row.customEventType),
    truthState: normalizedCalibrationToken(row.truthState),
    validationStatus: normalizedCalibrationToken(row.validationStatus),
    finalizedAt: normalizedCalibrationTimestamp(row.finalizedAt),
    createdAt: normalizedCalibrationTimestamp(row.createdAt) ?? "",
    updatedAt: normalizedCalibrationTimestamp(row.updatedAt) ?? "",
    campaignSourceRowId: normalizedCalibrationText(
      row.campaignSourceRowId,
    ),
    campaignTruthState: normalizedCalibrationToken(row.campaignTruthState),
    campaignValidationStatus: normalizedCalibrationToken(
      row.campaignValidationStatus,
    ),
    campaignCreatedAt: normalizedCalibrationTimestamp(row.campaignCreatedAt),
    campaignUpdatedAt: normalizedCalibrationTimestamp(row.campaignUpdatedAt),
    adsetSourceRowId: normalizedCalibrationText(row.adsetSourceRowId),
    adsetTruthState: normalizedCalibrationToken(row.adsetTruthState),
    adsetValidationStatus: normalizedCalibrationToken(
      row.adsetValidationStatus,
    ),
    adsetCreatedAt: normalizedCalibrationTimestamp(row.adsetCreatedAt),
    adsetUpdatedAt: normalizedCalibrationTimestamp(row.adsetUpdatedAt),
  };
}

function canonicalRestatedFact(row: NativeAdCalibrationSourceRow): boolean {
  // Legacy peer-calibration truth may have no finalized_at. The production
  // calibration builder keeps that peer row while independently excluding it
  // from the strict physical-account AOV numerator.
  return (
    row.metricSchemaVersion === META_CANONICAL_METRIC_SCHEMA_VERSION &&
    normalizedStatus(row.truthState) === "FINALIZED" &&
    normalizedStatus(row.validationStatus) === "PASSED" &&
    Number.isFinite(row.spend) &&
    row.spend >= 0 &&
    Number.isFinite(row.impressions) &&
    row.impressions >= 0 &&
    Number.isFinite(row.clicks) &&
    row.clicks >= 0 &&
    // Nullable: an unreported link-click day is incomplete evidence, not an
    // invalid row, so absence is admitted and only a bad NUMBER is refused.
    (row.linkClicks === null ||
      (Number.isFinite(row.linkClicks) && row.linkClicks >= 0)) &&
    Number.isInteger(row.conversions) &&
    row.conversions >= 0 &&
    Number.isFinite(row.revenue) &&
    row.revenue >= 0
  );
}

export function canonicalRestatedCalibrationFact(
  row: NativeAdCalibrationSourceRow,
): boolean {
  return (
    canonicalRestatedFact(row) &&
    row.campaignSourceRowId !== null &&
    normalizedStatus(row.campaignTruthState) === "FINALIZED" &&
    normalizedStatus(row.campaignValidationStatus) === "PASSED" &&
    row.adsetSourceRowId !== null &&
    normalizedStatus(row.adsetTruthState) === "FINALIZED" &&
    normalizedStatus(row.adsetValidationStatus) === "PASSED"
  );
}

function factDecisionSignature(row: NativeAdCalibrationSourceRow) {
  // This is deliberately identical to production sourceContentSignature.
  // Truth/freshness and deterministic physical-row selection are separate
  // stages: including their selectors/timestamps here would falsely classify
  // content-identical, cutoff-safe warehouse duplicates as contradictions.
  return d061StableHash({
    businessId: normalizedCalibrationText(row.businessId),
    providerAccountRefId: normalizedCalibrationText(
      row.providerAccountRefId,
    ),
    providerAccountId: normalizedCalibrationText(row.providerAccountId),
    date: normalizedCalibrationDate(row.date),
    campaignId: normalizedCalibrationText(row.campaignId),
    adsetId: normalizedCalibrationText(row.adsetId),
    adId: normalizedCalibrationText(row.adId),
    accountTimezone: normalizedCalibrationText(row.accountTimezone),
    accountCurrency: normalizedCalibrationToken(row.accountCurrency),
    sourceAccountTimezone: normalizedCalibrationText(
      row.sourceAccountTimezone,
    ),
    sourceAccountCurrency: normalizedCalibrationToken(
      row.sourceAccountCurrency,
    ),
    metricSchemaVersion: row.metricSchemaVersion,
    objective: normalizedCalibrationToken(row.objective),
    optimizationGoal: normalizedCalibrationToken(row.optimizationGoal),
    customEventType: normalizedCalibrationToken(row.customEventType),
    spend: calibrationManifestNumber(row.spend),
    impressions: calibrationManifestNumber(row.impressions),
    clicks: calibrationManifestNumber(row.clicks),
    linkClicks: calibrationManifestNumber(row.linkClicks),
    conversions: calibrationManifestNumber(row.conversions),
    revenue: calibrationManifestNumber(row.revenue),
    landingPageViews: calibrationManifestNumber(row.landingPageViews),
    addToCart: calibrationManifestNumber(row.addToCart),
    initiateCheckout: calibrationManifestNumber(row.initiateCheckout),
    thumbstop: calibrationManifestNumber(row.thumbstop),
  });
}

function duplicateRowAvailableAtCutoff(
  row: NativeAdCalibrationSourceRow,
  cutoff: string,
) {
  const requiredTimestamps = [
    row.createdAt,
    row.updatedAt,
    row.campaignCreatedAt,
    row.campaignUpdatedAt,
    row.adsetCreatedAt,
    row.adsetUpdatedAt,
  ];
  const timestamps =
    row.finalizedAt === null
      ? requiredTimestamps
      : [...requiredTimestamps, row.finalizedAt];
  return timestamps.every((value) => {
    const normalized = normalizedCalibrationTimestamp(value);
    return normalized !== null && normalized <= cutoff;
  });
}

export function deduplicateD061RestatedFacts(
  rows: readonly NativeAdCalibrationSourceRow[],
  options: { cutoff?: string } = {},
) {
  const groups = new Map<string, NativeAdCalibrationSourceRow[]>();
  for (const sourceRow of rows) {
    const row = normalizeD061RestatedFactRow(sourceRow);
    const key = [
      normalizedCalibrationText(row.businessId),
      normalizedCalibrationText(row.providerAccountRefId),
      normalizedCalibrationText(row.providerAccountId),
      normalizedCalibrationText(row.adId),
      normalizedCalibrationDate(row.date),
    ].join("::");
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const facts: NativeAdCalibrationSourceRow[] = [];
  const cutoff = options.cutoff;
  let conflictingDuplicateGroups = 0;
  let unsafeDuplicateGroups = 0;
  let duplicateSelectorRows = 0;
  const conflictingDuplicateSourceRowIds: string[] = [];
  const unsafeDuplicateSourceRowIds: string[] = [];
  for (const group of groups.values()) {
    if (new Set(group.map(factDecisionSignature)).size > 1) {
      conflictingDuplicateGroups += 1;
      conflictingDuplicateSourceRowIds.push(
        ...group.map((row) => row.sourceRowId),
      );
      continue;
    }
    const duplicateGroup = group.length > 1;
    const duplicateTruthSafe = group.every(
      canonicalRestatedCalibrationFact,
    );
    const duplicateCutoffSafe =
      cutoff === undefined ||
      group.every((row) => duplicateRowAvailableAtCutoff(row, cutoff));
    if (duplicateGroup && (!duplicateTruthSafe || !duplicateCutoffSafe)) {
      unsafeDuplicateGroups += 1;
      unsafeDuplicateSourceRowIds.push(
        ...group.map((row) => row.sourceRowId),
      );
      continue;
    }
    const representative = [...group].sort((left, right) =>
      (normalizedCalibrationText(left.sourceRowId) ?? "").localeCompare(
        normalizedCalibrationText(right.sourceRowId) ?? "",
      ),
    )[0];
    if (representative && canonicalRestatedFact(representative)) {
      facts.push(representative);
      duplicateSelectorRows += Math.max(0, group.length - 1);
    }
  }
  return {
    facts: facts.sort(
      (left, right) =>
        left.businessId.localeCompare(right.businessId) ||
        left.providerAccountRefId.localeCompare(
          right.providerAccountRefId,
        ) ||
        left.providerAccountId.localeCompare(right.providerAccountId) ||
        left.adId.localeCompare(right.adId) ||
        left.date.localeCompare(right.date) ||
        left.sourceRowId.localeCompare(right.sourceRowId),
    ),
    conflictingDuplicateGroups,
    conflictingDuplicateSourceRowIds:
      conflictingDuplicateSourceRowIds.sort(),
    unsafeDuplicateGroups,
    unsafeDuplicateSourceRowIds: unsafeDuplicateSourceRowIds.sort(),
    duplicateSelectorRows,
  };
}

function rowsBetween(
  rows: readonly NativeAdCalibrationSourceRow[],
  start: string,
  end: string,
) {
  return rows.filter((row) => row.date >= start && row.date <= end);
}

function sumOptional(
  rows: readonly NativeAdCalibrationSourceRow[],
  selector: (row: NativeAdCalibrationSourceRow) => number | null | undefined,
) {
  let observed = false;
  let total = 0;
  for (const row of rows) {
    const value = selector(row);
    if (value == null || !Number.isFinite(value)) continue;
    observed = true;
    total += value;
  }
  return observed ? total : null;
}

function aggregate(
  rows: readonly NativeAdCalibrationSourceRow[],
): AggregateMetrics {
  const spend = rows.reduce((total, row) => total + row.spend, 0);
  const impressions = rows.reduce((total, row) => total + row.impressions, 0);
  const clicks = rows.reduce((total, row) => total + row.clicks, 0);
  // Complete-only, matching the calibration job: one unreported row makes the
  // population's link-click total unknown rather than silently smaller.
  const linkClicks = rows.some((row) => row.linkClicks === null)
    ? null
    : rows.reduce((total, row) => total + (row.linkClicks ?? 0), 0);
  const conversions = rows.reduce((total, row) => total + row.conversions, 0);
  const revenue = rows.reduce((total, row) => total + row.revenue, 0);
  const dates = rows.map((row) => row.date).sort();
  const spendDates = rows
    .filter((row) => row.spend > 0)
    .map((row) => row.date)
    .sort();
  return {
    spend,
    impressions,
    clicks,
    linkClicks,
    conversions,
    revenue,
    landingPageViews: sumOptional(rows, (row) => row.landingPageViews),
    addToCart: sumOptional(rows, (row) => row.addToCart),
    initiateCheckout: sumOptional(rows, (row) => row.initiateCheckout),
    thumbstop: sumOptional(rows, (row) => row.thumbstop),
    sourceRowCount: rows.length,
    firstDate: dates[0] ?? null,
    lastSpendDate: spendDates.at(-1) ?? null,
    roas: spend > 0 ? revenue / spend : null,
    cpa: conversions > 0 ? spend / conversions : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
  };
}

function normalizeObjective(value: string | null): CampaignObjective | null {
  const objective = value?.trim().toUpperCase();
  if (objective === "SALES") return "OUTCOME_SALES";
  if (
    objective === "OUTCOME_SALES" ||
    objective === "OUTCOME_ENGAGEMENT" ||
    objective === "OUTCOME_TRAFFIC" ||
    objective === "OUTCOME_LEADS" ||
    objective === "OUTCOME_AWARENESS" ||
    objective === "OUTCOME_APP_PROMOTION"
  ) {
    return objective;
  }
  return null;
}

export function selectHistoricalTargetAtCutoff(
  targets: readonly HistoricalTarget[],
  cutoff: string,
): HistoricalTarget | null {
  const selected = [...targets]
    .filter(
      (target) =>
        target.effectiveAt !== null &&
        target.recordedAt !== null &&
        target.recordedAt >= target.effectiveAt &&
        target.effectiveAt <= cutoff &&
        target.recordedAt <= cutoff,
    )
    .sort(
      (left, right) =>
        (right.effectiveAt ?? "").localeCompare(left.effectiveAt ?? "") ||
        (right.recordedAt ?? "").localeCompare(left.recordedAt ?? "") ||
        (left.operation === right.operation
          ? 0
          : left.operation === "delete"
            ? -1
            : 1) ||
        (right.sourceRowId ?? "").localeCompare(left.sourceRowId ?? ""),
    )[0];
  return selected?.operation === "upsert" ? selected : null;
}

/**
 * Lane B only: select the latest target whose business-effective time is at or
 * before the historical decision cutoff. recordedAt remains the actual audit
 * timestamp and may be later than the cutoff; callers must explicitly restate
 * it before invoking current production math. This is never exact PIT proof.
 */
export function selectSemanticRestatedTargetAtCutoff(
  targets: readonly HistoricalTarget[],
  cutoff: string,
): HistoricalTarget | null {
  const selected = [...targets]
    .filter(
      (target) =>
        target.effectiveAt !== null &&
        target.recordedAt !== null &&
        target.effectiveAt <= cutoff,
    )
    .sort(
      (left, right) =>
        (right.effectiveAt ?? "").localeCompare(left.effectiveAt ?? "") ||
        (right.recordedAt ?? "").localeCompare(left.recordedAt ?? "") ||
        (left.operation === right.operation
          ? 0
          : left.operation === "delete"
            ? -1
            : 1) ||
        (right.sourceRowId ?? "").localeCompare(left.sourceRowId ?? ""),
    )[0];
  return selected?.operation === "upsert" ? selected : null;
}

function buildFixedOpportunityCohort(input: {
  args: D061ClosedWindowReplayArgs;
  data: LoadedReplayData;
  facts: readonly NativeAdCalibrationSourceRow[];
}) {
  const businessById = new Map(
    input.data.businesses.map((business) => [business.id, business]),
  );
  const sourceByAccount = new Map<string, NativeAdCalibrationSourceRow[]>();
  for (const row of input.data.sourceRows) {
    const key = [
      row.businessId,
      row.providerAccountRefId,
      row.providerAccountId,
    ].join("::");
    const list = sourceByAccount.get(key) ?? [];
    list.push(row);
    sourceByAccount.set(key, list);
  }
  const factsByAd = new Map<string, NativeAdCalibrationSourceRow[]>();
  for (const row of input.facts) {
    const key = [
      row.businessId,
      row.providerAccountRefId,
      row.providerAccountId,
      row.adId,
    ].join("::");
    const list = factsByAd.get(key) ?? [];
    list.push(row);
    factsByAd.set(key, list);
  }
  const receiptsByScope = new Map<string, D061ScopedActionReceipt[]>();
  for (const receipt of input.data.actionReceipts) {
    const key = `${receipt.businessId}::${receipt.scopeType}::${receipt.scopeId}`;
    const list = receiptsByScope.get(key) ?? [];
    list.push(receipt);
    receiptsByScope.set(key, list);
  }
  const candidates: FixedOpportunityCandidate[] = [];
  const lastSelected = new Map<string, string>();
  let preEffectiveTargetRows = 0;
  let nonPurchaseRows = 0;
  let missingContextRows = 0;
  let incompleteDecisionDayRows = 0;

  for (const [adKey, adRowsUnsorted] of [...factsByAd.entries()].sort()) {
    const adRows = [...adRowsUnsorted].sort((left, right) =>
      left.date.localeCompare(right.date),
    );
    for (const current of adRows) {
      if (
        current.date < input.args.startDate ||
        current.date > input.args.decisionEndDate ||
        (current.spend <= 0 && current.impressions <= 0)
      ) {
        continue;
      }
      const previousDate = lastSelected.get(adKey);
      const scoreEligible =
        previousDate === undefined ||
        diffDays(current.date, previousDate) >= DECISION_COOLDOWN_DAYS;
      const business = businessById.get(current.businessId);
      const objective = normalizeObjective(current.objective);
      const optimizationContext = buildNativeAdOptimizationContext(
        current.optimizationGoal,
        current.customEventType,
      );
      if (
        !business ||
        !objective ||
        !current.campaignId ||
        !current.adsetId ||
        !current.accountTimezone ||
        !current.accountCurrency ||
        !optimizationContext
      ) {
        missingContextRows += 1;
        continue;
      }
      if (
        input.data.completeness.get(
          `${current.businessId}::${current.providerAccountId}::${current.date}`,
        ) !== true
      ) {
        incompleteDecisionDayRows += 1;
        continue;
      }
      const cutoff = `${current.date}T03:00:00.000Z`;
      const target = selectSemanticRestatedTargetAtCutoff(
        input.data.targets.get(current.businessId) ?? [],
        cutoff,
      );
      if (
        !target ||
        target.targetRoas === null ||
        target.targetRoas <= 0 ||
        target.breakEvenRoas === null ||
        target.breakEvenRoas <= 0 ||
        !target.effectiveAt ||
        !target.recordedAt
      ) {
        preEffectiveTargetRows += 1;
        continue;
      }
      const window28 = aggregate(
        rowsBetween(adRows, addDays(current.date, -27), current.date),
      );
      const cohort = resolveMetaFunnelCohort({
        objective: current.objective,
        optimizationGoal: current.optimizationGoal,
        customEventType: current.customEventType,
        purchases: window28.conversions,
        revenue: window28.revenue,
      });
      if (cohort !== "purchase" || objective !== "OUTCOME_SALES") {
        nonPurchaseRows += 1;
        continue;
      }
      const targetAgeDays = diffDays(
        current.date,
        target.effectiveAt.slice(0, 10),
      );
      const accountKey = [
        current.businessId,
        current.providerAccountRefId,
        current.providerAccountId,
      ].join("::");
      const actionReceipts = [
        ...(receiptsByScope.get(`${current.businessId}::ad::${current.adId}`) ??
          []),
        ...(receiptsByScope.get(
          `${current.businessId}::adset::${current.adsetId}`,
        ) ?? []),
        ...(receiptsByScope.get(
          `${current.businessId}::campaign::${current.campaignId}`,
        ) ?? []),
      ].sort(
        (left, right) =>
          left.requestedAt.localeCompare(right.requestedAt) ||
          left.id.localeCompare(right.id),
      );
      const productionTarget: HistoricalTarget = {
        ...target,
        recordedAt: cutoff,
      };
      const candidateSourceRows = sourceByAccount.get(accountKey) ?? [];
      candidates.push({
        fixedKey: [accountKey, current.adId, current.date].join("::"),
        scoreEligible,
        business,
        providerAccountRefId: current.providerAccountRefId,
        providerAccountId: current.providerAccountId,
        accountTimezone: current.accountTimezone,
        accountCurrency: current.accountCurrency,
        adId: current.adId,
        campaignId: current.campaignId,
        adsetId: current.adsetId,
        objective,
        optimizationGoal: current.optimizationGoal,
        customEventType: current.customEventType,
        asOfDate: current.date,
        cutoff,
        target,
        productionTarget,
        targetRecordedAfterCutoff: target.recordedAt > cutoff,
        targetAgeDays,
        targetFreshness: targetAgeDays > 30 ? "stale" : "fresh",
        currentDay: aggregate(rowsBetween(adRows, current.date, current.date)),
        window7: aggregate(
          rowsBetween(adRows, addDays(current.date, -6), current.date),
        ),
        window28,
        allHistory: aggregate(adRows.filter((row) => row.date <= current.date)),
        sourceRows: candidateSourceRows,
        actionReceipts,
        actionCoverageStatus: "complete_ad_and_parent_scopes",
        decisionStatusProof: {
          mode: "restated_daily_delivery",
          exactAtCutoff: false,
          effectiveStatus: "ACTIVE",
          sourceRowId: current.sourceRowId,
          sourceDate: current.date,
          proofHash: d061StableHash({
            mode: "restated_daily_delivery",
            businessId: current.businessId,
            providerAccountRefId: current.providerAccountRefId,
            providerAccountId: current.providerAccountId,
            adId: current.adId,
            sourceRowId: current.sourceRowId,
            sourceDate: current.date,
            spend: current.spend,
            impressions: current.impressions,
          }),
        },
        decisionCampaignContextProof: {
          mode: "restated_neutral_medium",
          exactAtCutoff: false,
          campaignId: current.campaignId,
          kind: null,
          contextTrust: "medium",
          proofHash: d061StableHash({
            mode: "restated_neutral_medium",
            businessId: current.businessId,
            providerAccountRefId: current.providerAccountRefId,
            providerAccountId: current.providerAccountId,
            campaignId: current.campaignId,
            sourceRowId: current.sourceRowId,
            sourceDate: current.date,
            objective,
            optimizationContext,
          }),
        },
      });
      if (scoreEligible) lastSelected.set(adKey, current.date);
    }
  }
  return {
    candidates: candidates.sort(
      (left, right) =>
        left.asOfDate.localeCompare(right.asOfDate) ||
        left.business.id.localeCompare(right.business.id) ||
        left.providerAccountId.localeCompare(right.providerAccountId) ||
        left.adId.localeCompare(right.adId) ||
        left.fixedKey.localeCompare(right.fixedKey),
    ),
    exclusions: {
      preEffectiveTargetRows,
      nonPurchaseRows,
      missingContextRows,
      incompleteDecisionDayRows,
    },
  };
}

function clampObservedTimestamp(
  value: string | null,
  cutoff: string,
): string | null {
  if (value === null) return null;
  return value <= cutoff ? value : cutoff;
}

export function restateSourceAvailabilityAtCutoff(
  row: NativeAdCalibrationSourceRow,
  cutoff: string,
): NativeAdCalibrationSourceRow {
  return {
    ...row,
    createdAt: clampObservedTimestamp(row.createdAt, cutoff) ?? row.createdAt,
    updatedAt: clampObservedTimestamp(row.updatedAt, cutoff) ?? row.updatedAt,
    finalizedAt: clampObservedTimestamp(row.finalizedAt, cutoff),
    // Lane B is an explicit finalized-daily formula restatement, so the same
    // bounded availability projection applies to campaign/ad-set daily rows.
    // The unmodified timestamps remain in sourceAvailabilityManifestHash;
    // null context stays null and production admission still fails closed.
    campaignCreatedAt: clampObservedTimestamp(row.campaignCreatedAt, cutoff),
    campaignUpdatedAt: clampObservedTimestamp(row.campaignUpdatedAt, cutoff),
    adsetCreatedAt: clampObservedTimestamp(row.adsetCreatedAt, cutoff),
    adsetUpdatedAt: clampObservedTimestamp(row.adsetUpdatedAt, cutoff),
  };
}

function hierarchyUpdatedAfterCutoff(
  row: NativeAdCalibrationSourceRow,
  cutoff: string,
) {
  return [
    row.campaignCreatedAt,
    row.campaignUpdatedAt,
    row.adsetCreatedAt,
    row.adsetUpdatedAt,
  ].some((value) => value === null || value > cutoff);
}

function sourceUpdatedAfterCutoff(
  row: NativeAdCalibrationSourceRow,
  cutoff: string,
) {
  return [
    row.createdAt,
    row.updatedAt,
    row.finalizedAt,
    row.campaignCreatedAt,
    row.campaignUpdatedAt,
    row.adsetCreatedAt,
    row.adsetUpdatedAt,
  ].some((value) => value !== null && value > cutoff);
}

function targetPack(
  target: HistoricalTarget,
  freshness: CommercialTargetFreshness,
): BusinessTargetPack {
  return {
    targetCpa: target.targetCpa,
    targetRoas: target.targetRoas,
    breakEvenCpa: target.breakEvenCpa,
    breakEvenRoas: target.breakEvenRoas,
    operatorAovAssumption: target.operatorAovAssumption,
    defaultRiskPosture: target.defaultRiskPosture,
    updatedAt: target.recordedAt,
    freshness,
  };
}

function fixedFlags(businessId: string): EngineV3Flags {
  return {
    businessId,
    enabled: true,
    surfaceVisible: true,
    shadowOnly: false,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: true,
      shadowOnly: false,
    },
  };
}

function replayDataSource(input: {
  cell: NativeAdCalibrationCell;
  target: BusinessTargetPack;
}): CreativeDecisionDataSource {
  return {
    async getCreativeInput() {
      return null;
    },
    async getAccountCalibration() {
      return input.cell.accountCalibration;
    },
    async getCampaignCalibration() {
      return { calibration: null, matureCreativeCount: 0 };
    },
    async getAccountFunnelCalibration() {
      return input.cell.funnelCalibration;
    },
    async listCreativeInputs() {
      return [];
    },
    async getDataHealth() {
      return REPLAY_DATA_HEALTH;
    },
    async getLatestFunnelDiagnosis() {
      return null;
    },
    async getLatestOperatorResponse() {
      return null;
    },
    async getBusinessTargetPack() {
      return input.target;
    },
    async getDecisionCalibrationProfile() {
      return null;
    },
    async getMetaAttributedAov({ asOf }) {
      return {
        aovMean: null,
        purchaseCount: 0,
        totalRevenue: 0,
        windowStart: addDays(asOf, -89),
        windowEnd: asOf,
      };
    },
  };
}

function buildAdInput(
  candidate: FixedOpportunityCandidate,
  freshness: CommercialTargetFreshness,
): AdDecisionInput {
  const firstDate = candidate.allHistory.firstDate;
  const eventMetricsObserved =
    candidate.window28.landingPageViews !== null ||
    candidate.window28.addToCart !== null ||
    candidate.window28.initiateCheckout !== null ||
    candidate.window28.thumbstop !== null;
  return {
    decisionEntityType: "ad",
    decisionEntityId: candidate.adId,
    adId: candidate.adId,
    providerAccountId: candidate.providerAccountId,
    providerAccountRefId: candidate.providerAccountRefId,
    accountTimezone: candidate.accountTimezone,
    accountCurrency: candidate.accountCurrency,
    adsetId: candidate.adsetId,
    creativeId: null,
    optimizationGoal: candidate.optimizationGoal,
    customEventType: candidate.customEventType,
    creativeName: null,
    businessId: candidate.business.id,
    campaignId: candidate.campaignId,
    objective: candidate.objective,
    contextGrain: {
      providerAccountCount: 1,
      campaignCount: 1,
      adsetCount: 1,
      optimizationContextCount: 1,
      objectiveCount: 1,
      contextIdentityUnknown: false,
    },
    effectiveCohort: "purchase",
    spend: candidate.window28.spend,
    purchases: candidate.window28.conversions,
    purchaseValue: candidate.window28.revenue,
    impressions: candidate.window28.impressions,
    linkClicks: candidate.window28.linkClicks,
    roas: candidate.window28.roas,
    cpa: candidate.window28.cpa,
    ctr: candidate.window28.ctr,
    frequency: null,
    recent7dSpend: candidate.window7.spend,
    recent7dPurchases: candidate.window7.conversions,
    recent7dRoas: candidate.window7.roas,
    recent7dImpressions: candidate.window7.impressions,
    // Lane B is explicitly a finalized-daily formula restatement, not exact
    // historical execution parity. Positive delivery on the selected day is
    // the hash-bound neutral ACTIVE assumption used to reach production label
    // math; it never opens automation authority.
    effectiveStatus: candidate.decisionStatusProof.effectiveStatus,
    ageDays: firstDate ? diffDays(candidate.asOfDate, firstDate) + 1 : null,
    firstSeenAt: firstDate,
    firstSpendAt: firstDate,
    lastSpendAt: candidate.window28.lastSpendDate,
    spend24h: candidate.currentDay.spend,
    impressions24h: candidate.currentDay.impressions,
    reviewStatus: null,
    policyReason: null,
    disapprovalReason: null,
    limitedReason: null,
    dataFreshnessHours: 0,
    fatigueStatus: null,
    targetRoas: candidate.target.targetRoas,
    breakevenRoas: candidate.target.breakEvenRoas,
    commercialTargetFreshness: freshness,
    lifecyclePosition: null,
    daysSincePeak: null,
    peakRoas30d: null,
    peakConfidence: null,
    spendTrajectory30d: null,
    spendSlope7d: null,
    spendSlope30d: null,
    roasSlope7d: null,
    roasSlope30d: null,
    cpm:
      candidate.window28.impressions > 0
        ? (candidate.window28.spend / candidate.window28.impressions) * 1000
        : null,
    outboundClicks: null,
    landingPageViews: candidate.window28.landingPageViews,
    addToCart: candidate.window28.addToCart,
    initiateCheckout: candidate.window28.initiateCheckout,
    thumbstop: candidate.window28.thumbstop,
    video25Rate: null,
    video50Rate: null,
    video75Rate: null,
    video100Rate: null,
    qualityRanking: null,
    engagementRateRanking: null,
    conversionRateRanking: null,
    creativeFormat: null,
    metricEvidence: {
      sourceRowCount: candidate.window28.sourceRowCount,
      performanceMetricsObserved: true,
      eventMetricsObserved,
    },
    statusEvidence: {
      // No cutoff-safe state capture existed for this historical window.
      // Preserve that fact in the production input while the surrounding
      // replay contract carries the explicit delivery-restatement proof.
      source: "missing",
      sourceRecordId: null,
      observedAt: null,
      capturedAt: null,
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
  };
}

function mapDecision(input: {
  decision: {
    preAuthorityLabel: DecisionLabel;
    label: DecisionLabel;
    blockedActionType?: DecisionLabel | null;
    authorityBlocker: string | null;
    confidence: number;
    reason: string;
  };
  rawLabel: DecisionLabel;
}): D061ReplayDecision {
  return {
    preAuthorityLabel: input.decision.preAuthorityLabel,
    rawLabel: input.rawLabel,
    finalLabel: input.decision.label,
    blockedActionType: input.decision.blockedActionType ?? null,
    authorityBlocker: input.decision.authorityBlocker,
    confidence: input.decision.confidence,
    reason: input.decision.reason,
  };
}

interface ReplayComputation {
  mapped: D061ReplayDecision;
  computation: AdDecisionComputation;
  stabilityScope: DecisionProfileScope;
  commercialMaturitySpend: number | null;
}

function reviewOnlyCampaignContext(
  candidate: FixedOpportunityCandidate,
): CampaignContextLabelMap {
  const proof = candidate.decisionCampaignContextProof;
  return new Map([
    [
      proof.campaignId,
      {
        kind: proof.kind,
        testDimension: null,
        contextTrust: proof.contextTrust,
        provenance: {
          mode: "automatic" as const,
          source: "unknown" as const,
          campaignId: proof.campaignId,
          kind: null,
          testDimension: null,
          contextTrust: proof.contextTrust,
          sourceRecordType: null,
          sourceRecordId: null,
          sourceAsOfDate: candidate.asOfDate,
          sourceUpdatedAt: candidate.cutoff,
          sourceHash: proof.proofHash,
        },
      },
    ],
  ]);
}

export function d061NativeReplayProfileScope(
  providerAccountId: string,
): DecisionProfileScope {
  const normalized = providerAccountId.trim();
  if (!normalized) {
    throw new Error(
      "D061 native replay requires a physical provider account id",
    );
  }
  return { type: "account", id: normalized };
}

export function pinD061ReplayProfileToPhysicalAccount<
  T extends { scope: DecisionProfileScope },
>(profile: T, providerAccountId: string): T {
  return {
    ...profile,
    scope: d061NativeReplayProfileScope(providerAccountId),
  };
}

function computeReadyDecision(input: {
  candidate: FixedOpportunityCandidate;
  adInput: AdDecisionInput;
  profile: AccountDecisionProfile;
  previousLabels: Map<string, PreviousAdPublishedLabel>;
}): ReplayComputation {
  const campaignContextById = reviewOnlyCampaignContext(input.candidate);
  // resolveAccountDecisionProfile is the retained compatibility resolver and
  // therefore returns account/*. Production native generation replaces that
  // wildcard with the selected physical Meta account before both decision
  // computation and D036 hysteresis. Lane B must replay the same scope.
  const profile = pinD061ReplayProfileToPhysicalAccount(
    input.profile,
    input.candidate.providerAccountId,
  );
  const [computed] = computeNativeAdDecisions({
    businessId: input.candidate.business.id,
    profile,
    dataHealth: REPLAY_DATA_HEALTH,
    adInputs: [input.adInput],
    campaignContextMode: "automatic",
    campaignContextById,
    previousLabels: input.previousLabels,
  });
  if (!computed) throw new Error("Production native resolver returned no row");
  return {
    mapped: mapDecision(computed),
    computation: computed,
    stabilityScope: profile.scope,
    commercialMaturitySpend:
      profile.commercialStopLossThresholds?.commercialMaturitySpend ??
      profile.thresholds.commercialMaturitySpend,
  };
}

function computeSoftDecision(input: {
  candidate: FixedOpportunityCandidate;
  adInput: AdDecisionInput;
  blocker: string;
  evaluatedAt: string;
  previousLabels: Map<string, PreviousAdPublishedLabel>;
}): ReplayComputation {
  const blockedReason = `hard_actions_blocked:${input.blocker}`;
  const profile: NativeAdSoftOnlyDecisionProfile = {
    profileType: "native_ad_soft_only",
    businessId: input.candidate.business.id,
    asOfDate: input.candidate.asOfDate,
    channel: "meta",
    objectiveFamily: "sales",
    scope: d061NativeReplayProfileScope(
      input.candidate.providerAccountId,
    ),
    blocker: input.blocker,
    calibrationSource: null,
    selectedCell: null,
    hardActionEligibility: {
      scale: false,
      cut: false,
      refresh: false,
      reason: blockedReason,
      reasons: {
        scale: blockedReason,
        cut: blockedReason,
        refresh: blockedReason,
      },
    },
  };
  const campaignContextById = reviewOnlyCampaignContext(input.candidate);
  const [computed] = computeSoftOnlyNativeAdDecisions({
    businessId: input.candidate.business.id,
    blocker: input.blocker,
    profile,
    adInputs: [input.adInput],
    campaignContextMode: "automatic",
    campaignContextById,
    previousLabels: input.previousLabels,
    evaluatedAt: input.evaluatedAt,
  });
  if (!computed)
    throw new Error("Production native soft-only resolver returned no row");
  return {
    mapped: mapDecision(computed),
    computation: computed,
    stabilityScope: profile.scope,
    commercialMaturitySpend: null,
  };
}

export function d061ReplayStabilityKey(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  decisionEntityId: string;
  scope: DecisionProfileScope;
}) {
  return adDecisionStabilityKey({
    businessId: input.businessId,
    providerAccountRefId: input.providerAccountRefId,
    providerAccountId: input.providerAccountId,
    decisionEntityType: "ad",
    decisionEntityId: input.decisionEntityId,
    scopeType: input.scope.type,
    scopeId: input.scope.id,
  });
}

function replayStabilityKey(
  candidate: FixedOpportunityCandidate,
  scope: DecisionProfileScope = {
    type: "account",
    id: candidate.providerAccountId,
  },
) {
  return d061ReplayStabilityKey({
    businessId: candidate.business.id,
    providerAccountRefId: candidate.providerAccountRefId,
    providerAccountId: candidate.providerAccountId,
    decisionEntityId: candidate.adId,
    scope,
  });
}

function advancePreviousLabel(
  map: Map<string, PreviousAdPublishedLabel>,
  candidate: FixedOpportunityCandidate,
  computation: AdDecisionComputation,
  scope: DecisionProfileScope,
) {
  const key = replayStabilityKey(candidate, scope);
  const identity = {
    fixedKey: candidate.fixedKey,
    asOfDate: candidate.asOfDate,
    input: computation.input,
    decision: computation.decision,
    rawLabel: computation.rawLabel,
  };
  map.set(key, {
    businessId: candidate.business.id,
    providerAccountRefId: candidate.providerAccountRefId,
    providerAccountId: candidate.providerAccountId,
    decisionEntityType: "ad",
    decisionEntityId: candidate.adId,
    sourceSnapshotId: `replay-snapshot-${d061StableHash(identity)}`,
    sourceEvaluationId: `replay-evaluation-${d061StableHash({
      ...identity,
      kind: "evaluation",
    })}`,
    sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
    sourceAsOfDate: candidate.asOfDate,
    sourceComputedAt: candidate.cutoff,
    sourceInputHash: d061StableHash(computation.input),
    sourceDecisionHash: d061StableHash({
      decision: computation.decision,
      rawLabel: computation.rawLabel,
    }),
    publishedLabel: computation.decision.label,
    rawLabel: computation.rawLabel,
  });
}

function decisionEquivalent(
  left: D061ReplayDecision,
  right: D061ReplayDecision,
) {
  return (
    left.preAuthorityLabel === right.preAuthorityLabel &&
    left.rawLabel === right.rawLabel &&
    left.finalLabel === right.finalLabel &&
    left.blockedActionType === right.blockedActionType &&
    left.authorityBlocker === right.authorityBlocker &&
    left.confidence === right.confidence
  );
}

function selectExactCell(
  batch: NativeAdCalibrationBatch,
  candidate: FixedOpportunityCandidate,
) {
  const optimizationContext = buildNativeAdOptimizationContext(
    candidate.optimizationGoal,
    candidate.customEventType,
  );
  const matches = batch.cells.filter(
    (cell) =>
      cell.key.cellScope === "objective_cohort_context" &&
      cell.key.objective === candidate.objective &&
      cell.key.cohort === "purchase" &&
      cell.key.optimizationContext === optimizationContext &&
      cell.key.accountTimezone === candidate.accountTimezone &&
      cell.key.accountCurrency === candidate.accountCurrency,
  );
  if (matches.length > 1) {
    throw new Error(
      `Multiple exact production calibration cells matched ${candidate.fixedKey}`,
    );
  }
  return matches[0] ?? null;
}

export function bindD061ReplayProfileContextToCalibrationAdmission<
  T extends { accountTimezone: string; accountCurrency: string },
>(candidate: T, batch: Pick<NativeAdCalibrationBatch, "sourceProvenance">): T {
  const timezoneAdmission = batch.sourceProvenance.timezoneAdmission;
  const currencyAdmission = batch.sourceProvenance.currencyAdmission;
  const accountTimezone =
    timezoneAdmission.status === "ready" &&
    timezoneAdmission.accountTimezone !== null
      ? timezoneAdmission.accountTimezone
      : candidate.accountTimezone;
  const accountCurrency =
    currencyAdmission.status === "ready" &&
    currencyAdmission.accountCurrency !== null
      ? currencyAdmission.accountCurrency
      : candidate.accountCurrency;
  if (
    accountTimezone === candidate.accountTimezone &&
    accountCurrency === candidate.accountCurrency
  ) {
    return candidate;
  }
  // Lane B consumes the calibration batch's immutable source-admission
  // receipt. A historical Ad row may retain an older timezone, so requesting
  // its raw row dimensions would create a replay-only missing-cell diagnosis.
  return {
    ...candidate,
    accountTimezone,
    accountCurrency,
  };
}

function buildClosedOutcomes(input: {
  candidate: FixedOpportunityCandidate;
  factsByAd: ReadonlyMap<string, NativeAdCalibrationSourceRow[]>;
  completeness: ReadonlyMap<string, boolean>;
  outcomeCeiling: string;
}): Record<string, D061ClosedOutcome> {
  const adKey = [
    input.candidate.business.id,
    input.candidate.providerAccountRefId,
    input.candidate.providerAccountId,
    input.candidate.adId,
  ].join("::");
  const rows = input.factsByAd.get(adKey) ?? [];
  return Object.fromEntries(
    D061_CLOSED_OUTCOME_WINDOWS.map((windowDays) => {
      const dates = outcomeWindowDates(input.candidate.asOfDate, windowDays);
      const expectedDates = dateRange(dates.start, dates.end);
      const boundsValid =
        dates.start === addDays(input.candidate.asOfDate, 1) &&
        dates.end === addDays(input.candidate.asOfDate, windowDays) &&
        expectedDates.length === windowDays &&
        dates.end <= input.outcomeCeiling;
      const present = expectedDates.filter(
        (date) =>
          input.completeness.get(
            `${input.candidate.business.id}::${input.candidate.providerAccountId}::${date}`,
          ) === true,
      ).length;
      const metrics = aggregate(rowsBetween(rows, dates.start, dates.end));
      const forwardReceipts = selectForwardActionReceipts(
        input.candidate.actionReceipts,
        input.candidate.asOfDate,
        windowDays,
      );
      return [
        String(windowDays),
        {
          complete: boundsValid && present === expectedDates.length,
          windowStart: dates.start,
          windowEnd: dates.end,
          boundsValid,
          spend: metrics.spend,
          purchases: metrics.conversions,
          revenue: metrics.revenue,
          forwardActionContaminated: forwardReceipts.length > 0,
          actionCoverage: input.candidate.actionCoverageStatus,
          accountDaysExpected: expectedDates.length,
          accountDaysPresent: present,
        } satisfies D061ClosedOutcome,
      ];
    }),
  );
}

function evidenceProof(batch: NativeAdCalibrationBatch) {
  const evidence = batch.spendUnitAuthority.accountAovEvidence;
  return {
    status: evidence.status,
    basis: batch.spendUnitAuthority.basis,
    purchaseCount: evidence.observedPurchaseCount,
    meanAov: evidence.meanAov,
    totalRevenue: evidence.totalRevenue,
    contradictoryRowCount: evidence.contradictoryRowCount,
    evidenceHash: evidence.evidenceHash,
  } satisfies D061ClosedWindowReplayRow["accountAovProof"];
}

function errorProof(candidate: FixedOpportunityCandidate) {
  return {
    status: "unavailable",
    basis: null,
    purchaseCount: 0,
    meanAov: null,
    totalRevenue: 0,
    contradictoryRowCount: 0,
    evidenceHash: d061StableHash({
      candidate: candidate.fixedKey,
      status: "batch_execution_error",
    }),
  } satisfies D061ClosedWindowReplayRow["accountAovProof"];
}

async function evaluateCandidate(input: {
  candidate: FixedOpportunityCandidate;
  factsByAd: ReadonlyMap<string, NativeAdCalibrationSourceRow[]>;
  completeness: ReadonlyMap<string, boolean>;
  outcomeCeiling: string;
  baselinePreviousLabels: Map<string, PreviousAdPublishedLabel>;
  challengerPreviousLabels: Map<string, PreviousAdPublishedLabel>;
  batchCache: Map<string, NativeAdCalibrationBatch | Error>;
  profileCache: Map<string, AccountDecisionProfile>;
  sourceSliceCache: Map<string, CachedSourceSlice>;
}): Promise<D061ClosedWindowReplayRow> {
  const sourceSliceKey = [
    input.candidate.business.id,
    input.candidate.providerAccountRefId,
    input.candidate.providerAccountId,
    input.candidate.asOfDate,
  ].join("::");
  let sourceSlice = input.sourceSliceCache.get(sourceSliceKey);
  if (!sourceSlice) {
    const candidateRows = rowsBetween(
      input.candidate.sourceRows,
      addDays(input.candidate.asOfDate, -89),
      input.candidate.asOfDate,
    );
    const sourceAvailabilityProof = candidateRows.map((row) => ({
      sourceRowId: row.sourceRowId,
      date: row.date,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      finalizedAt: row.finalizedAt,
      campaignCreatedAt: row.campaignCreatedAt,
      campaignUpdatedAt: row.campaignUpdatedAt,
      adsetCreatedAt: row.adsetCreatedAt,
      adsetUpdatedAt: row.adsetUpdatedAt,
      factSignature: factDecisionSignature(row),
    }));
    const restatementDeduplication = deduplicateD061RestatedFacts(
      candidateRows,
      { cutoff: input.candidate.cutoff },
    );
    const restatementEligibleRows = restatementDeduplication.facts;
    const unsafeDuplicateSourceRowIds = new Set(
      restatementDeduplication.unsafeDuplicateSourceRowIds,
    );
    const conflictingDuplicateSourceRowIds = new Set(
      restatementDeduplication.conflictingDuplicateSourceRowIds,
    );
    const restatementProof = candidateRows.map((row) => ({
      sourceRowId: row.sourceRowId,
      admitted: restatementEligibleRows.some(
        (candidate) => candidate.sourceRowId === row.sourceRowId,
      ),
      duplicateContentSignature: factDecisionSignature(row),
      unsafeDuplicateAtCutoff: unsafeDuplicateSourceRowIds.has(
        row.sourceRowId,
      ),
      conflictingDuplicateContent:
        conflictingDuplicateSourceRowIds.has(row.sourceRowId),
      truthState: row.truthState,
      validationStatus: row.validationStatus,
      finalizedAt: row.finalizedAt,
      campaignSourceRowId: row.campaignSourceRowId,
      campaignTruthState: row.campaignTruthState,
      campaignValidationStatus: row.campaignValidationStatus,
      adsetSourceRowId: row.adsetSourceRowId,
      adsetTruthState: row.adsetTruthState,
      adsetValidationStatus: row.adsetValidationStatus,
      duplicateContentConflictGroups:
        restatementDeduplication.conflictingDuplicateGroups,
      unsafeDuplicateGroups:
        restatementDeduplication.unsafeDuplicateGroups,
      duplicateSelectorRows:
        restatementDeduplication.duplicateSelectorRows,
    }));
    sourceSlice = {
      rows: candidateRows,
      restatedRows: restatementEligibleRows.map((row) =>
        restateSourceAvailabilityAtCutoff(row, input.candidate.cutoff),
      ),
      excludedNonFinalizedOrHierarchyRowCount:
        candidateRows.filter(
          (row) =>
            !canonicalRestatedCalibrationFact(row) ||
            unsafeDuplicateSourceRowIds.has(row.sourceRowId) ||
            conflictingDuplicateSourceRowIds.has(row.sourceRowId),
        ).length,
      restatementProofHash: d061StableHash(restatementProof),
      sourceRowsUpdatedAfterCutoff: candidateRows.filter((row) =>
        sourceUpdatedAfterCutoff(row, input.candidate.cutoff),
      ).length,
      sourceAvailabilityManifestHash: d061StableHash(sourceAvailabilityProof),
      hierarchyManifestHash: d061StableHash(
        sourceAvailabilityProof.map((row) => ({
          sourceRowId: row.sourceRowId,
          campaignCreatedAt: row.campaignCreatedAt,
          campaignUpdatedAt: row.campaignUpdatedAt,
          adsetCreatedAt: row.adsetCreatedAt,
          adsetUpdatedAt: row.adsetUpdatedAt,
        })),
      ),
      hierarchyRowsAfterCutoff: candidateRows.filter((row) =>
        hierarchyUpdatedAfterCutoff(row, input.candidate.cutoff),
      ).length,
    };
    input.sourceSliceCache.set(sourceSliceKey, sourceSlice);
  }
  const candidateRows = sourceSlice.rows;
  const sourceRowsUpdatedAfterCutoff = sourceSlice.sourceRowsUpdatedAfterCutoff;
  const restatedRows = sourceSlice.restatedRows;
  let decisionCandidate = input.candidate;
  let adInput = buildAdInput(
    decisionCandidate,
    decisionCandidate.targetFreshness,
  );
  const exposure = summarizeActionExposure(
    input.candidate.actionReceipts,
    input.candidate.cutoff,
  );
  const outcomes = buildClosedOutcomes(input);
  let batch: NativeAdCalibrationBatch | null = null;
  let cell: NativeAdCalibrationCell | null = null;
  let baseline: D061ReplayDecision;
  let challenger: D061ReplayDecision;
  let baselineComputation: AdDecisionComputation;
  let challengerComputation: AdDecisionComputation;
  let baselineStabilityScope: DecisionProfileScope;
  let challengerStabilityScope: DecisionProfileScope;
  let challengerCommercialMaturitySpend: number | null;
  let oldTargetThirtyDayMetamorphicDrift = false;
  let executionError: string | null = null;
  try {
    const batchCacheKey = d061StableHash({
      businessId: input.candidate.business.id,
      providerAccountRefId: input.candidate.providerAccountRefId,
      providerAccountId: input.candidate.providerAccountId,
      asOfDate: input.candidate.asOfDate,
      cutoff: input.candidate.cutoff,
      targetSourceRowId: input.candidate.productionTarget.sourceRowId,
      targetEffectiveAt: input.candidate.productionTarget.effectiveAt,
      targetRecordedAt: input.candidate.productionTarget.recordedAt,
    });
    const cachedBatch = input.batchCache.get(batchCacheKey);
    if (cachedBatch instanceof Error) throw cachedBatch;
    if (cachedBatch) {
      batch = cachedBatch;
    } else {
      try {
        batch = computeNativeAdCalibrationBatch({
          businessId: input.candidate.business.id,
          providerAccountRefId: input.candidate.providerAccountRefId,
          providerAccountId: input.candidate.providerAccountId,
          asOf: input.candidate.asOfDate,
          computationCutoff: input.candidate.cutoff,
          sourceRows: restatedRows,
          targetAuthority: input.candidate.productionTarget,
        });
        input.batchCache.set(batchCacheKey, batch);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        input.batchCache.set(batchCacheKey, failure);
        throw failure;
      }
    }
    decisionCandidate =
      bindD061ReplayProfileContextToCalibrationAdmission(
        input.candidate,
        batch,
      );
    adInput = buildAdInput(
      decisionCandidate,
      decisionCandidate.targetFreshness,
    );
    cell = selectExactCell(batch, decisionCandidate);
    if (!cell) {
      const baselineResult = computeSoftDecision({
        candidate: decisionCandidate,
        adInput,
        blocker: "native_calibration_missing",
        evaluatedAt: decisionCandidate.cutoff,
        previousLabels: input.baselinePreviousLabels,
      });
      const challengerResult = computeSoftDecision({
        candidate: decisionCandidate,
        adInput,
        blocker: "native_calibration_missing",
        evaluatedAt: decisionCandidate.cutoff,
        previousLabels: input.challengerPreviousLabels,
      });
      baseline = baselineResult.mapped;
      challenger = challengerResult.mapped;
      baselineComputation = baselineResult.computation;
      challengerComputation = challengerResult.computation;
      baselineStabilityScope = baselineResult.stabilityScope;
      challengerStabilityScope = challengerResult.stabilityScope;
      challengerCommercialMaturitySpend =
        challengerResult.commercialMaturitySpend;
    } else {
      const authority = batch.spendUnitAuthority;
      const physicalAccountAov =
        authority.basis === "physical_account_purchase_aov_90d" &&
        authority.accountAovEvidence.status === "ready" &&
        authority.accountAovEvidence.meanAov !== null
          ? {
              meanAov: authority.accountAovEvidence.meanAov,
              purchaseCount: authority.accountAovEvidence.observedPurchaseCount,
              totalRevenue: authority.accountAovEvidence.totalRevenue,
            }
          : null;
      const currentTargetPack = targetPack(
        input.candidate.productionTarget,
        input.candidate.targetFreshness,
      );
      const dataSource = replayDataSource({
        cell,
        target: currentTargetPack,
      });
      const flags = fixedFlags(input.candidate.business.id);
      const profileKeyBase = {
        batchInputManifestHash: batch.inputManifestHash,
        cellInputManifestHash: cell.inputManifestHash,
        targetFreshness: input.candidate.targetFreshness,
      };
      const baselineProfileKey = d061StableHash({
        ...profileKeyBase,
        variant: "baseline",
      });
      const challengerProfileKey = d061StableHash({
        ...profileKeyBase,
        variant: "challenger",
        physicalAccountAov,
      });
      let baselineProfile = input.profileCache.get(baselineProfileKey);
      if (!baselineProfile) {
        baselineProfile = await resolveAccountDecisionProfile({
          businessId: input.candidate.business.id,
          asOf: input.candidate.asOfDate,
          dataSource,
          flags,
          commercialStopLossAovAuthority: null,
        });
        input.profileCache.set(baselineProfileKey, baselineProfile);
      }
      let challengerProfile = input.profileCache.get(challengerProfileKey);
      if (!challengerProfile) {
        challengerProfile = await resolveAccountDecisionProfile({
          businessId: input.candidate.business.id,
          asOf: input.candidate.asOfDate,
          dataSource,
          flags,
          commercialStopLossAovAuthority: physicalAccountAov,
        });
        input.profileCache.set(challengerProfileKey, challengerProfile);
      }
      const baselineResult = computeReadyDecision({
        candidate: decisionCandidate,
        adInput,
        profile: baselineProfile,
        previousLabels: input.baselinePreviousLabels,
      });
      const challengerResult = computeReadyDecision({
        candidate: decisionCandidate,
        adInput,
        profile: challengerProfile,
        previousLabels: input.challengerPreviousLabels,
      });
      baseline = baselineResult.mapped;
      challenger = challengerResult.mapped;
      baselineComputation = baselineResult.computation;
      challengerComputation = challengerResult.computation;
      baselineStabilityScope = baselineResult.stabilityScope;
      challengerStabilityScope = challengerResult.stabilityScope;
      challengerCommercialMaturitySpend =
        challengerResult.commercialMaturitySpend;

      if (input.candidate.targetAgeDays > 30) {
        const freshDataSource = replayDataSource({
          cell,
          target: targetPack(input.candidate.productionTarget, "fresh"),
        });
        const freshAdInput = buildAdInput(decisionCandidate, "fresh");
        const freshBaselineKey = d061StableHash({
          ...profileKeyBase,
          targetFreshness: "fresh",
          variant: "baseline",
        });
        const freshChallengerKey = d061StableHash({
          ...profileKeyBase,
          targetFreshness: "fresh",
          variant: "challenger",
          physicalAccountAov,
        });
        let freshBaselineProfile = input.profileCache.get(freshBaselineKey);
        if (!freshBaselineProfile) {
          freshBaselineProfile = await resolveAccountDecisionProfile({
            businessId: input.candidate.business.id,
            asOf: input.candidate.asOfDate,
            dataSource: freshDataSource,
            flags,
            commercialStopLossAovAuthority: null,
          });
          input.profileCache.set(freshBaselineKey, freshBaselineProfile);
        }
        let freshChallengerProfile = input.profileCache.get(freshChallengerKey);
        if (!freshChallengerProfile) {
          freshChallengerProfile = await resolveAccountDecisionProfile({
            businessId: input.candidate.business.id,
            asOf: input.candidate.asOfDate,
            dataSource: freshDataSource,
            flags,
            commercialStopLossAovAuthority: physicalAccountAov,
          });
          input.profileCache.set(freshChallengerKey, freshChallengerProfile);
        }
        const freshBaseline = computeReadyDecision({
          candidate: decisionCandidate,
          adInput: freshAdInput,
          profile: freshBaselineProfile,
          previousLabels: input.baselinePreviousLabels,
        }).mapped;
        const freshChallenger = computeReadyDecision({
          candidate: decisionCandidate,
          adInput: freshAdInput,
          profile: freshChallengerProfile,
          previousLabels: input.challengerPreviousLabels,
        }).mapped;
        oldTargetThirtyDayMetamorphicDrift =
          !decisionEquivalent(baseline, freshBaseline) ||
          !decisionEquivalent(challenger, freshChallenger);
      }
    }
  } catch (error) {
    executionError = error instanceof Error ? error.message : String(error);
    const baselineResult = computeSoftDecision({
      candidate: decisionCandidate,
      adInput,
      blocker: "replay_execution_error",
      evaluatedAt: decisionCandidate.cutoff,
      previousLabels: input.baselinePreviousLabels,
    });
    const challengerResult = computeSoftDecision({
      candidate: decisionCandidate,
      adInput,
      blocker: "replay_execution_error",
      evaluatedAt: decisionCandidate.cutoff,
      previousLabels: input.challengerPreviousLabels,
    });
    baseline = baselineResult.mapped;
    challenger = challengerResult.mapped;
    baselineComputation = baselineResult.computation;
    challengerComputation = challengerResult.computation;
    baselineStabilityScope = baselineResult.stabilityScope;
    challengerStabilityScope = challengerResult.stabilityScope;
    challengerCommercialMaturitySpend =
      challengerResult.commercialMaturitySpend;
  }
  advancePreviousLabel(
    input.baselinePreviousLabels,
    decisionCandidate,
    baselineComputation!,
    baselineStabilityScope!,
  );
  advancePreviousLabel(
    input.challengerPreviousLabels,
    decisionCandidate,
    challengerComputation!,
    challengerStabilityScope!,
  );
  const proof = batch ? evidenceProof(batch) : errorProof(input.candidate);
  const requestedOptimizationContext = buildNativeAdOptimizationContext(
    input.candidate.optimizationGoal,
    input.candidate.customEventType,
  );
  if (!requestedOptimizationContext) {
    throw new Error("Replay candidate lost its required optimization context");
  }
  const calibrationProof = {
    batchExpectedCellCount: batch?.expectedCellCount ?? null,
    batchQualityCounts: batch?.qualityCounts ?? null,
    accountDimensionBinding: {
      rawRequested: {
        accountTimezone: input.candidate.accountTimezone,
        accountCurrency: input.candidate.accountCurrency,
      },
      admissionBound: {
        accountTimezone: decisionCandidate.accountTimezone,
        accountCurrency: decisionCandidate.accountCurrency,
      },
      timezoneAdmission: batch
        ? {
            status: batch.sourceProvenance.timezoneAdmission.status,
            accountTimezone:
              batch.sourceProvenance.timezoneAdmission.accountTimezone,
            manifestHash:
              batch.sourceProvenance.timezoneAdmission.manifestHash,
          }
        : null,
      currencyAdmission: batch
        ? {
            status: batch.sourceProvenance.currencyAdmission.status,
            accountCurrency:
              batch.sourceProvenance.currencyAdmission.accountCurrency,
            manifestHash:
              batch.sourceProvenance.currencyAdmission.manifestHash,
          }
        : null,
    },
    requestedCellKey: {
      accountTimezone: decisionCandidate.accountTimezone,
      accountCurrency: decisionCandidate.accountCurrency,
      objective: decisionCandidate.objective,
      cohort: "purchase" as const,
      optimizationContext: requestedOptimizationContext,
    },
    batchCellKeys:
      batch?.cells.map((candidateCell) => ({
        accountTimezone: candidateCell.key.accountTimezone,
        accountCurrency: candidateCell.key.accountCurrency,
        cellScope: candidateCell.key.cellScope,
        objective: candidateCell.key.objective,
        cohort: candidateCell.key.cohort,
        optimizationContext: candidateCell.key.optimizationContext,
      })) ?? [],
    exactCellMatched: cell !== null,
    exactCellQualityStatus: cell?.qualityStatus ?? null,
    exactCellCutReady: cell?.actionReadiness.cut.ready ?? null,
    exactCellCutReason: cell?.actionReadiness.cut.reason ?? null,
  } satisfies D061ClosedWindowReplayRow["calibrationProof"];
  const actionReceiptManifest = input.candidate.actionReceipts.map(
    (receipt) => ({
      id: receipt.id,
      scopeType: receipt.scopeType,
      scopeId: receipt.scopeId,
      action: receipt.action,
      status: receipt.status,
      requestedAt: receipt.requestedAt,
      verifiedAt: receipt.verifiedAt,
      dryRun: receipt.dryRun,
    }),
  );
  const receiptManifestHash = d061StableHash(actionReceiptManifest);
  const hierarchyContextProof = {
    status:
      sourceSlice.hierarchyRowsAfterCutoff === 0
        ? ("cutoff_safe" as const)
        : ("restated_daily_hierarchy" as const),
    rowsAfterCutoff: sourceSlice.hierarchyRowsAfterCutoff,
    proofHash: sourceSlice.hierarchyManifestHash,
  };
  const adIdHash = d061StableHash({
    businessId: input.candidate.business.id,
    providerAccountId: input.candidate.providerAccountId,
    adId: input.candidate.adId,
  });
  const cohortKey = [
    input.candidate.business.id,
    input.candidate.providerAccountId,
    adIdHash,
    input.candidate.asOfDate,
  ].join("::");
  const rowContent = {
    cohortKey,
    businessId: input.candidate.business.id,
    providerAccountId: input.candidate.providerAccountId,
    adIdHash,
    asOfDate: input.candidate.asOfDate,
    sourceMode: "restated_ad_daily" as const,
    target: {
      sourceRowId: input.candidate.target.sourceRowId,
      operation: input.candidate.target.operation,
      effectiveAt: input.candidate.target.effectiveAt,
      actualRecordedAt: input.candidate.target.recordedAt,
      productionRecordedAt: input.candidate.productionTarget.recordedAt,
      recordedAfterCutoff: input.candidate.targetRecordedAfterCutoff,
      targetRoas: input.candidate.target.targetRoas,
      breakEvenRoas: input.candidate.target.breakEvenRoas,
    },
    batchInputManifestHash: batch?.inputManifestHash ?? null,
    cellInputManifestHash: cell?.inputManifestHash ?? null,
    actionExposure: exposure,
    actionCoverageStatus: input.candidate.actionCoverageStatus,
    actionReceiptManifest,
    receiptManifestHash,
    hierarchyContextProof,
    decisionStatusProof: input.candidate.decisionStatusProof,
    decisionCampaignContextProof: input.candidate.decisionCampaignContextProof,
    preDecision: {
      currentDay: input.candidate.currentDay,
      window7: input.candidate.window7,
      window28: input.candidate.window28,
      allHistory: input.candidate.allHistory,
    },
    accountAovProof: proof,
    calibrationProof,
    opportunityMaturitySpend: challengerCommercialMaturitySpend!,
    sourceProof: {
      rowCount: candidateRows.length,
      manifestHash: sourceSlice.sourceAvailabilityManifestHash,
      restatementAdmittedRowCount: restatedRows.length,
      excludedNonFinalizedOrHierarchyRowCount:
        sourceSlice.excludedNonFinalizedOrHierarchyRowCount,
      restatementProofHash: sourceSlice.restatementProofHash,
    },
    baseline,
    challenger,
    outcomes,
  };
  return {
    cohortKey,
    rowHash: d061StableHash(rowContent),
    businessId: input.candidate.business.id,
    businessName: input.candidate.business.name,
    providerAccountId: input.candidate.providerAccountId,
    adIdHash,
    asOfDate: input.candidate.asOfDate,
    sourceMode: "restated_ad_daily",
    sourceModeRestated: true,
    currentScd0FieldsUsed: [],
    sourceRowsUpdatedAfterCutoff,
    sourceRestatementProof: {
      candidateRowCount: candidateRows.length,
      admittedFinalizedRowCount: restatedRows.length,
      excludedNonFinalizedOrHierarchyRowCount:
        sourceSlice.excludedNonFinalizedOrHierarchyRowCount,
      proofHash: sourceSlice.restatementProofHash,
    },
    cutoffFallbackUsed: false,
    actionExposureAtCutoff: exposure.stratum,
    actionCoverageAtCutoff: {
      status: input.candidate.actionCoverageStatus,
      receiptManifestHash,
      receiptIds: actionReceiptManifest.map((receipt) => receipt.id),
    },
    hierarchyContextAtCutoff: hierarchyContextProof,
    decisionStatusProof: input.candidate.decisionStatusProof,
    decisionCampaignContextProof: input.candidate.decisionCampaignContextProof,
    target: {
      source: "business_target_pack_history",
      exactAtCutoff: false,
      semanticRestatedAtCutoff: true,
      effectiveAt: input.candidate.target.effectiveAt,
      recordedAt: input.candidate.target.recordedAt,
      productionRecordedAt: input.candidate.productionTarget.recordedAt,
      recordedAfterCutoff: input.candidate.targetRecordedAfterCutoff,
      targetRoas: input.candidate.target.targetRoas,
      breakEvenRoas: input.candidate.target.breakEvenRoas,
      ageDays: input.candidate.targetAgeDays,
    },
    preDecision: {
      spend: input.candidate.window28.spend,
      purchases: input.candidate.window28.conversions,
      revenue: input.candidate.window28.revenue,
      roas: input.candidate.window28.roas,
    },
    accountAovProof: proof,
    calibrationProof,
    opportunityMaturitySpend: challengerCommercialMaturitySpend!,
    baseline,
    challenger,
    oldTargetThirtyDayMetamorphicDrift,
    outcomes,
    executionError,
  };
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function repositoryRelativeOutputPaths(
  repoRoot: string,
  paths: readonly string[],
) {
  return paths
    .map((path) => relative(repoRoot, resolve(path)))
    .filter(
      (path) =>
        path.length > 0 &&
        path !== ".." &&
        !path.startsWith(`..${sep}`) &&
        !isAbsolute(path),
    )
    .map((path) => path.split(sep).join("/"))
    .sort((left, right) => left.localeCompare(right));
}

export function readReplayCodeProvenance(
  args: Pick<D061ClosedWindowReplayArgs, "jsonOut" | "mdOut" | "writeFiles">,
) {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const gitBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const excludedRepositoryPaths = repositoryRelativeOutputPaths(
    repoRoot,
    args.writeFiles
      ? [
          args.jsonOut,
          args.mdOut,
          `${args.jsonOut}.tmp`,
          `${args.mdOut}.tmp`,
        ]
      : [],
  );
  const repositoryContentManifest = buildRepositoryContentManifest(
    repoRoot,
    excludedRepositoryPaths,
  );
  const sourceFiles = [
    "scripts/creative-decision-center/native-ad-account-aov-closed-window-replay.ts",
    "scripts/creative-decision-center/d061-account-aov-closed-window-gate.ts",
    "scripts/creative-decision-center/native-ad-account-aov-authority-replay.ts",
    "lib/creative-decision-engine/jobs/ad-decisions-job.ts",
    "lib/creative-decision-engine/jobs/ad-calibration-job.ts",
    "lib/creative-decision-engine/decision-stability.ts",
    "lib/creative-decision-engine/ad-account-decision-profile.ts",
    "lib/creative-decision-engine/account-decision-profile.ts",
    "lib/creative-decision-engine/engine.ts",
    "lib/creative-decision-engine/gates/cut-policy.ts",
    "lib/creative-decision-engine/gates/diagnose.ts",
    "lib/creative-decision-engine/gates/maturity.ts",
    "lib/creative-decision-engine/gates/ratio-zones.ts",
    "lib/creative-decision-engine/gates/types.ts",
    "lib/creative-decision-engine/gates/zero-conv-burner.ts",
    "lib/creative-decision-engine/kind-aware-profile.ts",
    "lib/creative-decision-engine/types.ts",
  ];
  return {
    gitHead,
    gitBranch,
    captureMode: "pre_output_repository_content_manifest" as const,
    repositoryContentManifest,
    sourceFiles: Object.fromEntries(
      sourceFiles.map((relativePath) => [
        relativePath,
        sha256File(resolve(repoRoot, relativePath)),
      ]),
    ),
  };
}

export function assertClosedWindowReplayProvenanceStable(
  before: ReturnType<typeof readReplayCodeProvenance>,
  args: Pick<D061ClosedWindowReplayArgs, "jsonOut" | "mdOut" | "writeFiles">,
) {
  const after = readReplayCodeProvenance(args);
  const beforeHash = d061StableHash(before);
  const afterHash = d061StableHash(after);
  if (beforeHash !== afterHash) {
    throw new Error(
      `Closed-window replay source provenance changed while the artifact was generated: before=${beforeHash}, after=${afterHash}`,
    );
  }
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function verifyAuthorityArtifactChecksumSidecar(input: {
  repoRoot: string;
  artifactRepositoryPath: string;
}) {
  const artifactRepositoryPath = input.artifactRepositoryPath
    .split(sep)
    .join("/");
  const sidecarRepositoryPath = artifactRepositoryPath
    .toLowerCase()
    .endsWith(".json")
    ? `${artifactRepositoryPath.slice(0, -5)}.sha256`
    : `${artifactRepositoryPath}.sha256`;
  const artifactPath = resolve(input.repoRoot, artifactRepositoryPath);
  const sidecarPath = resolve(input.repoRoot, sidecarRepositoryPath);
  const actualSha256 = sha256File(artifactPath);
  const failures: string[] = [];
  let expectedSha256: string | null = null;
  let recordedArtifactPath: string | null = null;

  if (actualSha256 === null) failures.push("authority_artifact_missing");
  if (!existsSync(sidecarPath)) {
    failures.push("authority_checksum_sidecar_missing");
  } else {
    const lines = readFileSync(sidecarPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const match =
      lines.length === 1
        ? /^([0-9a-fA-F]{64})[ \t]+\*?(.+?)\s*$/.exec(lines[0]!)
        : null;
    if (!match) {
      failures.push("authority_checksum_sidecar_parse_failed");
    } else {
      expectedSha256 = match[1]!.toLowerCase();
      recordedArtifactPath = match[2]!.split("\\").join("/");
      if (recordedArtifactPath !== artifactRepositoryPath) {
        failures.push("authority_checksum_sidecar_path_mismatch");
      }
      if (
        actualSha256 !== null &&
        expectedSha256.toLowerCase() !== actualSha256.toLowerCase()
      ) {
        failures.push("authority_checksum_sidecar_mismatch");
      }
    }
  }

  return {
    valid: failures.length === 0,
    artifactRepositoryPath,
    sidecarRepositoryPath,
    actualSha256,
    expectedSha256,
    recordedArtifactPath,
    failures,
  };
}

type CompactAuthorityArtifactMode = "focused" | "scheduler_population";

const CURRENT_DAY_AUTHORITY_REPLAY_CONTRACT_VERSION =
  "adsecute.meta.native-ad-account-aov-current-day-production-parity.v7";

const AUTHORITY_SCHEDULER_CONTRACT = {
  activeBusinessLimit: 500,
  excludesDemoBusinesses: true,
  businessOrder: "created_at_asc",
  enabledSource: "business_override_then_current_env_default",
  metaEligibilitySource: "business_provider_accounts",
} as const;

const REQUIRED_ZERO_RELEASE_GATE_CHECKS = [
  "executionFailures",
  "schedulerPopulationContradictions",
  "authorityProofOrLineageContradictions",
  "canonicalEnvelopeContradictions",
  "currentDayRestatementContradictions",
  "unresolvedSourceDimensionContradictions",
  "profileCalibrationParityContradictions",
  "requestedScopeCoverageContradictions",
  "aboveBreakEvenCutProjectionViolations",
  "aboveBreakEvenProjectionDriftRows",
  "scaleRefreshIdentityDriftRows",
  "calibrationCutoffFallbackSlices",
  "waveOrHydrationCoverageContradictions",
  "aovPositiveControlFailures",
  "d036PerRowTransitionViolations",
  "d063LegacySafeZoneProjectionDriftRows",
  "d063ExpandedStripSemanticViolationRows",
  "d063ExpandedHeldAuthorizedCutRows",
  "d063ExpandedHeldPendingRows",
  "d063AccountAovP25NullReachabilityFailures",
  "d063AccountAovP25BackedOverlayRows",
  "d063ExactMediaBuyerContradictions",
] as const;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isSha256(value: unknown): boolean {
  const parsed = text(value);
  return parsed !== null && /^[0-9a-f]{64}$/.test(parsed);
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function validateCompactAuthorityArtifact(input: {
  artifact: Record<string, unknown>;
  expectedAsOfDate: string;
  mode: CompactAuthorityArtifactMode;
}) {
  const failures: string[] = [];
  const parsed = input.artifact;
  const contractVersion = text(parsed.contractVersion);
  if (contractVersion !== CURRENT_DAY_AUTHORITY_REPLAY_CONTRACT_VERSION) {
    failures.push("authority_contract_mismatch");
  }

  const artifactProjection = objectOrNull(parsed.artifactProjection);
  const projectionContractVersion = text(artifactProjection?.contractVersion);
  if (projectionContractVersion !== COMPACT_REPLAY_PROOF_CONTRACT_VERSION) {
    failures.push("authority_projection_contract_mismatch");
  }

  const coverage = objectOrNull(parsed.coverage);
  const mediaBuyerRowAudit = objectOrNull(parsed.mediaBuyerRowAudit);
  const mediaBuyerRowCount = mediaBuyerRowAudit?.rowCount;
  const compactProjectionValid =
    artifactProjection?.projectionMode ===
      "full_release_proof_with_media_buyer_rows_omitted_and_hash_bound" &&
    isSha256(artifactProjection?.fullArtifactSha256) &&
    isNonNegativeSafeInteger(artifactProjection?.fullArtifactBytes) &&
    artifactProjection.fullArtifactBytes > 0 &&
    isNonNegativeSafeInteger(
      artifactProjection?.omittedMediaBuyerRowCount,
    ) &&
    artifactProjection.omittedMediaBuyerRowCount === mediaBuyerRowCount &&
    isSha256(artifactProjection?.omittedMediaBuyerRowsCanonicalSha256) &&
    isSha256(artifactProjection?.cohortKeyHashSetSha256) &&
    isSha256(artifactProjection?.identityHashSetSha256) &&
    artifactProjection?.fullRowsRequiredForDrilldown === true &&
    mediaBuyerRowAudit?.rowsOmitted === true &&
    isNonNegativeSafeInteger(mediaBuyerRowCount) &&
    mediaBuyerRowCount > 0;
  if (!compactProjectionValid) {
    failures.push("authority_projection_contract_invalid");
  }
  const proofCommitment = objectOrNull(
    artifactProjection?.calibrationContextProofSetCommitment,
  );
  const proofContextCount = proofCommitment?.contextCount;
  const proofAssociationCount = proofCommitment?.associationCount;
  const proofSetHash = text(proofCommitment?.proofSetHash);
  const calibrationContextProofCommitmentValid =
    proofCommitment?.contractVersion ===
      REPLAY_CALIBRATION_CONTEXT_PROOF_SET_CONTRACT_VERSION &&
    proofCommitment?.proofContractVersion ===
      REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION &&
    proofCommitment?.fullMaterialOmitted === true &&
    isNonNegativeSafeInteger(proofContextCount) &&
    proofContextCount > 0 &&
    isNonNegativeSafeInteger(proofAssociationCount) &&
    proofAssociationCount > 0 &&
    proofContextCount <= proofAssociationCount &&
    proofSetHash !== null &&
    /^[0-9a-f]{64}$/.test(proofSetHash) &&
    proofAssociationCount === coverage?.challengerComputedRows &&
    proofAssociationCount === mediaBuyerRowCount;
  if (!calibrationContextProofCommitmentValid) {
    failures.push("authority_calibration_context_proof_commitment_invalid");
  }

  const releaseGate = objectOrNull(parsed.releaseGate);
  const releaseGateChecks = objectOrNull(releaseGate?.checks);
  const releaseGatePassed =
    releaseGate?.passed === true && releaseGate?.exitCode === 0;
  if (!releaseGatePassed) failures.push("authority_release_gate_failed");
  const releaseGateContractValid =
    emptyArray(releaseGate?.failures) &&
    releaseGateChecks !== null &&
    REQUIRED_ZERO_RELEASE_GATE_CHECKS.every(
      (check) => releaseGateChecks[check] === 0,
    ) &&
    Object.values(releaseGateChecks).every(
      (value) => isNonNegativeSafeInteger(value) && value === 0,
    );
  if (!releaseGateContractValid) {
    failures.push("authority_release_gate_contract_invalid");
  }
  const authorityLineageContradictions =
    Number(releaseGateChecks?.authorityProofOrLineageContradictions);
  if (authorityLineageContradictions !== 0) {
    failures.push("authority_proof_or_lineage_contradictions");
  }

  const parameters = objectOrNull(parsed.parameters);
  if (text(parameters?.asOfDate) !== input.expectedAsOfDate) {
    failures.push("authority_as_of_mismatch");
  }
  if (
    text(parameters?.baselineEngineVersion) !==
      NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION ||
    text(parameters?.challengerEngineVersion) !== NATIVE_AD_ENGINE_VERSION
  ) {
    failures.push("authority_engine_epoch_mismatch");
  }
  const generatedAt = timestamp(parsed.generatedAt);
  if (generatedAt?.slice(0, 10) !== input.expectedAsOfDate) {
    failures.push("authority_generation_date_mismatch");
  }
  if (
    generatedAt === null ||
    generatedAt < `${input.expectedAsOfDate}T03:00:00.000Z`
  ) {
    failures.push("authority_generation_precedes_scheduler_wave");
  }
  const safety = objectOrNull(parsed.safety);
  const transaction = objectOrNull(safety?.transaction);
  if (
    safety?.databaseAccess !== "existing_local_ssh_tunnel_only" ||
    safety?.providerWrites !== false ||
    safety?.databaseWrites !== false ||
    safety?.manualCron !== false ||
    transaction?.transactionReadOnly !== "on" ||
    transaction?.defaultTransactionReadOnly !== "on" ||
    text(transaction?.transactionIsolation)?.toLowerCase() !==
      "repeatable read" ||
    transaction?.statementTimeout !== "30000ms" ||
    text(transaction?.applicationName) === null
  ) {
    failures.push("authority_safety_contract_invalid");
  }
  if (
    !emptyArray(parsed.failures) ||
    !emptyArray(parsed.slicePreparationFailures)
  ) {
    failures.push("authority_artifact_failures_present");
  }

  let schedulerPopulationValid: boolean | null = null;
  let waveCoverageValid: boolean | null = null;
  if (input.mode === "scheduler_population") {
    const schedulerPopulation = objectOrNull(
      parsed.schedulerPopulationCoverage,
    );
    const schedulerContract = objectOrNull(
      schedulerPopulation?.schedulerContract,
    );
    const envDefaultEnabled = schedulerPopulation?.envDefaultEnabled;
    const expectedBusinessCount =
      schedulerPopulation?.expectedBusinessCount;
    const expectedProviderAccountCount =
      schedulerPopulation?.expectedProviderAccountCount;
    const rawExpectedBusinesses = schedulerPopulation?.expectedBusinesses;
    const parsedExpectedBusinesses = Array.isArray(rawExpectedBusinesses)
      ? rawExpectedBusinesses.map((value) => {
          const item = objectOrNull(value);
          const businessId = text(item?.businessId);
          const businessName = text(item?.businessName);
          const schedulerPosition = item?.schedulerPosition;
          return businessId &&
            businessName &&
            isNonNegativeSafeInteger(schedulerPosition) &&
            schedulerPosition > 0
            ? { businessId, businessName, schedulerPosition }
            : null;
        })
      : [];
    const expectedBusinesses = parsedExpectedBusinesses.filter(
      (
        item,
      ): item is {
        businessId: string;
        businessName: string;
        schedulerPosition: number;
      } => item !== null,
    );
    const rawExpectedProviderAccounts =
      schedulerPopulation?.expectedProviderAccounts;
    const parsedExpectedProviderAccounts = Array.isArray(
      rawExpectedProviderAccounts,
    )
      ? rawExpectedProviderAccounts.map((value) => {
          const item = objectOrNull(value);
          const businessId = text(item?.businessId);
          const providerAccountRefId = text(item?.providerAccountRefId);
          const providerAccountId = text(item?.providerAccountId);
          return businessId && providerAccountRefId && providerAccountId
            ? { businessId, providerAccountRefId, providerAccountId }
            : null;
        })
      : [];
    const expectedProviderAccounts = parsedExpectedProviderAccounts.filter(
      (
        item,
      ): item is {
        businessId: string;
        providerAccountRefId: string;
        providerAccountId: string;
      } => item !== null,
    );
    const expectedBusinessIds = new Set(
      expectedBusinesses.map((item) => item.businessId),
    );
    const expectedBusinessNames = new Map(
      expectedBusinesses.map((item) => [item.businessId, item.businessName]),
    );
    const providerAccountKey = (item: {
      businessId: string;
      providerAccountRefId: string;
      providerAccountId: string;
    }) =>
      `${item.businessId}::${item.providerAccountRefId}::${item.providerAccountId}`;
    const expectedProviderAccountKeys = new Set(
      expectedProviderAccounts.map(providerAccountKey),
    );
    const schedulerManifestHash = text(schedulerPopulation?.manifestHash);
    const populationProjectionManifestHash = text(
      artifactProjection?.schedulerPopulationManifestHash,
    );
    const recomputedSchedulerManifestHash =
      typeof envDefaultEnabled === "boolean"
        ? canonicalSha256({
            envDefaultEnabled,
            businesses: expectedBusinesses,
            providerAccounts: expectedProviderAccounts,
          })
        : null;
    const exactSchedulerContract =
      schedulerContract?.activeBusinessLimit ===
        AUTHORITY_SCHEDULER_CONTRACT.activeBusinessLimit &&
      schedulerContract?.excludesDemoBusinesses ===
        AUTHORITY_SCHEDULER_CONTRACT.excludesDemoBusinesses &&
      schedulerContract?.businessOrder ===
        AUTHORITY_SCHEDULER_CONTRACT.businessOrder &&
      schedulerContract?.enabledSource ===
        AUTHORITY_SCHEDULER_CONTRACT.enabledSource &&
      schedulerContract?.metaEligibilitySource ===
        AUTHORITY_SCHEDULER_CONTRACT.metaEligibilitySource &&
      Object.keys(schedulerContract).length ===
        Object.keys(AUTHORITY_SCHEDULER_CONTRACT).length;
    const providerAccountsCanonicallyOrdered =
      expectedProviderAccounts.every(
        (item, index) =>
          index === 0 ||
          providerAccountKey(
            expectedProviderAccounts[index - 1]!,
          ).localeCompare(providerAccountKey(item)) < 0,
      );
    schedulerPopulationValid =
      schedulerPopulation?.required === true &&
      schedulerPopulation?.mode === "unfiltered_scheduler_population" &&
      schedulerPopulation?.readWithinReplayRepeatableReadTransaction ===
        true &&
      exactSchedulerContract &&
      typeof envDefaultEnabled === "boolean" &&
      emptyArray(parameters?.businessFilter) &&
      emptyArray(parameters?.providerAccountFilter) &&
      isNonNegativeSafeInteger(expectedBusinessCount) &&
      expectedBusinessCount > 0 &&
      isNonNegativeSafeInteger(expectedProviderAccountCount) &&
      expectedProviderAccountCount > 0 &&
      Array.isArray(rawExpectedBusinesses) &&
      parsedExpectedBusinesses.length === rawExpectedBusinesses.length &&
      expectedBusinesses.length === expectedBusinessCount &&
      expectedBusinessIds.size === expectedBusinessCount &&
      expectedBusinesses.every(
        (item, index) => item.schedulerPosition === index + 1,
      ) &&
      Array.isArray(rawExpectedProviderAccounts) &&
      parsedExpectedProviderAccounts.length ===
        rawExpectedProviderAccounts.length &&
      expectedProviderAccounts.length === expectedProviderAccountCount &&
      expectedProviderAccountKeys.size === expectedProviderAccountCount &&
      providerAccountsCanonicallyOrdered &&
      expectedProviderAccounts.every((item) =>
        expectedBusinessIds.has(item.businessId),
      ) &&
      isNonNegativeSafeInteger(schedulerPopulation?.observedAnchorCount) &&
      schedulerPopulation.observedAnchorCount ===
        expectedBusinessCount &&
      isNonNegativeSafeInteger(
        schedulerPopulation?.observedIdentityAccountCount,
      ) &&
      schedulerPopulation.observedIdentityAccountCount ===
        expectedProviderAccountCount &&
      isSha256(schedulerManifestHash) &&
      schedulerManifestHash === recomputedSchedulerManifestHash &&
      populationProjectionManifestHash === schedulerManifestHash &&
      artifactProjection?.schedulerPopulationExpectedBusinessCount ===
        expectedBusinessCount &&
      artifactProjection?.schedulerPopulationExpectedProviderAccountCount ===
        expectedProviderAccountCount &&
      artifactProjection?.schedulerPopulationContradictions === 0 &&
      schedulerPopulation?.contradictions === 0 &&
      emptyArray(schedulerPopulation?.missingBusinessAnchors) &&
      emptyArray(schedulerPopulation?.unexpectedBusinessAnchors) &&
      emptyArray(schedulerPopulation?.duplicateBusinessAnchors) &&
      emptyArray(schedulerPopulation?.missingProviderAccountIdentities) &&
      emptyArray(schedulerPopulation?.unexpectedProviderAccountIdentities) &&
      emptyArray(schedulerPopulation?.anchorBusinessesWithoutIdentities) &&
      coverage?.businesses === expectedBusinessCount &&
      coverage?.accounts === expectedProviderAccountCount &&
      coverage?.accountCutoffSlices === expectedProviderAccountCount &&
      coverage?.preparedAccountCutoffSlices ===
        expectedProviderAccountCount &&
      coverage?.failedAccountCutoffSlices === 0 &&
      coverage?.challengerFailedRows === 0;
    if (!schedulerPopulationValid) {
      failures.push("authority_scheduler_population_coverage_invalid");
    }

    const waveCoverage = objectOrNull(parsed.waveCoverageProof);
    const waveBusinesses = Array.isArray(waveCoverage?.businesses)
      ? waveCoverage.businesses.flatMap((value) => {
          const item = objectOrNull(value);
          return item ? [item] : [];
        })
      : [];
    const waveAccounts = Array.isArray(waveCoverage?.accounts)
      ? waveCoverage.accounts.flatMap((value) => {
          const item = objectOrNull(value);
          return item ? [item] : [];
        })
      : [];
    const waveBusinessIds = new Set(
      waveBusinesses.flatMap((item) => {
        const businessId = text(item.businessId);
        return businessId ? [businessId] : [];
      }),
    );
    const waveProviderAccountKeys = new Set(
      waveAccounts.flatMap((item) => {
        const businessId = text(item.businessId);
        const providerAccountRefId = text(item.providerAccountRefId);
        const providerAccountId = text(item.providerAccountId);
        return businessId && providerAccountRefId && providerAccountId
          ? [`${businessId}::${providerAccountRefId}::${providerAccountId}`]
          : [];
      }),
    );
    const waveBusinessById = new Map(
      waveBusinesses.flatMap((item) => {
        const businessId = text(item.businessId);
        return businessId ? [[businessId, item] as const] : [];
      }),
    );
    const waveAccountsByBusiness = new Map<string, Record<string, unknown>[]>();
    for (const account of waveAccounts) {
      const businessId = text(account.businessId);
      if (!businessId) continue;
      const list = waveAccountsByBusiness.get(businessId) ?? [];
      list.push(account);
      waveAccountsByBusiness.set(businessId, list);
    }
    const expectedAccountsByBusiness = new Map<
      string,
      typeof expectedProviderAccounts
    >();
    for (const account of expectedProviderAccounts) {
      const list = expectedAccountsByBusiness.get(account.businessId) ?? [];
      list.push(account);
      expectedAccountsByBusiness.set(account.businessId, list);
    }
    const waveBusinessRows = waveBusinesses.reduce(
      (sum, item) => sum + Number(item.expectedDecisionRows),
      0,
    );
    const waveAccountRows = waveAccounts.reduce(
      (sum, item) => sum + Number(item.frozenRows),
      0,
    );
    waveCoverageValid =
      waveCoverage?.contradictions === 0 &&
      isNonNegativeSafeInteger(waveCoverage?.contradictions) &&
      waveBusinesses.length === expectedBusinessCount &&
      waveBusinessIds.size === expectedBusinessCount &&
      [...expectedBusinessIds].every((id) => waveBusinessIds.has(id)) &&
      waveAccounts.length === expectedProviderAccountCount &&
      waveProviderAccountKeys.size === expectedProviderAccountCount &&
      [...expectedProviderAccountKeys].every((key) =>
        waveProviderAccountKeys.has(key),
      ) &&
      waveBusinesses.every(
        (item) =>
          item.valid === true &&
          text(item.businessName) ===
            expectedBusinessNames.get(text(item.businessId) ?? "") &&
          text(item.decisionJobRunId) !== null &&
          text(item.calibrationJobRunId) !== null &&
          isNonNegativeSafeInteger(item.expectedDecisionRows) &&
          item.expectedDecisionRows > 0 &&
          isNonNegativeSafeInteger(item.anchoredSnapshotRows) &&
          item.expectedDecisionRows === item.anchoredSnapshotRows &&
          isNonNegativeSafeInteger(item.selectedScopeSnapshotRows) &&
          item.expectedDecisionRows === item.selectedScopeSnapshotRows &&
          isNonNegativeSafeInteger(item.selectedFrozenSnapshotRows) &&
          item.expectedDecisionRows === item.selectedFrozenSnapshotRows &&
          isNonNegativeSafeInteger(item.calibrationJobRowCount) &&
          isNonNegativeSafeInteger(item.calibrationJobExpectedCellCount) &&
          item.calibrationJobRowCount ===
            item.calibrationJobExpectedCellCount &&
          isNonNegativeSafeInteger(item.calibrationJobRowsWritten) &&
          item.calibrationJobRowCount === item.calibrationJobRowsWritten &&
          isNonNegativeSafeInteger(item.calibrationJobProviderAccountCount) &&
          item.calibrationJobProviderAccountCount ===
            (expectedAccountsByBusiness.get(
              text(item.businessId) ?? "",
            )?.length ?? 0) &&
          isNonNegativeSafeInteger(item.calibrationWaveReceiptCount) &&
          item.calibrationJobProviderAccountCount ===
            item.calibrationWaveReceiptCount &&
          isNonNegativeSafeInteger(item.calibrationWaveBatchCount) &&
          item.calibrationWaveReceiptCount ===
            item.calibrationWaveBatchCount &&
          isNonNegativeSafeInteger(item.calibrationWaveExpectedCellCount) &&
          item.calibrationJobExpectedCellCount ===
            item.calibrationWaveExpectedCellCount &&
          isNonNegativeSafeInteger(item.calibrationWaveActualCellCount) &&
          item.calibrationWaveExpectedCellCount ===
            item.calibrationWaveActualCellCount &&
          isNonNegativeSafeInteger(
            item.calibrationWaveReceiptContradictions,
          ) &&
          item.calibrationWaveReceiptContradictions === 0,
      ) &&
      waveAccounts.every(
        (item) => {
          const businessId = text(item.businessId);
          const providerAccountRefId = text(item.providerAccountRefId);
          const providerAccountId = text(item.providerAccountId);
          const businessProof = businessId
            ? waveBusinessById.get(businessId)
            : undefined;
          return (
            item.valid === true &&
            businessId !== null &&
            providerAccountRefId !== null &&
            providerAccountId !== null &&
            text(item.businessName) === expectedBusinessNames.get(businessId) &&
            text(item.anchoredAccountTimezone) !== null &&
            text(item.anchoredAccountCurrency) !== null &&
            text(item.calibrationBatchId) !== null &&
            text(item.calibrationBatchJobRunId) !== null &&
            item.calibrationBatchJobRunId ===
              businessProof?.calibrationJobRunId &&
            item.calibrationReceiptCount === 1 &&
            item.hydrationReceiptCount === 1 &&
            isNonNegativeSafeInteger(
              item.calibrationBatchExpectedCellCount,
            ) &&
            isNonNegativeSafeInteger(item.calibrationBatchActualCellCount) &&
            item.calibrationBatchExpectedCellCount ===
              item.calibrationBatchActualCellCount &&
            item.authoritativeForPrune === true &&
            item.calibrationLineageValid === true &&
            item.calibrationReceiptExact === true &&
            item.profileCalibrationExact === true &&
            item.canonicalEnvelopeExact === true &&
            isNonNegativeSafeInteger(item.frozenRows) &&
            item.frozenRows > 0 &&
            isNonNegativeSafeInteger(item.receiptExpectedRows) &&
            item.frozenRows === item.receiptExpectedRows &&
            isNonNegativeSafeInteger(item.receiptHydratedRows) &&
            item.frozenRows === item.receiptHydratedRows &&
            isSha256(item.recomputedManifestHash) &&
            item.recomputedManifestHash === item.receiptExpectedManifestHash &&
            item.recomputedManifestHash === item.receiptHydratedManifestHash
          );
        },
      ) &&
      waveBusinesses.every((business) => {
        const businessId = text(business.businessId);
        if (!businessId) return false;
        const businessAccounts =
          waveAccountsByBusiness.get(businessId) ?? [];
        const expectedAccounts =
          expectedAccountsByBusiness.get(businessId) ?? [];
        const expectedCells = businessAccounts.reduce(
          (sum, account) =>
            sum + Number(account.calibrationBatchExpectedCellCount),
          0,
        );
        const actualCells = businessAccounts.reduce(
          (sum, account) =>
            sum + Number(account.calibrationBatchActualCellCount),
          0,
        );
        return (
          businessAccounts.length === expectedAccounts.length &&
          expectedCells === business.calibrationJobExpectedCellCount &&
          actualCells === business.calibrationJobRowsWritten
        );
      }) &&
      isNonNegativeSafeInteger(coverage?.challengerComputedRows) &&
      waveBusinessRows === coverage.challengerComputedRows &&
      waveAccountRows === coverage.challengerComputedRows &&
      isNonNegativeSafeInteger(coverage?.baselineRows) &&
      coverage.baselineRows === coverage.challengerComputedRows;
    if (!waveCoverageValid) {
      failures.push("authority_scheduler_wave_coverage_invalid");
    }

    const exactMediaBuyerAudit = objectOrNull(parsed.exactMediaBuyerAudit);
    if (
      exactMediaBuyerAudit?.required !== true ||
      exactMediaBuyerAudit?.declaredScopeComplete !== true ||
      exactMediaBuyerAudit?.contradictions !== 0 ||
      !emptyArray(exactMediaBuyerAudit?.violations)
    ) {
      failures.push("authority_exact_media_buyer_audit_invalid");
    }
  }

  return {
    valid: failures.length === 0,
    failures,
    contractVersion,
    projectionContractVersion,
    releaseGatePassed,
    schedulerPopulationValid,
    waveCoverageValid,
  };
}

export function verifyCompactAuthorityArtifactFile(input: {
  repoRoot: string;
  artifactRepositoryPath: string;
  expectedAsOfDate: string;
  mode: CompactAuthorityArtifactMode;
}) {
  const populationPrefix =
    input.mode === "scheduler_population" ? "population_" : "";
  const checksum = verifyAuthorityArtifactChecksumSidecar(input);
  const failures = checksum.failures.map(
    (failure) => `${populationPrefix}${failure}`,
  );
  const artifactPath = resolve(input.repoRoot, input.artifactRepositoryPath);
  let parsedArtifact: Record<string, unknown> | null = null;
  let contractValidation: ReturnType<
    typeof validateCompactAuthorityArtifact
  > | null = null;

  if (existsSync(artifactPath)) {
    try {
      parsedArtifact = objectOrNull(
        JSON.parse(readFileSync(artifactPath, "utf8")) as unknown,
      );
      if (!parsedArtifact) throw new Error("root_not_object");
      contractValidation = validateCompactAuthorityArtifact({
        artifact: parsedArtifact,
        expectedAsOfDate: input.expectedAsOfDate,
        mode: input.mode,
      });
      failures.push(
        ...contractValidation.failures.map(
          (failure) => `${populationPrefix}${failure}`,
        ),
      );
    } catch (error) {
      failures.push(
        `${populationPrefix}authority_artifact_parse_failed:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    valid: failures.length === 0,
    failures,
    checksum,
    parsedArtifact,
    contractValidation,
  };
}

const PREVIOUS_AUTHORITY_ARTIFACT_PATH =
  "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-16-compact.json";
const FAILED_2026_07_19_FOCUSED_AUTHORITY_ARTIFACT_PATH =
  "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-compact.json";
const FAILED_2026_07_19_POPULATION_AUTHORITY_ARTIFACT_PATH =
  "docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-all-current-population-compact.json";

const authorityArtifactOutputSet = (artifactPath: string) => [
  artifactPath,
  artifactPath.replace(/\.json$/, ".sha256"),
  `${artifactPath}.tmp`,
];

export function buildD061AuthorityArtifactPlan(authorityAsOfDate: string) {
  validDate(authorityAsOfDate, "--authority-as-of");
  const generatedDirectory = "docs/creative-decision-center/generated";
  const focusedArtifactPath =
    `${generatedDirectory}/native-ad-account-aov-authority-replay-${authorityAsOfDate}-compact.json`;
  const populationArtifactPath =
    `${generatedDirectory}/native-ad-account-aov-authority-replay-${authorityAsOfDate}-all-current-population-compact.json`;
  const requiredRepositoryExclusions = [
    ...new Set(
      [
        focusedArtifactPath,
        populationArtifactPath,
        PREVIOUS_AUTHORITY_ARTIFACT_PATH,
        FAILED_2026_07_19_FOCUSED_AUTHORITY_ARTIFACT_PATH,
        FAILED_2026_07_19_POPULATION_AUTHORITY_ARTIFACT_PATH,
      ].flatMap(authorityArtifactOutputSet),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return {
    authorityAsOfDate,
    focusedArtifactPath,
    focusedSidecarPath: focusedArtifactPath.replace(/\.json$/, ".sha256"),
    populationArtifactPath,
    populationSidecarPath: populationArtifactPath.replace(
      /\.json$/,
      ".sha256",
    ),
    requiredRepositoryExclusions,
  };
}

const REQUIRED_AUTHORITY_SOURCE_FILES = [
  "scripts/creative-decision-center/native-ad-account-aov-authority-replay.ts",
  "scripts/_operational-runtime.ts",
  "lib/creative-decision-engine/jobs/ad-decisions-job.ts",
  "lib/creative-decision-engine/jobs/ad-calibration-job.ts",
  "lib/creative-decision-engine/jobs/ad-operator-response-job.ts",
  "lib/creative-decision-engine/jobs/native-ad-scheduled.ts",
  "lib/creative-decision-engine/ad-account-decision-profile.ts",
  "lib/creative-decision-engine/account-decision-profile.ts",
  "lib/creative-decision-engine/canonical-evaluation.ts",
  "lib/creative-decision-engine/data-source.ts",
  "lib/creative-decision-engine/decision-stability.ts",
  "lib/creative-decision-engine/feature-flags.ts",
  "lib/creative-decision-engine/gates/cut-policy.ts",
  "lib/creative-decision-engine/gates/types.ts",
  "lib/creative-decision-engine/kind-aware-profile.ts",
  "lib/creative-decision-engine/types.ts",
  "lib/sync/active-businesses.ts",
  "lib/creative-decision-engine/__tests__/jobs/native-ad-frozen-exact-replay.test.ts",
  "lib/creative-decision-engine/__tests__/fixtures/native-ad-frozen-exact-replay.v1.json",
].sort((left, right) => left.localeCompare(right));

function exactStringArray(
  value: unknown,
  expected: readonly string[],
) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every(
      (item, index) =>
        typeof item === "string" && item === expected[index],
    )
  );
}

export function compactArtifactRepositoryContentParity(input: {
  artifact: Record<string, unknown>;
  repoRoot: string;
  replayOutputPaths: readonly string[];
  authorityAsOfDate: string;
}) {
  const authorityPlan = buildD061AuthorityArtifactPlan(
    input.authorityAsOfDate,
  );
  const codeProvenance = objectOrNull(input.artifact.codeProvenance);
  const recordedManifest = objectOrNull(
    codeProvenance?.repositoryContentManifest,
  );
  const recordedExclusions = Array.isArray(
    recordedManifest?.excludedRepositoryPaths,
  )
    ? recordedManifest.excludedRepositoryPaths.flatMap((value) => {
        const parsedPath = text(value);
          return parsedPath ? [parsedPath] : [];
        })
      : [];
  const sourceFiles = objectOrNull(codeProvenance?.sourceFiles);
  const sourceFilePaths = sourceFiles
    ? Object.keys(sourceFiles).sort((left, right) =>
        left.localeCompare(right),
      )
    : [];
  const provenanceContractValid =
    codeProvenance?.captureMode ===
      "pre_output_repository_content_manifest" &&
    recordedManifest?.scope ===
      "current_tracked_and_untracked_non_ignored_repository_content_excluding_declared_outputs" &&
    exactStringArray(
      recordedManifest?.excludedRepositoryPaths,
      authorityPlan.requiredRepositoryExclusions,
    ) &&
    recordedExclusions.length ===
      authorityPlan.requiredRepositoryExclusions.length &&
    exactStringArray(sourceFilePaths, REQUIRED_AUTHORITY_SOURCE_FILES) &&
    sourceFiles !== null &&
    REQUIRED_AUTHORITY_SOURCE_FILES.every((path) => {
      const recordedHash = text(sourceFiles[path]);
      return (
        recordedHash !== null &&
        /^[0-9a-f]{64}$/.test(recordedHash) &&
        recordedHash === sha256File(resolve(input.repoRoot, path))
      );
    });
  const currentManifest = buildRepositoryContentManifest(input.repoRoot, [
    ...new Set([
      ...authorityPlan.requiredRepositoryExclusions,
      ...repositoryRelativeOutputPaths(
        input.repoRoot,
        input.replayOutputPaths,
      ),
    ]),
  ]);
  return (
    provenanceContractValid &&
    recordedManifest !== null &&
    recordedManifest.manifestSha256 === currentManifest.manifestSha256 &&
    recordedManifest.fileCount === currentManifest.fileCount &&
    recordedManifest.trackedFileCount === currentManifest.trackedFileCount &&
    recordedManifest.untrackedFileCount ===
      currentManifest.untrackedFileCount &&
    recordedManifest.missingTrackedFileCount ===
      currentManifest.missingTrackedFileCount &&
    recordedManifest.contentBytes === currentManifest.contentBytes
  );
}

export function crossArtifactProof(input: {
  authorityAsOfDate: string;
  expectedAccounts: readonly D061ExpectedAccountStratum[];
  historicalScopes: readonly {
    businessId: string;
    providerAccountId: string;
  }[];
  replayOutputPaths: readonly string[];
}) {
  const authorityPlan = buildD061AuthorityArtifactPlan(
    input.authorityAsOfDate,
  );
  const authorityArtifactPath = authorityPlan.focusedArtifactPath;
  const authoritySidecarPath = authorityPlan.focusedSidecarPath;
  const populationAuthorityArtifactPath =
    authorityPlan.populationArtifactPath;
  const populationAuthoritySidecarPath =
    authorityPlan.populationSidecarPath;
  const artifacts = [
    {
      path: "lib/creative-decision-engine/__tests__/fixtures/native-ad-frozen-exact-replay.v1.json",
      purpose:
        "Frozen production-function exact acceptance including D036 later-date confirmation",
    },
    {
      path: "lib/creative-decision-engine/__tests__/jobs/native-ad-frozen-exact-replay.test.ts",
      purpose: "Executable frozen exact acceptance",
    },
    {
      path: "scripts/creative-decision-center/native-ad-account-aov-authority-replay.ts",
      purpose:
        "Persisted current-epoch fixed-input baseline/challenger replay; not pooled with closed historical outcomes",
    },
    {
      path: authorityArtifactPath,
      purpose:
        "Hash-bound compact projection of the current-day exact-four production-input replay",
    },
    {
      path: authoritySidecarPath,
      purpose:
        "Independent SHA-256 checksum for the retained current-day exact-four compact proof",
    },
    {
      path: populationAuthorityArtifactPath,
      purpose:
        "Hash-bound compact projection of the current-day scheduler population proof",
    },
    {
      path: populationAuthoritySidecarPath,
      purpose:
        "Independent SHA-256 checksum for the retained current-day scheduler population proof",
    },
  ];
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const failures: string[] = [];
  const authorityArtifactVerification = verifyCompactAuthorityArtifactFile({
    repoRoot,
    artifactRepositoryPath: authorityArtifactPath,
    expectedAsOfDate: input.authorityAsOfDate,
    mode: "focused",
  });
  failures.push(...authorityArtifactVerification.failures);
  const populationAuthorityArtifactVerification =
    verifyCompactAuthorityArtifactFile({
      repoRoot,
      artifactRepositoryPath: populationAuthorityArtifactPath,
      expectedAsOfDate: input.authorityAsOfDate,
      mode: "scheduler_population",
    });
  failures.push(...populationAuthorityArtifactVerification.failures);
  const authorityArtifactIntegrity = authorityArtifactVerification.checksum;
  const populationAuthorityArtifactIntegrity =
    populationAuthorityArtifactVerification.checksum;
  const parsedContractVersion =
    authorityArtifactVerification.contractValidation?.contractVersion ?? null;
  const parsedProjectionContractVersion =
    authorityArtifactVerification.contractValidation
      ?.projectionContractVersion ?? null;
  const parsedReleaseGatePassed =
    authorityArtifactVerification.contractValidation?.releaseGatePassed ??
    false;
  let repositoryContentParity = false;
  let populationRepositoryContentParity = false;
  let requestedScopeParity = false;
  let exactMediaBuyerScopeValid = false;
  const populationArtifact =
    populationAuthorityArtifactVerification.parsedArtifact;
  if (populationArtifact) {
    try {
      populationRepositoryContentParity =
        compactArtifactRepositoryContentParity({
          artifact: populationArtifact,
          repoRoot,
          replayOutputPaths: input.replayOutputPaths,
          authorityAsOfDate: input.authorityAsOfDate,
        });
      if (!populationRepositoryContentParity) {
        failures.push(
          "population_authority_repository_content_manifest_mismatch",
        );
      }
    } catch (error) {
      failures.push(
        `population_authority_repository_content_manifest_validation_failed:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const authorityArtifact = authorityArtifactVerification.parsedArtifact;
  if (authorityArtifact) {
    try {
      const parsed = authorityArtifact;
      const parameters = objectOrNull(parsed.parameters);
      repositoryContentParity = compactArtifactRepositoryContentParity({
        artifact: parsed,
        repoRoot,
        replayOutputPaths: input.replayOutputPaths,
        authorityAsOfDate: input.authorityAsOfDate,
      });
      if (!repositoryContentParity) {
        failures.push("authority_repository_content_manifest_mismatch");
      }

      const expectedScopeSet = new Set(
        input.historicalScopes.map(
          (scope) => `${scope.businessId}::${scope.providerAccountId}`,
        ),
      );
      const expectedAccountIds = [
        ...new Set(
          input.expectedAccounts.map((account) => account.providerAccountId),
        ),
      ].sort();
      const providerAccountFilter = Array.isArray(
        parameters?.providerAccountFilter,
      )
        ? parameters.providerAccountFilter.flatMap((value) => {
            const item = objectOrNull(value);
            const businessId = text(item?.businessSelector);
            const providerAccountId = text(item?.providerAccountId);
            return businessId && providerAccountId
              ? [`${businessId}::${providerAccountId}`]
              : [];
          })
        : [];
      const requestedScopeCoverage = objectOrNull(
        parsed.requestedScopeCoverage,
      );
      const coverageAccounts = Array.isArray(
        requestedScopeCoverage?.providerAccounts,
      )
        ? requestedScopeCoverage.providerAccounts.flatMap((value) => {
            const item = objectOrNull(value);
            const businessId = text(item?.businessSelector);
            const providerAccountId = text(item?.providerAccountId);
            return businessId && providerAccountId && item?.valid === true
              ? [`${businessId}::${providerAccountId}`]
              : [];
          })
        : [];
      requestedScopeParity =
        input.expectedAccounts.length === 4 &&
        expectedAccountIds.length === 4 &&
        expectedScopeSet.size === 4 &&
        providerAccountFilter.length === 4 &&
        coverageAccounts.length === 4 &&
        providerAccountFilter.every((scope) => expectedScopeSet.has(scope)) &&
        coverageAccounts.every((scope) => expectedScopeSet.has(scope)) &&
        Number(requestedScopeCoverage?.contradictions) === 0;
      if (!requestedScopeParity)
        failures.push("authority_exact_scope_mismatch");

      const exactAudit = objectOrNull(parsed.exactMediaBuyerAudit);
      const auditRequestedIds = Array.isArray(
        exactAudit?.requestedProviderAccountIds,
      )
        ? exactAudit.requestedProviderAccountIds
            .flatMap((value) => {
              const id = text(value);
              return id ? [id] : [];
            })
            .sort()
        : [];
      exactMediaBuyerScopeValid =
        exactAudit?.required === true &&
        Number(exactAudit?.contradictions) === 0 &&
        Array.isArray(exactAudit?.unexpectedRequestedProviderAccountIds) &&
        exactAudit.unexpectedRequestedProviderAccountIds.length === 0 &&
        d061StableHash(auditRequestedIds) ===
          d061StableHash(expectedAccountIds);
      if (!exactMediaBuyerScopeValid) {
        failures.push("authority_exact_media_buyer_audit_invalid");
      }
    } catch (error) {
      failures.push(
        `authority_artifact_parse_failed:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return {
    evidenceIsNotPooledAcrossSourceModes: true,
    formulaSensitivityOnly: true,
    historicalLaneMayOpenAutomationOrRelease: false,
    valid: failures.length === 0,
    failures,
    parsedAuthorityArtifact: {
      contractVersion: parsedContractVersion,
      projectionContractVersion: parsedProjectionContractVersion,
      releaseGatePassed: parsedReleaseGatePassed,
      repositoryContentParity,
      requestedScopeParity,
      exactMediaBuyerScopeValid,
      artifactSha256: authorityArtifactIntegrity.actualSha256,
      checksumSidecarPath:
        authorityArtifactIntegrity.sidecarRepositoryPath,
      checksumSidecarExpectedSha256:
        authorityArtifactIntegrity.expectedSha256,
      checksumSidecarRecordedArtifactPath:
        authorityArtifactIntegrity.recordedArtifactPath,
      checksumSidecarValid: authorityArtifactIntegrity.valid,
    },
    populationAuthorityArtifact: {
      contractVersion:
        populationAuthorityArtifactVerification.contractValidation
          ?.contractVersion ?? null,
      projectionContractVersion:
        populationAuthorityArtifactVerification.contractValidation
          ?.projectionContractVersion ?? null,
      releaseGatePassed:
        populationAuthorityArtifactVerification.contractValidation
          ?.releaseGatePassed ?? false,
      schedulerPopulationValid:
        populationAuthorityArtifactVerification.contractValidation
          ?.schedulerPopulationValid ?? false,
      waveCoverageValid:
        populationAuthorityArtifactVerification.contractValidation
          ?.waveCoverageValid ?? false,
      repositoryContentParity: populationRepositoryContentParity,
      artifactSha256: populationAuthorityArtifactIntegrity.actualSha256,
      checksumSidecarPath:
        populationAuthorityArtifactIntegrity.sidecarRepositoryPath,
      checksumSidecarExpectedSha256:
        populationAuthorityArtifactIntegrity.expectedSha256,
      checksumSidecarRecordedArtifactPath:
        populationAuthorityArtifactIntegrity.recordedArtifactPath,
      checksumSidecarValid: populationAuthorityArtifactIntegrity.valid,
    },
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      sha256: sha256File(resolve(process.cwd(), artifact.path)),
    })),
  };
}

function parseRoasDisplay(value: string): number | null {
  const match = value
    .trim()
    .replace(",", ".")
    .match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function legacyTargetCorroborationProof(input: {
  evidence: readonly LegacyTargetDisplayCorroboration[];
  candidates: readonly FixedOpportunityCandidate[];
  expectedAccountStrata: readonly D061ExpectedAccountStratum[];
}) {
  const entries = input.expectedAccountStrata.map((stratum) => {
    const candidates = input.candidates.filter(
      (candidate) =>
        candidate.providerAccountId === stratum.providerAccountId &&
        candidate.asOfDate >= D061_LOCKED_TEST_START &&
        candidate.asOfDate <= D061_LOCKED_TEST_END,
    );
    const businessIds = [...new Set(candidates.map((row) => row.business.id))];
    const evidence = input.evidence.find(
      (row) => businessIds.length === 1 && row.businessId === businessIds[0],
    );
    const selectedTargetRoas = [
      ...new Set(candidates.map((row) => row.target.targetRoas)),
    ].filter((value): value is number => value !== null);
    const selectedBreakEvenRoas = [
      ...new Set(candidates.map((row) => row.target.breakEvenRoas)),
    ].filter((value): value is number => value !== null);
    const legacyTargetRoas =
      evidence?.targetRoasDisplays.length === 1
        ? parseRoasDisplay(evidence.targetRoasDisplays[0]!)
        : null;
    const legacyBreakEvenRoas =
      evidence?.breakEvenRoasDisplays.length === 1
        ? parseRoasDisplay(evidence.breakEvenRoasDisplays[0]!)
        : null;
    const singular =
      evidence !== undefined &&
      evidence.snapshotRows > 0 &&
      evidence.targetRoasDisplays.length === 1 &&
      evidence.breakEvenRoasDisplays.length === 1 &&
      legacyTargetRoas !== null &&
      legacyBreakEvenRoas !== null;
    const matchesRestatedSelector =
      singular &&
      selectedTargetRoas.length === 1 &&
      selectedBreakEvenRoas.length === 1 &&
      Math.abs(selectedTargetRoas[0]! - legacyTargetRoas!) < 1e-9 &&
      Math.abs(selectedBreakEvenRoas[0]! - legacyBreakEvenRoas!) < 1e-9;
    return {
      key: stratum.key,
      label: stratum.label,
      providerAccountId: stratum.providerAccountId,
      businessId: businessIds[0] ?? null,
      businessName: evidence?.businessName ?? null,
      snapshotRows: evidence?.snapshotRows ?? 0,
      firstCreatedAt: evidence?.firstCreatedAt ?? null,
      lastCreatedAt: evidence?.lastCreatedAt ?? null,
      targetRoasDisplays: evidence?.targetRoasDisplays ?? [],
      breakEvenRoasDisplays: evidence?.breakEvenRoasDisplays ?? [],
      parsedLegacyTargetRoas: legacyTargetRoas,
      parsedLegacyBreakEvenRoas: legacyBreakEvenRoas,
      selectedRestatedTargetRoas: selectedTargetRoas,
      selectedRestatedBreakEvenRoas: selectedBreakEvenRoas,
      singular,
      matchesRestatedSelector,
      status: !evidence
        ? "missing"
        : !singular
          ? "non_singular_or_unparseable"
          : matchesRestatedSelector
            ? "matched"
            : "mismatch",
    };
  });
  return {
    sourceMode:
      "legacy_meta_decision_snapshot_target_display_corroboration" as const,
    canonicalAuthority: false as const,
    mayOpenAutomationOrRelease: false as const,
    lockedWindow: {
      start: D061_LOCKED_TEST_START,
      end: D061_LOCKED_TEST_END,
      createdAtBoundary:
        "same snapshot date before end-of-day; not exact 03:00 cutoff",
    },
    valid: entries.every((entry) => entry.status === "matched"),
    entries,
  };
}

function renderMarkdown(
  report: Awaited<ReturnType<typeof runD061ClosedWindowReplay>>,
) {
  const lines = [
    "# D061 Native-Ad Account AOV Closed-Window Replay",
    "",
    `Generated: ${report.generatedAt}`,
    `Classification: \`${report.gate.classification}\``,
    "",
    "This is a SELECT-only, fixed-cohort Lane B formula-sensitivity review. Daily metric values/availability and target recorded time are explicitly restated; it is not an exact historical production replay and cannot open automation or release.",
    "",
    "## Integrity Gate",
    "",
    `- Passed: ${report.gate.integrityGate.passed}`,
    `- Failures: ${report.gate.integrityGate.failures.join(", ") || "none"}`,
    "",
    "## Historical Promotion Quality Gate (review-only)",
    "",
    `- Passed: ${report.gate.historicalPromotionQualityGate.passed}`,
    `- Failures: ${report.gate.historicalPromotionQualityGate.failures.join(", ") || "none"}`,
    `- Fixed cohort rows: ${report.gate.fixedCohort.rows}`,
    `- Locked complete / primary rows: ${report.gate.historicalPromotionQualityGate.observed.lockedCompleteRows} / ${report.gate.historicalPromotionQualityGate.observed.lockedPrimaryRows}`,
    `- Locked supported / known emitted (precision denominator): ${report.gate.historicalPromotionQualityGate.observed.lockedSupported} / ${report.gate.historicalPromotionQualityGate.observed.lockedKnownEmitted}`,
    `- Locked captured / positive opportunities (recall denominator): ${report.gate.historicalPromotionQualityGate.observed.lockedOpportunityCaptured} / ${report.gate.historicalPromotionQualityGate.observed.lockedOpportunityPositive}`,
    `- Target recorded after cutoff rows: ${report.gate.evidence.restatedTargetRecordedAfterCutoffRows}`,
    `- Hierarchy context unreconstructable rows: ${report.gate.evidence.hierarchyContextMissingRows}`,
    `- Cross-artifact parity valid: ${report.crossArtifact.valid}`,
    `- Legacy target-display corroboration valid: ${report.legacyTargetCorroboration.valid}`,
    `- Physical-account AOV changed-Cut rows: ${report.gate.evidence.physicalAccountAovChangedCutRows}`,
    `- Above-break-even Cut rows: ${report.gate.evidence.aboveBreakEvenCutRows}`,
    `- Raw Scale / Refresh drift: ${report.gate.evidence.rawScaleDeltaRows} / ${report.gate.evidence.rawRefreshDeltaRows}`,
    "",
    "## Named Accounts (14d)",
    "",
    "| Account | Status | Rows | Primary | Changed Cut | Supported / Emitted | Precision | Wilson lower | Captured / Positive | Recall | Safety |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const stratum of report.gate.strata.slice(1)) {
    const score = stratum.windows["14"]!;
    lines.push(
      `| ${stratum.label} | ${stratum.supportStatus}${stratum.supportReason ? ` (${stratum.supportReason})` : ""} | ${stratum.fixedCohortRows} | ${score.challenger.primaryRows} | ${stratum.changedCutRows} | ${score.challenger.supported} / ${score.challenger.knownEmitted} | ${score.challenger.precision?.toFixed(4) ?? "n/a"} | ${score.challenger.precisionWilson95?.lower.toFixed(4) ?? "n/a"} | ${score.challenger.opportunityCaptured} / ${score.challenger.opportunityPositive} | ${score.challenger.opportunityRecall?.toFixed(4) ?? "n/a"} | ${score.safety.aboveBreakEvenChallengerCutRows} |`,
    );
  }
  lines.push(
    "",
    "## Chronological Decision Audit",
    "",
    `- Daily decisions evaluated in chronological order: ${report.chronologicalAudit.rows}`,
    `- Published Cut rows across all available daily decisions: ${report.chronologicalAudit.publishedCutRows}`,
    `- Published Cut manifest SHA-256: \`${report.chronologicalAudit.publishedCutManifestHash}\``,
    "",
    "| Account | Daily rows | Raw Cut | Published Cut | Published hard actions |",
    "|---|---:|---:|---:|---:|",
  );
  for (const account of report.chronologicalAudit.accounts) {
    lines.push(
      `| ${account.label} | ${account.rows} | ${account.challengerRawLabels.cut ?? 0} | ${account.publishedCutRows} | ${account.publishedHardActionRows} |`,
    );
  }
  lines.push(
    "",
    "## Legacy Target Display Corroboration (non-authoritative)",
    "",
    "| Account | Status | Snapshot rows | Legacy Target / BE | Restated Target / BE |",
    "|---|---|---:|---:|---:|",
  );
  for (const entry of report.legacyTargetCorroboration.entries) {
    lines.push(
      `| ${entry.label} | ${entry.status} | ${entry.snapshotRows} | ${entry.parsedLegacyTargetRoas ?? "n/a"} / ${entry.parsedLegacyBreakEvenRoas ?? "n/a"} | ${entry.selectedRestatedTargetRoas.join(", ") || "n/a"} / ${entry.selectedRestatedBreakEvenRoas.join(", ") || "n/a"} |`,
    );
  }
  lines.push(
    "",
    "## Evidence Boundary",
    "",
    "- Targets come only from immutable `business_target_pack_history`. Lane B selects by effective time, retains actual `recorded_at` for audit, supplies a separate cutoff-time restatement to the calculation, and always reports `exactAtCutoff=false`.",
    "- Only finalized/passed ad and finalized/passed campaign/adset daily facts are admitted to Lane B formula input. Their actual timestamps remain hash-bound while separate availability-restated copies are clamped to the review cutoff; excluded and unavailable hierarchy evidence is counted and cannot become exact PIT authority.",
    "- Crossing target age 30 days is a metamorphic test and must not change label, confidence, authority blocker, or raw decision.",
    "- Current SCD0 account, creative, status, lifecycle, ranking, and profile configuration are not used as historical decision authority.",
    "- The challenger changes one axis only: a ready physical-account/currency 90d AOV proof is passed through retained production functions for Cut-sizing formula sensitivity.",
    "- Baseline and challenger maintain separate chronological D036 maps. Only published final `Cut` counts as emitted; a first hard signal remains pending and a later selected date can confirm it.",
    "- Lane A and Lane B metrics are never pooled. Cross-artifact current-day parity is parsed and source-hash checked independently; a missing/failed/stale artifact fails review.",
    "- Legacy June snapshot target displays may corroborate target values, but never become canonical target authority and never relax this boundary.",
    "",
  );
  return lines.join("\n");
}

export async function runD061ClosedWindowReplay(
  args: D061ClosedWindowReplayArgs,
) {
  const data = await loadReplayData(args);
  const deduplicated = deduplicateD061RestatedFacts(data.sourceRows);
  const fixed = buildFixedOpportunityCohort({
    args,
    data,
    facts: deduplicated.facts,
  });
  const scoredCandidates = fixed.candidates.filter(
    (candidate) => candidate.scoreEligible,
  );
  const factsByAd = new Map<string, NativeAdCalibrationSourceRow[]>();
  for (const row of deduplicated.facts) {
    const key = [
      row.businessId,
      row.providerAccountRefId,
      row.providerAccountId,
      row.adId,
    ].join("::");
    const list = factsByAd.get(key) ?? [];
    list.push(row);
    factsByAd.set(key, list);
  }
  // D047 invariant: candidate membership and its hash are frozen before either
  // baseline or challenger production profile is resolved.
  const fixedCandidateHash = d061StableHash(
    scoredCandidates.map((candidate) => ({
      fixedKey: candidate.fixedKey,
      targetSourceRowId: candidate.target.sourceRowId,
      targetEffectiveAt: candidate.target.effectiveAt,
      targetActualRecordedAt: candidate.target.recordedAt,
      targetProductionRecordedAt: candidate.productionTarget.recordedAt,
      targetRecordedAfterCutoff: candidate.targetRecordedAfterCutoff,
      actionReceiptManifestHash: d061StableHash(
        candidate.actionReceipts.map((receipt) => ({
          id: receipt.id,
          scopeType: receipt.scopeType,
          scopeId: receipt.scopeId,
          requestedAt: receipt.requestedAt,
          status: receipt.status,
          verifiedAt: receipt.verifiedAt,
          dryRun: receipt.dryRun,
        })),
      ),
      sourceRowIds: candidate.sourceRows
        .filter(
          (row) =>
            row.date >= addDays(candidate.asOfDate, -89) &&
            row.date <= candidate.asOfDate,
        )
        .map((row) => row.sourceRowId)
        .sort(),
    })),
  );
  const evaluationSequenceHash = d061StableHash(
    fixed.candidates.map((candidate) => ({
      fixedKey: candidate.fixedKey,
      scoreEligible: candidate.scoreEligible,
      decisionStatusProof: candidate.decisionStatusProof,
    })),
  );
  const rows: D061ClosedWindowReplayRow[] = [];
  const chronologicalRows: D061ClosedWindowReplayRow[] = [];
  // Each hypothetical variant owns independent D036 memory. Every available
  // daily evaluation advances that memory; the 7-day cooldown only selects
  // outcome-scored rows. A missing intermediate daily evaluation clears the
  // prior tuple conservatively so replay can never false-confirm a Cut.
  const baselinePreviousLabels = new Map<string, PreviousAdPublishedLabel>();
  const challengerPreviousLabels = new Map<string, PreviousAdPublishedLabel>();
  const lastEvaluatedDate = new Map<string, string>();
  let chronologyGapResets = 0;
  const batchCache = new Map<string, NativeAdCalibrationBatch | Error>();
  const profileCache = new Map<string, AccountDecisionProfile>();
  const sourceSliceCache = new Map<string, CachedSourceSlice>();
  for (const candidate of fixed.candidates) {
    const stabilityKey = replayStabilityKey(candidate);
    const priorEvaluationDate = lastEvaluatedDate.get(stabilityKey);
    if (
      priorEvaluationDate !== undefined &&
      diffDays(candidate.asOfDate, priorEvaluationDate) > 1
    ) {
      baselinePreviousLabels.delete(stabilityKey);
      challengerPreviousLabels.delete(stabilityKey);
      chronologyGapResets += 1;
    }
    const row = await evaluateCandidate({
      candidate,
      factsByAd,
      completeness: data.completeness,
      outcomeCeiling: args.outcomeCeiling,
      baselinePreviousLabels,
      challengerPreviousLabels,
      batchCache,
      profileCache,
      sourceSliceCache,
    });
    lastEvaluatedDate.set(stabilityKey, candidate.asOfDate);
    chronologicalRows.push(row);
    if (candidate.scoreEligible) rows.push(row);
  }
  const crossArtifact = crossArtifactProof({
    authorityAsOfDate: args.authorityAsOfDate,
    expectedAccounts: args.accounts,
    historicalScopes: args.accounts.flatMap((account) => {
      const businessIds = [
        ...new Set(
          scoredCandidates
            .filter(
              (candidate) =>
                candidate.providerAccountId === account.providerAccountId,
            )
            .map((candidate) => candidate.business.id),
        ),
      ];
      return businessIds.length === 1
        ? [
            {
              businessId: businessIds[0]!,
              providerAccountId: account.providerAccountId,
            },
          ]
        : [];
    }),
    replayOutputPaths: args.writeFiles ? [args.jsonOut, args.mdOut] : [],
  });
  const legacyTargetCorroboration = legacyTargetCorroborationProof({
    evidence: data.legacyTargetDisplayCorroboration,
    candidates: scoredCandidates,
    expectedAccountStrata: args.accounts,
  });
  const gate = evaluateD061ClosedWindowGate(rows, {
    conflictingDuplicateFactGroups: deduplicated.conflictingDuplicateGroups,
    chronologicalIntegrityRows: chronologicalRows,
    crossArtifactParityValid: crossArtifact.valid,
    legacyTargetCorroborationValid: legacyTargetCorroboration.valid,
    expectedAccountStrata: args.accounts,
    consecutiveDailyCoverageComplete: chronologyGapResets === 0,
    lockedWindowExact:
      args.startDate === DEFAULT_START_DATE &&
      args.decisionEndDate === DEFAULT_DECISION_END_DATE &&
      args.outcomeCeiling === DEFAULT_OUTCOME_CEILING,
  });
  const hardLabels = new Set<DecisionLabel>(["cut", "refresh", "scale"]);
  const decisionCounts = (
    accountRows: readonly D061ClosedWindowReplayRow[],
    selector: (row: D061ClosedWindowReplayRow) => DecisionLabel,
  ) => {
    const counts: Record<string, number> = {};
    for (const row of accountRows) {
      const label = selector(row);
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
  };
  const publishedCutManifest = chronologicalRows
    .filter((row) => row.challenger.finalLabel === "cut")
    .map((row) => ({
      rowHash: row.rowHash,
      businessName: row.businessName,
      providerAccountId: row.providerAccountId,
      adIdHash: row.adIdHash,
      asOfDate: row.asOfDate,
      target: row.target,
      preDecision: row.preDecision,
      challenger: row.challenger,
      outcomes: row.outcomes,
    }));
  return {
    contractVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    readOnly: true as const,
    mutatesDatabase: false as const,
    providerCalls: false as const,
    cronCalls: false as const,
    input: args,
    codeProvenance: readReplayCodeProvenance(args),
    transaction: data.transaction,
    methodology: {
      grain: "native_meta_ad_id",
      fixedCohortBeforeVariants: true,
      targetSource:
        "business_target_pack_history semantic-effective selection; actual recorded_at audited and calculation recorded_at explicitly restated to cutoff",
      profileConfigSource:
        "current retained-code default formula only; no historical profile-config reconstruction",
      sourceMode: "restated_ad_daily",
      sourceAuthority: "review_only_never_automation",
      classification:
        "Lane B formula-sensitivity review; not historical execution parity",
      fullDayMetricRestatement:
        "finalized daily metric values and their availability timestamps are restated; this is not exact PIT availability",
      statusRestatement:
        "positive finalized same-day delivery is hash-bound as neutral ACTIVE formula input; statusEvidence remains missing and this is never exact historical status authority",
      campaignContextRestatement:
        "historical campaign-role snapshots are unavailable; Lane B supplies hash-bound neutral medium context with null kind so production canonical baselines run without Test/Main transforms; this remains review-only and never grants automation authority",
      d036Chronology:
        "every available daily candidate advances independent baseline/challenger state; cooldown selects scoring rows only and unknown day gaps clear prior state",
      hierarchyContextPolicy:
        "finalized campaign/adset daily values are explicitly availability-restated for Lane B and their actual timestamps remain hash-bound; null context remains null and production admission fails closed",
      lanePooling: false,
      outcomes: [3, 7, 14],
      zeroRevenueRule:
        "positive forward spend plus zero revenue is a known loser",
      zeroSpendRule: "zero forward spend is censored",
      singleAxis:
        "baseline null vs challenger ready physical-account/currency AOV passed through retained production functions for paired formula sensitivity",
      currentScd0DecisionAuthority: false,
      targetAgePolicy:
        "age is advisory; Lane B uses the selected effective target only as an explicit semantic restatement and never as exact PIT authority",
      releaseBoundary:
        "this historical lane cannot open automation or release; cross-artifact current-day parity must independently pass",
    },
    chronologicalAudit: {
      rows: chronologicalRows.length,
      rowManifestHash: d061StableHash(
        chronologicalRows.map((row) => ({
          cohortKey: row.cohortKey,
          rowHash: row.rowHash,
        })),
      ),
      accounts: args.accounts.map((account) => {
        const accountRows = chronologicalRows.filter(
          (row) => row.providerAccountId === account.providerAccountId,
        );
        return {
          key: account.key,
          label: account.label,
          providerAccountId: account.providerAccountId,
          rows: accountRows.length,
          challengerPreAuthorityLabels: decisionCounts(
            accountRows,
            (row) => row.challenger.preAuthorityLabel,
          ),
          challengerRawLabels: decisionCounts(
            accountRows,
            (row) => row.challenger.rawLabel,
          ),
          challengerFinalLabels: decisionCounts(
            accountRows,
            (row) => row.challenger.finalLabel,
          ),
          publishedHardActionRows: accountRows.filter((row) =>
            hardLabels.has(row.challenger.finalLabel),
          ).length,
          publishedCutRows: accountRows.filter(
            (row) => row.challenger.finalLabel === "cut",
          ).length,
        };
      }),
      publishedCutManifestHash: d061StableHash(publishedCutManifest),
      publishedCutRows: publishedCutManifest.length,
      publishedCutSamples: publishedCutManifest.slice(0, 24),
    },
    coverage: {
      businesses: data.businesses.length,
      rawSourceRows: data.sourceRows.length,
      canonicalDeduplicatedFacts: deduplicated.facts.length,
      conflictingDuplicateFactGroups: deduplicated.conflictingDuplicateGroups,
      chronologicalEvaluationCandidates: fixed.candidates.length,
      chronologicalEvaluatedRows: chronologicalRows.length,
      fixedOpportunityCandidates: scoredCandidates.length,
      evaluatedRows: rows.length,
      chronologyGapResets,
      consecutiveDailyCoverageComplete: chronologyGapResets === 0,
      targetRecordedAfterCutoffRows: rows.filter(
        (row) => row.target.recordedAfterCutoff,
      ).length,
      hierarchyContextMissingRows: rows.filter(
        (row) =>
          row.hierarchyContextAtCutoff.status === "missing_unreconstructable",
      ).length,
      actionCoverageUnknownRows: rows.filter(
        (row) => row.actionCoverageAtCutoff.status === "unknown_parent_scopes",
      ).length,
      windows: Object.fromEntries(
        D061_CLOSED_OUTCOME_WINDOWS.map((windowDays) => {
          const score = gate.strata[0]!.windows[String(windowDays)]!;
          return [
            String(windowDays),
            {
              cohortRows: score.challenger.cohortRows,
              completeRows: score.challenger.completeRows,
              primaryRows: score.challenger.primaryRows,
              knownOpportunities: score.challenger.knownOpportunities,
              knownEmitted: score.challenger.knownEmitted,
            },
          ];
        }),
      ),
      ...fixed.exclusions,
    },
    lineage: {
      fixedCandidateHash,
      evaluationSequenceHash,
      evaluatedRowSetHash: d061StableHash(
        rows.map((row) => ({
          cohortKey: row.cohortKey,
          rowHash: row.rowHash,
        })),
      ),
      sourceManifestHash: d061StableHash(
        data.sourceRows.map((row) => ({
          sourceRowId: row.sourceRowId,
          businessId: row.businessId,
          providerAccountRefId: row.providerAccountRefId,
          providerAccountId: row.providerAccountId,
          adIdHash: d061StableHash(row.adId),
          date: row.date,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          finalizedAt: row.finalizedAt,
        })),
      ),
      scriptSha256: sha256File(
        resolve(
          process.cwd(),
          "scripts/creative-decision-center/native-ad-account-aov-closed-window-replay.ts",
        ),
      ),
      gateSha256: sha256File(
        resolve(
          process.cwd(),
          "scripts/creative-decision-center/d061-account-aov-closed-window-gate.ts",
        ),
      ),
    },
    crossArtifact,
    legacyTargetCorroboration,
    gate,
  };
}

async function main() {
  configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const args = parseD061ClosedWindowReplayArgs(process.argv.slice(2));
  const report = await withOperationalStartupLogsSilenced(() =>
    runD061ClosedWindowReplay(args),
  );
  const markdown = renderMarkdown(report);
  const outputs = args.writeFiles
    ? [
        {
          outputPath: resolve(args.jsonOut),
          content: `${JSON.stringify(report, null, 2)}\n`,
        },
        { outputPath: resolve(args.mdOut), content: `${markdown}\n` },
      ]
    : [];
  const stagedOutputs = outputs.map((output) => ({
    ...output,
    temporaryPath: `${output.outputPath}.tmp`,
  }));
  try {
    for (const output of stagedOutputs) {
      mkdirSync(dirname(output.outputPath), { recursive: true });
      writeFileSync(output.temporaryPath, output.content, "utf8");
    }
    assertClosedWindowReplayProvenanceStable(report.codeProvenance, args);
    for (const output of stagedOutputs) {
      renameSync(output.temporaryPath, output.outputPath);
    }
  } finally {
    for (const output of stagedOutputs) {
      rmSync(output.temporaryPath, { force: true });
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        contractVersion: report.contractVersion,
        coverage: report.coverage,
        integrityGate: report.gate.integrityGate,
        historicalPromotionQualityGate:
          report.gate.historicalPromotionQualityGate,
        classification: report.gate.classification,
        automationPromotionGate: report.gate.automationPromotionGate,
        crossArtifact: {
          valid: report.crossArtifact.valid,
          failures: report.crossArtifact.failures,
          parsedAuthorityArtifact: report.crossArtifact.parsedAuthorityArtifact,
        },
        legacyTargetCorroboration: report.legacyTargetCorroboration,
        outputs: args.writeFiles
          ? { json: args.jsonOut, markdown: args.mdOut }
          : null,
      },
      null,
      2,
    )}\n`,
  );
  if (!report.gate.integrityGate.passed) process.exitCode = 1;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
