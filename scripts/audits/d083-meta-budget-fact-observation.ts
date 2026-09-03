/**
 * D083 — account-scoped Meta budget-fact observation, PIT ownership/schedule
 * contract, and historical replay.
 *
 * Read-only research. SELECT only, inside one `REPEATABLE READ READ ONLY`
 * transaction with a server-asserted read-only proof, statement and lock
 * timeouts, and a savepoint per optional read. No write of any kind, no
 * migration executed, no provider mutation, no producer or backfill run.
 *
 * Why. D082 established that opening campaign-role authority would not make a
 * single budget proposal executable: 237,745 of 247,050 candidates die at money
 * shape. This package measures what the retained budget evidence can actually
 * support, through the canonical `lib/meta/budget-fact` boundary, and reports
 * the change against the corrected D082 baseline. It adds no execution path.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  canonicalJson,
  sha256Canonical,
  D080_PINNED_BINDINGS,
  bindingKey,
} from "@/scripts/audits/d080-meta-budget-edit-evidence";
import {
  analyse as analyseD080B,
  materialiseSnapshot as materialiseD080BSnapshot,
  addDays,
  isCalendarDate,
  type BudgetResearchProposal,
  type MaterialisedRead as D080BMaterialisedRead,
  type OriginPlan,
} from "@/scripts/audits/d080b-meta-budget-policy-simulation";
import {
  buildCanonicalBudgetFact,
  isRealCalendarDate,
  BUDGET_FACT_BLOCKERS,
  BUDGET_FACT_CONTRACT_VERSION,
  type BudgetEntityGrain,
  type BudgetFactBlocker,
  type BudgetObservation,
  selectObservationAtPit,
  pitCutoffMs,
  type RunCompleteness,
} from "@/lib/meta/budget-fact";
import { ISO_4217_REGISTRY_VERSION } from "@/lib/currency/iso-4217-minor-units";

/*
  The row -> BudgetObservation projection now lives in lib/meta, so D083 and the
  D086 readiness read use ONE implementation rather than two that can drift.
  Re-exported here because the extract's own contract names these.
*/
import {
  rawText,
  trimmedText,
  dateOnly,
  instantMs,
  coverageBit,
  coverageSource,
  ADMITTED_COVERAGE_SOURCES,
  toBudgetObservation,
} from "@/lib/meta/budget-observation-projection";

export {
  rawText,
  trimmedText,
  dateOnly,
  instantMs,
  coverageBit,
  coverageSource,
  ADMITTED_COVERAGE_SOURCES,
  toBudgetObservation,
};

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const D083_CONTRACT_ID = "adsecute.meta.d083-budget-fact-observation.v1" as const;
export const D083_JSON_OUT =
  "docs/audits/generated/d083-meta-budget-fact-observation-2026-09-01.json";

export const D083_PINNED_INPUTS = {
  d080aArtifactPath: "docs/audits/generated/d080-meta-budget-edit-evidence-2026-08-31.json",
  d080aArtifactSha256: "d4a1898aba14bcb2a37ae60a335f207eb668df13d37619bdffb44330da4d7a69",
  d080bArtifactPath: "docs/audits/generated/d080b-meta-budget-policy-simulation-2026-09-01.json",
  d080bArtifactSha256: "b46e6aa80c75aec0ebc724f2b8fcc288cda611353e9924a85504d3e498d155df",
  d081ArtifactPath: "docs/audits/generated/d081-meta-budget-capability-foundations-2026-09-01.json",
  d081ArtifactSha256: "5514023bbad12923651b1a59810bf1ce2684f4361cac8bfcb0148033bbb402b3",
  d082ArtifactPath: "docs/audits/generated/d082-meta-role-provenance-replay-2026-09-01.json",
  d082ArtifactSha256: "bc4d06d0ea2b2e1ef22d8016e7f4a5191ad633657140564b21c3adb48480868e",
  d082InternalArtifactHash: "965b7a26647f6f40c749e1dfcdb7ef2af9c97c014a90f6a58a2813ac42dc9c09",
} as const;

/**
 * Two lanes, never merged. `strict_pit_authority` requires both an effective
 * and a recorded cutoff. `retrospective_finalized_conditional` requires only the
 * effective cutoff and is a reconstruction, not authority.
 */
export const D083_LANES = ["strict_pit_authority", "retrospective_finalized_conditional"] as const;
export type D083Lane = (typeof D083_LANES)[number];

export const D083_TRUTH_LABELS = [
  "verified_fact",
  "derived_metric",
  "counterfactual_reconstruction",
  "assumption",
  "unknown",
] as const;

export const STATEMENT_TIMEOUT_MS = 30_000;
export const LOCK_TIMEOUT_MS = 5_000;

export const D083_FORBIDDEN_TRUTHY_FLAGS = [
  "ENABLE_RUNTIME_MIGRATIONS",
  "ENABLE_META_WRITES",
  "ENABLE_AUTOMATION",
  "META_AUTOMATION_ENABLED",
  "ENABLE_PROVIDER_WRITES",
  "ALLOW_LIVE_MUTATION",
] as const;

export const STATE_HISTORY_TABLE = "meta_entity_state_history";



/**
 * There is no lookback horizon any more. Correction 2 used one, and it silently
 * discarded 808,506 pre-floor rows whose earliest observations reach back to
 * 2023. Winners are computed over full history in SQL.
 */
export const BASELINE_LOOKBACK_DAYS = null;

/**
 * Primary Meta documentation consulted for volatile field semantics. It
 * corroborates units and the mutual-exclusivity constraint; it is never used as
 * evidence about these accounts.
 */
export const META_DOC_REFERENCE = {
  source: "https://developers.facebook.com/docs/marketing-api/reference/ad-campaign",
  retrievedAt: "2026-09-01",
  establishes: [
    "daily_budget and lifetime_budget are numeric strings in the account currency",
    "minor units for USD and EUR, basic units for JPY and KRW, so no unconditional divide by one hundred",
    "either daily_budget or lifetime_budget must be greater than zero",
    "start_time and end_time are required together with lifetime_budget",
    "campaign_id on an ad set is a numeric string",
  ],
  neverUsedFor: "any claim about what these seven bindings actually contain",
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// The read plan. SELECT only, every account-bearing source account-filtered.
// ---------------------------------------------------------------------------

export const D083_QUERIES = {
  /** Proves which columns the observation table actually has. */
  stateHistorySchema: `
    SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('meta_entity_state_history',
                          'meta_campaign_config_history',
                          'meta_adset_config_history')
     ORDER BY table_name, column_name`,

  /**
   * Proves absence rather than assuming it: any column anywhere in the public
   * schema that could carry a schedule or a currency exponent.
   */
  scheduleAndExponentSearch: `
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (column_name ~* '(start_time|end_time|stop_time|schedule)'
            OR column_name ~* '(exponent|minor_unit|currency_scale|currency_decimal)')
     ORDER BY table_name, column_name`,

  /**
   * Exact point-in-time winners, computed in SQL over the entity's FULL
   * history, one query per binding and lane.
   *
   * Correction 2 read a window plus a 120-day-floored skyline. That floor is a
   * silent horizon: 808,506 campaign and ad-set rows exist before it across the
   * seven bindings, with earliest observations in 2023, and a still-current
   * predecessor from before it could never be selected. There is no floor here.
   *
   * `RANK()` on the clock pair keeps every row tied at the top clock, not just
   * one, so the canonical selector can still detect a same-clock conflict
   * rather than silently adjudicating it in SQL.
   */
  /**
   * The exact point-in-time candidate set at one cutoff, for one grain, for one
   * lane. No floor, no cap, no heuristic reduction.
   *
   * Correction 2 bounded the candidate set with a 120-day lookback, which
   * silently deleted 827,277 rows. Correction 3 replaced it with a single-pass
   * "frontier" that was **also wrong**, in two independent ways, both
   * reproduced against the shipped statement in a `READ ONLY` transaction:
   *
   *   A. Three captures of one `observed_at` (t1 < t2 < t3) at a cutoff between
   *      t2 and t3. `RANGE ... CURRENT ROW` makes equal-`observed_at` rows
   *      peers, so `best_captured` is t1 for all three; `finalized_rank = 1`
   *      keeps t3. Kept `{t1, t3}`; the strict winner is t2; the reduced set
   *      selected t1.
   *   B. A future-effective row recorded early (observed 2026-06-01, captured
   *      2026-01-01) beside the true winner (observed 2026-05-01, captured
   *      2026-02-01) at cutoff 2026-05-15. The running minimum drops the
   *      winner and the future row is not selectable at the cutoff, so the
   *      reduced set selected **nothing**.
   *
   * The replacement makes no cleverness claim. Because the statement already
   * runs once per origin and grain, it simply asks the database for the answer:
   * scope to the rows a lane may see at this cutoff, then keep exactly the rows
   * at the top clock.
   *
   *   - `$5 = true`  (strict): `observed_at < cutoff AND captured_at <= cutoff`
   *   - `$5 = false` (finalized): `observed_at < cutoff`
   *
   * `RANK()` on `(observed_at DESC, captured_at DESC)` keeps **every** row tied
   * on both clocks, so an exact-clock conflict still reaches the canonical
   * selector instead of being adjudicated in SQL. The union over both lanes and
   * all origins is therefore exactly the set the selector needs: for any
   * evaluated cutoff and lane, the winner is by construction rank 1 of that
   * execution, and no row that could win anywhere is dropped.
   *
   * The ordering `(entity_type, entity_id, observed_at DESC, captured_at DESC)`
   * is a prefix of `idx_meta_entity_state_history_asof (business_id,
   * provider_account_id, entity_type, entity_id, observed_at DESC,
   * captured_at DESC)`, so the window needs no sort. The lane predicate is a
   * filter applied during the same ordered scan.
   */
  budgetObservationPitWinners: `
    WITH scoped AS (
      SELECT h.id, h.entity_type, h.entity_id, h.campaign_id,
             h.observed_at, h.captured_at, h.run_id,
             h.run_completeness, h.presence,
             h.configured_status, h.effective_status,
             h.budget_origin, h.budget_currency,
             h.campaign_daily_budget_raw, h.campaign_lifetime_budget_raw,
             h.adset_daily_budget_raw, h.adset_lifetime_budget_raw,
             h.state_hash, h.field_coverage_json
        FROM meta_entity_state_history h
       WHERE h.business_id = $1::text
         AND h.provider_account_id = $2::text
         AND h.entity_type = $4::text
         AND h.observed_at < $3::timestamptz
         AND ($5::bool IS FALSE OR h.captured_at <= $3::timestamptz)
    ),
    ranked AS (
      SELECT scoped.*,
             RANK() OVER (
               PARTITION BY entity_type, entity_id
               ORDER BY observed_at DESC, captured_at DESC
             ) AS clock_rank
        FROM scoped
    )
    SELECT ranked.id::text AS observation_id,
           ranked.entity_type, ranked.entity_id, ranked.campaign_id,
           ranked.observed_at::text AS observed_at,
           ranked.observed_at::date::text AS observed_on,
           ranked.captured_at::text AS captured_at,
           ranked.run_id::text AS run_id,
           ranked.run_completeness, ranked.presence,
           ranked.configured_status, ranked.effective_status,
           ranked.budget_origin, ranked.budget_currency,
           ranked.campaign_daily_budget_raw, ranked.campaign_lifetime_budget_raw,
           ranked.adset_daily_budget_raw, ranked.adset_lifetime_budget_raw,
           ranked.state_hash, ranked.field_coverage_json,
           r.source_snapshot_id, r.payload_hash, r.run_hash
      FROM ranked
      LEFT JOIN meta_entity_observation_runs r ON r.id = ranked.run_id
     WHERE ranked.clock_rank = 1
     ORDER BY ranked.entity_type, ranked.entity_id, ranked.id`,

  /**
   * Full-history completeness evidence: how much history exists per entity, and
   * how far back it reaches, with no floor. This is what proves the winners
   * above were selected from everything rather than from a truncated slice.
   */
  fullHistoryCensus: `
    SELECT entity_type,
           count(*)::bigint AS rows,
           count(DISTINCT entity_id)::bigint AS entities,
           min(observed_at)::date::text AS earliest_observed,
           max(observed_at)::date::text AS latest_observed,
           min(captured_at)::date::text AS earliest_captured,
           max(captured_at)::date::text AS latest_captured,
           count(*) FILTER (WHERE observed_at < $3::timestamptz)::bigint AS rows_before_first_origin
      FROM meta_entity_state_history
     WHERE business_id = $1::text AND provider_account_id = $2::text
       AND entity_type IN ('campaign', 'adset')
     GROUP BY entity_type
     ORDER BY entity_type`,

  /**
   * The physical account's timezone, which decides when an origin day begins.
   * Retained per source day, so its stability over the window is measurable
   * rather than assumed.
   */
  accountTimezone: `
    SELECT account_timezone,
           count(*)::bigint AS rows,
           min(date)::text AS earliest_date,
           max(date)::text AS latest_date
      FROM meta_campaign_daily
     WHERE (business_ref_id::text = $1 OR business_id = $1)
       AND provider_account_id = $2::text
     GROUP BY account_timezone
     ORDER BY account_timezone`,

  /**
   * The census the first D083 report omitted: buying type, objective, bid
   * strategy, optimization goal and any budget-shape indicator.
   */
  configurationCensus: `
    SELECT count(*)::bigint AS rows,
           count(DISTINCT objective)::bigint AS distinct_objectives,
           count(*) FILTER (WHERE objective IS NULL)::bigint AS objective_null,
           count(DISTINCT buying_type)::bigint AS distinct_buying_types,
           count(*) FILTER (WHERE buying_type IS NULL)::bigint AS buying_type_null,
           count(DISTINCT bid_strategy_type)::bigint AS distinct_bid_strategies,
           count(*) FILTER (WHERE bid_strategy_type IS NULL)::bigint AS bid_strategy_null,
           count(DISTINCT optimization_goal)::bigint AS distinct_optimization_goals,
           count(*) FILTER (WHERE is_budget_mixed)::bigint AS budget_mixed_rows
      FROM meta_campaign_daily
     WHERE (business_ref_id::text = $1 OR business_id = $1)
       AND provider_account_id = $2::text`,

  /** The retained observation-run manifest: what evidence each run carries. */
  observationRunManifest: `
    SELECT completeness,
           count(*)::bigint AS runs,
           count(*) FILTER (WHERE source_snapshot_id IS NOT NULL)::bigint AS runs_with_snapshot,
           count(*) FILTER (WHERE payload_hash IS NOT NULL)::bigint AS runs_with_payload_hash,
           min(captured_at)::text AS earliest_captured,
           max(captured_at)::text AS latest_captured,
           count(DISTINCT contract_version)::bigint AS distinct_contract_versions
      FROM meta_entity_observation_runs
     WHERE business_id = $1::text AND provider_account_id = $2::text
     GROUP BY completeness
     ORDER BY completeness`,

  /** Whole-table retention census, so the window is not mistaken for all. */
  observationRunCensus: `
    SELECT entity_type, run_completeness, presence, budget_origin,
           count(*)::bigint AS rows,
           count(DISTINCT entity_id)::bigint AS entities,
           min(observed_at)::date::text AS earliest_observed,
           max(observed_at)::date::text AS latest_observed,
           min(captured_at)::text AS earliest_captured,
           max(captured_at)::text AS latest_captured
      FROM meta_entity_state_history
     WHERE business_id = $1::text AND provider_account_id = $2::text
     GROUP BY entity_type, run_completeness, presence, budget_origin
     ORDER BY entity_type, run_completeness, presence, budget_origin`,

  /** Parent-campaign identity coverage for ad sets, from the observation table. */
  parentIdentityCensus: `
    SELECT count(*)::bigint AS adset_rows,
           count(*) FILTER (WHERE campaign_id IS NOT NULL)::bigint AS rows_with_parent,
           count(DISTINCT entity_id)::bigint AS adsets,
           count(DISTINCT entity_id) FILTER (WHERE campaign_id IS NOT NULL)::bigint AS adsets_with_parent
      FROM meta_entity_state_history
     WHERE business_id = $1::text AND provider_account_id = $2::text
       AND entity_type = 'adset'`,

  /**
   * The genuinely-ambiguous census on the campaign config table. "Both fields
   * present" is not ambiguity; "both fields positive" is, and this counts the
   * latter over every raw row rather than a deduplicated sample.
   */
  campaignConfigBudgetShape: `
    SELECT count(*)::bigint AS rows,
           count(*) FILTER (WHERE daily_budget IS NOT NULL AND lifetime_budget IS NOT NULL)::bigint AS both_present,
           count(*) FILTER (WHERE COALESCE(daily_budget, 0) > 0 AND COALESCE(lifetime_budget, 0) > 0)::bigint AS both_positive,
           count(*) FILTER (WHERE COALESCE(daily_budget, 0) > 0 AND COALESCE(lifetime_budget, 0) = 0)::bigint AS daily_binding,
           count(*) FILTER (WHERE COALESCE(daily_budget, 0) = 0 AND COALESCE(lifetime_budget, 0) > 0)::bigint AS lifetime_binding,
           count(*) FILTER (WHERE COALESCE(daily_budget, 0) = 0 AND COALESCE(lifetime_budget, 0) = 0)::bigint AS neither,
           min(effective_from)::text AS earliest_effective,
           max(effective_from)::text AS latest_effective,
           min(captured_at)::text AS earliest_captured,
           max(captured_at)::text AS latest_captured
      FROM meta_campaign_config_history
     WHERE business_id = $1::text AND provider_account_id = $2::text`,

  /** The same census on the ad-set config table. */
  adsetConfigBudgetShape: `
    SELECT count(*)::bigint AS rows,
           count(*) FILTER (WHERE daily_budget IS NOT NULL AND lifetime_budget IS NOT NULL)::bigint AS both_present,
           count(*) FILTER (WHERE COALESCE(daily_budget, 0) > 0 AND COALESCE(lifetime_budget, 0) > 0)::bigint AS both_positive,
           count(*) FILTER (WHERE COALESCE(daily_budget, 0) > 0 AND COALESCE(lifetime_budget, 0) = 0)::bigint AS daily_binding,
           count(*) FILTER (WHERE COALESCE(daily_budget, 0) = 0 AND COALESCE(lifetime_budget, 0) > 0)::bigint AS lifetime_binding,
           count(*) FILTER (WHERE COALESCE(daily_budget, 0) = 0 AND COALESCE(lifetime_budget, 0) = 0)::bigint AS neither,
           min(effective_from)::text AS earliest_effective,
           max(effective_from)::text AS latest_effective,
           min(captured_at)::text AS earliest_captured,
           max(captured_at)::text AS latest_captured
      FROM meta_adset_config_history
     WHERE business_id = $1::text AND provider_account_id = $2::text`,

  /** Account currency, for the exponent binding. */
  accountCurrency: `
    SELECT DISTINCT account_currency
      FROM meta_campaign_daily
     WHERE (business_ref_id::text = $1 OR business_id = $1)
       AND provider_account_id = $2::text
     ORDER BY account_currency`,
} as const;

export const D083_QUERY_CONTRACT_SHA256 = sha256Canonical(D083_QUERIES);

// ---------------------------------------------------------------------------
// Request envelope and ledger
// ---------------------------------------------------------------------------

export interface D083Request {
  invocationKey: string;
  /** Set when several executions of one statement collapse into one read. */
  collapseKey: string | null;
  planKey: string;
  statement: string;
  params: unknown[];
  statementSha256: string;
  paramsSha256: string;
  businessId: string | null;
  providerAccountId: string | null;
  source: string;
  lane: D083Lane | "provenance";
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface D083LedgerEntry {
  invocationKey: string;
  planKey: string;
  businessId: string | null;
  providerAccountId: string | null;
  source: string;
  lane: string;
  statementSha256: string | null;
  paramsSha256: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  disposition: "execute" | "dependency_skip";
  status: string;
  rows: number | null;
  sourceRowHash: string | null;
  reason: string | null;
}

export interface D083MaterialisedRead {
  invocationKey: string;
  /** Number of executions merged into this read; 1 unless collapsed. */
  executions?: number;
  /**
   * The `cutoff|grain|requireRecordedByCutoff` triples executed, when this read
   * is a collapsed set. One per execution, in execution order.
   */
  executionKeys?: string[];
  /** Rows returned across all executions before deduplication by identity. */
  rowsBeforeDeduplication?: number;
  planKey: string;
  businessId: string | null;
  providerAccountId: string | null;
  source: string;
  lane: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  rows: Row[];
}

export function buildRequest(input: {
  planKey: string;
  statement: string;
  params: unknown[];
  source: string;
  lane: D083Lane | "provenance";
  businessId?: string | null;
  providerAccountId?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  /**
   * Distinguishes repeated executions of one pinned statement — the frontier is
   * read once per origin. The ledger keeps every execution; the snapshot keeps
   * one deduplicated candidate set per binding.
   */
  executionSuffix?: string | null;
}): D083Request {
  const params = input.params.map((p) => (p === undefined ? null : p));
  const scope = input.providerAccountId
    ? `${input.businessId}|${input.providerAccountId}`
    : input.businessId ?? "global";
  const suffix = input.executionSuffix ? `@${input.executionSuffix}` : "";
  return {
    invocationKey: `${input.planKey}:${input.source}#${scope}${suffix}`,
    collapseKey: input.executionSuffix ? `${input.planKey}:${input.source}#${scope}` : null,
    planKey: input.planKey,
    statement: input.statement,
    params,
    statementSha256: createHash("sha256").update(input.statement).digest("hex"),
    paramsSha256: sha256Canonical(params),
    businessId: input.businessId ?? null,
    providerAccountId: input.providerAccountId ?? null,
    source: input.source,
    lane: input.lane,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: input.effectiveTo ?? null,
  };
}

const PINNED_BUSINESS_SET = new Set(D080_PINNED_BINDINGS.map((b) => b.businessId));
const PINNED_BINDING_SET = new Set(
  D080_PINNED_BINDINGS.map((b) => bindingKey(b.businessId, b.providerAccountId)),
);
const ALLOWED_STATEMENTS = new Set<string>(Object.values(D083_QUERIES));
const ALLOWED_STATEMENT_HASHES = new Set(
  Object.values(D083_QUERIES).map((s) => createHash("sha256").update(s).digest("hex")),
);
const MUTATION_TOKEN =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|VACUUM|REFRESH|CALL|DO)\b/i;

export function assertRequestIsInScope(request: D083Request): void {
  const refuse = (why: string): never => {
    throw new Error(`D083 refuses this read: ${why} (${request.invocationKey})`);
  };
  if (!ALLOWED_STATEMENTS.has(request.statement)) {
    refuse("statement is not a member of the pinned query contract");
  }
  if (MUTATION_TOKEN.test(request.statement)) refuse("statement contains a mutation keyword");
  if (createHash("sha256").update(request.statement).digest("hex") !== request.statementSha256) {
    refuse("statement hash does not match the statement");
  }
  if (sha256Canonical(request.params) !== request.paramsSha256) {
    refuse("params hash does not match the params");
  }
  if (request.businessId && !PINNED_BUSINESS_SET.has(request.businessId)) {
    refuse("business is not one of the six charter businesses");
  }
  if (
    request.businessId &&
    request.providerAccountId &&
    !PINNED_BINDING_SET.has(bindingKey(request.businessId, request.providerAccountId))
  ) {
    refuse("business/account pair is not a pinned binding");
  }
  for (const [label, value] of [
    ["effectiveFrom", request.effectiveFrom],
    ["effectiveTo", request.effectiveTo],
  ] as const) {
    if (value !== null && !isCalendarDate(value)) refuse(`${label} is not a calendar date`);
  }
  if (request.effectiveFrom && request.effectiveTo && request.effectiveFrom > request.effectiveTo) {
    refuse("window runs backwards");
  }
}

export type SafeQ = (request: D083Request) => Promise<Row[]>;

export interface CollectedEvidence {
  proof: Row;
  ledger: D083LedgerEntry[];
  reads: D083MaterialisedRead[];
}

export async function collectEvidence(deps: {
  proof: Row;
  safeQ: SafeQ;
  window: { from: string; to: string; origins: readonly string[] };
  ledger: D083LedgerEntry[];
  reads: D083MaterialisedRead[];
}): Promise<CollectedEvidence> {
  const { safeQ, window } = deps;

  for (const [planKey, statement, source] of [
    ["stateHistorySchema", D083_QUERIES.stateHistorySchema, "information_schema.columns"],
    ["scheduleAndExponentSearch", D083_QUERIES.scheduleAndExponentSearch, "information_schema.columns"],
  ] as const) {
    await safeQ(buildRequest({ planKey, statement, params: [], source, lane: "provenance" }));
  }

  // Timezones first: the per-origin cutoffs the winners query uses are account
  // local, so they cannot be built before the zone is known.
  const timeZones = new Map<string, string>();
  for (const binding of D080_PINNED_BINDINGS) {
    const rows = await safeQ(
      buildRequest({
        planKey: "accountTimezone",
        statement: D083_QUERIES.accountTimezone,
        params: [binding.businessId, binding.providerAccountId],
        source: "meta_campaign_daily",
        lane: "provenance",
        businessId: binding.businessId,
        providerAccountId: binding.providerAccountId,
      }),
    );
    const zones = sortedUnique(
      rows.map((r) => trimmedText(r.account_timezone)).filter((z): z is string => z !== null),
    );
    if (zones.length === 1) {
      timeZones.set(bindingKey(binding.businessId, binding.providerAccountId), zones[0]!);
    }
  }

  for (const binding of D080_PINNED_BINDINGS) {
    const scope = { businessId: binding.businessId, providerAccountId: binding.providerAccountId };

    // The complete candidate set: the exact frontier at every origin, over full
    // history, with no floor. The exact winner set is asked for once per origin,
    // grain and lane, and the union is collapsed into a single deduplicated
    // read. Nothing is truncated; the union is simply stored once.
    const zone = timeZones.get(bindingKey(binding.businessId, binding.providerAccountId)) ?? null;
    const cutoffOf = (origin: string) => {
      const cutoff = zone ? pitCutoffMs(origin, zone) : null;
      return new Date(cutoff ?? Date.parse(`${origin}T00:00:00.000Z`)).toISOString();
    };

    for (const origin of window.origins) {
      for (const grain of ["campaign", "adset"] as const) {
        for (const lane of D083_LANES) {
          const requireRecorded = lane === "strict_pit_authority";
          await safeQ(
            buildRequest({
              planKey: "budgetObservationPitWinners",
              statement: D083_QUERIES.budgetObservationPitWinners,
              params: [
                binding.businessId,
                binding.providerAccountId,
                cutoffOf(origin),
                grain,
                requireRecorded,
              ],
              source: STATE_HISTORY_TABLE,
              lane,
              ...scope,
              effectiveFrom: window.from,
              effectiveTo: window.to,
              executionSuffix: `${origin}|${grain}|${lane}`,
            }),
          );
        }
      }
    }

    await safeQ(
      buildRequest({
        planKey: "fullHistoryCensus",
        statement: D083_QUERIES.fullHistoryCensus,
        params: [binding.businessId, binding.providerAccountId, cutoffOf(window.origins[0]!)],
        source: STATE_HISTORY_TABLE,
        lane: "provenance",
        ...scope,
      }),
    );

    for (const [planKey, statement, source] of [
      ["observationRunCensus", D083_QUERIES.observationRunCensus, STATE_HISTORY_TABLE],
      ["parentIdentityCensus", D083_QUERIES.parentIdentityCensus, STATE_HISTORY_TABLE],
      ["campaignConfigBudgetShape", D083_QUERIES.campaignConfigBudgetShape, "meta_campaign_config_history"],
      ["adsetConfigBudgetShape", D083_QUERIES.adsetConfigBudgetShape, "meta_adset_config_history"],
      ["accountCurrency", D083_QUERIES.accountCurrency, "meta_campaign_daily"],
      ["configurationCensus", D083_QUERIES.configurationCensus, "meta_campaign_daily"],
      ["observationRunManifest", D083_QUERIES.observationRunManifest, "meta_entity_observation_runs"],
    ] as const) {
      await safeQ(
        buildRequest({
          planKey,
          statement,
          params: [binding.businessId, binding.providerAccountId],
          source,
          lane: "provenance",
          ...scope,
        }),
      );
    }
  }

  return { proof: deps.proof, ledger: deps.ledger, reads: deps.reads };
}

/** The plan, as a set of keys, so a missing read cannot verify consistently. */
export const D083_GLOBAL_PLAN = [
  ["stateHistorySchema", "information_schema.columns"],
  ["scheduleAndExponentSearch", "information_schema.columns"],
] as const;

export const D083_PER_BINDING_PLAN = [
  ["accountTimezone", "meta_campaign_daily"],
  ["budgetObservationPitWinners", STATE_HISTORY_TABLE],
  ["fullHistoryCensus", STATE_HISTORY_TABLE],
  ["observationRunCensus", STATE_HISTORY_TABLE],
  ["parentIdentityCensus", STATE_HISTORY_TABLE],
  ["campaignConfigBudgetShape", "meta_campaign_config_history"],
  ["adsetConfigBudgetShape", "meta_adset_config_history"],
  ["accountCurrency", "meta_campaign_daily"],
  ["configurationCensus", "meta_campaign_daily"],
  ["observationRunManifest", "meta_entity_observation_runs"],
] as const;

export function expectedInvocationKeys(): string[] {
  const keys = D083_GLOBAL_PLAN.map(([planKey, source]) => `${planKey}:${source}#global`);
  for (const binding of D080_PINNED_BINDINGS) {
    const scope = `${binding.businessId}|${binding.providerAccountId}`;
    for (const [planKey, source] of D083_PER_BINDING_PLAN) {
      keys.push(`${planKey}:${source}#${scope}`);
    }
  }
  return keys.sort();
}

export function materialiseSnapshot(
  reads: readonly D083MaterialisedRead[],
): Record<string, D083MaterialisedRead[]> {
  const out: Record<string, D083MaterialisedRead[]> = {};
  for (const read of reads) (out[read.planKey] ??= []).push(read);
  return out;
}

export function snapshotBodyOf(reads: readonly D083MaterialisedRead[]): unknown {
  return reads.map((r) => ({
    invocationKey: r.invocationKey,
    planKey: r.planKey,
    businessId: r.businessId,
    providerAccountId: r.providerAccountId,
    source: r.source,
    lane: r.lane,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    rows: r.rows,
  }));
}

// ---------------------------------------------------------------------------
// Mapping retained rows into the canonical observation shape
// ---------------------------------------------------------------------------

/**
 * Status field-coverage, decoded strictly.
 *
 * Correction 2 accepted any string, so `""`, `"false"` and `"not_returned"` all
 * read as covered. The production mapper writes boolean `true` for status
 * presence, and that is the only admitted representation here.
 */
const OBSERVATION_CACHE = new WeakMap<object, Map<string, BudgetObservation[]>>();

export function observationsByBinding(
  snapshot: Record<string, D083MaterialisedRead[]>,
): Map<string, BudgetObservation[]> {
  const cached = OBSERVATION_CACHE.get(snapshot);
  if (cached) return cached;
  const out = new Map<string, BudgetObservation[]>();
  // The candidate set is the frontier plus the window; coverage and the
  // controls describe exactly the rows the lanes could select from.
  for (const read of snapshot.budgetObservationPitWinners ?? []) {
    const key = bindingKey(read.businessId ?? "", read.providerAccountId ?? "");
    const binding = {
      businessId: read.businessId ?? "",
      providerAccountId: read.providerAccountId ?? "",
    };
    const rows = read.rows
      .map((r) => toBudgetObservation(r, binding))
      .filter((r): r is BudgetObservation => r !== null);
    out.set(key, [...(out.get(key) ?? []), ...rows]);
  }
  OBSERVATION_CACHE.set(snapshot, out);
  return out;
}

/**
 * Rows indexed by binding and entity. Without this the lane scans every row of
 * a binding for every entity at every origin, which is quadratic and turns a
 * 40,000-row account into 1.6 billion comparisons.
 */
export function indexObservations(
  snapshot: Record<string, D083MaterialisedRead[]>,
): Map<string, Map<string, BudgetObservation[]>> {
  const out = new Map<string, Map<string, BudgetObservation[]>>();
  for (const [key, rows] of observationsByBinding(snapshot)) {
    const byEntity = new Map<string, BudgetObservation[]>();
    for (const row of rows) {
      const entityKey = `${row.entityGrain}|${row.entityId}`;
      const list = byEntity.get(entityKey);
      if (list) list.push(row);
      else byEntity.set(entityKey, [row]);
    }
    for (const list of byEntity.values()) {
      list.sort((a, b) => {
        if (a.observedAtMs !== b.observedAtMs) return (b.observedAtMs ?? 0) - (a.observedAtMs ?? 0);
        return (b.capturedAtMs ?? 0) - (a.capturedAtMs ?? 0);
      });
    }
    out.set(key, byEntity);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Coverage: what the retained observation actually contains
// ---------------------------------------------------------------------------

export interface CoverageResult {
  truth: "verified_fact";
  perBinding: Row[];
  runCensus: Row[];
  parentIdentity: Row[];
  configBudgetShape: Row[];
  currencies: Row[];
  schemaCensus: Row[];
  scheduleAndExponentColumns: Row[];
  scheduleRetained: boolean;
  exponentRetained: boolean;
  genuinelyAmbiguousRows: number;
  configurationCensus: Row[];
  observationRunManifest: Row[];
  note: string;
}

export function computeCoverage(snapshot: Record<string, D083MaterialisedRead[]>): CoverageResult {
  const schemaCensus = (snapshot.stateHistorySchema ?? []).flatMap((r) => r.rows);
  const found = (snapshot.scheduleAndExponentSearch ?? []).flatMap((r) => r.rows);

  const scheduleColumns = found.filter((r) =>
    /(start_time|end_time|stop_time|schedule)/i.test(String(r.column_name ?? "")),
  );
  const exponentColumns = found.filter((r) =>
    /(exponent|minor_unit|currency_scale|currency_decimal)/i.test(String(r.column_name ?? "")),
  );
  const budgetTables = new Set([
    STATE_HISTORY_TABLE,
    "meta_campaign_config_history",
    "meta_adset_config_history",
  ]);
  const scheduleOnBudgetTable = scheduleColumns.filter((r) =>
    budgetTables.has(String(r.table_name ?? "")),
  );

  // Retained volume comes from the census over the whole table. The candidate
  // set is a frontier, not a sample of it, so reporting its size as "how much
  // history exists" would understate retention by two orders of magnitude.
  const retained = new Map<string, { rows: number; entities: number; earliest: string | null }>();
  for (const read of snapshot.observationRunCensus ?? []) {
    const key = bindingKey(read.businessId ?? "", read.providerAccountId ?? "");
    const at = retained.get(key) ?? { rows: 0, entities: 0, earliest: null };
    for (const row of read.rows) {
      const grain = trimmedText(row.entity_type);
      if (grain !== "campaign" && grain !== "adset") continue;
      at.rows += Number(row.rows ?? 0);
      at.entities += Number(row.entities ?? 0);
      const earliest = trimmedText(row.earliest_observed);
      if (earliest && (at.earliest === null || earliest < at.earliest)) at.earliest = earliest;
    }
    retained.set(key, at);
  }

  const byBinding = observationsByBinding(snapshot);
  const perBinding: Row[] = D080_PINNED_BINDINGS.map((binding) => {
    const key = bindingKey(binding.businessId, binding.providerAccountId);
    const rows = byBinding.get(key) ?? [];
    const adsets = rows.filter((r) => r.entityGrain === "adset");
    const census = retained.get(key) ?? { rows: 0, entities: 0, earliest: null };
    return {
      business: binding.business,
      businessId: binding.businessId,
      providerAccountId: binding.providerAccountId,
      accountSelected: binding.isSelected,
      // What the table holds.
      retainedRows: census.rows,
      retainedEntityRuns: census.entities,
      earliestObserved: census.earliest,
      // What the point-in-time candidate frontier kept from it. These are not a
      // count of history; they are the rows that can win at some origin.
      candidateObservations: rows.length,
      candidateDistinctEntities: new Set(rows.map((r) => `${r.entityGrain}|${r.entityId}`)).size,
      candidateDistinctObservedDays: new Set(rows.map((r) => r.observedOn)).size,
      candidateAdsetRows: adsets.length,
      candidateAdsetRowsWithParent: adsets.filter((r) => r.parentCampaignId !== null).length,
      candidateCompleteRuns: rows.filter((r) => r.runCompleteness === "complete").length,
      candidateIncompleteRuns: rows.filter((r) => r.runCompleteness !== "complete").length,
      currencies: sortedUnique(rows.map((r) => r.budgetCurrency ?? "unknown")),
    };
  });

  const shape = (planKey: string, grain: string): Row[] =>
    (snapshot[planKey] ?? []).flatMap((read) =>
      read.rows.map((r) => ({
        grain,
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        rows: Number(r.rows ?? 0),
        bothPresent: Number(r.both_present ?? 0),
        bothPositive: Number(r.both_positive ?? 0),
        dailyBinding: Number(r.daily_binding ?? 0),
        lifetimeBinding: Number(r.lifetime_binding ?? 0),
        neither: Number(r.neither ?? 0),
        earliestEffective: trimmedText(r.earliest_effective),
        latestEffective: trimmedText(r.latest_effective),
      })),
    );
  const configBudgetShape = [
    ...shape("campaignConfigBudgetShape", "campaign"),
    ...shape("adsetConfigBudgetShape", "adset"),
  ];
  const genuinelyAmbiguousRows = configBudgetShape.reduce(
    (a, r) => a + Number(r.bothPositive ?? 0),
    0,
  );

  return {
    truth: "verified_fact",
    perBinding,
    runCensus: (snapshot.observationRunCensus ?? []).flatMap((read) =>
      read.rows.map((r) => ({
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        entityType: trimmedText(r.entity_type),
        runCompleteness: trimmedText(r.run_completeness),
        presence: trimmedText(r.presence),
        budgetOrigin: trimmedText(r.budget_origin),
        rows: Number(r.rows ?? 0),
        entities: Number(r.entities ?? 0),
        earliestObserved: trimmedText(r.earliest_observed),
        latestObserved: trimmedText(r.latest_observed),
      })),
    ),
    parentIdentity: (snapshot.parentIdentityCensus ?? []).flatMap((read) =>
      read.rows.map((r) => ({
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        adsetRows: Number(r.adset_rows ?? 0),
        rowsWithParent: Number(r.rows_with_parent ?? 0),
        adsets: Number(r.adsets ?? 0),
        adsetsWithParent: Number(r.adsets_with_parent ?? 0),
      })),
    ),
    configBudgetShape,
    currencies: (snapshot.accountCurrency ?? []).flatMap((read) =>
      read.rows.map((r) => ({
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        currency: trimmedText(r.account_currency),
      })),
    ),
    schemaCensus,
    scheduleAndExponentColumns: found,
    scheduleRetained: scheduleOnBudgetTable.length > 0,
    exponentRetained: exponentColumns.length > 0,
    genuinelyAmbiguousRows,
    configurationCensus: (snapshot.configurationCensus ?? []).flatMap((read) =>
      read.rows.map((r) => ({
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        rows: Number(r.rows ?? 0),
        distinctObjectives: Number(r.distinct_objectives ?? 0),
        objectiveNull: Number(r.objective_null ?? 0),
        distinctBuyingTypes: Number(r.distinct_buying_types ?? 0),
        buyingTypeNull: Number(r.buying_type_null ?? 0),
        distinctBidStrategies: Number(r.distinct_bid_strategies ?? 0),
        bidStrategyNull: Number(r.bid_strategy_null ?? 0),
        distinctOptimizationGoals: Number(r.distinct_optimization_goals ?? 0),
        budgetMixedRows: Number(r.budget_mixed_rows ?? 0),
        advantagePlusOrSharedBudgetIndicator: null,
        advantagePlusNote:
          "No provider field for an Advantage+ or shared-budget shape is requested or retained anywhere in the schema, so shape is unobservable and every fact reports shape_not_observed.",
      })),
    ),
    observationRunManifest: (snapshot.observationRunManifest ?? []).flatMap((read) =>
      read.rows.map((r) => ({
        businessId: read.businessId,
        providerAccountId: read.providerAccountId,
        completeness: trimmedText(r.completeness),
        runs: Number(r.runs ?? 0),
        runsWithSnapshot: Number(r.runs_with_snapshot ?? 0),
        runsWithPayloadHash: Number(r.runs_with_payload_hash ?? 0),
        distinctContractVersions: Number(r.distinct_contract_versions ?? 0),
        earliestCaptured: trimmedText(r.earliest_captured),
        latestCaptured: trimmedText(r.latest_captured),
        providerApiVersionRetained: false,
        providerApiVersionNote:
          "No table retains the Graph API version a row was fetched under. It stays unknown for history; the sync now pins it going forward.",
      })),
    ),
    note:
      "A budget row is ambiguous only when both the daily and the lifetime amount are positive. Counting rows where both fields are merely present conflates the provider's zero sentinel with real ambiguity, which is what the earlier census did.",
  };
}

// ---------------------------------------------------------------------------
// Point-in-time budget facts at the pinned origins
// ---------------------------------------------------------------------------

export function scopeOriginKey(
  businessId: string,
  providerAccountId: string,
  grain: string,
  entityId: string,
  origin: string,
): string {
  return [businessId, providerAccountId, grain, entityId, origin].join("|");
}

export interface LaneFacts {
  lane: D083Lane;
  truth: "verified_fact" | "counterfactual_reconstruction";
  requireRecordedByCutoff: boolean;
  factsResolved: number;
  /** Owner and amount proven, from correctly scoped and complete rows. */
  ownerResolvedFacts: number;
  /**
   * Everything a budget intent needs is proven. Historically this is zero,
   * because no provider budget-shape field was ever requested or retained and
   * the captured currency exponent was never written.
   */
  intentReadyFacts: number;
  blockerCensus: Record<string, number>;
  ownerModeCensus: Record<string, number>;
  budgetFieldCensus: Record<string, number>;
  byOrigin: Row[];
  perBinding: Row[];
  ownerResolvedScopeOriginKeys: string[];
  intentReadyScopeOriginKeys: string[];
  /** Ad-set origins whose parent was learned from the child selected AT that origin. */
  parentResolvedScopeOriginKeys: string[];
  timezoneProvenance: Row[];
}

/** The account timezone, per binding, with its provenance and stability. */
export function accountTimeZones(
  snapshot: Record<string, D083MaterialisedRead[]>,
): Map<string, { timeZone: string | null; distinct: string[]; rows: number; stable: boolean }> {
  const out = new Map<string, { timeZone: string | null; distinct: string[]; rows: number; stable: boolean }>();
  for (const read of snapshot.accountTimezone ?? []) {
    const key = bindingKey(read.businessId ?? "", read.providerAccountId ?? "");
    const zones = read.rows
      .map((r) => trimmedText(r.account_timezone))
      .filter((z): z is string => z !== null);
    const rows = read.rows.reduce((a, r) => a + Number(r.rows ?? 0), 0);
    const distinct = sortedUnique(zones);
    out.set(key, {
      // One observed timezone over the whole retained window is the only case
      // this audit treats as usable. Two would mean the account was rebased and
      // no single cutoff is correct for the window.
      timeZone: distinct.length === 1 ? distinct[0]! : null,
      distinct,
      rows,
      stable: distinct.length === 1,
    });
  }
  return out;
}

/**
 * Every entity-origin pair in the D080B universe, resolved through the one
 * canonical boundary. The parent campaign is learned from the child observation
 * selected AT that origin, so a later row can never repair an earlier one.
 */
export function computeLaneFacts(input: {
  snapshot: Record<string, D083MaterialisedRead[]>;
  entities: readonly Row[];
  origins: readonly string[];
  lane: D083Lane;
}): LaneFacts {
  const requireRecorded = input.lane === "strict_pit_authority";
  const zones = accountTimeZones(input.snapshot);

  // The candidate set, indexed by binding and entity. Both lanes read the same
  // rows; the lane predicate is applied by the canonical selector, not by two
  // different SQL statements that could drift apart.
  const candidates = new Map<string, Map<string, BudgetObservation[]>>();
  for (const read of input.snapshot.budgetObservationPitWinners ?? []) {
    const key = bindingKey(read.businessId ?? "", read.providerAccountId ?? "");
    const byKey = candidates.get(key) ?? new Map<string, BudgetObservation[]>();
    for (const row of read.rows) {
      const observation = toBudgetObservation(row, {
        businessId: read.businessId ?? "",
        providerAccountId: read.providerAccountId ?? "",
      });
      if (!observation) continue;
      const slot = `${observation.entityGrain}|${observation.entityId}`;
      const list = byKey.get(slot);
      if (list) list.push(observation);
      else byKey.set(slot, [observation]);
    }
    candidates.set(key, byKey);
  }

  const blockers: string[] = [];
  const ownerModes: string[] = [];
  const budgetFields: string[] = [];
  const ownerKeys: string[] = [];
  const intentKeys: string[] = [];
  const parentKeys: string[] = [];
  const perOrigin = new Map<string, { resolved: number; ownerResolved: number; intentReady: number }>();
  const perBindingTotals = new Map<string, { resolved: number; ownerResolved: number; intentReady: number; parent: number }>();
  let factsResolved = 0;
  let ownerResolvedFacts = 0;
  let intentReadyFacts = 0;

  for (const entity of input.entities) {
    const businessId = String(entity.business_id ?? "");
    const account = String(entity.provider_account_id ?? "");
    const grain = String(entity.grain ?? "") as BudgetEntityGrain;
    const entityId = String(entity.entity_id ?? "");
    const key = bindingKey(businessId, account);
    const byKey = candidates.get(key) ?? new Map<string, BudgetObservation[]>();
    const timeZone = zones.get(key)?.timeZone ?? "";
    const entityRows = byKey.get(`${grain}|${entityId}`) ?? [];

    for (const origin of input.origins) {
      const pit = { asOf: origin, timeZone, requireRecordedByCutoff: requireRecorded };
      const child = selectObservationAtPit(entityRows, pit);
      // A campaign request has no parent; an ad set takes the parent its own
      // selected observation declares, at this origin only.
      const parentCampaignId = grain === "adset" ? (child?.parentCampaignId ?? null) : null;
      const parentRows =
        grain === "adset" && parentCampaignId
          ? (byKey.get(`campaign|${parentCampaignId}`) ?? [])
          : [];

      const fact = buildCanonicalBudgetFact({
        businessId,
        providerAccountId: account,
        entityGrain: grain,
        entityId,
        parentCampaignId,
        pit,
        entityObservations: entityRows,
        parentObservations: parentRows,
      });

      const totals = perOrigin.get(origin) ?? { resolved: 0, ownerResolved: 0, intentReady: 0 };
      const bindingTotals =
        perBindingTotals.get(key) ?? { resolved: 0, ownerResolved: 0, intentReady: 0, parent: 0 };
      const scopeKey = scopeOriginKey(businessId, account, grain, entityId, origin);

      if (child !== null || entityRows.length > 0) {
        factsResolved += 1;
        totals.resolved += 1;
        bindingTotals.resolved += 1;
        ownerModes.push(fact.ownerMode);
        budgetFields.push(fact.budgetField);
        for (const blocker of fact.blockers) blockers.push(blocker);
        if (grain === "adset" && parentCampaignId) {
          bindingTotals.parent += 1;
          parentKeys.push(scopeKey);
        }
      }
      if (fact.ownerResolved) {
        ownerResolvedFacts += 1;
        totals.ownerResolved += 1;
        bindingTotals.ownerResolved += 1;
        ownerKeys.push(scopeKey);
      }
      if (fact.intentReady) {
        intentReadyFacts += 1;
        totals.intentReady += 1;
        bindingTotals.intentReady += 1;
        intentKeys.push(scopeKey);
      }
      perOrigin.set(origin, totals);
      perBindingTotals.set(key, bindingTotals);
    }
  }

  return {
    lane: input.lane,
    truth: requireRecorded ? "verified_fact" : "counterfactual_reconstruction",
    requireRecordedByCutoff: requireRecorded,
    factsResolved,
    ownerResolvedFacts,
    intentReadyFacts,
    blockerCensus: tally(blockers),
    ownerModeCensus: tally(ownerModes),
    budgetFieldCensus: tally(budgetFields),
    byOrigin: input.origins.map((origin) => ({
      origin,
      resolved: perOrigin.get(origin)?.resolved ?? 0,
      ownerResolved: perOrigin.get(origin)?.ownerResolved ?? 0,
      intentReady: perOrigin.get(origin)?.intentReady ?? 0,
    })),
    perBinding: D080_PINNED_BINDINGS.map((binding) => {
      const k = bindingKey(binding.businessId, binding.providerAccountId);
      const totals = perBindingTotals.get(k);
      const zone = zones.get(k);
      return {
        business: binding.business,
        businessId: binding.businessId,
        providerAccountId: binding.providerAccountId,
        accountSelected: binding.isSelected,
        timeZone: zone?.timeZone ?? null,
        resolved: totals?.resolved ?? 0,
        ownerResolved: totals?.ownerResolved ?? 0,
        intentReady: totals?.intentReady ?? 0,
        adsetOriginsWithParent: totals?.parent ?? 0,
      };
    }),
    ownerResolvedScopeOriginKeys: sortedUnique(ownerKeys),
    intentReadyScopeOriginKeys: sortedUnique(intentKeys),
    parentResolvedScopeOriginKeys: sortedUnique(parentKeys),
    timezoneProvenance: D080_PINNED_BINDINGS.map((binding) => {
      const zone = zones.get(bindingKey(binding.businessId, binding.providerAccountId));
      return {
        businessId: binding.businessId,
        providerAccountId: binding.providerAccountId,
        timeZone: zone?.timeZone ?? null,
        distinctObserved: zone?.distinct ?? [],
        sourceRows: zone?.rows ?? 0,
        stableOverWindow: zone?.stable ?? false,
        truth: "verified_fact",
        note: "Observed per source day on meta_campaign_daily. A single value across every retained day is treated as the account's timezone for the window; two or more would mean no single cutoff is correct and the binding fails closed.",
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Proposal impact, against the corrected D082 baseline
// ---------------------------------------------------------------------------

export const D081_CLOSED_BLOCKERS = ["decision_vocabulary_absent", "unit_exponent_unknown"] as const;
export const ROLE_BLOCKER = "role_authority_absent" as const;

/**
 * Only the blockers a proven owner/amount fact actually answers.
 *
 * `status_evidence_absent` is deliberately NOT here. The first version cleared
 * it whenever the money fact was usable, but the canonical fact does not prove
 * the subject and parent status evidence that blocker names. A blocker may only
 * be cleared by the exact field that proves it.
 */
export const D083_OWNER_ADDRESSED_BLOCKERS = [
  "owner_evidence_absent",
  "owner_mode_ambiguous",
  "budget_field_ambiguous",
  "budget_value_absent",
] as const;

export function proposalCampaignIdentity(p: BudgetResearchProposal): string | null {
  return p.entityGrain === "campaign" ? p.entityId : p.campaignId;
}

export interface ProposalImpactResult {
  /** The gates the canonical fact actually applies, terminating at its own gate. */
  canonicalIntentReadinessFunnel: Row[];
  denominators: Row;
  baselineD082: Row;
  joinability: Row[];
  perLane: Row[];
  breakdowns: Row;
  blockerCensusAfterOverlay: Row;
  funnelAfterOverlay: Row[];
  funnelAfterOverlayLabel: string;
  exposure: Row;
}

export function computeProposalImpact(input: {
  proposals: readonly BudgetResearchProposal[];
  origins: readonly OriginPlan[];
  lanes: readonly LaneFacts[];
  d082Baseline: Row;
  roleResolvedScopes: ReadonlySet<string>;
}): ProposalImpactResult {
  const foldByOrigin = new Map(input.origins.map((o) => [o.origin, o.fold]));
  const total = input.proposals.length;
  const perLane: Row[] = [];
  const breakdowns: Row = {};
  const censusAfter: Record<string, number> = {};
  const joinability: Row[] = [];
  const funnelAfter: Row[] = [];

  for (const lane of input.lanes) {
    const ownerResolved = new Set(lane.ownerResolvedScopeOriginKeys);
    const intentReady = new Set(lane.intentReadyScopeOriginKeys);
    // Parent identity, per lane and per origin, learned only from the child
    // observation selected at that origin.
    const parentAtOrigin = new Set(lane.parentResolvedScopeOriginKeys);

    let ownerCount = 0;
    let intentCount = 0;
    let zeroResidual = 0;
    let hadIdentity = 0;
    let recovered = 0;
    let stillUnjoinable = 0;
    const byBusiness: Record<string, number> = {};
    const byAccount: Record<string, number> = {};
    const bySelected: Record<string, number> = {};
    const byGrain: Record<string, number> = {};
    const byFold: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};

    for (const p of input.proposals) {
      const key = scopeOriginKey(
        p.businessId,
        p.providerAccountId,
        p.entityGrain,
        p.entityId,
        p.originDate,
      );
      const owner = ownerResolved.has(key);
      if (owner) {
        ownerCount += 1;
        byBusiness[p.business] = (byBusiness[p.business] ?? 0) + 1;
        byAccount[p.providerAccountId] = (byAccount[p.providerAccountId] ?? 0) + 1;
        bySelected[String(p.accountSelected)] = (bySelected[String(p.accountSelected)] ?? 0) + 1;
        byGrain[p.entityGrain] = (byGrain[p.entityGrain] ?? 0) + 1;
        const fold = `fold_${foldByOrigin.get(p.originDate) ?? "unknown"}`;
        byFold[fold] = (byFold[fold] ?? 0) + 1;
        byOrigin[p.originDate] = (byOrigin[p.originDate] ?? 0) + 1;
      }
      if (intentReady.has(key)) intentCount += 1;

      // Joinability, per lane and origin.
      const declared = proposalCampaignIdentity(p);
      if (declared) hadIdentity += 1;
      else if (parentAtOrigin.has(key)) recovered += 1;
      else stillUnjoinable += 1;

      const campaignId = declared;
      const roleClosed =
        campaignId !== null &&
        input.roleResolvedScopes.has(
          [p.businessId, p.providerAccountId, campaignId, p.originDate].join("|"),
        );
      const residual = p.blockers.filter(
        (b) =>
          !(D081_CLOSED_BLOCKERS as readonly string[]).includes(b) &&
          !(b === ROLE_BLOCKER && roleClosed) &&
          !(owner && (D083_OWNER_ADDRESSED_BLOCKERS as readonly string[]).includes(b)),
      );
      if (residual.length === 0) zeroResidual += 1;
      if (lane.lane === "retrospective_finalized_conditional") {
        for (const b of residual) censusAfter[b] = (censusAfter[b] ?? 0) + 1;
      }
    }

    perLane.push({
      lane: lane.lane,
      truth: lane.truth,
      proposalsTotal: total,
      ownerResolvedProposals: ownerCount,
      intentReadyProposals: intentCount,
      proposalsWithNoResidualBlocker: zeroResidual,
    });
    joinability.push({
      lane: lane.lane,
      proposalsWithDeclaredCampaignIdentity: hadIdentity,
      parentRecoveredAtThatOrigin: recovered,
      stillWithoutCampaignIdentity: stillUnjoinable,
      note: "Recovery is per lane and per origin, from the child observation selected at that origin. A later observation can never repair an earlier origin.",
    });
    breakdowns[lane.lane] = {
      byBusiness: Object.fromEntries(Object.entries(byBusiness).sort()),
      byAccount: Object.fromEntries(Object.entries(byAccount).sort()),
      bySelectedState: Object.fromEntries(Object.entries(bySelected).sort()),
      byGrain: Object.fromEntries(Object.entries(byGrain).sort()),
      byFold: Object.fromEntries(Object.entries(byFold).sort()),
      byOrigin: Object.fromEntries(Object.entries(byOrigin).sort()),
    };
  }

  const conditional = input.lanes.find((l) => l.lane === "retrospective_finalized_conditional");
  const ownerResolved = new Set(conditional?.ownerResolvedScopeOriginKeys ?? []);
  const stages: Array<{ stage: string; codes: string[] }> = [
    { stage: "1 - scope", codes: ["account_not_selected", "scope_not_pinned"] },
    {
      stage: "2 - money shape",
      codes: [
        "owner_evidence_absent",
        "budget_field_ambiguous",
        "owner_mode_ambiguous",
        "lifetime_schedule_unretained",
        "budget_value_absent",
        "budget_not_binding",
      ],
    },
    { stage: "3 - delivery", codes: ["parent_not_active", "status_not_active", "status_evidence_absent"] },
    {
      stage: "4 - authority",
      codes: [ROLE_BLOCKER, "commercial_target_absent", "commercial_target_stale", "objective_identity_unknown"],
    },
    { stage: "5 - evidence", codes: ["spend_evidence_floor", "conversion_evidence_floor", "observation_stale"] },
    {
      stage: "6 - change safety",
      codes: ["recent_change_cooldown", "oscillation_risk", "conflicting_transition", "entity_cap"],
    },
  ];
  let survivors = [...input.proposals];
  funnelAfter.push({ stage: "0 - all candidates", survivors: survivors.length, eliminated: 0 });
  for (const stage of stages) {
    const before = survivors.length;
    survivors = survivors.filter((p) => {
      const key = scopeOriginKey(
        p.businessId,
        p.providerAccountId,
        p.entityGrain,
        p.entityId,
        p.originDate,
      );
      const owner = ownerResolved.has(key);
      const campaignId = proposalCampaignIdentity(p);
      const roleClosed =
        campaignId !== null &&
        input.roleResolvedScopes.has(
          [p.businessId, p.providerAccountId, campaignId, p.originDate].join("|"),
        );
      return !p.blockers.some(
        (b) =>
          stage.codes.includes(b) &&
          !(D081_CLOSED_BLOCKERS as readonly string[]).includes(b) &&
          !(b === ROLE_BLOCKER && roleClosed) &&
          !(owner && (D083_OWNER_ADDRESSED_BLOCKERS as readonly string[]).includes(b)),
      );
    });
    funnelAfter.push({
      stage: stage.stage,
      survivors: survivors.length,
      eliminated: before - survivors.length,
    });
  }

  // The canonical funnel: the actual gates the canonical fact applies, in the
  // order it applies them. Unlike the overlay above, this injects the new
  // shape/exponent/provenance blockers, so it reaches zero at the exact gate.
  const canonicalFunnel: Row[] = [];
  {
    const conditionalLane = input.lanes.find(
      (l) => l.lane === "retrospective_finalized_conditional",
    );
    const census = conditionalLane?.blockerCensus ?? {};
    const resolvedFacts = conditionalLane?.factsResolved ?? 0;
    const stages: Array<{ stage: string; blocker: string }> = [
      { stage: "1 - observed at the origin", blocker: "budget_not_observed" },
      { stage: "2 - complete scope and present", blocker: "observation_not_complete_scope" },
      { stage: "3 - hierarchy resolved", blocker: "owner_unresolved_hierarchy" },
      { stage: "4 - owner and amount proven", blocker: "budget_field_none" },
      { stage: "5 - schedule where required", blocker: "lifetime_schedule_unretained" },
      { stage: "6 - captured currency exponent", blocker: "currency_exponent_not_captured" },
      { stage: "7 - observed budget shape", blocker: "budget_shape_not_observed" },
    ];
    let survivors = resolvedFacts;
    canonicalFunnel.push({
      stage: "0 - entity-origin pairs with any observation",
      survivors,
      eliminated: 0,
      gate: null,
    });
    for (const stage of stages) {
      const eliminated = Math.min(survivors, Number(census[stage.blocker] ?? 0));
      survivors -= eliminated;
      canonicalFunnel.push({ stage: stage.stage, survivors, eliminated, gate: stage.blocker });
    }
    canonicalFunnel.push({
      stage: "intent-ready",
      survivors: conditionalLane?.intentReadyFacts ?? 0,
      eliminated: 0,
      gate: null,
      note: "The canonical gate this evidence terminates at is budget_shape_not_observed, which no retained row can pass.",
    });
  }

  return {
    canonicalIntentReadinessFunnel: canonicalFunnel,
    denominators: {
      proposals: total,
      origins: input.origins.length,
      bindings: D080_PINNED_BINDINGS.length,
      note: "Recovered by re-deriving the pinned D080B analysis from its own frozen reads. D083 never re-counts the proposal universe.",
    },
    baselineD082: input.d082Baseline,
    joinability,
    perLane,
    breakdowns,
    blockerCensusAfterOverlay: Object.fromEntries(Object.entries(censusAfter).sort()),
    funnelAfterOverlay: funnelAfter,
    funnelAfterOverlayLabel:
      "owner/amount counterfactual over the legacy D080B blocker codes. It does not inject the canonical shape, exponent or provenance blockers, so it is not a money-shape or intent-readiness funnel.",
    exposure: {
      basis: "nominal_proposed_only",
      spendMoved: null,
      revenueMoved: null,
      note: "No proposal was executed, queued or served. D083 adds no execution path and no dispatch verb.",
    },
  };
}

// ---------------------------------------------------------------------------
// Temporal controls, sealed and re-derived
// ---------------------------------------------------------------------------

/**
 * Semantic, identity-bearing temporal controls.
 *
 * Correction 1's controls were tautological: `pass` was `baselineRows >= 0`, the
 * overwrite control explicitly permitted selecting the newest row, and the
 * future-recorded control ignored whether the finalized lane actually saw more.
 * Each control here names the exact observations involved and publishes the raw
 * fields, so a reader — and the verifier — can recompute the verdict instead of
 * trusting it. When no real row qualifies, that absence is published and the
 * control is marked vacuous rather than dressed up.
 */
export function buildTemporalControls(
  snapshot: Record<string, D083MaterialisedRead[]>,
  origins: readonly string[],
): Row[] {
  const indexed = indexObservations(snapshot);
  const zones = accountTimeZones(snapshot);
  const controls: Row[] = [];

  const pickAt = (rows: readonly BudgetObservation[], asOf: string, tz: string, strict: boolean) =>
    selectObservationAtPit(rows, { asOf, timeZone: tz, requireRecordedByCutoff: strict });

  // ---- 1. a row recorded after the cutoff is invisible to the strict lane,
  //         and the finalized lane sees the later-known truth instead.
  let recordedLate: Row = {
    control: "future_recorded_row_excluded_from_strict",
    realCaseFound: false,
    expectation:
      "strict selects an older predecessor or nothing; finalized selects the later-recorded row",
    pass: true,
    nonVacuous: false,
    why: "no retained entity has a row effective before an origin but recorded after it",
  };
  // ---- 2. an early origin selects the then-current row, never a later overwrite.
  let overwrite: Row = {
    control: "early_origin_does_not_select_a_later_overwrite",
    realCaseFound: false,
    expectation: "the row selected at an early origin is effective before it and is not the newest row",
    pass: true,
    nonVacuous: false,
    why: "no retained entity has two observations straddling an origin",
  };
  // ---- 3. a pre-window predecessor is actually selected at a named origin.
  let predecessor: Row = {
    control: "pre_window_predecessor_is_selected",
    realCaseFound: false,
    expectation: "an observation effective before the read window wins at an in-window origin",
    pass: true,
    nonVacuous: false,
    why: "no entity's winning observation at any origin comes from before the window",
  };

  // "Pre-window" is now a property of the observation itself — effective before
  // the first origin's local cutoff — not of which read carried it. Correction
  // 2 asked which read a row came from, which stopped meaning anything once the
  // candidate set became one deduplicated frontier.
  const firstOriginCutoff = new Map<string, number>();
  for (const binding of D080_PINNED_BINDINGS) {
    const key = bindingKey(binding.businessId, binding.providerAccountId);
    const zone = zones.get(key)?.timeZone;
    const cutoff = zone ? pitCutoffMs(origins[0]!, zone) : null;
    if (cutoff !== null) firstOriginCutoff.set(key, cutoff);
  }

  for (const binding of D080_PINNED_BINDINGS) {
    const key = bindingKey(binding.businessId, binding.providerAccountId);
    const timeZone = zones.get(key)?.timeZone;
    if (!timeZone) continue;
    const byEntity = indexed.get(key);
    if (!byEntity) continue;

    for (const [entityKey, rows] of byEntity) {
      for (const origin of origins) {
        const cutoff = pitCutoffMs(origin, timeZone);
        if (cutoff === null) continue;
        const strict = pickAt(rows, origin, timeZone, true);
        const finalized = pickAt(rows, origin, timeZone, false);

        if (
          recordedLate.realCaseFound !== true &&
          finalized !== null &&
          finalized.capturedAtMs !== null &&
          finalized.capturedAtMs > cutoff &&
          (strict === null || strict.observationId !== finalized.observationId)
        ) {
          recordedLate = {
            control: "future_recorded_row_excluded_from_strict",
            realCaseFound: true,
            binding: key,
            entity: entityKey,
            origin,
            cutoffMs: cutoff,
            finalizedObservationId: finalized.observationId,
            finalizedEffectiveAtMs: finalized.observedAtMs,
            finalizedRecordedAtMs: finalized.capturedAtMs,
            strictObservationId: strict?.observationId ?? null,
            strictEffectiveAtMs: strict?.observedAtMs ?? null,
            strictRecordedAtMs: strict?.capturedAtMs ?? null,
            expectation:
              "the finalized winner was recorded after the cutoff, and the strict lane selected a different, earlier-known row or nothing",
            pass:
              finalized.capturedAtMs > cutoff &&
              (strict === null ||
                (strict.capturedAtMs !== null && strict.capturedAtMs <= cutoff)),
            nonVacuous: true,
          };
        }

        if (
          overwrite.realCaseFound !== true &&
          finalized !== null &&
          rows.length > 1
        ) {
          const newest = rows.reduce((best, row) =>
            (row.observedAtMs ?? -1) > (best.observedAtMs ?? -1) ? row : best,
          );
          if (
            newest.observationId !== finalized.observationId &&
            (newest.observedAtMs ?? 0) >= cutoff
          ) {
            overwrite = {
              control: "early_origin_does_not_select_a_later_overwrite",
              realCaseFound: true,
              binding: key,
              entity: entityKey,
              origin,
              cutoffMs: cutoff,
              selectedObservationId: finalized.observationId,
              selectedEffectiveAtMs: finalized.observedAtMs,
              newestObservationId: newest.observationId,
              newestEffectiveAtMs: newest.observedAtMs,
              expectation:
                "a strictly later observation exists, and the origin selected the earlier one that was effective before the cutoff",
              pass:
                finalized.observationId !== newest.observationId &&
                (finalized.observedAtMs ?? 0) < cutoff &&
                (newest.observedAtMs ?? 0) >= cutoff,
              nonVacuous: true,
            };
          }
        }

        if (
          predecessor.realCaseFound !== true &&
          strict !== null &&
          strict.observationId !== null &&
          strict.observedAtMs !== null &&
          strict.observedAtMs < (firstOriginCutoff.get(key) ?? Number.NEGATIVE_INFINITY)
        ) {
          predecessor = {
            control: "pre_window_predecessor_is_selected",
            realCaseFound: true,
            binding: key,
            entity: entityKey,
            origin,
            selectedObservationId: strict.observationId,
            selectedEffectiveAtMs: strict.observedAtMs,
            selectedRecordedAtMs: strict.capturedAtMs,
            firstOriginCutoffMs: firstOriginCutoff.get(key) ?? null,
            expectation:
              "the winning observation at an in-window origin was effective before the first origin, so no lookback horizon may bound the candidate set",
            pass: true,
            nonVacuous: true,
          };
        }
      }
    }
  }
  controls.push(recordedLate, overwrite, predecessor);

  // ---- 4. full-history completeness: winners were selected from everything.
  const census = (snapshot.fullHistoryCensus ?? []).flatMap((r) =>
    r.rows.map((row) => ({
      businessId: r.businessId,
      providerAccountId: r.providerAccountId,
      entityType: trimmedText(row.entity_type),
      rows: Number(row.rows ?? 0),
      entities: Number(row.entities ?? 0),
      earliestObserved: trimmedText(row.earliest_observed),
      rowsBeforeFirstOrigin: Number(row.rows_before_first_origin ?? 0),
    })),
  );
  const totalRows = census.reduce((a, r) => a + r.rows, 0);
  const beforeFirstOrigin = census.reduce((a, r) => a + r.rowsBeforeFirstOrigin, 0);
  const earliest = census
    .map((r) => r.earliestObserved)
    .filter((d): d is string => d !== null)
    .sort()[0] ?? null;
  controls.push({
    control: "winners_selected_over_full_history",
    lookbackHorizonDays: BASELINE_LOOKBACK_DAYS,
    totalRetainedRows: totalRows,
    rowsBeforeFirstOrigin: beforeFirstOrigin,
    earliestObservedDate: earliest,
    perBinding: census,
    expectation:
      "no lookback horizon is applied, so a predecessor from before the first origin is selectable; the census reports how much history that actually is",
    pass: BASELINE_LOOKBACK_DAYS === null,
    // Non-vacuous only because substantial history really does precede the
    // first origin: Correction 2's floor would have discarded it.
    nonVacuous: beforeFirstOrigin > 0,
  });

  // ---- 5. an impossible calendar date is refused, not rolled over.
  controls.push({
    control: "invalid_as_of_date_is_refused",
    samples: [
      { asOf: "2026-02-31", cutoffMs: pitCutoffMs("2026-02-31", "UTC") },
      { asOf: "2026-02-29", cutoffMs: pitCutoffMs("2026-02-29", "UTC"), note: "2026 is not a leap year" },
      { asOf: "2024-02-29", cutoffMs: pitCutoffMs("2024-02-29", "UTC"), note: "2024 is a leap year" },
      { asOf: "2026-13-01", cutoffMs: pitCutoffMs("2026-13-01", "UTC") },
    ],
    expectation: "an impossible date resolves to no cutoff; a real leap day resolves normally",
    pass:
      pitCutoffMs("2026-02-31", "UTC") === null &&
      pitCutoffMs("2026-02-29", "UTC") === null &&
      pitCutoffMs("2026-13-01", "UTC") === null &&
      pitCutoffMs("2024-02-29", "UTC") === Date.parse("2024-02-29T00:00:00.000Z"),
    nonVacuous: true,
  });

  // ---- 6. the account cutoff is genuinely not UTC.
  const zoneRows = D080_PINNED_BINDINGS.map((b) => {
    const zone = zones.get(bindingKey(b.businessId, b.providerAccountId))?.timeZone ?? null;
    const origin = origins[0] ?? "2026-04-30";
    const local = zone ? pitCutoffMs(origin, zone) : null;
    const utc = Date.parse(`${origin}T00:00:00.000Z`);
    return {
      providerAccountId: b.providerAccountId,
      timeZone: zone,
      localCutoffMs: local,
      utcCutoffMs: utc,
      differsFromUtc: local !== null && local !== utc,
    };
  });
  controls.push({
    control: "account_local_cutoff_differs_from_utc",
    bindings: zoneRows,
    expectation: "every binding resolves a timezone and none of them is UTC",
    pass: zoneRows.every((r) => r.timeZone !== null && r.localCutoffMs !== null),
    nonVacuous: zoneRows.every((r) => r.differsFromUtc === true),
  });

  return controls;
}

// ---------------------------------------------------------------------------
// Pinned inputs and the D080B/D082 baselines
// ---------------------------------------------------------------------------

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
}

export function assertPinnedInputs(): Record<string, string> {
  const pins: Array<[string, string, string]> = [
    ["d080aArtifact", D083_PINNED_INPUTS.d080aArtifactPath, D083_PINNED_INPUTS.d080aArtifactSha256],
    ["d080bArtifact", D083_PINNED_INPUTS.d080bArtifactPath, D083_PINNED_INPUTS.d080bArtifactSha256],
    ["d081Artifact", D083_PINNED_INPUTS.d081ArtifactPath, D083_PINNED_INPUTS.d081ArtifactSha256],
    ["d082Artifact", D083_PINNED_INPUTS.d082ArtifactPath, D083_PINNED_INPUTS.d082ArtifactSha256],
  ];
  const observed: Record<string, string> = {};
  for (const [label, path, expected] of pins) {
    const actual = fileSha256(path);
    if (actual !== expected) {
      throw new Error(`D083 refuses to run: ${label} hash drift (expected ${expected}, observed ${actual})`);
    }
    observed[label] = actual;
  }
  const d082 = JSON.parse(readFileSync(resolve(D083_PINNED_INPUTS.d082ArtifactPath), "utf8")) as Row;
  if (d082.artifactHash !== D083_PINNED_INPUTS.d082InternalArtifactHash) {
    throw new Error("D083 refuses to run: D082 internal artifact hash drift");
  }
  observed.d082InternalArtifactHash = String(d082.artifactHash);
  return observed;
}

let D080B_ANALYSIS_CACHE: {
  proposals: BudgetResearchProposal[];
  origins: OriginPlan[];
  entityUniverse: Row[];
} | null = null;

export function loadD080BAnalysis(): {
  proposals: BudgetResearchProposal[];
  origins: OriginPlan[];
  entityUniverse: Row[];
} {
  if (D080B_ANALYSIS_CACHE) return D080B_ANALYSIS_CACHE;
  const artifact = JSON.parse(
    readFileSync(resolve(D083_PINNED_INPUTS.d080bArtifactPath), "utf8"),
  ) as Record<string, Row>;
  const snapshot = (artifact.snapshot ?? {}) as Row;
  const reads = (snapshot.reads ?? []) as D080BMaterialisedRead[];
  const analysis = analyseD080B({
    ...materialiseD080BSnapshot(reads),
    snapshotHash: String(snapshot.snapshotHash ?? ""),
  });
  D080B_ANALYSIS_CACHE = {
    proposals: analysis.proposals,
    origins: analysis.origins,
    entityUniverse: analysis.entityUniverse as Row[],
  };
  return D080B_ANALYSIS_CACHE;
}

/**
 * The campaign-origin scopes D082's conditional lane actually resolved. Role is
 * only ever treated as closed for these; assuming it closed everywhere would
 * claim more than D082 established.
 */
export function loadD082ResolvedRoleScopes(): Set<string> {
  const artifact = JSON.parse(
    readFileSync(resolve(D083_PINNED_INPUTS.d082ArtifactPath), "utf8"),
  ) as Record<string, Row>;
  const laneC = (artifact.laneC ?? {}) as Row;
  return new Set((laneC.resolvedScopeOriginKeys ?? []) as string[]);
}

export function loadD082Baseline(): Row {
  const artifact = JSON.parse(
    readFileSync(resolve(D083_PINNED_INPUTS.d082ArtifactPath), "utf8"),
  ) as Record<string, Row>;
  const impact = (artifact.proposalImpact ?? {}) as Row;
  const laneC = (artifact.laneC ?? {}) as Row;
  return {
    d082ArtifactHash: artifact.artifactHash,
    perLane: impact.perLane,
    funnel: impact.funnelAfterRoleOverlay,
    joinability: impact.joinability,
    laneCWouldSatisfyAuthority: laneC.wouldSatisfyAuthority,
    note: "Read from the pinned corrected D082 artifact. D083 never recomputes or rewrites it.",
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface D083Analysis {
  window: { from: string; to: string; origins: string[] };
  coverage: CoverageResult;
  lanes: LaneFacts[];
  proposalImpact: ProposalImpactResult;
  temporalControls: Row[];
  reconciliation: Row[];
  futureObservations: Row[];
}

export function analyse(reads: readonly D083MaterialisedRead[]): D083Analysis {
  const snapshot = materialiseSnapshot(reads);
  const d080b = loadD080BAnalysis();
  const origins = d080b.origins.map((o) => o.origin).sort();
  const window = {
    from: origins[0]!,
    to: origins[origins.length - 1]!,
    origins,
  };

  const coverage = computeCoverage(snapshot);
  const lanes = D083_LANES.map((lane) =>
    computeLaneFacts({ snapshot, entities: d080b.entityUniverse, origins, lane }),
  );

  const proposalImpact = computeProposalImpact({
    proposals: d080b.proposals,
    origins: d080b.origins,
    lanes,
    d082Baseline: loadD082Baseline(),
    roleResolvedScopes: loadD082ResolvedRoleScopes(),
  });

  return {
    window,
    coverage,
    lanes,
    proposalImpact,
    temporalControls: buildTemporalControls(snapshot, origins),
    reconciliation: buildReconciliation({ proposals: d080b.proposals, lanes, proposalImpact }),
    futureObservations: buildFutureObservations(coverage),
  };
}

export function buildReconciliation(input: {
  proposals: readonly BudgetResearchProposal[];
  lanes: readonly LaneFacts[];
  proposalImpact: ProposalImpactResult;
}): Row[] {
  const total = input.proposals.length;
  const out: Row[] = [];
  for (const lane of input.proposalImpact.perLane) {
    const owner = Number(lane.ownerResolvedProposals ?? 0);
    const intent = Number(lane.intentReadyProposals ?? 0);
    out.push({
      check: `${lane.lane}: owner-resolved never exceeds the proposal universe`,
      left: owner,
      right: total,
      balances: owner <= total,
    });
    out.push({
      check: `${lane.lane}: intent-ready is a subset of owner-resolved`,
      left: intent,
      right: owner,
      balances: intent <= owner,
    });
  }
  for (const j of input.proposalImpact.joinability) {
    const joinSum =
      Number(j.proposalsWithDeclaredCampaignIdentity ?? 0) +
      Number(j.parentRecoveredAtThatOrigin ?? 0) +
      Number(j.stillWithoutCampaignIdentity ?? 0);
    out.push({
      check: `${String(j.lane)}: joinability partitions the proposal universe`,
      left: joinSum,
      right: total,
      balances: joinSum === total,
    });
  }
  for (const [laneName, breakdown] of Object.entries(input.proposalImpact.breakdowns)) {
    const b = breakdown as Record<string, Record<string, number>>;
    const usable = Number(
      input.proposalImpact.perLane.find((l) => l.lane === laneName)?.ownerResolvedProposals ?? 0,
    );
    for (const axis of ["byBusiness", "byAccount", "bySelectedState", "byGrain", "byFold", "byOrigin"]) {
      const sum = Object.values(b[axis] ?? {}).reduce((a, c) => a + c, 0);
      out.push({
        check: `${laneName}.${axis} sums to the lane's owner-resolved count`,
        left: sum,
        right: usable,
        balances: sum === usable,
      });
    }
  }
  for (const lane of input.lanes) {
    const perOriginResolved = lane.byOrigin.reduce((a, r) => a + Number(r.resolved ?? 0), 0);
    out.push({
      check: `${lane.lane} per-origin resolved sums to the lane total`,
      left: perOriginResolved,
      right: lane.factsResolved,
      balances: perOriginResolved === lane.factsResolved,
    });
    const perBindingOwner = lane.perBinding.reduce((a, r) => a + Number(r.ownerResolved ?? 0), 0);
    out.push({
      check: `${lane.lane} per-binding owner-resolved sums to the lane total`,
      left: perBindingOwner,
      right: lane.ownerResolvedFacts,
      balances: perBindingOwner === lane.ownerResolvedFacts,
    });
  }
  // The strict lane can never exceed the finalized lane it is a subset of.
  const strict = input.lanes.find((l) => l.lane === "strict_pit_authority");
  const finalized = input.lanes.find((l) => l.lane === "retrospective_finalized_conditional");
  out.push({
    check: "the strict lane is a subset of the finalized lane",
    left: strict?.ownerResolvedFacts ?? 0,
    right: finalized?.ownerResolvedFacts ?? 0,
    balances: (strict?.ownerResolvedFacts ?? 0) <= (finalized?.ownerResolvedFacts ?? 0),
  });
  return out;
}

/** What retained history cannot close, and exactly what would close it. */
export function buildFutureObservations(coverage: CoverageResult): Row[] {
  return [
    {
      gap: "lifetime budget schedule",
      frozenDbTruth:
        "No retained row carries a start or end time: the schedule columns did not exist when every retained row was written.",
      localAuthoredState:
        "The Graph field lists now request start_time/stop_time and start_time/end_time, the mappers carry them, and the migration adds four schedule columns. None of this has been deployed or applied.",
      closedBy: "applying the migration and running an admitted sync",
      retainedHistoryCanClose: false,
      scheduleRetainedInFrozenSnapshot: coverage.scheduleRetained,
    },
    {
      gap: "currency exponent provenance at capture",
      frozenDbTruth:
        "No retained row carries a captured exponent or registry version, so every historical fact fails the captured-exponent gate.",
      localAuthoredState:
        "The sync stamps both from resolveMinorUnitExponent at capture time, and the canonical reader requires them rather than re-deriving from the current registry.",
      closedBy: "applying the migration and running an admitted sync",
      retainedHistoryCanClose: false,
      exponentRetainedInFrozenSnapshot: coverage.exponentRetained,
    },
    {
      gap: "provider API version",
      frozenDbTruth:
        "No retained row carries the Graph version it was fetched under; it reads back null for all of history.",
      localAuthoredState:
        "A provider_api_version column is added, the mapper stamps the client-known version, the writer and reader carry it, and it is bound into the state hash under meta-entity-state.v3.",
      closedBy: "applying the migration and running an admitted sync",
      retainedHistoryCanClose: false,
    },
    {
      gap: "owner provenance derivation",
      frozenDbTruth:
        "budget_origin was written by a producer that used JS truthiness, so a zero sentinel claimed ownership and both-missing became not_applicable.",
      localAuthoredState:
        "deriveMetaBudgetOrigin now distinguishes absent, zero and positive explicitly and can emit not_observed. Retained rows keep the old derivation; the canonical hierarchy join and the origin-versus-amount cross-check are what make them safe to read.",
      closedBy: "the canonical reader, for retained rows; the corrected producer, for future rows",
      retainedHistoryCanClose: true,
    },
    {
      gap: "budget shape",
      frozenDbTruth:
        "No Advantage+ or shared-budget indicator is requested or retained anywhere, so no fact can be intent-ready.",
      localAuthoredState:
        "shapeSupport is a first-class canonical input; unobserved and unsupported both refuse. Nothing in the authored code observes it yet.",
      closedBy: "requesting and persisting a provider budget-shape field",
      retainedHistoryCanClose: false,
    },
    {
      gap: "observation cadence",
      frozenDbTruth:
        "Complete-lane observation covers only part of the window and stopped when ingestion halted, so most entity-origin pairs have no observation.",
      localAuthoredState: "unchanged by this slice",
      closedBy: "resuming the admitted sync",
      retainedHistoryCanClose: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export function sealArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash"));
  return { ...body, artifactHash: sha256Canonical(body) };
}

export function analysisHashOf(analysis: D083Analysis): string {
  return sha256Canonical(analysis);
}

export function assembleArtifact(input: {
  collected: CollectedEvidence;
  analysis: D083Analysis;
  authority: Record<string, unknown>;
  pinnedInputHashes: Record<string, string>;
  snapshotHash: string;
}): Record<string, unknown> {
  const proof = input.collected.proof;
  return sealArtifact({
    contract: D083_CONTRACT_ID,
    truthLabels: [...D083_TRUTH_LABELS],
    laneVocabulary: [...D083_LANES],
    budgetFactContractVersion: BUDGET_FACT_CONTRACT_VERSION,
    budgetFactBlockers: [...BUDGET_FACT_BLOCKERS],
    currencyRegistryVersion: ISO_4217_REGISTRY_VERSION,
    documentation: META_DOC_REFERENCE,
    provenance: {
      retrievedAt: trimmedText(proof.retrieved_at),
      transactionIsolation: trimmedText(proof.transaction_isolation),
      transactionReadOnly: trimmedText(proof.transaction_read_only),
      statementTimeout: trimmedText(proof.statement_timeout),
      lockTimeout: trimmedText(proof.lock_timeout),
      snapshotHash: input.snapshotHash,
      analysisHash: analysisHashOf(input.analysis),
      queryContractSha256: D083_QUERY_CONTRACT_SHA256,
      pinnedInputHashes: input.pinnedInputHashes,
      executionAuthority: input.authority,
      readLedger: input.collected.ledger,
      readFailures: input.collected.ledger.filter((e) => e.status !== "ok"),
      note: "SELECT only, inside one REPEATABLE READ READ ONLY transaction with a savepoint per optional read. No write of any kind, no migration executed, no provider call, no entity names or PII.",
    },
    scope: {
      bindings: D080_PINNED_BINDINGS.map((b) => ({
        business: b.business,
        businessId: b.businessId,
        providerAccountId: b.providerAccountId,
        accountSelected: b.isSelected,
      })),
      table: STATE_HISTORY_TABLE,
    },
    window: input.analysis.window,
    snapshot: { snapshotHash: input.snapshotHash, reads: input.collected.reads },
    coverage: input.analysis.coverage,
    lanes: input.analysis.lanes,
    proposalImpact: input.analysis.proposalImpact,
    temporalControls: input.analysis.temporalControls,
    reconciliation: input.analysis.reconciliation,
    futureObservations: input.analysis.futureObservations,
    limits: {
      executable: false,
      providerMutation: null,
      migrationApplied: false,
      causalClaims: { roasLift: null, revenueLift: null, purchaseLift: null, profitLift: null, spendLift: null },
      note: "This package measures observation capability and proposal coverage only. No spend moved, no outcome occurred, and no causal effect is claimed.",
    },
  });
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Re-derives one control's verdict from the fields it published. Returns null
 * when the control carries nothing to recompute, which is itself a failure.
 */
export function recomputeTemporalControl(control: Row): boolean | null {
  const name = String(control.control ?? "");
  const num = (key: string): number | null => {
    const value = control[key];
    return typeof value === "number" ? value : null;
  };
  switch (name) {
    case "future_recorded_row_excluded_from_strict": {
      if (control.realCaseFound !== true) return control.nonVacuous === false;
      const cutoff = num("cutoffMs");
      const finalizedRecorded = num("finalizedRecordedAtMs");
      const strictRecorded = num("strictRecordedAtMs");
      if (cutoff === null || finalizedRecorded === null) return null;
      return (
        finalizedRecorded > cutoff &&
        (control.strictObservationId === null ||
          (strictRecorded !== null && strictRecorded <= cutoff)) &&
        control.strictObservationId !== control.finalizedObservationId
      );
    }
    case "early_origin_does_not_select_a_later_overwrite": {
      if (control.realCaseFound !== true) return control.nonVacuous === false;
      const cutoff = num("cutoffMs");
      const selected = num("selectedEffectiveAtMs");
      const newest = num("newestEffectiveAtMs");
      if (cutoff === null || selected === null || newest === null) return null;
      return (
        control.selectedObservationId !== control.newestObservationId &&
        selected < cutoff &&
        newest >= cutoff
      );
    }
    case "pre_window_predecessor_is_selected": {
      if (control.realCaseFound !== true) return control.nonVacuous === false;
      // Recomputed from the raw instants, not from an authored flag: the
      // selected observation must really be effective before the first origin.
      const effective = num("selectedEffectiveAtMs");
      const cutoff = num("firstOriginCutoffMs");
      return (
        effective !== null &&
        cutoff !== null &&
        effective < cutoff &&
        typeof control.selectedObservationId === "string" &&
        control.selectedObservationId.length > 0
      );
    }
    case "winners_selected_over_full_history": {
      const before = num("rowsBeforeFirstOrigin");
      if (before === null) return null;
      return control.lookbackHorizonDays === null && before >= 0;
    }
    case "invalid_as_of_date_is_refused": {
      const samples = control.samples;
      if (!Array.isArray(samples) || samples.length === 0) return null;
      return samples.every((sample) => {
        const row = sample as Row;
        const asOf = String(row.asOf ?? "");
        const cutoff = row.cutoffMs;
        const real = /^\d{4}-\d{2}-\d{2}$/.test(asOf) && isRealCalendarDate(asOf);
        return real ? typeof cutoff === "number" : cutoff === null;
      });
    }
    case "account_local_cutoff_differs_from_utc": {
      const bindings = control.bindings;
      if (!Array.isArray(bindings) || bindings.length === 0) return null;
      return bindings.every((row) => {
        const binding = row as Row;
        return typeof binding.timeZone === "string" && typeof binding.localCutoffMs === "number";
      });
    }
    default:
      return null;
  }
}

export interface VerifyResult {
  ok: boolean;
  failures: string[];
  checked: string[];
}

export function verifyArtifact(artifact: Record<string, unknown>): VerifyResult {
  const failures: string[] = [];
  const checked: string[] = [];
  const fail = (section: string, why: string) => failures.push(`${section}: ${why}`);

  if (artifact.contract !== D083_CONTRACT_ID) fail("contract", `expected ${D083_CONTRACT_ID}`);
  checked.push("contract");

  const provenance = (artifact.provenance ?? {}) as Record<string, unknown>;
  const snapshot = (artifact.snapshot ?? {}) as Record<string, unknown>;
  const reads = (snapshot.reads ?? []) as D083MaterialisedRead[];
  if (!Array.isArray(reads) || reads.length === 0) {
    fail("snapshot.reads", "no reads are carried, so nothing can be re-derived");
    return { ok: false, failures, checked };
  }

  const recomputed = sha256Canonical(snapshotBodyOf(reads));
  if (recomputed !== snapshot.snapshotHash) fail("snapshot.reads", "snapshot_hash_mismatch");
  if (recomputed !== provenance.snapshotHash) fail("provenance.snapshotHash", "snapshot_hash_mismatch");
  checked.push("snapshot.snapshotHash");

  if (provenance.transactionReadOnly !== "on") fail("provenance", "transaction was not READ ONLY");
  if (provenance.transactionIsolation !== "repeatable read") {
    fail("provenance", "transaction was not REPEATABLE READ");
  }
  checked.push("provenance.readOnlyProof");

  const pinned = (provenance.pinnedInputHashes ?? {}) as Record<string, string>;
  for (const [label, path, expected] of [
    ["d080aArtifact", D083_PINNED_INPUTS.d080aArtifactPath, D083_PINNED_INPUTS.d080aArtifactSha256],
    ["d080bArtifact", D083_PINNED_INPUTS.d080bArtifactPath, D083_PINNED_INPUTS.d080bArtifactSha256],
    ["d081Artifact", D083_PINNED_INPUTS.d081ArtifactPath, D083_PINNED_INPUTS.d081ArtifactSha256],
    ["d082Artifact", D083_PINNED_INPUTS.d082ArtifactPath, D083_PINNED_INPUTS.d082ArtifactSha256],
  ] as const) {
    if (pinned[label] !== expected) fail("provenance.pinnedInputHashes", `${label} not pinned`);
    let onDisk: string | null = null;
    try {
      onDisk = fileSha256(path);
    } catch {
      onDisk = null;
    }
    if (onDisk !== expected) fail("provenance.pinnedInputHashes", `${label} drifted on disk`);
  }
  if (pinned.d082InternalArtifactHash !== D083_PINNED_INPUTS.d082InternalArtifactHash) {
    fail("provenance.pinnedInputHashes", "D082 internal artifact hash not pinned");
  }
  checked.push("provenance.pinnedInputHashes");

  if (provenance.queryContractSha256 !== D083_QUERY_CONTRACT_SHA256) {
    fail("provenance.queryContractSha256", "query_contract_mismatch");
  }
  checked.push("provenance.queryContractSha256");

  const ledger = (provenance.readLedger ?? []) as D083LedgerEntry[];
  const byKey = new Map(reads.map((r) => [r.invocationKey, r]));
  const executed = ledger.filter((e) => e.disposition === "execute" && e.status === "ok");

  // A read may be a collapsed set: one statement executed once per origin, kept
  // once, deduplicated by observation identity. The ledger still records every
  // execution, so the two are reconciled by counting rather than by equality.
  const collapseOf = (key: string) => (key.includes("@") ? key.slice(0, key.indexOf("@")) : key);
  const executionsPerRead = new Map<string, number>();
  for (const entry of executed) {
    const key = collapseOf(entry.invocationKey);
    executionsPerRead.set(key, (executionsPerRead.get(key) ?? 0) + 1);
  }
  if (executionsPerRead.size !== reads.length) {
    fail("provenance.readLedger", "invocation_set_mismatch");
  }
  for (const read of reads) {
    const executions = executionsPerRead.get(read.invocationKey) ?? 0;
    const declared = read.executions ?? 1;
    if (executions !== declared) {
      fail("provenance.readLedger", `execution_count_mismatch on ${read.invocationKey}`);
    }
    if (declared > 1) {
      // A collapsed read must name exactly the origins it was executed at, and
      // its kept rows must be the deduplication of what those executions
      // returned — never fewer distinct identities than it kept.
      if ((read.executionKeys ?? []).length !== declared) {
        fail("provenance.readLedger", `execution_key_count_mismatch on ${read.invocationKey}`);
      }
      if (new Set(read.executionKeys ?? []).size !== declared) {
        // Two executions with identical parameters would mean an origin, grain
        // or lane was read twice and another not at all.
        fail("provenance.readLedger", `duplicate_execution_key on ${read.invocationKey}`);
      }
      const before = read.rowsBeforeDeduplication ?? 0;
      if (before < read.rows.length) {
        fail("provenance.readLedger", `deduplication_expanded_rows on ${read.invocationKey}`);
      }
      const identities = new Set(read.rows.map((r) => String(r.observation_id ?? "")));
      if (identities.size !== read.rows.length) {
        fail("provenance.readLedger", `duplicate_identity_kept on ${read.invocationKey}`);
      }
      const ledgerRows = executed
        .filter((e) => collapseOf(e.invocationKey) === read.invocationKey)
        .reduce((a, e) => a + (e.rows ?? 0), 0);
      if (ledgerRows !== before) {
        fail("provenance.readLedger", `prededuplication_count_mismatch on ${read.invocationKey}`);
      }
    }
  }
  // The exact set, rebuilt from the plan. Comparing counts alone lets a whole
  // binding be dropped consistently from both the ledger and the reads.
  const expectedKeys = expectedInvocationKeys();
  const observedKeys = [...byKey.keys()].sort();
  for (const key of expectedKeys) {
    if (!byKey.has(key)) fail("provenance.readLedger", `required read missing: ${key}`);
  }
  for (const key of observedKeys) {
    if (!expectedKeys.includes(key)) fail("provenance.readLedger", `unexpected read: ${key}`);
  }
  if (ledger.some((e) => e.status !== "ok")) {
    fail("provenance.readLedger", "a required read did not succeed");
  }
  for (const entry of executed) {
    const read = byKey.get(collapseOf(entry.invocationKey));
    if (!read) {
      fail("provenance.readLedger", `ledger row ${entry.invocationKey} has no kept read`);
      continue;
    }
    // A single-execution read is still checked row for row and hash for hash.
    // A collapsed one cannot be: its kept set is the union, so the per-execution
    // counts are reconciled above instead.
    if ((read.executions ?? 1) === 1) {
      if (entry.rows !== read.rows.length) {
        fail("provenance.readLedger", `slice_count_mismatch on ${entry.invocationKey}`);
      }
      if (entry.sourceRowHash !== sha256Canonical(read.rows)) {
        fail("provenance.readLedger", `slice_hash_mismatch on ${entry.invocationKey}`);
      }
    }
    if (!ALLOWED_STATEMENT_HASHES.has(entry.statementSha256 ?? "")) {
      fail("provenance.readLedger", `statement on ${entry.invocationKey} is not pinned`);
    }
  }
  checked.push("provenance.readLedger");

  for (const read of reads) {
    if (read.businessId && !PINNED_BUSINESS_SET.has(read.businessId)) {
      fail("snapshot.reads", `identity_not_pinned: ${read.invocationKey}`);
    }
    if (
      read.businessId &&
      read.providerAccountId &&
      !PINNED_BINDING_SET.has(bindingKey(read.businessId, read.providerAccountId))
    ) {
      fail("snapshot.reads", `identity_not_pinned: ${read.invocationKey}`);
    }
  }
  checked.push("snapshot.reads.identityPinning");

  // A structurally invalid artifact needs no re-derivation: the cheap checks
  // above have already refused it, and re-deriving a 247,050-proposal analysis
  // to say so again would only make the refusal slower.
  if (failures.length > 0) {
    return { ok: false, failures, checked: sortedUnique([...checked, "structural_checks_failed_first"]) };
  }

  let rebuilt: D083Analysis;
  try {
    rebuilt = analyse(reads);
  } catch (error) {
    fail("analysis", `re-derivation threw: ${(error as Error).message.split("\n")[0]}`);
    return { ok: false, failures, checked };
  }
  if (analysisHashOf(rebuilt) !== provenance.analysisHash) {
    fail("provenance.analysisHash", "analysis_hash_mismatch");
  }
  for (const section of [
    "window",
    "coverage",
    "lanes",
    "proposalImpact",
    "temporalControls",
    "reconciliation",
    "futureObservations",
  ] as const) {
    if (canonicalJson(artifact[section] ?? null) !== canonicalJson(rebuilt[section] ?? null)) {
      fail(section, "derived_output_mismatch");
    }
    checked.push(section);
  }

  for (const row of rebuilt.reconciliation) {
    if (row.balances !== true) fail("reconciliation", `does not balance: ${String(row.check)}`);
  }
  checked.push("reconciliation.balances");

  // The verifier recomputes each control's verdict from the raw fields the
  // control publishes. An authored `pass: true` proves nothing on its own.
  for (const control of rebuilt.temporalControls) {
    const name = String(control.control);
    const recomputed = recomputeTemporalControl(control);
    if (recomputed === null) {
      fail("temporalControls", `${name} publishes no recomputable evidence`);
      continue;
    }
    if (recomputed !== control.pass) {
      fail("temporalControls", `${name}: authored pass=${String(control.pass)} but the raw fields say ${String(recomputed)}`);
    }
    if (recomputed !== true) fail("temporalControls", `${name} did not hold`);
    if (control.nonVacuous !== true) {
      fail("temporalControls", `${name} is vacuous, so it proves nothing`);
    }
  }
  const realCaseControls = rebuilt.temporalControls.filter((c) => "realCaseFound" in c);
  if (realCaseControls.length > 0 && realCaseControls.every((c) => c.realCaseFound !== true)) {
    fail("temporalControls", "no real-data temporal control found a qualifying case");
  }
  checked.push("temporalControls");

  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash"));
  if (sha256Canonical(body) !== artifact.artifactHash) fail("artifactHash", "artifact_hash_mismatch");
  checked.push("artifactHash");

  return { ok: failures.length === 0, failures, checked: sortedUnique(checked) };
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

function snapshotFlags(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(D083_FORBIDDEN_TRUTHY_FLAGS.map((f) => [f, env[f]]));
}

function isTruthyFlagValue(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on", "enabled"].includes(value.trim().toLowerCase());
}

export function evaluateExecutionAuthority(
  before: Record<string, string | undefined>,
  after: Record<string, string | undefined>,
): Record<string, unknown> {
  const truthyBefore = D083_FORBIDDEN_TRUTHY_FLAGS.filter((f) => isTruthyFlagValue(before[f]));
  const truthyAfter = D083_FORBIDDEN_TRUTHY_FLAGS.filter((f) => isTruthyFlagValue(after[f]));
  return {
    ok: truthyBefore.length === 0 && truthyAfter.length === 0,
    truthyBefore,
    truthyAfter,
    changedByLoader: D083_FORBIDDEN_TRUTHY_FLAGS.filter(
      (f) => (before[f] ?? null) !== (after[f] ?? null),
    ).map((flag) => ({ flag, before: before[flag] ?? null, after: after[flag] ?? null })),
  };
}

export async function runExtract(): Promise<void> {
  const pinnedInputHashes = assertPinnedInputs();
  const before = snapshotFlags(process.env);
  const runtime = await import("@/scripts/_operational-runtime");
  runtime.configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const authority = evaluateExecutionAuthority(before, snapshotFlags(process.env));
  if (authority.ok !== true) {
    throw new Error(
      `D083 refuses to read: execution authority is present (${[
        ...(authority.truthyBefore as string[]),
        ...(authority.truthyAfter as string[]),
      ].join(", ")}).`,
    );
  }

  const db = await import("@/lib/db");
  const ledger: D083LedgerEntry[] = [];
  const reads: D083MaterialisedRead[] = [];
  const collapsed = new Map<string, { read: D083MaterialisedRead; seen: Set<string> }>();
  const d080b = loadD080BAnalysis();
  const origins = d080b.origins.map((o) => o.origin).sort();
  const window = { from: origins[0]!, to: origins[origins.length - 1]!, origins };

  const collected = await db.runDbTransaction(async () => {
    const sql = db.getDb();
    await sql.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await sql.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    await sql.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    const [proof] = await sql.query<Row>(
      `SELECT now()::text AS retrieved_at,
              current_setting('transaction_isolation') AS transaction_isolation,
              current_setting('transaction_read_only') AS transaction_read_only,
              current_setting('statement_timeout') AS statement_timeout,
              current_setting('lock_timeout') AS lock_timeout`,
    );
    if (trimmedText(proof?.transaction_read_only) !== "on") {
      throw new Error("D083 refuses to run outside a READ ONLY transaction");
    }
    if (trimmedText(proof?.transaction_isolation) !== "repeatable read") {
      throw new Error("D083 requires REPEATABLE READ isolation");
    }

    const entryOf = (r: D083Request, over: Partial<D083LedgerEntry>): D083LedgerEntry => ({
      invocationKey: r.invocationKey,
      planKey: r.planKey,
      businessId: r.businessId,
      providerAccountId: r.providerAccountId,
      source: r.source,
      lane: r.lane,
      statementSha256: r.statementSha256,
      paramsSha256: r.paramsSha256,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      disposition: "execute",
      status: "ok",
      rows: 0,
      sourceRowHash: null,
      reason: null,
      ...over,
    });

    const safeQ: SafeQ = async (request) => {
      assertRequestIsInScope(request);
      await sql.query("SAVEPOINT d083");
      try {
        const rows = await sql.query<Row>(request.statement, request.params);
        await sql.query("RELEASE SAVEPOINT d083");
        if (request.collapseKey) {
          // One execution per origin. The union is what the lanes select from;
          // storing it once, keyed by observation identity, is what keeps the
          // artifact bounded without dropping a single candidate.
          const bucket = collapsed.get(request.collapseKey) ?? {
            read: {
              invocationKey: request.collapseKey,
              planKey: request.planKey,
              businessId: request.businessId,
              providerAccountId: request.providerAccountId,
              source: request.source,
              lane: request.lane,
              effectiveFrom: request.effectiveFrom,
              effectiveTo: request.effectiveTo,
              rows: [] as Row[],
              executions: 0,
              executionKeys: [] as string[],
              rowsBeforeDeduplication: 0,
            } satisfies D083MaterialisedRead,
            seen: new Set<string>(),
          };
          bucket.read.executions = (bucket.read.executions ?? 0) + 1;
          bucket.read.executionKeys = [
            ...(bucket.read.executionKeys ?? []),
            [
              String(request.params[2] ?? ""),
              String(request.params[3] ?? ""),
              String(request.params[4] ?? ""),
            ].join("|"),
          ];
          bucket.read.rowsBeforeDeduplication =
            (bucket.read.rowsBeforeDeduplication ?? 0) + rows.length;
          for (const row of rows) {
            const id = String(row.observation_id ?? "");
            if (!id || bucket.seen.has(id)) continue;
            bucket.seen.add(id);
            bucket.read.rows.push(row);
          }
          collapsed.set(request.collapseKey, bucket);
        } else {
          reads.push({
            invocationKey: request.invocationKey,
            planKey: request.planKey,
            businessId: request.businessId,
            providerAccountId: request.providerAccountId,
            source: request.source,
            lane: request.lane,
            effectiveFrom: request.effectiveFrom,
            effectiveTo: request.effectiveTo,
            rows,
          });
        }
        ledger.push(entryOf(request, { rows: rows.length, sourceRowHash: sha256Canonical(rows) }));
        return rows;
      } catch (error) {
        await sql.query("ROLLBACK TO SAVEPOINT d083");
        ledger.push(
          entryOf(request, {
            status: "unknown/source_read_failed",
            rows: null,
            sourceRowHash: null,
            reason: (error as Error).message.split("\n")[0]!.slice(0, 160),
          }),
        );
        return [];
      }
    };

    const out = await collectEvidence({ proof, safeQ, window, ledger, reads });
    // Flush the collapsed candidate sets in a deterministic order, with their
    // rows sorted by identity, so two runs of the same evidence hash alike.
    for (const key of [...collapsed.keys()].sort()) {
      const bucket = collapsed.get(key)!;
      bucket.read.rows.sort((a, b) =>
        String(a.observation_id ?? "").localeCompare(String(b.observation_id ?? "")),
      );
      out.reads.push(bucket.read);
    }
    out.reads.sort((a, b) => a.invocationKey.localeCompare(b.invocationKey));
    return out;
  });

  const snapshotHash = sha256Canonical(snapshotBodyOf(collected.reads));
  const analysis = analyse(collected.reads);
  const artifact = assembleArtifact({
    collected,
    analysis,
    authority,
    pinnedInputHashes,
    snapshotHash,
  });
  // Compact, not pretty. The artifact is verified by re-derivation and by
  // hash, never read by eye, and indentation was a third of Correction 2's
  // 155 MB. Hardware safety is part of the contract.
  writeFileSync(resolve(D083_JSON_OUT), JSON.stringify(artifact));
  console.log(
    JSON.stringify(
      {
        phase: "extract",
        retrievedAt: (artifact.provenance as Row).retrievedAt,
        snapshotHash,
        analysisHash: (artifact.provenance as Row).analysisHash,
        artifactHash: artifact.artifactHash,
        ledgerRows: collected.ledger.length,
        readFailures: collected.ledger.filter((e) => e.status !== "ok").length,
        rowsKept: collected.reads.reduce((a, r) => a + r.rows.length, 0),
        strictOwnerResolved:
          analysis.lanes.find((l) => l.lane === "strict_pit_authority")?.ownerResolvedFacts ?? 0,
        finalizedOwnerResolved:
          analysis.lanes.find((l) => l.lane === "retrospective_finalized_conditional")?.ownerResolvedFacts ?? 0,
        intentReady:
          analysis.lanes.find((l) => l.lane === "retrospective_finalized_conditional")?.intentReadyFacts ?? 0,
        genuinelyAmbiguousRows: analysis.coverage.genuinelyAmbiguousRows,
      },
      null,
      1,
    ),
  );
}

export function replayFromArtifact(artifact: Record<string, unknown>): {
  analysisHash: string;
  snapshotHash: string;
} {
  const snapshot = (artifact.snapshot ?? {}) as Record<string, unknown>;
  const reads = (snapshot.reads ?? []) as D083MaterialisedRead[];
  return {
    analysisHash: analysisHashOf(analyse(reads)),
    snapshotHash: sha256Canonical(snapshotBodyOf(reads)),
  };
}

export function runReplay(path = D083_JSON_OUT): Record<string, string> {
  const artifact = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  const replayed = replayFromArtifact(artifact);
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => k !== "artifactHash"));
  const out = { ...replayed, artifactHash: sha256Canonical(body) };
  console.log(JSON.stringify({ phase: "d083-replay", ...out }, null, 1));
  return out;
}

export function runVerify(path = D083_JSON_OUT): VerifyResult {
  const artifact = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  const result = verifyArtifact(artifact);
  console.log(JSON.stringify({ phase: "d083-verify", ...result }, null, 1));
  return result;
}

const invoked = process.argv[1] ?? "";
if (invoked.includes("d083-meta-budget-fact-observation")) {
  const mode = process.argv[2] ?? "extract";
  if (mode === "extract") {
    runExtract().catch((error) => {
      console.error((error as Error).message);
      process.exitCode = 1;
    });
  } else if (mode === "replay") {
    runReplay();
  } else if (mode === "verify") {
    if (!runVerify().ok) process.exitCode = 1;
  } else {
    console.error(`unknown mode ${mode}`);
    process.exitCode = 2;
  }
}
