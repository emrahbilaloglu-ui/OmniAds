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
  /** True when identical truth advanced the heartbeat and wrote no payload. */
  coalesced: boolean;
  /** How many observations this run now represents. */
  repeatCount: number;
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

export function buildMetaEntityStateHash(input: MetaEntityStateHashInput) {
  return sha256({
    contractVersion: "meta-entity-state.v1",
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
        const heartbeat = await sql<{ repeat_count: number | string }>`
          UPDATE meta_entity_observation_runs
          SET last_seen_at = ${observedAt}::timestamptz,
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
          states,
          adCreativeRelationships: input.adCreativeRelationships,
        });
        return {
          runId: currentRun.id,
          runHash,
          semanticHash,
          coalesced: true,
          repeatCount: Number(heartbeat[0]?.repeat_count ?? 0),
          stateCount: 0,
          lineageCount,
          completeness: input.completeness,
          observedAt: currentRun.observed_at,
          capturedAt: currentRun.captured_at,
        };
      }
    }

    const runRows = await sql<MetaObservationRunDbRow>`
      INSERT INTO meta_entity_observation_runs (
        business_ref_id, business_id, provider_account_ref_id, provider_account_id,
        entity_type, endpoint, observed_at, captured_at, completeness, page_count,
        row_count, source_snapshot_id, payload_hash, run_hash, error_json,
        semantic_hash, last_seen_at, repeat_count, last_checkpoint_at
      ) VALUES (
        ${binding.business_ref_id}, ${businessId}, ${binding.provider_account_ref_id},
        ${providerAccountId}, ${entityType}, ${endpoint}, ${observedAt}::timestamptz,
        ${capturedAt}::timestamptz, ${input.completeness}, ${pageCount},
        ${providerRowCount}, ${input.sourceSnapshotId ?? null}, ${payloadHash},
        ${runHash}, ${input.error == null ? null : JSON.stringify(input.error)}::jsonb,
        ${semanticHash}, ${observedAt}::timestamptz, 1, ${observedAt}::timestamptz
      )
      ON CONFLICT (run_hash) DO UPDATE SET
        semantic_hash = EXCLUDED.semantic_hash,
        last_seen_at = EXCLUDED.last_seen_at
      RETURNING id, business_ref_id::text AS business_ref_id,
        provider_account_ref_id::text AS provider_account_ref_id,
        observed_at::text AS observed_at, captured_at::text AS captured_at,
        completeness
    `;
    const run = runRows[0];
    if (!run) throw new Error("Observation run insert returned no row.");

    let stateCount = 0;
    for (const state of states) {
      const persisted = await sql<MetaPersistedStateDbRow>`
        INSERT INTO meta_entity_state_history (
          run_id, business_ref_id, business_id, provider_account_ref_id,
          provider_account_id, entity_type, entity_id, campaign_id, adset_id,
          ad_id, creative_id, entity_name, configured_status, effective_status,
          learning_status, learning_source, campaign_daily_budget_raw,
          campaign_lifetime_budget_raw, adset_daily_budget_raw,
          adset_lifetime_budget_raw, budget_currency, budget_origin, review_status,
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
          ${state.budgetOrigin}, ${state.reviewStatus ?? null},
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
      states,
      adCreativeRelationships: input.adCreativeRelationships,
    });

    return {
      runId: run.id,
      runHash,
      semanticHash,
      coalesced: false,
      repeatCount: 1,
      stateCount,
      lineageCount,
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
