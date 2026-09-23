/**
 * THE ONE CONTRACT for reading a Meta funnel stage out of a stored AD-DAY.
 *
 * ── The defect this exists to end ────────────────────────────────────────────
 * The ad-grain readers ask the stored insight row for a funnel stage by
 * reaching for a TOP-LEVEL key on `meta_ad_daily.payload_json`:
 *
 *     payload_json->>'landing_page_views'
 *     payload_json->>'add_to_cart'
 *     payload_json->>'initiate_checkout'
 *
 * No such top-level key has ever existed ON THAT TABLE. `lib/api/meta.ts`
 * requests the Graph field `actions` and stores the insight row verbatim, so
 * the measurement lives inside `payload_json->'actions'` as
 * `{"action_type":"landing_page_view","value":"42"}`. Measured read-only on
 * production 2026-09-21 over the 25 Aug – 20 Sep window (12 accounts, 10,733
 * spending ad-days): `landing_page_view` is positive in the raw on 6,025 rows,
 * `add_to_cart` on 2,455, `initiate_checkout` on 1,310 — and in EVERY one of
 * them the top-level key the readers ask for is absent.
 *
 * ── The grain this does NOT cover, and why ──────────────────────────────────
 * `meta_creative_daily.payload_json` is a DIFFERENT, already-flattened shape
 * that genuinely carries `landing_page_views`, `add_to_cart`,
 * `initiate_checkout`, `thumbstop`, `view_content`, `leads`, `outbound_clicks`
 * and the video quartiles as real top-level scalars. Measured over the same 90
 * days: 33,017 of 33,017 rows carry `landing_page_views`, 20,074 of them
 * positive, totalling 782,584. "The top-level key does not exist" is a
 * statement about `meta_ad_daily` only.
 *
 * CORRECTED 2026-09-22: key PRESENCE on the creative grain is not evidence of
 * MEASUREMENT. The creative-day writer (`lib/meta/creatives-row-mappers.ts`)
 * wrote every one of those keys as a finite number whether or not anything was
 * observed (`parseFloat(value) || 0`, omni-first alias fallbacks,
 * `linkClicks || inline_link_clicks`), so the 33,017-of-33,017 census measured
 * the writer, not the provider. The creative grain now reads measurements only
 * from the stamped per-stage evidence in
 * `lib/meta/creative-day-metric-evidence.ts`, which applies THIS module's alias
 * table and value guard at write time.
 *
 * ── What the ad-grain readers do with the miss ──────────────────────────────
 * `lib/meta/calibration.ts` wraps it in `COALESCE(..., 0)`, which converts "this
 * reader asked the wrong question" into a confident measured zero. That is the
 * fabrication this module refuses, and it is the same fabrication
 * `lib/meta/link-click-parse.ts` was written to undo one column over. The
 * native readers (`jobs/ad-calibration-job.ts`,
 * `HYDRATE_AD_DECISION_INPUTS_QUERY`) do NOT coalesce — their null-handling is
 * already honest — but they read the same absent key, so every ad-grain funnel
 * rate is unconditionally null. The production symptom is the decision reason
 * "funnel sample is insufficient (not enough upper/mid-funnel denominators for
 * quality scoring)", carried on 731 ad decisions on 2026-09-21.
 *
 * ── Why one module and not three fixes ──────────────────────────────────────
 * `link-click-parse.ts` records what happens when two paths each hold their own
 * idea of a measurement: the same provider payload was admitted by one and
 * refused by the other, and "is this column measured?" stopped having an
 * answer. Three ad-grain readers with three hand-written JSON expressions is
 * that failure waiting in three places. So the stage list, the alias choice,
 * the strict value guard and the SQL that extracts it all live here, and every
 * reader derives its SQL from `buildMetaFunnelStageSql` rather than writing its
 * own.
 *
 * ── Aliases: chosen per stage, never summed ─────────────────────────────────
 * Meta reports the same event under several `action_type` spellings. They are
 * NOT independent events and summing them multiplies the count. Measured
 * read-only on production 2026-09-21, per ad-day, over the trailing 90 days:
 *
 *   stage               bare vs pixel alias   bare vs a wider alias
 *   landing_page_view   (no pixel alias)      0 of 23,485 differ (omni)
 *   add_to_cart         0 differ              281 differ (omni)
 *   initiate_checkout   0 differ              144 differ (omni)
 *   view_content        0 differ              1,670 differ (omni)
 *   post_engagement     (no pixel alias)      2,346 differ (page_engagement)
 *   lead                (no pixel alias)      3,827 of 3,939 differ (lead_grouped)
 *   purchase            0 differ              0 differ (omni)
 *
 * The bare alias and the `offsite_conversion.fb_pixel_*` alias are the same
 * number on every row observed; `omni_*` is a genuinely wider population
 * (it folds in app and offline surfaces) and provably diverges on add-to-cart
 * and initiate-checkout.
 *
 * THE TRAP THIS TABLE EXISTS TO DOCUMENT: `purchase` and `landing_page_view`
 * show ZERO divergence between bare and omni. `purchase` is also the one stage
 * the pipeline already reads correctly. An alias rule validated on either of
 * them would conclude that `omni_*` is interchangeable and would then be
 * silently wrong on add-to-cart and initiate-checkout. The alias for each stage
 * is therefore proven for THAT stage and generalised from none of the others.
 *
 * We take the bare alias. It is the web-pixel-attributed event, which is the
 * same attribution surface D091 makes the commercial basis (Meta-attributed
 * purchase revenue over Meta-attributed purchase count). Mixing an omni figure
 * into a ladder whose denominator is pixel-attributed would compare two
 * different populations.
 *
 * ── Measured zero is a measurement; absence is not ──────────────────────────
 * Meta omits an `action_type` entirely when it did not occur, and it also
 * sometimes emits an explicit `"0"` (164 such entries in the sampled window).
 * Both mean the same thing: the stage was observed and it happened zero times.
 * An ad-day whose payload carries NO `actions` array at all is a different
 * statement — nothing about the funnel was observed — and it must never become
 * a zero. `MetaFunnelStageReading` keeps those apart, and every consumer is
 * expected to branch on `state` rather than on a number.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Stages here are the ones carried in `actions[]`. Deliberately NOT here:
 *   - `thumbstop`, `video25/50/75/100` — these are not action entries; they
 *     need a real provider field and denominator, which is a separate change.
 *   - `outbound_click` — measured across the trailing 90 days: the alias does
 *     not appear in a single stored `actions` array. That reader has nothing to
 *     read, which is an absent provider field, not a wrong key.
 */
import { parseMetaActionCountValue } from "@/lib/meta/action-count-parse";

/**
 * Bumped when the stage list, an alias choice, or the extraction semantics
 * change. Carried in the native ad evaluation envelope (`metricContract`) and in
 * the creative-day evidence stamp, so a stored funnel figure can be attributed
 * to the rule that produced it.
 *
 * Amended IN PLACE on 2026-09-22, before this version was ever released or
 * persisted: the SQL ladder gained the string-type guard its TypeScript twin
 * already applied, and the window rule below was added. No stored row carries
 * v1 yet (it was referenced only by tests until this change), which is the
 * condition under which an unshipped version may be amended rather than minted.
 */
export const META_FUNNEL_STAGE_CONTRACT_VERSION = "meta-funnel-stage.v1";

export type MetaFunnelStageId =
  | "landing_page_view"
  | "add_to_cart"
  | "initiate_checkout"
  | "view_content"
  | "post_engagement"
  | "lead"
  | "link_click";

export interface MetaFunnelStageDefinition {
  readonly id: MetaFunnelStageId;
  /** The single `action_type` this stage reads. Never more than one. */
  readonly canonicalAlias: string;
  /**
   * Aliases measured to carry an IDENTICAL value on every observed ad-day.
   * Recorded so a drift test can re-check the claim. They are never read as a
   * fallback and never added to the canonical value.
   */
  readonly provenEquivalentAliases: readonly string[];
  /**
   * Aliases measured to carry a DIFFERENT value. Listed so that substituting
   * or summing one is a visible contract change rather than a quiet edit.
   */
  readonly provenDivergentAliases: readonly string[];
}

export const META_FUNNEL_STAGES: readonly MetaFunnelStageDefinition[] = [
  {
    id: "landing_page_view",
    canonicalAlias: "landing_page_view",
    provenEquivalentAliases: ["omni_landing_page_view"],
    provenDivergentAliases: [],
  },
  {
    id: "add_to_cart",
    canonicalAlias: "add_to_cart",
    provenEquivalentAliases: ["offsite_conversion.fb_pixel_add_to_cart"],
    provenDivergentAliases: ["omni_add_to_cart"],
  },
  {
    id: "initiate_checkout",
    canonicalAlias: "initiate_checkout",
    provenEquivalentAliases: ["offsite_conversion.fb_pixel_initiate_checkout"],
    provenDivergentAliases: ["omni_initiated_checkout"],
  },
  {
    id: "view_content",
    canonicalAlias: "view_content",
    provenEquivalentAliases: ["offsite_conversion.fb_pixel_view_content"],
    provenDivergentAliases: ["omni_view_content"],
  },
  {
    /*
      `page_engagement` is a DIFFERENT event, not a spelling of this one: it
      differed on 2,346 of 32,363 ad-days. It is listed as divergent so that
      reaching for it is a visible contract change.
    */
    id: "post_engagement",
    canonicalAlias: "post_engagement",
    provenEquivalentAliases: [],
    provenDivergentAliases: ["page_engagement"],
  },
  {
    /*
      `onsite_conversion.lead_grouped` differed on 3,827 of 3,939 ad-days — the
      widest divergence measured anywhere in this table. The reader asks for
      leads; it gets the lead event, not the grouped onsite one.
    */
    id: "lead",
    canonicalAlias: "lead",
    provenEquivalentAliases: [],
    provenDivergentAliases: ["onsite_conversion.lead_grouped"],
  },
  {
    id: "link_click",
    canonicalAlias: "link_click",
    provenEquivalentAliases: [],
    provenDivergentAliases: ["outbound_click"],
  },
] as const;

export function metaFunnelStage(id: MetaFunnelStageId): MetaFunnelStageDefinition {
  const stage = META_FUNNEL_STAGES.find((candidate) => candidate.id === id);
  if (!stage) throw new Error(`meta_funnel_stage_unknown:${id}`);
  return stage;
}

/** Why a stage produced no usable count. */
export type MetaFunnelStageUnmeasurableReason = "actions_absent";
export type MetaFunnelStageUnreadableReason =
  | "duplicate_entries"
  | "malformed_value";

/**
 * The three distinguishable outcomes. `measured` carries a real count and may
 * legitimately be 0; the other two are NOT zero and must not be summed as one.
 */
export type MetaFunnelStageReading =
  | { state: "measured"; value: number }
  | { state: "unmeasurable"; reason: MetaFunnelStageUnmeasurableReason }
  | { state: "unreadable"; reason: MetaFunnelStageUnreadableReason };

/**
 * Reads ONE stage out of a stored `actions` array.
 *
 * A non-array (missing key, null, object, scalar) is `unmeasurable`: the row
 * never carried the observation. An array that simply has no entry for this
 * stage IS a measurement — Meta omits action types that did not occur — so it
 * returns `measured` 0.
 */
export function readMetaFunnelStageFromActions(
  actions: unknown,
  stageId: MetaFunnelStageId,
): MetaFunnelStageReading {
  if (!Array.isArray(actions)) {
    return { state: "unmeasurable", reason: "actions_absent" };
  }
  const stage = metaFunnelStage(stageId);
  const entries = actions.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { action_type?: unknown }).action_type === stage.canonicalAlias,
  ) as { value?: unknown }[];

  if (entries.length === 0) return { state: "measured", value: 0 };
  if (entries.length > 1) {
    return { state: "unreadable", reason: "duplicate_entries" };
  }
  const parsed = parseMetaActionCountValue(entries[0]?.value);
  if (!parsed.ok) return { state: "unreadable", reason: "malformed_value" };
  return { state: "measured", value: parsed.value };
}

/**
 * Reads a whole stored ad-day payload rather than a bare array, so callers do
 * not each re-derive "where do the actions live".
 */
export function readMetaFunnelStageFromPayload(
  payloadJson: unknown,
  stageId: MetaFunnelStageId,
): MetaFunnelStageReading {
  const actions =
    typeof payloadJson === "object" && payloadJson !== null
      ? (payloadJson as { actions?: unknown }).actions
      : undefined;
  return readMetaFunnelStageFromActions(actions, stageId);
}

/* ────────────────────────────────────────────────────────────────────────────
 * SQL extraction
 *
 * The four production readers aggregate in SQL, so a TypeScript parser alone
 * would leave them free to keep their own JSON expressions — and the alias
 * choice above would hold in one place and not the other. These builders emit
 * the SQL FROM THE SAME `META_FUNNEL_STAGES` table, so "which alias does this
 * stage read?" has one answer in both languages by construction.
 *
 * Shape: ONE lateral that expands `actions` once and pivots every stage out of
 * that single expansion. Measured read-only on production 2026-09-21 over the
 * trailing 90 days (40,692 ad-days): the single-pass lateral extracted all four
 * stages in 620 ms, while ONE stage via `jsonb_path_query_array` took 1,627 ms.
 * Per-stage path queries would re-parse the same jsonb once per stage; given
 * the native decision reads already sit against a 30 s statement timeout, the
 * cheaper shape is the safe one.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `Number.MAX_SAFE_INTEGER`, spelled out so the SQL bound and
 * `Number.isSafeInteger` in `parseMetaActionCountValue` refuse the same values.
 */
const SQL_MAX_SAFE_INTEGER = "9007199254740991";

/** The regex twin of `/^\d+$/`. Kept adjacent so a change to one is visibly a change to both. */
const SQL_COUNT_PATTERN = "'^[0-9]+$'";

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const SQL_PAYLOAD_EXPRESSION = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

export interface MetaFunnelStageSqlOptions {
  /** A column reference holding the stored insight row, e.g. `d.payload_json`. */
  readonly payloadExpression: string;
  /** Alias to give the emitted lateral, e.g. `funnel_actions`. */
  readonly lateralAlias: string;
  /** Defaults to every stage. */
  readonly stages?: readonly MetaFunnelStageId[];
}

export interface MetaFunnelStageSql {
  /** The `LEFT JOIN LATERAL (...) alias ON ...` clause. Insert into the FROM list. */
  readonly lateralSql: string;
  /** `double precision` count, or NULL when not `measured`. */
  valueSql(stageId: MetaFunnelStageId): string;
  /** `'measured' | 'unmeasurable' | 'unreadable'`. */
  stateSql(stageId: MetaFunnelStageId): string;
  /** TRUE only when the stage is `measured`; for use in `FILTER (WHERE ...)`. */
  measuredSql(stageId: MetaFunnelStageId): string;
  /**
   * TRUE when the row did NOT measure the stage (unmeasurable or unreadable).
   * Never NULL, so it is safe inside `FILTER (WHERE ...)` and under `NOT`.
   * This is the per-row input `buildMetaCompleteWindowSql` needs.
   */
  missingSql(stageId: MetaFunnelStageId): string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE WINDOW RULE: a sum over days is a measurement only when every
 * decision-bearing day in it was measured.
 *
 * The per-day ladder above keeps "measured zero" and "not measured" apart. A
 * reader that then aggregates with `SUM(value) FILTER (WHERE measured)` throws
 * that distinction away again: three measured days plus eleven delivered days
 * the provider never reported return a positive number that looks exactly like
 * complete coverage, and a measured 0 plus a missing day returns a confident 0.
 * That is the same fabrication as `COALESCE(x, 0)`, one level up.
 *
 * So every window reader takes its sum from here:
 *
 *   zero + missing   -> NULL   (the window is incomplete)
 *   zero + zero      -> 0      (a measured zero stays a measured zero)
 *   value + missing  -> NULL   (a partial sum is not a measurement)
 *   no rows at all   -> NULL   (nothing was observed)
 *
 * A day that did nothing at all (no delivery, no clicks, no conversions, no
 * revenue) is not a gap: it legitimately has no events, so it may be missing
 * without making the window incomplete. What counts as "did something" is the
 * CALLER's activity predicate, because it depends on the grain's columns; an
 * activity predicate that evaluates to NULL is treated as ACTIVE, so an
 * unreadable activity column can only make a window incomplete, never complete.
 *
 * `rowFilterSql` restricts both the sum and the completeness test to one window
 * inside a larger scan (a 14-day band inside 28 days, the last 28 of 90), so the
 * two can never describe different populations.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Names the window rule. Persisted beside anything aggregated under it, so a
 * stored window sum can be attributed to the rule that produced it.
 */
export const META_METRIC_WINDOW_COMPLETENESS_RULE = "meta-metric-window.complete-or-null.v1";

export interface MetaCompleteWindowSqlInput {
  /** Per-row value; NULL when the row did not measure it. */
  readonly valueSql: string;
  /** Per-row boolean, TRUE when the row did not measure it. Must never be NULL. */
  readonly missingSql: string;
  /** Per-row boolean: the row did something a window must account for. */
  readonly activitySql: string;
  /** Optional per-row window membership; defaults to every row of the group. */
  readonly rowFilterSql?: string;
}

export interface MetaCompleteWindowSql {
  /** The window sum, or NULL unless every decision-bearing row was measured. */
  readonly sumSql: string;
  /** How many decision-bearing rows in the window were not measured. */
  readonly missingDeliveredRowsSql: string;
}

export function buildMetaCompleteWindowSql(
  input: MetaCompleteWindowSqlInput,
): MetaCompleteWindowSql {
  const inWindow = input.rowFilterSql ? `COALESCE((${input.rowFilterSql}), FALSE)` : "TRUE";
  const missingDelivered = `${inWindow} AND (${input.missingSql}) AND COALESCE((${input.activitySql}), TRUE)`;
  return {
    sumSql: `(CASE
      WHEN COUNT(*) FILTER (WHERE ${missingDelivered}) = 0
      THEN SUM(${input.valueSql}) FILTER (WHERE ${inWindow})
    END)`,
    missingDeliveredRowsSql: `(COUNT(*) FILTER (WHERE ${missingDelivered}))::integer`,
  };
}

/**
 * The TypeScript twin of the window rule, for readers that aggregate in memory.
 * `null` in `values` means the row did not measure the metric; `active` says
 * whether that row had to.
 */
export function resolveMetaCompleteWindowSum(
  rows: readonly { value: number | null; active: boolean | null }[],
): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  let measuredAny = false;
  for (const row of rows) {
    if (row.value === null || !Number.isFinite(row.value)) {
      if (row.active !== false) return null;
      continue;
    }
    total += row.value;
    measuredAny = true;
  }
  return measuredAny ? total : null;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Builds the extraction SQL for a set of stages.
 *
 * `payloadExpression` and `lateralAlias` are restricted to plain identifiers:
 * they are always compile-time constants at the call sites, and the restriction
 * keeps that true.
 */
export function buildMetaFunnelStageSql(
  options: MetaFunnelStageSqlOptions,
): MetaFunnelStageSql {
  const { payloadExpression, lateralAlias } = options;
  if (!SQL_PAYLOAD_EXPRESSION.test(payloadExpression)) {
    throw new Error(`meta_funnel_stage_sql_payload_expression_invalid:${payloadExpression}`);
  }
  if (!SQL_IDENTIFIER.test(lateralAlias)) {
    throw new Error(`meta_funnel_stage_sql_alias_invalid:${lateralAlias}`);
  }
  const stages = (options.stages ?? META_FUNNEL_STAGES.map((stage) => stage.id)).map(
    metaFunnelStage,
  );
  if (stages.length === 0) throw new Error("meta_funnel_stage_sql_no_stages");

  const actionsExpression = `${payloadExpression}->'actions'`;
  /*
    `payload_json->'actions'` is SQL NULL when the key is absent, and
    `jsonb_typeof(NULL)` is NULL — so `jsonb_typeof(...) = 'array'` is NULL, not
    FALSE, and `NOT (...)` is NULL rather than TRUE. A plain negation therefore
    FAILS to fire the unmeasurable arm and the row falls through to the
    measured-zero arm: precisely the fabrication this module exists to refuse.
    Caught by running the emitted SQL against production read-only, where 6,270
    ad-days with no `actions` key reported as measured zeros.

    `IS DISTINCT FROM` is null-safe in both directions, so the two arms are
    exhaustive and neither can inherit a NULL.
  */
  const isArray = `jsonb_typeof(${actionsExpression}) IS NOT DISTINCT FROM 'array'`;
  const isNotArray = `jsonb_typeof(${actionsExpression}) IS DISTINCT FROM 'array'`;
  const entryCount = (stage: MetaFunnelStageDefinition) =>
    `${lateralAlias}.${stage.id}_entry_count`;
  const rawValue = (stage: MetaFunnelStageDefinition) =>
    `${lateralAlias}.${stage.id}_raw_value`;
  const rawType = (stage: MetaFunnelStageDefinition) =>
    `${lateralAlias}.${stage.id}_raw_type`;

  const projections = stages
    .flatMap((stage) => {
      const match = `entry->>'action_type' = ${quoteLiteral(stage.canonicalAlias)}`;
      return [
        `    count(*) FILTER (WHERE ${match}) AS ${stage.id}_entry_count`,
        `    max(entry->>'value') FILTER (WHERE ${match}) AS ${stage.id}_raw_value`,
        /*
          The JSON TYPE of the value, beside its text. `->>` stringifies a JSON
          number, so `{"value": 42}` would otherwise read as the digit string
          '42' and pass the regex, while the TypeScript guard refuses anything
          that is not a string. One contract, one answer: a non-string value is
          unreadable in both languages. Measured 2026-09-22 on production over
          120 days: zero non-string values, so this closes a parity gap rather
          than changing a live reading.
        */
        `    max(jsonb_typeof(entry->'value')) FILTER (WHERE ${match}) AS ${stage.id}_raw_type`,
      ];
    })
    .join(",\n");

  /*
    The set-returning function must never SEE a non-array.

    `jsonb_array_elements` raises `cannot extract elements from an object` (or
    `...from a scalar`) rather than returning zero rows, and a `LEFT JOIN
    LATERAL ... ON <test>` does not promise the planner evaluates that test
    first. Relying on the ON clause to keep a malformed payload away from the
    function makes the contract's "unmeasurable" outcome depend on a chosen
    plan. Feeding `'[]'::jsonb` for anything that is not an array makes the
    lateral TOTAL — the same guard
    `AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL` already uses in
    `lib/creative-decision-engine/data-source.ts`.

    The ON clause is kept as well: it skips the work for non-array rows, and
    the state ladder decides `unmeasurable` from the payload itself, so the
    two agree no matter which one the planner applies.
  */
  const arrayOnlyExpression = `CASE
      WHEN jsonb_typeof(${actionsExpression}) = 'array' THEN ${actionsExpression}
      ELSE '[]'::jsonb
    END`;

  const lateralSql = `LEFT JOIN LATERAL (
  SELECT
${projections}
  FROM jsonb_array_elements(${arrayOnlyExpression}) AS entry
) ${lateralAlias} ON ${isArray}`;

  /**
   * The ladder, in the order the TypeScript reader applies it:
   *   not an array            -> the row never carried the observation
   *   no entry for this stage -> Meta omits action types that did not occur
   *   more than one entry     -> a shape the provider has not shown us
   *   digits within range     -> the measurement
   *   anything else           -> malformed, and never a zero
   *
   * The range test is a NESTED CASE, not a second `AND` operand beside the
   * regex. PostgreSQL may reorder the operands of an `AND`, so
   * `raw ~ '^[0-9]+$' AND raw::numeric <= ...` can attempt the cast on a value
   * the regex would have rejected and raise `invalid input syntax for type
   * numeric` instead of reporting `unreadable`. Nesting makes the ordering part
   * of the expression rather than a hope about the planner.
   *
   * Leading zeros are deliberately accepted on both sides and mean the same
   * thing: TypeScript takes `/^\d+$/` then `Number.parseInt`, so "0000123" is
   * 123; `numeric` reads the same digits as 123. A digit string too long to be
   * an exact double fails `Number.isSafeInteger` in TypeScript and exceeds the
   * bound here, so both call it unreadable.
   */
  const ladder = (
    stage: MetaFunnelStageDefinition,
    onUnmeasurable: string,
    onMeasuredZero: string,
    onDuplicate: string,
    onValue: string,
    onMalformed: string,
  ) => `CASE
    WHEN ${isNotArray} THEN ${onUnmeasurable}
    WHEN COALESCE(${entryCount(stage)}, 0) = 0 THEN ${onMeasuredZero}
    WHEN ${entryCount(stage)} > 1 THEN ${onDuplicate}
    WHEN ${rawType(stage)} IS DISTINCT FROM 'string' THEN ${onMalformed}
    WHEN ${rawValue(stage)} ~ ${SQL_COUNT_PATTERN} THEN
      CASE
        WHEN (${rawValue(stage)})::numeric <= ${SQL_MAX_SAFE_INTEGER} THEN ${onValue}
        ELSE ${onMalformed}
      END
    ELSE ${onMalformed}
  END`;

  const resolve = (stageId: MetaFunnelStageId) => {
    const stage = stages.find((candidate) => candidate.id === stageId);
    if (!stage) throw new Error(`meta_funnel_stage_sql_stage_not_built:${stageId}`);
    return stage;
  };

  return {
    lateralSql,
    valueSql(stageId) {
      const stage = resolve(stageId);
      return ladder(
        stage,
        "NULL::double precision",
        "0::double precision",
        "NULL::double precision",
        `(${rawValue(stage)})::double precision`,
        "NULL::double precision",
      );
    },
    stateSql(stageId) {
      const stage = resolve(stageId);
      return ladder(
        stage,
        "'unmeasurable'",
        "'measured'",
        "'unreadable'",
        "'measured'",
        "'unreadable'",
      );
    },
    measuredSql(stageId) {
      const stage = resolve(stageId);
      return ladder(stage, "FALSE", "TRUE", "FALSE", "TRUE", "FALSE");
    },
    missingSql(stageId) {
      const stage = resolve(stageId);
      return ladder(stage, "TRUE", "FALSE", "TRUE", "FALSE", "TRUE");
    },
  };
}
