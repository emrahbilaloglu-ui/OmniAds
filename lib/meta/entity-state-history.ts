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
    /** ROUND 14: the real `meta_sync_runs.id` of the attempt. */
    syncRunId?: string | null;
    partitionId: string;
    sourceSnapshotId?: string | null;
    /** The raw snapshot row this capture was mapped from, as a real reference. */
    sourceSnapshotRefId?: string | null;
  } | null;
}

/**
 * WHAT A RUN'S PERSISTED STATE ROWS ARE, declared as a value.
 *
 * Before this constant the answer had to be INFERRED from a combination —
 * `completeness`, a NULL `manifest_kind`, and a `row_count` that is the logical
 * provider scope rather than the physical row count — and two different
 * storage semantics produced the same combination:
 *
 *   - legacy / `failed` / `point_lookup`: `manifest_kind` NULL because the run
 *     wrote every row it carried (or carried none), and
 *   - the deduped `partial` lane: `manifest_kind` NULL because 'delta' is a
 *     COMPLETE-lane word (see the block at the partial branch), while the rows
 *     it did write are a strict subset of what it observed.
 *
 * A reader that took NULL to mean "run-bound rows are this run's whole
 * payload" would read the second as the first. The discriminator removes the
 * inference: `delta_stats_json.manifestContract` says which contract produced
 * the rows, and it is present on every run this writer stamps stats onto.
 *
 * `manifest_kind` itself cannot carry the distinction: its column CHECK is
 * `manifest_kind IS NULL OR manifest_kind IN ('full','delta')`
 * (`lib/migrations.ts`, the `ADD COLUMN IF NOT EXISTS manifest_kind` statement),
 * so a third value needs a migration this change deliberately does not make.
 */
export const META_COMPLETE_MANIFEST_CONTRACT =
  "d075.complete-scope-manifest.v1" as const;

/**
 * The partial lane's storage contract, stated so no reader has to guess:
 *
 *  - the rows this run owns are the entities the payload POSITIVELY OBSERVED
 *    and whose content differed from the winner a reader already resolves;
 *  - `logicalEntityCount` (and the run's `row_count`) is the whole observed
 *    payload, which is larger than the row set whenever the dedupe suppressed
 *    anything, so `row_count` is NOT a membership count on this lane;
 *  - `exitedEntityCount` is structurally 0 and there is never an
 *    `absent_unconfirmed` row: a partial page proves what it contains, never
 *    what it omits, so this run makes no scope-membership claim at all;
 *  - the run is therefore NOT a manifest. Nothing may reconstruct a scope from
 *    it, and nothing may compare its member count to `row_count`.
 */
export const META_PARTIAL_MANIFEST_CONTRACT =
  "d075.partial-observed-present-delta.v1" as const;

export type MetaObservationManifestContract =
  | typeof META_COMPLETE_MANIFEST_CONTRACT
  | typeof META_PARTIAL_MANIFEST_CONTRACT;

/**
 * D075 write-amplification telemetry, persisted on the run as
 * `delta_stats_json` and returned to the caller. `logicalEntityCount` is the
 * full incoming scope (`row_count` keeps that meaning too);
 * `physicalStateRows` is what was actually appended.
 */
export interface MetaObservationDeltaStats {
  /** Which storage contract produced this run's rows. Never inferred. */
  manifestContract: MetaObservationManifestContract;
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
   * D075: how this run's manifest is stored. `'full'` on a first complete
   * observation of a scope, `'delta'` when only changed/new/exited entities
   * were appended, `null` everywhere else — coalesced results, the `failed`
   * and `point_lookup` lanes, AND the partial lane.
   *
   * A NULL here is NOT "this run wrote every row it carried". The partial lane
   * is delta-deduped too and still stamps NULL on purpose, because 'delta' is
   * a COMPLETE-lane word that three manifest-reconstruction readers switch on;
   * the block at that branch names them. `deltaStats.manifestContract` is the
   * field that says which storage contract produced the rows.
   */
  manifestKind: "full" | "delta" | null;
  /**
   * The write-amplification receipt for this run, or null when the run's rows
   * were not delta-bounded at all.
   *
   * NOT "present exactly when `manifestKind` is non-null", which is what the
   * previous revision of this comment claimed. The implication holds in ONE
   * direction only: a non-null `manifestKind` always carries stats, but the
   * partial lane writes `delta_stats_json` with `manifest_kind` NULL, so a
   * non-null `deltaStats` beside a NULL `manifestKind` is the ordinary shape
   * of a deduped partial run — and the shape a reader is likeliest to meet,
   * since the partial lane is the one that produced the 2026-09-07 rewrite
   * storm.
   *
   * Null on: a coalesced heartbeat result, the `failed` lane (which may carry
   * no states at all), the `point_lookup` lane, and a `partial` run whose
   * payload carried zero states. The `complete` lane always carries stats.
   */
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

/**
 * THREE DIFFERENT NULLS IN A SCHEDULE COLUMN, AND THE MARKER THAT SAYS WHICH.
 *
 * `campaign_start_time`, `campaign_end_time`, `adset_start_time` and
 * `adset_end_time` are `timestamptz` columns fed from provider strings. Until
 * this normalizer they reached PostgreSQL RAW: the campaign and ad-set mappers
 * in `lib/api/meta.ts` build them with `optionalString(input.row.start_time)`,
 * which trims and rejects blanks and validates nothing else, and both INSERT
 * sites in this module cast the result with `::timestamptz`. PostgreSQL was
 * therefore the FIRST thing that looked at the value, and it looks at it inside
 * `runDbTransaction` — so one unparsable string aborted the entire observation,
 * every entity in it. Measured against PostgreSQL 16.13:
 *
 *   select 'not-a-date'::timestamptz
 *     -> ERROR: invalid input syntax for type timestamp with time zone
 *   select ''::timestamptz
 *     -> ERROR: invalid input syntax for type timestamp with time zone
 *
 * `provider_updated_at` shares the column type and does NOT share the defect:
 * its mappers pass every value through `normalizeMetaProviderUpdatedAt` above,
 * which returns null on anything unparsable and on anything later than
 * `capturedAt`. The schedule fields were the ones with no such funnel.
 *
 * So a schedule value is validated BEFORE the write, and an unusable one
 * becomes an EXPLICIT UNKNOWN — the column is NULL and field coverage says
 * WHY. That marker is a THIRD thing, and the three must never be collapsed:
 *
 *   `true` beside a null value, or `false` — MEASURED ABSENCE. The request
 *     asked for the field and the response answered without a usable one.
 *     `metaFieldCoverageState` in `lib/api/meta.ts` writes these two.
 *   `degraded_not_observed` — NOT ASKED. The campaigns edge refused the
 *     schedule fields, the request was narrowed to be accepted at all, and the
 *     row's null is evidence of nothing. `lib/api/meta.ts` writes it as
 *     `META_FIELD_COVERAGE_DEGRADED`, and it is the ONE marker the read-side
 *     carry lateral in `stateSelect` restores a prior value for.
 *   `invalid_not_retained` — ASKED, ANSWERED, UNUSABLE. Written here, and only
 *     here. The provider did return something for a field we did ask for, and
 *     it could not be represented.
 *
 * WHY AN INVALID VALUE MUST NOT INHERIT THE OLD ONE. The carry-forward lateral
 * in `stateSelect` restores the newest prior value whose coverage
 * `IS DISTINCT FROM 'degraded_not_observed'`; that predicate IS the documented
 * carry rule, and it is the whole of it. `invalid_not_retained` is distinct
 * from `degraded_not_observed`, so the invalid row is itself an eligible
 * winner, wins the as-of read on its own recency, and resolves to NULL. That
 * is the case this normalizer is in and it is the intended one: a degraded row
 * is one nobody asked about, so the last OBSERVED value still stands; an
 * invalid row is one the provider did answer, so the old value has been
 * contradicted rather than left standing. Restoring it there would be exactly
 * the silent inheritance outside the carry rule that the rule exists to
 * prevent. (The other case — a schedule the request had to drop — is
 * unchanged: it still carries `degraded_not_observed`, and the lateral still
 * restores it.)
 *
 * WHY THE ACCEPTED SET IS BOUNDED WHERE IT IS, rather than at an invented
 * business window. It is exactly what `Date#toISOString` renders WITHOUT an
 * expanded-year sign, because that is exactly the subset `::timestamptz`
 * accepts back. Measured on the same cluster, and note that the raw value is
 * the one PostgreSQL likes:
 *
 *   select '99999-01-01'::timestamptz     -> accepted, year 99999 (the exact
 *                                            rendering depends on the server
 *                                            time zone; acceptance does not)
 *   new Date('99999-01-01').toISOString() -> '+099998-12-31T21:00:00.000Z'
 *   select '+099998-12-31T21:00:00.000Z'::timestamptz
 *     -> ERROR: time zone displacement out of range
 *
 * A year-99999 schedule is not a schedule; it is also a value whose canonical
 * ISO rendering PostgreSQL refuses, so normalizing it would CREATE the abort
 * this function exists to remove. It is an explicit unknown instead.
 *
 * WHAT THIS COSTS ONCE. Meta spells a schedule with an offset
 * (`2026-09-07T10:00:00+0300`); the canonical form of the same INSTANT is
 * `2026-09-07T07:00:00.000Z`. The `timestamptz` column stores an instant, so
 * the stored value does not move at all — only the string that goes into
 * `buildMetaEntityStateHash` canonicalizes. On the first run after this
 * deploys, each campaign and ad-set carrying a schedule therefore hashes
 * differently from its retained predecessor and the delta writer appends at
 * most one extra row per entity per scope, once. The same bounded restatement
 * the D083 Correction 1 note above describes, and afterwards a re-spelled
 * offset from the provider stops producing a row at all.
 */
export const META_FIELD_COVERAGE_SCHEDULE_INVALID =
  "invalid_not_retained" as const;

/** The four state fields that land in a `timestamptz` schedule column. */
export const META_SCHEDULE_STATE_FIELDS = [
  "campaignStartTime",
  "campaignEndTime",
  "adsetStartTime",
  "adsetEndTime",
] as const;

export type MetaScheduleStateField =
  (typeof META_SCHEDULE_STATE_FIELDS)[number];

export type MetaScheduleTimestampNormalization =
  /** No value arrived. Coverage is left exactly as the mapper wrote it. */
  | { outcome: "absent"; value: null }
  /** A usable instant, rendered canonically. */
  | { outcome: "normalized"; value: string }
  /** A value arrived and cannot be written. Coverage becomes explicit unknown. */
  | {
      outcome: "invalid";
      value: null;
      reason: "blank" | "unparsable" | "unrepresentable";
    };

/**
 * Exactly the shape `Date#toISOString` emits for a four-digit year. Anything
 * outside it carries the `+`/`-` expanded-year sign PostgreSQL reads as a time
 * zone displacement.
 */
const META_CANONICAL_ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * One provider schedule string, decided.
 *
 * A blank string is INVALID rather than absent on purpose. `''::timestamptz`
 * is an error, not a null, so it is a value that arrived and cannot be
 * written — and nothing about it says the provider meant "no schedule". The
 * shipped mappers never emit one (`optionalString` returns null for a blank),
 * so this arm is a guard for any other caller rather than a live lane.
 */
export function normalizeMetaScheduleTimestamp(
  raw: unknown,
): MetaScheduleTimestampNormalization {
  if (raw === null || raw === undefined) {
    return { outcome: "absent", value: null };
  }
  if (typeof raw !== "string") {
    return { outcome: "invalid", value: null, reason: "unparsable" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { outcome: "invalid", value: null, reason: "blank" };
  }
  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) {
    return { outcome: "invalid", value: null, reason: "unparsable" };
  }
  let iso: string;
  try {
    iso = parsed.toISOString();
  } catch {
    // `toISOString` throws RangeError past ±8.64e15 ms.
    return { outcome: "invalid", value: null, reason: "unrepresentable" };
  }
  if (!META_CANONICAL_ISO_INSTANT.test(iso)) {
    return { outcome: "invalid", value: null, reason: "unrepresentable" };
  }
  return { outcome: "normalized", value: iso };
}

/**
 * The same decision applied to a whole state, coverage included.
 *
 * IDEMPOTENT, and it has to be: `buildMetaEntityStateHash` runs it so no caller
 * can hash a state this writer would have normalized, and
 * `persistMetaEntityObservation` runs it on the object it BOTH hashes and
 * inserts. A normalized value re-normalizes to itself; an invalidated field is
 * null afterwards, which is `absent`, so its `invalid_not_retained` marker is
 * left alone rather than overwritten.
 *
 * Returns the input object unchanged when nothing needed normalizing, so the
 * overwhelmingly common path allocates nothing.
 */
export function normalizeMetaEntityStateSchedule<
  TState extends MetaEntityStateHashInput,
>(state: TState): TState {
  let patch: Partial<Record<MetaScheduleStateField, string | null>> | null =
    null;
  let coverage: Record<string, unknown> | null = null;
  for (const field of META_SCHEDULE_STATE_FIELDS) {
    const decision = normalizeMetaScheduleTimestamp(state[field]);
    if (decision.outcome === "absent") continue;
    if (decision.outcome === "normalized") {
      if (decision.value === state[field]) continue;
      patch ??= {};
      patch[field] = decision.value;
      continue;
    }
    patch ??= {};
    patch[field] = null;
    coverage ??= { ...(state.fieldCoverage ?? {}) };
    coverage[field] = META_FIELD_COVERAGE_SCHEDULE_INVALID;
  }
  if (!patch) return state;
  return (
    coverage
      ? { ...state, ...patch, fieldCoverage: coverage }
      : { ...state, ...patch }
  ) as TState;
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
export function buildMetaEntityStateHash(rawInput: MetaEntityStateHashInput) {
  // D083 Correction 3 — the schedule is normalized HERE as well as on the
  // persist path, so no caller can produce a hash over a raw schedule string
  // that the writer would have rewritten. It is idempotent, so the persist
  // path's own normalization does not double-apply.
  const input = normalizeMetaEntityStateSchedule(rawInput);
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
 * Failure-receipt keys that name the REQUEST, not the failure.
 *
 * WHY THIS EXISTS, measured. `persistMetaStatusConfigObservation` in
 * `lib/api/meta.ts` hands this module an `error` of
 * `{ pagination: paginationReceiptContext(receipt), invalidRowCount }`, and
 * `paginationReceiptContext` passes `receipt.failure` through whole. That
 * object is built by the non-complete receipt constructor in the same file and
 * carries `message`, `pageUrl`, `attempts` and `fbtraceId` alongside the
 * classification (`kind`, `httpStatus`, `errorCode`, `errorSubcode`,
 * `isTransient`). `fbtraceId` is Meta's per-REQUEST trace identifier
 * (`readMetaGraphErrorIdentity` reads it from `error.fbtrace_id`), so it is
 * different on every attempt by construction.
 *
 * Until v2 the whole object went into the semantic hash, which made every
 * failing attempt a semantically distinct observation. The coalescing branch
 * compares `currentRun.semantic_hash === semanticHash`, so it could never fire
 * on a repeating provider failure: each attempt appended a new
 * `meta_entity_observation_runs` row and a new
 * `meta_entity_observation_receipts` row. Neither table is in `FENCED_TABLES`
 * (`lib/sync/db-growth-fence.ts`), so no per-table ceiling bounds that growth —
 * only the 160 GiB `DEFAULT_DATABASE_BUDGET_BYTES` aggregate, which refuses ALL
 * sync when it trips rather than bounding either table. The measurement already
 * recorded for this lane is 729 `failed` `campaign_configs` runs since
 * 2026-09-04, every one carrying `httpStatus: 400` (the same window
 * `readMetaObservationWriterPressure` below documents). That ONE run was
 * appended per attempt is what this hash rule produces rather than a separate
 * measurement — and it did not start with the trace id: `message` and `pageUrl`
 * differ per attempt too, so a whole-receipt hash has been defeating the
 * heartbeat for as long as it has been computed that way.
 *
 * Dropped here, and why each one is request identity rather than truth:
 *  - `fbtraceId`  — Meta's identifier for THIS HTTP request.
 *  - `message`    — free text that echoes the request back; already excluded
 *                   from the snapshot path for the same reason.
 *  - `pageUrl`    — the paging cursor of this attempt.
 *  - `attempts`   — how many times THIS call retried internally.
 *
 * Deliberately kept, because they are the failure itself and two different
 * failures must not coalesce: `kind`, `termination`, `httpStatus`, `errorCode`,
 * `errorSubcode`, `isTransient`, `pageIndex`, `pageCount`, `complete`,
 * `invalidRowCount` and the field-degradation record.
 *
 * NOTHING IS LOST FORENSICALLY. The run keeps the first occurrence's full
 * `error_json` verbatim, and `appendObservationCaptureReceipt` writes the whole
 * error — trace id included — for EVERY occurrence, on the coalesced path as
 * well as the appending one. What changes is only which occurrences share a run.
 */
const META_REQUEST_SCOPED_ERROR_FIELDS: ReadonlySet<string> = new Set([
  "fbtraceId",
  "message",
  "pageUrl",
  "attempts",
]);

/**
 * Strip request-scoped keys at every depth, structure otherwise untouched.
 *
 * Applied to the SEMANTIC hash only. `buildMetaObservationRunHash` and the
 * persisted `error_json` keep the receipt whole: the run hash is the identity
 * of one stored row and must stay byte-faithful to what arrived.
 */
function canonicalizeSemanticError(
  value: unknown,
  active: Set<object> = new Set(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  // Same refusal `canonicalize` makes, taken one step earlier: without it a
  // self-referential receipt would exhaust the stack here instead of reaching
  // that guard's TypeError.
  if (active.has(value)) throw new TypeError("error receipt contains a cycle.");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalizeSemanticError(item, active));
    }
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (META_REQUEST_SCOPED_ERROR_FIELDS.has(key)) continue;
      output[key] = canonicalizeSemanticError(entry, active);
    }
    return output;
  } finally {
    active.delete(value);
  }
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
 * Included on purpose: completeness and the failure CLASSIFICATION, because
 * "complete with these 40 ads" and "partial with these 40 ads" are different
 * truths and must not coalesce into each other; and the sorted
 * (entityId, stateHash) set, which is the entity truth itself. `stateHash` is
 * already clock-free — it carries `providerUpdatedAt`, which is provider truth
 * rather than an observation clock.
 *
 * Excluded from the error receipt as of v2: the fragments that identify the
 * REQUEST rather than the failure — see `META_REQUEST_SCOPED_ERROR_FIELDS` for
 * the measured reason and the field-by-field justification.
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
    /*
      v1 -> v2: the error receipt is now canonicalized before it is hashed.

      The version is bumped rather than reused because the stored
      `meta_entity_observation_runs.semantic_hash` carries no version column of
      its own — the version lives inside the hashed payload. Reusing 'v1' would
      leave rows written under two different input rules indistinguishable and
      identically labelled. Bumping costs exactly one appended run per
      (business, account, entity_type, endpoint, completeness) lane on the first
      observation after deploy, because the newest run's stored v1 hash cannot
      match a v2 computation; on the complete lane that appended run takes the
      delta branch, so it writes only genuinely changed rows. No history is
      rewritten and no stored hash is reinterpreted.
    */
    contractVersion: "meta-entity-observation-semantic.v2",
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
    error: canonicalizeSemanticError(input.error ?? null),
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
 * D075: every ad this observation's lineage evidence can actually turn into an
 * edge. These ads must have a durable state row in whichever run a lineage edge
 * attaches to, because the edge FK-references
 * (run_id, entity_type, ad_id, creative_id).
 *
 * SHARED-CREATIVE NARROWING (the second half of the 2026-09-07 rewrite storm).
 * This used to name EVERY ad in `adCreativeRelationships`, which for an
 * `ad_configs` observation is every ad in the payload that carries a creative.
 * The delta writer then carried all of them into the run, so a complete
 * observation in which nothing changed still wrote the whole scope. Production
 * on 2026-09-06 (read-only, re-measured 2026-09-07): ALL TWELVE `ad_configs`
 * delta runs that day — one per ad account, twelve accounts, so "every run on
 * this endpoint" rather than a streak inside one account — recorded
 * `changedEntityCount: 0, newEntityCount: 0, exitedEntityCount: 0` beside
 * `lineageCarriedEntityCount` equal to `physicalStateRows` equal to that
 * account's entire ad scope (171 at the smallest, 3288 at the largest,
 * `amplification: 1`). The D075 diff was correct and the carry re-wrote the
 * scope anyway.
 *
 * The narrowing is edge-lossless by construction, not by estimate.
 * `persistMetaObservationLineage` derives an `observation_run` edge only inside
 * a creative group of two or more ads (it sorts the group, takes the earliest
 * as source, and emits `relationships.slice(1)` as targets), so a creative
 * named by exactly one ad in this payload can never produce an edge and its ad
 * never needs a durable row. The `verified_action` family is unrelated to the
 * payload grouping — it joins `meta_ads_action_log` — so both of its ads stay
 * named unconditionally.
 */
async function lineageRelevantAdIds(
  sql: ReturnType<typeof getDb>,
  input: {
    businessRefId: string;
    observedAt: string;
    adCreativeRelationships?: MetaObservedAdCreativeRelationship[] | null;
  },
): Promise<Set<string>> {
  const adIdsByCreative = new Map<string, Set<string>>();
  for (const relationship of input.adCreativeRelationships ?? []) {
    const adId = relationship.adId.trim();
    const creativeId = relationship.creativeId.trim();
    if (!adId || !creativeId) continue;
    const group = adIdsByCreative.get(creativeId) ?? new Set<string>();
    group.add(adId);
    adIdsByCreative.set(creativeId, group);
  }
  const adIds = new Set<string>();
  for (const group of adIdsByCreative.values()) {
    // One ad on a creative is a group of one; `relationships.slice(1)` below is
    // empty for it and no edge exists to FK-reference a row.
    if (group.size < 2) continue;
    for (const adId of group) adIds.add(adId);
  }
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
    /**
     * ROUND 14: the real `meta_sync_runs.id` of the attempt writing this
     * receipt. Null only for callers that genuinely have no sync attempt (the
     * tombstone path); the config-observation path always supplies one.
     */
    syncRunId: string | null;
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
  if (input.syncRunId !== null && !UUID_PATTERN.test(input.syncRunId)) {
    throw new Error("captureReceipt.syncRunId must be a UUID.");
  }
  const errorJson = input.error ? JSON.stringify(input.error) : null;
  const inserted = await sql<{ id: string }>`
    INSERT INTO meta_entity_observation_receipts (
      receipt_contract, run_id, business_id, provider_account_id, entity_type,
      endpoint, partition_id, source_snapshot_id, source_snapshot_ref_id,
      sync_run_id,
      capture_status, provider_row_count, page_count, run_reused, observed_at,
      captured_at, error_json
    ) VALUES (
      ${META_OBSERVATION_RECEIPT_CONTRACT}, ${input.runId}::uuid,
      ${input.businessId}, ${input.providerAccountId}, ${input.entityType},
      ${input.endpoint}, ${input.partitionId}::uuid, ${input.sourceSnapshotId},
      ${input.sourceSnapshotRefId}::uuid,
      ${input.syncRunId}::uuid,
      ${input.captureStatus}, ${input.providerRowCount}, ${input.pageCount},
      ${input.runReused}, ${input.observedAt}::timestamptz,
      ${input.capturedAt}::timestamptz,
      ${errorJson}::jsonb
    )
    /*
      ── ROUND 15, DEFECT 4 ─────────────────────────────────────────────────
      The occurrence includes the ATTEMPT. Two distinct sync runs capturing at
      the same millisecond used to collide on the partition-scoped key, and
      DO NOTHING silently kept whichever committed first -- possibly the one
      whose apply then failed. They now append as two receipts, while an exact
      retry of the SAME attempt still coalesces.
    */
    ON CONFLICT (partition_id, entity_type, endpoint, captured_at,
                 COALESCE(sync_run_id, '00000000-0000-0000-0000-000000000000'::uuid))
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
       -- ROUND 15: the same key the conflict fired on. Omitting the attempt
       -- here compared this attempt against a DIFFERENT attempt's row and
       -- reported its ordinary differences as a contradiction.
       AND COALESCE(sync_run_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = COALESCE(${input.syncRunId}::uuid,
                    '00000000-0000-0000-0000-000000000000'::uuid)
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
    `(partition_id, entity_type, endpoint, captured_at, COALESCE(sync_run_id,
    …))` — that is the UNIQUE index
    `meta_entity_observation_receipts_attempt_occurrence` (ROUND 16: this
    comment described the older four-column key, which Round 15 replaced so two
    distinct sync attempts at one millisecond could no longer collapse into one
    receipt) — and it is the key this very lookup uses. `observed_at` is not in
    it. It is the clock of the WRITE
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
    /*
      THE ROW AND ITS OWN HASH ARE COMPUTED FROM ONE OBJECT.

      `state_hash` is computed here, before the transaction opens, and both
      INSERT sites below write `state.campaignStartTime` (and its three
      siblings) from this very map — so the schedule has to be normalized
      BEFORE the hash call on the next line or the stored row and the stored
      hash would describe different values. That is the same constraint the
      read-side carry lateral in `stateSelect` names when it explains why the
      carry is read-side only; the difference is that this normalization is a
      property of the row itself, so it belongs on the write path.

      A schedule the provider answered with something unusable becomes an
      explicit unknown here: null column, `invalid_not_retained` coverage. Both
      go into the hash, which is what makes the explicit unknown a REAL state
      change — the row is appended by the delta writer instead of being deduped
      away against the last known value.
    */
    const normalizedState = normalizeMetaEntityStateSchedule({
      ...rawState,
      entityId: stateEntityId,
      observedAt: stateObservedAt,
    });
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
            syncRunId: input.captureReceipt.syncRunId ?? null,
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
    // observation of a scope keeps the full write exactly as before.
    //
    // The `partial` lane is delta-deduped too (branch below), but on a
    // strictly weaker contract: observed-present rows only, and never a
    // scope-exit row, because a partial payload is not a scope. `failed`
    // carries no states at all and `point_lookup` is a single-entity probe,
    // so neither has a diff baseline worth reconstructing.
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
          manifestContract: META_COMPLETE_MANIFEST_CONTRACT,
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
          manifestContract: META_COMPLETE_MANIFEST_CONTRACT,
          logicalEntityCount: states.length,
          changedEntityCount: 0,
          newEntityCount: states.length,
          exitedEntityCount: 0,
          lineageCarriedEntityCount: 0,
          physicalStateRows: states.length,
          amplification: 1,
        };
      }
    } else if (input.completeness === "partial" && states.length > 0) {
      // The partial lane, delta-deduped against what a reader would already
      // answer — WITHOUT ever inferring absence from a partial payload.
      //
      // WHY THIS EXISTS. Until this branch, `statesToPersist` stayed `states`
      // for every non-complete lane, so a partial observation re-wrote every
      // row it had managed to fetch. A partial receipt is produced by
      // `receiptCompleteness` in `lib/api/meta.ts` whenever pagination breaks
      // part-way — and also for a receipt whose pagination COMPLETED while
      // `invalidRowCount > 0`, since that function returns `complete` only for
      // `receipt.complete && invalidRowCount === 0`. The pagination arm is the
      // one measured below; the invalid-row arm reaches this branch too, and
      // the dedupe treats both identically because it compares state hashes
      // and never the receipt. Each retry breaks at a different page, so the
      // run's `pageCount`/`rowCount`/`error` differ and the same-completeness
      // heartbeat above cannot coalesce them. Every retry therefore appended a
      // full copy of the pages it did reach. Measured read-only on production
      // 2026-09-07: 126,500 partial state rows written since 2026-09-04, of
      // which 126,500 — every single one — carried a `state_hash` identical to
      // the entity's immediately preceding row. One `ad_configs` scope alone
      // wrote 94,500 such rows across 41 partial runs in three days, while
      // `meta_entity_state_history` sat 638,976 bytes over its 6 GiB D089
      // ceiling with admission refused.
      //
      // THE SAFETY HALF, STATED IN CODE. A partial page proves what it
      // CONTAINS, never what it omits. There is no `exitedRows` here and there
      // must never be one: the complete lane earns its `absent_unconfirmed`
      // rows because a complete payload is the whole scope, and a partial
      // payload is by definition not. An entity missing from this payload is
      // left exactly as the history already has it — no absence row, no
      // presence flip, no scope membership claim of any kind. The dedupe below
      // only ever REMOVES writes for entities the payload positively observed.
      const observedEntityIds = states.map((state) => state.entityId);
      // The winner this dedupe must not disturb, in the exact shape
      // `stateSelect` (the generic as-of read) resolves it: every lane, no
      // endpoint restriction, dual clock cutoff, and the same tie-break tuple.
      // Suppressing a write is only safe when the row it would have added
      // carries content a reader already gets from the row it would have
      // displaced.
      //
      // PER-ENTITY LATERAL, NOT `DISTINCT ON` OVER `entity_id = ANY(...)`.
      // This runs inside the writer's own transaction, so its cost is the
      // observation's cost. The `DISTINCT ON` spelling was measured on
      // production (EXPLAIN ANALYZE, read-only, 2026-09-07) against a real
      // 3,288-ad scope: it matched 856,497 historical rows and sorted all of
      // them — 14.07 s with a 115 MB external merge on disk. The lateral below
      // asks `idx_meta_entity_state_history_asof` for ONE row per observed
      // entity and returned the identical result in 517 ms on the same scope.
      // Same winner order, same predicates, 27x less work; do not "simplify"
      // it back.
      const baseline = await sql<{ entity_id: string; state_hash: string }>`
        SELECT target.entity_id, winner.state_hash
        FROM unnest(${observedEntityIds}::text[]) AS target(entity_id)
        CROSS JOIN LATERAL (
          SELECT state.state_hash
          FROM meta_entity_state_history state
          WHERE state.business_id = ${businessId}
            AND state.provider_account_id = ${providerAccountId}
            AND state.entity_type = ${entityType}
            AND state.entity_id = target.entity_id
            AND state.observed_at <= ${observedAt}::timestamptz
            AND state.captured_at <= ${capturedAt}::timestamptz
            AND state.run_completeness IN ('complete', 'partial', 'point_lookup')
          ORDER BY state.observed_at DESC, state.captured_at DESC,
            state.created_at DESC, state.id DESC
          LIMIT 1
        ) winner
      `;
      const baselineHashByEntity = new Map(
        baseline.map((row) => [row.entity_id, row.state_hash] as const),
      );
      let changedEntityCount = 0;
      let newEntityCount = 0;
      const deltaRows: typeof states = [];
      for (const state of states) {
        const priorHash = baselineHashByEntity.get(state.entityId);
        if (priorHash === undefined) {
          newEntityCount += 1;
          deltaRows.push(state);
        } else if (priorHash !== state.stateHash) {
          changedEntityCount += 1;
          deltaRows.push(state);
        }
      }
      // Same reason as the complete lane: `meta_creative_lineage_edges`
      // FK-references state rows BY RUN, so an ad this observation's lineage
      // evidence can actually turn into an edge needs a durable row in THIS
      // run even when its state did not change.
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
      statesToPersist = [...deltaRows].sort((a, b) =>
        a.entityId.localeCompare(b.entityId),
      );
      // `manifest_kind` deliberately stays NULL.
      //
      // 'delta' is a COMPLETE-lane word everywhere it is read: the ad
      // hydration lateral in `lib/creative-decision-engine/data-source.ts`,
      // the D086 membership lateral in `lib/meta/budget-readiness-read-model.ts`
      // and the `confirmed_until` lateral in
      // `lib/creative-decision-engine/jobs/ad-operator-response-job.ts` all
      // switch a manifest-reconstruction arm on it, and that arm reconstructs
      // from `run_completeness = 'complete'` rows only. Stamping a partial run
      // 'delta' would hand those readers a complete-lane scope as this partial
      // run's membership. A NULL kind keeps every existing reader's
      // classification of this run byte-identical to today; the dedupe is
      // reported in `delta_stats_json`, which no reader branches on, and the
      // storage semantic is stated there explicitly as
      // `manifestContract: META_PARTIAL_MANIFEST_CONTRACT` so that "NULL kind"
      // no longer has to carry two different meanings at once.
      //
      // The whole reference set, so the claim can be re-checked rather than
      // trusted (`grep -rn delta_stats_json --include='*.ts'`): this module
      // writes it and reads it back in two places that steer nothing — the
      // coalesced-path `jsonb_set` that keeps a kept run's carry counts
      // truthful, and the `SUM(...)` in `readMetaObservationWriterPressure`,
      // a read-only instrument. `lib/migrations.ts` adds the column and
      // `lib/migration-verification.ts` asserts its type. The rest only NAME
      // it: `scripts/ephemeral-postgres-native-ad-decision-seam.ts` creates a
      // column list, and four one-off audit scripts
      // (`scripts/audits/d077-correction1-artifact-generator.ts`,
      // `d077-production-recovery-readonly-preflight.ts`,
      // `d078-six-business-evidence-bundle.ts`,
      // `d080-meta-budget-edit-evidence.ts`) check whether production HAS the
      // column. One seam harness does assert its VALUE —
      // `scripts/ephemeral-postgres-entity-state-history-seam-child.ts` — but
      // that is a test observing this writer, not a reader taking a decision
      // from it. No production code path changes behaviour on its contents.
      //
      // THE CONSUMER SWEEP, verdict by verdict. Every reader that branches on
      // a run's manifest shape, checked against the contract stated at
      // `META_PARTIAL_MANIFEST_CONTRACT` rather than argued from it. The
      // question each one had to answer is: can it mistake a deduped partial
      // run for a run whose row set is its whole payload?
      //
      //  1. `lib/meta/budget-readiness-read-model.ts` — reconstructs members
      //     with `c.manifest_kind IS DISTINCT FROM 'delta'` (run-bound arm),
      //     which a NULL-kind partial run enters. It cannot mis-read it:
      //     `attestCompleteRun` refuses the capture by name
      //     (`D086_CAPTURE_STATUS_BLOCKER.partial = "capture_partial"`) before
      //     any member set or `row_count` comparison is reached, and refuses
      //     again on `run.captureStatus !== "complete"`.
      //  2. `scripts/creative-decision-center/native-ad-natural-wave-operational-verifier.ts`
      //     — same `IS DISTINCT FROM 'delta'` run-bound arm in
      //     `SOURCE_RUNS_SQL`, and it is the one place that compares
      //     `expectedRowCount` (the run's `row_count`) with
      //     `persistedRowCount`. It cannot mis-read a partial run either: the
      //     receipt predicate requires `source.completeness === "complete"`
      //     before that comparison is evaluated.
      //  3. `lib/creative-decision-engine/jobs/ad-operator-response-job.ts` —
      //     `AD_OPERATOR_SCOPE_CONFIRMATION_LATERAL_SQL` is complete-lane on
      //     both sides: it confirms only `state.run_completeness = 'complete'`
      //     rows, extends confirmation only from
      //     `later_run.manifest_kind = 'delta' AND later_run.completeness =
      //     'complete'` runs, and only a `newer.run_completeness = 'complete'`
      //     row supersedes. A partial run never granted confirmation and never
      //     revoked it, before this dedupe or after.
      //  4. `lib/creative-decision-engine/data-source.ts` — the ad hydration
      //     lateral reconstructs from `run_completeness = 'complete'` rows.
      //  5. `lib/meta/state-history-compaction.ts` — D077 planning is
      //     `r.completeness = 'complete'` throughout, so a partial run is never
      //     a compaction candidate; its rows only ever EXCLUDE a complete
      //     duplicate through the `interleaved.run_completeness IN ('partial',
      //     'point_lookup')` predicate. Fewer partial rows can only widen what
      //     D077 may remove, never narrow it.
      //  6. `readMetaEntityStatesAsOf` in this module — the only reader that
      //     resolves a partial row as an as-of winner. The dedupe's baseline
      //     lateral above is deliberately the same winner order, so a
      //     suppressed write is one whose content that reader already answers
      //     with. Proven rather than argued, against real PostgreSQL, by
      //     `lib/meta/entity-state-history-partial-delta.db.test.ts`.
      deltaStats = {
        manifestContract: META_PARTIAL_MANIFEST_CONTRACT,
        logicalEntityCount: states.length,
        changedEntityCount,
        newEntityCount,
        // Structurally zero, and it must stay that way. A partial payload
        // cannot evidence a scope exit.
        exitedEntityCount: 0,
        lineageCarriedEntityCount,
        physicalStateRows: statesToPersist.length,
        amplification: statesToPersist.length / Math.max(1, states.length),
      };
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
        syncRunId: input.captureReceipt.syncRunId ?? null,
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
          schedule.campaign_start_time,
          schedule.campaign_end_time,
          schedule.adset_start_time,
          schedule.adset_end_time,
          budget_currency_exponent, budget_currency_registry_version, budget_shape_support,
          provider_api_version,
          review_status, policy_status, policy_reasons_json, provider_updated_at, presence,
          field_coverage_json, observed_at::text AS observed_at,
          captured_at::text AS captured_at, run_completeness, state_hash
        FROM meta_entity_state_history state
        /*
          THE SCHEDULE IS THE LAST VALUE THAT WAS ACTUALLY OBSERVED.

          When the campaigns edge refuses start_time/stop_time, the sync
          drops those fields, retries, and writes rows whose schedule is NULL
          while field_coverage_json records degraded_not_observed — an
          explicit "not asked", not a measured absence. lib/api/meta.ts
          carries a known schedule forward into such a row before the write,
          but it cannot when the prior-value read itself fails
          (scheduleDegradation.priorStateReadFailed). Without this lateral
          that row is the newest one, wins the DISTINCT ON, and a schedule the
          system had observed is destroyed by a request that never asked for it.

          AND THE CARRY RULE IS EXACTLY THIS PREDICATE, no wider. A schedule
          the provider DID answer with an unusable value is stamped
          invalid_not_retained by normalizeMetaEntityStateSchedule on the write
          path, which is DISTINCT FROM degraded_not_observed -- so that row is
          an eligible winner here, wins on its own recency, and resolves to
          NULL. An explicit unknown must not inherit the old value: nobody
          asked about a degraded row, whereas an invalid row is an answer that
          contradicts what was there. Measured absence (coverage true or false)
          is the third case and is likewise never carried.

          NOTE: this comment is inside a tagged template literal, so it carries
          no backticks -- one would terminate the SQL string.

          Read-side and hash-neutral ON PURPOSE: state_hash is computed before
          the write, so a writer-side COALESCE would put the row and its hash
          out of agreement. Here the stored row is untouched and only the
          resolved value is carried.
        */
        LEFT JOIN LATERAL (
          SELECT
            (SELECT prior.campaign_start_time::text
               FROM meta_entity_state_history prior
              WHERE prior.business_id = state.business_id
                AND prior.provider_account_id = state.provider_account_id
                AND prior.entity_type = state.entity_type
                AND prior.entity_id = state.entity_id
                AND prior.observed_at <= state.observed_at
                AND prior.field_coverage_json ->> 'campaignStartTime'
                      IS DISTINCT FROM 'degraded_not_observed'
              ORDER BY prior.observed_at DESC, prior.captured_at DESC,
                       prior.created_at DESC, prior.id DESC
              LIMIT 1) AS campaign_start_time,
            (SELECT prior.campaign_end_time::text
               FROM meta_entity_state_history prior
              WHERE prior.business_id = state.business_id
                AND prior.provider_account_id = state.provider_account_id
                AND prior.entity_type = state.entity_type
                AND prior.entity_id = state.entity_id
                AND prior.observed_at <= state.observed_at
                AND prior.field_coverage_json ->> 'campaignEndTime'
                      IS DISTINCT FROM 'degraded_not_observed'
              ORDER BY prior.observed_at DESC, prior.captured_at DESC,
                       prior.created_at DESC, prior.id DESC
              LIMIT 1) AS campaign_end_time,
            (SELECT prior.adset_start_time::text
               FROM meta_entity_state_history prior
              WHERE prior.business_id = state.business_id
                AND prior.provider_account_id = state.provider_account_id
                AND prior.entity_type = state.entity_type
                AND prior.entity_id = state.entity_id
                AND prior.observed_at <= state.observed_at
                AND prior.field_coverage_json ->> 'adsetStartTime'
                      IS DISTINCT FROM 'degraded_not_observed'
              ORDER BY prior.observed_at DESC, prior.captured_at DESC,
                       prior.created_at DESC, prior.id DESC
              LIMIT 1) AS adset_start_time,
            (SELECT prior.adset_end_time::text
               FROM meta_entity_state_history prior
              WHERE prior.business_id = state.business_id
                AND prior.provider_account_id = state.provider_account_id
                AND prior.entity_type = state.entity_type
                AND prior.entity_id = state.entity_id
                AND prior.observed_at <= state.observed_at
                AND prior.field_coverage_json ->> 'adsetEndTime'
                      IS DISTINCT FROM 'degraded_not_observed'
              ORDER BY prior.observed_at DESC, prior.captured_at DESC,
                       prior.created_at DESC, prior.id DESC
              LIMIT 1) AS adset_end_time
        ) AS schedule ON TRUE
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
          schedule.campaign_start_time,
          schedule.campaign_end_time,
          schedule.adset_start_time,
          schedule.adset_end_time,
          budget_currency_exponent, budget_currency_registry_version, budget_shape_support,
          provider_api_version,
          review_status, policy_status, policy_reasons_json, provider_updated_at, presence,
          field_coverage_json, observed_at::text AS observed_at,
          captured_at::text AS captured_at, run_completeness, state_hash
        FROM meta_entity_state_history state
        /*
          THE SCHEDULE IS THE LAST VALUE THAT WAS ACTUALLY OBSERVED.

          When the campaigns edge refuses start_time/stop_time, the sync
          drops those fields, retries, and writes rows whose schedule is NULL
          while field_coverage_json records degraded_not_observed — an
          explicit "not asked", not a measured absence. lib/api/meta.ts
          carries a known schedule forward into such a row before the write,
          but it cannot when the prior-value read itself fails
          (scheduleDegradation.priorStateReadFailed). Without this lateral
          that row is the newest one, wins the DISTINCT ON, and a schedule the
          system had observed is destroyed by a request that never asked for it.

          AND THE CARRY RULE IS EXACTLY THIS PREDICATE, no wider. A schedule
          the provider DID answer with an unusable value is stamped
          invalid_not_retained by normalizeMetaEntityStateSchedule on the write
          path, which is DISTINCT FROM degraded_not_observed -- so that row is
          an eligible winner here, wins on its own recency, and resolves to
          NULL. An explicit unknown must not inherit the old value: nobody
          asked about a degraded row, whereas an invalid row is an answer that
          contradicts what was there. Measured absence (coverage true or false)
          is the third case and is likewise never carried.

          NOTE: this comment is inside a tagged template literal, so it carries
          no backticks -- one would terminate the SQL string.

          Read-side and hash-neutral ON PURPOSE: state_hash is computed before
          the write, so a writer-side COALESCE would put the row and its hash
          out of agreement. Here the stored row is untouched and only the
          resolved value is carried.
        */
        LEFT JOIN LATERAL (
          SELECT
            (SELECT prior.campaign_start_time::text
               FROM meta_entity_state_history prior
              WHERE prior.business_id = state.business_id
                AND prior.provider_account_id = state.provider_account_id
                AND prior.entity_type = state.entity_type
                AND prior.entity_id = state.entity_id
                AND prior.observed_at <= state.observed_at
                AND prior.field_coverage_json ->> 'campaignStartTime'
                      IS DISTINCT FROM 'degraded_not_observed'
              ORDER BY prior.observed_at DESC, prior.captured_at DESC,
                       prior.created_at DESC, prior.id DESC
              LIMIT 1) AS campaign_start_time,
            (SELECT prior.campaign_end_time::text
               FROM meta_entity_state_history prior
              WHERE prior.business_id = state.business_id
                AND prior.provider_account_id = state.provider_account_id
                AND prior.entity_type = state.entity_type
                AND prior.entity_id = state.entity_id
                AND prior.observed_at <= state.observed_at
                AND prior.field_coverage_json ->> 'campaignEndTime'
                      IS DISTINCT FROM 'degraded_not_observed'
              ORDER BY prior.observed_at DESC, prior.captured_at DESC,
                       prior.created_at DESC, prior.id DESC
              LIMIT 1) AS campaign_end_time,
            (SELECT prior.adset_start_time::text
               FROM meta_entity_state_history prior
              WHERE prior.business_id = state.business_id
                AND prior.provider_account_id = state.provider_account_id
                AND prior.entity_type = state.entity_type
                AND prior.entity_id = state.entity_id
                AND prior.observed_at <= state.observed_at
                AND prior.field_coverage_json ->> 'adsetStartTime'
                      IS DISTINCT FROM 'degraded_not_observed'
              ORDER BY prior.observed_at DESC, prior.captured_at DESC,
                       prior.created_at DESC, prior.id DESC
              LIMIT 1) AS adset_start_time,
            (SELECT prior.adset_end_time::text
               FROM meta_entity_state_history prior
              WHERE prior.business_id = state.business_id
                AND prior.provider_account_id = state.provider_account_id
                AND prior.entity_type = state.entity_type
                AND prior.entity_id = state.entity_id
                AND prior.observed_at <= state.observed_at
                AND prior.field_coverage_json ->> 'adsetEndTime'
                      IS DISTINCT FROM 'degraded_not_observed'
              ORDER BY prior.observed_at DESC, prior.captured_at DESC,
                       prior.created_at DESC, prior.id DESC
              LIMIT 1) AS adset_end_time
        ) AS schedule ON TRUE
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

/**
 * One observation lane's write pressure and liveness, as measured rather than
 * asserted.
 *
 * WHY THIS EXISTS. Two different stalls look identical from outside this
 * module — "the writer stopped" — and they need opposite responses:
 *
 *   1. Nothing was ATTEMPTED. No run row of any lane exists in the window. The
 *      cause is upstream of this file (sync admission refused, scheduler,
 *      lease, growth fence).
 *   2. It was attempted and the PROVIDER refused. `failed`/`partial` runs keep
 *      arriving with an `error_json` receipt while the `complete` lane's clock
 *      stands still. The cause is the provider call, not storage.
 *   3. It was attempted, it succeeded, and the writer wrote. Then
 *      `physicalStateRows` against `deltaLogicalEntityCount` says whether the
 *      delta contract is actually holding or the scope is being rewritten.
 *
 * On 2026-09-07 production shows all three at once, and this readback is the
 * instrument that separates them — it does NOT decide between them. Read-only,
 * SELECT-only, no side effects; safe to run against production through a
 * read-only session.
 *
 * The open question it exists to make re-testable: `campaign_configs` has no
 * `complete` run after 2026-08-22 06:02 UTC, no run of ANY lane between then
 * and 2026-09-04 15:57 UTC, and 729 `failed` runs carrying
 * `pagination.failure.httpStatus = 400` after that. Whether the campaign
 * writer's freeze is a CONSEQUENCE of the state-history rewrite chain (the
 * fence refused admission, so nothing was attempted) or an INDEPENDENT
 * provider-side rejection that merely started in the same window is not
 * decided here. Run this over the window on both sides of the fix and let the
 * three shapes above answer it.
 *
 * WHICH NUMBERS ARE WINDOW NUMBERS, stated because they are not all the same.
 * A run is COALESCED CONTENT: one row whose `repeat_count` and
 * `last_captured_at` keep moving as the same truth is re-observed. Filtering on
 * `run.captured_at` selects runs by their FIRST capture, so any number summed
 * off those rows crosses the window in both directions — a run first captured
 * before `since` contributes nothing however often it was re-observed inside,
 * and a run first captured inside contributes re-sightings that happened after
 * `until`. Every field below therefore names its own basis:
 *
 *   - `runsAppended`, `runsWithError`, `physicalStateRows`, `providerRowCount`,
 *     the `delta*` sums, `firstRunCapturedAt`/`lastRunCapturedAt`: runs whose
 *     FIRST capture fell in the window. Window facts about appends.
 *   - `lifetimeOccurrencesOfWindowRuns`, `lastHeartbeatAtOfWindowRuns`:
 *     LIFETIME totals of exactly those runs. They are not window numbers and
 *     the names say so.
 *   - `windowOccurrences`, `firstWindowOccurrenceAt`, `lastWindowOccurrenceAt`:
 *     the window's actual capture occurrences, counted from
 *     `meta_entity_observation_receipts`, which appends one immutable row per
 *     occurrence on the coalesced path as well as the appending one. This is
 *     the only field family that answers "how many times was this lane captured
 *     between `since` and `until`". NULL means no receipt exists for the lane at
 *     all — absence of measurement, not zero. Receipts are written only when the
 *     caller supplies `captureReceipt`, so a lane captured by a path that omits
 *     it reports NULL here while still reporting its appended runs.
 *
 * A lane re-observed inside the window whose run was appended BEFORE it appears
 * with `runsAppended: 0` and a positive `windowOccurrences`; that combination
 * is "alive, coalescing, appending nothing", and before the receipt join it was
 * indistinguishable from "nothing was attempted".
 */
export interface MetaObservationWriterPressureRow {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  endpoint: string;
  completeness: MetaObservationCompleteness;
  /** Runs APPENDED in the window — a coalesced re-observation adds none. */
  runsAppended: number;
  /**
   * Capture occurrences INSIDE the window, from the receipts. NULL when the
   * lane has no receipt at all (a capture path that supplied none).
   */
  windowOccurrences: number | null;
  /** First/last receipt clock inside the window; NULL with `windowOccurrences`. */
  firstWindowOccurrenceAt: string | null;
  lastWindowOccurrenceAt: string | null;
  /**
   * `repeat_count` summed over the runs APPENDED in the window: their whole
   * lifetime, including re-sightings after `until`. Not a window number.
   */
  lifetimeOccurrencesOfWindowRuns: number;
  /** Runs whose receipt carries an error object. */
  runsWithError: number;
  /** State rows those runs own right now — the storage this lane actually spent. */
  physicalStateRows: number;
  /** `row_count` summed: the LOGICAL provider scope those runs claim. */
  providerRowCount: number;
  /**
   * `delta_stats_json` summed over the runs that carry it. NULL means no run in
   * this group recorded stats (a legacy run, or a lane that writes none), which
   * is absence of measurement, not a zero.
   */
  deltaLogicalEntityCount: number | null;
  deltaChangedEntityCount: number | null;
  deltaNewEntityCount: number | null;
  deltaExitedEntityCount: number | null;
  deltaLineageCarriedEntityCount: number | null;
  /** Runs in this group with no `delta_stats_json` at all. */
  runsWithoutDeltaStats: number;
  firstRunCapturedAt: string | null;
  lastRunCapturedAt: string | null;
  /**
   * Newest heartbeat clock among the runs APPENDED in the window. A coalescing
   * lane is alive without appending, so this can be later than `until`; use
   * `lastWindowOccurrenceAt` for the window's own last capture.
   */
  lastHeartbeatAtOfWindowRuns: string | null;
  /** Newest `captured_at` among state rows these runs own; NULL when none. */
  lastStateCapturedAt: string | null;
  /** The newest receipt's failure shape, verbatim from `error_json`. */
  lastErrorKind: string | null;
  lastErrorHttpStatus: number | null;
  lastErrorTermination: string | null;
}

interface MetaObservationWriterPressureDbRow {
  business_id: string;
  provider_account_id: string;
  entity_type: MetaEntityType;
  endpoint: string;
  completeness: MetaObservationCompleteness;
  runs_appended: string | number | null;
  window_occurrences: string | number | null;
  first_window_occurrence_at: string | null;
  last_window_occurrence_at: string | null;
  lifetime_occurrences_of_window_runs: string | number | null;
  runs_with_error: string | number | null;
  physical_state_rows: string | number | null;
  provider_row_count: string | number | null;
  delta_logical_entity_count: string | number | null;
  delta_changed_entity_count: string | number | null;
  delta_new_entity_count: string | number | null;
  delta_exited_entity_count: string | number | null;
  delta_lineage_carried_entity_count: string | number | null;
  runs_without_delta_stats: string | number | null;
  first_run_captured_at: string | null;
  last_run_captured_at: string | null;
  last_heartbeat_at_of_window_runs: string | null;
  last_state_captured_at: string | null;
  last_error_kind: string | null;
  last_error_http_status: string | number | null;
  last_error_termination: string | null;
}

function countOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function countOrZero(value: string | number | null | undefined): number {
  return countOrNull(value) ?? 0;
}

/**
 * Read the writer-pressure rows for a captured-at window.
 *
 * `since` is required on purpose: an unbounded window would per-run probe
 * `meta_entity_state_history`, and that table is the one under the growth
 * fence. Scope to a business list whenever the question is about one account.
 * Measured on production 2026-09-07 through a read-only session: an unscoped
 * 18-day window over 2,379 runs returned in 3.4 s. That is diagnostic-shaped,
 * not request-shaped — it is comfortably under the 8 s pool ceiling but has no
 * business being on a page render path. The receipt aggregation added since
 * that measurement is a grouped scan of one window of
 * `meta_entity_observation_receipts` served by
 * `idx_meta_entity_observation_receipts_freshness_v2`; it is not per-run and adds
 * no probe of the fenced table, but the measurement above predates it and is
 * not re-quoted as covering it.
 */
export async function readMetaObservationWriterPressure(input: {
  since: string | Date;
  until?: string | Date | null;
  businessIds?: readonly string[] | null;
}): Promise<MetaObservationWriterPressureRow[]> {
  const sql = getDb();
  const since = normalizeCutoff(input.since);
  const until = input.until == null ? null : normalizeCutoff(input.until);
  const businessIds =
    input.businessIds == null
      ? null
      : Array.from(
          new Set(
            input.businessIds
              .map((value) => requireNonEmpty(value, "businessIds[]"))
              .sort(),
          ),
        );
  if (businessIds != null && businessIds.length === 0) {
    throw new Error("businessIds must be null or a non-empty list.");
  }
  const rows = await sql<MetaObservationWriterPressureDbRow>`
    WITH scoped_runs AS (
      SELECT
        run.id, run.business_id, run.provider_account_id, run.entity_type,
        run.endpoint, run.completeness, run.repeat_count, run.row_count,
        run.captured_at, run.delta_stats_json, run.error_json,
        COALESCE(run.last_captured_at, run.captured_at) AS heartbeat_at
      FROM meta_entity_observation_runs run
      WHERE run.captured_at >= ${since}::timestamptz
        AND (${until}::timestamptz IS NULL
             OR run.captured_at < ${until}::timestamptz)
        AND (${businessIds}::text[] IS NULL
             OR run.business_id = ANY(${businessIds}::text[]))
    ), measured AS (
      SELECT scoped.*, owned.state_rows, owned.last_state_captured_at
      FROM scoped_runs scoped
      LEFT JOIN LATERAL (
        SELECT count(*)::bigint AS state_rows,
               max(state.captured_at) AS last_state_captured_at
        FROM meta_entity_state_history state
        WHERE state.run_id = scoped.id
      ) owned ON TRUE
    ), run_groups AS (
      SELECT
        business_id, provider_account_id, entity_type, endpoint, completeness,
        count(*)::text AS runs_appended,
        SUM(COALESCE(repeat_count, 1))::text
          AS lifetime_occurrences_of_window_runs,
        count(*) FILTER (WHERE error_json IS NOT NULL)::text AS runs_with_error,
        SUM(COALESCE(state_rows, 0))::text AS physical_state_rows,
        SUM(COALESCE(row_count, 0))::text AS provider_row_count,
        SUM((delta_stats_json->>'logicalEntityCount')::bigint)::text
          AS delta_logical_entity_count,
        SUM((delta_stats_json->>'changedEntityCount')::bigint)::text
          AS delta_changed_entity_count,
        SUM((delta_stats_json->>'newEntityCount')::bigint)::text
          AS delta_new_entity_count,
        SUM((delta_stats_json->>'exitedEntityCount')::bigint)::text
          AS delta_exited_entity_count,
        SUM((delta_stats_json->>'lineageCarriedEntityCount')::bigint)::text
          AS delta_lineage_carried_entity_count,
        count(*) FILTER (WHERE delta_stats_json IS NULL)::text
          AS runs_without_delta_stats,
        min(captured_at)::text AS first_run_captured_at,
        max(captured_at)::text AS last_run_captured_at,
        max(heartbeat_at)::text AS last_heartbeat_at_of_window_runs,
        max(last_state_captured_at)::text AS last_state_captured_at,
        (array_agg(error_json->'pagination'->'failure'->>'kind'
                   ORDER BY captured_at DESC, id DESC)
          FILTER (WHERE error_json IS NOT NULL))[1] AS last_error_kind,
        (array_agg(error_json->'pagination'->'failure'->>'httpStatus'
                   ORDER BY captured_at DESC, id DESC)
          FILTER (WHERE error_json IS NOT NULL))[1] AS last_error_http_status,
        (array_agg(error_json->'pagination'->>'termination'
                   ORDER BY captured_at DESC, id DESC)
          FILTER (WHERE error_json IS NOT NULL))[1] AS last_error_termination
      FROM measured
      GROUP BY business_id, provider_account_id, entity_type, endpoint, completeness
    ), receipt_groups AS (
      /*
        THE WINDOW'S OCCURRENCES, from the append-only receipts.

        A receipt is written per capture occurrence -- on the coalesced path as
        well as the appending one -- and its clock never moves, so counting
        receipts inside the window is the only way to ask "how many captures
        happened between since and until" without a run's lifetime repeat_count
        leaking across either boundary.

        The grouping key is the run table's, with capture_status standing in for
        completeness: the coalescing lookup only ever reuses a run within the
        SAME completeness lane, so a receipt's status and its run's completeness
        cannot disagree.
      */
      SELECT
        business_id, provider_account_id, entity_type, endpoint,
        capture_status AS completeness,
        count(*)::text AS window_occurrences,
        min(captured_at)::text AS first_window_occurrence_at,
        max(captured_at)::text AS last_window_occurrence_at
      FROM meta_entity_observation_receipts
      WHERE captured_at >= ${since}::timestamptz
        AND (${until}::timestamptz IS NULL
             OR captured_at < ${until}::timestamptz)
        AND (${businessIds}::text[] IS NULL
             OR business_id = ANY(${businessIds}::text[]))
      GROUP BY business_id, provider_account_id, entity_type, endpoint,
        capture_status
    )
    -- FULL OUTER, so a lane that only COALESCED in the window (no run appended)
    -- is reported rather than silently reading as "nothing was attempted", and
    -- a lane that appended runs but wrote no receipt still reports its appends.
    SELECT *
    FROM run_groups
    FULL OUTER JOIN receipt_groups
      USING (business_id, provider_account_id, entity_type, endpoint,
             completeness)
    ORDER BY business_id, provider_account_id, entity_type, endpoint, completeness
  `;
  return rows.map((row) => ({
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    entityType: row.entity_type,
    endpoint: row.endpoint,
    completeness: row.completeness,
    runsAppended: countOrZero(row.runs_appended),
    windowOccurrences: countOrNull(row.window_occurrences),
    firstWindowOccurrenceAt: row.first_window_occurrence_at,
    lastWindowOccurrenceAt: row.last_window_occurrence_at,
    lifetimeOccurrencesOfWindowRuns: countOrZero(
      row.lifetime_occurrences_of_window_runs,
    ),
    runsWithError: countOrZero(row.runs_with_error),
    physicalStateRows: countOrZero(row.physical_state_rows),
    providerRowCount: countOrZero(row.provider_row_count),
    deltaLogicalEntityCount: countOrNull(row.delta_logical_entity_count),
    deltaChangedEntityCount: countOrNull(row.delta_changed_entity_count),
    deltaNewEntityCount: countOrNull(row.delta_new_entity_count),
    deltaExitedEntityCount: countOrNull(row.delta_exited_entity_count),
    deltaLineageCarriedEntityCount: countOrNull(
      row.delta_lineage_carried_entity_count,
    ),
    runsWithoutDeltaStats: countOrZero(row.runs_without_delta_stats),
    firstRunCapturedAt: row.first_run_captured_at,
    lastRunCapturedAt: row.last_run_captured_at,
    lastHeartbeatAtOfWindowRuns: row.last_heartbeat_at_of_window_runs,
    lastStateCapturedAt: row.last_state_captured_at,
    lastErrorKind: row.last_error_kind,
    lastErrorHttpStatus: countOrNull(row.last_error_http_status),
    lastErrorTermination: row.last_error_termination,
  }));
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

/**
 * The provider endpoint whose receipts attest an entity type's CURRENT CONFIG.
 *
 * ── ROUND 13 ────────────────────────────────────────────────────────────────
 * These are the exact literals `lib/api/meta.ts` passes to
 * `persistMetaStatusConfigObservation` (`campaign_configs`, `adset_configs`,
 * `ad_configs`), named here so a reader cannot ask about an endpoint the writer
 * never writes and silently find nothing.
 */
export const META_CONFIG_OBSERVATION_ENDPOINT: Readonly<
  Record<MetaEntityType, string>
> = Object.freeze({
  campaign: "campaign_configs",
  adset: "adset_configs",
  ad: "ad_configs",
  creative: "creative_configs",
});

export interface MetaObservationReceiptPointer {
  captureStatus: MetaObservationCompleteness;
  observedAt: string;
  capturedAt: string;
  providerRowCount: number;
  pageCount: number;
  hasError: boolean;
  /** The OBSERVATION run — coalesced content, shared by many captures. */
  runId: string;
  partitionId: string;
  sourceSnapshotId: string | null;
  /* ── ROUND 14: the exact sync attempt, and what became of it. ─────────── */
  /** `meta_sync_runs.id`, or null on a row written before the column existed. */
  syncRunId: string | null;
  syncRun: {
    status: string;
    /** ROUND 15: the attempt's own lifecycle, so the receipt can be placed inside it. */
    startedAt: string | null;
    finishedAt: string | null;
    partitionId: string;
    businessId: string;
    providerAccountId: string;
  } | null;
  /** The partition's own status, so a dead-lettered attempt cannot attest. */
  partitionStatus: string | null;
}

/**
 * The LATEST capture attempt at or before `cutoff`, whatever its outcome.
 *
 * ── ROUND 13 ────────────────────────────────────────────────────────────────
 * Deliberately NOT "the latest complete attempt". The distinction is the whole
 * point, and the table's own freshness index states it:
 *
 *   -- The FRESHNESS read: the newest attempt for an endpoint whatever its
 *   -- outcome, so a newer failure cannot be stepped over by an older
 *   -- success. Status is deliberately NOT in the leading key.
 *
 * A reader that filtered on `capture_status = 'complete'` inside the ORDER BY
 * would happily reach back past this morning's failed capture to yesterday's
 * good one and report the account as observed. The caller gets the newest row
 * and decides; it never gets to skip one.
 *
 * Ordering matches `idx_meta_entity_observation_receipts_freshness_v2`
 * exactly — `(business_id, provider_account_id, entity_type, endpoint,
 * captured_at DESC, created_at DESC, id DESC)` — so this is an index scan of
 * one row. ROUND 16: the `created_at` rung is what makes "newest" mean the
 * later ATTEMPT when two captured in the same millisecond; `id` alone is a
 * random v4 UUID and ordered them arbitrarily.
 */
export async function readMetaLatestObservationReceiptAsOf(input: {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  endpoint: string;
  cutoff: string | Date;
}): Promise<MetaObservationReceiptPointer | null> {
  const sql = getDb();
  const businessId = requireNonEmpty(input.businessId, "businessId");
  const providerAccountId = requireNonEmpty(
    input.providerAccountId,
    "providerAccountId",
  );
  const entityType = normalizeEntityType(input.entityType);
  const endpoint = requireNonEmpty(input.endpoint, "endpoint");
  const cutoff = normalizeCutoff(input.cutoff);
  const rows = await sql<{
    capture_status: string;
    observed_at: string;
    captured_at: string;
    provider_row_count: number;
    page_count: number;
    has_error: boolean;
    run_id: string;
    partition_id: string;
    source_snapshot_id: string | null;
    sync_run_id: string | null;
    sync_run_status: string | null;
    sync_run_started_at: string | null;
    sync_run_finished_at: string | null;
    sync_run_partition_id: string | null;
    sync_run_business_id: string | null;
    sync_run_provider_account_id: string | null;
    partition_status: string | null;
  }>`
    SELECT receipt.capture_status,
           receipt.observed_at::text  AS observed_at,
           receipt.captured_at::text  AS captured_at,
           receipt.provider_row_count,
           receipt.page_count,
           (receipt.error_json IS NOT NULL) AS has_error,
           receipt.run_id::text       AS run_id,
           receipt.partition_id::text AS partition_id,
           receipt.source_snapshot_id,
           receipt.sync_run_id::text  AS sync_run_id,
           run.status                 AS sync_run_status,
           -- ROUND 15: the START of the attempt, with the row's own creation
           -- clock as the fallback for a run that never stamped one. Without it
           -- the receipt cannot be placed inside the attempt's lifecycle.
           COALESCE(run.started_at, run.created_at)::text AS sync_run_started_at,
           run.finished_at::text      AS sync_run_finished_at,
           run.partition_id::text     AS sync_run_partition_id,
           run.business_id            AS sync_run_business_id,
           run.provider_account_id    AS sync_run_provider_account_id,
           part.status                AS partition_status
    FROM meta_entity_observation_receipts receipt
    -- LEFT joins on purpose. The receipt is SELECTED status-blind; whether its
    -- attempt succeeded is judged afterwards by the caller. Inner-joining a
    -- succeeded run here would let the query walk back past a newer failure to
    -- an older success, which is the exact fallback this contract forbids.
    LEFT JOIN meta_sync_runs run ON run.id = receipt.sync_run_id
    LEFT JOIN meta_sync_partitions part ON part.id = receipt.partition_id
    WHERE receipt.business_id = ${businessId}
      AND receipt.provider_account_id = ${providerAccountId}
      AND receipt.entity_type = ${entityType}
      AND receipt.endpoint = ${endpoint}
      -- BOTH clocks, STRICTLY before the knowledge bound: evidence exactly at
      -- the next provider-local midnight belongs to the next day.
      AND receipt.observed_at < ${cutoff}::timestamptz
      AND receipt.captured_at < ${cutoff}::timestamptz
    -- ROUND 15: real insertion order before the deterministic id tiebreak. The
    -- id is a random v4 UUID, so two attempts that captured in the same
    -- millisecond were previously ordered arbitrarily and the newest receipt
    -- could be the older attempt.
    ORDER BY receipt.captured_at DESC, receipt.created_at DESC, receipt.id DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    captureStatus: row.capture_status as MetaObservationCompleteness,
    observedAt: row.observed_at,
    capturedAt: row.captured_at,
    providerRowCount: Number(row.provider_row_count ?? 0),
    pageCount: Number(row.page_count ?? 0),
    hasError: Boolean(row.has_error),
    runId: row.run_id,
    partitionId: row.partition_id,
    sourceSnapshotId: row.source_snapshot_id,
    syncRunId: row.sync_run_id,
    syncRun:
      row.sync_run_status == null
        ? null
        : {
            status: row.sync_run_status,
            startedAt: row.sync_run_started_at,
            finishedAt: row.sync_run_finished_at,
            partitionId: row.sync_run_partition_id ?? "",
            businessId: row.sync_run_business_id ?? "",
            providerAccountId: row.sync_run_provider_account_id ?? "",
          },
    partitionStatus: row.partition_status,
  };
}

export type MetaManifestMembershipRefusal =
  | "observation_run_missing"
  | "observation_run_scope_mismatch"
  | "observation_run_not_complete"
  | "observation_run_errored"
  | "observation_run_clock_after_knowledge"
  | "observation_manifest_count_mismatch"
  | "observation_manifest_empty"
  /** ROUND 15: the receipt and its run disagree about how big the scope was. */
  | "observation_receipt_run_count_mismatch";

export interface MetaManifestMembership {
  ok: boolean;
  refusal: MetaManifestMembershipRefusal | null;
  /** The requested ids that are MEMBERS of the selected receipt's manifest. */
  presentEntityIds: Set<string>;
  manifestKind: string | null;
  /** The BASE manifest size, before tombstones. This is what the counts agree on. */
  manifestCount: number;
  /** Members removed by an explicit scope exit after the re-observation. */
  removedByTombstone: number;
}

/**
 * MEMBERSHIP OF THE EXACT CAPTURE THE RECEIPT NAMES.
 *
 * ── ROUND 14, CONTRACT 2 ────────────────────────────────────────────────────
 * `readMetaEntityTruthAsOf` answers a different question: "what is the latest
 * thing known about this entity at this cutoff". That accepts a `present` state
 * from ANY run — an older endpoint, an older capture, a partial lane — so an
 * entity that has not been seen since March authorised actions today, and an
 * `absent_unconfirmed` row (which means "we did not see it and cannot say why")
 * counted as evidence of presence. Neither is membership of the capture whose
 * completeness is doing the authorising.
 *
 * This asks the narrower question the authority actually needs: was this exact
 * entity IN the manifest of the observation run that the selected receipt
 * points at? The semantics are the ones already proven in
 * `lib/creative-decision-engine/data-source.ts` and
 * `lib/meta/budget-readiness-read-model.ts`, applied to one run:
 *
 *   full / legacy   the members are the rows written BY that exact run, with
 *                   `presence = 'present'`;
 *   delta           the run records only what changed, so membership is the
 *                   deterministic latest row per entity across the same
 *                   business / account / entity type / ENDPOINT, restricted to
 *                   the COMPLETE lane and to rows captured at or before the
 *                   selected run's own immutable payload clock, keeping only
 *                   those whose winning row is `present`;
 *   partial and point_lookup rows never enter delta reconstruction;
 *   `absent_unconfirmed` removes membership rather than granting it;
 *   an `explicit_deleted` / `explicit_not_found` tombstone recorded AFTER the
 *   applicable re-observation removes membership.
 *
 * COALESCED RECEIPTS. `persistMetaEntityObservation` advances a heartbeat on an
 * existing run when the semantic truth is unchanged, so the receipt's
 * occurrence clock and the run's payload clock are different facts. The delta
 * window is bounded by the RUN's immutable `captured_at` (the payload capture),
 * never by the receipt's occurrence clock, which is exactly the distinction the
 * `_d086_payload` index exists to serve.
 */
export async function readMetaCompleteManifestMembershipForReceipt(input: {
  businessId: string;
  providerAccountId: string;
  entityType: MetaEntityType;
  endpoint: string;
  /** The OBSERVATION run the selected receipt points at. */
  observationRunId: string;
  /** The receipt's own provider row count. */
  expectedProviderRowCount: number;
  /**
   * ── ROUND 15, DEFECT 2 ──────────────────────────────────────────────────
   * The RECEIPT OCCURRENCE clock, which is not the run's payload clock. A
   * coalesced receipt at t2 re-observes a payload first captured at t1: the
   * base manifest is reconstructed against t1 (the immutable payload), but the
   * account was demonstrably still being observed at t2, so a scope exit
   * recorded between t1 and t2 is SUPERSEDED by that re-observation. Only a
   * tombstone at or after t2 wins.
   */
  receiptCapturedAt: string | Date;
  /** Strict upper bound; evidence at or after this instant is the next day's. */
  knowledgeEndExclusive: string | Date;
  entityIds: readonly string[];
}): Promise<MetaManifestMembership> {
  const sql = getDb();
  const businessId = requireNonEmpty(input.businessId, "businessId");
  const providerAccountId = requireNonEmpty(
    input.providerAccountId,
    "providerAccountId",
  );
  const entityType = normalizeEntityType(input.entityType);
  const endpoint = requireNonEmpty(input.endpoint, "endpoint");
  const runId = requireNonEmpty(input.observationRunId, "observationRunId");
  const knowledge = normalizeCutoff(input.knowledgeEndExclusive);
  const receiptCapturedAt = normalizeCutoff(input.receiptCapturedAt);
  const requested = Array.from(
    new Set(input.entityIds.map((id) => id.trim())),
  ).filter((id) => id.length > 0);
  const deny = (
    refusal: MetaManifestMembershipRefusal,
  ): MetaManifestMembership => ({
    ok: false,
    refusal,
    presentEntityIds: new Set<string>(),
    manifestKind: null,
    manifestCount: 0,
    removedByTombstone: 0,
  });

  // ── 1. THE RUN ITSELF, validated before a single member is read. ──────────
  const runRows = await sql<{
    manifest_kind: string | null;
    completeness: string;
    row_count: number;
    has_error: boolean;
    observed_at: string;
    captured_at: string;
    scope_ok: boolean;
  }>`
    SELECT run.manifest_kind,
           run.completeness,
           run.row_count,
           (run.error_json IS NOT NULL) AS has_error,
           run.observed_at::text AS observed_at,
           run.captured_at::text AS captured_at,
           (run.business_id = ${businessId}
            AND run.provider_account_id = ${providerAccountId}
            AND run.entity_type = ${entityType}
            AND run.endpoint = ${endpoint}) AS scope_ok
    FROM meta_entity_observation_runs run
    WHERE run.id = ${runId}::uuid
    LIMIT 1
  `;
  const run = runRows[0];
  if (!run) return deny("observation_run_missing");
  if (!run.scope_ok) return deny("observation_run_scope_mismatch");
  if (run.completeness !== "complete") return deny("observation_run_not_complete");
  if (run.has_error) return deny("observation_run_errored");
  // IMMUTABLE CLOCKS, strictly inside the knowledge bound. A heartbeat can move
  // a run's effective clock; these two cannot.
  if (
    new Date(run.observed_at).getTime() >= new Date(knowledge).getTime() ||
    new Date(run.captured_at).getTime() >= new Date(knowledge).getTime()
  ) {
    return deny("observation_run_clock_after_knowledge");
  }
  /*
    ── ROUND 15: THE TWO RECORDED SCOPE SIZES MUST AGREE FIRST ─────────────
    Both the run and the receipt record how large the provider scope was. If
    they disagree, the pair is internally inconsistent and nothing downstream
    can be trusted to say an entity was absent.
  */
  const runRowCount = Number(run.row_count ?? 0);
  if (runRowCount !== input.expectedProviderRowCount) {
    return deny("observation_receipt_run_count_mismatch");
  }

  /*
    ── 2. THE BASE MANIFEST, RECONSTRUCTED BEFORE ANY TOMBSTONE ────────────

    ROUND 15 correction. Round 14 exempted delta runs from the count check on
    the belief that a delta run's `row_count` is the size of the change. It is
    not: `META_PARTIAL_MANIFEST_CONTRACT` states that `logicalEntityCount` — and
    the run's `row_count` with it — is "the whole observed payload", the full
    logical provider scope, on the complete lane too. So the integrity check
    applies to BOTH lanes, and skipping it on delta was exactly the hole a
    truncated delta needed.

    Tombstones are deliberately NOT applied here. Removing an exited entity
    before counting would make one legitimate deletion look like a truncated
    capture and invalidate every surviving member with it.
  */
  const isDelta = run.manifest_kind === "delta";
  const baseRows = await sql<{ entity_id: string }>`
    SELECT state.entity_id
    FROM meta_entity_state_history state
    WHERE ${!isDelta}::boolean
      AND state.run_id = ${runId}::uuid
      AND state.business_id = ${businessId}
      AND state.provider_account_id = ${providerAccountId}
      AND state.entity_type = ${entityType}
      AND state.presence = 'present'
      AND state.observed_at < ${knowledge}::timestamptz
      AND state.captured_at < ${knowledge}::timestamptz

    UNION ALL

    SELECT latest.entity_id
    FROM (
      SELECT DISTINCT ON (state.entity_id)
        state.entity_id, state.presence
      FROM meta_entity_state_history state
      WHERE ${isDelta}::boolean
        AND state.business_id = ${businessId}
        AND state.provider_account_id = ${providerAccountId}
        AND state.entity_type = ${entityType}
        -- COMPLETE LANE ONLY. Partial and point-lookup rows never enter a delta
        -- reconstruction: neither enumerates the account, so neither can
        -- establish that an absent entity is really absent.
        AND state.run_completeness = 'complete'
        -- Same ENDPOINT as the selected run: a different endpoint is a
        -- different manifest and must not leak in.
        AND EXISTS (
          SELECT 1 FROM meta_entity_observation_runs scope_run
          WHERE scope_run.id = state.run_id
            AND scope_run.endpoint = ${endpoint}
            AND scope_run.business_id = ${businessId}
            AND scope_run.provider_account_id = ${providerAccountId}
            AND scope_run.entity_type = ${entityType}
        )
        -- Bounded by the selected run IMMUTABLE payload clock, not by the
        -- receipt occurrence clock: a coalesced receipt shares a payload it did
        -- not itself capture.
        AND state.captured_at <= ${run.captured_at}::timestamptz
        AND state.observed_at < ${knowledge}::timestamptz
        AND state.captured_at < ${knowledge}::timestamptz
      ORDER BY state.entity_id, state.captured_at DESC, state.created_at DESC,
               state.id DESC
    ) latest
    -- absent_unconfirmed REMOVES membership. It means the capture did not see
    -- the entity and cannot say why, which is the opposite of evidence.
    WHERE latest.presence = 'present'
  `;
  const base = new Set(baseRows.map((row) => row.entity_id));
  /*
    THE INTEGRITY CHECK, on the BASE manifest and on BOTH lanes. A truncated or
    corrupt delta — receipt and run both claiming 2, reconstruction yielding 1 —
    is refused here rather than silently answering "that entity was absent".
  */
  if (base.size !== runRowCount) {
    return deny("observation_manifest_count_mismatch");
  }
  /*
    ── ROUND 16: A GENUINELY EMPTY ACCOUNT IS VALID, NOT BROKEN ─────────────

    Round 15 refused an empty manifest outright, before comparing counts. That
    conflated two different worlds: a capture that lost its rows, and an account
    that really has no ad sets. The first is caught by the count comparison
    above (recorded 2, reconstructed 0 is a mismatch); the second records 0 and
    reconstructs 0, which is a complete, truthful observation of an empty scope.

    Refusing it made an empty account permanently unattestable — and, once the
    bootstrap started reading this attestation, permanently in recovery. There
    are no entities to decide about either way, so the honest answer is a valid
    manifest with no members.
  */
  if (base.size === 0 && runRowCount !== 0) {
    return deny("observation_manifest_empty");
  }

  /*
    ── 3. LIVE MEMBERS: apply explicit scope exits AFTER the integrity check ──

    The re-observation instant is the RECEIPT OCCURRENCE clock. A coalesced
    receipt at t2 means the account was observed again at t2 and this entity was
    still in it, so a tombstone recorded between the payload clock t1 and t2 is
    SUPERSEDED. A tombstone at or after t2 wins — `>=`, which is the canonical
    deterministic tie rule this repository already uses, where a tombstone
    outranks a state at an identical clock.
  */
  const tombstoned = await sql<{ entity_id: string }>`
    SELECT DISTINCT tomb.entity_id
    FROM meta_entity_tombstones tomb
    WHERE tomb.business_id = ${businessId}
      AND tomb.provider_account_id = ${providerAccountId}
      AND tomb.entity_type = ${entityType}
      AND tomb.reason IN ('explicit_deleted', 'explicit_not_found')
      AND tomb.captured_at >= ${receiptCapturedAt}::timestamptz
      AND tomb.observed_at < ${knowledge}::timestamptz
      AND tomb.captured_at < ${knowledge}::timestamptz
  `;
  const exited = new Set(tombstoned.map((row) => row.entity_id));
  const live = new Set([...base].filter((id) => !exited.has(id)));
  return {
    ok: true,
    refusal: null,
    presentEntityIds: new Set(requested.filter((id) => live.has(id))),
    manifestKind: run.manifest_kind,
    manifestCount: base.size,
    removedByTombstone: base.size - live.size,
  };
}
