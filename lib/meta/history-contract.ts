export const META_HISTORY_KINDS = [
  "decisions",
  "writes",
  "responses",
  "label_flips",
  "outcomes",
  "briefs",
  "launches",
  "structures",
] as const;

export type MetaHistoryKind = (typeof META_HISTORY_KINDS)[number];

export const META_HISTORY_ENTITY_TYPES = [
  "account",
  "campaign",
  "adset",
  "ad",
  "creative",
  "creative_brief",
  "launch_intent",
  "recommendation",
] as const;

export type MetaHistoryEntityType = (typeof META_HISTORY_ENTITY_TYPES)[number];

export const META_HISTORY_SOURCES = [
  "meta_ads_action_log",
  "meta_decision_responses",
  "meta_decision_action_outcome_logs",
  "meta_decision_snapshots_daily",
  "engine_v3_decision_snapshots_daily",
  "engine_v3_decision_events",
  "engine_v3_decision_outcomes_daily",
  "meta_creative_briefs",
  "meta_launch_intents",
  "meta_campaign_dimensions",
  "meta_adset_dimensions",
] as const;

export type MetaHistorySource = (typeof META_HISTORY_SOURCES)[number];

export type MetaHistoryEntryStatus =
  | "published"
  | "recorded"
  | "pending"
  | "verified_success"
  | "failed"
  | "silent_failure"
  | "unknown_outcome"
  | "open"
  | "resolved"
  | "closed"
  | "improved"
  | "regressed"
  | "flat"
  | "inconclusive"
  | "positive"
  | "negative"
  | "neutral"
  | "draft"
  | "reviewed"
  | "prepared"
  | "validation_blocked"
  | "write_blocked"
  | "ready"
  | "executing"
  | "succeeded"
  | "partially_succeeded"
  | "unknown";

export type MetaHistorySourceIdKind =
  | "persisted_uuid"
  | "persisted_composite_key";

export type MetaHistoryAccountScopeBasis =
  | "direct_provider_account_id"
  | "exact_entity_key"
  | "exact_snapshot_key"
  | "unique_creative_key";

export interface MetaHistoryAccount {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
}

export interface MetaHistoryMoneyFact {
  label: string;
  amount: number | null;
  currency: string | null;
  availability: "available" | "currency_unavailable" | "not_recorded";
  attribution: "meta_attributed";
}

export interface MetaHistoryEntry {
  id: string;
  kind: MetaHistoryKind;
  occurredAt: string;
  title: string;
  summary: string | null;
  entity: {
    type: MetaHistoryEntityType;
    id: string;
    name: string | null;
  };
  label: string | null;
  status: MetaHistoryEntryStatus;
  actor: {
    id: string | null;
    name: string | null;
    availability: "available" | "unavailable" | "not_applicable";
  };
  identity: {
    canonicalDecisionId: null;
    sourceId: string;
    sourceIdKind: MetaHistorySourceIdKind;
    limitation: string;
  };
  provenance: {
    provider: "meta";
    source: MetaHistorySource;
    sourceId: string;
    accountScopeBasis: MetaHistoryAccountScopeBasis;
    attribution:
      | "engine_snapshot"
      | "engine_transition"
      | "operator_recorded"
      | "provider_write_log"
      | "correlational_outcome"
      | "workflow_object"
      | "warehouse_dimension";
  };
  correlation: {
    status: "keyed" | "unavailable" | "not_applicable";
    key: string | null;
    reason: string | null;
  };
  replay: {
    date: string;
    engineVersion: string | null;
  } | null;
  money: MetaHistoryMoneyFact[];
  detail: Record<string, unknown> | null;
}

export interface MetaHistoryCursor {
  occurredAt: string;
  source: MetaHistorySource;
  sourceId: string;
}

export interface MetaHistoryQuery {
  businessId: string;
  providerAccountId: string;
  kind: MetaHistoryKind | null;
  entity: MetaHistoryEntityType | null;
  label: string | null;
  from: string | null;
  to: string | null;
  q: string | null;
  cursor: MetaHistoryCursor | null;
  limit: number;
}

export interface MetaHistoryResponse {
  mode: "read_only";
  scope: {
    businessId: string;
    providerAccountId: string;
    providerAccountName: string | null;
    currency: string | null;
    timezone: string | null;
  };
  filters: Omit<MetaHistoryQuery, "cursor" | "limit">;
  entries: MetaHistoryEntry[];
  page: {
    limit: number;
    returned: number;
    /** Exact totals are intentionally not computed on the cursor read path. */
    total: number | null;
    nextCursor: string | null;
  };
  identityContract: {
    canonicalDecisionIdAvailable: false;
    grouping: "persisted_source_rows";
    limitation: string;
  };
  limitations: Array<{
    code:
      | "canonical_decision_id_unavailable"
      | "business_only_rows_omitted"
      | "shared_creative_rows_omitted"
      | "missing_join_unavailable"
      | "optional_source_unavailable"
      | "structure_inventory_explicit_filter";
    message: string;
  }>;
}

export class MetaHistoryQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MetaHistoryQueryError";
  }
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;

function requiredParam(params: URLSearchParams, key: string) {
  const value = params.get(key)?.trim() ?? "";
  if (!value) {
    throw new MetaHistoryQueryError(
      `missing_${key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)}`,
      `${key} is required.`,
    );
  }
  if (value.length > 160) {
    throw new MetaHistoryQueryError(`invalid_${key}`, `${key} is too long.`);
  }
  return value;
}

function optionalEnum<T extends string>(input: {
  params: URLSearchParams;
  key: string;
  values: readonly T[];
}): T | null {
  const raw = input.params.get(input.key)?.trim().toLowerCase() ?? "";
  if (!raw || raw === "all") return null;
  if (!input.values.includes(raw as T)) {
    throw new MetaHistoryQueryError(
      `invalid_${input.key}`,
      `${input.key} is not supported.`,
    );
  }
  return raw as T;
}

function optionalDate(params: URLSearchParams, key: "from" | "to") {
  const value = params.get(key)?.trim() ?? "";
  if (!value) return null;
  if (!ISO_DATE_PATTERN.test(value)) {
    throw new MetaHistoryQueryError(`invalid_${key}`, `${key} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new MetaHistoryQueryError(`invalid_${key}`, `${key} is not a valid date.`);
  }
  return value;
}

function optionalLabel(params: URLSearchParams) {
  const value = params.get("label")?.trim().toLowerCase() ?? "";
  if (!value) return null;
  if (!LABEL_PATTERN.test(value)) {
    throw new MetaHistoryQueryError(
      "invalid_label",
      "label must contain only letters, numbers, underscores, or hyphens.",
    );
  }
  return value;
}

function optionalSearch(params: URLSearchParams) {
  const value = params.get("q")?.trim() ?? "";
  if (!value) return null;
  if (value.length > 160) {
    throw new MetaHistoryQueryError("invalid_q", "q must be 160 characters or fewer.");
  }
  return value;
}

function parseLimit(params: URLSearchParams) {
  const raw = params.get("limit")?.trim();
  if (!raw) return 40;
  if (!/^\d+$/.test(raw)) {
    throw new MetaHistoryQueryError("invalid_limit", "limit must be an integer.");
  }
  const limit = Number(raw);
  if (limit < 1 || limit > 100) {
    throw new MetaHistoryQueryError("invalid_limit", "limit must be between 1 and 100.");
  }
  return limit;
}

export function encodeMetaHistoryCursor(cursor: MetaHistoryCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeMetaHistoryCursor(value: string): MetaHistoryCursor {
  if (!value || value.length > 2_048) {
    throw new MetaHistoryQueryError("invalid_cursor", "cursor is invalid.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<MetaHistoryCursor>;
    const occurredAt = typeof parsed.occurredAt === "string" ? parsed.occurredAt : "";
    const source = typeof parsed.source === "string" ? parsed.source : "";
    const sourceId = typeof parsed.sourceId === "string" ? parsed.sourceId : "";
    const timestamp = new Date(occurredAt);
    if (
      !Number.isFinite(timestamp.getTime()) ||
      !META_HISTORY_SOURCES.includes(source as MetaHistorySource) ||
      !sourceId ||
      sourceId.length > 512
    ) {
      throw new Error("invalid cursor payload");
    }
    return {
      occurredAt: timestamp.toISOString(),
      source: source as MetaHistorySource,
      sourceId,
    };
  } catch {
    throw new MetaHistoryQueryError("invalid_cursor", "cursor is invalid.");
  }
}

export function parseMetaHistoryQuery(params: URLSearchParams): MetaHistoryQuery {
  const businessId = requiredParam(params, "businessId");
  const providerAccountId = requiredParam(params, "providerAccountId");
  const from = optionalDate(params, "from");
  const to = optionalDate(params, "to");
  if (from && to && from > to) {
    throw new MetaHistoryQueryError(
      "invalid_date_range",
      "from must be on or before to.",
    );
  }

  const cursorValue = params.get("cursor")?.trim() ?? "";
  return {
    businessId,
    providerAccountId,
    kind: optionalEnum({ params, key: "kind", values: META_HISTORY_KINDS }),
    entity: optionalEnum({
      params,
      key: "entity",
      values: META_HISTORY_ENTITY_TYPES,
    }),
    label: optionalLabel(params),
    from,
    to,
    q: optionalSearch(params),
    cursor: cursorValue ? decodeMetaHistoryCursor(cursorValue) : null,
    limit: parseLimit(params),
  };
}
