/**
 * THE ONE CONTRACT for what a stored CREATIVE-DAY row actually measured.
 *
 * ── The defect this exists to end ────────────────────────────────────────────
 * `meta_creative_daily.payload_json` carries `landing_page_views`,
 * `add_to_cart`, `initiate_checkout`, `outbound_clicks`, `thumbstop` and the
 * video quartiles as top-level scalars, and the `link_clicks` column beside it.
 * Every one of them is written as a finite number whether or not the provider
 * reported anything. The writer (`lib/meta/creatives-row-mappers.ts`):
 *
 *   - `parseAction` answers `parseFloat(value) || 0`, so `"12abc"` is 12, a
 *     malformed value is 0, and a missing `actions` array is 0;
 *   - `parseActionAny` returns the FIRST alias with a positive value and reads
 *     `omni_add_to_cart` / `omni_initiated_checkout` BEFORE the bare alias —
 *     and `lib/meta/funnel-stage-parse.ts` measured `omni_*` to be a genuinely
 *     wider population on exactly those two stages;
 *   - link clicks are `link_click` or `omni_link_click`, then `|| inline_link_clicks`,
 *     a different Graph field with its own definition;
 *   - `thumbstop` is `video_play_actions[0]` (video STARTS, whatever its
 *     `action_type`) over all impressions, and 0 when the array is absent.
 *
 * `lib/meta/creatives-service-support.ts` then re-emits every one of those keys
 * as a number (`?? 0`), the creative fold sums members that did and did not
 * report, and the warehouse fold keeps only the FIRST row's payload. So a
 * stored creative-day 0 is indistinguishable from "nothing was observed", and
 * the decision readers (`jobs/lifecycle-job.ts`, `jobs/calibration-job.ts`, the
 * creative-grain hydration in `data-source.ts`) wrapped all of it in
 * `COALESCE(..., 0)` on top. Reader changes alone cannot fix that: the stored
 * row has already thrown the distinction away.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────
 * The writer STAMPS, from the raw provider insight and before any fallback,
 * one reading per stage under `payload_json.metric_evidence`, using the SAME
 * alias table and the SAME strict value guard the ad grain uses
 * (`readMetaFunnelStageFromActions`, `parseMetaActionCountValue`). Every fold
 * (the ad-to-creative fold in `groupRows`, the same-creative-day fold in
 * `mergeMetaCreativeDailyRowsForUpsert`) merges the stamp strictly: a sum is a
 * measurement only when EVERY member measured the stage. The decision readers
 * read the stamp and nothing else. A row without a stamp — every row written
 * before this contract — is UNMEASURED until it is re-synced; it is never a
 * zero.
 *
 * The display fields are deliberately left alone. They are what the Creatives
 * surface shows today, with their own presence sidecar; the decision readers
 * simply stop reading them.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Stamped: `link_click`, `landing_page_view`, `add_to_cart`,
 * `initiate_checkout` (all from `actions[]`, one canonical alias each) and
 * `outbound_click` (from the separate `outbound_clicks` field).
 *
 * Deliberately NOT stamped: `thumbstop` and the video quartiles. There is no
 * verified provider contract for a three-second view on this path — the writer
 * divides video STARTS by impressions, and `lib/meta/warehouse.ts`
 * (`payloadVideoViews3s`) already records that starts are not a measured
 * three-second view. A decision reader must emit NULL for those rates rather
 * than invent a numerator or a denominator.
 */
import { parseMetaActionCountValue } from "@/lib/meta/action-count-parse";
import {
  META_FUNNEL_STAGE_CONTRACT_VERSION,
  readMetaFunnelStageFromActions,
  type MetaFunnelStageReading,
} from "@/lib/meta/funnel-stage-parse";

/**
 * Bumped when the stage list, the per-stage reading, the merge rule or the SQL
 * extraction change. V1 remains readable; V2 records the complete requested
 * actions-row zero convention and is never inferred for historical V1 rows.
 */
export const META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION =
  "meta-creative-day-metric-evidence.v2";
const META_CREATIVE_DAY_METRIC_EVIDENCE_LEGACY_VERSION =
  "meta-creative-day-metric-evidence.v1";

/** The key inside `meta_creative_daily.payload_json` (and on a creative row in memory). */
export const META_CREATIVE_DAY_METRIC_EVIDENCE_KEY = "metric_evidence";

export type MetaCreativeDayMetricStage =
  | "link_click"
  | "landing_page_view"
  | "add_to_cart"
  | "initiate_checkout"
  | "outbound_click";

export const META_CREATIVE_DAY_METRIC_STAGES: readonly MetaCreativeDayMetricStage[] = [
  "link_click",
  "landing_page_view",
  "add_to_cart",
  "initiate_checkout",
  "outbound_click",
];

/** The stages read out of `actions[]` through the shared funnel-stage table. */
const ACTION_STAGES = [
  "link_click",
  "landing_page_view",
  "add_to_cart",
  "initiate_checkout",
] as const satisfies readonly MetaCreativeDayMetricStage[];

/**
 * `merged_partial`: the row is a fold of several members and at least one of
 * them did not measure the stage, so the sum would be an understatement.
 * `evidence_absent`: at least one member carried no (or no valid) stamp at all.
 */
export type MetaCreativeDayIncompleteReason = "merged_partial" | "evidence_absent";

/**
 * `outbound_click` is not read out of `actions[]`, so its "the provider field
 * was absent" reason is named for the field it actually reads.
 */
export type MetaCreativeDayStageReading =
  | MetaFunnelStageReading
  | { state: "unmeasurable"; reason: "outbound_clicks_absent" }
  | { state: "incomplete"; reason: MetaCreativeDayIncompleteReason };

export interface MetaCreativeDayMetricEvidence {
  version: typeof META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION |
    typeof META_CREATIVE_DAY_METRIC_EVIDENCE_LEGACY_VERSION;
  /** The funnel alias/guard contract the action stages were read under. */
  funnelStageContractVersion: typeof META_FUNNEL_STAGE_CONTRACT_VERSION;
  stages: Record<MetaCreativeDayMetricStage, MetaCreativeDayStageReading>;
}

/** A creative row (raw or API) that may carry the stamp beside its display numbers. */
export interface MetaCreativeDayMetricEvidenceCarrier {
  [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]?: MetaCreativeDayMetricEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Writing the stamp
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `outbound_clicks` is its own Graph field (fetched by a separate "rich"
 * request whose page failures are swallowed), not an entry in `actions[]`.
 *
 * A non-array is unmeasurable: a failed rich page and an omitted field look the
 * same from here, and neither is a measured zero. Exactly one
 * `outbound_click` entry is the measurement; more than one is a shape the
 * provider has not shown us; an array without the entry is Meta's measured-zero
 * encoding. `omni_outbound_click` is never read — it is not the same population.
 */
function readOutboundClickStage(outboundClicks: unknown): MetaCreativeDayStageReading {
  if (!Array.isArray(outboundClicks)) {
    return { state: "unmeasurable", reason: "outbound_clicks_absent" };
  }
  const entries = outboundClicks.filter(
    (entry) =>
      isRecord(entry) && (entry as { action_type?: unknown }).action_type === "outbound_click",
  ) as { value?: unknown }[];
  if (entries.length === 0) return { state: "measured", value: 0 };
  if (entries.length > 1) return { state: "unreadable", reason: "duplicate_entries" };
  const parsed = parseMetaActionCountValue(entries[0]?.value);
  if (!parsed.ok) return { state: "unreadable", reason: "malformed_value" };
  return { state: "measured", value: parsed.value };
}

/**
 * The stamp for ONE provider insight row (one ad, one day). Computed from the
 * raw insight before any alias fallback or `inline_link_clicks` substitution
 * the display fields apply.
 */
export function buildMetaCreativeDayMetricEvidence(insight: {
  actions?: unknown;
  outbound_clicks?: unknown;
}, options: { completeActionsRequest?: boolean } = {}): MetaCreativeDayMetricEvidence {
  const stages = {} as Record<MetaCreativeDayMetricStage, MetaCreativeDayStageReading>;
  for (const stage of ACTION_STAGES) {
    stages[stage] = readMetaFunnelStageFromActions(
      insight.actions === undefined && options.completeActionsRequest === true
        ? [] : insight.actions,
      stage,
    );
  }
  stages.outbound_click = readOutboundClickStage(insight.outbound_clicks);
  return {
    version: META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION,
    funnelStageContractVersion: META_FUNNEL_STAGE_CONTRACT_VERSION,
    stages,
  };
}

/**
 * A stamp for a FIXTURE whose counts are already known: every stage named in
 * `counts` is measured, every other stage is unmeasurable. Throws on anything
 * that is not a non-negative safe integer, because a fixture that stamps a
 * value the writer could never produce proves nothing.
 */
export function buildMeasuredMetaCreativeDayMetricEvidence(
  counts: Partial<Record<MetaCreativeDayMetricStage, number>>,
): MetaCreativeDayMetricEvidence {
  const stages = {} as Record<MetaCreativeDayMetricStage, MetaCreativeDayStageReading>;
  for (const stage of META_CREATIVE_DAY_METRIC_STAGES) {
    const value = counts[stage];
    if (value === undefined) {
      stages[stage] =
        stage === "outbound_click"
          ? { state: "unmeasurable", reason: "outbound_clicks_absent" }
          : { state: "unmeasurable", reason: "actions_absent" };
      continue;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`meta_creative_day_metric_evidence_fixture_invalid:${stage}:${value}`);
    }
    stages[stage] = { state: "measured", value };
  }
  return {
    version: META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION,
    funnelStageContractVersion: META_FUNNEL_STAGE_CONTRACT_VERSION,
    stages,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading the stamp
 * ──────────────────────────────────────────────────────────────────────────── */

const UNMEASURABLE_REASONS = new Set(["actions_absent", "outbound_clicks_absent"]);
const UNREADABLE_REASONS = new Set(["duplicate_entries", "malformed_value"]);
const INCOMPLETE_REASONS = new Set(["merged_partial", "evidence_absent"]);

function parseStageReading(raw: unknown): MetaCreativeDayStageReading | null {
  if (!isRecord(raw)) return null;
  const { state, reason, value } = raw;
  if (state === "measured") {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? { state, value }
      : null;
  }
  if (typeof reason !== "string") return null;
  if (state === "unmeasurable" && UNMEASURABLE_REASONS.has(reason)) {
    return { state, reason } as MetaCreativeDayStageReading;
  }
  if (state === "unreadable" && UNREADABLE_REASONS.has(reason)) {
    return { state, reason } as MetaCreativeDayStageReading;
  }
  if (state === "incomplete" && INCOMPLETE_REASONS.has(reason)) {
    return { state, reason } as MetaCreativeDayStageReading;
  }
  return null;
}

/**
 * Parses the stamp VALUE itself (what sits under the key). `null` unless the
 * version is this one and every stage is a well-formed reading; a normalised
 * copy is returned, so a caller can never mutate a stored payload through it.
 */
export function parseMetaCreativeDayMetricEvidence(
  raw: unknown,
): MetaCreativeDayMetricEvidence | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION &&
      raw.version !== META_CREATIVE_DAY_METRIC_EVIDENCE_LEGACY_VERSION) return null;
  const funnelStageContractVersion = raw.funnelStageContractVersion;
  if (funnelStageContractVersion !== META_FUNNEL_STAGE_CONTRACT_VERSION) return null;
  if (!isRecord(raw.stages)) return null;
  const stages = {} as Record<MetaCreativeDayMetricStage, MetaCreativeDayStageReading>;
  for (const stage of META_CREATIVE_DAY_METRIC_STAGES) {
    const reading = parseStageReading(raw.stages[stage]);
    if (!reading) return null;
    stages[stage] = reading;
  }
  return {
    version: raw.version,
    funnelStageContractVersion,
    stages,
  };
}

/** Reads the stamp out of a stored payload (or a creative row carrying it). */
export function readMetaCreativeDayMetricEvidence(
  payloadJson: unknown,
): MetaCreativeDayMetricEvidence | null {
  if (!isRecord(payloadJson)) return null;
  return parseMetaCreativeDayMetricEvidence(payloadJson[META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]);
}

/**
 * The TypeScript twin of `buildMetaCreativeDayMetricEvidenceSql(...).valueSql`,
 * for a reader that already holds the stored payload. PER STAGE, exactly like
 * the SQL: the version must match, the stage must say `measured`, and its value
 * must be a non-negative safe integer. A malformed SIBLING stage does not make
 * this one unreadable (the SQL cannot see siblings either).
 *
 * One spelling difference is out of reach: PostgreSQL keeps a non-canonical
 * JSON number such as `5.0` as the text `5.0`, which the SQL pattern refuses,
 * while `JSON.parse` has already turned it into 5 by the time it reaches here.
 * The writer never emits such a spelling (`JSON.stringify(5)` is `5`).
 */
export function readMetaCreativeDayStageValue(
  payloadJson: unknown,
  stage: MetaCreativeDayMetricStage,
): number | null {
  if (!isRecord(payloadJson)) return null;
  const evidence = payloadJson[META_CREATIVE_DAY_METRIC_EVIDENCE_KEY];
  if (
    !isRecord(evidence) ||
    (evidence.version !== META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION &&
      evidence.version !== META_CREATIVE_DAY_METRIC_EVIDENCE_LEGACY_VERSION) ||
    evidence.funnelStageContractVersion !== META_FUNNEL_STAGE_CONTRACT_VERSION
  ) {
    return null;
  }
  const stages = evidence.stages;
  if (!isRecord(stages)) return null;
  const reading = stages[stage];
  if (!isRecord(reading) || reading.state !== "measured") return null;
  const value = reading.value;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Merging stamps (every fold of two rows into one)
 * ──────────────────────────────────────────────────────────────────────────── */

function everyStage(reading: MetaCreativeDayStageReading): MetaCreativeDayMetricEvidence {
  const stages = {} as Record<MetaCreativeDayMetricStage, MetaCreativeDayStageReading>;
  for (const stage of META_CREATIVE_DAY_METRIC_STAGES) stages[stage] = { ...reading };
  return {
    version: META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION,
    funnelStageContractVersion: META_FUNNEL_STAGE_CONTRACT_VERSION,
    stages,
  };
}

/**
 * STRICT. Per stage:
 *
 *   measured + measured      -> measured sum
 *   anything else            -> incomplete (merged_partial)
 *
 * and when either side carries no valid stamp at all, EVERY stage is
 * incomplete (evidence_absent): a member whose measurement is unknown makes
 * every sum over it an understatement. A stamp under another funnel contract
 * is unreadable by this version and therefore follows the same rule.
 *
 * `measured 0 + measured 0` stays a measured 0. `measured 0 + unmeasurable` is
 * NOT 0 — that is the fabrication this contract exists to refuse.
 */
export function mergeMetaCreativeDayMetricEvidence(
  a: unknown,
  b: unknown,
): MetaCreativeDayMetricEvidence {
  const left = parseMetaCreativeDayMetricEvidence(a);
  const right = parseMetaCreativeDayMetricEvidence(b);
  if (!left || !right) return everyStage({ state: "incomplete", reason: "evidence_absent" });
  const stages = {} as Record<MetaCreativeDayMetricStage, MetaCreativeDayStageReading>;
  for (const stage of META_CREATIVE_DAY_METRIC_STAGES) {
    const l = left.stages[stage];
    const r = right.stages[stage];
    if (l.state === "measured" && r.state === "measured") {
      const sum = l.value + r.value;
      stages[stage] = Number.isSafeInteger(sum)
        ? { state: "measured", value: sum }
        : { state: "unreadable", reason: "malformed_value" };
    } else {
      stages[stage] = { state: "incomplete", reason: "merged_partial" };
    }
  }
  return {
    version: META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION,
    funnelStageContractVersion: left.funnelStageContractVersion,
    stages,
  };
}

function carriedEvidenceValue(row: unknown): unknown {
  return isRecord(row) ? row[META_CREATIVE_DAY_METRIC_EVIDENCE_KEY] : undefined;
}

/**
 * The stamp for a row that folds `rows` together, or `null` when NO member
 * carries a stamp (nothing is then said, and a reader treats the row as
 * unmeasured exactly as it would an unstamped legacy row). One member stamped
 * and another not is NOT "say nothing": the fold is stamped incomplete.
 */
export function mergeCarriedMetaCreativeDayMetricEvidence(
  rows: readonly unknown[],
): MetaCreativeDayMetricEvidence | null {
  const carried = rows.map(carriedEvidenceValue);
  if (carried.every((value) => value === undefined || value === null)) return null;
  if (carried.length === 1) return parseMetaCreativeDayMetricEvidence(carried[0]);
  let merged: unknown = carried[0];
  for (let index = 1; index < carried.length; index += 1) {
    merged = mergeMetaCreativeDayMetricEvidence(merged, carried[index]);
  }
  return merged as MetaCreativeDayMetricEvidence;
}

/**
 * The same-creative-day fold in `mergeMetaCreativeDailyRowsForUpsert` keeps the
 * first row's payload for every OTHER key; this replaces only the stamp with
 * the strict merge of both sides. Neither side stamped leaves the payload
 * exactly as it was. The input objects are never mutated.
 */
export function mergeMetaCreativeDayPayloadMetricEvidence(input: {
  basePayload: unknown;
  left: unknown;
  right: unknown;
}): unknown {
  const leftEvidence = carriedEvidenceValue(input.left);
  const rightEvidence = carriedEvidenceValue(input.right);
  const leftAbsent = leftEvidence === undefined || leftEvidence === null;
  const rightAbsent = rightEvidence === undefined || rightEvidence === null;
  if (leftAbsent && rightAbsent) return input.basePayload;
  const merged = mergeMetaCreativeDayMetricEvidence(leftEvidence, rightEvidence);
  return isRecord(input.basePayload)
    ? { ...input.basePayload, [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: merged }
    : { [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: merged };
}

/** Returns `row` carrying `evidence`, or `row` untouched when there is none. */
export function withMetaCreativeDayMetricEvidence<T extends object>(
  row: T,
  evidence: MetaCreativeDayMetricEvidence | null,
): T & MetaCreativeDayMetricEvidenceCarrier {
  if (!evidence) return row as T & MetaCreativeDayMetricEvidenceCarrier;
  return { ...row, [META_CREATIVE_DAY_METRIC_EVIDENCE_KEY]: evidence } as T &
    MetaCreativeDayMetricEvidenceCarrier;
}

/* ────────────────────────────────────────────────────────────────────────────
 * SQL extraction
 *
 * The decision readers aggregate in SQL, so the stamp is read by SQL emitted
 * from here, never by a hand-written JSON path in a reader.
 * ──────────────────────────────────────────────────────────────────────────── */

/** `Number.MAX_SAFE_INTEGER`, the same bound `parseMetaActionCountValue` applies. */
const SQL_MAX_SAFE_INTEGER = "9007199254740991";
const SQL_PAYLOAD_EXPRESSION = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;
const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertStage(stage: string): asserts stage is MetaCreativeDayMetricStage {
  if (!(META_CREATIVE_DAY_METRIC_STAGES as readonly string[]).includes(stage)) {
    throw new Error(`meta_creative_day_metric_evidence_sql_stage_unknown:${stage}`);
  }
}

export interface MetaCreativeDayMetricEvidenceSql {
  /** `double precision` count, or NULL unless the stage is a valid measurement. */
  valueSql(stage: MetaCreativeDayMetricStage): string;
  /** TRUE when `valueSql` would be NULL. Never NULL itself. */
  missingSql(stage: MetaCreativeDayMetricStage): string;
}

/**
 * Per-row extraction of one stage from a stored payload.
 *
 * Every test in the outer arm is a null-safe comparison that cannot raise:
 * `->` and `->>` on a JSON scalar, array or null return SQL NULL rather than
 * erroring, and `IS NOT DISTINCT FROM` turns that NULL into FALSE. The digit
 * pattern and the numeric bound are NESTED CASEs, not further `AND` operands,
 * because PostgreSQL may reorder an `AND`, and a cast attempted on text the
 * pattern would have refused raises instead of reporting NULL. A stamp written
 * by any other version is NULL — never interpreted.
 */
export function buildMetaCreativeDayMetricEvidenceSql(options: {
  payloadExpression: string;
}): MetaCreativeDayMetricEvidenceSql {
  const { payloadExpression } = options;
  if (!SQL_PAYLOAD_EXPRESSION.test(payloadExpression)) {
    throw new Error(
      `meta_creative_day_metric_evidence_sql_payload_expression_invalid:${payloadExpression}`,
    );
  }
  const evidence = `${payloadExpression}->'${META_CREATIVE_DAY_METRIC_EVIDENCE_KEY}'`;
  const valueSql = (stage: MetaCreativeDayMetricStage) => {
    assertStage(stage);
    const reading = `${evidence}->'stages'->'${stage}'`;
    const valueText = `(${reading}->>'value')`;
    return `(CASE
      WHEN (${evidence}->>'version') IN ('${META_CREATIVE_DAY_METRIC_EVIDENCE_VERSION}', '${META_CREATIVE_DAY_METRIC_EVIDENCE_LEGACY_VERSION}')
        AND (${evidence}->>'funnelStageContractVersion') IS NOT DISTINCT FROM '${META_FUNNEL_STAGE_CONTRACT_VERSION}'
        AND (${reading}->>'state') IS NOT DISTINCT FROM 'measured'
        AND jsonb_typeof(${reading}->'value') IS NOT DISTINCT FROM 'number'
      THEN CASE
        WHEN ${valueText} ~ '^[0-9]+$' THEN CASE
          WHEN ${valueText}::numeric <= ${SQL_MAX_SAFE_INTEGER}
          THEN ${valueText}::double precision
        END
      END
    END)`;
  };
  return {
    valueSql,
    missingSql: (stage) => `(${valueSql(stage)} IS NULL)`,
  };
}

/**
 * The creative-day activity predicate for the window rule
 * (`buildMetaCompleteWindowSql`): the row delivered, spent, was clicked,
 * converted or earned revenue, so an unmeasured stage on it is a GAP, not a
 * legitimately empty day. These five columns are `NOT NULL DEFAULT 0` on
 * `meta_creative_daily`; each is coalesced anyway so the predicate can never be
 * NULL.
 */
export function creativeDayDecisionBearingActivitySql(alias: string): string {
  if (!SQL_IDENTIFIER.test(alias)) {
    throw new Error(`meta_creative_day_activity_sql_alias_invalid:${alias}`);
  }
  return `(COALESCE(${alias}.impressions, 0) > 0
      OR COALESCE(${alias}.spend, 0) > 0
      OR COALESCE(${alias}.clicks, 0) > 0
      OR COALESCE(${alias}.conversions, 0) > 0
      OR COALESCE(${alias}.revenue, 0) > 0)`;
}

/** The TypeScript twin of `creativeDayDecisionBearingActivitySql`. */
export function isCreativeDayDecisionBearingActivity(row: {
  impressions?: number | null;
  spend?: number | null;
  clicks?: number | null;
  conversions?: number | null;
  revenue?: number | null;
}): boolean {
  return [row.impressions, row.spend, row.clicks, row.conversions, row.revenue].some(
    (value) => typeof value === "number" && value > 0,
  );
}

export interface MetaCreativeDayMetricEvidenceLateralSql {
  /** `CROSS JOIN LATERAL (...) alias` — insert into the FROM list after the row alias. */
  readonly lateralSql: string;
  /** The stage's per-row value column (double precision, NULL when missing). */
  valueSql(stage: MetaCreativeDayMetricStage): string;
  /** TRUE when the stage's value column is NULL. Never NULL itself. */
  missingSql(stage: MetaCreativeDayMetricStage): string;
  /** The row's decision-bearing activity (never NULL). */
  readonly activitySql: string;
}

/**
 * The same extraction, evaluated ONCE per row.
 *
 * A window reader needs each stage twice (the sum and the completeness test)
 * and `payload_json` is a multi-kilobyte, usually TOASTed document: every JSON
 * operator on the column detoasts it again, and PostgreSQL does not share
 * common subexpressions. The inner `OFFSET 0` fences a one-key copy of the
 * stamp so the large payload is detoasted once; the outer fence evaluates the
 * five stage values once, and the reader aggregates plain columns. The values
 * are exactly `buildMetaCreativeDayMetricEvidenceSql(...).valueSql`, and
 * `missingSql` is exactly its definition (`value IS NULL`).
 */
export function buildMetaCreativeDayMetricEvidenceLateralSql(options: {
  /** The stored payload column, e.g. `d.payload_json`. */
  payloadExpression: string;
  /** The `meta_creative_daily` row alias the activity predicate reads, e.g. `d`. */
  rowAlias: string;
  /** The alias given to the emitted lateral, e.g. `creative_day_evidence`. */
  lateralAlias: string;
}): MetaCreativeDayMetricEvidenceLateralSql {
  const { payloadExpression, rowAlias, lateralAlias } = options;
  if (!SQL_PAYLOAD_EXPRESSION.test(payloadExpression)) {
    throw new Error(
      `meta_creative_day_metric_evidence_sql_payload_expression_invalid:${payloadExpression}`,
    );
  }
  if (!SQL_IDENTIFIER.test(lateralAlias)) {
    throw new Error(`meta_creative_day_metric_evidence_sql_alias_invalid:${lateralAlias}`);
  }
  const sourceAlias = `${lateralAlias}_stamp`;
  const inner = buildMetaCreativeDayMetricEvidenceSql({
    payloadExpression: `${sourceAlias}.payload`,
  });
  const projections = META_CREATIVE_DAY_METRIC_STAGES.map(
    (stage) => `    ${inner.valueSql(stage)} AS ${stage}`,
  ).join(",\n");
  const lateralSql = `CROSS JOIN LATERAL (
  SELECT
${projections},
    ${creativeDayDecisionBearingActivitySql(rowAlias)} AS decision_bearing_activity
  FROM (
    SELECT jsonb_build_object(
      '${META_CREATIVE_DAY_METRIC_EVIDENCE_KEY}',
      ${payloadExpression}->'${META_CREATIVE_DAY_METRIC_EVIDENCE_KEY}'
    ) AS payload
    OFFSET 0
  ) ${sourceAlias}
  OFFSET 0
) ${lateralAlias}`;
  return {
    lateralSql,
    valueSql: (stage) => {
      assertStage(stage);
      return `${lateralAlias}.${stage}`;
    },
    missingSql: (stage) => {
      assertStage(stage);
      return `(${lateralAlias}.${stage} IS NULL)`;
    },
    activitySql: `${lateralAlias}.decision_bearing_activity`,
  };
}
