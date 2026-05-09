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

function valuesEqual(left: number | string | null | undefined, right: number | string | null | undefined) {
  return (left ?? null) === (right ?? null);
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

function isInformativePayload(payload: MetaConfigSnapshotPayload) {
  return (
    payload.bidValue != null ||
    payload.bidStrategyType != null ||
    payload.manualBidAmount != null ||
    payload.bidStrategyLabel != null ||
    payload.dailyBudget != null ||
    payload.lifetimeBudget != null
  );
}

function hasBidValue(payload: MetaConfigSnapshotPayload) {
  return payload.bidValue != null;
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
      SELECT entity_id, captured_at, payload
      FROM meta_config_snapshots
      WHERE business_id = ${input.businessId}
        AND entity_level = ${input.entityLevel}
        AND entity_id = ANY(${entityIds}::text[])
      ORDER BY entity_id ASC, captured_at DESC
    `) as unknown as Array<{
      entity_id: string;
      captured_at: string;
      payload: MetaConfigSnapshotPayload;
    }>;

    const byEntity = new Map<string, Array<{ capturedAt: string; payload: MetaConfigSnapshotPayload }>>();
    for (const row of rows) {
      const payload = stripIncompleteConstrainedBidFields(
        normalizeLegacySnapshotPayload(row.payload),
      );
      if (!isInformativePayload(payload)) continue;
      const existing = byEntity.get(row.entity_id) ?? [];
      existing.push({
        capturedAt: row.captured_at,
        payload,
      });
      byEntity.set(row.entity_id, existing);
    }

    const result = new Map<string, MetaPreviousConfigDiff>();

    for (const entityId of entityIds) {
      const history = byEntity.get(entityId) ?? [];
      const current = history[0]?.payload;
      if (!current) continue;
      const currentBidIndex = history.findIndex((row) => hasBidValue(row.payload));
      const currentBid = currentBidIndex >= 0 ? history[currentBidIndex]?.payload : null;

      let previousBid: { payload: MetaConfigSnapshotPayload; capturedAt: string } | null = null;
      let previousBudget: { payload: MetaConfigSnapshotPayload; capturedAt: string } | null = null;

      for (const row of currentBidIndex >= 0 ? history.slice(currentBidIndex + 1) : []) {
        if (
          previousBid == null &&
          currentBid != null &&
          hasBidValue(row.payload) &&
          (
            !valuesEqual(row.payload.bidValue, currentBid.bidValue) ||
            !valuesEqual(row.payload.bidValueFormat, currentBid.bidValueFormat)
          )
        ) {
          previousBid = row;
        }
        if (previousBid) break;
      }

      for (const row of history.slice(1)) {
        if (
          previousBudget == null &&
          (
            !valuesEqual(row.payload.dailyBudget, current.dailyBudget) ||
            !valuesEqual(row.payload.lifetimeBudget, current.lifetimeBudget)
          )
        ) {
          previousBudget = row;
        }

        if (previousBid && previousBudget) break;
      }

      result.set(entityId, {
        previousManualBidAmount: previousBid?.payload.manualBidAmount ?? null,
        previousBidValue: previousBid?.payload.bidValue ?? null,
        previousBidValueFormat: previousBid?.payload.bidValueFormat ?? null,
        previousBidCapturedAt: previousBid?.capturedAt ?? null,
        previousDailyBudget: previousBudget?.payload.dailyBudget ?? null,
        previousLifetimeBudget: previousBudget?.payload.lifetimeBudget ?? null,
        previousBudgetCapturedAt: previousBudget?.capturedAt ?? null,
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
      SELECT entity_id, payload
      FROM meta_config_snapshots
      WHERE business_id = ${input.businessId}
        AND entity_level = ${input.entityLevel}
        AND entity_id = ANY(${entityIds}::text[])
      ORDER BY entity_id ASC, captured_at DESC
    `) as unknown as Array<{
      entity_id: string;
      payload: MetaConfigSnapshotPayload;
    }>;

    const grouped = new Map<string, MetaConfigSnapshotPayload[]>();
    for (const row of rows) {
      const payload = normalizeLegacySnapshotPayload(row.payload);
      if (!payload.bidStrategyType && !payload.bidStrategyLabel) continue;
      grouped.set(row.entity_id, [...(grouped.get(row.entity_id) ?? []), payload]);
    }

    const result = new Map<string, MetaBidRegimeHistorySummary>();
    for (const entityId of entityIds) {
      const history = grouped.get(entityId) ?? [];
      if (history.length === 0) continue;

      const counts = new Map<string, { count: number; type: string | null; label: string | null }>();
      let constrainedCount = 0;
      let openCount = 0;

      for (const payload of history) {
        const type = payload.bidStrategyType ?? null;
        const label = payload.bidStrategyLabel ?? formatBidStrategyLabel(type);
        const key = `${type ?? "null"}|${label ?? "null"}`;
        const existing = counts.get(key) ?? { count: 0, type, label };
        existing.count += 1;
        counts.set(key, existing);

        if (type === "lowest_cost") openCount += 1;
        if (type === "manual_bid" || type === "bid_cap" || type === "cost_cap" || type === "target_roas") {
          constrainedCount += 1;
        }
      }

      const dominant = [...counts.values()].sort((a, b) => b.count - a.count)[0];
      const observationCount = history.length;
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
