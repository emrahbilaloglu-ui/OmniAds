import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import type { MetaPreviousConfigDiff } from "@/lib/meta/config-snapshots";
import {
  deriveManualBidAmount,
  formatBidStrategyLabel,
  type MetaConfigSnapshotPayload,
} from "@/lib/meta/configuration";

export interface MetaCampaignDimensionRecord {
  businessId: string;
  businessRefId: string | null;
  providerAccountId: string;
  providerAccountRefId: string | null;
  campaignId: string;
  campaignNameCurrent: string | null;
  campaignNameHistorical: string | null;
  campaignStatus: string | null;
  buyingType: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface MetaAdSetDimensionRecord {
  businessId: string;
  businessRefId: string | null;
  providerAccountId: string;
  providerAccountRefId: string | null;
  campaignId: string | null;
  adsetId: string;
  adsetNameCurrent: string | null;
  adsetNameHistorical: string | null;
  adsetStatus: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface MetaAdDimensionRecord {
  businessId: string;
  businessRefId: string | null;
  providerAccountId: string;
  providerAccountRefId: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string;
  adNameCurrent: string | null;
  adNameHistorical: string | null;
  adStatus: string | null;
  creativeId: string | null;
  projectionJson: unknown;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface MetaCreativeDimensionRecord {
  businessId: string;
  businessRefId: string | null;
  providerAccountId: string;
  providerAccountRefId: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  creativeId: string;
  creativeName: string | null;
  headline: string | null;
  primaryText: string | null;
  destinationUrl: string | null;
  thumbnailUrl: string | null;
  assetType: string | null;
  projectionJson: unknown;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  sourceUpdatedAt: string | null;
}

async function schemaReady(tables: string[]) {
  const readiness = await getDbSchemaReadiness({ tables });
  return readiness.ready;
}

async function readLatestConfigHistory(input: {
  tableName: "meta_campaign_config_history" | "meta_adset_config_history";
  entityColumn: "campaign_id" | "adset_id";
  businessId: string;
  entityIds: string[];
}) {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0) return new Map<string, MetaConfigSnapshotPayload>();
  if (!(await schemaReady([input.tableName]))) return new Map();

  const sql = getDb();
  const objectiveSelect =
    input.tableName === "meta_campaign_config_history"
      ? "objective"
      : "NULL::text AS objective";
  const customEventMixedSelect =
    input.tableName === "meta_campaign_config_history"
      ? "is_custom_event_type_mixed"
      : "FALSE AS is_custom_event_type_mixed";
  const adsetPromotedObjectSelect =
    input.tableName === "meta_adset_config_history"
      ? `
          pixel_id,
          custom_conversion_id,
          promoted_object_json
        `
      : `
          NULL::text AS pixel_id,
          NULL::text AS custom_conversion_id,
          NULL::jsonb AS promoted_object_json
        `;
  const rows = await sql.query(
    `
      WITH requested_entities AS (
        SELECT unnest($2::text[]) AS entity_id
      )
      SELECT
        requested_entities.entity_id,
        latest.objective,
        latest.optimization_goal,
        latest.custom_event_type,
        latest.pixel_id,
        latest.custom_conversion_id,
        latest.promoted_object_json,
        latest.bid_strategy_type,
        latest.bid_value,
        latest.bid_value_format,
        latest.daily_budget,
        latest.lifetime_budget,
        latest.is_budget_mixed,
        latest.is_config_mixed,
        latest.is_optimization_goal_mixed,
        latest.is_custom_event_type_mixed,
        latest.is_bid_strategy_mixed,
        latest.is_bid_value_mixed
      FROM requested_entities
      JOIN LATERAL (
        SELECT
          ${objectiveSelect},
          optimization_goal,
          custom_event_type,
          ${adsetPromotedObjectSelect},
          bid_strategy_type,
          bid_value,
          bid_value_format,
          daily_budget,
          lifetime_budget,
          is_budget_mixed,
          is_config_mixed,
          is_optimization_goal_mixed,
          ${customEventMixedSelect},
          is_bid_strategy_mixed,
          is_bid_value_mixed
        FROM ${input.tableName}
        WHERE business_id = $1
          AND ${input.entityColumn} = requested_entities.entity_id
        ORDER BY captured_at DESC, created_at DESC
        LIMIT 1
      ) latest ON true
    `,
    [input.businessId, entityIds],
  ) as Array<{
    entity_id: string;
    objective: string | null;
    optimization_goal: string | null;
    custom_event_type: string | null;
    pixel_id: string | null;
    custom_conversion_id: string | null;
    promoted_object_json: unknown;
    bid_strategy_type: string | null;
    bid_value: number | null;
    bid_value_format: "currency" | "roas" | null;
    daily_budget: number | null;
    lifetime_budget: number | null;
    is_budget_mixed: boolean;
    is_config_mixed: boolean;
    is_optimization_goal_mixed: boolean;
    is_custom_event_type_mixed: boolean;
    is_bid_strategy_mixed: boolean;
    is_bid_value_mixed: boolean;
  }>;

  return new Map(
    rows.map((row) => [
      row.entity_id,
      {
        objective: row.objective,
        optimizationGoal: row.optimization_goal,
        customEventType: row.custom_event_type,
        pixelId: row.pixel_id,
        customConversionId: row.custom_conversion_id,
        promotedObject: row.promoted_object_json,
        bidStrategyType: row.bid_strategy_type,
        bidStrategyLabel: formatBidStrategyLabel(row.bid_strategy_type),
        manualBidAmount: deriveManualBidAmount(row.bid_value, row.bid_value_format),
        bidValue: row.bid_value,
        bidValueFormat: row.bid_value_format,
        dailyBudget: row.daily_budget,
        lifetimeBudget: row.lifetime_budget,
        isBudgetMixed: row.is_budget_mixed,
        isConfigMixed: row.is_config_mixed,
        isOptimizationGoalMixed: row.is_optimization_goal_mixed,
        isCustomEventTypeMixed: row.is_custom_event_type_mixed,
        isBidStrategyMixed: row.is_bid_strategy_mixed,
        isBidValueMixed: row.is_bid_value_mixed,
      } satisfies MetaConfigSnapshotPayload,
    ]),
  );
}

async function readPreviousDifferentConfigHistory(input: {
  tableName: "meta_campaign_config_history" | "meta_adset_config_history";
  entityColumn: "campaign_id" | "adset_id";
  businessId: string;
  entityIds: string[];
  includeBudget?: boolean;
}) {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0) return new Map<string, MetaPreviousConfigDiff>();
  if (!(await schemaReady([input.tableName]))) return new Map();

  const sql = getDb();
  const previousBudgetSelect = input.includeBudget === false
    ? `
        NULL::timestamptz AS previous_budget_captured_at,
        NULL::double precision AS previous_daily_budget,
        NULL::double precision AS previous_lifetime_budget
      `
    : `
        previous_budget.captured_at AS previous_budget_captured_at,
        previous_budget.daily_budget AS previous_daily_budget,
        previous_budget.lifetime_budget AS previous_lifetime_budget
      `;
  const previousBudgetJoin = input.includeBudget === false
    ? ""
    : `
      LEFT JOIN LATERAL (
        SELECT
          captured_at,
          daily_budget,
          lifetime_budget
        FROM ${input.tableName}
        WHERE business_id = $1
          AND ${input.entityColumn} = latest.entity_id
          AND (
            daily_budget IS DISTINCT FROM latest.daily_budget OR
            lifetime_budget IS DISTINCT FROM latest.lifetime_budget
          )
        ORDER BY captured_at DESC, created_at DESC
        LIMIT 1
      ) previous_budget ON true
    `;
  const rows = await sql.query(
    `
      WITH requested_entities AS (
        SELECT unnest($2::text[]) AS entity_id
      ),
      latest AS (
        SELECT
          requested_entities.entity_id,
          current_row.captured_at,
          current_row.created_at,
          current_row.bid_value,
          current_row.bid_value_format,
          current_row.daily_budget,
          current_row.lifetime_budget
        FROM requested_entities
        JOIN LATERAL (
          SELECT
            captured_at,
            created_at,
            bid_value,
            bid_value_format,
            daily_budget,
            lifetime_budget
          FROM ${input.tableName}
          WHERE business_id = $1
            AND ${input.entityColumn} = requested_entities.entity_id
          ORDER BY captured_at DESC, created_at DESC
          LIMIT 1
        ) current_row ON true
      )
      SELECT
        latest.entity_id,
        previous_bid.captured_at AS previous_bid_captured_at,
        previous_bid.bid_value AS previous_bid_value,
        previous_bid.bid_value_format AS previous_bid_value_format,
        ${previousBudgetSelect}
      FROM latest
      LEFT JOIN LATERAL (
        SELECT
          captured_at,
          bid_value,
          bid_value_format
        FROM ${input.tableName}
        WHERE business_id = $1
          AND ${input.entityColumn} = latest.entity_id
          AND (
            latest.bid_value IS NOT NULL OR
            latest.bid_value_format IS NOT NULL
          )
          AND (
            bid_value IS DISTINCT FROM latest.bid_value OR
            bid_value_format IS DISTINCT FROM latest.bid_value_format
          )
        ORDER BY captured_at DESC, created_at DESC
        LIMIT 1
      ) previous_bid ON true
      ${previousBudgetJoin}
    `,
    [input.businessId, entityIds],
  ) as Array<{
    entity_id: string;
    previous_bid_captured_at: string | null;
    previous_bid_value: number | null;
    previous_bid_value_format: "currency" | "roas" | null;
    previous_budget_captured_at: string | null;
    previous_daily_budget: number | null;
    previous_lifetime_budget: number | null;
  }>;

  const result = new Map<string, MetaPreviousConfigDiff>();
  for (const row of rows) {
    result.set(row.entity_id, {
      previousManualBidAmount: deriveManualBidAmount(
        row.previous_bid_value,
        row.previous_bid_value_format,
      ),
      previousBidValue: row.previous_bid_value ?? null,
      previousBidValueFormat: row.previous_bid_value_format ?? null,
      previousBidCapturedAt: row.previous_bid_captured_at ?? null,
      previousDailyBudget: row.previous_daily_budget ?? null,
      previousLifetimeBudget: row.previous_lifetime_budget ?? null,
      previousBudgetCapturedAt: row.previous_budget_captured_at ?? null,
    });
  }

  return result;
}

async function readDimensionsByIds<T>(input: {
  tableName:
    | "meta_campaign_dimensions"
    | "meta_adset_dimensions"
    | "meta_ad_dimensions"
    | "meta_creative_dimensions";
  entityColumn: "campaign_id" | "adset_id" | "ad_id" | "creative_id";
  businessId: string;
  entityIds: string[];
}): Promise<T[]> {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0) return [];
  if (!(await schemaReady([input.tableName]))) return [];

  const sql = getDb();
  return (await sql.query(
    `
      SELECT *
      FROM ${input.tableName}
      WHERE business_id = $1
        AND ${input.entityColumn} = ANY($2::text[])
    `,
    [input.businessId, entityIds],
  )) as T[];
}

export async function readLatestMetaCampaignConfigHistory(input: {
  businessId: string;
  campaignIds: string[];
}) {
  return readLatestConfigHistory({
    tableName: "meta_campaign_config_history",
    entityColumn: "campaign_id",
    businessId: input.businessId,
    entityIds: input.campaignIds,
  });
}

export async function readLatestMetaAdSetConfigHistory(input: {
  businessId: string;
  adsetIds: string[];
}) {
  return readLatestConfigHistory({
    tableName: "meta_adset_config_history",
    entityColumn: "adset_id",
    businessId: input.businessId,
    entityIds: input.adsetIds,
  });
}

export async function readPreviousDifferentMetaCampaignConfigHistoryDiffs(input: {
  businessId: string;
  campaignIds: string[];
  includeBudget?: boolean;
}) {
  return readPreviousDifferentConfigHistory({
    tableName: "meta_campaign_config_history",
    entityColumn: "campaign_id",
    businessId: input.businessId,
    entityIds: input.campaignIds,
    includeBudget: input.includeBudget,
  });
}

export async function readPreviousDifferentMetaAdSetConfigHistoryDiffs(input: {
  businessId: string;
  adsetIds: string[];
  includeBudget?: boolean;
}) {
  return readPreviousDifferentConfigHistory({
    tableName: "meta_adset_config_history",
    entityColumn: "adset_id",
    businessId: input.businessId,
    entityIds: input.adsetIds,
    includeBudget: input.includeBudget,
  });
}

export async function readMetaCampaignDimensions(input: {
  businessId: string;
  campaignIds: string[];
}) {
  const rows = await readDimensionsByIds<{
    business_id: string;
    business_ref_id: string | null;
    provider_account_id: string;
    provider_account_ref_id: string | null;
    campaign_id: string;
    campaign_name_current: string | null;
    campaign_name_historical: string | null;
    campaign_status: string | null;
    buying_type: string | null;
    first_seen_at: string | null;
    last_seen_at: string | null;
    source_updated_at: string | null;
  }>({
    tableName: "meta_campaign_dimensions",
    entityColumn: "campaign_id",
    businessId: input.businessId,
    entityIds: input.campaignIds,
  });
  return new Map<string, MetaCampaignDimensionRecord>(
    rows.map((row) => [
      row.campaign_id,
      {
        businessId: row.business_id,
        businessRefId: row.business_ref_id,
        providerAccountId: row.provider_account_id,
        providerAccountRefId: row.provider_account_ref_id,
        campaignId: row.campaign_id,
        campaignNameCurrent: row.campaign_name_current,
        campaignNameHistorical: row.campaign_name_historical,
        campaignStatus: row.campaign_status,
        buyingType: row.buying_type,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        sourceUpdatedAt: row.source_updated_at,
      },
    ]),
  );
}

export async function readMetaAdSetDimensions(input: {
  businessId: string;
  adsetIds: string[];
}) {
  const rows = await readDimensionsByIds<{
    business_id: string;
    business_ref_id: string | null;
    provider_account_id: string;
    provider_account_ref_id: string | null;
    campaign_id: string | null;
    adset_id: string;
    adset_name_current: string | null;
    adset_name_historical: string | null;
    adset_status: string | null;
    first_seen_at: string | null;
    last_seen_at: string | null;
    source_updated_at: string | null;
  }>({
    tableName: "meta_adset_dimensions",
    entityColumn: "adset_id",
    businessId: input.businessId,
    entityIds: input.adsetIds,
  });
  return new Map<string, MetaAdSetDimensionRecord>(
    rows.map((row) => [
      row.adset_id,
      {
        businessId: row.business_id,
        businessRefId: row.business_ref_id,
        providerAccountId: row.provider_account_id,
        providerAccountRefId: row.provider_account_ref_id,
        campaignId: row.campaign_id,
        adsetId: row.adset_id,
        adsetNameCurrent: row.adset_name_current,
        adsetNameHistorical: row.adset_name_historical,
        adsetStatus: row.adset_status,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        sourceUpdatedAt: row.source_updated_at,
      },
    ]),
  );
}

export async function readMetaAdDimensions(input: {
  businessId: string;
  adIds: string[];
}) {
  const rows = await readDimensionsByIds<{
    business_id: string;
    business_ref_id: string | null;
    provider_account_id: string;
    provider_account_ref_id: string | null;
    campaign_id: string | null;
    adset_id: string | null;
    ad_id: string;
    ad_name_current: string | null;
    ad_name_historical: string | null;
    ad_status: string | null;
    creative_id: string | null;
    projection_json: unknown;
    first_seen_at: string | null;
    last_seen_at: string | null;
    source_updated_at: string | null;
  }>({
    tableName: "meta_ad_dimensions",
    entityColumn: "ad_id",
    businessId: input.businessId,
    entityIds: input.adIds,
  });
  return new Map<string, MetaAdDimensionRecord>(
    rows.map((row) => [
      row.ad_id,
      {
        businessId: row.business_id,
        businessRefId: row.business_ref_id,
        providerAccountId: row.provider_account_id,
        providerAccountRefId: row.provider_account_ref_id,
        campaignId: row.campaign_id,
        adsetId: row.adset_id,
        adId: row.ad_id,
        adNameCurrent: row.ad_name_current,
        adNameHistorical: row.ad_name_historical,
        adStatus: row.ad_status,
        creativeId: row.creative_id,
        projectionJson: row.projection_json,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        sourceUpdatedAt: row.source_updated_at,
      },
    ]),
  );
}

export async function readMetaCreativeDimensions(input: {
  businessId: string;
  creativeIds: string[];
}) {
  const rows = await readDimensionsByIds<{
    business_id: string;
    business_ref_id: string | null;
    provider_account_id: string;
    provider_account_ref_id: string | null;
    campaign_id: string | null;
    adset_id: string | null;
    ad_id: string | null;
    creative_id: string;
    creative_name: string | null;
    headline: string | null;
    primary_text: string | null;
    destination_url: string | null;
    thumbnail_url: string | null;
    asset_type: string | null;
    projection_json: unknown;
    first_seen_at: string | null;
    last_seen_at: string | null;
    source_updated_at: string | null;
  }>({
    tableName: "meta_creative_dimensions",
    entityColumn: "creative_id",
    businessId: input.businessId,
    entityIds: input.creativeIds,
  });
  return new Map<string, MetaCreativeDimensionRecord>(
    rows.map((row) => [
      row.creative_id,
      {
        businessId: row.business_id,
        businessRefId: row.business_ref_id,
        providerAccountId: row.provider_account_id,
        providerAccountRefId: row.provider_account_ref_id,
        campaignId: row.campaign_id,
        adsetId: row.adset_id,
        adId: row.ad_id,
        creativeId: row.creative_id,
        creativeName: row.creative_name,
        headline: row.headline,
        primaryText: row.primary_text,
        destinationUrl: row.destination_url,
        thumbnailUrl: row.thumbnail_url,
        assetType: row.asset_type,
        projectionJson: row.projection_json,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        sourceUpdatedAt: row.source_updated_at,
      },
    ]),
  );
}
