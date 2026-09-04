import { createHash } from "node:crypto";
import { getDb, runDbTransaction } from "@/lib/db";

export const META_ENTITY_TYPES = [
  "campaign",
  "adset",
  "ad",
  "creative",
] as const;
export type MetaEntityType = (typeof META_ENTITY_TYPES)[number];

export const META_OBSERVATION_COMPLETENESS = [
  "complete",
  "partial",
  "point_lookup",
  "failed",
] as const;
export type MetaObservationCompleteness =
  (typeof META_OBSERVATION_COMPLETENESS)[number];

export type MetaLearningSource = "provider" | "inferred" | "not_observed";
export type MetaBudgetOrigin =
  "campaign" | "adset" | "not_observed" | "not_applicable";
export type MetaEntityPresence = "present" | "absent_unconfirmed";
export type MetaEntityTombstoneReason =
  "explicit_deleted" | "explicit_not_found";
export type MetaCreativeLineageType =
  "reuse_same_creative" | "rebuild_successor";
export type MetaCreativeLineageEvidenceSource =
  "observation_run" | "verified_action" | "manual_verified";

export interface MetaEntityStateHashInput {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  entityId: string;
  campaignId?: string | null;
  adsetId?: string | null;
  adId?: string | null;
  creativeId?: string | null;
  entityName?: string | null;
  configuredStatus?: string | null;
  effectiveStatus?: string | null;
  learningStatus?: string | null;
  learningSource: MetaLearningSource;
  campaignDailyBudgetRaw?: string | null;
  campaignLifetimeBudgetRaw?: string | null;
  adsetDailyBudgetRaw?: string | null;
  adsetLifetimeBudgetRaw?: string | null;
  budgetCurrency?: string | null;
  budgetOrigin: MetaBudgetOrigin;
  /**
   * D083 — schedule, required whenever a lifetime budget is the binding field,
   * and the currency exponent in force when the amount was captured.
   */
  campaignStartTime?: string | null;
  campaignEndTime?: string | null;
  adsetStartTime?: string | null;
  adsetEndTime?: string | null;
  budgetCurrencyExponent?: number | null;
  budgetCurrencyRegistryVersion?: string | null;
  /** D086: whether the provider's budget SHAPE was observed for this row. */
  budgetShapeSupport?: "supported" | "unsupported_shape" | "shape_not_observed" | null;
  providerApiVersion?: string | null;
  reviewStatus?: string | null;
  policyStatus?: string | null;
  policyReasons?: unknown[] | null;
  providerUpdatedAt?: string | null;
  presence: MetaEntityPresence;
  fieldCoverage: Record<string, unknown>;
}

export interface MetaObservationRunHashInput {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  endpoint: string;
  observedAt: string;
  capturedAt: string;
  completeness: MetaObservationCompleteness;
  pageCount: number;
  rowCount: number;
  sourceSnapshotId?: string | null;
  payloadHash?: string | null;
  error?: Record<string, unknown> | null;
}

export interface MetaEntityObservationStateInput
  extends MetaEntityStateHashInput {
  observedAt: string;
}

export interface MetaObservedAdCreativeRelationship {
  adId: string;
  creativeId: string;
  providerCreatedAt: string;
}

export interface PersistMetaEntityObservationInput {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  endpoint: string;
  observedAt: string;
  capturedAt: string;
  completeness: MetaObservationCompleteness;
  pageCount: number;
  providerRowCount: number;
  states: MetaEntityObservationStateInput[];
  sourceSnapshotId?: string | null;
  payloadHash?: string | null;
  error?: Record<string, unknown> | null;
  adCreativeRelationships?: MetaObservedAdCreativeRelationship[] | null;
  /**
   * D086: bind this capture OCCURRENCE to the sync that performed it.
   *
   * The run is coalesced content — identical truth advances a heartbeat on an
   * existing run rather than appending one — so the run cannot carry the
   * cohort. Supplying this writes an append-only receipt naming the core sync
   * partition, the raw snapshot the rows were mapped from, and whether the run
   * was reused. Omitting it writes no receipt and leaves the capture
   * unattestable, which is the fail-closed direction.
   */
  captureReceipt?: {
    partitionId: string;
    sourceSnapshotId?: string | null;
    /** The raw snapshot row this capture was mapped from, as a real reference. */
    sourceSnapshotRefId?: string | null;
  } | null;
}

/**
 * D075 write-amplification telemetry, persisted on the run as
 * `delta_stats_json` and returned to the caller. `logicalEntityCount` is the
 * full incoming scope (`row_count` keeps that meaning too);
 * `physicalStateRows` is what was actually appended.
 */
export interface MetaObservationDeltaStats {
  logicalEntityCount: number;
  changedEntityCount: number;
  newEntityCount: number;
  exitedEntityCount: number;
  /** Unchanged rows re-persisted only so creative-lineage FKs stay run-bound. */
  lineageCarriedEntityCount: number;
  physicalStateRows: number;
  /** physicalStateRows / max(1, logicalEntityCount). */
  amplification: number;
}

export interface PersistMetaEntityObservationResult {
  runId: string;
  runHash: string;
  stateCount: number;
  lineageCount: number;
  completeness: MetaObservationCompleteness;
  observedAt: string;
  capturedAt: string;
  /** The clock-free truth this observation carried. */
  semanticHash: string;
  /**
   * True when identical truth advanced the heartbeat instead of appending a
   * run. Usually writes nothing; the one exception is a lineage carry
   * (D075): a relationship-named ad missing from the kept delta run gets its
   * byte-identical row carried in, reported via `stateCount`.
   */
  coalesced: boolean;
  /** How many observations this run now represents. */
  repeatCount: number;
  /**
   * D075: how this run's manifest is stored. `null` on non-complete lanes
   * (legacy full-manifest behavior) and on coalesced results, `'full'` on a
   * first complete observation of a scope, `'delta'` when only
   * changed/new/exited entities were appended.
   */
  manifestKind: "full" | "delta" | null;
  /** Present exactly when `manifestKind` is non-null. */
  deltaStats: MetaObservationDeltaStats | null;
}

export interface PersistMetaExplicitEntityTombstoneInput {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  entityId: string;
  endpoint: string;
  reason: MetaEntityTombstoneReason;
  providerEvidence: Record<string, unknown>;
  observedAt: string;
  capturedAt: string;
  sourceSnapshotId?: string | null;
}

export interface MetaEntityStateHistoryRow {
  id: string;
  runId: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  entityId: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  creativeId: string | null;
  entityName: string | null;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  learningStatus: string | null;
  learningSource: MetaLearningSource;
  campaignDailyBudgetRaw: string | null;
  campaignLifetimeBudgetRaw: string | null;
  adsetDailyBudgetRaw: string | null;
  adsetLifetimeBudgetRaw: string | null;
  budgetCurrency: string | null;
  budgetOrigin: MetaBudgetOrigin;
  campaignStartTime: string | null;
  campaignEndTime: string | null;
  adsetStartTime: string | null;
  adsetEndTime: string | null;
  budgetCurrencyExponent: number | null;
  budgetCurrencyRegistryVersion: string | null;
  budgetShapeSupport: string | null;
  providerApiVersion: string | null;
  reviewStatus: string | null;
  policyStatus: string | null;
  policyReasons: unknown[] | null;
  providerUpdatedAt: string | null;
  presence: MetaEntityPresence;
  fieldCoverage: Record<string, unknown>;
  observedAt: string;
  capturedAt: string;
  runCompleteness: Exclude<MetaObservationCompleteness, "failed">;
  stateHash: string;
}

export interface MetaEntityTombstone {
  id: string;
  runId: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  entityId: string;
  reason: MetaEntityTombstoneReason;
  providerEvidence: Record<string, unknown>;
  observedAt: string;
  capturedAt: string;
  runCompleteness: "complete" | "point_lookup";
  tombstoneHash: string;
}

export interface MetaEntityTruthPointer {
  eventKind: "state" | "tombstone";
  eventId: string;
  entityId: string;
  observedAt: string;
  capturedAt: string;
  evidenceHash: string;
  tombstoneReason: MetaEntityTombstoneReason | null;
}

export interface MetaCreativeLineageEdge {
  id: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sourceAdId: string;
  sourceCreativeId: string;
  targetAdId: string;
  targetCreativeId: string;
  lineageType: MetaCreativeLineageType;
  evidenceSource: MetaCreativeLineageEvidenceSource;
  observationRunId: string | null;
  observationRunEntityType: "ad" | "creative" | null;
  observationRunCompleteness: Exclude<
    MetaObservationCompleteness,
    "failed"
  > | null;
  actionLogId: string | null;
  actionType: "duplicate" | null;
  actionStatus: "success" | null;
  actionVerifiedAt: string | null;
  evidence: Record<string, unknown>;
  observedAt: string;
  capturedAt: string;
  lineageHash: string;
}

interface MetaEntityStateDbRow {
  id: string;
  run_id: string;
  business_ref_id: string;
  business_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  entity_type: MetaEntityType;
  entity_id: string;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  creative_id: string | null;
  entity_name: string | null;
  configured_status: string | null;
  effective_status: string | null;
  learning_status: string | null;
  learning_source: MetaLearningSource;
  campaign_daily_budget_raw: string | null;
  campaign_lifetime_budget_raw: string | null;
  adset_daily_budget_raw: string | null;
  adset_lifetime_budget_raw: string | null;
  budget_currency: string | null;
  budget_origin: MetaBudgetOrigin;
  campaign_start_time: string | null;
  campaign_end_time: string | null;
  adset_start_time: string | null;
  adset_end_time: string | null;
  budget_currency_exponent: number | null;
  budget_currency_registry_version: string | null;
  budget_shape_support: string | null;
  provider_api_version: string | null;
  review_status: string | null;
  policy_status: string | null;
  policy_reasons_json: unknown[] | null;
  provider_updated_at: string | null;
  presence: MetaEntityPresence;
  field_coverage_json: Record<string, unknown>;
  observed_at: string;
  captured_at: string;
  run_completeness: Exclude<MetaObservationCompleteness, "failed">;
  state_hash: string;
}

interface MetaEntityTombstoneDbRow {
  id: string;
  run_id: string;
  business_ref_id: string;
  business_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  entity_type: MetaEntityType;
  entity_id: string;
  reason: MetaEntityTombstoneReason;
  provider_evidence_json: Record<string, unknown>;
  observed_at: string;
  captured_at: string;
  run_completeness: "complete" | "point_lookup";
  tombstone_hash: string;
}

interface MetaEntityTruthDbRow {
  event_kind: "state" | "tombstone";
  event_id: string;
  entity_id: string;
  observed_at: string;
  captured_at: string;
  evidence_hash: string;
  tombstone_reason: MetaEntityTombstoneReason | null;
}

interface MetaCreativeLineageDbRow {
  id: string;
  business_ref_id: string;
  business_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  source_ad_id: string;
  source_creative_id: string;
  target_ad_id: string;
  target_creative_id: string;
  lineage_type: MetaCreativeLineageType;
  evidence_source: MetaCreativeLineageEvidenceSource;
  observation_run_id: string | null;
  observation_run_entity_type: "ad" | "creative" | null;
  observation_run_completeness: Exclude<
    MetaObservationCompleteness,
    "failed"
  > | null;
  action_log_id: string | null;
  action_type: "duplicate" | null;
  action_status: "success" | null;
  action_verified_at: string | null;
  evidence_json: Record<string, unknown>;
  observed_at: string;
  captured_at: string;
  lineage_hash: string;
}

interface MetaAccountBindingDbRow {
  business_ref_id: string;
  provider_account_ref_id: string;
}

interface MetaObservationRunDbRow {
  id: string;
  business_ref_id: string;
  provider_account_ref_id: string;
  observed_at: string;
  captured_at: string;
  completeness: MetaObservationCompleteness;
}

interface MetaPersistedStateDbRow {
  id: string;
  state_hash: string;
}

interface MetaVerifiedDuplicateLineageDbRow {
  action_log_id: string;
  source_ad_id: string;
  source_creative_id: string;
  target_ad_id: string;
  target_creative_id: string;
  action_verified_at: string;
}

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalize(
  value: unknown,
  path = "$",
  active = new WeakSet<object>(),
): CanonicalJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`${path} must be a finite number.`);
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not JSON data.`);
  }
  if (active.has(value)) throw new TypeError(`${path} contains a cycle.`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        canonicalize(item, `${path}[${index}]`, active),
      );
    }
    const record = value as Record<string, unknown>;
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(record).sort()) {
      output[key] = canonicalize(record[key], `${path}.${key}`, active);
    }
    return output;
  } finally {
    active.delete(value);
  }
}

function stableJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function requireNonEmpty(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function normalizeCutoff(value: string | Date) {
  const parsed =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new Error("cutoff must be a valid timestamp.");
  return parsed.toISOString();
}

function normalizeTimestamp(value: string | Date, field: string) {
  const parsed =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be a valid timestamp.`);
  }
  return parsed.toISOString();
}

export function normalizeMetaProviderUpdatedAt(
  value: string | null | undefined,
  capturedAt: string | Date,
) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  const captured = new Date(capturedAt);
  if (
    Number.isNaN(parsed.getTime()) ||
    Number.isNaN(captured.getTime()) ||
    parsed.getTime() > captured.getTime()
  ) {
    return null;
  }
  return parsed.toISOString();
}

export function resolveMetaEntityObservedAt(input: {
  providerUpdatedAt?: string | null;
  responseObservedAt: string | Date;
  capturedAt: string | Date;
}) {
  const capturedAt = normalizeTimestamp(input.capturedAt, "capturedAt");
  const providerUpdatedAt = normalizeMetaProviderUpdatedAt(
    input.providerUpdatedAt,
    capturedAt,
  );
  if (providerUpdatedAt) return providerUpdatedAt;

  const responseObservedAt = normalizeTimestamp(
    input.responseObservedAt,
    "responseObservedAt",
  );
  return new Date(responseObservedAt).getTime() <= new Date(capturedAt).getTime()
    ? responseObservedAt
    : capturedAt;
}

function normalizeEntityType(value: MetaEntityType) {
  if (!META_ENTITY_TYPES.includes(value))
    throw new Error("entityType is invalid.");
  return value;
}

function normalizeEntityIds(values: string[] | null | undefined) {
  return Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  );
}

function normalizeLimit(value: number | null | undefined) {
  if (value == null) return 500;
  if (!Number.isInteger(value) || value < 1)
    throw new Error("limit must be a positive integer.");
  return Math.min(value, 2_000);
}

/**
 * D083 Correction 2 — the provider API version joins the schedule and
 * currency-exponent fields in this hash, and the contract identity moves to
 * `meta-entity-state.v3`. The version a row was fetched under changes what the
 * row means, so a change in it is a change in observed truth.
 *
 * D083 Correction 1 — the schedule and currency-exponent fields ARE part of
 * this hash, and the contract identity is bumped to `meta-entity-state.v2` to
 * say so.
 *
 * The alternative — excluding them — would mean the D075 delta writer never
 * persists a first capture or a later schedule change for an otherwise
 * unchanged entity, so the columns would exist and stay empty. Including them
 * costs one bounded, one-time restatement: on the first complete run after
 * deploy every entity's hash differs from its retained predecessor, so the
 * writer persists at most one additional row per entity per scope, once. The
 * previous revision of this file claimed these fields were excluded while the
 * code included them; that disagreement is what this note replaces.
 */
export function buildMetaEntityStateHash(input: MetaEntityStateHashInput) {
  return sha256({
    contractVersion: "meta-entity-state.v3",
    businessId: requireNonEmpty(input.businessId, "businessId"),
    providerAccountId: requireNonEmpty(
      input.providerAccountId,
      "providerAccountId",
    ),
    entityType: normalizeEntityType(input.entityType),
    entityId: requireNonEmpty(input.entityId, "entityId"),
    campaignId: input.campaignId ?? null,
    adsetId: input.adsetId ?? null,
    adId: input.adId ?? null,
    creativeId: input.creativeId ?? null,
    entityName: input.entityName ?? null,
    configuredStatus: input.configuredStatus ?? null,
    effectiveStatus: input.effectiveStatus ?? null,
    learningStatus: input.learningStatus ?? null,
    learningSource: input.learningSource,
    campaignDailyBudgetRaw: input.campaignDailyBudgetRaw ?? null,
    campaignLifetimeBudgetRaw: input.campaignLifetimeBudgetRaw ?? null,
    adsetDailyBudgetRaw: input.adsetDailyBudgetRaw ?? null,
    adsetLifetimeBudgetRaw: input.adsetLifetimeBudgetRaw ?? null,
    budgetCurrency: input.budgetCurrency ?? null,
    budgetOrigin: input.budgetOrigin,
    campaignStartTime: input.campaignStartTime ?? null,
    campaignEndTime: input.campaignEndTime ?? null,
    adsetStartTime: input.adsetStartTime ?? null,
    adsetEndTime: input.adsetEndTime ?? null,
    budgetCurrencyExponent: input.budgetCurrencyExponent ?? null,
    budgetCurrencyRegistryVersion: input.budgetCurrencyRegistryVersion ?? null,
    budgetShapeSupport: input.budgetShapeSupport ?? null,
    providerApiVersion: input.providerApiVersion ?? null,
    reviewStatus: input.reviewStatus ?? null,
    policyStatus: input.policyStatus ?? null,
    policyReasons: input.policyReasons ?? null,
    providerUpdatedAt: input.providerUpdatedAt ?? null,
    presence: input.presence,
    fieldCoverage: input.fieldCoverage,
  });
}

/**
 * How long identical truth may be coalesced before a full auditable checkpoint
 * is forced anyway.
 *
 * Coalescing alone would mean an account whose inventory never changes has one
 * state row from months ago and nothing since — technically accurate, but an
 * audit cannot distinguish "unchanged and still being observed" from "nobody
 * has looked". The cadence bounds that: at most one full checkpoint per window
 * per key, which is a few hundred rows a year instead of a few hundred thousand.
 */
export const META_OBSERVATION_CHECKPOINT_INTERVAL_MS = 24 * 60 * 60_000;

/** Advisory-lock namespace for observation coalescing. */
const META_OBSERVATION_COALESCE_LOCK_NAMESPACE = 0x4d454f42;

/**
 * A shorter cadence for repeated failure or partial truth.
 *
 * A provider that has been failing for six hours is a different operational
 * story from one that failed once, and the difference has to be visible without
 * waiting a day for the next checkpoint.
 */
export const META_OBSERVATION_DEGRADED_CHECKPOINT_INTERVAL_MS = 60 * 60_000;

export function metaObservationCheckpointIntervalMs(
  completeness: MetaObservationCompleteness,
): number {
  return completeness === "complete" || completeness === "point_lookup"
    ? META_OBSERVATION_CHECKPOINT_INTERVAL_MS
    : META_OBSERVATION_DEGRADED_CHECKPOINT_INTERVAL_MS;
}

/**
 * The observed TRUTH, with every clock removed.
 *
 * `buildMetaObservationRunHash` includes `observedAt` and `capturedAt`, so
 * replaying the same provider response one second later is a different run — and
 * every run writes a full state set. Identical inventory observed hourly
 * therefore stored itself hourly, in full. That is the remaining structural
 * source of `meta_entity_state_history` growth after the historical-day gate.
 *
 * Excluded on purpose: observedAt, capturedAt, sourceSnapshotId and payloadHash.
 * The first two are observation clocks. The third is a checkpoint pointer. The
 * fourth is derived from per-state `observedAt`, so including it would smuggle a
 * clock back in.
 *
 * Included on purpose: completeness and the error receipt, because "complete
 * with these 40 ads" and "partial with these 40 ads" are different truths and
 * must not coalesce into each other; and the sorted (entityId, stateHash) set,
 * which is the entity truth itself. `stateHash` is already clock-free — it
 * carries `providerUpdatedAt`, which is provider truth rather than an
 * observation clock.
 */
export function buildMetaObservationSemanticHash(input: {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  endpoint: string;
  completeness: MetaObservationCompleteness;
  pageCount: number;
  rowCount: number;
  error?: Record<string, unknown> | null;
  states: ReadonlyArray<{ entityId: string; stateHash: string }>;
}) {
  return sha256({
    contractVersion: "meta-entity-observation-semantic.v1",
    businessId: requireNonEmpty(input.businessId, "businessId"),
    providerAccountId: requireNonEmpty(
      input.providerAccountId,
      "providerAccountId",
    ),
    entityType: normalizeEntityType(input.entityType),
    endpoint: requireNonEmpty(input.endpoint, "endpoint"),
    completeness: input.completeness,
    pageCount: input.pageCount,
    rowCount: input.rowCount,
    error: input.error ?? null,
    states: [...input.states]
      .map((state) => ({ entityId: state.entityId, stateHash: state.stateHash }))
      .sort((a, b) => a.entityId.localeCompare(b.entityId)),
  });
}

export function buildMetaObservationRunHash(
  input: MetaObservationRunHashInput,
) {
  return sha256({
    contractVersion: "meta-entity-observation.v1",
    businessId: requireNonEmpty(input.businessId, "businessId"),
    providerAccountId: requireNonEmpty(
      input.providerAccountId,
      "providerAccountId",
    ),
    entityType: normalizeEntityType(input.entityType),
    endpoint: requireNonEmpty(input.endpoint, "endpoint"),
    observedAt: normalizeCutoff(input.observedAt),
    capturedAt: normalizeCutoff(input.capturedAt),
    completeness: input.completeness,
    pageCount: input.pageCount,
    rowCount: input.rowCount,
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    payloadHash: input.payloadHash ?? null,
    error: input.error ?? null,
  });
}

function requireNonNegativeInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

async function resolveMetaAccountBinding(
  sql: ReturnType<typeof getDb>,
  input: { businessId: string; providerAccountId: string },
) {
  const rows = await sql<MetaAccountBindingDbRow>`
    SELECT
      business.id::text AS business_ref_id,
      assignment.provider_account_ref_id::text AS provider_account_ref_id
    FROM businesses business
    JOIN business_provider_accounts assignment
      ON assignment.business_id = business.id::text
     AND assignment.provider = 'meta'
    JOIN provider_accounts account
      ON account.id = assignment.provider_account_ref_id
     AND account.external_account_id = assignment.provider_account_id
    WHERE business.id::text = ${input.businessId}
      AND assignment.provider_account_id = ${input.providerAccountId}
    LIMIT 1
  `;
  const binding = rows[0];
  if (!binding) {
    throw new Error("Meta account is not assigned to this business.");
  }
  return binding;
}

function buildMetaCreativeLineageHash(input: {
  businessId: string;
  providerAccountId: string;
  sourceAdId: string;
  sourceCreativeId: string;
  targetAdId: string;
  targetCreativeId: string;
  evidenceSource: "observation_run" | "verified_action";
  observationRunId: string;
  actionLogId?: string | null;
}) {
  return sha256({
    contractVersion: "meta-creative-lineage.v1",
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    lineageType: "reuse_same_creative",
    sourceAdId: input.sourceAdId,
    sourceCreativeId: input.sourceCreativeId,
    targetAdId: input.targetAdId,
    targetCreativeId: input.targetCreativeId,
    evidenceSource: input.evidenceSource,
    observationRunId: input.observationRunId,
    actionLogId: input.actionLogId ?? null,
  });
}

/**
 * Stable logical identity for a lineage edge.
 *
 * "This ad reuses that creative" is a fact about two ads. `lineage_hash` folded
 * `observationRunId` into it, so the same fact got a fresh identity on every
 * observation and the unique constraint deduplicated nothing — every run
 * appended the whole edge set again.
 *
 * `evidenceSource` and `actionLogId` stay IN the key on purpose. A verified
 * duplicate action and an inferred same-creative relationship are different
 * claims with different authority, and collapsing them would let an inference
 * silently stand in for a receipt.
 */
export function buildMetaCreativeLineageLogicalKey(input: {
  businessId: string;
  providerAccountId: string;
  lineageType: MetaCreativeLineageType;
  sourceAdId: string;
  sourceCreativeId: string;
  targetAdId: string;
  targetCreativeId: string;
  evidenceSource: MetaCreativeLineageEvidenceSource;
  actionLogId?: string | null;
}) {
  return sha256({
    contractVersion: "meta-creative-lineage-logical.v1",
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    lineageType: input.lineageType,
    sourceAdId: input.sourceAdId,
    sourceCreativeId: input.sourceCreativeId,
    targetAdId: input.targetAdId,
    targetCreativeId: input.targetCreativeId,
    evidenceSource: input.evidenceSource,
    actionLogId: input.actionLogId ?? null,
  });
}

/**
 * The one legacy arbiter this writer may treat as "already present".
 *
 * Selective on purpose. A blanket catch around the insert would swallow a
 * foreign-key violation — a lineage edge pointing at state rows that do not
 * exist — and report success, which is exactly the class of silent corruption
 * the receipt model exists to prevent.
 */
const LEGACY_LINEAGE_HASH_CONSTRAINT = "meta_creative_lineage_hash_unique";

function isLegacyLineageHashConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  return code === "23505" && constraint === LEGACY_LINEAGE_HASH_CONSTRAINT;
}

/**
 * Insert one lineage edge under BOTH arbiters.
 *
 * The logical key is the arbiter in `ON CONFLICT`. The legacy
 * `(business_id, provider_account_id, lineage_hash)` unique still exists and
 * still applies, so a row whose logical key is new but whose legacy hash
 * collides raises 23505 on the OTHER constraint. That specific case means the
 * edge is already recorded, and only that case is absorbed — a foreign-key
 * violation, a check violation, or a unique violation on any other constraint
 * propagates, because each of those means the edge does not describe reality
 * and reporting success would be a silent corruption.
 *
 * A savepoint is required: in PostgreSQL an error aborts the whole transaction
 * unless it is rolled back to a savepoint, so catching without one would leave
 * every later statement failing with 25P02.
 */
async function insertLineageEdge(
  sql: ReturnType<typeof getDb>,
  insert: () => Promise<Array<{ id: string }>>,
): Promise<Array<{ id: string }>> {
  await sql`SAVEPOINT lineage_edge_insert`;
  try {
    const rows = await insert();
    await sql`RELEASE SAVEPOINT lineage_edge_insert`;
    return rows;
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT lineage_edge_insert`;
    await sql`RELEASE SAVEPOINT lineage_edge_insert`;
    if (isLegacyLineageHashConflict(error)) return [];
    throw error;
  }
}

function buildMetaTombstoneHash(input: {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  entityId: string;
  reason: MetaEntityTombstoneReason;
  providerEvidence: Record<string, unknown>;
}) {
  return sha256({
    contractVersion: "meta-entity-tombstone.v1",
    ...input,
  });
}

/**
 * Creative lineage for one observation, decoupled from whether the observation
 * appended a run.
 *
 * Extracted because it must run on the COALESCED path too. Relationship truth is
 * not part of the semantic identity — two observations with byte-identical
 * entity states can differ in whether the provider returned the ad-creative link
 * at all, because `creative{id}` is a separate field group that can be missing
 * on one page and present on the next. When that happened the coalescing branch
 * returned early with `lineageCount: 0` and the edge was simply never recorded:
 * the states were "the same truth", and the new relationship was thrown away
 * with them.
 *
 * Running it here, keyed on the run whose state rows are already durable, means
 * a relationship-only change persists its logical edge while the identical state
 * payload still coalesces. Both `ON CONFLICT ... DO NOTHING` arbiters make a
 * repeat a no-op, so calling this on every observation is idempotent.
 */
/**
 * D075: every ad this observation's lineage evidence names — the provider's
 * ad-creative relationships plus verified duplicate action pairs. These ads
 * must have a durable state row in whichever run a lineage edge attaches to,
 * because the edge FK-references (run_id, entity_type, ad_id, creative_id).
 */
async function lineageRelevantAdIds(
  sql: ReturnType<typeof getDb>,
  input: {
    businessRefId: string;
    observedAt: string;
    adCreativeRelationships?: MetaObservedAdCreativeRelationship[] | null;
  },
): Promise<Set<string>> {
  const adIds = new Set<string>(
    (input.adCreativeRelationships ?? []).map((rel) => rel.adId),
  );
  const verifiedPairs = await sql<{
    ad_id: string;
    resulting_ad_id: string;
  }>`
    SELECT ad_id, resulting_ad_id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessRefId}::uuid
      AND action = 'duplicate'
      AND status = 'success'
      AND verified_at IS NOT NULL
      AND verified_at <= ${input.observedAt}::timestamptz
      AND resulting_ad_id IS NOT NULL
  `;
  for (const pair of verifiedPairs) {
    adIds.add(pair.ad_id);
    adIds.add(pair.resulting_ad_id);
  }
  return adIds;
}

/**
 * D075: resolve which of the named ads already have durable state rows in a
 * specific run, so lineage receives only rows the edge FK can reference.
 */
async function lineageStatesForRun(
  sql: ReturnType<typeof getDb>,
  input: {
    runId: string;
    entityType: MetaEntityType;
    adIds: ReadonlyArray<string>;
  },
): Promise<
  ReadonlyArray<{ entityId: string; adId: string | null; creativeId: string | null }>
> {
  if (input.entityType !== "ad") return [];
  const adIds = Array.from(new Set(input.adIds));
  if (adIds.length === 0) return [];
  const rows = await sql<{
    entity_id: string;
    ad_id: string | null;
    creative_id: string | null;
  }>`
    SELECT entity_id, ad_id, creative_id
    FROM meta_entity_state_history
    WHERE run_id = ${input.runId}
      AND entity_type = 'ad'
      AND ad_id = ANY(${adIds}::text[])
  `;
  return rows.map((row) => ({
    entityId: row.entity_id,
    adId: row.ad_id,
    creativeId: row.creative_id,
  }));
}

async function persistMetaObservationLineage(
  sql: ReturnType<typeof getDb>,
  options: {
    runId: string;
    binding: { business_ref_id: string; provider_account_ref_id: string };
    businessId: string;
    providerAccountId: string;
    entityType: MetaEntityType;
    completeness: MetaObservationCompleteness;
    /** The RUN's clocks. The composite foreign key pins the edge to these. */
    observedAt: string;
    capturedAt: string;
    /**
     * When the relationship was ACTUALLY observed.
     *
     * On the coalesced path this is the current observation, not the kept run's
     * original instant — otherwise an as-of read at the run's time returns an
     * edge nobody had seen yet. Defaults to the run's clocks on the appending
     * path, where they are the same thing.
     */
    relationshipObservedAt?: string;
    relationshipCapturedAt?: string;
    states: ReadonlyArray<{
      entityId: string;
      adId?: string | null;
      creativeId?: string | null;
    }>;
    adCreativeRelationships?: MetaObservedAdCreativeRelationship[] | null;
  },
): Promise<number> {
  const relationshipObservedAt = options.relationshipObservedAt ?? options.observedAt;
  const relationshipCapturedAt = options.relationshipCapturedAt ?? options.capturedAt;
    let lineageCount = 0;
  if (options.entityType === "ad" && options.completeness !== "failed") {
    const verifiedRows = await sql<MetaVerifiedDuplicateLineageDbRow>`
      SELECT
        action.id::text AS action_log_id,
        source.ad_id AS source_ad_id,
        source.creative_id AS source_creative_id,
        target.ad_id AS target_ad_id,
        target.creative_id AS target_creative_id,
        action.verified_at::text AS action_verified_at
      FROM meta_ads_action_log action
      JOIN meta_entity_state_history source
        ON source.run_id = ${options.runId}
       AND source.entity_type = 'ad'
       AND source.ad_id = action.ad_id
       AND source.creative_id = action.creative_id
      JOIN meta_entity_state_history target
        ON target.run_id = ${options.runId}
       AND target.entity_type = 'ad'
       AND target.ad_id = action.resulting_ad_id
       AND target.creative_id = source.creative_id
      WHERE action.business_id = ${options.binding.business_ref_id}::uuid
        AND action.action = 'duplicate'
        AND action.status = 'success'
        AND action.verified_at IS NOT NULL
        AND action.verified_at <= ${options.observedAt}::timestamptz
        AND action.resulting_ad_id IS NOT NULL
        AND source.creative_id IS NOT NULL
      ORDER BY action.verified_at, action.id
    `;
    const verifiedPairs = new Set<string>();
    for (const edge of verifiedRows) {
      const pairKey = `${edge.source_ad_id}\u0000${edge.target_ad_id}`;
      verifiedPairs.add(pairKey);
      const lineageHash = buildMetaCreativeLineageHash({
        businessId: options.businessId,
        providerAccountId: options.providerAccountId,
        sourceAdId: edge.source_ad_id,
        sourceCreativeId: edge.source_creative_id,
        targetAdId: edge.target_ad_id,
        targetCreativeId: edge.target_creative_id,
        evidenceSource: "verified_action",
        observationRunId: options.runId,
        actionLogId: edge.action_log_id,
      });
      const logicalKey = buildMetaCreativeLineageLogicalKey({
        businessId: options.businessId,
        providerAccountId: options.providerAccountId,
        lineageType: "reuse_same_creative",
        sourceAdId: edge.source_ad_id,
        sourceCreativeId: edge.source_creative_id,
        targetAdId: edge.target_ad_id,
        targetCreativeId: edge.target_creative_id,
        evidenceSource: "verified_action",
        actionLogId: edge.action_log_id,
      });
      const inserted = await insertLineageEdge(sql, async () => sql<{ id: string }>`
        INSERT INTO meta_creative_lineage_edges (
          business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, source_ad_id, source_creative_id, target_ad_id,
          target_creative_id, lineage_type, evidence_source,
          observation_run_id, observation_run_entity_type,
          observation_run_completeness, action_log_id, action_type,
          action_status, action_verified_at, evidence_json, observed_at,
          captured_at, lineage_hash, logical_lineage_key,
          relationship_observed_at, relationship_captured_at
        ) VALUES (
          ${options.binding.business_ref_id}, ${options.businessId},
          ${options.binding.provider_account_ref_id}, ${options.providerAccountId},
          ${edge.source_ad_id}, ${edge.source_creative_id}, ${edge.target_ad_id},
          ${edge.target_creative_id}, 'reuse_same_creative', 'verified_action',
          ${options.runId}, 'ad', ${options.completeness}, ${edge.action_log_id},
          'duplicate', 'success', ${edge.action_verified_at}::timestamptz,
          ${JSON.stringify({ receipt: "meta_ads_action_log", matchedObservedAds: true })}::jsonb,
          ${options.observedAt}::timestamptz, ${options.capturedAt}::timestamptz, ${lineageHash},
          ${logicalKey},
          ${relationshipObservedAt}::timestamptz, ${relationshipCapturedAt}::timestamptz
        )
        ON CONFLICT (business_id, provider_account_id, logical_lineage_key)
          WHERE logical_lineage_key IS NOT NULL
        DO NOTHING
        RETURNING id
      `);
      lineageCount += inserted.length;
    }

    const stateByAdId = new Map(
      options.states
        .filter(
          (state) =>
            state.adId != null &&
            state.creativeId != null &&
            state.adId === state.entityId,
        )
        .map((state) => [state.adId as string, state]),
    );
    const relationshipsByCreative = new Map<
      string,
      Array<MetaObservedAdCreativeRelationship & { createdAt: string }>
    >();
    for (const relationship of options.adCreativeRelationships ?? []) {
      const adId = relationship.adId.trim();
      const creativeId = relationship.creativeId.trim();
      const state = stateByAdId.get(adId);
      if (!state || state.creativeId !== creativeId) continue;
      const createdAt = normalizeMetaProviderUpdatedAt(
        relationship.providerCreatedAt,
        options.observedAt,
      );
      if (!createdAt) continue;
      const group = relationshipsByCreative.get(creativeId) ?? [];
      group.push({ ...relationship, adId, creativeId, createdAt });
      relationshipsByCreative.set(creativeId, group);
    }
    for (const [creativeId, relationships] of relationshipsByCreative) {
      relationships.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.adId.localeCompare(b.adId),
      );
      const source = relationships[0];
      if (!source) continue;
      for (const target of relationships.slice(1)) {
        if (target.createdAt === source.createdAt) continue;
        if (verifiedPairs.has(`${source.adId}\u0000${target.adId}`)) continue;
        const lineageHash = buildMetaCreativeLineageHash({
          businessId: options.businessId,
          providerAccountId: options.providerAccountId,
          sourceAdId: source.adId,
          sourceCreativeId: creativeId,
          targetAdId: target.adId,
          targetCreativeId: creativeId,
          evidenceSource: "observation_run",
          observationRunId: options.runId,
        });
        const logicalKey = buildMetaCreativeLineageLogicalKey({
          businessId: options.businessId,
          providerAccountId: options.providerAccountId,
          lineageType: "reuse_same_creative",
          sourceAdId: source.adId,
          sourceCreativeId: creativeId,
          targetAdId: target.adId,
          targetCreativeId: creativeId,
          evidenceSource: "observation_run",
        });
        const inserted = await insertLineageEdge(sql, async () => sql<{ id: string }>`
          INSERT INTO meta_creative_lineage_edges (
            business_ref_id, business_id, provider_account_ref_id,
            provider_account_id, source_ad_id, source_creative_id,
            target_ad_id, target_creative_id, lineage_type, evidence_source,
            observation_run_id, observation_run_entity_type,
            observation_run_completeness, evidence_json, observed_at,
            captured_at, lineage_hash, logical_lineage_key,
            relationship_observed_at, relationship_captured_at
          ) VALUES (
            ${options.binding.business_ref_id}, ${options.businessId},
            ${options.binding.provider_account_ref_id}, ${options.providerAccountId},
            ${source.adId}, ${creativeId}, ${target.adId}, ${creativeId},
            'reuse_same_creative', 'observation_run', ${options.runId}, 'ad',
            ${options.completeness},
            ${JSON.stringify({
              relationship: "same_provider_creative_id",
              sourceProviderCreatedAt: source.createdAt,
              targetProviderCreatedAt: target.createdAt,
            })}::jsonb,
            ${options.observedAt}::timestamptz, ${options.capturedAt}::timestamptz,
            ${lineageHash}, ${logicalKey},
            ${relationshipObservedAt}::timestamptz, ${relationshipCapturedAt}::timestamptz
          )
          ON CONFLICT (business_id, provider_account_id, logical_lineage_key)
            WHERE logical_lineage_key IS NOT NULL
          DO NOTHING
          RETURNING id
        `);
        lineageCount += inserted.length;
      }
    }
  }
  return lineageCount;
}

export const META_OBSERVATION_RECEIPT_CONTRACT =
  "d086.observation-capture-receipt.v1" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Append the capture receipt for ONE occurrence.
 *
 * Written inside the observation transaction, so a receipt exists exactly when
 * the observation it describes was committed. `runReused` records that the
 * writer coalesced onto an existing run: that row is the evidence that one run
 * carried several captures, which is why the cohort cannot live on the run.
 */
async function appendObservationCaptureReceipt(
  sql: ReturnType<typeof getDb>,
  input: {
    runId: string;
    businessId: string;
    providerAccountId: string;
    entityType: MetaEntityType;
    endpoint: string;
    partitionId: string;
    sourceSnapshotId: string | null;
    sourceSnapshotRefId: string | null;
    captureStatus: MetaObservationCompleteness;
    providerRowCount: number;
    pageCount: number;
    runReused: boolean;
    observedAt: string;
    capturedAt: string;
    error: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!UUID_PATTERN.test(input.partitionId)) {
    throw new Error("captureReceipt.partitionId must be a UUID.");
  }
  if (input.sourceSnapshotRefId !== null && !UUID_PATTERN.test(input.sourceSnapshotRefId)) {
    throw new Error("captureReceipt.sourceSnapshotRefId must be a UUID.");
  }
  const errorJson = input.error ? JSON.stringify(input.error) : null;
  const inserted = await sql<{ id: string }>`
    INSERT INTO meta_entity_observation_receipts (
      receipt_contract, run_id, business_id, provider_account_id, entity_type,
      endpoint, partition_id, source_snapshot_id, source_snapshot_ref_id,
      capture_status, provider_row_count, page_count, run_reused, observed_at,
      captured_at, error_json
    ) VALUES (
      ${META_OBSERVATION_RECEIPT_CONTRACT}, ${input.runId}::uuid,
      ${input.businessId}, ${input.providerAccountId}, ${input.entityType},
      ${input.endpoint}, ${input.partitionId}::uuid, ${input.sourceSnapshotId},
      ${input.sourceSnapshotRefId}::uuid,
      ${input.captureStatus}, ${input.providerRowCount}, ${input.pageCount},
      ${input.runReused}, ${input.observedAt}::timestamptz,
      ${input.capturedAt}::timestamptz,
      ${errorJson}::jsonb
    )
    ON CONFLICT (partition_id, entity_type, endpoint, captured_at)
    DO NOTHING
    RETURNING id::text AS id
  `;
  if (inserted[0]) return;

  /*
    D086 correction 8: an occurrence collision must be COMPARED, not swallowed.

    `DO NOTHING` accepted a retry that named a different run, a different
    outcome, a different row or page count, or a different snapshot, and left
    the first row standing as if the two had agreed. An exact retry is a no-op;
    anything else is two contradictory statements about one capture occurrence
    and there is no rule that picks a winner, so it refuses.
  */
  const existing = await sql<{
    run_id: string;
    source_snapshot_id: string | null;
    source_snapshot_ref_id: string | null;
    capture_status: string;
    provider_row_count: number | string;
    page_count: number | string;
    run_reused: boolean;
    observed_at: string;
    error_json: unknown;
  }>`
    SELECT run_id::text AS run_id, source_snapshot_id,
           source_snapshot_ref_id::text AS source_snapshot_ref_id,
           capture_status, provider_row_count, page_count, run_reused,
           observed_at::text AS observed_at, error_json
      FROM meta_entity_observation_receipts
     WHERE partition_id = ${input.partitionId}::uuid
       AND entity_type = ${input.entityType}
       AND endpoint = ${input.endpoint}
       AND captured_at = ${input.capturedAt}::timestamptz
  `;
  const row = existing[0];
  if (!row) {
    throw new Error("Observation receipt conflicted with a row that then vanished.");
  }
  const differences: string[] = [];
  const compare = (field: string, left: unknown, right: unknown) => {
    if (left !== right) differences.push(`${field} ${String(left)} != ${String(right)}`);
  };
  compare("run_id", row.run_id, input.runId);
  compare("capture_status", row.capture_status, input.captureStatus);
  compare("provider_row_count", Number(row.provider_row_count), input.providerRowCount);
  compare("page_count", Number(row.page_count), input.pageCount);
  /*
    `run_reused` is deliberately NOT compared. It describes the WRITE — whether
    this attempt found the run already present — not the capture occurrence. An
    exact retry of one occurrence legitimately coalesces where the first attempt
    appended, and refusing that would make ordinary retries fatal.
  */
  compare("source_snapshot_id", row.source_snapshot_id ?? null, input.sourceSnapshotId);
  compare(
    "source_snapshot_ref_id",
    row.source_snapshot_ref_id ?? null,
    input.sourceSnapshotRefId,
  );
  /*
    PRE-DEPLOY AUDIT — `observed_at` is deliberately NOT compared, for exactly
    the reason `run_reused` above is not.

    The database defines an occurrence as
    `(partition_id, entity_type, endpoint, captured_at)` — that is the UNIQUE
    index `meta_entity_observation_receipts_occurrence`, and it is the key this
    very lookup uses. `observed_at` is not in it. It is the clock of the WRITE
    ATTEMPT — when WE looked — while `captured_at` is the provider capture time
    that identifies the occurrence.

    So two attempts at ONE occurrence that stamp `observed_at` a millisecond
    apart are, by the schema's own definition, the same occurrence written
    twice. Comparing it made the guard refuse them with "collision with a
    DIFFERENT occurrence", which is not true: nothing about the occurrence
    differed. That is the ordinary shape of a retry storm, and it was fatal —
    the canonical seam's four concurrent identical runs failed on a 1 ms gap
    (`observed_at 2026-09-03T12:26:01.434Z != …433Z`).

    Everything that identifies the occurrence is still compared, and so is
    every fact the receipt asserts about it: the run, the capture status, the
    row and page counts, both snapshot pointers and the error receipt. A
    genuine second occurrence differs in one of those, or it has a different
    `captured_at` and never reaches this guard at all.
  */
  compare(
    "error_json",
    row.error_json === null || row.error_json === undefined
      ? null : JSON.stringify(row.error_json),
    errorJson,
  );
  if (differences.length > 0) {
    throw new Error(
      "Observation receipt collision with a DIFFERENT occurrence: "
      + differences.join("; "),
    );
  }
}

export async function persistMetaEntityObservation(
  input: PersistMetaEntityObservationInput,
): Promise<PersistMetaEntityObservationResult> {
  const businessId = requireNonEmpty(input.businessId, "businessId");
  const providerAccountId = requireNonEmpty(
    input.providerAccountId,
    "providerAccountId",
  );
  const entityType = normalizeEntityType(input.entityType);
  const endpoint = requireNonEmpty(input.endpoint, "endpoint");
  const capturedAt = normalizeTimestamp(input.capturedAt, "capturedAt");
  const observedAt = normalizeTimestamp(input.observedAt, "observedAt");
  if (new Date(observedAt).getTime() > new Date(capturedAt).getTime()) {
    throw new Error("observedAt cannot be after capturedAt.");
  }
  const pageCount = requireNonNegativeInteger(input.pageCount, "pageCount");
  const providerRowCount = requireNonNegativeInteger(
    input.providerRowCount,
    "providerRowCount",
  );
  if (!META_OBSERVATION_COMPLETENESS.includes(input.completeness)) {
    throw new Error("completeness is invalid.");
  }
  if (input.completeness === "failed" && input.states.length > 0) {
    throw new Error("Failed observations cannot persist state rows.");
  }
  if (input.completeness === "failed" && input.error == null) {
    throw new Error("Failed observations require an error receipt.");
  }

  const statesByEntity = new Map<
    string,
    MetaEntityObservationStateInput & { stateHash: string }
  >();
  for (const rawState of input.states) {
    const stateEntityId = requireNonEmpty(rawState.entityId, "entityId");
    if (
      rawState.businessId !== businessId ||
      rawState.providerAccountId !== providerAccountId ||
      rawState.entityType !== entityType
    ) {
      throw new Error("State identity does not match its observation run.");
    }
    const stateObservedAt = normalizeTimestamp(
      rawState.observedAt,
      "state.observedAt",
    );
    if (new Date(stateObservedAt).getTime() > new Date(capturedAt).getTime()) {
      throw new Error("State observedAt cannot be after capturedAt.");
    }
    const normalizedState = {
      ...rawState,
      entityId: stateEntityId,
      observedAt: stateObservedAt,
    };
    statesByEntity.set(stateEntityId, {
      ...normalizedState,
      stateHash: buildMetaEntityStateHash(normalizedState),
    });
  }
  const states = Array.from(statesByEntity.values()).sort((a, b) =>
    a.entityId.localeCompare(b.entityId),
  );
  const payloadHash =
    input.payloadHash ??
    sha256(
      states.map((state) => ({
        entityId: state.entityId,
        observedAt: state.observedAt,
        stateHash: state.stateHash,
      })),
    );
  const runHash = buildMetaObservationRunHash({
    businessId,
    providerAccountId,
    entityType,
    endpoint,
    observedAt,
    capturedAt,
    completeness: input.completeness,
    pageCount,
    rowCount: providerRowCount,
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    payloadHash,
    error: input.error ?? null,
  });

  const semanticHash = buildMetaObservationSemanticHash({
    businessId,
    providerAccountId,
    entityType,
    endpoint,
    completeness: input.completeness,
    pageCount,
    rowCount: providerRowCount,
    error: input.error ?? null,
    states: states.map((state) => ({
      entityId: state.entityId,
      stateHash: state.stateHash,
    })),
  });

  return runDbTransaction(async () => {
    const sql = getDb();
    const binding = await resolveMetaAccountBinding(sql, {
      businessId,
      providerAccountId,
    });

    // Deterministic lock per observation key, so two workers observing the same
    // account and endpoint at the same moment cannot both decide "this truth is
    // new" and both write a full state set.
    await sql`
      SELECT pg_advisory_xact_lock(
        ${META_OBSERVATION_COALESCE_LOCK_NAMESPACE}::int,
        hashtext(${`meta_entity_observation:${businessId}:${providerAccountId}:${entityType}:${endpoint}`})
      )
    `;

    const currentRows = await sql<{
      id: string;
      semantic_hash: string | null;
      repeat_count: number | string | null;
      last_checkpoint_at: string | null;
      observed_at: string;
      captured_at: string;
    }>`
      SELECT id, semantic_hash, repeat_count,
             last_checkpoint_at::text AS last_checkpoint_at,
             observed_at::text AS observed_at,
             captured_at::text AS captured_at
      FROM meta_entity_observation_runs
      WHERE business_id = ${businessId}
        AND provider_account_id = ${providerAccountId}
        AND entity_type = ${entityType}
        AND endpoint = ${endpoint}
        -- Health transitions do not mutate entity truth. A failed or partial
        -- receipt between two identical complete receipts used to break the
        -- heartbeat chain and rewrite the complete payload in full. Compare
        -- only within the same completeness lane so complete A -> failed ->
        -- complete A reuses A, while complete A -> complete B -> complete A
        -- still records both real state transitions.
        AND completeness = ${input.completeness}
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `;
    const currentRun = currentRows[0];

    if (currentRun && currentRun.semantic_hash === semanticHash) {
      // The same truth again. A full auditable checkpoint is forced only at the
      // declared cadence; until then this advances the heartbeat and writes no
      // state and no lineage payload at all.
      const anchorMs = Date.parse(
        currentRun.last_checkpoint_at ?? currentRun.observed_at,
      );
      const elapsedMs = Number.isFinite(anchorMs)
        ? new Date(observedAt).getTime() - anchorMs
        : Number.POSITIVE_INFINITY;
      if (elapsedMs < metaObservationCheckpointIntervalMs(input.completeness)) {
        // D075 acceptance correction 1: the heartbeat clocks are MONOTONIC.
        // An accepted older exact replay (H2) must not move them backward —
        // a regression here erases already-established confirmed_until
        // evidence and demotes a proven no_response back to unknown. This
        // mirrors the GREATEST guard the ON CONFLICT (run_hash) branch has
        // always had.
        const heartbeat = await sql<{ repeat_count: number | string }>`
          UPDATE meta_entity_observation_runs
          SET last_seen_at = GREATEST(
                COALESCE(last_seen_at, observed_at),
                ${observedAt}::timestamptz
              ),
              last_captured_at = GREATEST(
                COALESCE(last_captured_at, captured_at),
                ${capturedAt}::timestamptz
              ),
              repeat_count = repeat_count + 1,
              source_snapshot_id = COALESCE(${input.sourceSnapshotId ?? null}, source_snapshot_id)
          WHERE id = ${currentRun.id}
          RETURNING repeat_count
        `;
        // Lineage is processed on the coalesced path too.
        //
        // Relationship truth is deliberately NOT part of the semantic identity:
        // the entity states really are the same, and re-writing a full state set
        // because a link appeared is the growth this heartbeat exists to remove.
        // But `creative{id}` is a separate field group that can be absent on one
        // observation and present on the next, so returning early here threw the
        // newly-available edge away — permanently, because the next identical
        // observation coalesces again.
        //
        // The edge is keyed to the run whose state rows are already durable, and
        // both lineage arbiters are DO NOTHING, so this is idempotent on a true
        // repeat and records exactly the new edges on a relationship-only change.
        // D075: `states` handed to lineage must describe rows that are
        // durable in the target run. Under delta manifests the kept run may
        // not contain every incoming entity, so resolve the
        // relationship-relevant rows the run actually holds — and CARRY the
        // missing ones in. A relationship first seen while the states
        // coalesce would otherwise be silently deferred until the next
        // appending observation (H8 all over again, one manifest kind down).
        // The carried row is byte-identical to the lane winner — the
        // observation coalesced, so every entity's state_hash matches the
        // kept run's payload — and it takes the KEPT run's clocks because
        // the composite run FK pins state rows to them.
        const lineageAdIds =
          entityType === "ad"
            ? await lineageRelevantAdIds(sql, {
                businessRefId: binding.business_ref_id,
                observedAt,
                adCreativeRelationships: input.adCreativeRelationships,
              })
            : new Set<string>();
        const durableLineageStates = await lineageStatesForRun(sql, {
          runId: currentRun.id,
          entityType,
          adIds: Array.from(lineageAdIds),
        });
        const durableLineageIds = new Set(
          durableLineageStates.map((state) => state.entityId),
        );
        const carriedLineageStates: Array<{
          entityId: string;
          adId: string | null;
          creativeId: string | null;
        }> = [];
        for (const adId of Array.from(lineageAdIds).sort()) {
          if (durableLineageIds.has(adId)) continue;
          const state = statesByEntity.get(adId);
          if (!state) continue;
          const carried = await sql<{ id: string }>`
            INSERT INTO meta_entity_state_history (
              run_id, business_ref_id, business_id, provider_account_ref_id,
              provider_account_id, entity_type, entity_id, campaign_id, adset_id,
              ad_id, creative_id, entity_name, configured_status, effective_status,
              learning_status, learning_source, campaign_daily_budget_raw,
              campaign_lifetime_budget_raw, adset_daily_budget_raw,
              adset_lifetime_budget_raw, budget_currency, budget_origin,
              campaign_start_time, campaign_end_time, adset_start_time, adset_end_time,
              budget_currency_exponent, budget_currency_registry_version,
              budget_shape_support,
              provider_api_version, review_status,
              policy_status, policy_reasons_json, provider_updated_at, presence,
              field_coverage_json, observed_at, captured_at, run_completeness, state_hash
            ) VALUES (
              ${currentRun.id}, ${binding.business_ref_id}, ${businessId},
              ${binding.provider_account_ref_id}, ${providerAccountId}, ${entityType},
              ${state.entityId}, ${state.campaignId ?? null}, ${state.adsetId ?? null},
              ${state.adId ?? null}, ${state.creativeId ?? null},
              ${state.entityName ?? null}, ${state.configuredStatus ?? null},
              ${state.effectiveStatus ?? null}, ${state.learningStatus ?? null},
              ${state.learningSource}, ${state.campaignDailyBudgetRaw ?? null},
              ${state.campaignLifetimeBudgetRaw ?? null},
              ${state.adsetDailyBudgetRaw ?? null},
              ${state.adsetLifetimeBudgetRaw ?? null}, ${state.budgetCurrency ?? null},
              ${state.budgetOrigin},
              ${state.campaignStartTime ?? null}::timestamptz,
              ${state.campaignEndTime ?? null}::timestamptz,
              ${state.adsetStartTime ?? null}::timestamptz,
              ${state.adsetEndTime ?? null}::timestamptz,
              ${state.budgetCurrencyExponent ?? null},
              ${state.budgetCurrencyRegistryVersion ?? null},
              ${state.budgetShapeSupport ?? null},
              ${state.providerApiVersion ?? null},
              ${state.reviewStatus ?? null},
              ${state.policyStatus ?? null},
              ${state.policyReasons == null ? null : JSON.stringify(state.policyReasons)}::jsonb,
              ${state.providerUpdatedAt ?? null}::timestamptz, ${state.presence},
              ${JSON.stringify(state.fieldCoverage)}::jsonb,
              ${currentRun.observed_at}::timestamptz, ${currentRun.captured_at}::timestamptz,
              ${input.completeness}, ${state.stateHash}
            )
            ON CONFLICT (run_id, entity_id) DO UPDATE SET
              state_hash = meta_entity_state_history.state_hash
            WHERE meta_entity_state_history.state_hash = EXCLUDED.state_hash
            RETURNING id
          `;
          if (!carried[0]) {
            throw new Error(
              `Lineage carry conflicted with different state for ${state.entityId}.`,
            );
          }
          carriedLineageStates.push({
            entityId: state.entityId,
            adId: state.adId ?? null,
            creativeId: state.creativeId ?? null,
          });
        }
        if (carriedLineageStates.length > 0) {
          // Keep the run's write telemetry truthful about the extra rows.
          await sql`
            UPDATE meta_entity_observation_runs
            SET delta_stats_json = jsonb_set(
              jsonb_set(
                delta_stats_json,
                '{physicalStateRows}',
                to_jsonb(
                  COALESCE((delta_stats_json->>'physicalStateRows')::int, 0)
                  + ${carriedLineageStates.length}
                )
              ),
              '{lineageCarriedEntityCount}',
              to_jsonb(
                COALESCE((delta_stats_json->>'lineageCarriedEntityCount')::int, 0)
                + ${carriedLineageStates.length}
              )
            )
            WHERE id = ${currentRun.id}
              AND delta_stats_json IS NOT NULL
          `;
        }
        const lineageStates = [
          ...durableLineageStates,
          ...carriedLineageStates,
        ];
        const lineageCount = await persistMetaObservationLineage(sql, {
          runId: currentRun.id,
          binding,
          businessId,
          providerAccountId,
          entityType,
          completeness: input.completeness,
          // The KEPT run's clocks, because `meta_creative_lineage_edges` carries
          // a composite foreign key onto
          // (observation_run_id, …, observed_at, captured_at, completeness) and
          // an edge attached to the coalesced run must describe that run's
          // identity exactly or the write is rejected outright.
          observedAt: currentRun.observed_at,
          capturedAt: currentRun.captured_at,
          // ...but the relationship was observed NOW. Recording the run's t1 as
          // the observation time made an as-of read at t1 return an edge that
          // did not exist until t2.
          relationshipObservedAt: observedAt,
          relationshipCapturedAt: capturedAt,
          states: lineageStates,
          adCreativeRelationships: input.adCreativeRelationships,
        });
        if (input.captureReceipt) {
          await appendObservationCaptureReceipt(sql, {
            runId: currentRun.id,
            businessId,
            providerAccountId,
            entityType,
            endpoint,
            partitionId: input.captureReceipt.partitionId,
            sourceSnapshotId: input.captureReceipt.sourceSnapshotId ?? null,
            sourceSnapshotRefId: input.captureReceipt.sourceSnapshotRefId ?? null,
            captureStatus: input.completeness,
            providerRowCount,
            pageCount,
            // The run was NOT appended. This is the row that proves a single
            // run can represent more than one capture cohort.
            runReused: true,
            // THIS occurrence's clocks, not the kept run's. The run's clocks
            // are the content's first sighting; the receipt is when we looked.
            observedAt,
            capturedAt,
            error: input.error ?? null,
          });
        }
        return {
          runId: currentRun.id,
          runHash,
          semanticHash,
          coalesced: true,
          repeatCount: Number(heartbeat[0]?.repeat_count ?? 0),
          stateCount: carriedLineageStates.length,
          lineageCount,
          completeness: input.completeness,
          observedAt: currentRun.observed_at,
          capturedAt: currentRun.captured_at,
          manifestKind: null,
          deltaStats: null,
        };
      }
    }

    // D075: delta-bounded complete manifests. A complete observation with a
    // reconstructable baseline persists only changed, new, and scope-exited
    // entities; unchanged entities write nothing. The first complete
    // observation of a scope, and every non-complete lane, keep the full
    // write exactly as before.
    let manifestKind: "full" | "delta" | null = null;
    let baseRunId: string | null = null;
    let statesToPersist = states;
    let deltaStats: MetaObservationDeltaStats | null = null;
    if (input.completeness === "complete") {
      if (currentRun) {
        const baseline = await sql<{
          entity_id: string;
          state_hash: string;
          presence: MetaEntityPresence;
          campaign_id: string | null;
          adset_id: string | null;
          ad_id: string | null;
          creative_id: string | null;
        }>`
          SELECT DISTINCT ON (state.entity_id)
            state.entity_id, state.state_hash, state.presence,
            state.campaign_id, state.adset_id, state.ad_id, state.creative_id
          FROM meta_entity_state_history state
          JOIN meta_entity_observation_runs scope_run
            ON scope_run.id = state.run_id
          WHERE state.business_id = ${businessId}
            AND state.provider_account_id = ${providerAccountId}
            AND state.entity_type = ${entityType}
            AND state.run_completeness = 'complete'
            -- The scope unit of a complete manifest is the ENDPOINT, exactly
            -- like the base-run lookup above. A baseline spanning endpoints
            -- would fabricate scope exits for entities another endpoint
            -- legitimately observes.
            AND scope_run.endpoint = ${endpoint}
            -- Reconstruct the predecessor as it was knowable for THIS
            -- observation. A historical replay can arrive with a newer
            -- capture clock than a later-observed live state; without both
            -- cutoffs it can compare against the future and without
            -- observed_at-first ordering it can become the next live run's
            -- false baseline.
            AND state.observed_at <= ${observedAt}::timestamptz
            AND state.captured_at <= ${capturedAt}::timestamptz
          ORDER BY state.entity_id, state.observed_at DESC,
            state.captured_at DESC, state.created_at DESC, state.id DESC
        `;
        const baselinePresent = new Map(
          baseline
            .filter((row) => row.presence === "present")
            .map((row) => [row.entity_id, row] as const),
        );
        let changedEntityCount = 0;
        let newEntityCount = 0;
        const deltaRows: typeof states = [];
        for (const state of states) {
          const prior = baselinePresent.get(state.entityId);
          if (!prior) {
            newEntityCount += 1;
            deltaRows.push(state);
          } else if (prior.state_hash !== state.stateHash) {
            changedEntityCount += 1;
            deltaRows.push(state);
          }
        }
        // Scope exit is explicit evidence: an entity that was present in the
        // reconstructed baseline but is absent from this complete payload
        // persists one `absent_unconfirmed` row, so no reader can ever
        // resurrect the stale present row past this observation.
        const exitedRows: typeof states = [];
        for (const [entityId, prior] of baselinePresent) {
          if (statesByEntity.has(entityId)) continue;
          const absentState = {
            businessId,
            providerAccountId,
            entityType,
            entityId,
            campaignId: prior.campaign_id,
            adsetId: prior.adset_id,
            adId: prior.ad_id,
            creativeId: prior.creative_id,
            learningSource: "not_observed" as const,
            budgetOrigin: "not_observed" as const,
            presence: "absent_unconfirmed" as const,
            fieldCoverage: {},
            observedAt,
          };
          exitedRows.push({
            ...absentState,
            stateHash: buildMetaEntityStateHash(absentState),
          });
        }
        // Creative-lineage edges FK-reference state rows BY RUN, so any ad
        // this observation's lineage evidence names must have a durable row
        // in this run even when its state did not change. These small
        // carried rows are counted separately in the stats.
        let lineageCarriedEntityCount = 0;
        if (entityType === "ad") {
          const lineageAdIds = await lineageRelevantAdIds(sql, {
            businessRefId: binding.business_ref_id,
            observedAt,
            adCreativeRelationships: input.adCreativeRelationships,
          });
          if (lineageAdIds.size > 0) {
            const included = new Set(deltaRows.map((row) => row.entityId));
            for (const adId of lineageAdIds) {
              const state = statesByEntity.get(adId);
              if (state && !included.has(adId)) {
                deltaRows.push(state);
                included.add(adId);
                lineageCarriedEntityCount += 1;
              }
            }
          }
        }
        statesToPersist = [...deltaRows, ...exitedRows].sort((a, b) =>
          a.entityId.localeCompare(b.entityId),
        );
        manifestKind = "delta";
        baseRunId = currentRun.id;
        deltaStats = {
          logicalEntityCount: states.length,
          changedEntityCount,
          newEntityCount,
          exitedEntityCount: exitedRows.length,
          lineageCarriedEntityCount,
          physicalStateRows: statesToPersist.length,
          amplification:
            statesToPersist.length / Math.max(1, states.length),
        };
      } else {
        manifestKind = "full";
        deltaStats = {
          logicalEntityCount: states.length,
          changedEntityCount: 0,
          newEntityCount: states.length,
          exitedEntityCount: 0,
          lineageCarriedEntityCount: 0,
          physicalStateRows: states.length,
          amplification: 1,
        };
      }
    }

    const runRows = await sql<MetaObservationRunDbRow>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        entity_type, endpoint, observed_at, captured_at, completeness, page_count,
        row_count, source_snapshot_id, payload_hash, run_hash, error_json,
        semantic_hash, last_seen_at, last_captured_at, repeat_count,
        last_checkpoint_at, manifest_kind, base_run_id, delta_stats_json
      ) VALUES (
        ${binding.business_ref_id}, ${businessId}, ${binding.provider_account_ref_id},
        ${providerAccountId}, ${entityType}, ${endpoint}, ${observedAt}::timestamptz,
        ${capturedAt}::timestamptz, ${input.completeness}, ${pageCount},
        ${providerRowCount}, ${input.sourceSnapshotId ?? null}, ${payloadHash},
        ${runHash}, ${input.error == null ? null : JSON.stringify(input.error)}::jsonb,
        ${semanticHash}, ${observedAt}::timestamptz,
        ${capturedAt}::timestamptz, 1, ${observedAt}::timestamptz,
        ${manifestKind}, ${baseRunId}::uuid,
        ${deltaStats == null ? null : JSON.stringify(deltaStats)}::jsonb
      )
      ON CONFLICT (run_hash) DO UPDATE SET
        semantic_hash = EXCLUDED.semantic_hash,
        -- run_hash includes the original clocks, so a conflict is an exact
        -- replay of an OLD receipt. The heartbeat clocks must never move
        -- backwards when the row has already been advanced past the replay.
        last_seen_at = GREATEST(
          COALESCE(meta_entity_observation_runs.last_seen_at,
            EXCLUDED.last_seen_at),
          EXCLUDED.last_seen_at
        ),
        last_captured_at = GREATEST(
          COALESCE(meta_entity_observation_runs.last_captured_at,
            EXCLUDED.last_captured_at),
          EXCLUDED.last_captured_at
        )
      RETURNING id, business_ref_id::text AS business_ref_id,
        provider_account_ref_id::text AS provider_account_ref_id,
        observed_at::text AS observed_at, captured_at::text AS captured_at,
        completeness
    `;
    const run = runRows[0];
    if (!run) throw new Error("Observation run insert returned no row.");

    let stateCount = 0;
    for (const state of statesToPersist) {
      const persisted = await sql<MetaPersistedStateDbRow>`
        INSERT INTO meta_entity_state_history (
          run_id, business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, entity_id, campaign_id, adset_id,
          ad_id, creative_id, entity_name, configured_status, effective_status,
          learning_status, learning_source, campaign_daily_budget_raw,
          campaign_lifetime_budget_raw, adset_daily_budget_raw,
          adset_lifetime_budget_raw, budget_currency, budget_origin,
          campaign_start_time, campaign_end_time, adset_start_time, adset_end_time,
          budget_currency_exponent, budget_currency_registry_version,
          budget_shape_support,
          provider_api_version, review_status,
          policy_status, policy_reasons_json, provider_updated_at, presence,
          field_coverage_json, observed_at, captured_at, run_completeness, state_hash
        ) VALUES (
          ${run.id}, ${binding.business_ref_id}, ${businessId},
          ${binding.provider_account_ref_id}, ${providerAccountId}, ${entityType},
          ${state.entityId}, ${state.campaignId ?? null}, ${state.adsetId ?? null},
          ${state.adId ?? null}, ${state.creativeId ?? null},
          ${state.entityName ?? null}, ${state.configuredStatus ?? null},
          ${state.effectiveStatus ?? null}, ${state.learningStatus ?? null},
          ${state.learningSource}, ${state.campaignDailyBudgetRaw ?? null},
          ${state.campaignLifetimeBudgetRaw ?? null},
          ${state.adsetDailyBudgetRaw ?? null},
          ${state.adsetLifetimeBudgetRaw ?? null}, ${state.budgetCurrency ?? null},
          ${state.budgetOrigin},
          ${state.campaignStartTime ?? null}::timestamptz,
          ${state.campaignEndTime ?? null}::timestamptz,
          ${state.adsetStartTime ?? null}::timestamptz,
          ${state.adsetEndTime ?? null}::timestamptz,
          ${state.budgetCurrencyExponent ?? null},
          ${state.budgetCurrencyRegistryVersion ?? null},
          ${state.budgetShapeSupport ?? null},
          ${state.providerApiVersion ?? null},
          ${state.reviewStatus ?? null},
          ${state.policyStatus ?? null},
          ${state.policyReasons == null ? null : JSON.stringify(state.policyReasons)}::jsonb,
          ${state.providerUpdatedAt ?? null}::timestamptz, ${state.presence},
          ${JSON.stringify(state.fieldCoverage)}::jsonb,
          ${state.observedAt}::timestamptz, ${capturedAt}::timestamptz,
          ${input.completeness}, ${state.stateHash}
        )
        ON CONFLICT (run_id, entity_id) DO UPDATE SET
          state_hash = meta_entity_state_history.state_hash
        WHERE meta_entity_state_history.state_hash = EXCLUDED.state_hash
        RETURNING id, state_hash
      `;
      if (!persisted[0]) {
        throw new Error(
          `Observation retry conflicted with different state for ${state.entityId}.`,
        );
      }
      stateCount += 1;
    }

    const lineageCount = await persistMetaObservationLineage(sql, {
      runId: run.id,
      binding,
      businessId,
      providerAccountId,
      entityType,
      completeness: input.completeness,
      observedAt,
      capturedAt,
      // D075: only rows durable in THIS run — lineage edges FK-reference
      // (run_id, entity_type, ad_id, creative_id), and a delta run does not
      // contain unchanged entities.
      states: statesToPersist,
      adCreativeRelationships: input.adCreativeRelationships,
    });

    if (input.captureReceipt) {
      await appendObservationCaptureReceipt(sql, {
        runId: run.id,
        businessId,
        providerAccountId,
        entityType,
        endpoint,
        partitionId: input.captureReceipt.partitionId,
        sourceSnapshotId: input.captureReceipt.sourceSnapshotId ?? null,
        sourceSnapshotRefId: input.captureReceipt.sourceSnapshotRefId ?? null,
        captureStatus: input.completeness,
        providerRowCount,
        pageCount,
        runReused: false,
        observedAt,
        capturedAt,
        error: input.error ?? null,
      });
    }
    return {
      runId: run.id,
      runHash,
      semanticHash,
      coalesced: false,
      repeatCount: 1,
      stateCount,
      lineageCount,
      manifestKind,
      deltaStats,
      completeness: input.completeness,
      observedAt,
      capturedAt,
    };
  });
}

export async function persistMetaExplicitEntityTombstone(
  input: PersistMetaExplicitEntityTombstoneInput,
) {
  const businessId = requireNonEmpty(input.businessId, "businessId");
  const providerAccountId = requireNonEmpty(
    input.providerAccountId,
    "providerAccountId",
  );
  const entityType = normalizeEntityType(input.entityType);
  const entityId = requireNonEmpty(input.entityId, "entityId");
  const endpoint = requireNonEmpty(input.endpoint, "endpoint");
  const observedAt = normalizeTimestamp(input.observedAt, "observedAt");
  const capturedAt = normalizeTimestamp(input.capturedAt, "capturedAt");
  if (new Date(observedAt).getTime() > new Date(capturedAt).getTime()) {
    throw new Error("observedAt cannot be after capturedAt.");
  }
  if (!input.providerEvidence || Array.isArray(input.providerEvidence)) {
    throw new Error("providerEvidence must be an object.");
  }
  const payloadHash = sha256(input.providerEvidence);
  const runHash = buildMetaObservationRunHash({
    businessId,
    providerAccountId,
    entityType,
    endpoint,
    observedAt,
    capturedAt,
    completeness: "point_lookup",
    pageCount: 1,
    rowCount: 0,
    sourceSnapshotId: input.sourceSnapshotId ?? null,
    payloadHash,
  });
  const tombstoneHash = buildMetaTombstoneHash({
    businessId,
    providerAccountId,
    entityType,
    entityId,
    reason: input.reason,
    providerEvidence: input.providerEvidence,
  });

  return runDbTransaction(async () => {
    const sql = getDb();
    const binding = await resolveMetaAccountBinding(sql, {
      businessId,
      providerAccountId,
    });
    const runRows = await sql<MetaObservationRunDbRow>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        entity_type, endpoint, observed_at, captured_at, completeness, page_count,
        row_count, source_snapshot_id, payload_hash, run_hash
      ) VALUES (
        ${binding.business_ref_id}, ${businessId}, ${binding.provider_account_ref_id},
        ${providerAccountId}, ${entityType}, ${endpoint}, ${observedAt}::timestamptz,
        ${capturedAt}::timestamptz, 'point_lookup', 1, 0,
        ${input.sourceSnapshotId ?? null}, ${payloadHash}, ${runHash}
      )
      ON CONFLICT (run_hash) DO UPDATE SET run_hash = EXCLUDED.run_hash
      RETURNING id, business_ref_id::text AS business_ref_id,
        provider_account_ref_id::text AS provider_account_ref_id,
        observed_at::text AS observed_at, captured_at::text AS captured_at,
        completeness
    `;
    const run = runRows[0];
    if (!run) throw new Error("Point observation insert returned no row.");
    const tombstones = await sql<{ id: string; tombstone_hash: string }>`
      INSERT INTO meta_entity_tombstones (
        run_id, business_ref_id, business_id, provider_account_ref_id,
        provider_account_id, entity_type, entity_id, reason,
        provider_evidence_json, observed_at, captured_at, run_completeness,
        tombstone_hash
      ) VALUES (
        ${run.id}, ${binding.business_ref_id}, ${businessId},
        ${binding.provider_account_ref_id}, ${providerAccountId}, ${entityType},
        ${entityId}, ${input.reason}, ${JSON.stringify(input.providerEvidence)}::jsonb,
        ${observedAt}::timestamptz, ${capturedAt}::timestamptz, 'point_lookup',
        ${tombstoneHash}
      )
      ON CONFLICT (run_id, entity_type, entity_id, reason) DO UPDATE SET
        tombstone_hash = meta_entity_tombstones.tombstone_hash
      WHERE meta_entity_tombstones.tombstone_hash = EXCLUDED.tombstone_hash
      RETURNING id, tombstone_hash
    `;
    if (!tombstones[0]) {
      throw new Error("Point-evidence retry conflicted with another tombstone.");
    }
    return {
      runId: run.id,
      runHash,
      tombstoneId: tombstones[0].id,
      tombstoneHash,
    };
  });
}

function mapState(row: MetaEntityStateDbRow): MetaEntityStateHistoryRow {
  return {
    id: row.id,
    runId: row.run_id,
    businessRefId: row.business_ref_id,
    businessId: row.business_id,
    providerAccountRefId: row.provider_account_ref_id,
    providerAccountId: row.provider_account_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    adId: row.ad_id,
    creativeId: row.creative_id,
    entityName: row.entity_name,
    configuredStatus: row.configured_status,
    effectiveStatus: row.effective_status,
    learningStatus: row.learning_status,
    learningSource: row.learning_source,
    campaignDailyBudgetRaw: row.campaign_daily_budget_raw,
    campaignLifetimeBudgetRaw: row.campaign_lifetime_budget_raw,
    adsetDailyBudgetRaw: row.adset_daily_budget_raw,
    adsetLifetimeBudgetRaw: row.adset_lifetime_budget_raw,
    budgetCurrency: row.budget_currency,
    budgetOrigin: row.budget_origin,
    campaignStartTime: row.campaign_start_time,
    campaignEndTime: row.campaign_end_time,
    adsetStartTime: row.adset_start_time,
    adsetEndTime: row.adset_end_time,
    budgetCurrencyExponent: row.budget_currency_exponent,
    budgetCurrencyRegistryVersion: row.budget_currency_registry_version,
    budgetShapeSupport: row.budget_shape_support,
    providerApiVersion: row.provider_api_version,
    reviewStatus: row.review_status,
    policyStatus: row.policy_status,
    policyReasons: row.policy_reasons_json,
    providerUpdatedAt: row.provider_updated_at,
    presence: row.presence,
    fieldCoverage: row.field_coverage_json,
    observedAt: row.observed_at,
    capturedAt: row.captured_at,
    runCompleteness: row.run_completeness,
    stateHash: row.state_hash,
  };
}

function stateSelect(
  sql: ReturnType<typeof getDb>,
  input: {
    businessId: string;
    providerAccountId: string;
    entityType: MetaEntityType;
    entityIds: string[];
    cutoff: string;
  },
) {
  return input.entityIds.length > 0
    ? sql<MetaEntityStateDbRow>`
        SELECT DISTINCT ON (entity_id)
          id, run_id, business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, entity_id, campaign_id, adset_id, ad_id,
          creative_id, entity_name, configured_status, effective_status, learning_status,
          learning_source, campaign_daily_budget_raw, campaign_lifetime_budget_raw,
          adset_daily_budget_raw, adset_lifetime_budget_raw, budget_currency, budget_origin,
          campaign_start_time::text AS campaign_start_time,
          campaign_end_time::text AS campaign_end_time,
          adset_start_time::text AS adset_start_time,
          adset_end_time::text AS adset_end_time,
          budget_currency_exponent, budget_currency_registry_version, budget_shape_support,
          provider_api_version,
          review_status, policy_status, policy_reasons_json, provider_updated_at, presence,
          field_coverage_json, observed_at::text AS observed_at,
          captured_at::text AS captured_at, run_completeness, state_hash
        FROM meta_entity_state_history
        WHERE business_id = ${input.businessId}
          AND provider_account_id = ${input.providerAccountId}
          AND entity_type = ${input.entityType}
          AND entity_id = ANY(${input.entityIds}::text[])
          AND observed_at <= ${input.cutoff}::timestamptz
          AND captured_at <= ${input.cutoff}::timestamptz
          AND run_completeness IN ('complete', 'partial', 'point_lookup')
        ORDER BY entity_id, observed_at DESC, captured_at DESC, created_at DESC, id DESC
      `
    : sql<MetaEntityStateDbRow>`
        SELECT DISTINCT ON (entity_id)
          id, run_id, business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, entity_id, campaign_id, adset_id, ad_id,
          creative_id, entity_name, configured_status, effective_status, learning_status,
          learning_source, campaign_daily_budget_raw, campaign_lifetime_budget_raw,
          adset_daily_budget_raw, adset_lifetime_budget_raw, budget_currency, budget_origin,
          campaign_start_time::text AS campaign_start_time,
          campaign_end_time::text AS campaign_end_time,
          adset_start_time::text AS adset_start_time,
          adset_end_time::text AS adset_end_time,
          budget_currency_exponent, budget_currency_registry_version, budget_shape_support,
          provider_api_version,
          review_status, policy_status, policy_reasons_json, provider_updated_at, presence,
          field_coverage_json, observed_at::text AS observed_at,
          captured_at::text AS captured_at, run_completeness, state_hash
        FROM meta_entity_state_history
        WHERE business_id = ${input.businessId}
          AND provider_account_id = ${input.providerAccountId}
          AND entity_type = ${input.entityType}
          AND observed_at <= ${input.cutoff}::timestamptz
          AND captured_at <= ${input.cutoff}::timestamptz
          AND run_completeness IN ('complete', 'partial', 'point_lookup')
        ORDER BY entity_id, observed_at DESC, captured_at DESC, created_at DESC, id DESC
      `;
}

export async function readMetaEntityStatesAsOf(input: {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  entityIds?: string[] | null;
  cutoff: string | Date;
}) {
  const sql = getDb();
  const rows = await stateSelect(sql, {
    businessId: requireNonEmpty(input.businessId, "businessId"),
    providerAccountId: requireNonEmpty(
      input.providerAccountId,
      "providerAccountId",
    ),
    entityType: normalizeEntityType(input.entityType),
    entityIds: normalizeEntityIds(input.entityIds),
    cutoff: normalizeCutoff(input.cutoff),
  });
  return rows.map(mapState);
}

function mapTombstone(row: MetaEntityTombstoneDbRow): MetaEntityTombstone {
  return {
    id: row.id,
    runId: row.run_id,
    businessRefId: row.business_ref_id,
    businessId: row.business_id,
    providerAccountRefId: row.provider_account_ref_id,
    providerAccountId: row.provider_account_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    providerEvidence: row.provider_evidence_json,
    observedAt: row.observed_at,
    capturedAt: row.captured_at,
    runCompleteness: row.run_completeness,
    tombstoneHash: row.tombstone_hash,
  };
}

export async function readMetaEntityTombstonesAsOf(input: {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  entityIds?: string[] | null;
  cutoff: string | Date;
}) {
  const sql = getDb();
  const businessId = requireNonEmpty(input.businessId, "businessId");
  const providerAccountId = requireNonEmpty(
    input.providerAccountId,
    "providerAccountId",
  );
  const entityType = normalizeEntityType(input.entityType);
  const entityIds = normalizeEntityIds(input.entityIds);
  const cutoff = normalizeCutoff(input.cutoff);
  const rows =
    entityIds.length > 0
      ? await sql<MetaEntityTombstoneDbRow>`
        SELECT DISTINCT ON (entity_id)
          id, run_id, business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, entity_id, reason, provider_evidence_json,
          observed_at::text AS observed_at, captured_at::text AS captured_at,
          run_completeness, tombstone_hash
        FROM meta_entity_tombstones
        WHERE business_id = ${businessId}
          AND provider_account_id = ${providerAccountId}
          AND entity_type = ${entityType}
          AND entity_id = ANY(${entityIds}::text[])
          AND observed_at <= ${cutoff}::timestamptz
          AND captured_at <= ${cutoff}::timestamptz
          AND reason IN ('explicit_deleted', 'explicit_not_found')
        ORDER BY entity_id, observed_at DESC, captured_at DESC, created_at DESC, id DESC
      `
      : await sql<MetaEntityTombstoneDbRow>`
        SELECT DISTINCT ON (entity_id)
          id, run_id, business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, entity_id, reason, provider_evidence_json,
          observed_at::text AS observed_at, captured_at::text AS captured_at,
          run_completeness, tombstone_hash
        FROM meta_entity_tombstones
        WHERE business_id = ${businessId}
          AND provider_account_id = ${providerAccountId}
          AND entity_type = ${entityType}
          AND observed_at <= ${cutoff}::timestamptz
          AND captured_at <= ${cutoff}::timestamptz
          AND reason IN ('explicit_deleted', 'explicit_not_found')
        ORDER BY entity_id, observed_at DESC, captured_at DESC, created_at DESC, id DESC
      `;
  return rows.map(mapTombstone);
}

export async function readMetaEntityTruthAsOf(input: {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  entityIds?: string[] | null;
  cutoff: string | Date;
}) {
  const sql = getDb();
  const businessId = requireNonEmpty(input.businessId, "businessId");
  const providerAccountId = requireNonEmpty(
    input.providerAccountId,
    "providerAccountId",
  );
  const entityType = normalizeEntityType(input.entityType);
  const entityIds = normalizeEntityIds(input.entityIds);
  const cutoff = normalizeCutoff(input.cutoff);
  const rows =
    entityIds.length > 0
      ? await sql<MetaEntityTruthDbRow>`
        WITH scoped_events AS (
          SELECT 'state'::text AS event_kind, id AS event_id, entity_id,
                 observed_at, captured_at, created_at, state_hash AS evidence_hash,
                 NULL::text AS tombstone_reason
          FROM meta_entity_state_history
          WHERE business_id = ${businessId}
            AND provider_account_id = ${providerAccountId}
            AND entity_type = ${entityType}
            AND entity_id = ANY(${entityIds}::text[])
            AND observed_at <= ${cutoff}::timestamptz
            AND captured_at <= ${cutoff}::timestamptz
          UNION ALL
          SELECT 'tombstone'::text AS event_kind, id AS event_id, entity_id,
                 observed_at, captured_at, created_at, tombstone_hash AS evidence_hash,
                 reason AS tombstone_reason
          FROM meta_entity_tombstones
          WHERE business_id = ${businessId}
            AND provider_account_id = ${providerAccountId}
            AND entity_type = ${entityType}
            AND entity_id = ANY(${entityIds}::text[])
            AND observed_at <= ${cutoff}::timestamptz
            AND captured_at <= ${cutoff}::timestamptz
        )
        SELECT DISTINCT ON (entity_id)
          event_kind, event_id, entity_id, observed_at::text AS observed_at,
          captured_at::text AS captured_at, evidence_hash, tombstone_reason
        FROM scoped_events
        ORDER BY entity_id, observed_at DESC, captured_at DESC,
                 (event_kind = 'tombstone') DESC, created_at DESC, event_id DESC
      `
      : await sql<MetaEntityTruthDbRow>`
        WITH scoped_events AS (
          SELECT 'state'::text AS event_kind, id AS event_id, entity_id,
                 observed_at, captured_at, created_at, state_hash AS evidence_hash,
                 NULL::text AS tombstone_reason
          FROM meta_entity_state_history
          WHERE business_id = ${businessId}
            AND provider_account_id = ${providerAccountId}
            AND entity_type = ${entityType}
            AND observed_at <= ${cutoff}::timestamptz
            AND captured_at <= ${cutoff}::timestamptz
          UNION ALL
          SELECT 'tombstone'::text AS event_kind, id AS event_id, entity_id,
                 observed_at, captured_at, created_at, tombstone_hash AS evidence_hash,
                 reason AS tombstone_reason
          FROM meta_entity_tombstones
          WHERE business_id = ${businessId}
            AND provider_account_id = ${providerAccountId}
            AND entity_type = ${entityType}
            AND observed_at <= ${cutoff}::timestamptz
            AND captured_at <= ${cutoff}::timestamptz
        )
        SELECT DISTINCT ON (entity_id)
          event_kind, event_id, entity_id, observed_at::text AS observed_at,
          captured_at::text AS captured_at, evidence_hash, tombstone_reason
        FROM scoped_events
        ORDER BY entity_id, observed_at DESC, captured_at DESC,
                 (event_kind = 'tombstone') DESC, created_at DESC, event_id DESC
      `;
  return rows.map((row): MetaEntityTruthPointer => ({
    eventKind: row.event_kind,
    eventId: row.event_id,
    entityId: row.entity_id,
    observedAt: row.observed_at,
    capturedAt: row.captured_at,
    evidenceHash: row.evidence_hash,
    tombstoneReason: row.tombstone_reason,
  }));
}

export async function readMetaCreativeLineageAsOf(input: {
  businessId: string;
  providerAccountId: string;
  cutoff: string | Date;
  creativeId?: string | null;
  limit?: number | null;
}) {
  const sql = getDb();
  const businessId = requireNonEmpty(input.businessId, "businessId");
  const providerAccountId = requireNonEmpty(
    input.providerAccountId,
    "providerAccountId",
  );
  const cutoff = normalizeCutoff(input.cutoff);
  const creativeId = input.creativeId?.trim() || null;
  const limit = normalizeLimit(input.limit);
  // DEDUPLICATED BY LOGICAL IDENTITY.
  //
  // `lineage_hash` used to include `observationRunId`, so the same logical fact
  // — this ad reuses that creative — got a new row on every observation. The
  // table is ~3.27 GB of those, and the collapse pass deliberately deletes
  // nothing, so the duplicates are still there and will remain there. A reader
  // that returns them all reports one relationship dozens of times and makes a
  // `LIMIT` return one relationship's history instead of many relationships.
  //
  // `DISTINCT ON` over the logical identity — the same tuple
  // `buildMetaCreativeLineageLogicalKey` hashes — returns the OLDEST observation
  // of each fact, which is what lineage means: when the relationship was first
  // seen. The physical rows stay untouched, so nothing is lost and the read
  // stops depending on a compaction that may never run.
  const dedupedColumns = `
    DISTINCT ON (
      lineage_type, source_ad_id, source_creative_id, target_ad_id,
      target_creative_id, evidence_source, action_log_id
    )
    id, business_ref_id, business_id, provider_account_ref_id, provider_account_id,
    source_ad_id, source_creative_id, target_ad_id, target_creative_id, lineage_type,
    evidence_source, observation_run_id, observation_run_entity_type,
    observation_run_completeness, action_log_id, action_type, action_status,
    action_verified_at::text AS action_verified_at, evidence_json,
    -- The EFFECTIVE observation instant. An edge recorded on a coalesced run
    -- carries that run's clocks for the foreign key's sake, so reading
    -- observed_at directly reports a relationship as seen at the kept run's t1
    -- when it was not observed until t2.
    COALESCE(relationship_observed_at, observed_at)::text AS observed_at,
    COALESCE(relationship_captured_at, captured_at)::text AS captured_at,
    lineage_hash
  `;
  const dedupedOrder = `
    ORDER BY lineage_type, source_ad_id, source_creative_id, target_ad_id,
             target_creative_id, evidence_source, action_log_id,
             COALESCE(relationship_observed_at, observed_at) ASC,
             COALESCE(relationship_captured_at, captured_at) ASC, id ASC
  `;
  const rows = (await sql.query(
    creativeId
      ? `SELECT * FROM (
           SELECT ${dedupedColumns}
           FROM meta_creative_lineage_edges
           WHERE business_id = $1
             AND provider_account_id = $2
             AND (source_creative_id = $3 OR target_creative_id = $3)
             AND COALESCE(relationship_observed_at, observed_at) <= $4::timestamptz
             AND COALESCE(relationship_captured_at, captured_at) <= $4::timestamptz
           ${dedupedOrder}
         ) deduped
         ORDER BY observed_at DESC, captured_at DESC, id DESC
         LIMIT $5`
      : `SELECT * FROM (
           SELECT ${dedupedColumns}
           FROM meta_creative_lineage_edges
           WHERE business_id = $1
             AND provider_account_id = $2
             AND COALESCE(relationship_observed_at, observed_at) <= $3::timestamptz
             AND COALESCE(relationship_captured_at, captured_at) <= $3::timestamptz
           ${dedupedOrder}
         ) deduped
         ORDER BY observed_at DESC, captured_at DESC, id DESC
         LIMIT $4`,
    creativeId
      ? [businessId, providerAccountId, creativeId, cutoff, limit]
      : [businessId, providerAccountId, cutoff, limit],
  )) as MetaCreativeLineageDbRow[];
  return rows.map((row): MetaCreativeLineageEdge => ({
    id: row.id,
    businessRefId: row.business_ref_id,
    businessId: row.business_id,
    providerAccountRefId: row.provider_account_ref_id,
    providerAccountId: row.provider_account_id,
    sourceAdId: row.source_ad_id,
    sourceCreativeId: row.source_creative_id,
    targetAdId: row.target_ad_id,
    targetCreativeId: row.target_creative_id,
    lineageType: row.lineage_type,
    evidenceSource: row.evidence_source,
    observationRunId: row.observation_run_id,
    observationRunEntityType: row.observation_run_entity_type,
    observationRunCompleteness: row.observation_run_completeness,
    actionLogId: row.action_log_id,
    actionType: row.action_type,
    actionStatus: row.action_status,
    actionVerifiedAt: row.action_verified_at,
    evidence: row.evidence_json,
    observedAt: row.observed_at,
    capturedAt: row.captured_at,
    lineageHash: row.lineage_hash,
  }));
}
