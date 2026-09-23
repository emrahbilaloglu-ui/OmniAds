import { getDb } from "@/lib/db";
import { resolveMetaProviderLocalDayEnd } from "@/lib/meta/provider-local-day";
import {
  assertDbSchemaReady,
  getDbSchemaReadiness,
  isMissingRelationError,
} from "@/lib/db-schema-readiness";
import {
  deriveManualBidAmount,
  formatBidStrategyLabel,
  stripIncompleteConstrainedBidFields,
  stripDerivedMetaConfigFields,
  type MetaConfigSnapshotPayload,
} from "@/lib/meta/configuration";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";

export type MetaConfigEntityLevel = "campaign" | "adset";

export interface MetaConfigSnapshotObservation {
  id: string;
  accountId: string;
  accountTimezone?: string;
  capturedAt: string;
  sourceKind?: "meta_config_snapshots" | "meta_raw_snapshots";
  providerObservation: MetaConfigSnapshotPayload["providerObservation"] | null;
}

interface MetaConfigSnapshotInsert {
  businessId: string;
  accountId: string;
  entityLevel: MetaConfigEntityLevel;
  entityId: string;
  payload: MetaConfigSnapshotPayload;
  providerObservation?: NonNullable<MetaConfigSnapshotPayload["providerObservation"]>;
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
  providerAccountId: string;
  entityLevel: MetaConfigEntityLevel;
  entityIds: string[];
  /** Provider-local reporting day. Without this, the result is current only. */
  asOfDay?: string;
  /** Historical repair accepts only receipts linked to a raw provider response. */
  requireProviderReceipt?: boolean;
  /** Source identity for audited historical repair; never changes the payload. */
  onObservation?: (entityId: string, source: MetaConfigSnapshotObservation) => void;
}): Promise<Map<string, MetaConfigSnapshotPayload>> {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0 || !input.providerAccountId?.trim()) return new Map();

  // A snapshot captured after a historical reporting day cannot describe that
  // day's configuration. Resolve the account's own day boundary, failing closed
  // when its timezone is not available rather than using the server timezone.
  const capturedBefore = input.asOfDay
    ? await resolveMetaProviderLocalDayEnd({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        day: input.asOfDay,
        query: (query, params) => getDb().query(query, params),
      }).catch(() => null)
    : null;
  if (input.asOfDay && !capturedBefore) return new Map();

  try {
    const readiness = await getDbSchemaReadiness({
      tables: ["meta_config_snapshots"],
    });
    if (!readiness.ready) {
      return new Map();
    }
    const sql = getDb();
    const rows = await sql.query<{
      entity_id: string;
      id: string;
      captured_at: Date | string;
      payload: MetaConfigSnapshotPayload;
    }>(
      `
        WITH requested_entities AS (
          SELECT unnest($4::text[]) AS entity_id
        )
        SELECT
          requested_entities.entity_id,
          latest.id,
          latest.captured_at,
          latest.payload
        FROM requested_entities
        JOIN LATERAL (
          SELECT id, captured_at, payload
          FROM meta_config_snapshots
          WHERE business_id = $1
            AND entity_level = $2
            AND account_id = $3
            AND entity_id = requested_entities.entity_id
            AND ($5::timestamptz IS NULL OR captured_at < $5::timestamptz)
            AND (
              NOT $6::boolean
              OR (
                payload->'providerObservation'->>'kind' = 'provider_config_receipt'
                AND payload->'providerObservation'->>'normalizationVersion' = '2'
                AND NULLIF(payload->'providerObservation'->>'sourceSnapshotId', '') IS NOT NULL
              )
            )
          ORDER BY captured_at DESC, created_at DESC
          LIMIT 1
        ) latest ON true
      `,
      [input.businessId, input.entityLevel, input.providerAccountId, entityIds, capturedBefore?.toISOString() ?? null, Boolean(input.requireProviderReceipt)],
    );

    return new Map(rows.map((row) => {
      if (row.id && row.captured_at) {
        input.onObservation?.(row.entity_id, {
          id: row.id,
          accountId: input.providerAccountId,
          capturedAt: new Date(row.captured_at).toISOString(),
          sourceKind: "meta_config_snapshots",
          providerObservation: row.payload.providerObservation ?? null,
        });
      }
      return [
        row.entity_id,
        stripIncompleteConstrainedBidFields(normalizeLegacySnapshotPayload(row.payload)),
      ] as const;
    }));
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
  /*
    A stored `bidValueFormat: "roas"` value is ALREADY a plain multiplier:
    `buildConfigSnapshotPayload` divides Meta's scaled integer down once, at
    capture. This branch used to run that divisor a SECOND time on the way
    back out, which is a read of stored data that changes what the stored data
    means. It was invisible only because the old magnitude guess made a second
    pass a no-op below 100 — every retained ROAS row in the warehouse is inside
    that range today, so no served number moves as a result of removing it.

    The payload is passed through unchanged. Nothing else here reads `bidValue`
    numerically; `deriveManualBidAmount` keys on `bidValueFormat`.
  */
  const bidValue = payload.bidValue;
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
  providerAccountId: string;
  entityLevel: MetaConfigEntityLevel;
  entityIds: string[];
}): Promise<Map<string, MetaPreviousConfigDiff>> {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0 || !input.providerAccountId?.trim()) return new Map();

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
            AND account_id = ${input.providerAccountId}
            AND entity_level = ${input.entityLevel}
            AND entity_id = requested_entities.entity_id
            AND payload->'providerObservation'->>'kind' = 'provider_config_receipt'
            AND payload->'providerObservation'->>'normalizationVersion' = '2'
            AND NULLIF(payload->'providerObservation'->>'sourceSnapshotId', '') IS NOT NULL
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
            AND account_id = ${input.providerAccountId}
            AND entity_level = ${input.entityLevel}
            AND entity_id = requested_entities.entity_id
            AND payload->'providerObservation'->>'kind' = 'provider_config_receipt'
            AND payload->'providerObservation'->>'normalizationVersion' = '2'
            AND NULLIF(payload->'providerObservation'->>'sourceSnapshotId', '') IS NOT NULL
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
          AND account_id = ${input.providerAccountId}
          AND entity_level = ${input.entityLevel}
          AND entity_id = latest.entity_id
          AND payload->'providerObservation'->>'kind' = 'provider_config_receipt'
          AND payload->'providerObservation'->>'normalizationVersion' = '2'
          AND NULLIF(payload->'providerObservation'->>'sourceSnapshotId', '') IS NOT NULL
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
          AND account_id = ${input.providerAccountId}
          AND entity_level = ${input.entityLevel}
          AND entity_id = latest.entity_id
          AND payload->'providerObservation'->>'kind' = 'provider_config_receipt'
          AND payload->'providerObservation'->>'normalizationVersion' = '2'
          AND NULLIF(payload->'providerObservation'->>'sourceSnapshotId', '') IS NOT NULL
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
        captured_at: row.providerObservation?.observedAt ?? null,
        payload: sanitizeForJson({
          ...stripIncompleteConstrainedBidFields(stripDerivedMetaConfigFields(row.payload)),
          ...(row.providerObservation ? { providerObservation: row.providerObservation } : {}),
        }),
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
        captured_at,
        payload
      )
      SELECT
        item.business_id,
        item.business_ref_id,
        item.account_id,
        item.provider_account_ref_id,
        item.entity_level,
        item.entity_id,
        COALESCE(item.captured_at, now()),
        item.payload
      FROM jsonb_to_recordset(${payload}::jsonb) AS item(
        business_id text,
        business_ref_id uuid,
        account_id text,
        provider_account_ref_id uuid,
        entity_level text,
        entity_id text,
        captured_at timestamptz,
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
      WHERE (latest.payload - 'providerObservation') IS DISTINCT FROM (item.payload - 'providerObservation')
         OR (
           item.payload->'providerObservation'->>'kind' = 'provider_config_receipt'
           AND (
             latest.payload->'providerObservation'->>'kind' IS DISTINCT FROM
               item.payload->'providerObservation'->>'kind'
             OR latest.payload->'providerObservation'->>'normalizationVersion' IS DISTINCT FROM
               item.payload->'providerObservation'->>'normalizationVersion'
           )
         )
    `;
  } catch (error) {
    // A schema that is not ready yet is a deployment state, not a failure: the
    // migration has not run, and skipping is the correct behaviour.
    if (isMissingRelationError(error, ["meta_config_snapshots"])) {
      console.warn("[meta-config-snapshots] append_skipped_schema_not_ready", {
        rowCount: rows.length,
      });
      return;
    }
    // Everything else propagates. This used to warn and return, so a write that
    // silently failed left the caller believing configuration evidence had been
    // recorded — and every later comparison against "the previous config" was
    // then made against a row that was never written.
    console.error("[meta-config-snapshots] append_failed", {
      rowCount: rows.length,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * The bid-regime history behind a served recommendation.
 *
 * ── ROUND 9 ITEM 6 ─────────────────────────────────────────────────────────
 * This filtered on `business_id` and `entity_level` alone — no `account_id`,
 * no time bound — and its output raises a recommendation's confidence and can
 * carry it into the `act` lane. Two ways that was wrong:
 *
 *   - A business with several Meta accounts pooled all of them, so one
 *     account's constrained/open share described another's entity.
 *   - The whole history was read regardless of the window being served, so a
 *     request for a range ending in March counted snapshots captured in
 *     September. A "high confidence" act was built from evidence recorded
 *     after the decision it justifies.
 *
 * Both are required now, and an unusable scope or an unreadable table returns
 * an EMPTY map — which the caller already treats as "no history", so the
 * recommendation loses the confidence rather than gaining it from the wrong
 * rows.
 */
export async function readMetaBidRegimeHistorySummaries(input: {
  businessId: string;
  providerAccountId: string;
  /** Inclusive `YYYY-MM-DD`; the advertiser-local day the window ends on. */
  capturedAtCutoff: string;
  entityLevel: MetaConfigEntityLevel;
  entityIds: string[];
}): Promise<Map<string, MetaBidRegimeHistorySummary>> {
  const entityIds = Array.from(new Set(input.entityIds.filter(Boolean)));
  if (entityIds.length === 0) return new Map();
  const providerAccountId = input.providerAccountId?.trim() ?? "";
  if (!providerAccountId) return new Map();
  /*
    ROUND 10 ITEM 4. Resolved to an absolute instant from the ACCOUNT's own IANA
    timezone; a null zone or binding answers with an empty map, which the caller
    already reads as "no history". This signal can only raise a
    recommendation's confidence, so an unresolvable window must not produce one.
  */
  const capturedBefore = await resolveMetaProviderLocalDayEnd({
    businessId: input.businessId,
    providerAccountId,
    day: input.capturedAtCutoff ?? "",
    query: (text, params) => getDb().query(text, params),
  }).catch(() => null);
  if (!capturedBefore) return new Map();

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
        AND account_id = ${providerAccountId}
        AND captured_at < ${capturedBefore.toISOString()}::timestamptz
        AND entity_level = ${input.entityLevel}
        AND entity_id = ANY(${entityIds}::text[])
        AND payload->'providerObservation'->>'kind' = 'provider_config_receipt'
        AND payload->'providerObservation'->>'normalizationVersion' = '2'
        AND NULLIF(payload->'providerObservation'->>'sourceSnapshotId', '') IS NOT NULL
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
