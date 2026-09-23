import { getDb } from "@/lib/db";
import { isDeepStrictEqual } from "node:util";
import { buildConfigSnapshotPayload, type MetaConfigSnapshotPayload } from "@/lib/meta/configuration";
import { CORROBORATION_HORIZON_DAYS } from "@/lib/meta/config-field-source-contract";
import {
  providerLocalDayEndExclusive,
  providerLocalDayStartInclusive,
  readMetaAccountTimeZones,
} from "@/lib/meta/provider-local-day";

export type RawConfigLevel = "campaign" | "adset";

export interface DatedRawConfigReceipt {
  payload: MetaConfigSnapshotPayload;
  source: {
    kind: "meta_raw_snapshots";
    /** The CANONICAL CONTENT id. Shared by every re-read of that content. */
    id: string;
    /**
     * The RECEIPT id: one real provider GET.
     *
     * `meta_raw_snapshot_observations` keys receipt identity on
     * `(snapshot_id, partition, run, checkpoint, page, cursor, status,
     * observed_at)` (lib/migrations.ts), so every distinct observation INSTANT
     * is its own row while the canonical payload is shared and deduplicated.
     * Two receipts of unchanged content therefore share `id` and differ here —
     * measured: 211 observations on Silveristic's snapshot
     * `0d629df6…`, spanning 24 hours.
     *
     * NULL only for a legacy snapshot-only receipt, which has no observation
     * row at all.
     */
    observationId: string | null;
    observedAt: string;
    entityUpdatedAt: string;
    corroboratingSourceSnapshotId: string;
    /** The day-closing witness's receipt id; see `observationId`. */
    corroboratingObservationId: string | null;
    corroboratingObservedAt: string;
    accountTimezone: string;
    fieldScope: string[];
    observedFieldScope: string[];
    normalizationVersion: 2;
  };
}

type DatedRawConfigRow = {
  entity_id: string;
  entity_json: Record<string, unknown>;
  snapshot_id: string;
  /** One real provider GET. NULL for a legacy snapshot with no observation. */
  observation_id: string | null;
  observed_at: Date | string | null;
  /** Aggregate receipt clock, used only to REFUSE an untimed later page. */
  receipt_observed_at?: Date | string | null;
  request_context: Record<string, unknown>;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** A provider mutation clock without an offset cannot date a local report day. */
function providerInstantMs(value: unknown): number | null {
  const instant = optionalText(value);
  const match = instant?.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/,
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 ||
      day < 1 || day > daysInMonth[month - 1]!) {
    return null;
  }
  const parsed = Date.parse(instant!);
  return Number.isFinite(parsed) ? parsed : null;
}

function receiptInstantMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function rowFieldScope(row: DatedRawConfigRow): string[] {
  const pagination = row.request_context.pagination &&
    typeof row.request_context.pagination === "object" &&
    !Array.isArray(row.request_context.pagination)
      ? row.request_context.pagination as Record<string, unknown>
      : {};
  return effectiveDatedConfigFieldScope(
    row.request_context.fields, pagination.fieldDegradation,
  );
}

function observedField(row: DatedRawConfigRow, field: string): boolean {
  return rowFieldScope(row).some((requested) =>
    requested.split(/[({]/, 1)[0] === field,
  ) && Object.hasOwn(row.entity_json, field);
}

/**
 * A newer response may have dropped ONE optional field to complete. Recover the
 * older response for that field only when every intervening response still
 * observed the SAME provider mutation clock and did not ask for that field.
 * A requested-but-absent field is an observed absence, never permission to
 * carry an older value. Keep one raw source identity per returned payload.
 */
function earlierOmittedFieldReceipt(input: {
  level: RawConfigLevel;
  rows: DatedRawConfigRow[];
  newest: DatedRawConfigRow;
  dayStartMs: number;
}): { row: DatedRawConfigRow; fields: string[] } | null {
  const targets = input.level === "campaign"
    ? ["objective"]
    : ["optimization_goal", "promoted_object"];
  const newestClock = optionalText(input.newest.entity_json.updated_time);
  if (!newestClock || providerInstantMs(newestClock) === null ||
      !observedField(input.newest, "updated_time")) return null;
  const newestAt = receiptInstantMs(input.newest.observed_at);
  if (newestAt === null) return null;
  for (const field of targets) {
    // The latest response did ask: a missing value is evidence of absence.
    if (rowFieldScope(input.newest).some((requested) =>
      requested.split(/[({]/, 1)[0] === field,
    )) continue;
    for (const earlier of input.rows) {
      const earlierAt = receiptInstantMs(earlier.observed_at);
      if (earlierAt === null || earlierAt >= newestAt ||
          !observedField(earlier, field) ||
          !observedField(earlier, "updated_time") ||
          optionalText(earlier.entity_json.updated_time) !== newestClock ||
          providerInstantMs(earlier.entity_json.updated_time) === null ||
          providerInstantMs(earlier.entity_json.updated_time)! > input.dayStartMs) {
        continue;
      }
      const intervening = input.rows.filter((candidate) => {
        const candidateAt = receiptInstantMs(candidate.observed_at) ??
          receiptInstantMs(candidate.receipt_observed_at);
        return candidateAt !== null && candidateAt > earlierAt;
      });
      if (intervening.some((candidate) => {
        const candidateAt = receiptInstantMs(candidate.observed_at);
        // A merged response cannot date this entity's page: it can never be
        // skipped on the way to an older observation.
        if (candidateAt === null) return true;
        if (!observedField(candidate, "updated_time") ||
            optionalText(candidate.entity_json.updated_time) !== newestClock) return true;
        return rowFieldScope(candidate).some((requested) =>
          requested.split(/[({]/, 1)[0] === field,
        );
      })) continue;
      const selectedFields = rowFieldScope(earlier).filter((requested) =>
        ["id", "updated_time", field].includes(requested.split(/[({]/, 1)[0]!),
      );
      return { row: earlier, fields: selectedFields };
    }
  }
  return null;
}

/** Graph field selectors can contain commas inside a nested expansion. */
export function splitMetaConfigFieldScope(fields: unknown): string[] {
  if (typeof fields !== "string") return [];
  const result: string[] = [];
  let part = "";
  let depth = 0;
  for (const char of fields) {
    if (char === "{" || char === "(") depth++;
    else if (char === "}" || char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      if (part.trim()) result.push(part.trim());
      part = "";
    } else {
      part += char;
    }
  }
  if (part.trim()) result.push(part.trim());
  return depth === 0 ? result : [];
}

function droppedConfigFieldNames(value: unknown): string[] | null {
  if (Array.isArray(value) && value.every((field) => typeof field === "string")) {
    return value.map((field) => field.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((field) => field.trim()).filter(Boolean);
  }
  return null;
}

/** A recovered request without a readable dropped-field list proves no selector. */
export function effectiveDatedConfigFieldScope(
  fields: unknown,
  degradation: unknown,
): string[] {
  const requested = splitMetaConfigFieldScope(fields);
  if (!degradation || typeof degradation !== "object" || Array.isArray(degradation)) {
    return requested;
  }
  const record = degradation as Record<string, unknown>;
  if (record.recovered !== true && record.recovered !== "true") return requested;
  const dropped = droppedConfigFieldNames(record.droppedFields);
  if (!dropped) return [];
  const droppedSet = new Set(dropped);
  return requested.filter((field) => !droppedSet.has(field.split(/[({]/, 1)[0]!));
}

export function normalizeDatedRawConfig(input: {
  level: RawConfigLevel;
  row: unknown;
  fields: unknown;
  droppedFields?: unknown;
}): MetaConfigSnapshotPayload | null {
  if (!input.row || typeof input.row !== "object" || Array.isArray(input.row)) return null;
  const record = input.row as Record<string, unknown>;
  const id = optionalText(record.id);
  if (!id) return null;
  const dropped = droppedConfigFieldNames(input.droppedFields) ?? [];
  const fieldScope = splitMetaConfigFieldScope(input.fields).filter(
    (field) => !dropped.includes(field.split("{")[0]!),
  );
  const fieldNames = new Set(fieldScope.map((field) => field.split("{")[0]!));
  if (!fieldNames.has("id")) return null;
  if (input.level === "campaign") {
    if (!["objective", "bid_strategy", "bid_amount", "daily_budget", "lifetime_budget"]
      .some((field) => fieldNames.has(field) && Object.hasOwn(record, field))) return null;
    return buildConfigSnapshotPayload({
      campaignId: id,
      objective: fieldNames.has("objective") ? optionalText(record.objective) : null,
      bidStrategy: fieldNames.has("bid_strategy") ? optionalText(record.bid_strategy) : null,
      manualBidAmount: fieldNames.has("bid_amount") ? optionalNumber(record.bid_amount) : null,
      dailyBudget: fieldNames.has("daily_budget") ? optionalNumber(record.daily_budget) : null,
      lifetimeBudget: fieldNames.has("lifetime_budget") ? optionalNumber(record.lifetime_budget) : null,
    });
  }
  const promoted = record.promoted_object && typeof record.promoted_object === "object" &&
    !Array.isArray(record.promoted_object)
    ? record.promoted_object as Record<string, unknown>
    : null;
  const constraints = record.bid_constraints && typeof record.bid_constraints === "object" &&
    !Array.isArray(record.bid_constraints)
    ? record.bid_constraints as Record<string, unknown>
    : null;
  if (!["optimization_goal", "promoted_object", "bid_strategy", "bid_amount",
    "bid_constraints", "daily_budget", "lifetime_budget"]
    .some((field) => fieldNames.has(field) && Object.hasOwn(record, field))) return null;
  return buildConfigSnapshotPayload({
    campaignId: fieldNames.has("campaign_id") ? optionalText(record.campaign_id) : null,
    optimizationGoal: fieldNames.has("optimization_goal") ? optionalText(record.optimization_goal) : null,
    customEventType: fieldNames.has("promoted_object") ? optionalText(promoted?.custom_event_type) : null,
    pixelId: fieldNames.has("promoted_object") ? optionalText(promoted?.pixel_id) : null,
    customConversionId: fieldNames.has("promoted_object") ? optionalText(promoted?.custom_conversion_id) : null,
    promotedObject: fieldNames.has("promoted_object") ? promoted : null,
    bidStrategy: fieldNames.has("bid_strategy") ? optionalText(record.bid_strategy) : null,
    manualBidAmount: fieldNames.has("bid_amount") ? optionalNumber(record.bid_amount) : null,
    targetRoas: fieldNames.has("bid_constraints") ? optionalNumber(constraints?.roas_average_floor) : null,
    dailyBudget: fieldNames.has("daily_budget") ? optionalNumber(record.daily_budget) : null,
    lifetimeBudget: fieldNames.has("lifetime_budget") ? optionalNumber(record.lifetime_budget) : null,
  });
}

/**
 * Reconstruct only configuration actually observed on the provider-local day.
 * `start_date`/`end_date` on legacy raw snapshots are ignored: historical sync
 * once stamped a current inventory response with an old report date.
 */
export async function readDatedRawConfigReceipts(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  level: RawConfigLevel;
  entityIds: string[];
}): Promise<Map<string, DatedRawConfigReceipt>> {
  const entityIds = [...new Set(input.entityIds.filter(Boolean))];
  if (entityIds.length === 0) return new Map();
  const sql = getDb();
  const timeZone = (await readMetaAccountTimeZones({
    businessId: input.businessId,
    providerAccountIds: [input.providerAccountId],
    query: (query, params) => sql.query(query, params),
  })).get(input.providerAccountId);
  if (!timeZone) return new Map();
  const start = providerLocalDayStartInclusive({ day: input.day, timeZone });
  const end = providerLocalDayEndExclusive({ day: input.day, timeZone });
  if (!start || !end) return new Map();
  const endpointName = input.level === "campaign" ? "campaign_configs" : "adset_configs";
  const rows = await sql.query<DatedRawConfigRow>(`
    WITH observed AS (
      SELECT observation.id AS observation_id,
             observation.snapshot_id, observation.observed_at,
             observation.request_context
      FROM meta_raw_snapshot_observations observation
      WHERE observation.business_id = $1
        AND observation.provider_account_id = $2
        AND observation.endpoint_name = $3
        AND observation.entity_scope = $7
        AND observation.status = 'fetched'
        AND observation.provider_http_status = 200
        AND observation.observed_at >= $4::timestamptz - interval '1 day'
        AND observation.observed_at < $5::timestamptz + interval '1 day'
      UNION ALL
      /* Legacy snapshot-only receipts have no observation row, so no receipt
         identity of their own. NULL says exactly that, and the corroboration
         walk treats an unknown identity as possibly-the-same. */
      SELECT NULL::uuid AS observation_id,
             snapshot.id, snapshot.fetched_at, snapshot.request_context
      FROM meta_raw_snapshots snapshot
      WHERE snapshot.business_id = $1
        AND snapshot.provider_account_id = $2
        AND snapshot.endpoint_name = $3
        AND snapshot.entity_scope = $7
        AND snapshot.status = 'fetched'
        AND snapshot.provider_http_status = 200
        AND snapshot.fetched_at >= $4::timestamptz - interval '1 day'
        AND snapshot.fetched_at < $5::timestamptz + interval '1 day'
        AND NOT EXISTS (
          SELECT 1 FROM meta_raw_snapshot_observations observation
          WHERE observation.snapshot_id = snapshot.id
        )
    ), valid AS (
      SELECT observed.observation_id, observed.snapshot_id, observed.observed_at,
             observed.request_context, snapshot.payload_json
      FROM observed
      JOIN meta_raw_snapshots snapshot ON snapshot.id = observed.snapshot_id
        AND snapshot.business_id = $1
        AND snapshot.provider_account_id = $2
        AND snapshot.endpoint_name = $3
        AND snapshot.entity_scope = $7
      WHERE observed.request_context->'pagination'->>'complete' = 'true'
        AND observed.request_context->'pagination'->>'termination' = 'natural_end'
        AND jsonb_typeof(snapshot.payload_json) = 'array'
        AND NULLIF(observed.request_context->>'fields', '') IS NOT NULL
    )
    SELECT entity.entity_json->>'id' AS entity_id,
           entity.entity_json, valid.snapshot_id::text AS snapshot_id,
           valid.observation_id::text AS observation_id,
           entity_observation.observed_at,
           valid.observed_at AS receipt_observed_at, valid.request_context
    FROM valid
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(valid.payload_json) = 'array'
        THEN valid.payload_json ELSE '[]'::jsonb END
    ) AS entity(entity_json)
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN jsonb_typeof(valid.request_context->'rowObservedAtByEntityId') = 'object'
          THEN CASE WHEN
            (valid.request_context->'rowObservedAtByEntityId'->>(entity.entity_json->>'id'))
              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
            AND pg_input_is_valid(
              valid.request_context->'rowObservedAtByEntityId'->>(entity.entity_json->>'id'),
              'timestamp with time zone'
            )
            THEN (valid.request_context->'rowObservedAtByEntityId'->>(entity.entity_json->>'id'))::timestamptz
            ELSE NULL END
        WHEN valid.request_context->'pagination'->>'pageCount' = '1'
          THEN valid.observed_at
        ELSE NULL
      END AS observed_at
    ) entity_observation
    WHERE entity.entity_json->>'id' = ANY($6::text[])
      AND (
        (entity_observation.observed_at >= $4::timestamptz
         AND entity_observation.observed_at < $5::timestamptz)
        -- An untimed later page must be visible to the application guard. If
        -- dropped here, an older timed row could falsely prove the whole day.
        OR entity_observation.observed_at IS NULL
      )
    ORDER BY entity.entity_json->>'id',
             COALESCE(entity_observation.observed_at, valid.observed_at) DESC,
             valid.snapshot_id DESC
  `, [input.businessId, input.providerAccountId, endpointName,
    start.toISOString(), end.toISOString(), entityIds, input.level]);
  const result = new Map<string, DatedRawConfigReceipt>();
  const candidateRawRows = new Map<string, Record<string, unknown>>();
  const rowsByEntity = new Map<string, DatedRawConfigRow[]>();
  for (const row of rows) {
    const grouped = rowsByEntity.get(row.entity_id) ?? [];
    grouped.push(row);
    rowsByEntity.set(row.entity_id, grouped);
  }
  for (const [entityId, entityRows] of rowsByEntity) {
    entityRows.sort((a, b) =>
      (receiptInstantMs(b.observed_at) ?? receiptInstantMs(b.receipt_observed_at) ?? -Infinity) -
      (receiptInstantMs(a.observed_at) ?? receiptInstantMs(a.receipt_observed_at) ?? -Infinity),
    );
    const newest = entityRows[0]!;
    const newestAt = receiptInstantMs(newest.observed_at);
    // If the latest possible page has no own clock, neither it nor an older
    // response can establish what this entity held through the reporting day.
    if (newestAt === null || newestAt < start.getTime() || newestAt >= end.getTime()) continue;
    const recovered = earlierOmittedFieldReceipt({
      level: input.level, rows: entityRows, newest, dayStartMs: start.getTime(),
    });
    const row = recovered?.row ?? newest;
    // A same-day observation alone does not prove a full day's configuration.
    // The provider's own entity update time must predate the day boundary; a
    // config changed during the reporting day cannot be assigned to its whole
    // aggregate metric row.
    const entityUpdatedAt = optionalText(row.entity_json.updated_time);
    const updateTime = providerInstantMs(entityUpdatedAt);
    if (!entityUpdatedAt || updateTime === null || updateTime > start.getTime()) continue;
    const fieldScope = recovered?.fields ?? rowFieldScope(row);
    if (!fieldScope.includes("updated_time")) continue;
    const payload = normalizeDatedRawConfig({
      level: input.level, row: row.entity_json, fields: fieldScope.join(","),
    });
    if (!payload) continue;
    candidateRawRows.set(entityId, row.entity_json);
    result.set(entityId, {
      payload,
      source: {
        kind: "meta_raw_snapshots",
        id: row.snapshot_id,
        observationId: row.observation_id ?? null,
        observedAt: new Date(row.observed_at!).toISOString(),
        entityUpdatedAt,
        corroboratingSourceSnapshotId: "",
        corroboratingObservationId: null,
        corroboratingObservedAt: "",
        accountTimezone: timeZone,
        fieldScope,
        observedFieldScope: fieldScope.filter((field) =>
          Object.hasOwn(row.entity_json, field.split(/[({]/, 1)[0]!),
        ),
        normalizationVersion: 2,
      },
    });
  }
  if (result.size === 0) return result;

  // A response during the report day cannot establish what happened after it.
  // Walk every complete later response in time order. A field dropped from one
  // request may be corroborated by the next request for that field, but an
  // intervening changed/missing mutation clock or observed contradiction ends
  // its lineage. Never combine values from different raw source identities.
  const laterRows = await sql.query<DatedRawConfigRow>(`
    WITH observed AS (
      SELECT observation.id AS observation_id,
             observation.snapshot_id, observation.observed_at,
             observation.request_context
      FROM meta_raw_snapshot_observations observation
      WHERE observation.business_id = $1
        AND observation.provider_account_id = $2
        AND observation.endpoint_name = $3
        AND observation.entity_scope = $6
        AND observation.status = 'fetched'
        AND observation.provider_http_status = 200
        AND observation.observed_at >= $4::timestamptz - interval '1 day'
        AND observation.observed_at < $4::timestamptz + interval '${CORROBORATION_HORIZON_DAYS + 1} days'
      UNION ALL
      /* Legacy snapshot-only receipts have no observation row, so no receipt
         identity of their own. NULL says exactly that, and the corroboration
         walk treats an unknown identity as possibly-the-same. */
      SELECT NULL::uuid AS observation_id,
             snapshot.id, snapshot.fetched_at, snapshot.request_context
      FROM meta_raw_snapshots snapshot
      WHERE snapshot.business_id = $1
        AND snapshot.provider_account_id = $2
        AND snapshot.endpoint_name = $3
        AND snapshot.entity_scope = $6
        AND snapshot.status = 'fetched'
        AND snapshot.provider_http_status = 200
        AND snapshot.fetched_at >= $4::timestamptz - interval '1 day'
        AND snapshot.fetched_at < $4::timestamptz + interval '${CORROBORATION_HORIZON_DAYS + 1} days'
        AND NOT EXISTS (
          SELECT 1 FROM meta_raw_snapshot_observations observation
          WHERE observation.snapshot_id = snapshot.id
        )
    ), valid AS (
      SELECT observed.observation_id, observed.snapshot_id, observed.observed_at,
             observed.request_context, snapshot.payload_json
      FROM observed
      JOIN meta_raw_snapshots snapshot ON snapshot.id = observed.snapshot_id
        AND snapshot.business_id = $1
        AND snapshot.provider_account_id = $2
        AND snapshot.endpoint_name = $3
        AND snapshot.entity_scope = $6
      WHERE observed.request_context->'pagination'->>'complete' = 'true'
        AND observed.request_context->'pagination'->>'termination' = 'natural_end'
        AND NULLIF(observed.request_context->>'fields', '') IS NOT NULL
    )
    SELECT entity.entity_json->>'id' AS entity_id,
           entity.entity_json, valid.snapshot_id::text AS snapshot_id,
           valid.observation_id::text AS observation_id,
           entity_observation.observed_at,
           valid.observed_at AS receipt_observed_at, valid.request_context
    FROM valid
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(valid.payload_json) = 'array'
        THEN valid.payload_json ELSE '[]'::jsonb END
    ) AS entity(entity_json)
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN jsonb_typeof(valid.request_context->'rowObservedAtByEntityId') = 'object'
          THEN CASE WHEN
            (valid.request_context->'rowObservedAtByEntityId'->>(entity.entity_json->>'id'))
              ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
            AND pg_input_is_valid(
              valid.request_context->'rowObservedAtByEntityId'->>(entity.entity_json->>'id'),
              'timestamp with time zone'
            )
            THEN (valid.request_context->'rowObservedAtByEntityId'->>(entity.entity_json->>'id'))::timestamptz
            ELSE NULL END
        WHEN valid.request_context->'pagination'->>'pageCount' = '1'
          THEN valid.observed_at
        ELSE NULL
      END AS observed_at
    ) entity_observation
    WHERE entity.entity_json->>'id' = ANY($5::text[])
      AND (
        (entity_observation.observed_at >= $4::timestamptz
         AND entity_observation.observed_at < $4::timestamptz + interval '${CORROBORATION_HORIZON_DAYS} days')
        -- An untimed page can hide an intervening config change. Return it as
        -- a barrier instead of silently skipping ahead to a matching value.
        OR entity_observation.observed_at IS NULL
      )
    ORDER BY entity.entity_json->>'id',
             COALESCE(entity_observation.observed_at, valid.observed_at) ASC,
             valid.snapshot_id ASC
  `, [input.businessId, input.providerAccountId, endpointName,
    end.toISOString(), [...result.keys()], input.level]);
  const laterByEntity = new Map<string, DatedRawConfigRow[]>();
  for (const later of laterRows) {
    const grouped = laterByEntity.get(later.entity_id) ?? [];
    grouped.push(later);
    laterByEntity.set(later.entity_id, grouped);
  }
  const corroborated = new Set<string>();
  const bidFields = new Set(["bid_strategy", "bid_amount", "bid_constraints"]);
  const preferredFields = input.level === "campaign"
    ? ["objective"]
    : ["optimization_goal", "promoted_object"];
  for (const [entityId, first] of result) {
    const firstRawRow = candidateRawRows.get(entityId);
    if (!firstRawRow) continue;
    const laterCandidates = laterByEntity.get(entityId) ?? [];
    laterCandidates.sort((a, b) =>
      (receiptInstantMs(a.observed_at) ?? receiptInstantMs(a.receipt_observed_at) ?? Infinity) -
      (receiptInstantMs(b.observed_at) ?? receiptInstantMs(b.receipt_observed_at) ?? Infinity),
    );
    const blockedFields = new Set<string>();
    let best: { row: DatedRawConfigRow; fields: string[]; payload: MetaConfigSnapshotPayload; score: number } | null = null;
    for (const later of laterCandidates) {
      const laterTime = receiptInstantMs(later.observed_at);
      const aggregateTime = receiptInstantMs(later.receipt_observed_at);
      if (laterTime === null) {
        // The aggregate time is only an upper bound on this page's time. A
        // possible intervening page with no clock cannot be skipped safely.
        if (aggregateTime !== null && aggregateTime >= end.getTime()) break;
        continue;
      }
      if (laterTime < end.getTime()) continue;
      if (laterTime >= end.getTime() + CORROBORATION_HORIZON_DAYS * 86_400_000) break;
      /*
        A WITNESS IS A RECEIPT, NOT A PAYLOAD.

        Only the SAME OBSERVATION may not corroborate itself. A second GET of
        unchanged configuration is a genuine second witness even though it
        shares the canonical content — and sharing is the normal case, because
        `meta_raw_snapshots` deduplicates payloads while
        `meta_raw_snapshot_observations` keys receipt identity on
        `(snapshot_id, partition, run, checkpoint, page, cursor, status,
        observed_at)` (lib/migrations.ts). Every distinct observation INSTANT is
        its own row precisely so the timeline can answer between them; a
        same-instant replay heartbeats instead of appending, so equal ids really
        do mean one receipt.

        An earlier version of this guard compared `snapshot_id` and was WRONG:
        it threw away real second witnesses. Measured on production for
        Silveristic ad set `120251869715690343`, 2026-09-11: the day's source
        and its day-closing witness are observations `e5511bab…`
        (2026-09-12T04:53:37.979Z) and `c86e1e4b…` (T05:00:07.888Z) — separate
        rows, both fetched/HTTP 200/natural_end, each `created_at` equal to its
        own `observed_at`, same partition. That canonical snapshot carries 211
        such observations across 24 hours.

        Legacy snapshot-only rows have no observation id. Two of them on one
        canonical snapshot cannot be shown to be different receipts, so an
        unknown identity is treated as possibly-the-same and refused.

        `continue`, not `break`: a re-read of one receipt cannot itself be an
        intervening change, so it is not a barrier.
      */
      const sameReceipt = later.observation_id && first.source.observationId
        ? later.observation_id === first.source.observationId
        : later.snapshot_id === first.source.id;
      if (sameReceipt) continue;
      if (!observedField(later, "updated_time") ||
          optionalText(later.entity_json.updated_time) !== first.source.entityUpdatedAt ||
          providerInstantMs(later.entity_json.updated_time) === null) break;
      const laterScope = rowFieldScope(later);
      const laterNames = new Set(laterScope.map((field) => field.split(/[({]/, 1)[0]!));
      const matched = new Set<string>();
      // A requested absence or changed value ends that field's lineage. A
      // later reverted match cannot resurrect the older day's value.
      for (const field of first.source.observedFieldScope) {
        const name = field.split(/[({]/, 1)[0]!;
        if (blockedFields.has(name) || !laterNames.has(name)) continue;
        if (!Object.hasOwn(later.entity_json, name) ||
            !isDeepStrictEqual(firstRawRow[name], later.entity_json[name])) {
          blockedFields.add(name);
        } else {
          matched.add(name);
        }
      }
      const observedBidNames = first.source.observedFieldScope
        .map((field) => field.split(/[({]/, 1)[0]!)
        .filter((name) => bidFields.has(name));
      /*
        THE BID TRIPLE IS ANCHORED ON `bid_strategy`, not merely atomic.
        ───────────────────────────────────────────────────────────────────────
        The existing rule — all three bid fields survive together or none does —
        only ever fired when an OBSERVED bid field failed to corroborate. It
        cannot fire when `bid_strategy` was never observed at all, and that gap
        is what manufactures a value out of nothing:
        `normalizeDatedRawConfig` passes `bidStrategy: null` for an unobserved
        field (:247), and `normalizeBidStrategy` (lib/meta/configuration.ts:127)
        turns `null` strategy plus a finite `bid_amount` into `"manual_bid"` —
        a label that is not in Meta's `bid_strategy` enum and that no receipt
        ever stated.
        The normalizer is right for its own job: reading a live entity, an
        absent strategy beside a bid amount IS manual bidding. It is wrong as a
        HISTORICAL source, because there "absent" also covers "we never asked",
        and this path cannot tell the two apart — `fieldNames.has(...)` collapses
        both to `null` before the inference runs.
        Measured: ColorFull `bc0c6178`, ad set `120243489401810340`, 2026-07-25.
        Its receipt carried `bid_amount` but no `bid_strategy`, and the manifest
        proposed `bidStrategyType = "manual_bid"` for an ad set whose own parent
        campaign was read, from a receipt that DID request `bid_strategy`, as
        `cost_cap`. The live path resolves that same ad set the other way —
        `effectiveBidStrategy = adset.bid_strategy ?? campaignConfig.bid_strategy`
        (lib/api/meta.ts:921) — so the historical claim contradicted the live one.
        So: unless the provider actually STATED `bid_strategy` on this entity,
        the whole triple is dropped and `normalizeBidStrategy` is handed nothing
        to infer from. Its own behaviour is untouched; what changes is which
        fields this historical reader is willing to hand it.
      */
      const strategyObserved = observedBidNames.includes("bid_strategy");
      if (!strategyObserved || observedBidNames.some((name) => !matched.has(name))) {
        for (const name of observedBidNames) matched.delete(name);
      }
      const fields = first.source.observedFieldScope.filter((field) =>
        matched.has(field.split(/[({]/, 1)[0]!),
      );
      const payload = normalizeDatedRawConfig({
        level: input.level, row: firstRawRow, fields: fields.join(","),
      });
      if (!payload) continue;
      const score = preferredFields.reduce((total, field, index) =>
        total + (matched.has(field) ? 100 - index : 0), 0,
      ) + matched.size;
      if (!best || score > best.score) best = { row: later, fields, payload, score };
    }
    if (!best) continue;
    first.payload = best.payload;
    first.source.observedFieldScope = best.fields;
    first.source.corroboratingSourceSnapshotId = best.row.snapshot_id;
    first.source.corroboratingObservationId = best.row.observation_id ?? null;
    first.source.corroboratingObservedAt = new Date(best.row.observed_at!).toISOString();
    corroborated.add(entityId);
  }
  for (const entityId of result.keys()) {
    if (!corroborated.has(entityId)) result.delete(entityId);
  }
  return result;
}
