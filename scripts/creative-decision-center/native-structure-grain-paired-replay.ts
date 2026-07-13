#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  H7_STRUCTURE_MATURITY_GRID,
  H9_ANNUAL_SEASONALITY_ELIMINATION,
  H9_STRUCTURE_HISTORY_GRID,
  H9_STRUCTURE_HISTORY_LOOKBACK_DAYS,
  STRUCTURE_OUTCOME_WINDOWS,
  STRUCTURE_REPLAY_CADENCE_ANCHOR,
  STRUCTURE_REPLAY_CONTRACT_VERSION,
  addStructureReplayDays,
  buildStructureReplayProtocol,
  buildStructureVariantGrid,
  calculateStructureWeightedMetrics,
  classifyStructureDurabilityOutcome,
  compareStructureVariantScores,
  differenceInStructureReplayDays,
  evaluateStructureCandidate,
  hashFixedStructureCohort,
  normalizeMetaBudgetMinorUnits,
  normalizeStructureBidRegime,
  normalizeStructureGoalKey,
  projectStructureOpportunityWindow,
  resolveStructureBudgetOwner,
  scoreStructureVariant,
  structureHistorySignalKey,
  structurePeerCohortKey,
  structureQuantile,
  type StructureCohort,
  type StructureGrain,
  type StructureOpportunity,
  type StructureOutcomeWindowDays,
  type StructureReplayPhase,
  type StructureVariant,
  type StructureVariantScore,
} from "@/lib/creative-decision-engine/simulation/structure-replay";
import { resolveBusinessTargetPackFreshness } from "@/lib/business-commercial";
import { resolveMetaFunnelCohort } from "@/lib/meta/funnel-cohort";

const DEFAULT_START_DATE = "2025-12-01";
const DEFAULT_DECISION_END_DATE = "2026-07-05";
const DEFAULT_OUTCOME_CEILING = "2026-07-11";
const DEFAULT_JSON_OUT =
  "docs/creative-decision-center/generated/native-structure-grain-paired-replay-2025-12-01-to-2026-07-05.json";
const DEFAULT_MD_OUT =
  "docs/creative-decision-center/NATIVE_STRUCTURE_GRAIN_PAIRED_REPLAY_2025-12-01_TO_2026-07-05.md";
const OPPORTUNITY_CADENCE_DAYS = 7;
const MIN_SELECTION_BINARY_CANDIDATES = 10;

type DbRow = Record<string, unknown>;

interface ParsedArgs {
  startDate: string;
  decisionEndDate: string;
  outcomeCeiling: string;
  businesses: string[];
  jsonOut: string;
  mdOut: string;
  writeFiles: boolean;
}

interface BusinessIdentity {
  id: string;
  name: string;
}

interface StructureDailyFact {
  grain: StructureGrain;
  businessId: string;
  accountId: string;
  entityId: string;
  campaignId: string;
  adsetId: string | null;
  date: string;
  currency: string;
  spend: number;
  purchases: number;
  revenue: number;
  sourceSnapshotId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface OpportunityConfigRow {
  grain: StructureGrain;
  businessId: string;
  accountId: string;
  entityId: string;
  campaignId: string;
  adsetId: string | null;
  asOfDate: string;
  cutoff: string;
  outcomeCutoff: string;
  timezone: string;
  currency: string;
  asOfSpend: number;
  statusObserved: string | null;
  sourceSnapshotId: string | null;
  sourceUpdatedAt: string | null;
  sourceUpdatedAfterCutoff: boolean;
  campaignConfigId: string | null;
  campaignConfigCapturedAt: string | null;
  campaignConfigLocalDate: string | null;
  campaignConfigSourceKind: string | null;
  campaignObjective: string | null;
  campaignOptimizationGoal: string | null;
  campaignCustomEventType: string | null;
  campaignDailyBudget: number | null;
  campaignLifetimeBudget: number | null;
  campaignBudgetMixed: boolean;
  campaignConfigMixed: boolean;
  campaignGoalMixed: boolean;
  campaignBidStrategy: string | null;
  campaignBidValue: number | null;
  campaignBidValueFormat: string | null;
  campaignBidMixed: boolean;
  adsetConfigId: string | null;
  adsetConfigCapturedAt: string | null;
  adsetConfigLocalDate: string | null;
  adsetConfigSourceKind: string | null;
  adsetOptimizationGoal: string | null;
  adsetCustomEventType: string | null;
  adsetDailyBudget: number | null;
  adsetLifetimeBudget: number | null;
  adsetBudgetMixed: boolean;
  adsetConfigMixed: boolean;
  adsetGoalMixed: boolean;
  adsetBidStrategy: string | null;
  adsetBidValue: number | null;
  adsetBidValueFormat: string | null;
  adsetBidMixed: boolean;
  targetHistoryId: string | null;
  targetSource: string | null;
  targetOperation: string | null;
  targetEffectiveAt: string | null;
  targetRecordedAt: string | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  breakEvenCpa: number | null;
  outcomeCampaignDailyBudget: number | null;
  outcomeAdsetDailyBudget: number | null;
}

interface DerivedStructureOpportunity extends StructureOpportunity {
  businessName: string;
  campaignId: string;
  adsetId: string | null;
  cutoff: string;
  configIds: string[];
  configSourceKinds: string[];
  configRegimeStartDate: string | null;
  inferredBudgetAmount: number | null;
  outcomeBudgetAmount: number | null;
  budgetOwnerReason: string;
  targetSource: string | null;
  statusObserved: string | null;
  sourceSnapshotId: string | null;
  sourceUpdatedAfterCutoff: boolean;
  futureSpend: number;
  futurePurchases: number;
  futureRoas: number | null;
  outcomeWindows: Record<
    StructureOutcomeWindowDays,
    {
      windowDays: StructureOutcomeWindowDays;
      completeReceipt: boolean;
      status: "supported" | "refuted" | "neutral" | "unknown" | "censored";
      criticalRefutation: boolean;
      futureSpend: number;
      futureConversions: number;
      futureRevenue: number;
      futureRoas: number | null;
      futureCostPerResult: number | null;
    }
  >;
}

interface AggregateMetrics {
  spend: number;
  purchases: number;
  revenue: number;
  roas: number | null;
}

interface ReplayLoadResult {
  businesses: BusinessIdentity[];
  dailyFacts: StructureDailyFact[];
  opportunityRows: OpportunityConfigRow[];
  completeAccountDays: Set<string>;
  sourceCounts: {
    dailyFacts: number;
    campaignOpportunityRows: number;
    adsetOpportunityRows: number;
    accountReceiptRows: number;
  };
}

interface VariantResult {
  variant: StructureVariant;
  development: StructureVariantScore;
  calibration: StructureVariantScore;
  lockedTest: StructureVariantScore;
  full: StructureVariantScore;
}

function stringOrNull(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOrZero(value: unknown) {
  return numberOrNull(value) ?? 0;
}

function booleanValue(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function isoTimestamp(value: unknown) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function dateString(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`Expected PostgreSQL DATE text, received ${normalized}`);
  }
  return normalized;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    startDate: DEFAULT_START_DATE,
    decisionEndDate: DEFAULT_DECISION_END_DATE,
    outcomeCeiling: DEFAULT_OUTCOME_CEILING,
    businesses: [],
    jsonOut: DEFAULT_JSON_OUT,
    mdOut: DEFAULT_MD_OUT,
    writeFiles: true,
  };
  for (const token of argv) {
    if (token.startsWith("--start=")) args.startDate = token.slice(8);
    else if (token.startsWith("--decisionEnd=")) {
      args.decisionEndDate = token.slice(14);
    } else if (token.startsWith("--outcomeCeiling=")) {
      args.outcomeCeiling = token.slice(17);
    } else if (token.startsWith("--business=")) {
      args.businesses.push(token.slice(11));
    } else if (token.startsWith("--jsonOut=")) args.jsonOut = token.slice(10);
    else if (token.startsWith("--mdOut=")) args.mdOut = token.slice(8);
    else if (token === "--no-write") args.writeFiles = false;
    else throw new Error(`Unknown argument: ${token}`);
  }
  buildStructureReplayProtocol({
    startDate: args.startDate,
    endDate: args.decisionEndDate,
    cadenceDays: OPPORTUNITY_CADENCE_DAYS,
    anchorDate: STRUCTURE_REPLAY_CADENCE_ANCHOR,
  });
  if (
    differenceInStructureReplayDays(args.outcomeCeiling, args.decisionEndDate) <
    Math.min(...STRUCTURE_OUTCOME_WINDOWS)
  ) {
    throw new Error(
      `outcomeCeiling must close at least the ${Math.min(...STRUCTURE_OUTCOME_WINDOWS)}-day outcome window after decisionEnd`,
    );
  }
  return args;
}

function assertTunnelDatabase(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(url.hostname) ||
    url.port !== "15432"
  ) {
    throw new Error(
      "Structure replay requires the read-only SSH tunnel at 127.0.0.1:15432",
    );
  }
}

function factKey(input: {
  grain: StructureGrain;
  businessId: string;
  accountId: string;
  entityId: string;
}) {
  return `${input.grain}|${input.businessId}|${input.accountId}|${input.entityId}`;
}

function accountDayKey(businessId: string, accountId: string, date: string) {
  return `${businessId}|${accountId}|${date}`;
}

function aggregateFacts(
  facts: readonly StructureDailyFact[],
  startDate: string,
  endDate: string,
): AggregateMetrics {
  let spend = 0;
  let purchases = 0;
  let revenue = 0;
  for (const fact of facts) {
    if (fact.date < startDate || fact.date > endDate) continue;
    spend += Math.max(0, fact.spend);
    purchases += Math.max(0, fact.purchases);
    revenue += Math.max(0, fact.revenue);
  }
  return {
    spend,
    purchases,
    revenue,
    roas: spend > 0 ? revenue / spend : null,
  };
}

function completeOutcomeReceipt(input: {
  completeAccountDays: Set<string>;
  businessId: string;
  accountId: string;
  asOfDate: string;
  outcomeCeiling: string;
  windowDays: StructureOutcomeWindowDays;
}) {
  for (let offset = 1; offset <= input.windowDays; offset += 1) {
    const date = addStructureReplayDays(input.asOfDate, offset);
    if (date > input.outcomeCeiling) return false;
    if (
      !input.completeAccountDays.has(
        accountDayKey(input.businessId, input.accountId, date),
      )
    ) {
      return false;
    }
  }
  return true;
}

function mapDailyFact(row: DbRow): StructureDailyFact {
  const grain = String(row.grain) as StructureGrain;
  if (grain !== "campaign" && grain !== "adset") {
    throw new Error(`Unexpected structure grain ${grain}`);
  }
  return {
    grain,
    businessId: String(row.business_id),
    accountId: String(row.provider_account_id),
    entityId: String(row.entity_id),
    campaignId: String(row.campaign_id),
    adsetId: stringOrNull(row.adset_id),
    date: dateString(row.date),
    currency: String(row.account_currency).trim().toUpperCase(),
    spend: numberOrZero(row.spend),
    purchases: numberOrZero(row.conversions),
    revenue: numberOrZero(row.revenue),
    sourceSnapshotId: stringOrNull(row.source_snapshot_id),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
  };
}

function mapOpportunityConfig(row: DbRow): OpportunityConfigRow {
  const grain = String(row.grain) as StructureGrain;
  return {
    grain,
    businessId: String(row.business_id),
    accountId: String(row.provider_account_id),
    entityId: String(row.entity_id),
    campaignId: String(row.campaign_id),
    adsetId: stringOrNull(row.adset_id),
    asOfDate: dateString(row.as_of_date),
    cutoff: isoTimestamp(row.cutoff) ?? "",
    outcomeCutoff: isoTimestamp(row.outcome_cutoff) ?? "",
    timezone: String(row.account_timezone),
    currency: String(row.account_currency).trim().toUpperCase(),
    asOfSpend: numberOrZero(row.as_of_spend),
    statusObserved: stringOrNull(row.status_observed),
    sourceSnapshotId: stringOrNull(row.source_snapshot_id),
    sourceUpdatedAt: isoTimestamp(row.source_updated_at),
    sourceUpdatedAfterCutoff: booleanValue(row.source_updated_after_cutoff),
    campaignConfigId: stringOrNull(row.campaign_config_id),
    campaignConfigCapturedAt: isoTimestamp(row.campaign_config_captured_at),
    campaignConfigLocalDate: stringOrNull(row.campaign_config_local_date),
    campaignConfigSourceKind: stringOrNull(row.campaign_config_source_kind),
    campaignObjective: stringOrNull(row.campaign_objective),
    campaignOptimizationGoal: stringOrNull(row.campaign_optimization_goal),
    campaignCustomEventType: stringOrNull(row.campaign_custom_event_type),
    campaignDailyBudget: numberOrNull(row.campaign_daily_budget),
    campaignLifetimeBudget: numberOrNull(row.campaign_lifetime_budget),
    campaignBudgetMixed: booleanValue(row.campaign_budget_mixed),
    campaignConfigMixed: booleanValue(row.campaign_config_mixed),
    campaignGoalMixed: booleanValue(row.campaign_goal_mixed),
    campaignBidStrategy: stringOrNull(row.campaign_bid_strategy),
    campaignBidValue: numberOrNull(row.campaign_bid_value),
    campaignBidValueFormat: stringOrNull(row.campaign_bid_value_format),
    campaignBidMixed: booleanValue(row.campaign_bid_mixed),
    adsetConfigId: stringOrNull(row.adset_config_id),
    adsetConfigCapturedAt: isoTimestamp(row.adset_config_captured_at),
    adsetConfigLocalDate: stringOrNull(row.adset_config_local_date),
    adsetConfigSourceKind: stringOrNull(row.adset_config_source_kind),
    adsetOptimizationGoal: stringOrNull(row.adset_optimization_goal),
    adsetCustomEventType: stringOrNull(row.adset_custom_event_type),
    adsetDailyBudget: numberOrNull(row.adset_daily_budget),
    adsetLifetimeBudget: numberOrNull(row.adset_lifetime_budget),
    adsetBudgetMixed: booleanValue(row.adset_budget_mixed),
    adsetConfigMixed: booleanValue(row.adset_config_mixed),
    adsetGoalMixed: booleanValue(row.adset_goal_mixed),
    adsetBidStrategy: stringOrNull(row.adset_bid_strategy),
    adsetBidValue: numberOrNull(row.adset_bid_value),
    adsetBidValueFormat: stringOrNull(row.adset_bid_value_format),
    adsetBidMixed: booleanValue(row.adset_bid_mixed),
    targetHistoryId: stringOrNull(row.target_history_id),
    targetSource: stringOrNull(row.target_source),
    targetOperation: stringOrNull(row.target_operation),
    targetEffectiveAt: isoTimestamp(row.target_effective_at),
    targetRecordedAt: isoTimestamp(row.target_recorded_at),
    targetRoas: numberOrNull(row.target_roas),
    breakEvenRoas: numberOrNull(row.break_even_roas),
    targetCpa: numberOrNull(row.target_cpa),
    breakEvenCpa: numberOrNull(row.break_even_cpa),
    outcomeCampaignDailyBudget: numberOrNull(row.outcome_campaign_daily_budget),
    outcomeAdsetDailyBudget: numberOrNull(row.outcome_adset_daily_budget),
  };
}

async function loadReplayData(
  args: ParsedArgs,
  opportunityDates: string[],
): Promise<ReplayLoadResult> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  assertTunnelDatabase(databaseUrl);
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "adsecute-native-structure-replay-readonly",
  });
  await client.connect();
  await client.query(
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  try {
    const readOnly = await client.query<{ transaction_read_only: string }>(
      "SHOW transaction_read_only",
    );
    if (readOnly.rows[0]?.transaction_read_only !== "on") {
      throw new Error("Structure replay transaction is not read-only");
    }
    await client.query("SET LOCAL statement_timeout = '120s'");
    const businessFilter = args.businesses.length > 0 ? args.businesses : null;
    const businessResult = await client.query<DbRow>(
      `
      SELECT id::text AS id, name
      FROM businesses
      WHERE COALESCE(is_demo_business, FALSE) = FALSE
        AND ($1::text[] IS NULL OR id::text = ANY($1::text[]) OR name = ANY($1::text[]))
        AND (
          EXISTS (
            SELECT 1 FROM meta_campaign_daily d
            WHERE d.business_id = businesses.id::text
              AND d.date BETWEEN $2::date AND $3::date
              AND d.spend > 0
          )
          OR EXISTS (
            SELECT 1 FROM meta_adset_daily d
            WHERE d.business_id = businesses.id::text
              AND d.date BETWEEN $2::date AND $3::date
              AND d.spend > 0
          )
        )
      ORDER BY name
      `,
      [businessFilter, args.startDate, args.outcomeCeiling],
    );
    const businesses = businessResult.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
    }));
    if (businesses.length === 0) throw new Error("No businesses matched scope");
    const businessIds = businesses.map((business) => business.id);
    const historyStart = addStructureReplayDays(
      args.startDate,
      -H9_STRUCTURE_HISTORY_LOOKBACK_DAYS,
    );

    const factResult = await client.query<DbRow>(
      `
      SELECT
        'campaign'::text AS grain,
        business_id,
        provider_account_id,
        campaign_id AS entity_id,
        campaign_id,
        NULL::text AS adset_id,
        date::text AS date,
        account_currency,
        spend,
        conversions,
        revenue,
        source_snapshot_id::text,
        created_at,
        updated_at
      FROM meta_campaign_daily
      WHERE business_id = ANY($1::text[])
        AND date BETWEEN $2::date AND $3::date
        AND truth_state = 'finalized'
        AND validation_status = 'passed'
        AND spend > 0
      UNION ALL
      SELECT
        'adset'::text,
        business_id,
        provider_account_id,
        adset_id,
        campaign_id,
        adset_id,
        date::text,
        account_currency,
        spend,
        conversions,
        revenue,
        source_snapshot_id::text,
        created_at,
        updated_at
      FROM meta_adset_daily
      WHERE business_id = ANY($1::text[])
        AND date BETWEEN $2::date AND $3::date
        AND truth_state = 'finalized'
        AND validation_status = 'passed'
        AND spend > 0
        AND campaign_id IS NOT NULL
      ORDER BY grain, business_id, provider_account_id, entity_id, date
      `,
      [businessIds, historyStart, args.outcomeCeiling],
    );

    const accountReceiptResult = await client.query<DbRow>(
      `
      SELECT business_id, provider_account_id, date::text AS date
      FROM meta_account_daily
      WHERE business_id = ANY($1::text[])
        AND date BETWEEN $2::date AND $3::date
        AND truth_state = 'finalized'
        AND validation_status = 'passed'
      `,
      [
        businessIds,
        addStructureReplayDays(args.startDate, 1),
        args.outcomeCeiling,
      ],
    );

    const campaignOpportunityResult = await client.query<DbRow>(
      `
      WITH opportunity AS (
        SELECT
          d.*,
          ((d.date + 1)::timestamp AT TIME ZONE d.account_timezone) AS cutoff,
          (LEAST(d.date + 15, $3::date + 1)::timestamp AT TIME ZONE d.account_timezone) AS outcome_cutoff
        FROM meta_campaign_daily d
        WHERE d.business_id = ANY($1::text[])
          AND d.date = ANY($2::date[])
          AND d.truth_state = 'finalized'
          AND d.validation_status = 'passed'
          AND d.spend > 0
      )
      SELECT
        'campaign'::text AS grain,
        o.business_id,
        o.provider_account_id,
        o.campaign_id AS entity_id,
        o.campaign_id,
        NULL::text AS adset_id,
        o.date::text AS as_of_date,
        o.cutoff,
        o.outcome_cutoff,
        o.account_timezone,
        o.account_currency,
        o.spend AS as_of_spend,
        o.campaign_status AS status_observed,
        o.source_snapshot_id::text,
        o.updated_at AS source_updated_at,
        o.updated_at > o.cutoff AS source_updated_after_cutoff,
        cfg.id::text AS campaign_config_id,
        cfg.captured_at AS campaign_config_captured_at,
        (cfg.captured_at AT TIME ZONE o.account_timezone)::date::text AS campaign_config_local_date,
        cfg.source_kind AS campaign_config_source_kind,
        cfg.objective AS campaign_objective,
        cfg.optimization_goal AS campaign_optimization_goal,
        cfg.custom_event_type AS campaign_custom_event_type,
        cfg.daily_budget AS campaign_daily_budget,
        cfg.lifetime_budget AS campaign_lifetime_budget,
        cfg.is_budget_mixed AS campaign_budget_mixed,
        cfg.is_config_mixed AS campaign_config_mixed,
        (cfg.is_optimization_goal_mixed OR cfg.is_custom_event_type_mixed) AS campaign_goal_mixed,
        cfg.bid_strategy_type AS campaign_bid_strategy,
        cfg.bid_value AS campaign_bid_value,
        cfg.bid_value_format AS campaign_bid_value_format,
        (cfg.is_bid_strategy_mixed OR cfg.is_bid_value_mixed) AS campaign_bid_mixed,
        NULL::text AS adset_config_id,
        NULL::timestamptz AS adset_config_captured_at,
        NULL::text AS adset_config_local_date,
        NULL::text AS adset_config_source_kind,
        NULL::text AS adset_optimization_goal,
        NULL::text AS adset_custom_event_type,
        NULL::double precision AS adset_daily_budget,
        NULL::double precision AS adset_lifetime_budget,
        FALSE AS adset_budget_mixed,
        FALSE AS adset_config_mixed,
        FALSE AS adset_goal_mixed,
        NULL::text AS adset_bid_strategy,
        NULL::double precision AS adset_bid_value,
        NULL::text AS adset_bid_value_format,
        FALSE AS adset_bid_mixed,
        COALESCE(target_history.id::text, current_target.id::text) AS target_history_id,
        CASE
          WHEN target_history.id IS NOT NULL THEN 'business_target_pack_history'
          WHEN current_target.id IS NOT NULL THEN 'business_target_packs_cutoff_safe_scd0'
          ELSE NULL
        END AS target_source,
        COALESCE(target_history.operation, CASE WHEN current_target.id IS NOT NULL THEN 'upsert' END) AS target_operation,
        COALESCE(target_history.effective_at, current_target.updated_at) AS target_effective_at,
        COALESCE(target_history.recorded_at, current_target.updated_at) AS target_recorded_at,
        COALESCE(target_history.target_roas, current_target.target_roas) AS target_roas,
        COALESCE(target_history.break_even_roas, current_target.break_even_roas) AS break_even_roas,
        COALESCE(target_history.target_cpa, current_target.target_cpa) AS target_cpa,
        COALESCE(target_history.break_even_cpa, current_target.break_even_cpa) AS break_even_cpa,
        outcome_cfg.daily_budget AS outcome_campaign_daily_budget,
        NULL::double precision AS outcome_adset_daily_budget
      FROM opportunity o
      LEFT JOIN LATERAL (
        SELECT c.*
        FROM meta_campaign_config_history c
        WHERE c.business_id = o.business_id
          AND c.provider_account_id = o.provider_account_id
          AND c.campaign_id = o.campaign_id
          AND c.captured_at <= o.cutoff
        ORDER BY c.captured_at DESC, c.id DESC
        LIMIT 1
      ) cfg ON TRUE
      LEFT JOIN LATERAL (
        SELECT t.*
        FROM business_target_pack_history t
        WHERE t.business_id::text = o.business_id
          AND t.effective_at <= o.cutoff
          AND t.recorded_at <= o.cutoff
        ORDER BY t.effective_at DESC, t.recorded_at DESC, t.id DESC
        LIMIT 1
      ) target_history ON TRUE
      LEFT JOIN LATERAL (
        SELECT p.*
        FROM business_target_packs p
        WHERE p.business_id::text = o.business_id
          AND p.updated_at <= o.cutoff
          AND target_history.id IS NULL
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT 1
      ) current_target ON TRUE
      LEFT JOIN LATERAL (
        SELECT c.daily_budget
        FROM meta_campaign_config_history c
        WHERE c.business_id = o.business_id
          AND c.provider_account_id = o.provider_account_id
          AND c.campaign_id = o.campaign_id
          AND c.captured_at <= o.outcome_cutoff
        ORDER BY c.captured_at DESC, c.id DESC
        LIMIT 1
      ) outcome_cfg ON TRUE
      ORDER BY o.business_id, o.provider_account_id, o.campaign_id, o.date
      `,
      [businessIds, opportunityDates, args.outcomeCeiling],
    );

    const adsetOpportunityResult = await client.query<DbRow>(
      `
      WITH opportunity AS (
        SELECT
          d.*,
          ((d.date + 1)::timestamp AT TIME ZONE d.account_timezone) AS cutoff,
          (LEAST(d.date + 15, $3::date + 1)::timestamp AT TIME ZONE d.account_timezone) AS outcome_cutoff
        FROM meta_adset_daily d
        WHERE d.business_id = ANY($1::text[])
          AND d.date = ANY($2::date[])
          AND d.truth_state = 'finalized'
          AND d.validation_status = 'passed'
          AND d.spend > 0
          AND d.campaign_id IS NOT NULL
      )
      SELECT
        'adset'::text AS grain,
        o.business_id,
        o.provider_account_id,
        o.adset_id AS entity_id,
        o.campaign_id,
        o.adset_id,
        o.date::text AS as_of_date,
        o.cutoff,
        o.outcome_cutoff,
        o.account_timezone,
        o.account_currency,
        o.spend AS as_of_spend,
        o.adset_status AS status_observed,
        o.source_snapshot_id::text,
        o.updated_at AS source_updated_at,
        o.updated_at > o.cutoff AS source_updated_after_cutoff,
        campaign_cfg.id::text AS campaign_config_id,
        campaign_cfg.captured_at AS campaign_config_captured_at,
        (campaign_cfg.captured_at AT TIME ZONE o.account_timezone)::date::text AS campaign_config_local_date,
        campaign_cfg.source_kind AS campaign_config_source_kind,
        campaign_cfg.objective AS campaign_objective,
        campaign_cfg.optimization_goal AS campaign_optimization_goal,
        campaign_cfg.custom_event_type AS campaign_custom_event_type,
        campaign_cfg.daily_budget AS campaign_daily_budget,
        campaign_cfg.lifetime_budget AS campaign_lifetime_budget,
        campaign_cfg.is_budget_mixed AS campaign_budget_mixed,
        campaign_cfg.is_config_mixed AS campaign_config_mixed,
        (campaign_cfg.is_optimization_goal_mixed OR campaign_cfg.is_custom_event_type_mixed) AS campaign_goal_mixed,
        campaign_cfg.bid_strategy_type AS campaign_bid_strategy,
        campaign_cfg.bid_value AS campaign_bid_value,
        campaign_cfg.bid_value_format AS campaign_bid_value_format,
        (campaign_cfg.is_bid_strategy_mixed OR campaign_cfg.is_bid_value_mixed) AS campaign_bid_mixed,
        adset_cfg.id::text AS adset_config_id,
        adset_cfg.captured_at AS adset_config_captured_at,
        (adset_cfg.captured_at AT TIME ZONE o.account_timezone)::date::text AS adset_config_local_date,
        adset_cfg.source_kind AS adset_config_source_kind,
        adset_cfg.optimization_goal AS adset_optimization_goal,
        adset_cfg.custom_event_type AS adset_custom_event_type,
        adset_cfg.daily_budget AS adset_daily_budget,
        adset_cfg.lifetime_budget AS adset_lifetime_budget,
        adset_cfg.is_budget_mixed AS adset_budget_mixed,
        adset_cfg.is_config_mixed AS adset_config_mixed,
        adset_cfg.is_optimization_goal_mixed AS adset_goal_mixed,
        adset_cfg.bid_strategy_type AS adset_bid_strategy,
        adset_cfg.bid_value AS adset_bid_value,
        adset_cfg.bid_value_format AS adset_bid_value_format,
        (adset_cfg.is_bid_strategy_mixed OR adset_cfg.is_bid_value_mixed) AS adset_bid_mixed,
        COALESCE(target_history.id::text, current_target.id::text) AS target_history_id,
        CASE
          WHEN target_history.id IS NOT NULL THEN 'business_target_pack_history'
          WHEN current_target.id IS NOT NULL THEN 'business_target_packs_cutoff_safe_scd0'
          ELSE NULL
        END AS target_source,
        COALESCE(target_history.operation, CASE WHEN current_target.id IS NOT NULL THEN 'upsert' END) AS target_operation,
        COALESCE(target_history.effective_at, current_target.updated_at) AS target_effective_at,
        COALESCE(target_history.recorded_at, current_target.updated_at) AS target_recorded_at,
        COALESCE(target_history.target_roas, current_target.target_roas) AS target_roas,
        COALESCE(target_history.break_even_roas, current_target.break_even_roas) AS break_even_roas,
        COALESCE(target_history.target_cpa, current_target.target_cpa) AS target_cpa,
        COALESCE(target_history.break_even_cpa, current_target.break_even_cpa) AS break_even_cpa,
        outcome_campaign_cfg.daily_budget AS outcome_campaign_daily_budget,
        outcome_adset_cfg.daily_budget AS outcome_adset_daily_budget
      FROM opportunity o
      LEFT JOIN LATERAL (
        SELECT c.*
        FROM meta_campaign_config_history c
        WHERE c.business_id = o.business_id
          AND c.provider_account_id = o.provider_account_id
          AND c.campaign_id = o.campaign_id
          AND c.captured_at <= o.cutoff
        ORDER BY c.captured_at DESC, c.id DESC
        LIMIT 1
      ) campaign_cfg ON TRUE
      LEFT JOIN LATERAL (
        SELECT c.*
        FROM meta_adset_config_history c
        WHERE c.business_id = o.business_id
          AND c.provider_account_id = o.provider_account_id
          AND c.adset_id = o.adset_id
          AND c.captured_at <= o.cutoff
        ORDER BY c.captured_at DESC, c.id DESC
        LIMIT 1
      ) adset_cfg ON TRUE
      LEFT JOIN LATERAL (
        SELECT t.*
        FROM business_target_pack_history t
        WHERE t.business_id::text = o.business_id
          AND t.effective_at <= o.cutoff
          AND t.recorded_at <= o.cutoff
        ORDER BY t.effective_at DESC, t.recorded_at DESC, t.id DESC
        LIMIT 1
      ) target_history ON TRUE
      LEFT JOIN LATERAL (
        SELECT p.*
        FROM business_target_packs p
        WHERE p.business_id::text = o.business_id
          AND p.updated_at <= o.cutoff
          AND target_history.id IS NULL
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT 1
      ) current_target ON TRUE
      LEFT JOIN LATERAL (
        SELECT c.daily_budget
        FROM meta_campaign_config_history c
        WHERE c.business_id = o.business_id
          AND c.provider_account_id = o.provider_account_id
          AND c.campaign_id = o.campaign_id
          AND c.captured_at <= o.outcome_cutoff
        ORDER BY c.captured_at DESC, c.id DESC
        LIMIT 1
      ) outcome_campaign_cfg ON TRUE
      LEFT JOIN LATERAL (
        SELECT c.daily_budget
        FROM meta_adset_config_history c
        WHERE c.business_id = o.business_id
          AND c.provider_account_id = o.provider_account_id
          AND c.adset_id = o.adset_id
          AND c.captured_at <= o.outcome_cutoff
        ORDER BY c.captured_at DESC, c.id DESC
        LIMIT 1
      ) outcome_adset_cfg ON TRUE
      ORDER BY o.business_id, o.provider_account_id, o.adset_id, o.date
      `,
      [businessIds, opportunityDates, args.outcomeCeiling],
    );

    await client.query("ROLLBACK");
    const completeAccountDays = new Set(
      accountReceiptResult.rows.map((row) =>
        accountDayKey(
          String(row.business_id),
          String(row.provider_account_id),
          dateString(row.date),
        ),
      ),
    );
    return {
      businesses,
      dailyFacts: factResult.rows.map(mapDailyFact),
      opportunityRows: [
        ...campaignOpportunityResult.rows,
        ...adsetOpportunityResult.rows,
      ].map(mapOpportunityConfig),
      completeAccountDays,
      sourceCounts: {
        dailyFacts: factResult.rowCount ?? factResult.rows.length,
        campaignOpportunityRows:
          campaignOpportunityResult.rowCount ??
          campaignOpportunityResult.rows.length,
        adsetOpportunityRows:
          adsetOpportunityResult.rowCount ?? adsetOpportunityResult.rows.length,
        accountReceiptRows:
          accountReceiptResult.rowCount ?? accountReceiptResult.rows.length,
      },
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original read failure is more useful than rollback noise.
    }
    throw error;
  } finally {
    await client.end();
  }
}

function laterDate(left: string | null, right: string | null) {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function deriveOpportunities(input: {
  load: ReplayLoadResult;
  outcomeCeiling: string;
}) {
  const businessNames = new Map(
    input.load.businesses.map((business) => [business.id, business.name]),
  );
  const factsByEntity = new Map<string, StructureDailyFact[]>();
  for (const fact of input.load.dailyFacts) {
    const key = factKey(fact);
    const rows = factsByEntity.get(key) ?? [];
    rows.push(fact);
    factsByEntity.set(key, rows);
  }

  const opportunities: DerivedStructureOpportunity[] = [];
  for (const row of input.load.opportunityRows) {
    const campaignConfigAvailable = row.campaignConfigId !== null;
    const adsetConfigAvailable = row.adsetConfigId !== null;
    const owner = resolveStructureBudgetOwner({
      campaignConfigAvailable,
      campaignDailyBudget: row.campaignDailyBudget,
      campaignBudgetMixed: row.campaignBudgetMixed,
      adsetConfigAvailable,
      adsetDailyBudget: row.adsetDailyBudget,
    });
    const optimizationGoal =
      row.grain === "adset"
        ? (row.adsetOptimizationGoal ?? row.campaignOptimizationGoal)
        : row.campaignOptimizationGoal;
    const customEventType =
      row.grain === "adset"
        ? (row.adsetCustomEventType ?? row.campaignCustomEventType)
        : row.campaignCustomEventType;
    const goalKey = normalizeStructureGoalKey({
      customEventType,
      optimizationGoal,
      objective: row.campaignObjective,
    });
    const funnelCohort = resolveMetaFunnelCohort({
      customEventType,
      optimizationGoal,
      objective: row.campaignObjective,
    }) as StructureCohort;
    const bidStrategy =
      row.grain === "adset"
        ? (row.adsetBidStrategy ?? row.campaignBidStrategy)
        : row.campaignBidStrategy;
    const bidValue =
      row.grain === "adset"
        ? (row.adsetBidValue ?? row.campaignBidValue)
        : row.campaignBidValue;
    const bidValueFormat =
      row.grain === "adset"
        ? (row.adsetBidValueFormat ?? row.campaignBidValueFormat)
        : row.campaignBidValueFormat;
    const bidContext = normalizeStructureBidRegime({
      strategy: bidStrategy,
      value: bidValue,
      valueFormat: bidValueFormat,
      mixed:
        row.campaignBidMixed || (row.grain === "adset" && row.adsetBidMixed),
    });
    const configRegimeStartDate =
      row.grain === "adset"
        ? laterDate(row.campaignConfigLocalDate, row.adsetConfigLocalDate)
        : row.campaignConfigLocalDate;
    const configCutoffSafe =
      Boolean(row.cutoff) &&
      campaignConfigAvailable &&
      (row.grain === "campaign" || adsetConfigAvailable) &&
      !row.campaignConfigMixed &&
      !row.campaignGoalMixed &&
      (row.grain === "campaign" ||
        (!row.adsetConfigMixed &&
          !row.adsetGoalMixed &&
          !row.adsetBudgetMixed)) &&
      goalKey !== "unknown";
    const facts = factsByEntity.get(factKey(row)) ?? [];
    const firstFactDate = facts[0]?.date ?? row.asOfDate;
    const regimeStart = configRegimeStartDate ?? row.asOfDate;
    const cumulative = aggregateFacts(facts, regimeStart, row.asOfDate);
    const targetCutoffSafe =
      row.targetHistoryId !== null &&
      row.targetOperation === "upsert" &&
      row.targetEffectiveAt !== null &&
      row.targetRecordedAt !== null &&
      row.targetEffectiveAt <= row.cutoff &&
      row.targetRecordedAt <= row.cutoff;
    const targetFresh =
      targetCutoffSafe &&
      resolveBusinessTargetPackFreshness(
        row.targetEffectiveAt,
        new Date(row.cutoff),
      ) === "fresh";
    const cutoffTargetRoas =
      targetCutoffSafe && (row.targetRoas ?? 0) > 0 ? row.targetRoas : null;
    const cutoffBreakEvenRoas =
      targetCutoffSafe && (row.breakEvenRoas ?? 0) > 0
        ? row.breakEvenRoas
        : null;
    const coherentRoasEconomics =
      cutoffTargetRoas !== null &&
      cutoffBreakEvenRoas !== null &&
      cutoffTargetRoas >= cutoffBreakEvenRoas;
    const budgetMinorUnits =
      owner.owner === "campaign"
        ? row.campaignDailyBudget
        : owner.owner === "adset"
          ? row.adsetDailyBudget
          : null;
    const outcomeBudgetMinorUnits =
      owner.owner === "campaign"
        ? row.outcomeCampaignDailyBudget
        : owner.owner === "adset"
          ? row.outcomeAdsetDailyBudget
          : null;
    const budgetAmount = normalizeMetaBudgetMinorUnits(budgetMinorUnits);
    opportunities.push({
      grain: row.grain,
      entityId: row.entityId,
      businessId: row.businessId,
      businessName: businessNames.get(row.businessId) ?? row.businessId,
      accountId: row.accountId,
      campaignId: row.campaignId,
      adsetId: row.adsetId,
      currency: row.currency,
      goalKey,
      cohort: funnelCohort,
      bidRegime: bidContext.regime,
      bidValue,
      bidValueFormat,
      bidContextReconstructable: bidContext.reconstructable,
      asOfDate: row.asOfDate,
      cutoff: row.cutoff,
      ageDays:
        Math.max(
          0,
          differenceInStructureReplayDays(row.asOfDate, firstFactDate),
        ) + 1,
      cumulativePurchases: cumulative.purchases,
      cumulativeConversions: cumulative.purchases,
      budgetUtilization:
        budgetAmount !== null ? row.asOfSpend / budgetAmount : null,
      budgetOwner: owner.owner,
      budgetOrigin: owner.origin,
      budgetOwnerReconstructable: owner.reconstructable,
      statusReconstructable: false,
      configCutoffSafe,
      targetCutoffSafe,
      targetFresh,
      targetRoas: coherentRoasEconomics ? cutoffTargetRoas : null,
      breakEvenRoas: coherentRoasEconomics ? cutoffBreakEvenRoas : null,
      targetCpa:
        targetCutoffSafe && (row.targetCpa ?? 0) > 0 ? row.targetCpa : null,
      breakEvenCpa:
        targetCutoffSafe && (row.breakEvenCpa ?? 0) > 0
          ? row.breakEvenCpa
          : null,
      completeOutcomeReceipt: completeOutcomeReceipt({
        completeAccountDays: input.load.completeAccountDays,
        businessId: row.businessId,
        accountId: row.accountId,
        asOfDate: row.asOfDate,
        outcomeCeiling: input.outcomeCeiling,
        windowDays: 14,
      }),
      purchaseCohort: funnelCohort === "purchase",
      history: {},
      outcome: "unknown",
      criticalRefutation: false,
      outcomes: {},
      configIds: [row.campaignConfigId, row.adsetConfigId].filter(
        (value): value is string => value !== null,
      ),
      configSourceKinds: [
        row.campaignConfigSourceKind,
        row.adsetConfigSourceKind,
      ].filter((value): value is string => value !== null),
      configRegimeStartDate,
      inferredBudgetAmount: budgetAmount,
      outcomeBudgetAmount: normalizeMetaBudgetMinorUnits(
        outcomeBudgetMinorUnits,
      ),
      budgetOwnerReason: owner.reason,
      targetSource: row.targetSource,
      statusObserved: row.statusObserved,
      sourceSnapshotId: row.sourceSnapshotId,
      sourceUpdatedAfterCutoff: row.sourceUpdatedAfterCutoff,
      futureSpend: 0,
      futurePurchases: 0,
      futureRoas: null,
      outcomeWindows: {} as DerivedStructureOpportunity["outcomeWindows"],
    });
  }

  const opportunityIdentities = new Set<string>();
  for (const opportunity of opportunities) {
    const identity = `${factKey(opportunity)}|${opportunity.asOfDate}`;
    if (opportunityIdentities.has(identity)) {
      throw new Error(`Duplicate fixed opportunity identity: ${identity}`);
    }
    opportunityIdentities.add(identity);
  }

  const groups = new Map<string, DerivedStructureOpportunity[]>();
  for (const opportunity of opportunities) {
    const key = structurePeerCohortKey(opportunity);
    const rows = groups.get(key) ?? [];
    rows.push(opportunity);
    groups.set(key, rows);
  }

  for (const group of groups.values()) {
    const benchmarkPeers = group.filter(
      (opportunity) =>
        opportunity.cohort !== "unknown" &&
        opportunity.configCutoffSafe &&
        opportunity.bidContextReconstructable &&
        opportunity.budgetOwner === opportunity.grain,
    );
    for (const halfLifeDays of H9_STRUCTURE_HISTORY_GRID.halfLifeDays) {
      for (const seasonality of H9_STRUCTURE_HISTORY_GRID.seasonalityModes) {
        const historyKey = structureHistorySignalKey({
          halfLifeDays,
          seasonality,
        });
        const supportByEntity = new Map<string, boolean[]>();
        let currentWinnerOutcomeCountP50: number | null = null;
        for (
          let offset = 0;
          offset < Math.max(...H9_STRUCTURE_HISTORY_GRID.supportDays);
          offset += 1
        ) {
          const supportDate = addStructureReplayDays(
            group[0]!.asOfDate,
            -offset,
          );
          const metricsByEntity = new Map<
            string,
            ReturnType<typeof calculateStructureWeightedMetrics> | null
          >();
          for (const opportunity of benchmarkPeers) {
            const facts = factsByEntity.get(factKey(opportunity)) ?? [];
            const regimeStart = opportunity.configRegimeStartDate;
            metricsByEntity.set(
              opportunity.entityId,
              regimeStart && supportDate >= regimeStart
                ? calculateStructureWeightedMetrics({
                    facts: facts.map((fact) => ({
                      date: fact.date,
                      spend: fact.spend,
                      revenue: fact.revenue,
                      conversions: fact.purchases,
                    })),
                    startDate: regimeStart,
                    asOfDate: supportDate,
                    halfLifeDays,
                    seasonality,
                  })
                : null,
            );
          }
          const peerRoas = Array.from(metricsByEntity.values())
            .map((metrics) => metrics?.roas ?? null)
            .filter((value): value is number => value !== null);
          const peerCostPerResult = Array.from(metricsByEntity.values())
            .map((metrics) => metrics?.costPerResult ?? null)
            .filter((value): value is number => value !== null);
          const peerP75 =
            peerRoas.length >= 3 ? structureQuantile(peerRoas, 0.75) : null;
          const peerCostP25 =
            peerCostPerResult.length >= 3
              ? structureQuantile(peerCostPerResult, 0.25)
              : null;
          const purchaseCohort = group[0]!.purchaseCohort;
          const winnerIds = benchmarkPeers
            .filter((opportunity) => {
              const metrics = metricsByEntity.get(opportunity.entityId);
              return purchaseCohort
                ? peerP75 !== null &&
                    opportunity.targetFresh &&
                    opportunity.targetRoas !== null &&
                    metrics?.roas !== null &&
                    metrics?.roas !== undefined &&
                    metrics.roas >= Math.max(peerP75, opportunity.targetRoas)
                : peerCostP25 !== null &&
                    metrics?.costPerResult !== null &&
                    metrics?.costPerResult !== undefined &&
                    metrics.costPerResult <= peerCostP25;
            })
            .map((opportunity) => opportunity.entityId);
          if (
            offset === 0 &&
            (purchaseCohort ? peerP75 !== null : peerCostP25 !== null)
          ) {
            const winnerSet = new Set(winnerIds);
            currentWinnerOutcomeCountP50 = structureQuantile(
              benchmarkPeers
                .filter((opportunity) => winnerSet.has(opportunity.entityId))
                .map((opportunity) => opportunity.cumulativeConversions),
              0.5,
            );
          }
          for (const opportunity of group) {
            const support = supportByEntity.get(opportunity.entityId) ?? [];
            const metrics = metricsByEntity.get(opportunity.entityId) ?? null;
            support.push(
              opportunity.purchaseCohort
                ? peerP75 !== null &&
                    opportunity.targetFresh &&
                    opportunity.targetRoas !== null &&
                    metrics?.roas !== null &&
                    metrics?.roas !== undefined &&
                    metrics.roas >= Math.max(peerP75, opportunity.targetRoas)
                : peerCostP25 !== null &&
                    metrics?.costPerResult !== null &&
                    metrics?.costPerResult !== undefined &&
                    metrics.costPerResult <= peerCostP25,
            );
            supportByEntity.set(opportunity.entityId, support);
            if (offset === 0) {
              opportunity.history[historyKey] = {
                weightedRoas: metrics?.roas ?? null,
                weightedCostPerResult: metrics?.costPerResult ?? null,
                peerRoasP75: peerP75,
                peerCostPerResultP25: peerCostP25,
                peerWinnerPurchaseP50: opportunity.purchaseCohort
                  ? currentWinnerOutcomeCountP50
                  : null,
                peerWinnerOutcomeCountP50: currentWinnerOutcomeCountP50,
                consecutiveSupportDays: 0,
                peerCount: opportunity.purchaseCohort
                  ? peerRoas.length
                  : peerCostPerResult.length,
              };
            }
          }
        }
        for (const opportunity of group) {
          const support = supportByEntity.get(opportunity.entityId) ?? [];
          let consecutive = 0;
          for (const supported of support) {
            if (!supported) break;
            consecutive += 1;
          }
          const history = opportunity.history[historyKey];
          if (history) history.consecutiveSupportDays = consecutive;
        }
      }
    }

    const outcomeStart = addStructureReplayDays(group[0]!.asOfDate, 1);
    for (const windowDays of STRUCTURE_OUTCOME_WINDOWS) {
      const outcomeEnd = addStructureReplayDays(group[0]!.asOfDate, windowDays);
      const futureByEntity = new Map<string, AggregateMetrics>();
      for (const opportunity of group) {
        const facts = factsByEntity.get(factKey(opportunity)) ?? [];
        futureByEntity.set(
          opportunity.entityId,
          aggregateFacts(facts, outcomeStart, outcomeEnd),
        );
      }
      const delivering = benchmarkPeers
        .map((opportunity) => futureByEntity.get(opportunity.entityId)!)
        .filter((metrics) => metrics.spend > 0);
      const peerRoas = delivering
        .map((metrics) => metrics.roas)
        .filter((value): value is number => value !== null);
      const peerCostPerResult = delivering
        .filter((metrics) => metrics.purchases > 0)
        .map((metrics) => metrics.spend / metrics.purchases);
      const peerSpend = delivering.map((metrics) => metrics.spend);
      const peerRoasP25 =
        peerRoas.length >= 3 ? structureQuantile(peerRoas, 0.25) : null;
      const peerRoasP50 =
        peerRoas.length >= 3 ? structureQuantile(peerRoas, 0.5) : null;
      const peerRoasP75 =
        peerRoas.length >= 3 ? structureQuantile(peerRoas, 0.75) : null;
      const peerCostP25 =
        peerCostPerResult.length >= 3
          ? structureQuantile(peerCostPerResult, 0.25)
          : null;
      const peerCostP50 =
        peerCostPerResult.length >= 3
          ? structureQuantile(peerCostPerResult, 0.5)
          : null;
      const peerCostP75 =
        peerCostPerResult.length >= 3
          ? structureQuantile(peerCostPerResult, 0.75)
          : null;
      const peerSpendP50 =
        delivering.length >= 3 ? structureQuantile(peerSpend, 0.5) : null;
      for (const opportunity of group) {
        const future = futureByEntity.get(opportunity.entityId)!;
        const completeReceipt = completeOutcomeReceipt({
          completeAccountDays: input.load.completeAccountDays,
          businessId: opportunity.businessId,
          accountId: opportunity.accountId,
          asOfDate: opportunity.asOfDate,
          outcomeCeiling: input.outcomeCeiling,
          windowDays,
        });
        const futureCostPerResult =
          future.purchases > 0 ? future.spend / future.purchases : null;
        const outcome = classifyStructureDurabilityOutcome({
          completeReceipt,
          cohort: opportunity.cohort,
          futureSpend: future.spend,
          futurePurchases: future.purchases,
          futureConversions: future.purchases,
          futureRoas: future.roas,
          futureCostPerResult,
          targetRoas:
            opportunity.targetFresh && opportunity.targetCutoffSafe
              ? opportunity.targetRoas
              : null,
          breakEvenRoas:
            opportunity.targetFresh && opportunity.targetCutoffSafe
              ? opportunity.breakEvenRoas
              : null,
          peerCount: opportunity.purchaseCohort
            ? peerRoas.length
            : peerCostPerResult.length,
          peerRoasP25,
          peerRoasP50,
          peerRoasP75,
          peerCostPerResultP25: peerCostP25,
          peerCostPerResultP50: peerCostP50,
          peerCostPerResultP75: peerCostP75,
          peerSpendP50,
        });
        const windowOutcome = {
          windowDays,
          completeReceipt,
          status: outcome.status,
          criticalRefutation: outcome.criticalRefutation,
          futureSpend: future.spend,
          futureConversions: future.purchases,
          futureRevenue: future.revenue,
          futureRoas: future.roas,
          futureCostPerResult,
        };
        opportunity.outcomes[windowDays] = windowOutcome;
        opportunity.outcomeWindows[windowDays] = windowOutcome;
      }
    }
    for (const opportunity of group) {
      const canonical = opportunity.outcomeWindows[14];
      opportunity.completeOutcomeReceipt = canonical.completeReceipt;
      opportunity.outcome = canonical.status;
      opportunity.criticalRefutation = canonical.criticalRefutation;
      opportunity.futureSpend = canonical.futureSpend;
      opportunity.futurePurchases = canonical.futureConversions;
      opportunity.futureRoas = canonical.futureRoas;
    }
  }
  return opportunities;
}

function scoreVariants(input: {
  opportunities: readonly DerivedStructureOpportunity[];
  variants: readonly StructureVariant[];
  phaseDates: Record<StructureReplayPhase, readonly string[]>;
  grain: StructureGrain;
  windowDays: StructureOutcomeWindowDays;
  cohort: StructureCohort;
  currency: string;
}) {
  const eligibleDates = new Set([
    ...input.phaseDates.development,
    ...input.phaseDates.calibration,
    ...input.phaseDates.locked_test,
  ]);
  const grainRows = input.opportunities
    .filter(
      (opportunity) =>
        opportunity.grain === input.grain &&
        opportunity.cohort === input.cohort &&
        opportunity.currency === input.currency &&
        eligibleDates.has(opportunity.asOfDate),
    )
    .map((opportunity) =>
      projectStructureOpportunityWindow(opportunity, input.windowDays),
    );
  const developmentDates = new Set(input.phaseDates.development);
  const calibrationDates = new Set(input.phaseDates.calibration);
  const lockedTestDates = new Set(input.phaseDates.locked_test);
  const developmentRows = grainRows.filter((opportunity) =>
    developmentDates.has(opportunity.asOfDate),
  );
  const calibrationRows = grainRows.filter((opportunity) =>
    calibrationDates.has(opportunity.asOfDate),
  );
  const lockedTestRows = grainRows.filter((opportunity) =>
    lockedTestDates.has(opportunity.asOfDate),
  );
  const results: VariantResult[] = input.variants.map((variant) => ({
    variant,
    development: scoreStructureVariant(developmentRows, variant),
    calibration: scoreStructureVariant(calibrationRows, variant),
    lockedTest: scoreStructureVariant(lockedTestRows, variant),
    full: scoreStructureVariant(grainRows, variant),
  }));
  results.sort((left, right) =>
    compareStructureVariantScores(left.calibration, right.calibration),
  );
  const selected =
    results.find(
      (result) =>
        result.calibration.supportedCandidates +
          result.calibration.refutedCandidates >=
        MIN_SELECTION_BINARY_CANDIDATES,
    ) ?? results[0]!;
  return {
    results,
    selected,
    grainRows,
    phaseRows: {
      development: developmentRows,
      calibration: calibrationRows,
      locked_test: lockedTestRows,
    },
  };
}

function countBy<T>(rows: readonly T[], key: (row: T) => string) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = key(row);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function candidateDistribution(
  opportunities: readonly DerivedStructureOpportunity[],
  variant: StructureVariant,
) {
  const candidates = opportunities.filter(
    (opportunity) => evaluateStructureCandidate(opportunity, variant).candidate,
  );
  const byAccount = countBy(
    candidates,
    (opportunity) =>
      `${opportunity.businessName}|${opportunity.accountId}|${opportunity.currency}`,
  );
  const largestAccountCandidates = Math.max(0, ...Object.values(byAccount));
  const authorities = countBy(
    candidates,
    (opportunity) => evaluateStructureCandidate(opportunity, variant).authority,
  );
  return {
    candidateCount: candidates.length,
    activeAccountCount: Object.keys(byAccount).length,
    largestAccountShare:
      candidates.length > 0
        ? largestAccountCandidates / candidates.length
        : null,
    byAccount,
    authorities,
  };
}

function scorePassesThresholdGate(score: StructureVariantScore) {
  const known = score.supportedCandidates + score.refutedCandidates;
  return (
    known >= 100 &&
    (score.precision ?? 0) >= 0.92 &&
    (score.precisionWilsonLower95 ?? 0) >= 0.85 &&
    (score.opportunityRecall ?? 0) >= 0.92 &&
    score.criticalFalsePositives === 0
  );
}

function promotionGate(input: {
  selected: VariantResult;
  lockedTestDistribution: ReturnType<typeof candidateDistribution>;
}) {
  const thresholdReasons: string[] = [];
  const lockedTestKnown =
    input.selected.lockedTest.supportedCandidates +
    input.selected.lockedTest.refutedCandidates;
  if (lockedTestKnown < 100) {
    thresholdReasons.push("locked_test_known_binary_below_100");
  }
  if ((input.selected.lockedTest.precision ?? 0) < 0.92) {
    thresholdReasons.push("locked_test_precision_below_0_92");
  }
  if ((input.selected.lockedTest.precisionWilsonLower95 ?? 0) < 0.85) {
    thresholdReasons.push("locked_test_precision_wilson_lower_below_0_85");
  }
  if ((input.selected.lockedTest.opportunityRecall ?? 0) < 0.92) {
    thresholdReasons.push("locked_test_opportunity_recall_below_0_92");
  }
  if (input.selected.lockedTest.criticalFalsePositives > 0) {
    thresholdReasons.push("locked_test_critical_false_positive_present");
  }
  if (input.lockedTestDistribution.activeAccountCount < 3) {
    thresholdReasons.push("locked_test_candidates_span_fewer_than_3_accounts");
  }
  if ((input.lockedTestDistribution.largestAccountShare ?? 1) > 0.5) {
    thresholdReasons.push("largest_locked_test_account_share_above_0_50");
  }
  const actionableCandidates =
    input.lockedTestDistribution.authorities.actionable ?? 0;
  const executionReasons = [
    "historical_status_execution_authority_unproven",
    ...(actionableCandidates < input.lockedTestDistribution.candidateCount
      ? ["candidate_budget_owner_execution_authority_unproven"]
      : []),
    "observational_durability_does_not_establish_causal_budget_lift",
    "paired_causal_non_inferiority_not_identifiable_from_observational_replay",
  ];
  return {
    thresholdPromotion: thresholdReasons.length === 0 ? "PASS" : "BLOCKED",
    thresholdReasons,
    executionPromotion: executionReasons.length === 0 ? "PASS" : "BLOCKED",
    executionReasons,
    acceptance: {
      minimumLockedTestKnownBinary: 100,
      minimumPrecision: 0.92,
      minimumPrecisionWilsonLower95: 0.85,
      minimumOpportunityRecall: 0.92,
      maximumCriticalFalsePositives: 0,
      minimumCandidateAccounts: 3,
      maximumLargestAccountShare: 0.5,
    },
  };
}

function gridDiagnostics(results: readonly VariantResult[]) {
  const lockedTestRanked = results
    .filter(
      (result) =>
        result.lockedTest.supportedCandidates +
          result.lockedTest.refutedCandidates >=
        5,
    )
    .slice()
    .sort((left, right) =>
      compareStructureVariantScores(left.lockedTest, right.lockedTest),
    );
  return {
    evaluatedVariantCount: results.length,
    developmentThresholdGatePassCount: results.filter((result) =>
      scorePassesThresholdGate(result.development),
    ).length,
    calibrationThresholdGatePassCount: results.filter((result) =>
      scorePassesThresholdGate(result.calibration),
    ).length,
    lockedTestThresholdGatePassCount: results.filter((result) =>
      scorePassesThresholdGate(result.lockedTest),
    ).length,
    diagnosticBestLockedTestWithAtLeastFiveKnown:
      lockedTestRanked.length > 0 ? lockedTestRanked[0] : null,
    note: "Calibration selects the candidate. Locked-test diagnostics never alter selection and only show whether any preregistered bounded alternative could have passed.",
  };
}

function walkForwardDiagnostics(input: {
  opportunities: readonly DerivedStructureOpportunity[];
  variants: readonly StructureVariant[];
  opportunityDates: readonly string[];
}) {
  const folds = [4, 6, 8]
    .filter((trainCount) => trainCount + 1 < input.opportunityDates.length)
    .map((trainCount) => {
      const trainDates = input.opportunityDates.slice(0, trainCount);
      const validationDates = input.opportunityDates.slice(
        trainCount,
        Math.min(input.opportunityDates.length, trainCount + 2),
      );
      const trainSet = new Set(trainDates);
      const validationSet = new Set(validationDates);
      const trainRows = input.opportunities.filter((row) =>
        trainSet.has(row.asOfDate),
      );
      const validationRows = input.opportunities.filter((row) =>
        validationSet.has(row.asOfDate),
      );
      const ranked = input.variants
        .map((variant) => ({
          variant,
          development: scoreStructureVariant(trainRows, variant),
          validation: scoreStructureVariant(validationRows, variant),
        }))
        .sort((left, right) =>
          compareStructureVariantScores(left.development, right.development),
        );
      const scored =
        ranked.find(
          (row) =>
            row.development.supportedCandidates +
              row.development.refutedCandidates >=
            MIN_SELECTION_BINARY_CANDIDATES,
        ) ?? ranked[0]!;
      const known =
        scored.development.supportedCandidates +
        scored.development.refutedCandidates;
      return {
        trainDates,
        validationDates,
        selectedVariant: scored.variant,
        developmentSelectionMinimumMet:
          known >= MIN_SELECTION_BINARY_CANDIDATES,
        development: scored.development,
        validation: scored.validation,
      };
    });
  return {
    folds,
    uniqueSelectedVariantCount: new Set(
      folds.map((fold) => fold.selectedVariant.id),
    ).size,
    validationKnownBinary: folds.reduce(
      (total, fold) =>
        total +
        fold.validation.supportedCandidates +
        fold.validation.refutedCandidates,
      0,
    ),
    validationSupported: folds.reduce(
      (total, fold) => total + fold.validation.supportedCandidates,
      0,
    ),
    validationRefuted: folds.reduce(
      (total, fold) => total + fold.validation.refutedCandidates,
      0,
    ),
    validationCriticalFalsePositives: folds.reduce(
      (total, fold) => total + fold.validation.criticalFalsePositives,
      0,
    ),
  };
}

function budgetChangeSummary(
  opportunities: readonly DerivedStructureOpportunity[],
  variant: StructureVariant,
) {
  const candidates = opportunities.filter(
    (opportunity) => evaluateStructureCandidate(opportunity, variant).candidate,
  );
  let increased = 0;
  let unchanged = 0;
  let decreased = 0;
  let unknown = 0;
  for (const opportunity of candidates) {
    const before = opportunity.inferredBudgetAmount;
    const after = opportunity.outcomeBudgetAmount;
    if (before === null || after === null) {
      unknown += 1;
    } else if (after > before * 1.001) increased += 1;
    else if (after < before * 0.999) decreased += 1;
    else unchanged += 1;
  }
  return {
    interpretation: "observational_safety_only_not_causal_lift",
    candidateCount: candidates.length,
    increased,
    unchanged,
    decreased,
    unknown,
  };
}

function perAccountScores(
  opportunities: readonly DerivedStructureOpportunity[],
  variant: StructureVariant,
) {
  const groups = new Map<string, DerivedStructureOpportunity[]>();
  for (const opportunity of opportunities) {
    const key = `${opportunity.businessName}|${opportunity.accountId}|${opportunity.currency}`;
    const rows = groups.get(key) ?? [];
    rows.push(opportunity);
    groups.set(key, rows);
  }
  return Array.from(groups.entries())
    .map(([key, rows]) => ({
      key,
      score: scoreStructureVariant(rows, variant),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function coverageSummary(
  opportunities: readonly DerivedStructureOpportunity[],
) {
  return {
    fixedCohortRows: opportunities.length,
    businesses: new Set(opportunities.map((row) => row.businessId)).size,
    accounts: new Set(opportunities.map((row) => row.accountId)).size,
    currencies: countBy(opportunities, (row) => row.currency),
    goals: countBy(opportunities, (row) => row.goalKey),
    cohorts: countBy(opportunities, (row) => row.cohort),
    bidRegimes: countBy(opportunities, (row) => row.bidRegime),
    purchaseCohortRows: opportunities.filter((row) => row.purchaseCohort)
      .length,
    nonPurchaseCohortRows: opportunities.filter(
      (row) => row.cohort !== "purchase" && row.cohort !== "unknown",
    ).length,
    cutoffSafeConfigRows: opportunities.filter((row) => row.configCutoffSafe)
      .length,
    cutoffSafeBidContextRows: opportunities.filter(
      (row) => row.bidContextReconstructable,
    ).length,
    cutoffSafeTargetRows: opportunities.filter((row) => row.targetCutoffSafe)
      .length,
    freshTargetRows: opportunities.filter((row) => row.targetFresh).length,
    freshEconomicTargetRows: opportunities.filter(
      (row) =>
        row.targetFresh &&
        row.targetRoas !== null &&
        row.breakEvenRoas !== null,
    ).length,
    targetSources: countBy(
      opportunities,
      (row) => row.targetSource ?? "missing",
    ),
    completeOutcomeReceiptRows: opportunities.filter(
      (row) => row.completeOutcomeReceipt,
    ).length,
    inferredBudgetOwner: countBy(opportunities, (row) => row.budgetOwner),
    budgetOrigins: countBy(opportunities, (row) => row.budgetOrigin),
    reconstructableBudgetOwnerRows: opportunities.filter(
      (row) => row.budgetOwnerReconstructable,
    ).length,
    reconstructableHistoricalStatusRows: opportunities.filter(
      (row) => row.statusReconstructable,
    ).length,
    restatedSourceRows: opportunities.filter(
      (row) => row.sourceUpdatedAfterCutoff,
    ).length,
    configSourceKinds: countBy(opportunities, (row) =>
      row.configSourceKinds.length > 0
        ? row.configSourceKinds.sort().join("+")
        : "missing",
    ),
    outcomes: countBy(opportunities, (row) => row.outcome),
    fixedCohortHash: hashFixedStructureCohort(opportunities),
  };
}

function selectedExamples(
  opportunities: readonly DerivedStructureOpportunity[],
  variant: StructureVariant,
) {
  return opportunities
    .filter(
      (opportunity) =>
        evaluateStructureCandidate(opportunity, variant).candidate,
    )
    .slice(0, 20)
    .map((opportunity) => ({
      business: opportunity.businessName,
      accountId: opportunity.accountId,
      grain: opportunity.grain,
      entityId: opportunity.entityId,
      campaignId: opportunity.campaignId,
      adsetId: opportunity.adsetId,
      asOfDate: opportunity.asOfDate,
      currency: opportunity.currency,
      goalKey: opportunity.goalKey,
      cohort: opportunity.cohort,
      bidRegime: opportunity.bidRegime,
      ageDays: opportunity.ageDays,
      purchases: opportunity.cumulativePurchases,
      primaryOutcomes: opportunity.cumulativeConversions,
      utilization: opportunity.budgetUtilization,
      budgetOwner: opportunity.budgetOwner,
      budgetOrigin: opportunity.budgetOrigin,
      targetFresh: opportunity.targetFresh,
      targetRoas: opportunity.targetRoas,
      breakEvenRoas: opportunity.breakEvenRoas,
      authority: evaluateStructureCandidate(opportunity, variant).authority,
      outcome: opportunity.outcome,
      futureRoas: opportunity.futureRoas,
    }));
}

function hashSortedJsonRows(rows: readonly unknown[]) {
  return createHash("sha256")
    .update(
      rows
        .map((row) => JSON.stringify(row))
        .sort()
        .join("\n"),
    )
    .digest("hex");
}

function sourceReceiptHashes(input: {
  load: ReplayLoadResult;
  opportunities: DerivedStructureOpportunity[];
}) {
  return {
    dailyFacts: hashSortedJsonRows(
      input.load.dailyFacts.map((fact) => ({
        grain: fact.grain,
        businessId: fact.businessId,
        accountId: fact.accountId,
        entityId: fact.entityId,
        campaignId: fact.campaignId,
        adsetId: fact.adsetId,
        date: fact.date,
        currency: fact.currency,
        spend: fact.spend,
        conversions: fact.purchases,
        revenue: fact.revenue,
        sourceSnapshotId: fact.sourceSnapshotId,
        createdAt: fact.createdAt,
        updatedAt: fact.updatedAt,
      })),
    ),
    completeAccountDays: hashSortedJsonRows(
      Array.from(input.load.completeAccountDays),
    ),
    opportunityEvidence: hashSortedJsonRows(
      input.opportunities.map((row) => ({
        grain: row.grain,
        businessId: row.businessId,
        accountId: row.accountId,
        entityId: row.entityId,
        asOfDate: row.asOfDate,
        currency: row.currency,
        goalKey: row.goalKey,
        cohort: row.cohort,
        cutoff: row.cutoff,
        configIds: row.configIds,
        configSourceKinds: row.configSourceKinds,
        configRegimeStartDate: row.configRegimeStartDate,
        configCutoffSafe: row.configCutoffSafe,
        bidRegime: row.bidRegime,
        bidValue: row.bidValue,
        bidValueFormat: row.bidValueFormat,
        bidContextReconstructable: row.bidContextReconstructable,
        budgetOwner: row.budgetOwner,
        budgetOrigin: row.budgetOrigin,
        budgetOwnerReason: row.budgetOwnerReason,
        inferredBudgetAmount: row.inferredBudgetAmount,
        targetSource: row.targetSource,
        targetCutoffSafe: row.targetCutoffSafe,
        targetFresh: row.targetFresh,
        targetRoas: row.targetRoas,
        breakEvenRoas: row.breakEvenRoas,
        targetCpa: row.targetCpa,
        breakEvenCpa: row.breakEvenCpa,
        sourceSnapshotId: row.sourceSnapshotId,
        sourceUpdatedAfterCutoff: row.sourceUpdatedAfterCutoff,
        outcomeWindows: row.outcomeWindows,
      })),
    ),
  };
}

function sourceManifestHash(input: {
  args: ParsedArgs;
  opportunityDates: string[];
  load: ReplayLoadResult;
  opportunities: DerivedStructureOpportunity[];
}) {
  const codeProvenance = replayCodeProvenance();
  const receiptHashes = sourceReceiptHashes(input);
  const manifest = {
    parameters: {
      startDate: input.args.startDate,
      decisionEndDate: input.args.decisionEndDate,
      outcomeCeiling: input.args.outcomeCeiling,
      businesses: input.args.businesses.slice().sort(),
      opportunityDates: input.opportunityDates,
    },
    sourceCounts: input.load.sourceCounts,
    receiptHashes,
    codeProvenance,
    cohortHashes: {
      campaign: hashFixedStructureCohort(
        input.opportunities.filter((row) => row.grain === "campaign"),
      ),
      adset: hashFixedStructureCohort(
        input.opportunities.filter((row) => row.grain === "adset"),
      ),
    },
  };
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function replayCodeProvenance() {
  const scriptPath =
    "scripts/creative-decision-center/native-structure-grain-paired-replay.ts";
  const mathPath =
    "lib/creative-decision-engine/simulation/structure-replay.ts";
  let repoHead: string | null = null;
  try {
    repoHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
  } catch {
    repoHead = null;
  }
  return {
    repoHead,
    scriptPath,
    scriptSha256: sha256File(scriptPath),
    mathPath,
    mathSha256: sha256File(mathPath),
  };
}

function fmtPercent(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
}

function renderMarkdown(report: ReturnType<typeof buildReport>) {
  const lines: string[] = [
    "# Native Campaign / Ad-set Structure Paired Replay",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Scope",
    "",
    `- Decision dates: ${report.parameters.opportunityDates.join(", ")}`,
    `- Cadence anchor: ${report.parameters.cadenceAnchor} (${report.parameters.opportunityCadenceDays} days)`,
    `- Outcome windows: ${report.parameters.outcomeWindowDays.join(", ")} complete account days`,
    `- Candidate grid: ${report.parameters.variantCount} H7/H9 combinations per grain`,
    `- Source manifest SHA-256: \`${report.sourceManifestHash}\``,
    "",
    "## Period Protocol",
    "",
    "| Phase | Range | Outcome ceiling | Cadence dates |",
    "|---|---|---|---:|",
  ];
  for (const phase of ["development", "calibration", "locked_test"] as const) {
    const row = report.parameters.phases[phase];
    lines.push(
      `| ${phase} | ${row.startDate}..${row.endDate} | ${row.outcomeCeiling} | ${row.opportunityDates.length} |`,
    );
  }
  lines.push(
    "",
    "Calibration selects each finite-grid candidate. Locked-test rows never alter selection. Every cell is isolated by grain, outcome window, funnel cohort, and currency.",
    "",
    "## Promotion Gates",
    "",
    "| Grain | Window | Cohort | Currency | Variant | Locked known | Precision | Wilson lower | Recall | Safety | Threshold | Execution |",
    "|---|---:|---|---|---|---:|---:|---:|---:|---:|---|---|",
  );
  for (const cell of report.results.cells) {
    const score = cell.calibrationSelected.lockedTest;
    lines.push(
      `| ${cell.grain} | ${cell.windowDays}d | ${cell.cohort} | ${cell.currency} | \`${cell.calibrationSelected.variant.id}\` | ${score.supportedCandidates + score.refutedCandidates} | ${fmtPercent(score.precision)} | ${fmtPercent(score.precisionWilsonLower95)} | ${fmtPercent(score.opportunityRecall)} | ${score.criticalFalsePositives} | ${cell.promotionGate.thresholdPromotion} | ${cell.promotionGate.executionPromotion} |`,
    );
  }
  lines.push(
    "",
    "No currency is pooled into selection or promotion metrics. Purchase cells require cutoff-safe fresh target and break-even anchors. Other funnel cells use their own primary-result cost distribution and never inherit ROAS targets.",
    "",
    "## Coverage",
    "",
    "| Grain | Fixed rows | Purchase | Non-purchase | Config PIT | Bid PIT | Target PIT | Fresh target | Complete 14d |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const grain of ["campaign", "adset"] as const) {
    const coverage = report.results.coverage[grain];
    lines.push(
      `| ${grain} | ${coverage.fixedCohortRows} | ${coverage.purchaseCohortRows} | ${coverage.nonPurchaseCohortRows} | ${coverage.cutoffSafeConfigRows} | ${coverage.cutoffSafeBidContextRows} | ${coverage.cutoffSafeTargetRows} | ${coverage.freshTargetRows} | ${coverage.completeOutcomeReceiptRows} |`,
    );
  }
  lines.push("", "## Evidence Limits", "");
  for (const limit of report.evidenceLimits) lines.push(`- ${limit}`);
  lines.push("", "## Decision", "", report.verdict, "");
  return lines.join("\n");
}

function buildReport(input: {
  args: ParsedArgs;
  opportunityDates: string[];
  load: ReplayLoadResult;
  opportunities: DerivedStructureOpportunity[];
  variants: StructureVariant[];
}) {
  const protocol = buildStructureReplayProtocol({
    startDate: input.args.startDate,
    endDate: input.args.decisionEndDate,
    cadenceDays: OPPORTUNITY_CADENCE_DAYS,
    anchorDate: STRUCTURE_REPLAY_CADENCE_ANCHOR,
  });
  const cells = [];
  for (const grain of ["campaign", "adset"] as const) {
    const grainRows = input.opportunities.filter((row) => row.grain === grain);
    const cohorts = Array.from(
      new Set(
        grainRows
          .map((row) => row.cohort)
          .filter((cohort) => cohort !== "unknown"),
      ),
    ).sort();
    for (const cohort of cohorts) {
      const currencies = Array.from(
        new Set(
          grainRows
            .filter((row) => row.cohort === cohort)
            .map((row) => row.currency),
        ),
      ).sort();
      for (const currency of currencies) {
        for (const windowDays of STRUCTURE_OUTCOME_WINDOWS) {
          const phaseDates = {
            development:
              protocol.phases.development.eligibleDatesByWindow[windowDays],
            calibration:
              protocol.phases.calibration.eligibleDatesByWindow[windowDays],
            locked_test:
              protocol.phases.locked_test.eligibleDatesByWindow[windowDays],
          } satisfies Record<StructureReplayPhase, readonly string[]>;
          const result = scoreVariants({
            opportunities: input.opportunities,
            variants: input.variants,
            phaseDates,
            grain,
            windowDays,
            cohort,
            currency,
          });
          if (result.grainRows.length === 0) continue;
          const lockedTestDistribution = candidateDistribution(
            result.phaseRows.locked_test,
            result.selected.variant,
          );
          const fullDistribution = candidateDistribution(
            result.grainRows,
            result.selected.variant,
          );
          cells.push({
            key: `${grain}|${windowDays}d|${cohort}|${currency}`,
            grain,
            windowDays,
            cohort,
            currency,
            phaseDates,
            fixedCohortHash: hashFixedStructureCohort(result.grainRows),
            calibrationSelected: result.selected,
            selectionMinimumMet:
              result.selected.calibration.supportedCandidates +
                result.selected.calibration.refutedCandidates >=
              MIN_SELECTION_BINARY_CANDIDATES,
            topCalibration: result.results.slice(0, 25),
            allVariants: result.results,
            gridDiagnostics: gridDiagnostics(result.results),
            walkForward: walkForwardDiagnostics({
              opportunities: result.phaseRows.development,
              variants: input.variants,
              opportunityDates: phaseDates.development,
            }),
            promotionGate: promotionGate({
              selected: result.selected,
              lockedTestDistribution,
            }),
            candidateDistribution: {
              full: fullDistribution,
              lockedTest: lockedTestDistribution,
            },
            coverage: coverageSummary(result.grainRows),
            budgetChangeObservation:
              windowDays === 14
                ? budgetChangeSummary(result.grainRows, result.selected.variant)
                : null,
            perAccount: perAccountScores(
              result.grainRows,
              result.selected.variant,
            ),
            examples: selectedExamples(
              result.grainRows,
              result.selected.variant,
            ),
            action:
              grain === "campaign"
                ? "increase_campaign_budget"
                : "increase_adset_budget",
          });
        }
      }
    }
  }
  const coverage = Object.fromEntries(
    (["campaign", "adset"] as const).map((grain) => [
      grain,
      coverageSummary(
        input.opportunities
          .filter((row) => row.grain === grain)
          .map((row) => projectStructureOpportunityWindow(row, 14)),
      ),
    ]),
  ) as Record<StructureGrain, ReturnType<typeof coverageSummary>>;
  const phaseReport = Object.fromEntries(
    (["development", "calibration", "locked_test"] as const).map((phase) => [
      phase,
      protocol.phases[phase],
    ]),
  ) as typeof protocol.phases;
  const report = {
    contractVersion: STRUCTURE_REPLAY_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    sourceMode: "restated_structure_daily_with_cutoff_config_history",
    sourceManifestHash: sourceManifestHash(input),
    parameters: {
      startDate: input.args.startDate,
      decisionEndDate: input.args.decisionEndDate,
      outcomeCeiling: input.args.outcomeCeiling,
      opportunityCadenceDays: OPPORTUNITY_CADENCE_DAYS,
      cadenceAnchor: protocol.anchorDate,
      outcomeWindowDays: STRUCTURE_OUTCOME_WINDOWS,
      historyLookbackDays: H9_STRUCTURE_HISTORY_LOOKBACK_DAYS,
      opportunityDates: input.opportunityDates,
      phases: phaseReport,
      variantCount: input.variants.length,
      grid: {
        h7: H7_STRUCTURE_MATURITY_GRID,
        h9: H9_STRUCTURE_HISTORY_GRID,
        h9AnnualSeasonalityElimination: H9_ANNUAL_SEASONALITY_ELIMINATION,
      },
    },
    source: {
      databaseAccess: "ssh_tunnel_read_only_transaction",
      tables: [
        "businesses",
        "meta_campaign_daily",
        "meta_adset_daily",
        "meta_account_daily",
        "meta_campaign_config_history",
        "meta_adset_config_history",
        "business_target_pack_history",
        "business_target_packs",
      ],
      counts: input.load.sourceCounts,
      receiptHashes: sourceReceiptHashes(input),
      codeProvenance: replayCodeProvenance(),
    },
    results: {
      cells,
      coverage,
    },
    evidenceLimits: [
      "Daily campaign/ad-set metrics are finalized warehouse facts but are restated, not exact raw point-in-time generations; source_updated_after_cutoff is reported rather than hidden.",
      "Cutoff-gated config history proves what was recorded by the decision cutoff, but the normalized schema collapses direct campaign budgets and equal ad-set budget fallbacks. Those cases remain review-only and cannot authorize writes.",
      "Campaign/ad-set status is not versioned in config history. Daily status columns can be restated from later provider reads, so historical execution authority is always false in this replay.",
      "A future durable-winner outcome is an observational ranking proxy. It does not identify causal budget-step lift, incrementality, or counterfactual savings.",
      "The warehouse conversion field is interpreted only inside its cutoff-classified funnel cohort. Purchase cells require fresh target and break-even truth; non-purchase cells use primary-result cost without ROAS substitution.",
      "Bid strategy/value and budget owner/origin must be reconstructable at the cutoff. Mixed or unsupported contexts fail closed rather than borrowing another regime.",
      "Unlogged provider actions, deleted entities, attribution restatements, and successor lineage cannot be reconstructed from these tables.",
    ],
    verdict: cells.some(
      (cell) => cell.promotionGate.thresholdPromotion === "PASS",
    )
      ? "At least one currency-isolated grain/window/cohort cell passed the observational threshold gate. Execution remains blocked because historical durability cannot establish causal budget lift or execution authority."
      : `All ${input.variants.length} finite H7/H9 alternatives were evaluated independently in every estimable grain/window/cohort/currency cell; none passed the locked-test threshold gate. Do not ship an H7/H9 threshold change from this replay.`,
  };
  return report;
}

export async function runNativeStructureReplay(args: ParsedArgs) {
  const protocol = buildStructureReplayProtocol({
    startDate: args.startDate,
    endDate: args.decisionEndDate,
    cadenceDays: OPPORTUNITY_CADENCE_DAYS,
    anchorDate: STRUCTURE_REPLAY_CADENCE_ANCHOR,
  });
  const opportunityDates = protocol.opportunityDates;
  const variants = buildStructureVariantGrid();
  const load = await loadReplayData(args, opportunityDates);
  const opportunities = deriveOpportunities({
    load,
    outcomeCeiling: args.outcomeCeiling,
  });
  const report = buildReport({
    args,
    opportunityDates,
    load,
    opportunities,
    variants,
  });
  if (args.writeFiles) {
    mkdirSync(dirname(args.jsonOut), { recursive: true });
    mkdirSync(dirname(args.mdOut), { recursive: true });
    writeFileSync(args.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(args.mdOut, `${renderMarkdown(report)}\n`);
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await runNativeStructureReplay(args);
  const summary = {
    contractVersion: report.contractVersion,
    sourceManifestHash: report.sourceManifestHash,
    opportunityDates: report.parameters.opportunityDates,
    coverage: report.results.coverage,
    promotionCellSummary: {
      evaluated: report.results.cells.length,
      calibrationSelectionMinimumMet: report.results.cells.filter(
        (cell) => cell.selectionMinimumMet,
      ).length,
      thresholdPass: report.results.cells.filter(
        (cell) => cell.promotionGate.thresholdPromotion === "PASS",
      ).length,
      executionPass: report.results.cells.filter(
        (cell) => cell.promotionGate.executionPromotion === "PASS",
      ).length,
    },
    informativeCells: report.results.cells
      .map((cell) => ({
        key: cell.key,
        selectedVariant: cell.calibrationSelected.variant.id,
        selectionMinimumMet: cell.selectionMinimumMet,
        lockedTestKnown:
          cell.calibrationSelected.lockedTest.supportedCandidates +
          cell.calibrationSelected.lockedTest.refutedCandidates,
        lockedTestPrecision: cell.calibrationSelected.lockedTest.precision,
        lockedTestWilsonLower:
          cell.calibrationSelected.lockedTest.precisionWilsonLower95,
        lockedTestRecall: cell.calibrationSelected.lockedTest.opportunityRecall,
        lockedTestCriticalFalsePositives:
          cell.calibrationSelected.lockedTest.criticalFalsePositives,
        thresholdPromotion: cell.promotionGate.thresholdPromotion,
        executionPromotion: cell.promotionGate.executionPromotion,
      }))
      .filter((cell) => cell.selectionMinimumMet || cell.lockedTestKnown > 0),
    artifacts: args.writeFiles
      ? { json: args.jsonOut, markdown: args.mdOut }
      : null,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
