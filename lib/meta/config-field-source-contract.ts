/**
 * THE ONE RULE for whether a stored Meta config field may speak for a past day.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Two readers answer "what was this campaign's objective on day D": the decision
 * loader (`lib/creative-decision-engine/data-source.ts`) and native calibration
 * (`lib/creative-decision-engine/jobs/ad-calibration-job.ts`). They answered it
 * differently, and both answers were wrong in the same direction — they trusted
 * a value whose provenance cannot support it:
 *
 *   - Both prefer `meta_campaign_daily.objective`, and fall back to a typed
 *     config-history lateral with NO source filter.
 *   - Every row in `meta_campaign_config_history` carries
 *     source_kind 'warehouse_daily'; not one `provider_config_receipt` row has
 *     ever been written. Those rows came from a migration backfill selecting out
 *     of `meta_campaign_daily` and synthesising
 *     `captured_at = COALESCE(finalized_at, date T00:00:00Z)`. So `captured_at`
 *     is the REPORTING DATE, not an observation clock, and asking the table
 *     "what was the config as of day D" is circular: the row exists because day
 *     D had a daily row, and its captured_at IS day D.
 *   - The snapshot those rows cite cannot be the field's source either. It is an
 *     `ad_insights_bulk` snapshot, and 0 of 37,969 retained such snapshots for
 *     one business across five months contain an `objective` key at all.
 *
 * A single rule in one place, imported by both readers, is the only way a value
 * cannot be admitted by one path and refused by the other.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * Admissibility is computed from RAW OBSERVATIONS, not from typed history.
 *
 * That is not a preference, it is forced. `meta_campaign_config_history` is a
 * TRANSITION log: when a later observation finds the config unchanged it writes
 * nothing. So a rule that looks for a same-day history row reports the field as
 * unknown from the second day onward, however many successful daily fetches
 * happened — the history is silent precisely because nothing changed. The raw
 * observation is the receipt, and its retained payload is the value.
 *
 * Three tiers, and the tier decides what the value may DO:
 *
 *   provider_receipt_day_bracketed  A complete same-day observation whose
 *                                   payload carries the field, whose provider
 *                                   `updated_time` predates the provider-local
 *                                   day, AND a corroborating complete
 *                                   observation at or after the day's end
 *                                   reporting the same value and the same
 *                                   `updated_time`. Nothing wrote the entity
 *                                   during the day, so the WHOLE day is proven.
 *                                   Full decision authority.
 *   provider_receipt_point_in_day   A complete same-day observation, but no
 *                                   corroboration past the day's end. It proves
 *                                   the config at an INSTANT, not across the day
 *                                   whose metrics the cell aggregates, so a
 *                                   write later that day cannot be ruled out.
 *                                   REVIEW ONLY.
 *   typed_contemporaneous           The same-day creative witness. Cites no
 *                                   receipt at all. REVIEW ONLY.
 *   unknown                         Everything else, reported as unknown and
 *                                   never coalesced into a confident value.
 *
 * The bracket rests on an ACCEPTED ASSUMPTION, not on a verified provider fact,
 * and it is recorded that way on purpose. We have no confirmed rule that a write
 * to `objective` advances `updated_time`, and no natural change case exists in
 * anything we retained to test it against: zero objective changes across 2,148
 * campaigns over 24 days, and zero optimization_goal changes across 3,766 ad
 * sets over the window. The clock's detection power was only ever exercised at
 * sampling gaps of three days or less. So "the day was unchanged" is what this
 * tier ASSUMES on the strength of equal values at both ends plus an unmoved
 * clock — it is not something the provider has told us.
 *
 * The residual, stated rather than buried: the Campaign reference
 * documents `updated_time` only by exclusion, naming three write classes that do
 * NOT advance it (spend_cap, daily budget, lifetime budget) and never stating
 * which writes do. Those three are budget fields and cannot change `objective`,
 * so the carve-out does not touch this field directly. But because the positive
 * rule is undocumented, an unchanged clock cannot by itself prove that NOTHING
 * touched the entity: a change-and-revert inside the day, under a clock that did
 * not advance, is not excluded. What the bracket does prove directly is the value
 * at both ends; the clock is what bridges the one day between them. That is the
 * strongest claim the provider supports, and it is why this tier is called
 * day_bracketed rather than day_proven.
 *
 * The bracket shape is deliberately the one the repository already uses in
 * `sourceProvesWholeProviderDay` (`lib/meta/repair.ts`), not a new invention.
 * Because observations are daily, day N's bracket end is simply day N+1's
 * observation, so authority persists day after day without the history table
 * being involved at all.
 *
 * The canonical raw row is FIRST-observation metadata and shared between
 * observations, so completeness, status and field scope are always read from the
 * observation row, and only the payload value comes from the snapshot.
 *
 * An observation only counts when it is genuinely complete AND actually asked
 * for the field: status `fetched`, HTTP 200, `pagination.complete` true,
 * `termination` `natural_end`, and `request_context.fields` naming the field as
 * a TOP-LEVEL token — nested groups are stripped before the test, so a field
 * that merely contains the word (or appears only inside a `parent{child}`
 * expansion) does not count as having been requested. The field check is not
 * ceremony — the outage that created this whole problem was a 200 for a reduced
 * field list standing beside a 400 for the full one, and canonical raw content
 * is shared between observations, so an observation that never requested a
 * field must not license writing it.
 *
 * `run_id` IS NOT AN ADMISSION TEST. It decides only which CLOCK an admitted row
 * may be dated by, and therefore which tier it can reach.
 *
 * An earlier draft of this contract did require it, and that draft would have
 * admitted nothing at all: every live config-endpoint observation carries a NULL
 * `run_id` (34,985 campaign, 35,186 adset, 35,171 ad since 2026-09-01). Refusing
 * all of it would also have stranded every approved source-backed historical
 * repair outside the decision engine. So admission is by completeness and field
 * scope, and the run id — together with `request_context.rowObservedAtByEntityId`
 * — only marks a row MODERN, meaning it carries its own per-entity page clock.
 *
 * Three shapes are admitted, and they differ in what they can prove about TIME:
 *   - MODERN (run id + per-entity clock): each row has its own page time, so it
 *     can date a day and reach `provider_receipt_day_bracketed`.
 *   - LEGACY SINGLE-PAGE: no run id and no per-entity clock, but a one-page
 *     response has exactly one page time, so its aggregate `observed_at` IS that
 *     row's page time. It reaches the legacy bracket, or
 *     `provider_receipt_legacy_single_page` alone.
 *   - LEGACY MULTI-PAGE: neither clock and no structural substitute. Admitted as
 *     evidence of a VALUE and never of a time, so it is
 *     `provider_receipt_legacy_interval_uncertain` — review-only by construction
 *     and barred from anchoring a bracket.
 *     ONE exception, and it is a measurement rather than a concession: when the
 *     receipt records the first request and the last response
 *     (`request_context.pagination.startedAt` / `completedAt`) and both, with the
 *     row's own clock, fall on one provider-local date, the only hazard the tier
 *     guards — a fetch straddling local midnight — is disproved. That row is
 *     `provider_receipt_legacy_paged_within_day`: still review-only on its own,
 *     still below a point observation, but able to end a bracket. Without it an
 *     account whose config list never fits on one page is held forever by page
 *     count rather than by evidence.
 * Refusing the last two zeroes whole accounts whose payloads we actually hold,
 * which is why they are admitted rather than dropped; refusing to DATE them is
 * what keeps that from becoming a false authority.
 *
 * Two things are explicitly NOT sources, and both used to be:
 *   - a `warehouse_daily` / Insights-derived typed history row. Every row in
 *     `meta_campaign_config_history` is that kind; they were backfilled out of
 *     `meta_campaign_daily` with a synthesised
 *     `captured_at = COALESCE(finalized_at, date T00:00:00Z)`, so asking the
 *     table as-of is circular, and the `ad_insights_bulk` snapshot they cite
 *     contains no objective key at all (0 of 37,969 sampled).
 *   - a config observation from AFTER the day, carried backwards. Meta's own
 *     Campaign reference documents `updated_time` only by exclusion ("If you
 *     update spend_cap or daily budget or lifetime budget, this will not
 *     automatically update this field") and never states which writes advance
 *     it. `objective` is also not provably immutable: the Business SDK lists it
 *     among the params Campaign.api_update accepts. A later value is evidence
 *     about later.
 *
 * ── The typed tier's guards, each one paid for ──────────────────────────────
 * The creative witness needs all four, and each rules out a specific way the
 * value lies:
 *   1. created_at AND updated_at inside the provider-local day. The upsert does
 *      `objective = COALESCE(EXCLUDED.objective, existing)` while advancing
 *      `updated_at = now()` unconditionally, so a same-day updated_at alone
 *      proves nothing — but if the row was also CREATED that day, every write it
 *      ever received happened inside the day.
 *   2. Exactly one ad behind the row (`associated_ads_count <= 1`).
 *   3. `payload_json.real_ad_id` resolving to this campaign at ad grain.
 *      `meta_creative_daily.ad_id` is a creative hash, not a provider ad id, and
 *      the writer coalesces the campaign relation on merge, so the row's own
 *      campaign_id is not self-evidence.
 *   4. One consistent value across the day. Enforced by the caller comparing
 *      tiers; the SQL returns the single row it accepted.
 *
 * The witness is also NOT auditable: `lib/meta/creatives-warehouse.ts:1193`
 * hard-codes `sourceSnapshotId: null`, and its `payload_json` is an application
 * projection whose objective equals the column it would be cited for — self
 * citation, not a receipt. That is exactly why this tier is review-only.
 */

/**
 * Bump when the admissibility RULE changes, not when SQL is reformatted.
 * A stored decision that cites an older version was made under a different rule.
 *
 * AMENDED IN PLACE, NOT RE-MINTED (receipt lineage). `.v1` is unshipped: the
 * file is not in HEAD ef33d238b and no production row cites the version, so the
 * amendment below changes no stored decision.
 *
 * The receipt identity (canonical snapshot id, observation id, row clock and
 * field-scope hash) now travels through every resolution, and the resolution
 * tie-break ends on the OBSERVATION id after the snapshot id. That is a rule
 * change in exactly one place: two observations of ONE snapshot at ONE instant
 * used to be an unordered tie that DISTINCT ON broke by plan order. Their
 * values are identical by construction (same content). What CAN differ between
 * them is per-observation request metadata the ordering does not rank — at
 * campaign grain, whether each asked for updated_time, which the bracket reads —
 * and that was already an unordered tie: whichever row the new order picks is a
 * row the old order could already pick. So no answer becomes possible that was
 * not possible before; what changes is that the query now gives the SAME answer,
 * and cites the SAME receipt, every time. A reference whose citation could
 * change between two runs over the same rows would make the evaluation hash
 * flap, which is the failure the identity is being carried to prevent.
 */
export const META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION =
  "meta-config-field-source.v1";

/**
 * The version of the per-field receipt reference this contract emits
 * (`evidenceRefSql`). The reference's shape, parser and fail-closed coherence
 * rule live in `lib/meta/config-field-evidence-ref.ts`; the constant lives here
 * so the SQL builder and the parser cannot import each other in a cycle.
 */
export const META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION =
  "meta-config-field-evidence-ref.v1";

/**
 * How this contract turns a raw provider payload into a field value: top-level
 * token extraction from the canonical raw snapshot, then D098's case- and
 * separator-insensitive agreement (DECISION_LOG.md D098). It is a different
 * normalization from `buildConfigSnapshotPayload`'s `normalizationVersion: 2`
 * (lib/meta/raw-config-receipts.ts), which describes the historical repair
 * path, so it is numbered on its own. Bump it when the extraction or the
 * agreement rule changes; a reference citing another number fails closed.
 */
export const META_CONFIG_FIELD_SOURCE_NORMALIZATION_VERSION = 1;

/** The only `source_kind` that is a provider config observation. */
export const PROVIDER_CONFIG_RECEIPT_SOURCE_KIND = "provider_config_receipt";

/**
 * A `source_kind` for a value derived from the contemporaneous typed witness.
 *
 * Reserved, and deliberately unused by any writer in this release: the readers
 * compute the tier live from primary evidence, so when real receipts start
 * arriving both readers change behaviour with no backfill. Persisting a derived
 * value under the receipt kind would make an inference indistinguishable from an
 * observation, which is the failure this module exists to end.
 */
export const TYPED_CONTEMPORANEOUS_SOURCE_KIND =
  "provider_config_typed_contemporaneous";

/**
 * How promptly corroboration must arrive for a day to count as bracketed.
 *
 * Tied to an existing invariant rather than chosen: the repository already
 * declares, through META_OBSERVATION_CHECKPOINT_INTERVAL_MS, that 24h is the
 * longest an identical truth may go unwitnessed. Three days is a small multiple
 * of that, and a corroboration further out is weak evidence anyway — so the
 * horizon is stated as policy instead of arriving as an accident of whatever the
 * next observation happened to be.
 *
 * It also bounds the scan. Without it the corroboration lateral has no upper
 * limit on time and re-reads history for every ad-day.
 */
export const CORROBORATION_HORIZON_DAYS = 3;

/**
 * Slack allowed between a page's own response clock and its observation row's
 * aggregate clock, used ONLY to prune the scan.
 *
 * A receipt stores a merged multi-page payload, so the two clocks differ; this
 * is a generous bound on that difference, never a correctness test. Admission is
 * still decided by the per-entity page clock alone. Its purpose is to let the
 * existing index on observed_at prune: measured on production, an unbounded
 * lateral cost 792ms and ~11,000 blocks for ONE campaign-day, because it
 * rescanned legacy rows that the run-id rule was going to reject anyway.
 */
export const OBSERVATION_CLOCK_SLACK_DAYS = 2;


/**
 * Whether a response's selector EFFECTIVELY authorises a field.
 *
 * Reading `request_context.fields` alone is not enough. A degraded-but-recovered
 * response reports HTTP 200 while having dropped fields from the request, and
 * because canonical raw content is shared between observations, such a response
 * would otherwise authorise a field it never asked for — the inverse of the 400
 * that started all of this. So the effective selector is the requested field
 * list MINUS anything the degradation record says was dropped.
 *
 * Fail-closed in both unreadable directions: `droppedFields` is accepted as a
 * JSON array or a comma string, and when a response says it recovered from
 * degradation without a readable list of what it dropped, the field is treated
 * as NOT authorised rather than assumed intact.
 *
 * `topLevelOnly` strips nested groups first, so `parent{child}` never counts as
 * having requested `child`, and a field whose name merely contains the token
 * does not match.
 *
 * EXPORTED so its tests can drive the real predicate rather than restate it. A
 * restatement drifted once already and in the worst possible way: `\s` inside a
 * JavaScript template literal collapses to `s`, so a hand-written copy of this
 * regex matched the letter instead of whitespace, and the test failed while the
 * shipped SQL was correct. A test that re-implements the thing it checks can be
 * wrong in ways the implementation is not.
 */
/**
 * Casts of PROVIDER-SUPPLIED json, guarded so one malformed value cannot take
 * down the whole read.
 *
 * `(json ->> key)::timestamptz` raises on a bad string, and these queries run
 * inside calibration and decision hydration over a 90-day cohort — so a single
 * corrupt request_context or payload field would fail the entire job rather than
 * leave one row unknown. `pg_input_is_valid` (PostgreSQL 16) tests first and
 * yields NULL instead, which every tier already treats as no evidence.
 *
 * This mirrors `lib/meta/raw-config-receipts.ts:225-231` deliberately: the repair
 * reader and this contract must not disagree about what a malformed clock means.
 */
function safeCast(expr: string, sqlType: string): string {
  return `(CASE WHEN pg_input_is_valid(${expr}, '${sqlType}')
        THEN (${expr})::${sqlType} ELSE NULL END)`;
}

/**
 * An INSTANT, not merely something PostgreSQL will accept as one.
 *
 * `pg_input_is_valid` is necessary and not sufficient here: '2026-09-15' passes
 * it and becomes local midnight, but a page clock that lost its time is not a
 * page clock, and midnight would silently file the row on the wrong side of a
 * provider-local day boundary. Both values this guards are machine-written full
 * timestamps — the page clock from `new Date().toISOString()`
 * (lib/api/meta.ts:1723 and :2088) and the provider's own `updated_time` — so
 * requiring the shape costs nothing and rejects a truncated one.
 *
 * The zone is accepted as `Z`, `+00:00` or `+0000`, because Graph writes the
 * last of those while our own writer writes the first.
 */
function safeInstant(expr: string): string {
  const shape =
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$";
  return `(CASE WHEN (${expr}) ~ '${shape}'
        AND pg_input_is_valid(${expr}, 'timestamp with time zone')
        THEN (${expr})::timestamptz ELSE NULL END)`;
}

/**
 * Did the WHOLE of this receipt's pagination happen inside ONE provider-local day?
 *
 * A legacy multi-page receipt carries a single clock for the merged response, so
 * nothing in it says which page carried which entity — which is why the tier
 * below it refuses authority. But the hazard that refusal guards against is
 * narrow and nameable: a fetch that STRADDLED a provider-local midnight, where an
 * entity read on page 1 belongs to a different day from one read on page 9. Once
 * the writer records the first request and the last response, that hazard is
 * directly testable, and a fetch proven to lie inside one local day dates every
 * row it carries to that day — not to an instant within it, which is why such a
 * receipt is still not a point observation and still not modern.
 *
 * Four conditions, all fail-closed:
 *   - the scope provides the account's own timezone; an unknown zone is not
 *     silently treated as UTC when certifying a provider-local day;
 *   - both timings present and INSTANTS (see `safeInstant`: a bare date becomes
 *     local midnight and would answer the day question by construction);
 *   - the window runs forwards;
 *   - start, end and the row's OWN observation clock share one local date. The
 *     last is not redundant. `request_context` belongs to the observation row,
 *     so a timing pair that disagrees with the clock printed beside it is not
 *     evidence about this sighting, and is refused rather than reconciled.
 *
 * Missing or malformed timings yield FALSE, never NULL, so every receipt written
 * before this metadata existed keeps exactly the treatment it has today.
 */
function pagedWithinProviderDaySql(alias: string, timezoneExpr: string): string {
  const tz = `COALESCE(NULLIF(BTRIM(${timezoneExpr}), ''), 'UTC')`;
  const started = safeInstant(
    `${alias}.request_context->'pagination'->>'startedAt'`,
  );
  const completed = safeInstant(
    `${alias}.request_context->'pagination'->>'completedAt'`,
  );
  return `COALESCE((
        /* A provider-local day cannot be proved from an unknown account zone. */
        NULLIF(BTRIM(${timezoneExpr}), '') IS NOT NULL
        AND ${started} IS NOT NULL
        AND ${completed} IS NOT NULL
        AND ${started} <= ${completed}
        AND (${started} AT TIME ZONE ${tz})::date
          = (${completed} AT TIME ZONE ${tz})::date
        AND (${alias}.observed_at AT TIME ZONE ${tz})::date
          = (${completed} AT TIME ZONE ${tz})::date
      ), FALSE)`;
}

export function effectiveSelectorHasToken(alias: string, token: string): string {
  const fields = `${alias}.request_context->>'fields'`;
  const degradation = `${alias}.request_context->'pagination'->'fieldDegradation'`;
  /*
    Whitespace is significant to a LIKE and not to the provider. A list written
    "optimization_goal, promoted_object" would leave the second token as
    ", promoted_object," and a ",token," test would miss it — so a DROPPED field
    would read as authorised, which is the failure direction that matters. Both
    the requested list and the dropped list are therefore normalised around their
    separators before any comparison, and array elements are trimmed.
  */
  const commaList = (expr: string): string =>
    `(',' || BTRIM(regexp_replace(${expr}, '\\s*,\\s*', ',', 'g')) || ',')`;
  const topLevelFields = `regexp_replace(${fields}, '\\{[^}]*\\}', '', 'g')`;
  return `(
        (${commaList(topLevelFields)} LIKE '%,${token},%')
        AND NOT (CASE jsonb_typeof(${degradation}->'droppedFields')
          WHEN 'array' THEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${degradation}->'droppedFields') AS dropped(name)
            WHERE BTRIM(dropped.name) = '${token}'
          )
          WHEN 'string'
            THEN ${commaList(`${degradation}->>'droppedFields'`)} LIKE '%,${token},%'
          /* Recovered, but it cannot say what it dropped: refuse the field. */
          ELSE COALESCE(${degradation}->>'recovered', 'false') = 'true'
        END)
      )`;
}

export type MetaConfigFieldTier =
  | "provider_receipt_day_bracketed"
  | "provider_receipt_point_in_day"
  | "provider_receipt_legacy_bracketed"
  | "provider_receipt_legacy_single_page"
  /**
   * A complete legacy receipt that spanned SEVERAL pages, carrying no run id and
   * no per-entity page clock. Its payload is real evidence; its TIMING is not
   * knowable, because the only clock it has describes the merged response and
   * nothing says which page carried this entity. So the value is reported and the
   * interval it belongs to is declared uncertain: review only, never authority,
   * and never an end of a bracket. Inventing a page time to make it authoritative
   * is the one thing this tier exists to refuse.
   */
  | "provider_receipt_legacy_interval_uncertain"
  /**
   * A legacy MULTI-page receipt that PROVED its whole pagination ran inside one
   * provider-local day: first request and last response both recorded, both on
   * the same local date as the row's own observation clock.
   *
   * It is the answer to a real defect, not a relaxation. Without it, an account
   * whose config list never fits on one page can never leave
   * `provider_receipt_legacy_interval_uncertain`, and a consumer that demands a
   * receipt-named value holds it FOREVER — not because its evidence is weak but
   * because of how many rows the provider returns per page. Measured on the live
   * warehouse, two such accounts carry 18.0% of the 28-day spend and never once
   * flip to single page.
   *
   * What it proves is the DAY, not an instant in it: whichever page held the
   * entity, that page was fetched inside this local day. So it ranks below a
   * point observation, stays review only on its own, and — unlike
   * `provider_receipt_legacy_interval_uncertain` — may anchor an end of a legacy
   * bracket, because the one thing a bracket needs from it is that its value
   * belong to the day it is being read for.
   */
  | "provider_receipt_legacy_paged_within_day"
  /**
   * A receipt for a day whose corroboration window has NOT ELAPSED yet.
   *
   * Measured on a real run instant: at a 03:06:30Z as-of, every one of the 62
   * most recent ad-set-days came back review-only, because a bracket needs an
   * observation after the day ends and before the cutoff, and only hours had
   * passed. That is a TIMING artefact, not an evidence gap, and the two must not
   * look alike — otherwise every run's freshest data reads as permanently
   * unverifiable and a consumer that demands authority on every day in its window
   * can never act at all.
   *
   * Still review only: the day genuinely is not corroborated yet. But it is named
   * so a consumer can wait for it rather than treat it as missing.
   */
  | "provider_receipt_pending_corroboration"
  | "typed_contemporaneous"
  /**
   * A receipt that asked for the field and came back WITHOUT it. That is a
   * provider statement, not a gap in our looking, and it must not be confused
   * with `unknown`: the whole point is that it ENDS a stale value. Carrying no
   * value, it authorises nothing, but it is reported under its own name so a
   * reader can tell "the provider says there is none" from "we never looked".
   */
  | "observed_absent"
  | "unknown";

/** What a tier's value is allowed to do. */
export type MetaConfigFieldReadiness = "decision_authority" | "review_only" | "none";

/**
 * WHERE an admitted value came from, kept apart from which day it proves.
 *
 * Provenance and timeliness are independent axes everywhere else in this repair,
 * and they are here too: a snapshot-only legacy receipt can bracket a day
 * perfectly while being the weakest source we hold. Multiplying tier names to
 * encode both would hide that.
 *
 *   modern                a run-bound observation carrying a per-entity page clock.
 *   legacy_observed       an observation row, single page, no run id or clock map.
 *   typed_unlinked        the contemporaneous typed witness: a value stored in a
 *                         warehouse row that links to no raw receipt at all
 *                         (creatives-warehouse.ts:1193 hard-codes
 *                         sourceSnapshotId: null). Calling this legacy_observed
 *                         would claim a receipt that does not exist.
 *   legacy_snapshot_only  a retained snapshot with NO observation row at all. The
 *                         2026-07-25 ColorFull receipts are this: real fetched
 *                         200 single-page responses with the field requested,
 *                         which the historical repair path already accepts, and
 *                         which a reader scanning only observations erases.
 *                         Admitted ONLY when no observation exists for that
 *                         snapshot — once one does, the snapshot row is
 *                         first-occurrence metadata and may not stand in for it.
 */
export type MetaConfigSourceClass =
  | "modern"
  | "legacy_observed"
  | "legacy_multi_page"
  | "legacy_snapshot_only"
  | "typed_unlinked"
  | "none";

/**
 * Every tier, in one list, so the SQL ladders can be GENERATED from the rule
 * rather than restated beside it.
 *
 * Two hand-written CASE ladders had already drifted from this function and from
 * each other: the campaign one omitted `provider_receipt_pending_corroboration`
 * and the ad-set one omitted `typed_contemporaneous`, so both fell through to
 * `ELSE 'none'`. The campaign omission is the expensive one — it is exactly the
 * tier the freshest day of every run carries, so the current day's objective
 * read as "no provenance at all" instead of "not corroborated yet", in a
 * consumer that treats the two very differently.
 *
 * An `ELSE` that silently downgrades an unlisted tier is the wrong default for a
 * ladder maintained by hand, so it is no longer maintained by hand.
 */
export const META_CONFIG_FIELD_TIERS = [
  "provider_receipt_day_bracketed",
  "provider_receipt_legacy_bracketed",
  "provider_receipt_point_in_day",
  "provider_receipt_legacy_single_page",
  "provider_receipt_legacy_paged_within_day",
  "provider_receipt_legacy_interval_uncertain",
  "provider_receipt_pending_corroboration",
  "typed_contemporaneous",
  "observed_absent",
  "unknown",
] as const satisfies readonly MetaConfigFieldTier[];

/**
 * The readiness ladder as SQL, emitted from `readinessForConfigFieldTier`.
 *
 * `ELSE 'none'` stays as the answer for a value that is not a tier at all (a
 * NULL from an absent join), but every tier now has its own WHEN, so the ELSE
 * can no longer swallow one.
 */
/**
 * The final, deterministic tail of every resolution ordering.
 *
 * Without it each DISTINCT ON ends at `row_observed_at`, and two admissible
 * observations of the same entity on the same day can share an instant — the
 * same canonical snapshot re-observed, or two snapshots fetched in one batch.
 * PostgreSQL is then free to return either, so the SAME query can answer
 * differently across plans and runs. That is a bad property in itself, and a
 * worse one for anyone diffing this query against a rewrite: the flapping row
 * looks like a defect in the rewrite.
 *
 * The order is not arbitrary. At an equal instant, prefer the observation whose
 * clock is stronger — a modern receipt times the row itself, and a row that is
 * not interval-uncertain has a page time rather than an approximation — and end
 * on the snapshot identity, which is stable and carries no meaning of its own.
 */
/**
 * The SECOND compression layer, applied AFTER the payload is expanded.
 *
 * ── WHY A SECOND ONE ────────────────────────────────────────────────────────
 *
 * The first layer reduces repeated work on identical CONTENT: each distinct
 * snapshot is expanded once instead of once per observation. What it cannot
 * reduce is the resolution join, because that runs per (account, entity, day)
 * over every retained receipt row — and after expansion the same entity appears
 * once per observation that saw it. Measured on a live account for one day:
 * 45,518 campaign receipt rows carrying only 1,199 distinct (entity, day)
 * pairs, and 72,302 ad-set rows carrying 1,973. The join was re-deciding the
 * same question thousands of times.
 *
 * ── WHY THESE THREE ROWS, AND NO OTHERS ─────────────────────────────────────
 *
 * Exactly three picks are ever made from a bucket, so exactly three rows must
 * survive it:
 *   - the SAME-DAY value is the newest observation of that day admitted by the
 *     cutoff — `last_known`;
 *   - the CORROBORATION is the earliest observation in the window after the day,
 *     also cutoff-admitted — `first_known` of each later day's bucket;
 *   - the RESTATED diagnostic is the newest observation of the day with no
 *     cutoff at all — `last_overall`.
 * Anything between them loses every one of those comparisons.
 *
 * TIES SURVIVE WHOLE. The filter is an equality against the three boundary
 * instants, not a LIMIT, so when several observations share an instant they are
 * all retained and `RESOLUTION_TIE_BREAK_SQL` still chooses among the full set.
 *
 * ── WHAT THE KEY MUST CONTAIN, AND WHY ──────────────────────────────────────
 *
 * The entity, because two entities in one payload are two different timelines.
 * The PROVIDER-LOCAL day of the ROW's own clock — not the observation's
 * aggregate clock and not UTC: a modern receipt dates each row separately, so a
 * row can belong to a different local day than the response it arrived in, and
 * a UTC bucket cuts every non-UTC account's day in the wrong place.
 * And the requested-selector flags, because an observation that did not ask for
 * a field cannot speak about it — bucketing it together with one that did lets
 * a silent response displace a speaking one.
 *
 * `requested_updated_time` is in BOTH grains' keys. It gates the bracket at both
 * ends, so a row that asked for the clock and a row that did not are not
 * interchangeable, even at the same instant on the same day.
 */
function entityDayCompressionCte(input: {
  name: string;
  source: string;
  entityColumn: string;
  scopeRelationSql: string;
  cutoff: string;
  extraPartitionColumns: readonly string[];
}): string {
  const extra = input.extraPartitionColumns.length
    ? `,\n            ${input.extraPartitionColumns.map((c) => `r.${c}`).join(", ")}`
    : "";
  return `${input.name} AS MATERIALIZED (
    WITH scope_tz AS (
      SELECT DISTINCT provider_account_id,
             COALESCE(NULLIF(BTRIM(account_timezone), ''), 'UTC') AS account_timezone
      FROM (${input.scopeRelationSql}) scope_rows
    ),
    bounded AS (
      SELECT r.*,
        tz.account_timezone AS resolved_account_timezone,
        MIN(r.row_observed_at) FILTER (WHERE r.row_observed_at <= ${input.cutoff})
          OVER w AS first_known,
        MAX(r.row_observed_at) FILTER (WHERE r.row_observed_at <= ${input.cutoff})
          OVER w AS last_known,
        MAX(r.row_observed_at) OVER w AS last_overall
      FROM ${input.source} r
      JOIN scope_tz tz ON tz.provider_account_id = r.provider_account_id
      WINDOW w AS (
        PARTITION BY r.provider_account_id, r.${input.entityColumn},
          tz.account_timezone,
          (r.row_observed_at AT TIME ZONE tz.account_timezone)::date,
          r.requested_updated_time${extra}
      )
    )
    SELECT * FROM bounded
    WHERE row_observed_at = first_known
       OR row_observed_at = last_known
       OR row_observed_at = last_overall
  )`;
}

/**
 * The scope join, computed ONCE for every resolution that shares it.
 *
 * ── WHY THIS EXISTS, IN MEASURED NUMBERS ────────────────────────────────────
 *
 * Each resolution used to carry its own copy of the same join: the caller's
 * scope rows against the entity-day relation, on (account, entity, timezone).
 * The entity-day relation is a CTE, so it has no index, and the planner
 * estimates it at ONE row — every predicate that reaches it goes through
 * `request_context->>'...'` json extraction, whose selectivity the planner can
 * only guess at, and six such guesses multiply to nothing. A one-row estimate
 * makes a nested loop look free, so the planner picks one and re-reads the
 * WHOLE relation for every scope row.
 *
 * Measured on production (TheSwaf, 1,394 scope rows, 5,488 entity-day rows, four
 * interleaved read-only runs): each ad-set resolution scanned 1,394 x 5,488 =
 * 7.65 M rows and cost ~960 ms, and there are six of them — 45.9 M row touches
 * and 5.8 s of a 10.0 s query, purely to compute the same join six times. The
 * cost was exactly linear in the number of resolutions (1 -> 1.47 s, 3 ->
 * 3.52 s, 6 -> 6.28 s), which is what identified it.
 *
 * The join itself is tiny. Bounded by the widest window any resolution uses, it
 * is 7,241 rows at ad-set grain and 1,046 at campaign grain. So it is computed
 * once, into its own materialised relation, and each resolution then applies
 * only its OWN predicates over that.
 *
 * ── WHY IT IS THE SAME ANSWER ───────────────────────────────────────────────
 *
 * The bound is the UNION of every window a resolution can use, and nothing more
 * is removed here:
 *   same-day and restated  [dayStart, dayEnd)
 *   corroboration          [dayEnd, dayEnd + horizon)
 *   union                  [dayStart, dayEnd + horizon)
 * Each resolution still applies its exact window, its own `requested_<field>`
 * selector flag and its own cutoff afterwards, so it sees precisely the rows it
 * saw before. There is no value filter here, for the same reason there is none
 * there: an observed absence is a candidate and must be able to win.
 *
 * The scope is DISTINCTed to the grain the resolutions key on. That is not a
 * behaviour change either — a duplicate scope row produces duplicate identical
 * joined rows, and `DISTINCT ON` collapsed them already — but it is worth real
 * time at campaign grain, where one campaign carries many ad sets and the same
 * measurement shows 1,394 scope rows reducing to 482 distinct campaign-days.
 *
 * The timezone is taken from the entity-day side afterwards. The join requires
 * `resolved_account_timezone` to EQUAL the coalesced scope timezone, so inside
 * this relation the two are the same value by construction, and the windows can
 * read either.
 */
function resolutionScopeCte(input: {
  name: string;
  entityDayCte: string;
  entityColumn: string;
  scopeRelationSql: string;
  horizonDays: number;
}): string {
  const scopeTz = `COALESCE(NULLIF(BTRIM(s.account_timezone), ''), 'UTC')`;
  return `${input.name} AS MATERIALIZED (
    SELECT s.date, r.*
    FROM (
      SELECT DISTINCT provider_account_id, ${input.entityColumn}, date, account_timezone
      FROM (${input.scopeRelationSql})
        scope_rows(provider_account_id, ${input.entityColumn}, date, account_timezone)
    ) s
    JOIN ${input.entityDayCte} r
      ON r.provider_account_id = s.provider_account_id
     AND r.${input.entityColumn} = s.${input.entityColumn}
     /* The bucket is keyed by the account's timezone, so the join must be too:
        one account's compressed rows must never answer another's day. */
     AND r.resolved_account_timezone = ${scopeTz}
    /* The union of every resolution window; each still applies its own. */
    WHERE r.row_observed_at >= (s.date::timestamp AT TIME ZONE ${scopeTz})
      AND r.row_observed_at < ((s.date + 1)::timestamp AT TIME ZONE ${scopeTz})
        + INTERVAL '${input.horizonDays} days'
  )`;
}

/**
 * The account narrowing, as a predicate the planner can use as an index condition.
 *
 * `provider_account_id IN (SELECT ...)` is a subquery, and PostgreSQL will not
 * fold a subquery into an index condition — so the narrowing filtered rows but
 * did not narrow the SCAN. Measured with EXPLAIN on the largest live account, the
 * snapshot-only anti-join then built a BitmapAnd that included a 154,103-entry
 * scan of the endpoint index, because the account column was not available to
 * restrict the driving index.
 *
 * A caller whose scope is one account — every calibration batch — passes a
 * single scalar select, and that case is rewritten to an equality. Anything else
 * keeps the general `IN`, which is still correct and still filters; only the
 * scalar case gets the index condition.
 *
 * The detection is deliberately narrow: exactly `SELECT $n::text` or
 * `SELECT $n`, nothing else. A pattern that guessed wider could rewrite a
 * multi-row scope into an equality and silently drop accounts.
 */
export function accountNarrowingSql(
  alias: string,
  accountScopeSql: string | undefined,
): string {
  if (!accountScopeSql) return "";
  const scalar = /^\s*SELECT\s+(\$\d+(?:::text)?)\s*$/i.exec(accountScopeSql);
  return scalar
    ? `        AND ${alias}.provider_account_id = ${scalar[1]}`
    : `        AND ${alias}.provider_account_id IN (${accountScopeSql})`;
}

/*
  The tail ends on the OBSERVATION id, after the snapshot id.

  The snapshot id alone left one tie open: the same canonical snapshot observed
  twice at the same instant. The value cannot differ between the two (same
  content), so the tie was nearly invisible — only request metadata the ordering
  does not rank could differ. It stops being invisible the moment the chosen
  receipt's identity is carried into a reference: the evaluation hash would then
  depend on plan order. Ordering on the uuid itself (not its text) keeps the comparison
  byte-wise and collation-free. NULLS LAST is explicit rather than implied: a
  snapshot-only receipt has no observation id, and it can only ever be alone in
  its snapshot (it is admitted only when no observation exists), so it never
  competes with one; the clause states that instead of relying on a default.
*/
export const RESOLUTION_TIE_BREAK_SQL =
  "r.is_modern DESC, r.is_interval_uncertain ASC, r.snapshot_id, r.observation_id NULLS LAST";

/**
 * The identity of a receipt's EFFECTIVE field scope, as sha256 hex.
 *
 * Two observations of one canonical snapshot can differ in what they ASKED for
 * — the same payload re-observed under a narrower selector, or a degraded
 * response that dropped fields and recovered — and that difference is exactly
 * what decides whether the receipt may speak for a field
 * (`effectiveSelectorHasToken`). A reference that named the receipt but not its
 * scope could not be audited against that decision. The hash covers the
 * requested field list and the degradation record verbatim, separated by a unit
 * separator that neither can contain; an absent part hashes as the empty string
 * rather than NULL, so the hash itself is never NULL for an admitted receipt.
 *
 * The builtin `sha256(bytea)` (PostgreSQL 11+), not pgcrypto: this contract must
 * not depend on an extension being installed.
 */
export function receiptFieldScopeHashSql(alias: string): string {
  return `encode(sha256(convert_to(
          COALESCE(${alias}.request_context->>'fields', '') || E'\\x1f' ||
          COALESCE(${alias}.request_context->'pagination'->>'fieldDegradation', ''),
          'UTF8')), 'hex')`;
}

/**
 * Tiers only a provider receipt can earn: every `provider_receipt_*` tier, and
 * `observed_absent` (a receipt that asked and came back without the field).
 *
 * Stated here rather than imported because `lib/meta/config-field-evidence-ref.ts`
 * imports THIS module; its `META_CONFIG_EVIDENCE_RECEIPT_TIERS` is the same list
 * and a unit test pins the two equal.
 */
export const META_CONFIG_FIELD_RECEIPT_BACKED_TIERS: readonly MetaConfigFieldTier[] =
  Object.freeze(
    (META_CONFIG_FIELD_TIERS as readonly MetaConfigFieldTier[]).filter(
      (tier) => tier.startsWith("provider_receipt_") || tier === "observed_absent",
    ),
  );

/** Tiers whose proof includes a second, day-closing receipt; same parity rule. */
export const META_CONFIG_FIELD_BRACKETED_TIERS: readonly MetaConfigFieldTier[] =
  Object.freeze([
    "provider_receipt_day_bracketed",
    "provider_receipt_legacy_bracketed",
  ]);

function sqlTierList(tiers: readonly MetaConfigFieldTier[]): string {
  return tiers.map((tier) => `'${tier}'`).join(", ");
}

/** A receipt row clock as the reference's ISO-8601 UTC millisecond instant. */
function evidenceInstantSql(expr: string): string {
  return `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * THE RECEIPT A FIELD'S TIER WAS DECIDED ON, as one jsonb reference.
 *
 * The shape, the parser and the fail-closed coherence rule it must satisfy live
 * in `lib/meta/config-field-evidence-ref.ts`; this is the only producer. It is a
 * scalar subquery so the tier ladder — the largest expression this contract
 * emits — is evaluated ONCE per reference and then read by name, instead of
 * being spliced into every key that depends on it.
 *
 * What each part cites, and why nothing else:
 *   - identity comes from the SAME-DAY resolution row, which is the row every
 *     receipt tier (including observed absence) is decided on;
 *   - the corroborating identity is filled ONLY for a bracketed tier: a later
 *     sighting that did not close a bracket is not part of the proof, and
 *     citing it would make identity move on evidence that chose nothing;
 *   - a receipt-less tier (typed witness, unknown) carries NO identity at all.
 *     `unknown` reports source class `none` even when a same-day row exists
 *     under an account with no timezone: the tier refused that row, so the
 *     reference must not claim it — a class the tier did not use would read as
 *     tampering to the coherence rule;
 *   - `readiness` is the CONTRACT readiness for the tier. A caller's agreement
 *     gate narrows authority downstream and must not be baked into the receipt.
 */
function configFieldEvidenceRefSql(input: {
  prefix: string;
  field: string;
  tierSql: string;
  sourceClassSql: string;
  pitClassSql: string;
  sameDayAlias: string;
  corroborationAlias: string;
}): string {
  const ref = `${input.prefix}_evref`;
  const isReceipt = `${ref}.tier IN (${sqlTierList(META_CONFIG_FIELD_RECEIPT_BACKED_TIERS)})`;
  const isBracketed = `${ref}.tier IN (${sqlTierList(META_CONFIG_FIELD_BRACKETED_TIERS)})`;
  const day = input.sameDayAlias;
  const next = input.corroborationAlias;
  return `(SELECT jsonb_build_object(
      'refContractVersion', '${META_CONFIG_FIELD_EVIDENCE_REF_CONTRACT_VERSION}'::text,
      'field', '${input.field}'::text,
      'sourceContractVersion', '${META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION}'::text,
      'normalizationVersion',
        CASE WHEN ${isReceipt} THEN ${META_CONFIG_FIELD_SOURCE_NORMALIZATION_VERSION} END,
      'tier', ${ref}.tier,
      'readiness', ${readinessCaseSql(`${ref}.tier`)},
      'sourceClass',
        CASE WHEN ${ref}.tier = 'unknown' THEN 'none'::text ELSE ${input.sourceClassSql} END,
      'pitClass', CASE WHEN ${isReceipt} THEN ${input.pitClassSql} END,
      'sourceSnapshotId', CASE WHEN ${isReceipt} THEN ${day}.snapshot_id::text END,
      'observationId', CASE WHEN ${isReceipt} THEN ${day}.observation_id::text END,
      'observedAt',
        CASE WHEN ${isReceipt} THEN ${evidenceInstantSql(`${day}.row_observed_at`)} END,
      'fieldScopeHash', CASE WHEN ${isReceipt} THEN ${day}.field_scope_hash END,
      'corroboratingSnapshotId',
        CASE WHEN ${isBracketed} THEN ${next}.snapshot_id::text END,
      'corroboratingObservationId',
        CASE WHEN ${isBracketed} THEN ${next}.observation_id::text END,
      'corroboratingObservedAt',
        CASE WHEN ${isBracketed} THEN ${evidenceInstantSql(`${next}.row_observed_at`)} END
    )
    /*
      OFFSET 0 fences the ladder. Without it PostgreSQL flattens this FROM
      subquery and substitutes the whole tier ladder for every read of
      ref.tier above (about a dozen), so "evaluated once" would be a claim the
      plan does not keep.
    */
    FROM (SELECT ${input.tierSql} AS tier OFFSET 0) ${ref})`;
}

export function readinessCaseSql(tierExpression: string): string {
  const arms = META_CONFIG_FIELD_TIERS.map(
    (tier) => `      WHEN '${tier}' THEN '${readinessForConfigFieldTier(tier)}'`,
  ).join("\n");
  return `(CASE ${tierExpression}\n${arms}\n      ELSE 'none'\n    END)`;
}

export function readinessForConfigFieldTier(
  tier: MetaConfigFieldTier,
): MetaConfigFieldReadiness {
  switch (tier) {
    case "provider_receipt_day_bracketed":
    /*
      A legacy pair that brackets the day carries the same shape of proof as a
      modern one: value equality at both ends and an unmoved provider clock that
      predates the day. Holding it at review_only would push every already
      repaired historical case into permanent re-review, which is not a safety
      property, just friction. It stays a SEPARATE tier so the weaker source is
      auditable, and a contradiction or a missing bracket still falls back to
      review_only.
    */
    case "provider_receipt_legacy_bracketed":
      return "decision_authority";
    /*
      A point observation proves an instant, not the day whose metrics the cell
      aggregates; the creative witness proves a day but cites no receipt. Both
      inform a recommendation and neither authorizes execution.
    */
    /* Observed absence carries no value, so it can authorise nothing — but it is
       a measurement, and its tier says so rather than pretending we never looked. */
    case "observed_absent":
      return "none";
    case "provider_receipt_point_in_day":
    /*
      A legacy single-page receipt. It carries no run binding and no per-entity
      page clock, so its day stamp rests on the structural fact that a one-page
      response has exactly one page time - real evidence, but a weaker class
      than the modern receipt, and never execution authority.
    */
    case "provider_receipt_legacy_single_page":
    /*
      A multi-page receipt whose pagination is proven to fit inside one
      provider-local day. It dates its rows to that DAY and to nothing finer, so
      it sits exactly where the single-page receipt sits: real evidence, never
      execution authority on its own. What separates it from the uncertain tier
      is only that the straddled-midnight hazard has been measured away.
    */
    case "provider_receipt_legacy_paged_within_day":
    case "provider_receipt_legacy_interval_uncertain":
    case "provider_receipt_pending_corroboration":
    case "typed_contemporaneous":
      return "review_only";
    default:
      return "none";
  }
}

/**
 * The campaign-level fields this contract governs.
 *
 * `objective` and nothing else, because that is what the campaign receipt
 * actually carries: a live 200 `campaign_configs` payload element holds
 * bid_strategy, buying_type, daily_budget, effective_status, id,
 * lifetime_budget, name, objective, status and updated_time. There is no
 * campaign-level `optimization_goal` or `custom_event_type` in it.
 *
 * Ad-set `optimization_goal` therefore needs its own resolver keyed on ad-set
 * identity, and must not be inferred from a campaign-scoped source: one campaign
 * can hold ad sets with different goals, so a single campaign-wide value would
 * be wrong for all but one of them.
 */
export const META_CONFIG_CONTRACT_CAMPAIGN_FIELDS = ["objective"] as const;

export type MetaConfigContractCampaignField =
  (typeof META_CONFIG_CONTRACT_CAMPAIGN_FIELDS)[number];

export interface MetaConfigFieldSourceSqlInput {
  /**
   * SQL yielding the provider account ids in scope, e.g. "SELECT $4::text".
   *
   * Narrows the receipt scan before anything else happens. The only index on
   * `meta_raw_snapshot_observations` for this access path is
   * (business_id, provider_account_id, endpoint_name, observed_at), and without
   * an account predicate the scan stops using it after its first column.
   * Measured on the largest live account with EXPLAIN (no ANALYZE): the
   * observation scan falls from ~42k to ~4.5k estimated cost and the statement
   * total from 273k to 172k — and to 46.7k once the creative-witness CTE is
   * narrowed the same way.
   *
   * NOT A PERFORMANCE FIX ON ITS OWN. The same statement still exceeded 30s in a
   * real historical run with all of that applied, so the remaining cost is
   * elsewhere. It is here because it is correct and cheap, not because it closes
   * the budget.
   *
   * Optional, and omitting it changes no result: it narrows rows the scope
   * relation would reject anyway.
   */
  accountScopeSql?: string;
  /**
   * Placeholders bounding the whole query's day range, e.g. "$2" and "$3".
   *
   * Required because admissibility is extracted ONCE for the scope rather than
   * re-derived per ad-day. Measured on production, the per-row shape cost
   * 1.685ms for 10 campaign-days and 399.7ms with 692,593 buffer hits for 100 —
   * 237x the time for 10x the rows, because every row re-scanned the raw tables
   * and re-expanded 476-element payloads.
   */
  scopeStartParam: string;
  scopeEndParam: string;
  /**
   * SQL yielding the campaign ids the caller actually needs, e.g.
   * "SELECT DISTINCT campaign_id FROM scope".
   *
   * Required, not optional, because without it the extraction expands EVERY
   * campaign in every qualifying snapshot. A live July probe did exactly that
   * and cost 510,281 buffer hits with 262,974 temp reads: a month of daily
   * snapshots times a 476-element payload spills to disk. Filtering the
   * expansion to the campaigns in scope is the difference between a hash spill
   * and a small set.
   */
  campaignScopeSql: string;
  /**
   * A SQL relation yielding the caller's scope with exactly these columns in
   * this order: (provider_account_id, campaign_id, date, account_timezone).
   *
   * Required because resolution is SET-BASED. As three correlated laterals this
   * builder re-scanned the whole materialised receipts set once per ad-day, which
   * is what took a 9,241-ad-day calibration read to 307 seconds.
   */
  scopeRelationSql: string;
  /**
   * The evaluation cutoff, e.g. "$4" — the instant the decision is made as of.
   *
   * Without it this contract leaks the future into a historical replay: the
   * receipts CTE reaches three days past the scope for corroboration, and the
   * witness takes a creative row updated any time before the day ends. Replaying
   * as of D would then admit a D+1 corroboration the original run could not have
   * seen. Evidence observed after the cutoff still resolves a VALUE, but it can
   * never carry authority, and pitClassSql reports it as restated.
   */
  evaluationCutoffParam: string;
  /** SQL expression for the ad-day's date, e.g. "d.date". */
  dayExpression: string;
  /** SQL expression for the provider account timezone, e.g. "d.account_timezone". */
  timezoneExpression: string;
  /** Placeholder carrying the business id, e.g. "$1". */
  businessParam: string;
  /** SQL expression for the provider account id. */
  accountExpression: string;
  /** SQL expression for the campaign id. */
  campaignExpression: string;
  /** Distinct alias prefix, so one query can carry several instances. */
  aliasPrefix?: string;
  /**
   * Emit the RESTATED diagnostic resolution, and its join, at all.
   *
   * Off by default, because it is not free and almost nobody reads it. It is a
   * whole extra `DISTINCT ON` relation plus a `LEFT JOIN` that the final SELECT
   * re-scans once per output row, and a relation nothing reads is a relation
   * nothing needs. Measured read-only on production (Bilsem, 9,117 output rows):
   * the two AD-SET diagnostic joins alone were 11.1 M of the 44.1 M row touches
   * in the final join and ~1.2 s of a ~9.4 s query, with the result set
   * bit-identical once they were removed.
   *
   * Of the two production readers, `data-source.ts` reads no restated value at
   * any grain, and `ad-calibration-job.ts` reads only the CAMPAIGN one. So the
   * default is what both of them actually want, and the one caller that needs
   * the diagnostic asks for it.
   *
   * `restatedValueSql` THROWS when this is off rather than naming a relation the
   * query does not contain, so the mistake is a build-time error and never a
   * SQL one.
   */
  includeRestated?: boolean;
}

export interface MetaConfigFieldSourceSql {
  contractVersion: string;
  /**
   * A `name AS MATERIALIZED (...)` fragment for the query's WITH clause.
   *
   * MATERIALIZED is load-bearing, not decoration: without it the planner is free
   * to inline the CTE back into each lateral, which reproduces exactly the
   * per-row rescan this shape exists to remove.
   */
  withSql: string;
  /** The CTE's name, so a caller can see what it is splicing. */
  cteName: string;
  /** LATERAL joins over the CTE, to splice into the FROM clause, in order. */
  lateralSql: string;
  /**
   * The value a decision may use: admitted ONLY when its evidence predates the
   * evaluation cutoff. NULL otherwise, never a future value with a flag.
   */
  valueSql(field: MetaConfigContractCampaignField): string;
  /**
   * The same value ignoring the cutoff, for a current readback or diagnostic.
   * Never for a decision: this is what today's warehouse says, not what that
   * run could have known.
   */
  restatedValueSql(field: MetaConfigContractCampaignField): string;
  /** The tier that admitted it, always non-null. */
  tierSql(field: MetaConfigContractCampaignField): string;
  /** What that tier permits. */
  readinessSql(field: MetaConfigContractCampaignField): string;
  /** Where the admitted value came from, independent of which day it proves. */
  sourceClassSql(field: MetaConfigContractCampaignField): string;
  /**
   * Whether the evidence was already visible at the evaluation cutoff.
   * "as_of_known" or "restated" — never used to resolve a value, only to say
   * what the value is a statement about.
   */
  pitClassSql(field: MetaConfigContractCampaignField): string;
  /**
   * The receipt the tier was decided on, as a `ConfigFieldEvidenceRef` jsonb
   * (`lib/meta/config-field-evidence-ref.ts`). A projected expression over this
   * builder's laterals; a caller that needs it as an identifier (the coherence
   * predicate and the manifest helpers require one) projects it into a column
   * first.
   */
  evidenceRefSql(field: MetaConfigContractCampaignField): string;
}

/**
 * Builds the laterals and expressions both readers use.
 *
 * Emitted as SQL rather than resolved in TypeScript because both callers are
 * single large set-based queries; pulling the decision out into application code
 * would mean a second round trip per ad-day and a second chance to diverge.
 */
export function buildMetaConfigFieldSourceSql(
  input: MetaConfigFieldSourceSqlInput,
): MetaConfigFieldSourceSql {
  const p = input.aliasPrefix ?? "cfgsrc";
  const includeRestated = input.includeRestated ?? false;
  const cteName = `${p}_receipts`;
  /* The post-expansion, per-(entity, provider-local day) compression. */
  const entityDayCte = `${p}_entity_day`;
  const sameDay = `${p}_receipt`;
  const after = `${p}_corrob`;
  const witness = `${p}_witness`;
  const tz = `COALESCE(NULLIF(BTRIM(${input.timezoneExpression}), ''), 'UTC')`;
  const dayStart = `(${input.dayExpression}::timestamp AT TIME ZONE ${tz})`;
  const dayEnd = `((${input.dayExpression} + 1)::timestamp AT TIME ZONE ${tz})`;

  /*
    Every qualifying config receipt in the scope, exploded to one row per
    campaign, extracted ONCE.

    Completeness, status and field scope come from the OBSERVATION row: the
    canonical raw row is first-occurrence metadata and its content is
    deduplicated across observations, so only the payload value may come from the
    snapshot. The join therefore also matches business, account, endpoint and
    scope, and fails closed when shared content does not line up.

    The field test names a TOP-LEVEL token: nested groups are stripped first, so
    a field that merely contains the word, or appears only inside a
    parent{child} expansion, does not count as requested. The outage that created
    this problem was a 200 for a reduced field list standing beside a 400 for the
    full one.

    The clock is each row's OWN page response time. A receipt stores a merged
    multi-page payload, so the observation's observed_at describes the
    aggregation; on a two-page account it can put a row on the wrong side of a
    day boundary. An observation predating that metadata cannot say which page
    time a row had, so it is refused rather than approximated.
  */
  /** See `accountScopeSql`: a no-op when the caller did not supply a scope. */
  const accountNarrowing = (alias: string): string =>
    accountNarrowingSql(alias, input.accountScopeSql);

  const withSql = `${cteName} AS MATERIALIZED (
    WITH qualifying AS (
      /*
        Reject the observation BEFORE touching its payload. Without this step the
        planner is free to expand every snapshot's array first and filter after,
        and the array is large — a live campaign_configs payload holds 476
        elements. Measured on production, expanding first cost ~550,000 buffer
        hits to build this CTE even though almost every observation was going to
        be rejected for a failed status or a null run id.
      */
      SELECT obs.snapshot_id, obs.provider_account_id, obs.request_context,
             obs.observed_at,
             (obs.run_id IS NOT NULL
              AND obs.request_context ? 'rowObservedAtByEntityId') AS is_modern,
             /*
               String comparison, not a cast: a malformed pageCount can then
               neither raise nor slip through as a number.
             */
             (obs.request_context->'pagination'->>'pageCount' = '1')
               AS is_single_page,
             /*
               The bracket compares payload updated_time, so the response must
               have ASKED for it. Canonical payload reuse means an objective-only
               observation can otherwise inherit an older payload's clock and
               brackets a day on a value it never requested.
             */
             ${effectiveSelectorHasToken("obs", "updated_time")}
               AS requested_updated_time,
             /*
               RECEIPT IDENTITY, carried from here to the reference. The
               observation id is the receipt; the snapshot id above is only its
               shared content, and one snapshot is re-observed about a hundred
               times, so citing the snapshot alone cannot tell two receipts
               apart. The scope hash is computed once per observation, before
               the payload is expanded.
             */
             obs.id AS observation_id,
             ${receiptFieldScopeHashSql("obs")} AS field_scope_hash
      FROM meta_raw_snapshot_observations obs
      WHERE obs.business_id = ${input.businessParam}
        AND obs.endpoint_name = 'campaign_configs'
${accountNarrowing('obs')}
        AND obs.entity_scope = 'campaign'
        AND obs.status = 'fetched'
        AND obs.provider_http_status = 200
        AND obs.request_context->'pagination'->>'complete' = 'true'
        AND obs.request_context->'pagination'->>'termination' = 'natural_end'
        AND ${effectiveSelectorHasToken("obs", "objective")}
        /*
          THREE admissible shapes, differing in what they can prove about TIME.
          See the module header for the full rule; in short, a MODERN row binds a
          run id and a per-entity page clock, a LEGACY SINGLE-PAGE row has one
          page so its aggregate observed_at IS its page time, and a LEGACY
          MULTI-PAGE row has neither and is admitted as evidence of a VALUE only.

          Nothing below filters on the shape: the tier does. Admission is decided
          by completeness and field scope alone, because requiring a run id would
          admit not one live row and would strand every approved source-backed
          repair outside the decision engine.
        */
        /*
          Bounded by the query's own scope so the existing index on observed_at
          prunes. Generous on both sides because this is the AGGREGATE clock;
          admission is still decided by the per-row page clock below.
        */
        AND obs.observed_at >= ${input.scopeStartParam}::date
          - INTERVAL '${OBSERVATION_CLOCK_SLACK_DAYS} days'
        AND obs.observed_at < ${input.scopeEndParam}::date
          + INTERVAL '${CORROBORATION_HORIZON_DAYS + OBSERVATION_CLOCK_SLACK_DAYS + 1} days'
      UNION ALL
      /*
        Snapshot-only legacy receipts. A real fetched 200 single-page response
        that never got an observation row: verified on production for the
        2026-07-25 ColorFull campaign and ad-set snapshots, which carry
        status fetched, HTTP 200, the right entity scope, complete/natural_end
        pagination at one page and the objective field requested, yet have zero
        observation rows. The historical repair path already accepts exactly
        this, so a reader that scans only observations erases every approved
        source-backed repair before it can reach a decision.

        The NOT EXISTS is the whole safety of it: the moment ANY observation
        exists for a canonical snapshot, that snapshot row describes the FIRST
        occurrence and must not be read as this one.
      */
      SELECT snap.id AS snapshot_id, snap.provider_account_id, snap.request_context,
             snap.fetched_at AS observed_at,
             FALSE AS is_modern,
             TRUE AS is_single_page,
             ${effectiveSelectorHasToken("snap", "updated_time")}
               AS requested_updated_time,
             /* No observation row exists, so no receipt id: an explicit NULL,
                never one inferred from the snapshot. */
             NULL::uuid AS observation_id,
             ${receiptFieldScopeHashSql("snap")} AS field_scope_hash
      FROM meta_raw_snapshots snap
      WHERE snap.business_id = ${input.businessParam}
        AND snap.endpoint_name = 'campaign_configs'
${accountNarrowing('snap')}
        AND snap.entity_scope = 'campaign'
        AND snap.status = 'fetched'
        AND snap.provider_http_status = 200
        AND snap.request_context->'pagination'->>'complete' = 'true'
        AND snap.request_context->'pagination'->>'termination' = 'natural_end'
        AND snap.request_context->'pagination'->>'pageCount' = '1'
        AND ${effectiveSelectorHasToken("snap", "objective")}
        AND snap.fetched_at >= ${input.scopeStartParam}::date
          - INTERVAL '${OBSERVATION_CLOCK_SLACK_DAYS} days'
        AND snap.fetched_at < ${input.scopeEndParam}::date
          + INTERVAL '${CORROBORATION_HORIZON_DAYS + OBSERVATION_CLOCK_SLACK_DAYS + 1} days'
        AND NOT EXISTS (
          SELECT 1 FROM meta_raw_snapshot_observations o WHERE o.snapshot_id = snap.id
        )
    ),
    account_tz AS MATERIALIZED (
      SELECT DISTINCT provider_account_id, account_timezone
      FROM (${input.scopeRelationSql}) tz(provider_account_id, campaign_id, date, account_timezone)
    ),
    compressed AS MATERIALIZED (
      /*
        The observation timeline, reduced to the sightings that can still win.

        A snapshot is re-observed about a hundred times and every sighting repeats
        the same payload, so the product with the entities is the cost. Three
        sightings per bucket survive, because those are the only ones any ordering
        this contract uses can select: the LAST at or before the cutoff (the
        same-day pick), the FIRST at or before it (a later day's bucket supplies
        the corroboration), and the LAST regardless of cutoff (the diagnostic).

        Two reductions were tried and rejected before this one, and the bucket is
        shaped by both failures. First-and-last alone is unsound: with sightings
        of one snapshot at 10:00, 14:00 and 18:00, a rival at 12:00 and a 15:00
        cutoff, dropping 14:00 lets the rival win. And bucketing by the UTC date
        is unsound: at UTC+3 a local day starts at 21:00 UTC, so sightings at
        01:00, 21:30 and 23:00 UTC span two LOCAL days inside one UTC day, and a
        UTC bucket drops the 21:30 sighting that is the next local day's
        corroboration. The bucket therefore keys on the ACCOUNT's local day.

        Modern rows pass through untouched: their clock is per entity, so a bucket
        keyed on the observation's own day could file one on the wrong side.
      */
      SELECT q.*, FALSE AS is_paged_within_day
      FROM qualifying q WHERE q.is_modern
      UNION ALL
      SELECT snapshot_id, provider_account_id, request_context, observed_at,
             is_modern, is_single_page, requested_updated_time,
             observation_id, field_scope_hash,
             is_paged_within_day
      FROM (
        SELECT q.*,
          /*
            Computed HERE because this is the only place the account timezone is
            in scope, and it is a per-row fact, so it rides through the bucket
            untouched. It is deliberately NOT part of the bucket key: two
            sightings that differ in it are still interchangeable except for
            their instant, and the three the bucket keeps are chosen by instant.
          */
          ${pagedWithinProviderDaySql("q", "tz.account_timezone")}
            AS is_paged_within_day,
          MAX(q.observed_at) FILTER (
            WHERE q.observed_at <= ${input.evaluationCutoffParam}::timestamptz
          ) OVER w AS last_before_cutoff,
          MIN(q.observed_at) FILTER (
            WHERE q.observed_at <= ${input.evaluationCutoffParam}::timestamptz
          ) OVER w AS first_before_cutoff,
          MAX(q.observed_at) OVER w AS last_overall
        FROM qualifying q
        JOIN account_tz tz ON tz.provider_account_id = q.provider_account_id
        WHERE NOT q.is_modern
        WINDOW w AS (
          PARTITION BY q.snapshot_id, q.provider_account_id,
            (q.observed_at AT TIME ZONE
              COALESCE(NULLIF(BTRIM(tz.account_timezone), ''), 'UTC'))::date,
            q.requested_updated_time, q.is_single_page
        )
      ) ranked
      WHERE observed_at = last_before_cutoff
         OR observed_at = first_before_cutoff
         OR observed_at = last_overall
    )
    SELECT
      q.provider_account_id,
      /*
        CARRIED FOR IDENTITY, not for content. Two admissible observations of the
        same entity can share an instant to the microsecond, and without a final
        tie-break the DISTINCT ON below resolves them by whatever the plan
        happens to deliver first — so the same query can answer differently
        across runs. This gives the ordering something stable to end on.
      */
      q.snapshot_id,
      /* The receipt itself, and the scope it asked under; see qualifying. */
      q.observation_id,
      q.field_scope_hash,
      entity.payload->>'id' AS campaign_id,
      /*
        A modern receipt must supply THIS entity's own page time. Falling back to
        the aggregate clock when one entity is missing from the map would date a
        row by the merge instant and still call it modern, which is how a
        multi-page receipt could hand out decision authority on a row it never
        actually timed. The aggregate clock is admissible ONLY for a verified
        single-page response, where there is exactly one page time and it is
        that one. Anything else yields NULL and is dropped below.
      */
      CASE
        WHEN q.is_modern
          THEN ${safeInstant("q.request_context->'rowObservedAtByEntityId'->>(entity.payload->>'id')")}
        WHEN q.is_single_page THEN q.observed_at
        /*
          A legacy MULTI-page receipt: the only clock it has describes the merged
          response, so this dates the row APPROXIMATELY. It is carried so the
          value is not lost, and every tier below caps such a row at review only.
        */
        WHEN NOT q.is_modern THEN q.observed_at
        ELSE NULL
      END AS row_observed_at,
      /*
        NULL-safe on purpose. A pageCount can be absent or malformed, and then
        is_single_page is NULL rather than FALSE, so NOT is_single_page is NULL
        too and a downstream NOT COALESCE(flag, FALSE) reads TRUE — handing a
        malformed legacy receipt the authority this tier exists to withhold.
        IS NOT TRUE makes anything that is not a PROVEN single page uncertain,
        which is the fail-closed direction.
        (No backticks in this block: it sits inside a template literal.)

        A multi-page receipt that PROVED its whole pagination ran inside one
        provider-local day is no longer uncertain about the INTERVAL: whichever
        page held the row, that page was fetched inside this day. It stays legacy
        and stays below a point observation, but it may end a bracket — which is
        the difference between a permanently paged account being read and being
        held forever. Still fail-closed: the flag is FALSE unless proven.
      */
      (NOT q.is_modern AND q.is_single_page IS NOT TRUE
        AND NOT q.is_paged_within_day) AS is_interval_uncertain,
      q.is_paged_within_day,
      q.is_modern,
      q.requested_updated_time,
      CASE
        WHEN q.is_modern THEN 'modern'
        WHEN q.is_single_page IS NOT TRUE THEN 'legacy_multi_page'
        WHEN EXISTS (
          SELECT 1 FROM meta_raw_snapshot_observations o WHERE o.snapshot_id = q.snapshot_id
        ) THEN 'legacy_observed'
        ELSE 'legacy_snapshot_only'
      END AS source_class,
      BTRIM(entity.payload->>'objective') AS objective,
      entity.payload->>'updated_time' AS entity_updated_time
    FROM compressed q
    /*
      Completeness, status and field scope came from the OBSERVATION row above:
      the canonical raw row is first-occurrence metadata and its content is
      deduplicated across observations, so only the payload VALUE may come from
      the snapshot. The join matches business, account, endpoint and scope too,
      and fails closed when shared content does not line up.
    */
    JOIN meta_raw_snapshots snap
      ON snap.id = q.snapshot_id
     AND snap.business_id = ${input.businessParam}
     AND snap.provider_account_id = q.provider_account_id
     AND snap.endpoint_name = 'campaign_configs'
     AND snap.entity_scope = 'campaign'
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(snap.payload_json) = 'array'
        THEN snap.payload_json ELSE '[]'::jsonb END
    ) AS entity(payload)
    /* Expand only the campaigns the caller needs; see campaignScopeSql. */
    JOIN (${input.campaignScopeSql}) wanted(campaign_id)
      ON wanted.campaign_id = entity.payload->>'id'
    /*
      No filter on the VALUE. A receipt that requested objective and came back
      without it is an OBSERVED ABSENCE, and dropping the row would leave the
      previous day's value standing as though the receipt that disproves it had
      never arrived — a stale objective surviving its own refutation.
    */
    WHERE
      /* Drops a modern row whose entity is absent from the page-clock map. */
      (CASE
        WHEN q.is_modern
          THEN ${safeInstant("q.request_context->'rowObservedAtByEntityId'->>(entity.payload->>'id')")}
        WHEN q.is_single_page THEN q.observed_at
        WHEN NOT q.is_modern THEN q.observed_at
        ELSE NULL
      END) IS NOT NULL
  )`;

  /*
    Resolution, computed once per (account, campaign, day) and joined on equality.

    As three correlated laterals this re-scanned the whole materialised receipts
    set once per ad-day, which is what took a 9,241-ad-day calibration read to
    307 seconds. The ad-set contract already resolves per entity and day once;
    this is the same shape at campaign grain.

    The cutoff bounds the CANDIDATES, never the winner: ranking without it picks a
    post-cutoff sighting and the later test then rejects it, losing the pre-cutoff
    row the run could have used. The corroboration pick takes the FIRST later
    sighting, agreeing or not, so a disagreeing one refuses the bracket rather
    than being skipped for a reverted match further out. The diagnostic pick
    ignores the cutoff on purpose and stands apart.
  */
  const cutoffAt = `${input.evaluationCutoffParam}::timestamptz`;
  const restatedAlias = `${p}_restated`;
  /*
    The scope join, hoisted. See `resolutionScopeCte` for the measurement that
    motivated it. Inside this relation the day is `r.date` and the account
    timezone is `r.resolved_account_timezone`, which the join proved equal to the
    coalesced scope timezone.
  */
  const scopedCte = `${p}_scoped`;
  const rowTz = "r.resolved_account_timezone";
  const rowDayStart = `(r.date::timestamp AT TIME ZONE ${rowTz})`;
  const rowDayEnd = `((r.date + 1)::timestamp AT TIME ZONE ${rowTz})`;

  const resolutionCte = (kind: "day" | "next" | "restated"): string => {
    const alias = kind === "day" ? sameDay : kind === "next" ? after : restatedAlias;
    const window =
      kind === "next"
        ? `      AND r.row_observed_at >= ${rowDayEnd}
      AND r.row_observed_at < ${rowDayEnd}
        + INTERVAL '${CORROBORATION_HORIZON_DAYS} days'
      AND r.row_observed_at <= ${cutoffAt}`
        : kind === "day"
          ? `      AND r.row_observed_at >= ${rowDayStart}
      AND r.row_observed_at < ${rowDayEnd}
      AND r.row_observed_at <= ${cutoffAt}`
          : `      AND r.row_observed_at >= ${rowDayStart}
      AND r.row_observed_at < ${rowDayEnd}`;
    return `${alias} AS MATERIALIZED (
    SELECT DISTINCT ON (r.provider_account_id, r.campaign_id, r.date)
      r.provider_account_id, r.campaign_id, r.date,
      r.objective, r.entity_updated_time, r.is_modern, r.source_class,
      r.row_observed_at, r.requested_updated_time, r.is_interval_uncertain,
      r.is_paged_within_day,
      /* The identity of the row this pick chose, for evidenceRefSql. */
      r.snapshot_id, r.observation_id, r.field_scope_hash
    FROM ${scopedCte} r
    WHERE TRUE
${window}
    ORDER BY r.provider_account_id, r.campaign_id, r.date,
             r.row_observed_at ${kind === "next" ? "ASC" : "DESC"},
             ${RESOLUTION_TIE_BREAK_SQL}
  )`;
  };

  /*
    ── A SINGLE-ROW LOOKUP, NOT A RE-DERIVATION ────────────────────────────────

    A plain `LEFT JOIN <relation> ON <three equalities>` makes the CTE Scan emit
    the WHOLE relation and filters above it, once per output row. Measured on
    production (Bilsem, 9,117 output rows): the nine such joins emitted 44.1M
    rows for at most 9,117 matches, because a materialised CTE has no index and
    the planner estimates it at one row, so it picks a nested loop and re-reads
    everything.

    Each of these relations is `DISTINCT ON (account, entity, date)`, so AT MOST
    ONE row can match the three equalities. Pushing them inside a lateral with
    LIMIT 1 therefore cannot drop a match or choose a different one; it only lets
    the scan stop when it finds the row instead of reading past it. Paired
    read-only runs, alternating which form goes first: 8/8 rounds faster on both
    accounts, median 0.76 (Bilsem 8,723 -> 6,743 ms) and 0.77 (TheSwaf 4,127 ->
    3,103 ms), with the full result set bit-identical.

    THIS IS NOT THE LATERAL THIS CONTRACT WITHDREW. That one re-derived the
    answer per ad-day by ranking the whole receipt table inside the lateral. The
    reduction still happens exactly once, set-based, in the DISTINCT ON above;
    what is lateral here is only the lookup of one already-decided row.
  */
  const joinFor = (alias: string): string => `
  LEFT JOIN LATERAL (
    SELECT * FROM ${alias} hit
    WHERE hit.provider_account_id = ${input.accountExpression}
      AND hit.campaign_id = ${input.campaignExpression}
      AND hit.date = ${input.dayExpression}
    LIMIT 1
  ) ${alias} ON TRUE`;
  /*
    The contemporaneous typed witness, also extracted once.

    As a per-row lateral this was the query's hot spot: the receipts CTE costs
    4,432 buffer hits, but the witness lateral cost roughly 5,500 hits PER ROW,
    which is what took a 100-row probe to 555,542 hits. One scan of the scope
    with the guards expressed as aggregates removes that.

    The four guards, each ruling out one way the value lies:
      - both clocks inside the provider-local day, because the upsert does
        objective = COALESCE(EXCLUDED.objective, existing) while advancing
        updated_at unconditionally, so a same-day updated_at alone proves
        nothing while a same-day created_at means every write it ever received
        happened inside the day;
      - exactly one ad behind the row;
      - the row's real_ad_id resolving to this campaign at ad grain, because
        meta_creative_daily.ad_id is a creative hash and the writer coalesces the
        campaign relation on merge;
      - one consistent value across the day. That last one is counted over EVERY
        positive-spend row with a non-null objective, not only the admitted ones,
        so a disagreeing row that fails another guard still refuses the day.
  */
  /*
    ── THE WITNESS SCAN, NARROWED TO THE SCOPE ────────────────────────────────

    Measured with EXPLAIN (no ANALYZE) on the largest live account, 90 days, at a
    local day-end cutoff: this CTE was 151,034 of the statement's 172,430
    estimated cost — 87.6% of it, and far more than the receipt scans or the day
    resolution. The reason is in the plan: it scanned meta_creative_daily by
    business and date only, then ran a correlated EXISTS against meta_ad_daily
    for EVERY row it found.

    Every one of those rows outside the scope is then thrown away: the lateral
    below matches on provider_account_id, campaign_id and date. So the narrowing
    removes work whose result was never read.

    PARITY IS STRUCTURAL, not a hope. The GROUP BY key is
    (provider_account_id, campaign_id, date) — exactly the columns being narrowed
    — so no surviving group can lose a row, and `distinct_values`, which counts
    across a group, cannot change. A group that disappears entirely is one the
    lateral could never have selected.
  */
  const witnessNarrowing = [
    accountNarrowingSql("cre", input.accountScopeSql).replace(
      /^ {8}AND/,
      "      AND",
    ),
    `      AND cre.campaign_id IN (${input.campaignScopeSql})`,
  ]
    .filter(Boolean)
    .join("\n");

  const witnessCte = `${witness}_scope AS MATERIALIZED (
    SELECT
      cre.provider_account_id,
      cre.campaign_id,
      cre.date,
      /*
        The disagreement guard is as-of too: a contradiction that only appears
        after the cutoff could not have refused a decision the run already made.
      */
      COUNT(DISTINCT BTRIM(cre.objective)) FILTER (
        WHERE NULLIF(BTRIM(cre.objective), '') IS NOT NULL
          AND cre.updated_at <= ${input.evaluationCutoffParam}::timestamptz
      ) AS distinct_values,
      MIN(BTRIM(cre.objective)) FILTER (WHERE ${p}_admits.ok) AS admitted_objective,
      BOOL_OR(${p}_admits.ok) AS has_admitted,
      MAX(cre.updated_at) FILTER (WHERE ${p}_admits.ok) AS last_updated_at
    FROM meta_creative_daily cre
    CROSS JOIN LATERAL (
      SELECT (
        NULLIF(BTRIM(cre.objective), '') IS NOT NULL
        /* As-of: a witness row written after the cutoff is not evidence the run
           had, and must not displace an older one that was. */
        AND cre.updated_at <= ${input.evaluationCutoffParam}::timestamptz
        AND cre.created_at >= (cre.date::timestamp AT TIME ZONE
          COALESCE(NULLIF(BTRIM(cre.account_timezone), ''), 'UTC'))
        AND cre.updated_at < ((cre.date + 1)::timestamp AT TIME ZONE
          COALESCE(NULLIF(BTRIM(cre.account_timezone), ''), 'UTC'))
        AND COALESCE(${safeCast("cre.payload_json->>'associated_ads_count'", "integer")}, 1) <= 1
        AND EXISTS (
          SELECT 1
          FROM meta_ad_daily anchor
          WHERE anchor.business_id = cre.business_id
            AND anchor.provider_account_id = cre.provider_account_id
            AND anchor.date = cre.date
            AND anchor.ad_id = cre.payload_json->>'real_ad_id'
            AND anchor.campaign_id = cre.campaign_id
        )
      ) AS ok
    ) ${p}_admits
    WHERE cre.business_id = ${input.businessParam}
      AND cre.date BETWEEN ${input.scopeStartParam}::date AND ${input.scopeEndParam}::date
      AND cre.spend > 0
${witnessNarrowing}
    GROUP BY 1, 2, 3
  )`;

  const witnessLateral = `
  LEFT JOIN LATERAL (
    SELECT w.admitted_objective AS objective, w.last_updated_at
    FROM ${witness}_scope w
    WHERE w.provider_account_id = ${input.accountExpression}
      AND w.campaign_id = ${input.campaignExpression}
      AND w.date = ${input.dayExpression}
      AND w.has_admitted
      AND w.distinct_values = 1
    LIMIT 1
  ) ${witness} ON TRUE`;

  const bracketAgrees = `(${sameDay}.objective IS NOT NULL
      /* Both responses must have requested the clock the bracket reads. */
      AND ${sameDay}.requested_updated_time
      AND ${after}.requested_updated_time
      AND ${sameDay}.entity_updated_time IS NOT NULL
      AND ${safeInstant(`${sameDay}.entity_updated_time`)} <= ${dayStart}
      AND ${after}.row_observed_at IS NOT NULL
      AND ${after}.objective = ${sameDay}.objective
      AND ${after}.entity_updated_time IS NOT DISTINCT FROM ${sameDay}.entity_updated_time)`;
  const bothModern = `(${sameDay}.is_modern AND ${after}.is_modern)`;
  /* A receipt whose page time is unknowable cannot anchor either end. */
  const bracketEndsAreTimed =
    `(NOT COALESCE(${sameDay}.is_interval_uncertain, FALSE)
      AND NOT COALESCE(${after}.is_interval_uncertain, FALSE))`;
  /*
    Authority additionally requires that BOTH ends were already visible at the
    evaluation cutoff. A corroboration that arrived after it is real evidence
    about today and says nothing about what that run could have used.
  */
  const knownAtCutoff = `(${sameDay}.row_observed_at <= ${input.evaluationCutoffParam}::timestamptz
      AND ${after}.row_observed_at <= ${input.evaluationCutoffParam}::timestamptz)`;
  /*
    A value is AVAILABLE to a decision only if its own evidence predates the
    cutoff. Marking a future value as restated and still returning it is not
    enough: hydration would take it for objective and cohort and the flag would
    sit unread beside it. So the future value is returned by its own diagnostic
    accessor, and every tier below is bounded by these predicates too, which
    keeps the tier and the value from ever disagreeing.
  */
  const receiptAvailable = `(${sameDay}.objective IS NOT NULL
      AND ${sameDay}.row_observed_at <= ${input.evaluationCutoffParam}::timestamptz)`;
  /*
    The receipt SPOKE for this day: it was admitted, requested the field, and its
    payload either carried a value or did not. That distinction outranks the typed
    witness — a provider saying "there is none" must not be overwritten by a
    derived daily value from before it, or the absence is silently healed and the
    stale value lives on under a different name.
  */
  /*
    The corroboration window for this day has not elapsed yet: the day ended less
    than the horizon ago, measured against the cutoff the decision is made at.
  */
  const corroborationPending =
    `((${dayEnd} + INTERVAL '${CORROBORATION_HORIZON_DAYS} days')
      > ${input.evaluationCutoffParam}::timestamptz)`;
  const receiptSpoke = `(${sameDay}.row_observed_at IS NOT NULL
      AND ${sameDay}.row_observed_at <= ${input.evaluationCutoffParam}::timestamptz)`;
  const witnessAvailable = `(NULLIF(BTRIM(${witness}.objective), '') IS NOT NULL
      AND ${witness}.last_updated_at <= ${input.evaluationCutoffParam}::timestamptz)`;

  const tierSql = (): string => `(CASE
      /* The day attached to a receipt is unknowable without the account zone. */
      WHEN NULLIF(BTRIM(${input.timezoneExpression}), '') IS NULL THEN 'unknown'
      WHEN ${bracketAgrees} AND ${knownAtCutoff} AND ${bracketEndsAreTimed} AND ${bothModern}
        THEN 'provider_receipt_day_bracketed'
      WHEN ${bracketAgrees} AND ${knownAtCutoff} AND ${bracketEndsAreTimed}
        THEN 'provider_receipt_legacy_bracketed'
      WHEN ${receiptAvailable} AND ${sameDay}.is_interval_uncertain
        THEN 'provider_receipt_legacy_interval_uncertain'
      /* Named apart from a settled gap: the window simply has not elapsed. */
      WHEN ${receiptAvailable} AND ${corroborationPending}
        THEN 'provider_receipt_pending_corroboration'
      WHEN ${receiptAvailable} AND ${sameDay}.is_modern
        THEN 'provider_receipt_point_in_day'
      /* Multi-page, but the pagination is proven to fit inside this local day.
         Named apart from the single-page receipt so the ladder never claims one
         page where there were nine. */
      WHEN ${receiptAvailable} AND ${sameDay}.is_paged_within_day
        THEN 'provider_receipt_legacy_paged_within_day'
      WHEN ${receiptAvailable}
        THEN 'provider_receipt_legacy_single_page'
      /* Ordered ABOVE the witness: an observed absence is a provider statement
         and a derived daily value must not mask it. */
      WHEN ${receiptSpoke} THEN 'observed_absent'
      WHEN ${witnessAvailable} THEN 'typed_contemporaneous'
      ELSE 'unknown'
    END)`;

  const pitClassSql = (): string => `(CASE
      WHEN ${sameDay}.row_observed_at IS NOT NULL
        AND ${sameDay}.row_observed_at <= ${input.evaluationCutoffParam}::timestamptz
        THEN 'as_of_known'
      WHEN ${witness}.last_updated_at IS NOT NULL
        AND ${witness}.last_updated_at <= ${input.evaluationCutoffParam}::timestamptz
        THEN 'as_of_known'
      ELSE 'restated'
    END)`;
  const sourceClassSql = (): string => `COALESCE(${sameDay}.source_class, CASE
      WHEN NULLIF(BTRIM(${witness}.objective), '') IS NOT NULL THEN 'typed_unlinked'
      ELSE 'none'
    END)`;

  return {
    contractVersion: META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION,
    cteName,
    withSql: [
      withSql,
      entityDayCompressionCte({
        name: entityDayCte,
        source: cteName,
        entityColumn: "campaign_id",
        scopeRelationSql: input.scopeRelationSql,
        cutoff: cutoffAt,
        extraPartitionColumns: [],
      }),
      resolutionScopeCte({
        name: scopedCte,
        entityDayCte,
        entityColumn: "campaign_id",
        scopeRelationSql: input.scopeRelationSql,
        horizonDays: CORROBORATION_HORIZON_DAYS,
      }),
      resolutionCte("day"),
      resolutionCte("next"),
      ...(includeRestated ? [resolutionCte("restated")] : []),
      witnessCte,
    ].join(",\n  "),
    lateralSql: `${joinFor(sameDay)}${joinFor(after)}${
      includeRestated ? joinFor(restatedAlias) : ""
    }${witnessLateral}`,
    valueSql: () => `(CASE
      WHEN ${receiptAvailable} THEN ${sameDay}.objective
      /* The receipt spoke and had none: that is the answer, not the witness. */
      WHEN ${receiptSpoke} THEN NULL
      WHEN ${witnessAvailable} THEN BTRIM(${witness}.objective)
      ELSE NULL
    END)`,
    restatedValueSql: () => {
      if (!includeRestated) {
        throw new Error(
          "restatedValueSql needs includeRestated: the diagnostic relation is not emitted",
        );
      }
      return `(CASE
      WHEN ${restatedAlias}.objective IS NOT NULL THEN ${restatedAlias}.objective
      /* Today's warehouse also holds the absence, if that is what the day ends on. */
      WHEN ${restatedAlias}.row_observed_at IS NOT NULL THEN NULL
      WHEN NULLIF(BTRIM(${witness}.objective), '') IS NOT NULL
        THEN BTRIM(${witness}.objective)
      ELSE NULL
    END)`;
    },
    tierSql,
    pitClassSql,
    sourceClassSql,
    readinessSql: () => readinessCaseSql(tierSql()),
    evidenceRefSql: (field) =>
      configFieldEvidenceRefSql({
        prefix: p,
        field,
        tierSql: tierSql(),
        sourceClassSql: sourceClassSql(),
        pitClassSql: pitClassSql(),
        sameDayAlias: sameDay,
        corroborationAlias: after,
      }),
  };
}

/*
 * There is deliberately NO helper here for "may an objective withhold a Cut".
 *
 * One existed and its comment overreached twice. The approved plan says an
 * economic Cut with otherwise sufficient evidence will not be held solely because
 * of ROLE uncertainty. It says nothing about objective uncertainty releasing a Cut
 * finding, and the two are not the same shape: role uncertainty leaves the
 * economics intact and clouds who owns the budget, while objective selects the
 * cohort, the cohort selects the target, and without a target there is no
 * break-even to be below.
 *
 * The pipeline already behaves correctly for both. A role-uncertain Cut keeps its
 * verdict and is presented as an operator action (lib/meta/decision-semantics.ts).
 * A missing objective terminates at scopeGate (engine.ts:78) through
 * computeSoftOnlyNativeAdDecisions, which forbids action and high confidence. A
 * review-only economic verdict path for objective-uncertain ads would be a scope
 * expansion with its own negative controls to design, not an application of D097,
 * and it is not added here.
 */



/* ────────────────────────────────────────────────────────────────────────────
 * Ad-set scope
 *
 * A separate contract, not a parameter of the campaign one, because the two
 * answer questions at different grains and conflating them is the specific
 * error this repair exists to undo: one campaign can hold ad sets with
 * different optimization goals, so a campaign-scoped goal would be wrong for
 * all but one of them. Campaign receipts do not even carry the field — a live
 * 200 `campaign_configs` element holds id, name, objective, status,
 * effective_status, buying_type, bid_strategy, daily_budget, lifetime_budget and
 * updated_time, and nothing else.
 *
 * What ad sets DO have is a working source. `adset_configs` never broke: in
 * 2026-09 alone it carries 31,470 successful observations, 25,742 of them single
 * page, against zero for `campaign_configs` in the same month. So unlike
 * objective, an ad-set goal can reach decision authority today — through the
 * legacy single-page path, since no `adset_configs` observation in July, August
 * or September carries a run id or a per-entity clock map.
 *
 * The admission RULES are shared with the campaign contract rather than
 * restated: same completeness test, same clock selection, same bracket, same
 * cutoff. Only the endpoint, the entity id and the fields differ.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The ad-set fields this contract governs, and where each lives in the payload. */
export const META_CONFIG_CONTRACT_ADSET_FIELDS = [
  "optimization_goal",
  "custom_event_type",
  /*
    `custom_conversion_id` IS GOVERNED, and it has to be, because the rule that
    reads a missing `custom_event_type` as "the provider configured no conversion
    target" is only sound if the OTHER field that can carry a target was looked
    at. Meta's promoted object carries them as separate fields: an ad set may name
    a custom conversion instead of a standard event and still be optimising for
    purchases.

    Live today no spending ad-set-day in 2026-08-25..09-20 carries one, so this
    column is all NULLs on the current cohort. That is exactly why it is added
    now rather than when the first one appears: a safeguard nothing supplies is
    not a safeguard, and the failure it prevents (calling a real purchase target
    an absence) is silent.
  */
  "custom_conversion_id",
] as const;

export type MetaConfigContractAdsetField =
  (typeof META_CONFIG_CONTRACT_ADSET_FIELDS)[number];

/**
 * Where each governed ad-set field sits in a retained `adset_configs` element.
 *
 * `optimization_goal` is top level. `custom_event_type` is NOT: it lives inside
 * `promoted_object`, beside `pixel_id`, and is present on only some ad sets (258
 * of 436 elements in a live payload). Reading it from the wrong place would
 * produce a confident NULL for every ad set, which is the shape of failure this
 * whole area keeps producing.
 */
const ADSET_FIELD_PATH: Record<MetaConfigContractAdsetField, string> = {
  optimization_goal: "payload->>'optimization_goal'",
  custom_event_type: "payload->'promoted_object'->>'custom_event_type'",
  custom_conversion_id:
    "payload->'promoted_object'->>'custom_conversion_id'",
};

export interface MetaAdsetConfigFieldSourceSqlInput
  extends Omit<
    MetaConfigFieldSourceSqlInput,
    "campaignExpression" | "campaignScopeSql"
  > {
  /**
   * SQL yielding the AD-SET ids the caller needs, e.g.
   * "SELECT DISTINCT adset_id FROM scope".
   *
   * Named for what it carries. It was briefly inherited as `campaignScopeSql`,
   * and a caller who obeyed that name would pass campaign ids, which join against
   * nothing in an `adset_configs` payload and silently return no entities at all —
   * a total, quiet loss that reads as "no evidence exists".
   */
  adsetScopeSql: string;
  /** SQL expression for the ad-set id; the grain the goal actually belongs to. */
  adsetExpression: string;
  /**
   * SQL yielding the provider account ids in scope, e.g. "SELECT $4::text".
   *
   * Narrows the receipt scan before anything else happens. The only index on
   * `meta_raw_snapshot_observations` for this access path is
   * (business_id, provider_account_id, endpoint_name, observed_at), and without
   * an account predicate the scan stops using it after its first column.
   * Measured on the largest live account with EXPLAIN (no ANALYZE): the
   * observation scan falls from ~42k to ~4.5k estimated cost and the statement
   * total from 273k to 172k.
   *
   * NOT A PERFORMANCE FIX ON ITS OWN — the same statement still exceeded 30s in
   * a real historical run, with the snapshot anti-join and the creative witness
   * dominating what remains. It is included because it is correct and cheap, not
   * because it closes the budget.
   *
   * Optional, and omitting it changes no result: it is a narrowing of rows the
   * scope relation would reject anyway.
   */
  accountScopeSql?: string;
  /**
   * A SQL relation yielding the caller's own scope, with exactly these columns in
   * this order: (provider_account_id, adset_id, date, account_timezone).
   *
   * Required because resolution is SET-BASED: the in-day latest and the after-day
   * first evidence are computed ONCE per (account, ad-set, day) and joined on
   * equality, instead of four correlated laterals re-scanning the whole receipt
   * set per ad-day. The ranking still runs over the receipt rows themselves, so
   * every observation's own selector flags and page clock take part in choosing
   * the winner — nothing is compressed away, only the ANSWER is reduced to one
   * row per field and day. That is the difference from the withdrawn
   * earliest/latest compression, which reduced the observations instead.
   */
  scopeRelationSql: string;
  /** Distinct alias prefix, so one query can carry several instances. */
  aliasPrefix?: string;
  /**
   * Emit the RESTATED diagnostic resolution, and its join, at all.
   *
   * Off by default, because it is not free and almost nobody reads it. It is a
   * whole extra `DISTINCT ON` relation plus a `LEFT JOIN` that the final SELECT
   * re-scans once per output row, and a relation nothing reads is a relation
   * nothing needs. Measured read-only on production (Bilsem, 9,117 output rows):
   * the two AD-SET diagnostic joins alone were 11.1 M of the 44.1 M row touches
   * in the final join and ~1.2 s of a ~9.4 s query, with the result set
   * bit-identical once they were removed.
   *
   * Of the two production readers, `data-source.ts` reads no restated value at
   * any grain, and `ad-calibration-job.ts` reads only the CAMPAIGN one. So the
   * default is what both of them actually want, and the one caller that needs
   * the diagnostic asks for it.
   *
   * `restatedValueSql` THROWS when this is off rather than naming a relation the
   * query does not contain, so the mistake is a build-time error and never a
   * SQL one.
   */
  includeRestated?: boolean;
}

export interface MetaAdsetConfigFieldSourceSql {
  contractVersion: string;
  cteName: string;
  withSql: string;
  lateralSql: string;
  valueSql(field: MetaConfigContractAdsetField): string;
  restatedValueSql(field: MetaConfigContractAdsetField): string;
  tierSql(field: MetaConfigContractAdsetField): string;
  readinessSql(field: MetaConfigContractAdsetField): string;
  sourceClassSql(field: MetaConfigContractAdsetField): string;
  pitClassSql(field: MetaConfigContractAdsetField): string;
  /** See `MetaConfigFieldSourceSql.evidenceRefSql`; same shape, ad-set grain. */
  evidenceRefSql(field: MetaConfigContractAdsetField): string;
}

export function buildMetaAdsetConfigFieldSourceSql(
  input: MetaAdsetConfigFieldSourceSqlInput,
): MetaAdsetConfigFieldSourceSql {
  const p = input.aliasPrefix ?? "adsetcfg";
  const includeRestated = input.includeRestated ?? false;
  const cteName = `${p}_receipts`;
  /* The post-expansion, per-(entity, provider-local day) compression. */
  const entityDayCte = `${p}_entity_day`;
  const tz = `COALESCE(NULLIF(BTRIM(${input.timezoneExpression}), ''), 'UTC')`;
  const dayStart = `(${input.dayExpression}::timestamp AT TIME ZONE ${tz})`;
  const dayEnd = `((${input.dayExpression} + 1)::timestamp AT TIME ZONE ${tz})`;
  const cutoff = `${input.evaluationCutoffParam}::timestamptz`;

  /*
    Selector tokens, per field. `custom_event_type` is NOT a top-level field: it
    lives inside `promoted_object`, so the selector token that authorises it is
    `promoted_object`. Requiring the literal field name would reject every
    response that legitimately carries it.
  */
  const SELECTOR_TOKEN: Record<MetaConfigContractAdsetField, string> = {
    optimization_goal: "optimization_goal",
    custom_event_type: "promoted_object",
    /* Same container, same authorising token. */
    custom_conversion_id: "promoted_object",
  };
  const topLevelToken = effectiveSelectorHasToken;

  /*
    FIELDS THAT SHARE A RECEIPT SHARE A RESOLUTION.

    `custom_event_type` and `custom_conversion_id` are two keys of the SAME
    `promoted_object`, authorised by the same selector token, so the in-day
    winner, the corroborating observation and the restated pick are the same rows
    for both. Resolving them separately means three more MATERIALIZED CTEs over
    the whole receipt set for an answer already computed — measured at roughly
    +50% on the ad-set side of a 90-day account, against a 30s statement budget
    with very little headroom.

    Each member still carries its OWN value column, so the bracket's agreement
    test stays per field: a `custom_event_type` that agreed at both ends cannot
    lend its bracket to a `custom_conversion_id` that changed.
  */
  const RESOLUTION_LEAD: Record<
    MetaConfigContractAdsetField,
    MetaConfigContractAdsetField
  > = {
    optimization_goal: "optimization_goal",
    custom_event_type: "custom_event_type",
    custom_conversion_id: "custom_event_type",
  };
  const RESOLUTION_LEADS = META_CONFIG_CONTRACT_ADSET_FIELDS.filter(
    (field) => RESOLUTION_LEAD[field] === field,
  );
  /*
    The grouping is only sound while the members share a selector token: the
    group's WHERE uses the LEAD's `requested_*` flag, which is the same predicate
    as a member's only when the same token authorises both. Checked here rather
    than trusted, because a field added to a group with a different token would
    otherwise be silently gated by someone else's selector.
  */
  for (const field of META_CONFIG_CONTRACT_ADSET_FIELDS) {
    const lead = RESOLUTION_LEAD[field];
    if (SELECTOR_TOKEN[field] !== SELECTOR_TOKEN[lead]) {
      throw new Error(
        `Ad-set config field ${field} shares a resolution with ${lead} but not its selector token.`,
      );
    }
  }
  const membersOf = (lead: MetaConfigContractAdsetField) =>
    META_CONFIG_CONTRACT_ADSET_FIELDS.filter(
      (field) => RESOLUTION_LEAD[field] === lead,
    );
  const valueCol = (field: MetaConfigContractAdsetField) => `value_${field}`;
  const sameDayAlias = (field: MetaConfigContractAdsetField) =>
    `${p}_${RESOLUTION_LEAD[field]}_day`;
  const corrobAlias = (field: MetaConfigContractAdsetField) =>
    `${p}_${RESOLUTION_LEAD[field]}_next`;

  const fieldColumns = META_CONFIG_CONTRACT_ADSET_FIELDS.map(
    (field) => `      BTRIM(entity.${ADSET_FIELD_PATH[field]}) AS ${field}`,
  ).join(",\n");
  const requestedColumns = RESOLUTION_LEADS.map(
    (field) => `      q.requested_${field}`,
  ).join(",\n");
  /** The same list, qualified for a CTE that aliases the source as q. */
  const requestedColumnsQualified = RESOLUTION_LEADS.map(
    (field) => `             q.requested_${field}`,
  ).join(",\n");
  /** And unqualified, for a CTE selecting straight out of the previous one. */
  const requestedColumnsBare = RESOLUTION_LEADS.map(
    (field) => `             requested_${field}`,
  ).join(",\n");
  const anySelector = (alias: string): string =>
    RESOLUTION_LEADS.map((field) =>
      topLevelToken(alias, SELECTOR_TOKEN[field]),
    ).join("\n          OR ");
  /*
    ONE FLAG PER RESOLUTION, not per field. Each flag is an
    `effectiveSelectorHasToken` test — a `regexp_replace` over the response's
    field list, evaluated for every receipt row — and two fields sharing a token
    produced two identical regexes per row. Measured on the live account with the
    largest window (8,985 ad-days), emitting the duplicate cost ~3s of a 30s
    statement budget for an answer already computed.
  */
  const requestedFlags = (alias: string): string =>
    RESOLUTION_LEADS.map(
      (field) =>
        `             ${topLevelToken(alias, SELECTOR_TOKEN[field])} AS requested_${field}`,
    ).join(",\n");

  /*
    WITHDRAWN OPTIMIZATION, recorded so it is not reintroduced blind.
    An earlier version compressed the observation timeline to the earliest and
    latest sighting per (snapshot, account, provider-local day). It was faster and
    it was wrong in three independent ways, all of which come from treating
    observations of one snapshot as interchangeable:
      - they are not: the same canonical snapshot can be re-observed under a
        DIFFERENT request_context, so an inner observation may be the only one
        whose effective selector requested promoted_object or optimization_goal,
        and compressing to the extremes silently drops that field's authority;
      - modern and legacy rows do not share clock semantics, so a bucket holding
        both mixes a per-entity page clock with an aggregate one;
      - a per-entity rowObservedAt can fall on a DIFFERENT provider-local day than
        its observation's aggregate observed_at (midnight pagination), so bucketing
        by the aggregate clock can discard the row that actually belongs to the
        day being asked about.
    A correct compression would have to partition by the requested_* flags and the
    clock semantics, and for modern rows happen only AFTER the entity join where
    the real clock is known. That is worth doing against a narrow materialised
    source table, not inside a read-time query, so it is left undone rather than
    approximated.

    What REMAINS is exact: each distinct snapshot is expanded once instead of once
    per observation. That is not a compression of the timeline, only of repeated
    work on identical content — on production there are 100.1 observations per distinct snapshot
    for this endpoint, so a 436-element payload was being exploded a hundred
    times over. Expand each distinct snapshot ONCE, then join the per-observation
    clocks back onto it.
  */
  /*
    NOT COMPRESSED, deliberately.

    The ad-set contract reduces its observation timeline to three sightings per
    bucket, and the same was briefly done here. It was withdrawn for two reasons,
    in this order.

    It was not equivalent. The bucket keyed the provider-local day off
    `observed_at AT TIME ZONE 'UTC'`, but every pick this contract makes is in the
    ACCOUNT's timezone. At UTC+3 a local day starts at 21:00 UTC, so sightings at
    01:00, 21:30 and 23:00 UTC span two local days inside one UTC day: the bucket
    kept 01:00 and 23:00 and dropped 21:30, which is the first sighting of the
    next local day and therefore the corroboration candidate. A rival snapshot at
    22:00 could then win a day it should not. Bucketing correctly needs the
    account timezone, which this builder is not given — the ad-set one takes a
    scope relation and so can.

    And it bought nothing: on the live calibration worst case the 90-day read
    measured 312.7s before and 307.1s after, so the campaign side's cost is not
    in the observation timeline at all. An optimisation that is not equivalent and
    does not pay is not worth the timezone input it would need.
  */
  /** See `accountScopeSql`: a no-op when the caller did not supply a scope. */
  const accountNarrowing = (alias: string): string =>
    accountNarrowingSql(alias, input.accountScopeSql);

  const withSql = `${cteName} AS MATERIALIZED (
    WITH qualifying AS (
      /* Observation-backed, and snapshot-only legacy, admitted on the same terms
         as the campaign contract. */
      SELECT obs.snapshot_id, obs.provider_account_id, obs.observed_at,
             (obs.run_id IS NOT NULL
              AND obs.request_context ? 'rowObservedAtByEntityId') AS is_modern,
             (obs.request_context->'pagination'->>'pageCount' = '1') AS is_single_page,
             obs.request_context,
             /* The bracket reads updated_time, so the response must have asked
                for it; otherwise its absence is a selector artefact, not a fact. */
             ${topLevelToken("obs", "updated_time")} AS requested_updated_time,
${requestedFlags("obs")},
             TRUE AS has_observation,
             /* Receipt identity; see the campaign contract's qualifying CTE. */
             obs.id AS observation_id,
             ${receiptFieldScopeHashSql("obs")} AS field_scope_hash
      FROM meta_raw_snapshot_observations obs
      WHERE obs.business_id = ${input.businessParam}
        AND obs.endpoint_name = 'adset_configs'
${accountNarrowing('obs')}
        AND obs.entity_scope = 'adset'
        AND obs.status = 'fetched'
        AND obs.provider_http_status = 200
        AND obs.request_context->'pagination'->>'complete' = 'true'
        AND obs.request_context->'pagination'->>'termination' = 'natural_end'
        /*
          The same three shapes as the campaign contract, admitted on the same
          terms and separated by TIER rather than by admission. A legacy
          multi-page response is evidence of a value and never of a time.
        */
        /* Field-level: one governed field requested is enough to admit the row;
           each field is then gated by its OWN selector flag downstream. */
        AND (
          ${anySelector("obs")}
        )
        AND obs.observed_at >= ${input.scopeStartParam}::date
          - INTERVAL '${OBSERVATION_CLOCK_SLACK_DAYS} days'
        AND obs.observed_at < ${input.scopeEndParam}::date
          + INTERVAL '${CORROBORATION_HORIZON_DAYS + OBSERVATION_CLOCK_SLACK_DAYS + 1} days'
      UNION ALL
      /* A retained single-page snapshot with no observation row at all. */
      SELECT snap.id, snap.provider_account_id, snap.fetched_at,
             FALSE, TRUE, snap.request_context,
             ${topLevelToken("snap", "updated_time")},
${requestedFlags("snap")},
             FALSE,
             /* No observation row, so no receipt id: explicit NULL. */
             NULL::uuid,
             ${receiptFieldScopeHashSql("snap")}
      FROM meta_raw_snapshots snap
      WHERE snap.business_id = ${input.businessParam}
        AND snap.endpoint_name = 'adset_configs'
${accountNarrowing('snap')}
        AND snap.entity_scope = 'adset'
        AND snap.status = 'fetched'
        AND snap.provider_http_status = 200
        AND snap.request_context->'pagination'->>'complete' = 'true'
        AND snap.request_context->'pagination'->>'termination' = 'natural_end'
        AND snap.request_context->'pagination'->>'pageCount' = '1'
        AND (
          ${anySelector("snap")}
        )
        AND snap.fetched_at >= ${input.scopeStartParam}::date
          - INTERVAL '${OBSERVATION_CLOCK_SLACK_DAYS} days'
        AND snap.fetched_at < ${input.scopeEndParam}::date
          + INTERVAL '${CORROBORATION_HORIZON_DAYS + OBSERVATION_CLOCK_SLACK_DAYS + 1} days'
        AND NOT EXISTS (
          SELECT 1 FROM meta_raw_snapshot_observations o WHERE o.snapshot_id = snap.id
        )
    ),
    account_tz AS MATERIALIZED (
      SELECT DISTINCT provider_account_id, account_timezone
      FROM (${input.scopeRelationSql}) tz(provider_account_id, adset_id, date, account_timezone)
    ),
    compressed AS MATERIALIZED (
      /*
        The observation timeline, reduced to the sightings that can still win.

        A snapshot is re-observed about a hundred times on production, and every
        one of those rows carries the same payload values, so the product of
        observations and entities is where the cost is. But the naive reduction —
        each snapshot's first and last sighting — is WRONG, and provably so:
        with sightings of snapshot A at 10:00, 14:00 and 18:00, a rival snapshot B
        at 12:00, and a cutoff of 15:00, keeping only A's ends drops A@14:00 and
        lets B@12:00 win a day it should not.

        What actually has to survive, per bucket, is three sightings:
          - the LAST at or before the cutoff, which the same-day as-of pick takes;
          - the FIRST at or before the cutoff, which a later day's bucket supplies
            to the corroboration pick;
          - the LAST regardless of cutoff, which the restated diagnostic takes.
        Everything between them is dominated by one of the three under every
        ordering the contract uses.

        The bucket carries what can differ between sightings of one snapshot:
        the provider-local day, the effective per-field selector flags, and the
        clock/source shape. Two sightings in the same bucket are interchangeable
        except for their instant, which is exactly what the three keep.

        MODERN rows are not compressed at all. Their clock is per entity, so a
        bucket keyed on the observation's aggregate day could file one on the
        wrong side of a boundary — the hazard that sank an earlier attempt.
      */
      SELECT q.*, FALSE AS is_paged_within_day
      FROM qualifying q WHERE q.is_modern
      UNION ALL
      SELECT snapshot_id, provider_account_id, observed_at, is_modern,
             is_single_page, request_context, requested_updated_time,
${requestedColumnsBare.replace("             requested_", "             requested_")},
             has_observation, observation_id, field_scope_hash,
             is_paged_within_day
      FROM (
        SELECT q.*,
          /*
            Per-row, computed where the account timezone is in scope, and kept
            OUT of the bucket key on purpose: two sightings differing only in it
            are still chosen by instant, and all ties on an instant survive.
          */
          ${pagedWithinProviderDaySql("q", "tz.account_timezone")}
            AS is_paged_within_day,
          MAX(q.observed_at) FILTER (WHERE q.observed_at <= ${cutoff}) OVER w
            AS last_before_cutoff,
          MIN(q.observed_at) FILTER (WHERE q.observed_at <= ${cutoff}) OVER w
            AS first_before_cutoff,
          MAX(q.observed_at) OVER w AS last_overall
        FROM qualifying q
        JOIN account_tz tz ON tz.provider_account_id = q.provider_account_id
        WHERE NOT q.is_modern
        WINDOW w AS (
          PARTITION BY q.snapshot_id, q.provider_account_id,
            (q.observed_at AT TIME ZONE
              COALESCE(NULLIF(BTRIM(tz.account_timezone), ''), 'UTC'))::date,
            q.requested_updated_time,
${requestedColumnsQualified.replace("             q.requested_", "            q.requested_")},
            q.is_single_page, q.has_observation
        )
      ) ranked
      WHERE observed_at = last_before_cutoff
         OR observed_at = first_before_cutoff
         OR observed_at = last_overall
    ),
    entities AS MATERIALIZED (
      /* Each distinct snapshot expanded exactly once. */
      SELECT d.snapshot_id,
             d.provider_account_id,
             entity.payload->>'id' AS adset_id,
             entity.payload->>'updated_time' AS entity_updated_time,
${fieldColumns}
      FROM (SELECT DISTINCT snapshot_id, provider_account_id FROM compressed) d
      JOIN meta_raw_snapshots snap
        ON snap.id = d.snapshot_id
       AND snap.business_id = ${input.businessParam}
       /* Exact account match: a snapshot id alone would let one account's
          observation metadata authorise another account's payload. */
       AND snap.provider_account_id = d.provider_account_id
       AND snap.endpoint_name = 'adset_configs'
       AND snap.entity_scope = 'adset'
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(snap.payload_json) = 'array'
          THEN snap.payload_json ELSE '[]'::jsonb END
      ) AS entity(payload)
      JOIN (${input.adsetScopeSql}) wanted(adset_id)
        ON wanted.adset_id = entity.payload->>'id'
    )
    SELECT
      q.provider_account_id,
      /* Identity for the final tie-break; see the campaign contract for why. */
      q.snapshot_id,
      /* The receipt itself, and the scope it asked under. */
      q.observation_id,
      q.field_scope_hash,
      e.adset_id,
      CASE
        WHEN q.is_modern
          THEN ${safeInstant("q.request_context->'rowObservedAtByEntityId'->>e.adset_id")}
        WHEN q.is_single_page THEN q.observed_at
        /*
          A legacy MULTI-page receipt: the only clock it has describes the merged
          response, so this dates the row APPROXIMATELY. It is carried so the
          value is not lost, and every tier below caps such a row at review only.
        */
        WHEN NOT q.is_modern THEN q.observed_at
        ELSE NULL
      END AS row_observed_at,
      /*
        NULL-safe on purpose. A pageCount can be absent or malformed, and then
        is_single_page is NULL rather than FALSE, so NOT is_single_page is NULL
        too and a downstream NOT COALESCE(flag, FALSE) reads TRUE — handing a
        malformed legacy receipt the authority this tier exists to withhold.
        IS NOT TRUE makes anything that is not a PROVEN single page uncertain,
        which is the fail-closed direction.
        (No backticks in this block: it sits inside a template literal.)

        A multi-page receipt that PROVED its whole pagination ran inside one
        provider-local day is no longer uncertain about the INTERVAL: whichever
        page held the row, that page was fetched inside this day. It stays legacy
        and stays below a point observation, but it may end a bracket — which is
        the difference between a permanently paged account being read and being
        held forever. Still fail-closed: the flag is FALSE unless proven.
      */
      (NOT q.is_modern AND q.is_single_page IS NOT TRUE
        AND NOT q.is_paged_within_day) AS is_interval_uncertain,
      q.is_paged_within_day,
      q.is_modern,
      q.requested_updated_time,
${requestedColumns},
      CASE
        WHEN q.is_modern THEN 'modern'
        WHEN q.is_single_page IS NOT TRUE THEN 'legacy_multi_page'
        WHEN q.has_observation THEN 'legacy_observed'
        ELSE 'legacy_snapshot_only'
      END AS source_class,
      e.entity_updated_time,
      ${META_CONFIG_CONTRACT_ADSET_FIELDS.map((f) => `e.${f}`).join(",\n      ")}
    FROM compressed q
    JOIN entities e
      ON e.snapshot_id = q.snapshot_id
     AND e.provider_account_id = q.provider_account_id
    WHERE (CASE
      WHEN q.is_modern
        THEN ${safeInstant("q.request_context->'rowObservedAtByEntityId'->>e.adset_id")}
      WHEN q.is_single_page THEN q.observed_at
      /* Legacy multi-page: kept, with its timing declared uncertain downstream. */
      WHEN NOT q.is_modern THEN q.observed_at
      ELSE NULL
    END) IS NOT NULL
  )`;

  /*
    Field-specific resolution, computed once per (account, ad-set, day).

    Two things had to be true at the same time, and an earlier version got only
    one of them. Field-specific: a later response that omits one field must not
    lose an earlier same-day measurement of it, so each field ranks its own rows.
    Observation-preserving: the ranking runs over receipt rows, each carrying its
    own selector flags and its own page clock, so the inner observation of a
    re-observed snapshot can win — which is exactly what the withdrawn
    earliest/latest compression destroyed.

    DISTINCT ON does the reduction, and the result is a small materialised set
    joined on equality rather than four correlated laterals over the whole
    receipt table.
  */
  /*
    The scope join, hoisted out of all six resolutions. See `resolutionScopeCte`:
    computing it once instead of six times is the single largest measured saving
    in this query. Inside the hoisted relation the day is `r.date` and the
    account timezone is `r.resolved_account_timezone`, which the join proved
    equal to the coalesced scope timezone.
  */
  const scopedCte = `${p}_scoped`;
  const rowTz = "r.resolved_account_timezone";
  const rowDayStart = `(r.date::timestamp AT TIME ZONE ${rowTz})`;
  const rowDayEnd = `((r.date + 1)::timestamp AT TIME ZONE ${rowTz})`;

  const resolutionCte = (
    field: MetaConfigContractAdsetField,
    kind: "day" | "next",
  ): string => {
    const alias = kind === "day" ? sameDayAlias(field) : corrobAlias(field);
    /*
      The cutoff bounds the CANDIDATES, not the winner.

      Filtering after the pick loses evidence: with an in-day receipt A before the
      cutoff and a newer in-day receipt B after it, DISTINCT ON takes B, the
      post-hoc cutoff test then rejects it, and A — which the run could and should
      have used — never appears at all. Ranking only over rows the cutoff admits
      makes A the winner, which is what an as-of read means.
    */
    const asOf = `      AND r.row_observed_at <= ${cutoff}`;
    const window =
      kind === "day"
        ? `      AND r.row_observed_at >= ${rowDayStart}
      AND r.row_observed_at < ${rowDayEnd}
${asOf}`
        : `      AND r.row_observed_at >= ${rowDayEnd}
      AND r.row_observed_at < ${rowDayEnd}
        + INTERVAL '${CORROBORATION_HORIZON_DAYS} days'
${asOf}`;
    /* Newest inside the day; earliest after it. The after-day pick is the FIRST
       later sighting, agreeing or not — agreement is tested in the tier, so a
       disagreeing first observation refuses instead of being skipped. */
    const direction = kind === "day" ? "DESC" : "ASC";
    return `${alias} AS MATERIALIZED (
    SELECT DISTINCT ON (r.provider_account_id, r.adset_id, r.date)
      r.provider_account_id, r.adset_id, r.date,
      ${membersOf(field)
        .map((member) => `r.${member} AS ${valueCol(member)}`)
        .join(",\n      ")},
      r.entity_updated_time,
      r.is_modern,
      r.source_class,
      r.row_observed_at,
      r.requested_updated_time,
      r.is_interval_uncertain,
      r.is_paged_within_day,
      /* The identity of the row this pick chose, for evidenceRefSql. */
      r.snapshot_id,
      r.observation_id,
      r.field_scope_hash
    FROM ${scopedCte} r
    WHERE r.requested_${field}
      /* No value filter: an observed absence is a candidate, and must be able to
         win, or it cannot end a stale value. */
${window}
    ORDER BY r.provider_account_id, r.adset_id, r.date, r.row_observed_at ${direction},
             ${RESOLUTION_TIE_BREAK_SQL}
  )`;
  };

  /*
    The diagnostic resolution: the same in-day pick with NO cutoff at all.
    Separate because the as-of path must not see it — this is what today's
    warehouse says, not what that run could have known — and because folding the
    two together is precisely the bug that lost a usable pre-cutoff row to a
    newer post-cutoff one.
  */
  const restatedAlias = (field: MetaConfigContractAdsetField) =>
    `${p}_${RESOLUTION_LEAD[field]}_restated`;
  const restatedCte = (field: MetaConfigContractAdsetField): string =>
    `${restatedAlias(field)} AS MATERIALIZED (
    SELECT DISTINCT ON (r.provider_account_id, r.adset_id, r.date)
      r.provider_account_id, r.adset_id, r.date,
      ${membersOf(field)
        .map((member) => `r.${member} AS ${valueCol(member)}`)
        .join(",\n      ")},
      /* The same identity as the as-of picks, so a diagnostic can cite it too. */
      r.snapshot_id,
      r.observation_id,
      r.field_scope_hash,
      r.row_observed_at
    FROM ${scopedCte} r
    WHERE r.requested_${field}
      /*
        No value filter here either. The diagnostic answers "what does today's
        warehouse say", and after a receipt that requested the field and came back
        without it, the honest answer is that there is none — not the value from
        before the receipt that disproved it.
      */
      AND r.row_observed_at >= ${rowDayStart}
      AND r.row_observed_at < ${rowDayEnd}
    ORDER BY r.provider_account_id, r.adset_id, r.date, r.row_observed_at DESC,
             ${RESOLUTION_TIE_BREAK_SQL}
  )`;

  const joinFor = (field: MetaConfigContractAdsetField): string => {
    const day = sameDayAlias(field);
    const next = corrobAlias(field);
    const restated = restatedAlias(field);
    /* Omitted entirely when the caller does not read it; see includeRestated. */
    /* One already-decided row, looked up; see the campaign joinFor for why. */
    const lookup = (alias: string) => `
  LEFT JOIN LATERAL (
    SELECT * FROM ${alias} hit
    WHERE hit.provider_account_id = ${input.accountExpression}
      AND hit.adset_id = ${input.adsetExpression}
      AND hit.date = ${input.dayExpression}
    LIMIT 1
  ) ${alias} ON TRUE`;
    const restatedJoin = includeRestated ? lookup(restated) : "";
    return `${restatedJoin}${lookup(day)}${lookup(next)}`;
  };

  const corroborationPending =
    `((${dayEnd} + INTERVAL '${CORROBORATION_HORIZON_DAYS} days') > ${cutoff})`;
  const available = (field: MetaConfigContractAdsetField): string =>
    `(${sameDayAlias(field)}.${valueCol(field)} IS NOT NULL
      AND ${sameDayAlias(field)}.row_observed_at <= ${cutoff})`;

  const bracketAgrees = (field: MetaConfigContractAdsetField): string => {
    const a = sameDayAlias(field);
    const b = corrobAlias(field);
    return `(${available(field)}
      /* The clock only means anything if both responses asked for it. */
      AND ${a}.requested_updated_time
      AND ${b}.requested_updated_time
      AND ${a}.entity_updated_time IS NOT NULL
      AND ${safeInstant(`${a}.entity_updated_time`)} <= ${dayStart}
      AND ${b}.row_observed_at IS NOT NULL
      AND ${b}.row_observed_at <= ${cutoff}
      AND ${b}.${valueCol(field)} = ${a}.${valueCol(field)}
      AND ${b}.entity_updated_time IS NOT DISTINCT FROM ${a}.entity_updated_time)`;
  };

  /* A receipt whose page time is unknowable cannot anchor either bracket end. */
  const bracketEndsAreTimed = (field: MetaConfigContractAdsetField): string =>
    `(NOT COALESCE(${sameDayAlias(field)}.is_interval_uncertain, FALSE)
      AND NOT COALESCE(${corrobAlias(field)}.is_interval_uncertain, FALSE))`;

  const tierSql = (field: MetaConfigContractAdsetField): string => `(CASE
      /* The day attached to a receipt is unknowable without the account zone. */
      WHEN NULLIF(BTRIM(${input.timezoneExpression}), '') IS NULL THEN 'unknown'
      WHEN ${bracketAgrees(field)} AND ${bracketEndsAreTimed(field)}
        AND ${sameDayAlias(field)}.is_modern AND ${corrobAlias(field)}.is_modern
        THEN 'provider_receipt_day_bracketed'
      WHEN ${bracketAgrees(field)} AND ${bracketEndsAreTimed(field)}
        THEN 'provider_receipt_legacy_bracketed'
      WHEN ${available(field)} AND ${sameDayAlias(field)}.is_interval_uncertain
        THEN 'provider_receipt_legacy_interval_uncertain'
      WHEN ${available(field)} AND ${corroborationPending}
        THEN 'provider_receipt_pending_corroboration'
      WHEN ${available(field)} AND ${sameDayAlias(field)}.is_modern
        THEN 'provider_receipt_point_in_day'
      /* Multi-page, but the pagination is proven to fit inside this local day.
         Named apart from the single-page receipt so the ladder never claims one
         page where there were nine. */
      WHEN ${available(field)} AND ${sameDayAlias(field)}.is_paged_within_day
        THEN 'provider_receipt_legacy_paged_within_day'
      WHEN ${available(field)} THEN 'provider_receipt_legacy_single_page'
      WHEN ${sameDayAlias(field)}.row_observed_at IS NOT NULL
        AND ${sameDayAlias(field)}.row_observed_at <= ${cutoff}
        THEN 'observed_absent'
      ELSE 'unknown'
    END)`;

  /*
    KEYED ON THE RECEIPT, NOT ON THE VALUE — the same rule as the campaign
    contract. This used to answer 'as_of_known' only when a VALUE was available,
    so an observed absence (a receipt that asked for the field before the cutoff
    and came back without it) was reported as 'restated': a statement about
    today's warehouse, when it is exactly as known at the cutoff as a receipt
    that carried a value. The two grains disagreed about one fact, and a
    reference citing the absence would have claimed hindsight it did not use.
    No production reader consumed the ad-set pit class, so nothing that was
    decided moves.
  */
  const pitClassSql = (field: MetaConfigContractAdsetField): string => `(CASE
      WHEN ${sameDayAlias(field)}.row_observed_at IS NOT NULL
        AND ${sameDayAlias(field)}.row_observed_at <= ${cutoff}
        THEN 'as_of_known'
      ELSE 'restated'
    END)`;

  return {
    contractVersion: META_CONFIG_FIELD_SOURCE_CONTRACT_VERSION,
    cteName,
    withSql: [
      withSql,
      entityDayCompressionCte({
        name: entityDayCte,
        source: cteName,
        entityColumn: "adset_id",
        scopeRelationSql: input.scopeRelationSql,
        cutoff,
        /* One bucket per requested-selector shape: a response that did not ask
           for a field must not displace one that did. */
        extraPartitionColumns: RESOLUTION_LEADS.map(
          (field) => `requested_${field}`,
        ),
      }),
      resolutionScopeCte({
        name: scopedCte,
        entityDayCte,
        entityColumn: "adset_id",
        scopeRelationSql: input.scopeRelationSql,
        horizonDays: CORROBORATION_HORIZON_DAYS,
      }),
      ...RESOLUTION_LEADS.flatMap((field) => [
        resolutionCte(field, "day"),
        resolutionCte(field, "next"),
        ...(includeRestated ? [restatedCte(field)] : []),
      ]),
    ].join(",\n  "),
    lateralSql: RESOLUTION_LEADS.map(joinFor).join(""),
    valueSql: (field) => `(CASE
      WHEN ${available(field)} THEN ${sameDayAlias(field)}.${valueCol(field)}
      ELSE NULL
    END)`,
    restatedValueSql: (field) => {
      if (!includeRestated) {
        throw new Error(
          "restatedValueSql needs includeRestated: the diagnostic relation is not emitted",
        );
      }
      return `${restatedAlias(field)}.${valueCol(field)}`;
    },
    tierSql,
    readinessSql: (field) => readinessCaseSql(tierSql(field)),
    sourceClassSql: (field) =>
      `COALESCE(${sameDayAlias(field)}.source_class, 'none')`,
    pitClassSql,
    evidenceRefSql: (field) =>
      configFieldEvidenceRefSql({
        prefix: `${p}_${field}`,
        field,
        tierSql: tierSql(field),
        sourceClassSql: `COALESCE(${sameDayAlias(field)}.source_class, 'none')`,
        pitClassSql: pitClassSql(field),
        sameDayAlias: sameDayAlias(field),
        corroborationAlias: corrobAlias(field),
      }),
  };
}
