import { getDb } from "@/lib/db";
import { assertDbSchemaReady, getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import {
  deriveManualBidAmount,
  formatBidStrategyLabel,
  normalizeTargetRoasValue,
  stripIncompleteConstrainedBidFields,
  stripDerivedMetaConfigFields,
  type MetaConfigSnapshotPayload,
} from "@/lib/meta/configuration";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";

export type MetaConfigEntityLevel = "campaign" | "adset";

interface MetaConfigSnapshotInsert {
  businessId: string;
  accountId: string;
  entityLevel: MetaConfigEntityLevel;
  entityId: string;
  payload: MetaConfigSnapshotPayload;
}

export interface MetaPreviousConfigDiff {
  previousManualBidAmount: number | null;
  previousBidValue: number | null;
  previousBidValueFormat: "currency" | "roas" | null;
  previousBidCapturedAt: string | null;
  previousDailyBudget: number | null;
  previousLifetimeBudget: number | null;
  previousBudgetCapturedAt: string | null;
}

export interface MetaBidRegimeHistorySummary {
  dominantBidStrategyType: string | null;
  dominantBidStrategyLabel: string | null;
  observationCount: number;
  constrainedShare: number;
  openShare: number;
}

function sanitizeForJson(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForJson(entry));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitizeForJson(entry),
      ])
    );
  }
  return String(value);
}

export async function readLatestMetaConfigSnapshots(input: {
  businessId: string;
  entityLevel: MetaConfigEntityLevel;
  entityIds: string[];
}): Promise<Map<string, MetaConfigSnapshotPayload>> {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0) return new Map();

  try {
    const readiness = await getDbSchemaReadiness({
      tables: ["meta_config_snapshots"],
    });
    if (!readiness.ready) {
      return new Map();
    }
    const sql = getDb();
    const rows = await sql.query<{ entity_id: string; payload: MetaConfigSnapshotPayload }>(
      `
        WITH requested_entities AS (
          SELECT unnest($3::text[]) AS entity_id
        )
        SELECT
          requested_entities.entity_id,
          latest.payload
        FROM requested_entities
        JOIN LATERAL (
          SELECT payload
          FROM meta_config_snapshots
          WHERE business_id = $1
            AND entity_level = $2
            AND entity_id = requested_entities.entity_id
          ORDER BY captured_at DESC
          LIMIT 1
        ) latest ON true
      `,
      [input.businessId, input.entityLevel, entityIds],
    );

    return new Map(
      rows.map((row) => [
        row.entity_id,
        stripIncompleteConstrainedBidFields(normalizeLegacySnapshotPayload(row.payload)),
      ]),
    );
  } catch (error) {
    console.warn("[meta-config-snapshots] read_latest_failed", {
      businessId: input.businessId,
      entityLevel: input.entityLevel,
      message: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

export async function readPreviousMetaConfigSnapshots(input: {
  businessId: string;
  entityLevel: MetaConfigEntityLevel;
  entityIds: string[];
}): Promise<Map<string, MetaConfigSnapshotPayload>> {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0) return new Map();

  try {
    const readiness = await getDbSchemaReadiness({
      tables: ["meta_config_snapshots"],
    });
    if (!readiness.ready) {
      return new Map();
    }
    const sql = getDb();
    const rows = await sql.query<{ entity_id: string; payload: MetaConfigSnapshotPayload }>(
      `
        WITH requested_entities AS (
          SELECT unnest($3::text[]) AS entity_id
        )
        SELECT
          requested_entities.entity_id,
          previous.payload
        FROM requested_entities
        JOIN LATERAL (
          SELECT payload
          FROM meta_config_snapshots
          WHERE business_id = $1
            AND entity_level = $2
            AND entity_id = requested_entities.entity_id
            AND (
              payload->>'bidValue' IS NOT NULL
              OR payload->>'bidStrategyType' IS NOT NULL
              OR payload->>'manualBidAmount' IS NOT NULL
              OR payload->>'bidStrategyLabel' IS NOT NULL
            )
          ORDER BY captured_at DESC
          OFFSET 1
          LIMIT 1
        ) previous ON true
      `,
      [input.businessId, input.entityLevel, entityIds],
    );

    return new Map(
      rows.map((row) => [
        row.entity_id,
        stripIncompleteConstrainedBidFields(normalizeLegacySnapshotPayload(row.payload)),
      ]),
    );
  } catch (error) {
    console.warn("[meta-config-snapshots] read_previous_failed", {
      businessId: input.businessId,
      entityLevel: input.entityLevel,
      message: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

function normalizeLegacySnapshotPayload(payload: MetaConfigSnapshotPayload): MetaConfigSnapshotPayload {
  const bidValue =
    payload.bidValueFormat === "roas"
      ? normalizeTargetRoasValue(payload.bidValue)
      : payload.bidValue;
  return {
    ...payload,
    bidValue,
    bidStrategyLabel:
      payload.bidStrategyLabel ?? formatBidStrategyLabel(payload.bidStrategyType),
    manualBidAmount:
      payload.manualBidAmount ??
      deriveManualBidAmount(bidValue, payload.bidValueFormat),
  };
}

export async function readPreviousDifferentMetaConfigDiffs(input: {
  businessId: string;
  entityLevel: MetaConfigEntityLevel;
  entityIds: string[];
}): Promise<Map<string, MetaPreviousConfigDiff>> {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0) return new Map();

  try {
    const readiness = await getDbSchemaReadiness({
      tables: ["meta_config_snapshots"],
    });
    if (!readiness.ready) {
      return new Map();
    }
    const sql = getDb();
    const rows = (await sql`
      WITH requested_entities AS (
        SELECT unnest(${entityIds}::text[]) AS entity_id
      ),
      latest AS (
        SELECT
          requested_entities.entity_id,
          current_row.captured_at,
          current_row.created_at,
          current_row.payload,
          current_row.daily_budget,
          current_row.lifetime_budget
        FROM requested_entities
        JOIN LATERAL (
          SELECT
            captured_at,
            created_at,
            payload,
            payload->>'dailyBudget' AS daily_budget,
            payload->>'lifetimeBudget' AS lifetime_budget
          FROM meta_config_snapshots
          WHERE business_id = ${input.businessId}
            AND entity_level = ${input.entityLevel}
            AND entity_id = requested_entities.entity_id
            AND (
              payload->>'bidValue' IS NOT NULL
              OR payload->>'bidStrategyType' IS NOT NULL
              OR payload->>'manualBidAmount' IS NOT NULL
              OR payload->>'bidStrategyLabel' IS NOT NULL
              OR payload->>'dailyBudget' IS NOT NULL
              OR payload->>'lifetimeBudget' IS NOT NULL
            )
          ORDER BY captured_at DESC, created_at DESC
          LIMIT 1
        ) current_row ON true
      ),
      latest_bid AS (
        SELECT
          requested_entities.entity_id,
          current_bid.captured_at,
          current_bid.created_at,
          current_bid.bid_value,
          current_bid.bid_value_format
        FROM requested_entities
        LEFT JOIN LATERAL (
          SELECT
            captured_at,
            created_at,
            payload->>'bidValue' AS bid_value,
            payload->>'bidValueFormat' AS bid_value_format
          FROM meta_config_snapshots
          WHERE business_id = ${input.businessId}
            AND entity_level = ${input.entityLevel}
            AND entity_id = requested_entities.entity_id
            AND payload->>'bidValue' IS NOT NULL
          ORDER BY captured_at DESC, created_at DESC
          LIMIT 1
        ) current_bid ON true
      )
      SELECT
        latest.entity_id,
        previous_bid.captured_at AS previous_bid_captured_at,
        previous_bid.payload AS previous_bid_payload,
        previous_budget.captured_at AS previous_budget_captured_at,
        previous_budget.payload AS previous_budget_payload
      FROM latest
      LEFT JOIN latest_bid ON latest_bid.entity_id = latest.entity_id
      LEFT JOIN LATERAL (
        SELECT captured_at, payload
        FROM meta_config_snapshots
        WHERE business_id = ${input.businessId}
          AND entity_level = ${input.entityLevel}
          AND entity_id = latest.entity_id
          AND latest_bid.bid_value IS NOT NULL
          AND payload->>'bidValue' IS NOT NULL
          AND (
            payload->>'bidValue' IS DISTINCT FROM latest_bid.bid_value
            OR payload->>'bidValueFormat' IS DISTINCT FROM latest_bid.bid_value_format
          )
          AND (
            captured_at < latest_bid.captured_at
            OR (captured_at = latest_bid.captured_at AND created_at < latest_bid.created_at)
          )
        ORDER BY captured_at DESC, created_at DESC
        LIMIT 1
      ) previous_bid ON true
      LEFT JOIN LATERAL (
        SELECT captured_at, payload
        FROM meta_config_snapshots
        WHERE business_id = ${input.businessId}
          AND entity_level = ${input.entityLevel}
          AND entity_id = latest.entity_id
          AND (
            payload->>'dailyBudget' IS DISTINCT FROM latest.daily_budget
            OR payload->>'lifetimeBudget' IS DISTINCT FROM latest.lifetime_budget
          )
          AND (
            captured_at < latest.captured_at
            OR (captured_at = latest.captured_at AND created_at < latest.created_at)
          )
        ORDER BY captured_at DESC, created_at DESC
        LIMIT 1
      ) previous_budget ON true
    `) as unknown as Array<{
      entity_id: string;
      previous_bid_captured_at: string | null;
      previous_bid_payload: MetaConfigSnapshotPayload | null;
      previous_budget_captured_at: string | null;
      previous_budget_payload: MetaConfigSnapshotPayload | null;
    }>;

    const result = new Map<string, MetaPreviousConfigDiff>();
    for (const row of rows) {
      const previousBid = row.previous_bid_payload
        ? stripIncompleteConstrainedBidFields(
            normalizeLegacySnapshotPayload(row.previous_bid_payload),
          )
        : null;
      const previousBudget = row.previous_budget_payload
        ? stripIncompleteConstrainedBidFields(
            normalizeLegacySnapshotPayload(row.previous_budget_payload),
          )
        : null;
      result.set(row.entity_id, {
        previousManualBidAmount: previousBid?.manualBidAmount ?? null,
        previousBidValue: previousBid?.bidValue ?? null,
        previousBidValueFormat: previousBid?.bidValueFormat ?? null,
        previousBidCapturedAt: row.previous_bid_captured_at ?? null,
        previousDailyBudget: previousBudget?.dailyBudget ?? null,
        previousLifetimeBudget: previousBudget?.lifetimeBudget ?? null,
        previousBudgetCapturedAt: row.previous_budget_captured_at ?? null,
      });
    }

    return result;
  } catch (error) {
    console.warn("[meta-config-snapshots] read_previous_different_failed", {
      businessId: input.businessId,
      entityLevel: input.entityLevel,
      message: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

export async function appendMetaConfigSnapshots(
  rows: MetaConfigSnapshotInsert[]
): Promise<void> {
  if (rows.length === 0) return;

  try {
    await assertDbSchemaReady({
      tables: ["meta_config_snapshots"],
      context: "meta_config_snapshots:append",
    });
    const sql = getDb();
    const [businessRefIds, providerAccountRefIds] = await Promise.all([
      resolveBusinessReferenceIds(rows.map((row) => row.businessId)),
      ensureProviderAccountReferenceIds({
        provider: "meta",
        accounts: rows.map((row) => ({
          externalAccountId: row.accountId,
        })),
      }),
    ]);
    const payload = JSON.stringify(
      rows.map((row) => ({
        business_id: row.businessId,
        business_ref_id: businessRefIds.get(row.businessId) ?? null,
        account_id: row.accountId,
        provider_account_ref_id: providerAccountRefIds.get(row.accountId) ?? null,
        entity_level: row.entityLevel,
        entity_id: row.entityId,
        payload: sanitizeForJson(
          stripIncompleteConstrainedBidFields(stripDerivedMetaConfigFields(row.payload)),
        ),
      }))
    );

    await sql`
      INSERT INTO meta_config_snapshots (
        business_id,
        business_ref_id,
        account_id,
        provider_account_ref_id,
        entity_level,
        entity_id,
        payload
      )
      SELECT
        item.business_id,
        item.business_ref_id,
        item.account_id,
        item.provider_account_ref_id,
        item.entity_level,
        item.entity_id,
        item.payload
      FROM jsonb_to_recordset(${payload}::jsonb) AS item(
        business_id text,
        business_ref_id uuid,
        account_id text,
        provider_account_ref_id uuid,
        entity_level text,
        entity_id text,
        payload jsonb
      )
      LEFT JOIN LATERAL (
        SELECT existing.payload
        FROM meta_config_snapshots existing
        WHERE existing.business_id = item.business_id
          AND existing.account_id = item.account_id
          AND existing.entity_level = item.entity_level
          AND existing.entity_id = item.entity_id
        ORDER BY existing.captured_at DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE latest.payload IS DISTINCT FROM item.payload
    `;
  } catch (error) {
    console.warn("[meta-config-snapshots] append_failed", {
      rowCount: rows.length,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readMetaBidRegimeHistorySummaries(input: {
  businessId: string;
  entityLevel: MetaConfigEntityLevel;
  entityIds: string[];
}): Promise<Map<string, MetaBidRegimeHistorySummary>> {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0) return new Map();

  try {
    await assertDbSchemaReady({
      tables: ["meta_config_snapshots"],
      context: "meta_config_snapshots:read_bid_regime_history",
    });
    const sql = getDb();
    const rows = (await sql`
      SELECT
        entity_id,
        payload->>'bidStrategyType' AS bid_strategy_type,
        payload->>'bidStrategyLabel' AS bid_strategy_label,
        COUNT(*)::int AS observation_count
      FROM meta_config_snapshots
      WHERE business_id = ${input.businessId}
        AND entity_level = ${input.entityLevel}
        AND entity_id = ANY(${entityIds}::text[])
        AND (
          payload->>'bidStrategyType' IS NOT NULL
          OR payload->>'bidStrategyLabel' IS NOT NULL
        )
      GROUP BY entity_id, payload->>'bidStrategyType', payload->>'bidStrategyLabel'
    `) as unknown as Array<{
      entity_id: string;
      bid_strategy_type: string | null;
      bid_strategy_label: string | null;
      observation_count: number | string;
    }>;

    const grouped = new Map<string, Array<{ count: number; type: string | null; label: string | null }>>();
    for (const row of rows) {
      const type = row.bid_strategy_type ?? null;
      const label = row.bid_strategy_label ?? formatBidStrategyLabel(type);
      const count = Number(row.observation_count ?? 0);
      if (!type && !label) continue;
      if (!Number.isFinite(count) || count <= 0) continue;
      grouped.set(row.entity_id, [...(grouped.get(row.entity_id) ?? []), { count, type, label }]);
    }

    const result = new Map<string, MetaBidRegimeHistorySummary>();
    for (const entityId of entityIds) {
      const history = grouped.get(entityId) ?? [];
      if (history.length === 0) continue;

      let constrainedCount = 0;
      let openCount = 0;
      let observationCount = 0;

      for (const { count, type } of history) {
        observationCount += count;
        if (type === "lowest_cost") openCount += count;
        if (type === "manual_bid" || type === "bid_cap" || type === "cost_cap" || type === "target_roas") {
          constrainedCount += count;
        }
      }

      const dominant = history.sort((a, b) => b.count - a.count)[0];
      result.set(entityId, {
        dominantBidStrategyType: dominant?.type ?? null,
        dominantBidStrategyLabel: dominant?.label ?? null,
        observationCount,
        constrainedShare: observationCount > 0 ? constrainedCount / observationCount : 0,
        openShare: observationCount > 0 ? openCount / observationCount : 0,
      });
    }

    return result;
  } catch (error) {
    console.warn("[meta-config-snapshots] read_bid_regime_history_failed", {
      businessId: input.businessId,
      entityLevel: input.entityLevel,
      message: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}
