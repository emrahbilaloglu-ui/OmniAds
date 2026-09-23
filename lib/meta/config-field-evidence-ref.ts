/**
 * THE RECEIPT A CONFIG DECISION CITES — `ConfigFieldEvidenceRef`.
 *
 * ── The defect this exists to end ────────────────────────────────────────────
 * The raw receipt model knows exactly which provider GET proved a config value:
 * `lib/meta/raw-config-receipts.ts` carries the canonical snapshot id, the
 * observation (receipt) id, the page clock, the field scope and the
 * normalization version. The decision chain never saw any of it. The shared SQL
 * contract (`lib/meta/config-field-source-contract.ts`) resolved each field to a
 * value, a tier and a readiness and dropped the identity of the receipt that
 * earned them; hydration, calibration, the evaluation input hash, persistence,
 * the read model and the UI then carried only "bracketed / point-in-day /
 * unknown". Two evaluations resting on different receipts but the same value
 * and tier hashed IDENTICALLY, and no stored decision could name the receipt it
 * relied on.
 *
 * ── What a reference is ─────────────────────────────────────────────────────
 * One field, one evaluation day, the receipt the contract SELECTED for it (not
 * every re-observation: one snapshot can be re-observed hundreds of times a day,
 * and INVARIANTS "evidence that chooses nothing must not move identity"), plus
 * the corroborating receipt when the tier is a bracket, plus the class facts the
 * contract already computes. It explains a decision and may never grant one:
 * authority still comes only from `readiness`, through
 * `lib/meta/config-field-readiness.ts`.
 *
 * ── Fail-closed coherence ───────────────────────────────────────────────────
 * A reference that is malformed, from an unknown contract, or incoherent with
 * the tier it claims (a receipt tier without a receipt, a legacy snapshot-only
 * receipt claiming an observation id, a modern receipt missing one) is not
 * evidence. Its field's readiness is forced to `none` before any authority rule
 * runs. The rule is defined ONCE, in the tables below, and emitted both as a
 * TypeScript parser and as a SQL predicate, so the two readers cannot drift.
 *
 * ── Current day vs economic window ──────────────────────────────────────────
 * The CURRENT day's references travel whole (four per ad). The economic window
 * — every economically meaningful day in the ad's own decision metrics, D098 —
 * travels as a compact manifest: a sha256 over one identity line per economic
 * day, plus counts. The line format is emitted by the same code in both
 * languages so a test can recompute the SQL hash in TypeScript.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 * - It never turns a current-configuration fallback into historical evidence:
 *   `current_fallback` exists only on `unknown` tier with readiness `none`.
 * - It never infers an identity for legacy rows: a legacy snapshot-only receipt
 *   carries an explicit null observation id, and a persisted evaluation from
 *   before this contract carries no reference at all (explicit NULL).
 */
import { createHash } from "node:crypto";

import {
  META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION,
  META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION,
  META_CONFIG_FIELD_SOURCE_NORMALIZATION_VERSION,
  META_CONFIG_FIELD_TIERS,
  readinessForConfigFieldTier,
  type MetaConfigFieldReadiness,
  type MetaConfigFieldTier,
} from "@/lib/meta/config-field-source-contract";

export {
  META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION,
  META_CONFIG_FIELD_SOURCE_NORMALIZATION_VERSION,
};

/** The fields a native ad decision's config authority rests on. */
export const META_CONFIG_EVIDENCE_FIELDS = [
  "objective",
  "optimization_goal",
  "custom_event_type",
  "custom_conversion_id",
] as const;

export type MetaConfigEvidenceField = (typeof META_CONFIG_EVIDENCE_FIELDS)[number];

/** Source contracts whose references this parser can read. Unknown fails closed. */
export const META_CONFIG_EVIDENCE_READABLE_SOURCE_CONTRACTS: readonly string[] = [
  META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION,
];

/** Classes that name a real provider receipt. */
export const META_CONFIG_EVIDENCE_RECEIPT_SOURCE_CLASSES = [
  "modern",
  "legacy_observed",
  "legacy_multi_page",
  "legacy_snapshot_only",
] as const;

/** Receipt classes that are, by definition, an observation row. */
const OBSERVATION_SOURCE_CLASSES = ["modern", "legacy_observed", "legacy_multi_page"] as const;

/**
 * Every source class a reference may carry. `current_fallback` is a value the
 * loader took from the current warehouse because no receipt proved the day; it
 * is listed so a surface can say "current configuration, not historical
 * evidence" instead of "no receipt", and it can only ever sit on `unknown`.
 */
export const META_CONFIG_EVIDENCE_SOURCE_CLASSES = [
  ...META_CONFIG_EVIDENCE_RECEIPT_SOURCE_CLASSES,
  "typed_unlinked",
  "none",
  "current_fallback",
] as const;

export type MetaConfigEvidenceSourceClass =
  (typeof META_CONFIG_EVIDENCE_SOURCE_CLASSES)[number];

export const META_CONFIG_EVIDENCE_PIT_CLASSES = ["as_of_known", "restated"] as const;
export type MetaConfigEvidencePitClass = (typeof META_CONFIG_EVIDENCE_PIT_CLASSES)[number];

/** Tiers that can only be earned by a provider receipt (including observed absence). */
export const META_CONFIG_EVIDENCE_RECEIPT_TIERS: readonly MetaConfigFieldTier[] =
  META_CONFIG_FIELD_TIERS.filter(
    (tier) => tier.startsWith("provider_receipt_") || tier === "observed_absent",
  );

/** Tiers whose proof includes a SECOND, day-closing receipt. */
export const META_CONFIG_EVIDENCE_BRACKETED_TIERS: readonly MetaConfigFieldTier[] = [
  "provider_receipt_day_bracketed",
  "provider_receipt_legacy_bracketed",
];

/**
 * Tiers the source contract can only reach through a MODERN receipt: both
 * builders' ladders require `sameDay.is_modern` for them, and a modern row's
 * source class is always `modern`. A reference claiming one of these tiers
 * under any other class contradicts the contract that produced it.
 * (Only the mappings verified in the ladder are encoded; the legacy tiers are
 * left to the receipt-class rule rather than guessed.)
 */
export const META_CONFIG_EVIDENCE_MODERN_ONLY_TIERS: readonly MetaConfigFieldTier[] = [
  "provider_receipt_day_bracketed",
  "provider_receipt_point_in_day",
];

export interface ConfigFieldEvidenceRef {
  refContractVersion: typeof META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION;
  field: MetaConfigEvidenceField;
  /** The field-source rule the receipt was admitted under. */
  sourceContractVersion: string;
  /** The value extraction/agreement rule; null only on a receipt-less tier. */
  normalizationVersion: number | null;
  tier: MetaConfigFieldTier;
  /** The contract's readiness for `tier`, BEFORE any warehouse-agreement gate. */
  readiness: MetaConfigFieldReadiness;
  sourceClass: MetaConfigEvidenceSourceClass;
  pitClass: MetaConfigEvidencePitClass | null;
  /** The canonical raw content id (`meta_raw_snapshots.id`). */
  sourceSnapshotId: string | null;
  /** The receipt id (`meta_raw_snapshot_observations.id`); null for snapshot-only. */
  observationId: string | null;
  /** The per-entity page clock the tier was decided on, ISO-8601 UTC ms. */
  observedAt: string | null;
  /** sha256 hex of the receipt's effective field scope. */
  fieldScopeHash: string | null;
  corroboratingSnapshotId: string | null;
  corroboratingObservationId: string | null;
  corroboratingObservedAt: string | null;
}

export type ConfigFieldEvidenceRefRefusal =
  | "absent"
  | "not_an_object"
  | "ref_contract_unknown"
  | "field_mismatch"
  | "source_contract_unknown"
  | "tier_unknown"
  | "readiness_incoherent"
  | "source_class_unknown"
  | "pit_class_invalid"
  | "normalization_version_invalid"
  | "identity_malformed"
  | "identity_incoherent";

export type ConfigFieldEvidenceRefParseResult =
  | { ok: true; ref: ConfigFieldEvidenceRef }
  | { ok: false; refusal: ConfigFieldEvidenceRefRefusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/* SQL twins of the three patterns above. Kept adjacent: a change to one is a change to both. */
const SQL_UUID = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";
const SQL_INSTANT = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'";
const SQL_SHA256_HEX = "'^[0-9a-f]{64}$'";

const IDENTITY_KEYS = [
  "sourceSnapshotId",
  "observationId",
  "observedAt",
  "fieldScopeHash",
  "corroboratingSnapshotId",
  "corroboratingObservationId",
  "corroboratingObservedAt",
] as const;

type IdentityKey = (typeof IDENTITY_KEYS)[number];

function nullableText(raw: Record<string, unknown>, key: string): string | null | undefined {
  const value = raw[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

function validInstant(value: string): boolean {
  return INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Parses one reference. Anything short of a coherent reference for `field`
 * is refused; the caller forces that field's readiness to `none`.
 */
export function parseConfigFieldEvidenceRef(
  raw: unknown,
  field: MetaConfigEvidenceField,
): ConfigFieldEvidenceRefParseResult {
  if (raw === null || raw === undefined) return { ok: false, refusal: "absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, refusal: "not_an_object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.refContractVersion !== META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION) {
    return { ok: false, refusal: "ref_contract_unknown" };
  }
  if (record.field !== field) return { ok: false, refusal: "field_mismatch" };
  if (
    typeof record.sourceContractVersion !== "string" ||
    !META_CONFIG_EVIDENCE_READABLE_SOURCE_CONTRACTS.includes(record.sourceContractVersion)
  ) {
    return { ok: false, refusal: "source_contract_unknown" };
  }
  const tier = record.tier;
  if (typeof tier !== "string" || !(META_CONFIG_FIELD_TIERS as readonly string[]).includes(tier)) {
    return { ok: false, refusal: "tier_unknown" };
  }
  const typedTier = tier as MetaConfigFieldTier;
  if (record.readiness !== readinessForConfigFieldTier(typedTier)) {
    return { ok: false, refusal: "readiness_incoherent" };
  }
  const sourceClass = record.sourceClass;
  if (
    typeof sourceClass !== "string" ||
    !(META_CONFIG_EVIDENCE_SOURCE_CLASSES as readonly string[]).includes(sourceClass)
  ) {
    return { ok: false, refusal: "source_class_unknown" };
  }
  const pitClass = record.pitClass ?? null;
  if (
    pitClass !== null &&
    !(META_CONFIG_EVIDENCE_PIT_CLASSES as readonly unknown[]).includes(pitClass)
  ) {
    return { ok: false, refusal: "pit_class_invalid" };
  }
  const normalizationVersion = record.normalizationVersion ?? null;
  if (normalizationVersion !== null && typeof normalizationVersion !== "number") {
    return { ok: false, refusal: "normalization_version_invalid" };
  }

  const identity = {} as Record<IdentityKey, string | null>;
  for (const key of IDENTITY_KEYS) {
    const value = nullableText(record, key);
    if (value === undefined) return { ok: false, refusal: "identity_malformed" };
    identity[key] = value;
  }
  for (const key of [
    "sourceSnapshotId",
    "observationId",
    "corroboratingSnapshotId",
    "corroboratingObservationId",
  ] as const) {
    if (identity[key] !== null && !UUID.test(identity[key]!)) {
      return { ok: false, refusal: "identity_malformed" };
    }
  }
  for (const key of ["observedAt", "corroboratingObservedAt"] as const) {
    if (identity[key] !== null && !validInstant(identity[key]!)) {
      return { ok: false, refusal: "identity_malformed" };
    }
  }
  if (identity.fieldScopeHash !== null && !SHA256_HEX.test(identity.fieldScopeHash)) {
    return { ok: false, refusal: "identity_malformed" };
  }

  if (
    !identityCoherent({
      tier: typedTier,
      sourceClass: sourceClass as MetaConfigEvidenceSourceClass,
      pitClass: pitClass as MetaConfigEvidencePitClass | null,
      normalizationVersion: normalizationVersion as number | null,
      identity,
    })
  ) {
    return { ok: false, refusal: "identity_incoherent" };
  }

  return {
    ok: true,
    ref: {
      refContractVersion: META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION,
      field,
      sourceContractVersion: record.sourceContractVersion,
      normalizationVersion: normalizationVersion as number | null,
      tier: typedTier,
      readiness: readinessForConfigFieldTier(typedTier),
      sourceClass: sourceClass as MetaConfigEvidenceSourceClass,
      pitClass: pitClass as MetaConfigEvidencePitClass | null,
      ...identity,
    },
  };
}

/**
 * The coherence rule, stated once. `configFieldEvidenceRefCoherentSql` emits the
 * same rule for SQL; the parity test drives both from the same fixtures.
 */
function identityCoherent(input: {
  tier: MetaConfigFieldTier;
  sourceClass: MetaConfigEvidenceSourceClass;
  pitClass: MetaConfigEvidencePitClass | null;
  normalizationVersion: number | null;
  identity: Record<IdentityKey, string | null>;
}): boolean {
  const { tier, sourceClass, identity } = input;
  const allNull = IDENTITY_KEYS.every((key) => identity[key] === null);
  if (META_CONFIG_EVIDENCE_RECEIPT_TIERS.includes(tier)) {
    if (!(META_CONFIG_EVIDENCE_RECEIPT_SOURCE_CLASSES as readonly string[]).includes(sourceClass)) {
      return false;
    }
    if (input.pitClass === null) return false;
    if (input.normalizationVersion !== META_CONFIG_FIELD_SOURCE_NORMALIZATION_VERSION) return false;
    if (identity.sourceSnapshotId === null || identity.observedAt === null) return false;
    if (identity.fieldScopeHash === null) return false;
    const isObservation = (OBSERVATION_SOURCE_CLASSES as readonly string[]).includes(sourceClass);
    if (isObservation && identity.observationId === null) return false;
    if (!isObservation && identity.observationId !== null) return false;
    if (META_CONFIG_EVIDENCE_MODERN_ONLY_TIERS.includes(tier) && sourceClass !== "modern") {
      return false;
    }
    if (META_CONFIG_EVIDENCE_BRACKETED_TIERS.includes(tier)) {
      if (identity.corroboratingSnapshotId === null || identity.corroboratingObservedAt === null) {
        return false;
      }
    } else if (
      /* A later sighting that closed no bracket is not part of the proof. */
      identity.corroboratingSnapshotId !== null ||
      identity.corroboratingObservationId !== null ||
      identity.corroboratingObservedAt !== null
    ) {
      return false;
    }
    return true;
  }
  if (tier === "typed_contemporaneous") {
    return sourceClass === "typed_unlinked" &&
      input.pitClass === null &&
      input.normalizationVersion === null &&
      allNull;
  }
  if (tier === "unknown") {
    return (sourceClass === "none" || sourceClass === "current_fallback") &&
      input.pitClass === null &&
      input.normalizationVersion === null &&
      allNull;
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SQL: the same rule over a jsonb reference expression.
 * ──────────────────────────────────────────────────────────────────────────── */

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

const SQL_REF_EXPRESSION = /^[a-z_][a-z0-9_.]*$/;

function assertRefExpression(refSql: string): void {
  if (!SQL_REF_EXPRESSION.test(refSql)) {
    throw new Error(`config_evidence_ref_sql_expression_invalid:${refSql}`);
  }
}

/** TRUE only for a coherent reference for `field`. Never NULL. */
export function configFieldEvidenceRefCoherentSql(
  refSql: string,
  field: MetaConfigEvidenceField,
): string {
  assertRefExpression(refSql);
  const text = (key: string) => `(${refSql}->>'${key}')`;
  const isNull = (key: string) =>
    `(${refSql}->'${key}' IS NULL OR jsonb_typeof(${refSql}->'${key}') = 'null')`;
  const matches = (key: string, pattern: string) =>
    `(jsonb_typeof(${refSql}->'${key}') = 'string' AND ${text(key)} ~ ${pattern})`;
  const nullOr = (key: string, pattern: string) => `(${isNull(key)} OR ${matches(key, pattern)})`;
  const readinessArms = META_CONFIG_FIELD_TIERS.map(
    (tier) => `WHEN '${tier}' THEN '${readinessForConfigFieldTier(tier)}'`,
  ).join(" ");
  const allIdentityNull = IDENTITY_KEYS.map(isNull).join(" AND ");
  const wellFormed = [
    nullOr("sourceSnapshotId", SQL_UUID),
    nullOr("observationId", SQL_UUID),
    nullOr("corroboratingSnapshotId", SQL_UUID),
    nullOr("corroboratingObservationId", SQL_UUID),
    nullOr("observedAt", SQL_INSTANT),
    nullOr("corroboratingObservedAt", SQL_INSTANT),
    nullOr("fieldScopeHash", SQL_SHA256_HEX),
  ].join("\n      AND ");
  return `COALESCE((
    jsonb_typeof(${refSql}) = 'object'
      AND ${text("refContractVersion")} = '${META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION}'
      AND ${text("field")} = '${field}'
      AND ${text("sourceContractVersion")} IN (${sqlList(META_CONFIG_EVIDENCE_READABLE_SOURCE_CONTRACTS)})
      AND ${text("tier")} IN (${sqlList(META_CONFIG_FIELD_TIERS)})
      AND ${text("readiness")} = (CASE ${text("tier")} ${readinessArms} ELSE NULL END)
      AND ${text("sourceClass")} IN (${sqlList(META_CONFIG_EVIDENCE_SOURCE_CLASSES)})
      AND (${isNull("pitClass")} OR ${text("pitClass")} IN (${sqlList(META_CONFIG_EVIDENCE_PIT_CLASSES)}))
      AND (${isNull("normalizationVersion")} OR jsonb_typeof(${refSql}->'normalizationVersion') = 'number')
      AND ${wellFormed}
      AND (CASE
        WHEN ${text("tier")} IN (${sqlList(META_CONFIG_EVIDENCE_RECEIPT_TIERS)}) THEN (
          ${text("sourceClass")} IN (${sqlList(META_CONFIG_EVIDENCE_RECEIPT_SOURCE_CLASSES)})
          AND NOT ${isNull("pitClass")}
          AND ${refSql}->'normalizationVersion' = '${META_CONFIG_FIELD_SOURCE_NORMALIZATION_VERSION}'::jsonb
          AND NOT ${isNull("sourceSnapshotId")}
          AND NOT ${isNull("observedAt")}
          AND NOT ${isNull("fieldScopeHash")}
          AND (CASE
            WHEN ${text("sourceClass")} IN (${sqlList(OBSERVATION_SOURCE_CLASSES)})
              THEN NOT ${isNull("observationId")}
            ELSE ${isNull("observationId")}
          END)
          AND (CASE
            WHEN ${text("tier")} IN (${sqlList(META_CONFIG_EVIDENCE_MODERN_ONLY_TIERS)})
              THEN ${text("sourceClass")} = 'modern'
            ELSE TRUE
          END)
          AND (CASE
            WHEN ${text("tier")} IN (${sqlList(META_CONFIG_EVIDENCE_BRACKETED_TIERS)})
              THEN NOT ${isNull("corroboratingSnapshotId")}
                AND NOT ${isNull("corroboratingObservedAt")}
            ELSE ${isNull("corroboratingSnapshotId")}
              AND ${isNull("corroboratingObservationId")}
              AND ${isNull("corroboratingObservedAt")}
          END)
        )
        WHEN ${text("tier")} = 'typed_contemporaneous'
          THEN ${text("sourceClass")} = 'typed_unlinked'
            AND ${isNull("pitClass")}
            AND ${isNull("normalizationVersion")}
            AND ${allIdentityNull}
        WHEN ${text("tier")} = 'unknown'
          THEN ${text("sourceClass")} IN ('none', 'current_fallback')
            AND ${isNull("pitClass")}
            AND ${isNull("normalizationVersion")}
            AND ${allIdentityNull}
        ELSE FALSE
      END)
  ), FALSE)`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The economic-window manifest.
 *
 * One line per economically meaningful day, in date order:
 *   <YYYY-MM-DD>|<objective>|<optimization_goal>|<custom_event_type>|<custom_conversion_id>
 * where each field is `absent` for a missing reference and otherwise the
 * colon-joined identity below. The hash covers the manifest version and the
 * lines, so a changed receipt, a changed observation under the same snapshot, or
 * a changed class moves it; a re-observation the contract did not select does
 * not.
 * ──────────────────────────────────────────────────────────────────────────── */

export const META_CONFIG_RECEIPT_MANIFEST_VERSION = "meta-config-receipt-window-manifest.v1";

const IDENTITY_TEXT_KEYS = [
  "refContractVersion",
  "field",
  "sourceContractVersion",
  "normalizationVersion",
  "tier",
  "readiness",
  "sourceClass",
  "pitClass",
  "sourceSnapshotId",
  "observationId",
  "observedAt",
  "fieldScopeHash",
  "corroboratingSnapshotId",
  "corroboratingObservationId",
  "corroboratingObservedAt",
] as const;

/** The identity text of one reference (TypeScript twin of the SQL below). */
export function configFieldEvidenceRefIdentityText(
  ref: Partial<Record<(typeof IDENTITY_TEXT_KEYS)[number], unknown>> | null | undefined,
): string {
  if (ref === null || ref === undefined) return "absent";
  return IDENTITY_TEXT_KEYS.map((key) => {
    const value = ref[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  }).join(":");
}

export function configFieldEvidenceRefIdentityTextSql(refSql: string): string {
  assertRefExpression(refSql);
  const parts = IDENTITY_TEXT_KEYS.map(
    (key) =>
      `COALESCE(CASE WHEN jsonb_typeof(${refSql}->'${key}') IN ('string', 'number') THEN ${refSql}->>'${key}' END, '')`,
  ).join(" || ':' || ");
  return `(CASE WHEN ${refSql} IS NULL OR jsonb_typeof(${refSql}) <> 'object' THEN 'absent' ELSE ${parts} END)`;
}

/** The manifest line for one day (TypeScript twin of `configReceiptManifestLineSql`). */
export function configReceiptManifestLine(
  date: string,
  refs: Partial<Record<MetaConfigEvidenceField, unknown>>,
): string {
  return [
    date,
    ...META_CONFIG_EVIDENCE_FIELDS.map((field) =>
      configFieldEvidenceRefIdentityText(
        (refs[field] ?? null) as Parameters<typeof configFieldEvidenceRefIdentityText>[0],
      ),
    ),
  ].join("|");
}

export function configReceiptManifestLineSql(input: {
  dateSql: string;
  refSql: Record<MetaConfigEvidenceField, string>;
}): string {
  return [
    `to_char(${input.dateSql}, 'YYYY-MM-DD')`,
    ...META_CONFIG_EVIDENCE_FIELDS.map((field) =>
      configFieldEvidenceRefIdentityTextSql(input.refSql[field]),
    ),
  ].join(" || '|' || ");
}

/** How many receipt-backed references on a day carry no observation id (legacy snapshot-only). */
export function configReceiptNullObservationCountSql(
  refSql: Record<MetaConfigEvidenceField, string>,
): string {
  return META_CONFIG_EVIDENCE_FIELDS.map((field) => {
    const ref = refSql[field];
    assertRefExpression(ref);
    return `(CASE WHEN (${ref}->>'tier') IN (${sqlList(META_CONFIG_EVIDENCE_RECEIPT_TIERS)})
        AND (${ref}->'observationId' IS NULL OR jsonb_typeof(${ref}->'observationId') = 'null')
      THEN 1 ELSE 0 END)`;
  }).join(" + ");
}

/** sha256 of the manifest (TypeScript twin of `configReceiptManifestHashSql`). */
export function hashConfigReceiptManifest(lines: readonly string[]): string {
  return createHash("sha256")
    .update(`${META_CONFIG_RECEIPT_MANIFEST_VERSION}\n${lines.join("\n")}`, "utf8")
    .digest("hex");
}

/**
 * Aggregate SQL for the manifest hash over the rows of a GROUP BY for which
 * `includeSql` holds, ordered by `orderSql`.
 */
export function configReceiptManifestHashSql(input: {
  lineSql: string;
  includeSql: string;
  orderSql: string;
}): string {
  return `encode(sha256(convert_to(
      '${META_CONFIG_RECEIPT_MANIFEST_VERSION}' || E'\\n' ||
      COALESCE(string_agg(${input.lineSql}, E'\\n' ORDER BY ${input.orderSql})
        FILTER (WHERE ${input.includeSql}), ''),
      'UTF8')), 'hex')`;
}

/** What the evaluation envelope carries for the economic window. */
export interface ConfigReceiptWindowManifest {
  manifestVersion: typeof META_CONFIG_RECEIPT_MANIFEST_VERSION;
  refContractVersion: typeof META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION;
  hash: string;
  economicDayCount: number;
  /** Receipt-backed references with no observation id (legacy snapshot-only). */
  nullObservationIdCount: number;
  /** Economic days on which at least one reference failed the coherence rule. */
  incoherentDayCount: number;
}

/**
 * Validates the SQL-produced manifest facts. A malformed manifest is not
 * evidence: the caller treats the economic window as unverified.
 */
export function parseConfigReceiptWindowManifest(input: {
  manifestVersion?: unknown;
  refContractVersion?: unknown;
  hash: unknown;
  economicDayCount: unknown;
  nullObservationIdCount: unknown;
  incoherentDayCount: unknown;
}): ConfigReceiptWindowManifest | null {
  const count = (value: unknown): number | null => {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
  };
  const economicDayCount = count(input.economicDayCount);
  const nullObservationIdCount = count(input.nullObservationIdCount);
  const incoherentDayCount = count(input.incoherentDayCount);
  if (
    (input.manifestVersion !== undefined &&
      input.manifestVersion !== META_CONFIG_RECEIPT_MANIFEST_VERSION) ||
    (input.refContractVersion !== undefined &&
      input.refContractVersion !== META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION) ||
    typeof input.hash !== "string" ||
    !SHA256_HEX.test(input.hash) ||
    economicDayCount === null ||
    nullObservationIdCount === null ||
    incoherentDayCount === null ||
    incoherentDayCount > economicDayCount ||
    nullObservationIdCount > economicDayCount * META_CONFIG_EVIDENCE_FIELDS.length
  ) {
    return null;
  }
  return {
    manifestVersion: META_CONFIG_RECEIPT_MANIFEST_VERSION,
    refContractVersion: META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION,
    hash: input.hash,
    economicDayCount,
    nullObservationIdCount,
    incoherentDayCount,
  };
}

/**
 * A reference for a value NO receipt proved: tier `unknown`, readiness `none`,
 * every identity field an explicit JSON null. `sourceClassSql` must evaluate to
 * 'none' or 'current_fallback' — the latter for a value the loader took from
 * the current warehouse, so a surface can say "current configuration, not
 * historical evidence" instead of "no receipt". It never grants anything.
 */
export function configFieldEvidenceRefWithoutReceiptSql(
  field: MetaConfigEvidenceField,
  sourceClassSql: string,
): string {
  return `jsonb_build_object(
      'refContractVersion', '${META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION}',
      'field', '${field}',
      'sourceContractVersion', '${META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION}',
      'normalizationVersion', NULL::integer,
      'tier', 'unknown',
      'readiness', 'none',
      'sourceClass', (${sourceClassSql}),
      'pitClass', NULL::text,
      'sourceSnapshotId', NULL::text,
      'observationId', NULL::text,
      'observedAt', NULL::text,
      'fieldScopeHash', NULL::text,
      'corroboratingSnapshotId', NULL::text,
      'corroboratingObservationId', NULL::text,
      'corroboratingObservedAt', NULL::text
    )`;
}

/**
 * The ENUMERATED, hash-stable form of a reference (INVARIANTS: a canonicalizer
 * must enumerate what it hashes). A new member of `ConfigFieldEvidenceRef`
 * therefore cannot enter an evaluation hash by accident.
 */
export function canonicalConfigFieldEvidenceRef(
  ref: ConfigFieldEvidenceRef | null,
): Record<string, string | number | null> | null {
  if (ref === null) return null;
  return {
    refContractVersion: ref.refContractVersion,
    field: ref.field,
    sourceContractVersion: ref.sourceContractVersion,
    normalizationVersion: ref.normalizationVersion,
    tier: ref.tier,
    readiness: ref.readiness,
    sourceClass: ref.sourceClass,
    pitClass: ref.pitClass,
    sourceSnapshotId: ref.sourceSnapshotId,
    observationId: ref.observationId,
    observedAt: ref.observedAt,
    fieldScopeHash: ref.fieldScopeHash,
    corroboratingSnapshotId: ref.corroboratingSnapshotId,
    corroboratingObservationId: ref.corroboratingObservationId,
    corroboratingObservedAt: ref.corroboratingObservedAt,
  };
}

/** The enumerated, hash-stable form of a window manifest. */
export function canonicalConfigReceiptWindowManifest(
  manifest: ConfigReceiptWindowManifest | null,
): Record<string, string | number> | null {
  if (manifest === null) return null;
  return {
    manifestVersion: manifest.manifestVersion,
    refContractVersion: manifest.refContractVersion,
    hash: manifest.hash,
    economicDayCount: manifest.economicDayCount,
    nullObservationIdCount: manifest.nullObservationIdCount,
    incoherentDayCount: manifest.incoherentDayCount,
  };
}
