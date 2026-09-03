/**
 * D080B — six-business historical Meta budget-policy simulation.
 *
 * READ-ONLY research. This script never mutates a provider, a product surface,
 * a schema, or a shared database. It reads inside one server-asserted
 * `REPEATABLE READ READ ONLY` transaction and writes exactly one JSON artifact
 * under docs/audits/generated/.
 *
 * Two stages, deliberately separated so the analysis is testable without a
 * database:
 *
 *   extract — one bounded real snapshot with a complete request ledger, source
 *             row counts and hashes, and explicit dependency skips.
 *   replay  — pure offline analysis of that frozen snapshot. Replaying the same
 *             frozen input twice must produce byte-identical hashes.
 *
 * Three evidence lanes never share a denominator:
 *
 *   strict_pit_authority                — only facts knowable at each origin.
 *   retrospective_finalized_conditional — research-only sensitivity over
 *                                         finalized history, never action
 *                                         authority.
 *   synthetic_stress_only               — fixtures for cases the six-business
 *                                         history does not contain; excluded
 *                                         from every real-data headline.
 *
 * The creative-only runtime decision vocabulary is NOT reused or widened here.
 * D080B emits its own typed research proposal and never an executable action.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  D080_PINNED_BINDINGS,
  canonicalDigest,
  canonicalJson,
  sha256Canonical,
  type PinnedBinding,
} from "@/scripts/audits/d080-meta-budget-edit-evidence";

// ---------------------------------------------------------------------------
// Contract and configuration — config-as-data, no scattered thresholds
// ---------------------------------------------------------------------------

/**
 * v2 supersedes v1. v1's verifier recomputed self-authored section hashes and
 * re-derived only a handful of claims, so fifteen independently authored
 * single-field lies survived a fresh reseal. v2 makes the raw reads the ONE
 * authoritative source: every section, every headline and every receipt is
 * re-derived from `snapshot.reads` plus module constants, and the reads
 * themselves are bound to the ledger by recomputed count and hash.
 */
export const D080B_CONTRACT_ID = "adsecute.meta.d080b-budget-policy-simulation.v2" as const;
export const D080B_JSON_OUT =
  "docs/audits/generated/d080b-meta-budget-policy-simulation-2026-09-01.json";

/** The accepted D080A package this simulation is pinned to. */
export const D080B_PINNED_INPUTS = {
  d080aArtifactPath: "docs/audits/generated/d080-meta-budget-edit-evidence-2026-08-31.json",
  d080aArtifactSha256: "d4a1898aba14bcb2a37ae60a335f207eb668df13d37619bdffb44330da4d7a69",
  d080aInternalArtifactHash: "21e7ac328704eff5bc8db17bbaeabf3c275c0c8ccb23072a950257d039dbdd9f",
  d078BundlePath: "docs/audits/generated/d078-six-business-evidence-bundle-2026-08-30.json",
  d078BundleSha256: "9c0d83aa4541849b43096056b95f686c9673169c461d8ebb97ebb3dd86db7b47",
} as const;

/**
 * The candidate ladder. Symmetric and bounded; every rung is a hypothesis until
 * the measured results support it. No universal default is assumed anywhere in
 * this file.
 */
export const POLICY_LADDER_PERCENT = [5, 10, 15, 20, 25] as const;
export const POLICY_DIRECTIONS = ["increase", "decrease"] as const;
/** Horizons are only USED where the clocks actually support them. */
export const HORIZON_DAYS = [7, 14, 28, 56] as const;
/** Origins are sampled weekly; a denser cadence would re-measure the same state. */
export const ORIGIN_CADENCE_DAYS = 7;
/**
 * The simulation window, in days back from each binding's cutoff. It bounds
 * BOTH the extraction and the origin axis, so an origin can never fall outside
 * the history that was actually read. Sized at 16 weeks: two full 56-day
 * horizons, the longest the clocks support.
 */
export const SIMULATION_WINDOW_DAYS = 112;
/** Folds partition the origin axis; walk-forward, never overlapping. */
export const FOLD_COUNT = 4;

export const EVIDENCE_LANES = [
  "strict_pit_authority",
  "retrospective_finalized_conditional",
  "synthetic_stress_only",
] as const;
export type EvidenceLane = (typeof EVIDENCE_LANES)[number];

/** Evidence floors. Every one is a declared hypothesis, not a derived truth. */
export const EVIDENCE_FLOORS = {
  trailingWindowDays: 7,
  minSpendMinorUnits: 0,
  minConversionsForIncrease: 1,
  minSpendDaysForAnyAction: 3,
  cooldownDays: 7,
  oscillationLookbackDays: 28,
  staleObservationDays: 3,
  maxEntityChangesPerWindow: 1,
  maxBusinessChangesPerOrigin: 5,
  maxFleetChangesPerOrigin: 20,
  maxAccountExposureShare: 0.25,
} as const;

/**
 * Server-owned gates. Order is authoritative: scope and policy/delivery
 * blockers are evaluated before any performance consideration, per the
 * Decision Center invariant that policy and delivery blockers override
 * performance.
 */
export const D080B_GATE_CODES = [
  // scope and identity
  "scope_not_pinned",
  "account_not_selected",
  "entity_identity_unresolved",
  // ownership and money shape
  "owner_evidence_absent",
  "owner_mode_ambiguous",
  "budget_field_ambiguous",
  "budget_value_absent",
  "lifetime_schedule_unretained",
  "unit_exponent_unknown",
  // delivery and configuration
  "status_evidence_absent",
  "status_not_active",
  "parent_not_active",
  "objective_identity_unknown",
  // authority
  "role_authority_absent",
  "commercial_target_absent",
  "commercial_target_stale",
  "decision_vocabulary_absent",
  // evidence
  "spend_evidence_floor",
  "conversion_evidence_floor",
  "budget_not_binding",
  "observation_stale",
  // change safety
  "recent_change_cooldown",
  "conflicting_transition",
  "oscillation_risk",
  "entity_cap",
  "business_cap",
  "fleet_cap",
  "concentration_cap",
  // execution safety (simulated)
  "cas_drift",
  "ambiguous_provider_outcome",
  "idempotency_collision",
  "rollback_exposure_unbounded",
  "kill_switch_block",
] as const;
export type GateCode = (typeof D080B_GATE_CODES)[number];

/**
 * The three blockers the conditional lane waives, each with the assumption that
 * waiving it makes. These are SYSTEM-CAPABILITY gaps, not evidence gaps: no
 * amount of retained history closes them, so leaving them in place makes every
 * candidate equally ineligible and the ladder undiscriminating. Waiving them
 * buys comparability and costs authority, which is why lane 2 can never be
 * served as action authority.
 */
export const CONDITIONAL_WAIVERS: Array<{ code: GateCode; assumption: string }> = [
  { code: "decision_vocabulary_absent", assumption: "assumes a typed budget verb exists to record the intent; today none does at any grain" },
  { code: "role_authority_absent", assumption: "assumes automatic campaign role could carry account scope; today every in-window role row has a null provider account" },
  { code: "unit_exponent_unknown", assumption: "assumes a per-currency exponent source exists; today no column in the schema names one" },
];
export const CONDITIONAL_WAIVED_CODES: readonly GateCode[] = CONDITIONAL_WAIVERS.map((w) => w.code);

/**
 * The gate ladder grouped into stages, in the order authority is established.
 * The funnel reports how many candidates survive each cumulative stage, which
 * is how the report answers "which gates eliminate the most" without guessing.
 */
export const GATE_STAGES: Array<{ stage: string; codes: GateCode[] }> = [
  { stage: "1_scope", codes: ["scope_not_pinned", "account_not_selected", "entity_identity_unresolved"] },
  { stage: "2_money_shape", codes: ["owner_evidence_absent", "owner_mode_ambiguous", "budget_field_ambiguous", "budget_value_absent", "lifetime_schedule_unretained"] },
  { stage: "3_unit", codes: ["unit_exponent_unknown"] },
  { stage: "4_delivery", codes: ["status_evidence_absent", "status_not_active", "parent_not_active", "objective_identity_unknown"] },
  { stage: "5_authority", codes: ["role_authority_absent", "commercial_target_absent", "commercial_target_stale", "decision_vocabulary_absent"] },
  { stage: "6_evidence", codes: ["spend_evidence_floor", "conversion_evidence_floor", "budget_not_binding", "observation_stale"] },
  { stage: "7_change_safety", codes: ["recent_change_cooldown", "conflicting_transition", "oscillation_risk", "entity_cap", "business_cap", "fleet_cap", "concentration_cap"] },
  { stage: "8_execution_safety", codes: ["cas_drift", "ambiguous_provider_outcome", "idempotency_collision", "rollback_exposure_unbounded", "kill_switch_block"] },
];

/**
 * The fact was never retained, as opposed to a retained fact that fails a rule.
 * This is the ONE list `not_determinable` is decided from; an earlier duplicate
 * inside the proposal builder had drifted from it.
 */
export const ABSENCE_BLOCKERS: readonly GateCode[] = [
  "owner_evidence_absent", "status_evidence_absent", "budget_value_absent",
  "commercial_target_absent", "unit_exponent_unknown", "role_authority_absent",
  "objective_identity_unknown", "decision_vocabulary_absent", "lifetime_schedule_unretained",
];

/**
 * Absence plus the evidence-coverage gaps. A successful read that found no
 * spend is not an absent fact — it is a fact — but it is still a coverage gap
 * for the purpose of asking where the ladder could ever be compared.
 */
export const COVERAGE_BLOCKERS: readonly GateCode[] = [
  ...ABSENCE_BLOCKERS, "observation_stale", "spend_evidence_floor",
];


/**
 * The conditional lane, aggregated online.
 *
 * Correction 9: this lane used to be a second array of 247,050 rows, walked a
 * dozen times by `filter`, `map` and `tally`. Every one of those results is a
 * counter, a grouped counter, a sum or a small key set, so none of them needs
 * the rows to exist at once. State here is bounded by the number of distinct
 * groups — origins, businesses, accounts, gate stages, ladder rungs — not by
 * the number of proposals.
 *
 * The one deliberately larger structure is `entityOrigins`, a set of distinct
 * `origin|account|entity` keys, which the published measurement is a count of.
 * It is bounded by entities times origins, not by proposals.
 *
 * `buildFunnel`'s sequential filtering is reproduced exactly: a row survives
 * stage `i` when it carries no blocker from stages 1..i, so recording the first
 * stage that eliminates each row gives the identical survivor and eliminated
 * counts without keeping the rows.
 */
type GroupCounts = { eligible: number; blocked: number; not_determinable: number; total: number };

export function createConditionalAccumulator(origins: readonly OriginPlan[]) {
  const foldOf = new Map(origins.map((o) => [o.origin, o.fold ?? 0]));
  const group = () => new Map<string, GroupCounts>();
  const bump = (m: Map<string, GroupCounts>, key: string, eligibility: ConditionalRecord["eligibility"]) => {
    let cell = m.get(key);
    if (!cell) { cell = { eligible: 0, blocked: 0, not_determinable: 0, total: 0 }; m.set(key, cell); }
    cell[eligibility] += 1;
    cell.total += 1;
  };
  const sortedGroups = (m: Map<string, GroupCounts>) =>
    Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const countInto = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1);
  const sortedTally = (m: Map<string, number>) =>
    Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));

  const byPolicyDelta = group(); const byBusiness = group(); const byOwnerMode = group();
  const byGrain = group(); const byBudgetField = group(); const byFold = group();
  const blockerCensus = new Map<string, number>();
  const increaseCensus = new Map<string, number>();
  const decreaseCensus = new Map<string, number>();
  const worstCaseByOrigin = new Map<string, number>();
  const concentrationByAccount = new Map<string, number>();
  // `survivedThrough[i]` counts rows that cleared stages 1..i.
  const survivedThrough = new Array<number>(GATE_STAGES.length + 1).fill(0);
  const moneyAndDeliveryCodes = [...GATE_STAGES[1]!.codes, ...GATE_STAGES[3]!.codes] as readonly string[];
  const rungBlocked = new Map<string, number>();
  const cohortByPolicyDelta = group(); const cohortByOwnerMode = group(); const cohortByBusiness = group();
  const cohortRemaining = new Map<string, number>();
  const cohortEntityOrigins = new Set<string>();
  let denominator = 0; let eligible = 0; let grossRawExposure = 0;
  let increaseSurviving = 0; let decreaseSurviving = 0; let cohortSize = 0;

  return {
    accept(p: ConditionalRecord): void {
      denominator += 1;
      bump(byPolicyDelta, `${p.policyDirection}_${p.policyPercent}`, p.eligibility);
      bump(byBusiness, p.business, p.eligibility);
      bump(byOwnerMode, p.ownerMode ?? "unobserved", p.eligibility);
      bump(byGrain, p.entityGrain, p.eligibility);
      bump(byBudgetField, p.budgetField ?? "undecidable", p.eligibility);
      bump(byFold, `fold_${foldOf.get(p.originDate) ?? 0}`, p.eligibility);
      for (const b of p.blockers) {
        countInto(blockerCensus, b);
        if (p.policyDirection === "increase") countInto(increaseCensus, b);
        else if (p.policyDirection === "decrease") countInto(decreaseCensus, b);
      }
      if (p.eligibility === "eligible") {
        eligible += 1;
        grossRawExposure += Math.abs(p.rawDelta ?? 0);
        countInto(worstCaseByOrigin, p.originDate);
        countInto(concentrationByAccount, p.providerAccountId);
      }
      // The first stage that eliminates this row; `GATE_STAGES.length` means it
      // survived every stage.
      let firstFail = GATE_STAGES.length;
      for (let i = 0; i < GATE_STAGES.length; i += 1) {
        const codes = GATE_STAGES[i]!.codes as readonly string[];
        if (p.blockers.some((b) => codes.includes(b))) { firstFail = i; break; }
      }
      for (let i = 0; i <= firstFail; i += 1) survivedThrough[i] = (survivedThrough[i] ?? 0) + 1;
      if (!p.blockers.some((b) => moneyAndDeliveryCodes.includes(b))) {
        if (p.policyDirection === "increase") increaseSurviving += 1;
        else if (p.policyDirection === "decrease") decreaseSurviving += 1;
      }
      if (p.eligibility !== "eligible") {
        countInto(rungBlocked, `${p.policyDirection}|${p.policyPercent}`);
      }
      if (!p.blockers.some((b) => (COVERAGE_BLOCKERS as readonly string[]).includes(b))) {
        cohortSize += 1;
        cohortEntityOrigins.add(`${p.originDate}|${p.providerAccountId}|${p.entityId}`);
        bump(cohortByPolicyDelta, `${p.policyDirection}_${p.policyPercent}`, p.eligibility);
        bump(cohortByOwnerMode, p.ownerMode ?? "unobserved", p.eligibility);
        bump(cohortByBusiness, p.business, p.eligibility);
        for (const b of p.blockers) countInto(cohortRemaining, b);
      }
    },
    finish() {
      const funnel: Row[] = [
        { stage: "0_all_candidates", gates: [], survivors: denominator, eliminated: 0 },
      ];
      let previous = denominator;
      for (let i = 0; i < GATE_STAGES.length; i += 1) {
        const survivors = survivedThrough[i + 1] ?? 0;
        funnel.push({
          stage: GATE_STAGES[i]!.stage,
          gates: GATE_STAGES[i]!.codes,
          survivors,
          eliminated: previous - survivors,
        });
        previous = survivors;
      }
      const perRung = POLICY_LADDER_PERCENT.map((pct) => ({
        percent: pct,
        increaseBlocked: rungBlocked.get(`increase|${pct}`) ?? 0,
        decreaseBlocked: rungBlocked.get(`decrease|${pct}`) ?? 0,
      }));
      const distinct = new Set(perRung.map((r) => `${r.increaseBlocked}|${r.decreaseBlocked}`)).size;
      return {
        denominator, eligible, grossRawExposure,
        byPolicyDelta: sortedGroups(byPolicyDelta),
        byBusiness: sortedGroups(byBusiness),
        byOwnerMode: sortedGroups(byOwnerMode),
        byGrain: sortedGroups(byGrain),
        byBudgetField: sortedGroups(byBudgetField),
        byFold: sortedGroups(byFold),
        blockerCensus: sortedTally(blockerCensus),
        // `[...new Set(...)].sort()` in the array form: default UTF-16 order,
        // not `localeCompare`. Reproduced exactly.
        worstCaseSimultaneousByOrigin: Object.fromEntries(
          [...worstCaseByOrigin.keys()].sort().map((o) => [o, worstCaseByOrigin.get(o) ?? 0]),
        ),
        concentrationByAccount: sortedTally(concentrationByAccount),
        funnel,
        increaseCensus: sortedTally(increaseCensus),
        decreaseCensus: sortedTally(decreaseCensus),
        increaseSurviving, decreaseSurviving,
        perRung, rungsAreDistinguishable: distinct > 1,
        cohort: {
          size: cohortSize,
          entityOrigins: cohortEntityOrigins.size,
          byPolicyDelta: sortedGroups(cohortByPolicyDelta),
          byOwnerMode: sortedGroups(cohortByOwnerMode),
          byBusiness: sortedGroups(cohortByBusiness),
          remainingBlockers: sortedTally(cohortRemaining),
        },
      };
    },
  };
}

/** Exactly the fields the conditional-lane aggregates read. */
export interface ConditionalRecord {
  business: string;
  providerAccountId: string;
  entityGrain: string;
  entityId: string;
  originDate: string;
  policyDirection: string;
  policyPercent: number;
  ownerMode: string | null;
  budgetField: string | null;
  evidenceLane: string;
  eligibility: BudgetResearchProposal["eligibility"];
  blockers: BudgetResearchProposal["blockers"];
  rawDelta: number | null;
}

export function buildFunnel(rows: readonly { blockers: readonly string[] }[]): Row[] {
  let survivors = rows;
  const out: Row[] = [{ stage: "0_all_candidates", gates: [], survivors: survivors.length, eliminated: 0 }];
  for (const { stage, codes } of GATE_STAGES) {
    const before = survivors.length;
    survivors = survivors.filter(
      (p) => !p.blockers.some((b) => (codes as readonly string[]).includes(b)),
    );
    out.push({ stage, gates: codes, survivors: survivors.length, eliminated: before - survivors.length });
  }
  return out;
}

export const STATEMENT_TIMEOUT_MS = 30_000;
export const LOCK_TIMEOUT_MS = 5_000;

/**
 * Flags that must be unset. This script refuses to read at all if any is truthy
 * before OR after configuration loading, and never overwrites one to pass.
 */
export const D080B_FORBIDDEN_TRUTHY_FLAGS = [
  "ENABLE_RUNTIME_MIGRATIONS",
  "ENABLE_META_WRITES",
  "ENABLE_AUTOMATION",
  "META_AUTOMATION_ENABLED",
  "ENABLE_PROVIDER_WRITES",
  "ALLOW_LIVE_MUTATION",
] as const;

type Row = Record<string, unknown>;

export function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  return String(value);
}

export function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The blocker census, counted in place.
 *
 * `tally(proposals.flatMap((p) => p.blockers))` flattened every blocker of
 * 247,050 proposals into one array before counting a single one, and the
 * filtered censuses built a filtered copy first as well. The output is
 * identical, including key order; only the intermediate arrays are gone.
 */
export function tallyBlockers<T extends { blockers: readonly string[] }>(
  proposals: readonly T[],
  include?: (p: T) => boolean,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of proposals) {
    if (include && !include(p)) continue;
    for (const b of p.blockers) out[b] = (out[b] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function bindingKey(businessId: string, providerAccountId: string): string {
  return `${businessId}|${providerAccountId}`;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// Query contract — every statement this audit may execute
// ---------------------------------------------------------------------------

/** Columns each source must expose before any dependent read is attempted. */
export const D080B_REQUIRED_COLUMNS: Record<string, string[]> = {
  meta_campaign_config_history: [
    "business_id", "provider_account_id", "campaign_id", "config_fingerprint",
    "objective", "optimization_goal", "bid_strategy_type", "daily_budget",
    "lifetime_budget", "is_budget_mixed", "captured_at", "effective_from", "created_at", "id",
  ],
  meta_adset_config_history: [
    "business_id", "provider_account_id", "campaign_id", "adset_id", "config_fingerprint",
    "optimization_goal", "bid_strategy_type", "daily_budget", "lifetime_budget",
    "is_budget_mixed", "captured_at", "effective_from", "created_at", "id",
  ],
  meta_campaign_daily: [
    "business_id", "provider_account_id", "date", "campaign_id", "campaign_status",
    "account_currency", "spend", "conversions", "revenue", "truth_state", "finalized_at",
  ],
  meta_adset_daily: [
    "business_id", "provider_account_id", "date", "campaign_id", "adset_id", "adset_status",
    "account_currency", "spend", "conversions", "revenue", "truth_state", "finalized_at",
  ],
  meta_entity_state_history: [
    "business_id", "provider_account_id", "entity_type", "entity_id", "campaign_id",
    "configured_status", "effective_status", "budget_origin", "budget_currency",
    "campaign_daily_budget_raw", "campaign_lifetime_budget_raw",
    "adset_daily_budget_raw", "adset_lifetime_budget_raw", "presence", "observed_at", "captured_at",
  ],
  business_provider_accounts: ["business_id", "provider_account_id", "is_selected"],
  business_target_pack_history: ["business_id", "target_roas", "break_even_roas", "effective_at", "recorded_at"],
  engine_v3_campaign_context_daily: [
    "business_id", "provider_account_id", "campaign_id", "as_of_date",
    "inferred_kind", "confidence_class",
  ],
  engine_v3_ad_decision_snapshots_daily: [
    "business_id", "provider_account_id", "decision_entity_type", "as_of_date",
    "label", "authorized_action",
  ],
};

/**
 * A currency exponent must come from a retained source, never from a constant.
 * This statement looks for ANY column in the schema that could carry one. It is
 * expected to return nothing, which is what makes `unit_exponent_unknown` an
 * evidenced blocker rather than an assumption.
 */
export const D080B_QUERIES = {
  columnContract: `
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name, column_name`,

  currencyExponentSource: `
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (column_name ILIKE '%currency_exponent%'
            OR column_name ILIKE '%minor_unit%'
            OR column_name ILIKE '%currency_scale%'
            OR column_name ILIKE '%currency_decimal%')
     ORDER BY table_name, column_name`,

  bindings: `
    SELECT business_id, provider_account_id, is_selected
      FROM business_provider_accounts
     WHERE business_id = ANY($1::text[]) AND provider = 'meta'
     ORDER BY business_id, provider_account_id`,

  sourceClock: `
    SELECT min(EFFECTIVE_COL)::text AS earliest_effective,
           max(EFFECTIVE_COL)::text AS latest_effective,
           count(*)::bigint AS rows
      FROM SOURCE_TABLE
     WHERE business_id = $1::text AND provider_account_id = $2::text`,

  accountCurrency: `
    SELECT account_currency, count(*)::bigint AS rows,
           min(date)::text AS first_date, max(date)::text AS last_date
      FROM meta_campaign_daily
     WHERE business_id = $1::text AND provider_account_id = $2::text
       AND date >= $3::date AND date <= $4::date
     GROUP BY account_currency
     ORDER BY account_currency`,

  /**
   * The deduplicated retained budget-configuration sequence. One row per
   * (entity, effective_from): the latest capture for that effective day, plus
   * how many captures disagreed. Knowledge bound $5 keeps a point-in-time read
   * honest; NULL admits later captures and is therefore retrospective.
   */
  configStates: `
    WITH captures AS (
      SELECT ENTITY_COL AS entity_id, effective_from, captured_at, created_at, id::text AS id,
             config_fingerprint, daily_budget, lifetime_budget,
             optimization_goal, bid_strategy_type, OBJECTIVE_EXPR AS objective,
             COALESCE(is_budget_mixed, FALSE) AS is_budget_mixed
        FROM SOURCE_TABLE
       WHERE business_id = $1::text AND provider_account_id = $2::text
         AND effective_from >= $3::date AND effective_from <= $4::date
         AND ($5::date IS NULL OR captured_at < ($5::date + 1))
    ), agg AS (
      SELECT entity_id, effective_from,
             count(*)::bigint AS raw_captures,
             count(DISTINCT config_fingerprint)::bigint AS distinct_fingerprints,
             bool_or(is_budget_mixed) AS any_mixed
        FROM captures GROUP BY 1, 2
    ), pick AS (
      SELECT DISTINCT ON (entity_id, effective_from)
             entity_id, effective_from, captured_at, created_at, id, config_fingerprint,
             daily_budget, lifetime_budget, optimization_goal, bid_strategy_type, objective
        FROM captures
       ORDER BY entity_id, effective_from, captured_at DESC, created_at DESC, id DESC
    )
    SELECT p.entity_id, p.effective_from::text AS effective_from,
           p.captured_at::text AS captured_at, p.config_fingerprint,
           p.daily_budget, p.lifetime_budget, p.optimization_goal,
           p.bid_strategy_type, p.objective,
           a.raw_captures, a.distinct_fingerprints, a.any_mixed
      FROM pick p JOIN agg a ON a.entity_id = p.entity_id AND a.effective_from = p.effective_from
     ORDER BY p.entity_id, p.effective_from`,

  /**
   * Owner, mode and delivery state per entity per observed day. `budget_origin`
   * is the only retained statement of which node owns the money.
   */
  ownerStates: `
    SELECT DISTINCT ON (entity_type, entity_id, observed_at::date)
           entity_type, entity_id, campaign_id,
           observed_at::date::text AS observed_on,
           captured_at::text AS captured_at,
           configured_status, effective_status, presence,
           budget_origin, budget_currency,
           campaign_daily_budget_raw, campaign_lifetime_budget_raw,
           adset_daily_budget_raw, adset_lifetime_budget_raw
      FROM meta_entity_state_history
     WHERE business_id = $1::text AND provider_account_id = $2::text
       AND entity_type IN ('campaign', 'adset')
       AND observed_at >= $3::date AND observed_at < ($4::date + 1)
     ORDER BY entity_type, entity_id, observed_at::date, observed_at DESC, captured_at DESC`,

  /** Finalized daily performance. Only spend-bearing days are retained here. */
  performanceDaily: `
    SELECT ENTITY_COL AS entity_id, date::text AS date, STATUS_COL AS entity_status,
           account_currency, spend, conversions, revenue, truth_state,
           (finalized_at IS NOT NULL) AS finalized
      FROM SOURCE_TABLE
     WHERE business_id = $1::text AND provider_account_id = $2::text
       AND date >= $3::date AND date <= $4::date AND spend > 0
     ORDER BY ENTITY_COL, date`,

  /** Automatic campaign-role inference. Never a manual Test/Main/Mixed label. */
  roleContext: `
    SELECT campaign_id, as_of_date::text AS as_of_date, inferred_kind, confidence_class,
           provider_account_id
      FROM engine_v3_campaign_context_daily
     WHERE business_id = $1::text
       AND as_of_date >= $2::date AND as_of_date <= $3::date
     ORDER BY campaign_id, as_of_date`,

  /** Commercial anchors with both an effective and a recorded clock. */
  targetPacks: `
    SELECT business_id::text AS business_id, target_roas, break_even_roas,
           effective_at::text AS effective_at, recorded_at::text AS recorded_at
      FROM business_target_pack_history
     WHERE business_id::text = ANY($1::text[])
     ORDER BY business_id, effective_at`,

  /** Whether any typed budget verb exists in the decision system at all. */
  budgetVerbCensus: `
    SELECT count(*)::bigint AS total_rows,
           count(*) FILTER (WHERE decision_entity_type <> 'ad')::bigint AS non_ad_rows,
           count(*) FILTER (WHERE label ILIKE '%budget%'
                              OR authorized_action ILIKE '%budget%')::bigint AS budget_verb_rows
      FROM engine_v3_ad_decision_snapshots_daily
     WHERE business_id = $1::text AND provider_account_id = $2::text
       AND as_of_date >= $3::date AND as_of_date <= $4::date`,
} as const;

/** Which clock each source contributes, and which column carries it. */
export const D080B_CLOCK_SOURCES = [
  { key: "meta_campaign_daily", column: "date", grain: "campaign" },
  { key: "meta_adset_daily", column: "date", grain: "adset" },
  { key: "meta_campaign_config_history", column: "effective_from", grain: "campaign" },
  { key: "meta_adset_config_history", column: "effective_from", grain: "adset" },
  { key: "meta_entity_state_history", column: "observed_at", grain: null },
] as const;

export function shapeConfigStates(grain: "campaign" | "adset", knowledgeBounded: boolean): string {
  const table = grain === "campaign" ? "meta_campaign_config_history" : "meta_adset_config_history";
  const entity = grain === "campaign" ? "campaign_id" : "adset_id";
  // The ad-set table has no objective column; the campaign one does. Naming the
  // difference explicitly beats silently selecting NULL from both.
  const objective = grain === "campaign" ? "objective" : "NULL::text";
  return D080B_QUERIES.configStates
    .replace(/SOURCE_TABLE/g, table)
    .replace(/ENTITY_COL/g, entity)
    .replace(/OBJECTIVE_EXPR/g, objective)
    .concat(knowledgeBounded ? "\n    -- knowledge-bounded (point in time)" : "\n    -- unbounded knowledge (retrospective)");
}

export function shapePerformance(grain: "campaign" | "adset"): string {
  const table = grain === "campaign" ? "meta_campaign_daily" : "meta_adset_daily";
  const entity = grain === "campaign" ? "campaign_id" : "adset_id";
  const status = grain === "campaign" ? "campaign_status" : "adset_status";
  return D080B_QUERIES.performanceDaily
    .replace(/SOURCE_TABLE/g, table)
    .replace(/ENTITY_COL/g, entity)
    .replace(/STATUS_COL/g, status);
}

export function shapeClock(source: string, column: string): string {
  return D080B_QUERIES.sourceClock
    .replace(/SOURCE_TABLE/g, source)
    .replace(/EFFECTIVE_COL/g, column);
}

// ---------------------------------------------------------------------------
// Request envelope and read ledger
// ---------------------------------------------------------------------------

export interface D080BRequest {
  invocationKey: string;
  planKey: string;
  statement: string;
  params: unknown[];
  statementSha256: string;
  paramsSha256: string;
  businessId: string | null;
  providerAccountId: string | null;
  grain: "campaign" | "adset" | null;
  source: string;
  lane: EvidenceLane;
  knowledgeTo: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface D080BLedgerEntry {
  invocationKey: string;
  planKey: string;
  businessId: string | null;
  providerAccountId: string | null;
  grain: "campaign" | "adset" | null;
  source: string;
  lane: EvidenceLane;
  statementSha256: string | null;
  paramsSha256: string | null;
  knowledgeTo: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  disposition: "execute" | "dependency_skip";
  status: "ok" | "unknown/source_read_failed" | "not_run_dependency_failed";
  rows: number | null;
  sourceRowHash: string | null;
  dependencyCode: string | null;
  reason: string | null;
}

function normaliseParams(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

export function buildRequest(input: {
  planKey: string;
  statement: string;
  params: unknown[];
  source: string;
  lane: EvidenceLane;
  businessId?: string | null;
  providerAccountId?: string | null;
  grain?: "campaign" | "adset" | null;
  knowledgeTo?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}): D080BRequest {
  const params = normaliseParams(input.params);
  const scope = input.providerAccountId
    ? `${input.businessId}|${input.providerAccountId}`
    : input.businessId ?? "global";
  // The source belongs in the key: `sourceClock` addresses five different
  // sources, so a plan-plus-scope key collided across them and two distinct
  // reads shared one identity.
  const key = input.grain
    ? `${input.planKey}:${input.source}#${scope}|${input.grain}`
    : `${input.planKey}:${input.source}#${scope}`;
  return {
    invocationKey: key,
    planKey: input.planKey,
    statement: input.statement,
    params,
    statementSha256: createHash("sha256").update(input.statement).digest("hex"),
    paramsSha256: sha256Canonical(params),
    businessId: input.businessId ?? null,
    providerAccountId: input.providerAccountId ?? null,
    grain: input.grain ?? null,
    source: input.source,
    lane: input.lane,
    knowledgeTo: input.knowledgeTo ?? null,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: input.effectiveTo ?? null,
  };
}

const PINNED_BUSINESS_SET = new Set(D080_PINNED_BINDINGS.map((b) => b.businessId));
const PINNED_BINDING_SET = new Set(
  D080_PINNED_BINDINGS.map((b) => `${b.businessId}|${b.providerAccountId}`),
);

/**
 * The guard every request passes immediately before execution. A request may
 * only address a pinned identity, may not carry a backwards window, and may not
 * claim a knowledge bound that is not a real date.
 */
export function assertRequestIsInScope(request: D080BRequest): void {
  const refuse = (why: string): never => {
    throw new Error(`D080B refuses to execute ${request.invocationKey}: ${why}`);
  };
  if (createHash("sha256").update(request.statement).digest("hex") !== request.statementSha256) {
    refuse("statement does not match its declared hash");
  }
  if (sha256Canonical(request.params) !== request.paramsSha256) {
    refuse("params do not match their declared hash");
  }
  if (request.businessId !== null && !PINNED_BUSINESS_SET.has(request.businessId)) {
    refuse(`businessId ${JSON.stringify(request.businessId)} is not a charter business`);
  }
  if (request.providerAccountId !== null) {
    if (request.businessId === null) refuse("a provider account without a business");
    if (!PINNED_BINDING_SET.has(`${request.businessId}|${request.providerAccountId}`)) {
      refuse(`${request.businessId}|${request.providerAccountId} is not a pinned binding`);
    }
  }
  for (const field of ["knowledgeTo", "effectiveFrom", "effectiveTo"] as const) {
    const value = request[field];
    if (value !== null && !isCalendarDate(value)) {
      refuse(`${field} ${JSON.stringify(value)} is not a real calendar date`);
    }
  }
  if (
    request.effectiveFrom !== null && request.effectiveTo !== null &&
    request.effectiveFrom > request.effectiveTo
  ) {
    refuse(`effective window runs backwards: ${request.effectiveFrom} > ${request.effectiveTo}`);
  }
  if (!EVIDENCE_LANES.includes(request.lane)) refuse(`unknown evidence lane ${request.lane}`);
  if (request.lane === "synthetic_stress_only") {
    refuse("the synthetic lane never reads the database");
  }
}

export type SafeQ = (request: D080BRequest) => Promise<Row[]>;

interface ExecutionAuthorityVerdict {
  ok: boolean;
  truthyBefore: string[];
  truthyAfter: string[];
  changedByLoader: Array<{ flag: string; before: string | null; after: string | null }>;
}

function isTruthyFlagValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function snapshotFlags(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(D080B_FORBIDDEN_TRUTHY_FLAGS.map((f) => [f, env[f]]));
}

export function evaluateExecutionAuthority(
  before: Record<string, string | undefined>,
  after: Record<string, string | undefined>,
): ExecutionAuthorityVerdict {
  const truthyBefore = D080B_FORBIDDEN_TRUTHY_FLAGS.filter((f) => isTruthyFlagValue(before[f]));
  const truthyAfter = D080B_FORBIDDEN_TRUTHY_FLAGS.filter((f) => isTruthyFlagValue(after[f]));
  return {
    ok: truthyBefore.length === 0 && truthyAfter.length === 0,
    truthyBefore,
    truthyAfter,
    changedByLoader: D080B_FORBIDDEN_TRUTHY_FLAGS
      .filter((f) => (before[f] ?? null) !== (after[f] ?? null))
      .map((flag) => ({ flag, before: before[flag] ?? null, after: after[flag] ?? null })),
  };
}

// ---------------------------------------------------------------------------
// The typed research proposal — D080B's own vocabulary, not the creative one
// ---------------------------------------------------------------------------

export type BudgetOwner = "campaign" | "adset";
export type BudgetField = "daily_budget" | "lifetime_budget";
export type PolicyDirection = (typeof POLICY_DIRECTIONS)[number];

/**
 * A research proposal. It deliberately carries NO executable action, no
 * approval hash and no idempotency key: this audit may not create anything a
 * dispatcher could consume. `evidenceLane` travels with every row so a
 * conditional result can never be counted as authority.
 */
export interface BudgetResearchProposal {
  snapshotHash: string;
  originDate: string;
  businessId: string;
  business: string;
  providerAccountId: string;
  accountSelected: boolean;
  entityGrain: BudgetOwner;
  entityId: string;
  campaignId: string | null;
  budgetOwner: BudgetOwner | null;
  budgetField: BudgetField | null;
  ownerMode: string | null;
  automaticRole: string | null;
  automaticRoleAuthority: "account_scoped" | "absent";
  currency: string | null;
  unitExponentConfidence: "authoritative" | "unknown";
  currentRawAmount: number | null;
  proposedRawAmount: number | null;
  rawDelta: number | null;
  policyDirection: PolicyDirection;
  policyPercent: number;
  action: "propose_budget_change" | "no_proposal";
  eligibility: "eligible" | "blocked" | "not_determinable";
  blockers: GateCode[];
  reasons: string[];
  evidenceLane: EvidenceLane;
}

/** Everything the engine may look at for one entity at one origin. */
export interface PolicyInput {
  origin: string;
  binding: PinnedBinding;
  entityGrain: BudgetOwner;
  entityId: string;
  campaignId: string | null;
  /** Latest config state at or before the origin, knowledge-bounded. */
  configAsOfOrigin: {
    effectiveFrom: string;
    dailyBudget: number | null;
    lifetimeBudget: number | null;
    anyMixed: boolean;
    distinctFingerprints: number;
    optimizationGoal: string | null;
    bidStrategy: string | null;
    objective: string | null;
  } | null;
  /** Latest owner/delivery observation at or before the origin. */
  ownerAsOfOrigin: {
    observedOn: string;
    budgetOrigin: string | null;
    budgetCurrency: string | null;
    configuredStatus: string | null;
    effectiveStatus: string | null;
    presence: string | null;
  } | null;
  /** Parent campaign observation, for the ad-set parent gate. */
  parentAsOfOrigin: { configuredStatus: string | null; effectiveStatus: string | null } | null;
  /** Trailing performance strictly before the origin. */
  trailing: { days: number; spend: number; conversions: number; revenue: number; spendDays: number };
  /** Automatic role, and whether it carried account scope. */
  role: { inferredKind: string | null; confidenceClass: string | null; accountScoped: boolean } | null;
  /** Commercial anchor knowable at the origin. */
  anchor: { targetRoas: number | null; breakEvenRoas: number | null; effectiveAt: string; ageDays: number } | null;
  /** Retained exponent evidence for this currency. Empty means unknown. */
  currencyExponentSources: number;
  /** Recent retained budget changes for this entity, strictly before the origin. */
  recentChanges: Array<{ effectiveFrom: string; direction: PolicyDirection | "unresolved" }>;
  /** Whether a typed budget verb exists anywhere in the decision system. */
  budgetVerbRows: number;
  /** Simulated execution-safety conditions for stress rows. */
  stress?: Partial<Record<"casDrift" | "ambiguousOutcome" | "idempotencyCollision" | "killSwitch" | "rollbackUnbounded", boolean>>;
  /** Counters the caller advances across the origin, for cap gates. */
  caps: { businessProposals: number; fleetProposals: number; accountExposureShare: number };
  lane: EvidenceLane;
}

const RAW_SENTINEL_ZERO = "0";

/** `"0"` in the state-history raws is a not-set sentinel, not a real budget. */
export function rawBudgetValue(raw: unknown): number | null {
  const t = text(raw);
  if (t === null || t === RAW_SENTINEL_ZERO) return null;
  const n = num(t);
  return n !== null && n > 0 ? n : null;
}

/**
 * The gate ladder. Pure, ordered, and total: it returns every blocker it finds
 * rather than the first, so the report can rank which gates carry the load.
 *
 * Order follows the Decision Center invariant that policy and delivery blockers
 * override performance: scope, ownership and delivery are evaluated before any
 * evidence floor.
 */
export function evaluateGates(input: PolicyInput, percent: number, direction: PolicyDirection): {
  blockers: GateCode[];
  reasons: string[];
  owner: BudgetOwner | null;
  field: BudgetField | null;
  currentRaw: number | null;
  proposedRaw: number | null;
  currency: string | null;
} {
  const blockers: GateCode[] = [];
  const reasons: string[] = [];
  const block = (code: GateCode, why: string) => { blockers.push(code); reasons.push(why); };

  // --- scope and identity -------------------------------------------------
  const key = `${input.binding.businessId}|${input.binding.providerAccountId}`;
  if (!PINNED_BINDING_SET.has(key)) block("scope_not_pinned", "identity is outside the charter matrix");
  if (!input.binding.isSelected) {
    block("account_not_selected", "assigned but deselected account is reference-only, never action scope");
  }
  if (!input.entityId) block("entity_identity_unresolved", "no entity identity at this origin");

  // --- ownership and the shape of the money -------------------------------
  const owner: BudgetOwner | null =
    input.ownerAsOfOrigin?.budgetOrigin === "campaign" ? "campaign"
      : input.ownerAsOfOrigin?.budgetOrigin === "adset" ? "adset"
      : null;
  if (input.ownerAsOfOrigin === null) {
    block("owner_evidence_absent", "no retained owner observation at or before this origin");
  } else if (owner === null) {
    block("owner_mode_ambiguous", `budget_origin ${JSON.stringify(input.ownerAsOfOrigin.budgetOrigin)} does not name an owning node`);
  } else if (owner !== input.entityGrain) {
    block("owner_mode_ambiguous", `the money is owned at ${owner} grain, not at ${input.entityGrain}`);
  }

  const cfg = input.configAsOfOrigin;
  const daily = cfg?.dailyBudget ?? null;
  const lifetime = cfg?.lifetimeBudget ?? null;
  let field: BudgetField | null = null;
  if (cfg === null) {
    block("budget_value_absent", "no retained configuration state at or before this origin");
  } else if (daily !== null && lifetime !== null) {
    block("budget_field_ambiguous", "both daily_budget and lifetime_budget are set; the target field is undecidable");
  } else if (daily !== null) {
    field = "daily_budget";
  } else if (lifetime !== null) {
    field = "lifetime_budget";
    // A lifetime budget is meaningless without the schedule it spans, and no
    // retained source carries a campaign or ad-set end date.
    block("lifetime_schedule_unretained", "lifetime budget with no retained schedule or end date; remaining lifetime is unknowable");
  } else {
    block("budget_value_absent", "neither budget field is set in the retained state");
  }
  if (cfg?.anyMixed) block("budget_field_ambiguous", "the capture is flagged budget-mixed");
  if ((cfg?.distinctFingerprints ?? 0) > 1) {
    block("conflicting_transition", `${cfg?.distinctFingerprints} disagreeing captures share this effective day`);
  }

  const currentRaw = field === "daily_budget" ? daily : field === "lifetime_budget" ? lifetime : null;
  const signed = direction === "increase" ? percent : -percent;
  const proposedRaw = currentRaw === null ? null : Math.round(currentRaw * (1 + signed / 100));
  if (currentRaw !== null && proposedRaw !== null && proposedRaw === currentRaw) {
    block("budget_value_absent", "the proposed change rounds to no change at this amount");
  }

  // --- the monetary unit --------------------------------------------------
  const currency = input.ownerAsOfOrigin?.budgetCurrency ?? null;
  if (input.currencyExponentSources === 0) {
    block("unit_exponent_unknown", "no retained per-currency exponent source; the raw amount cannot be converted to account currency");
  }

  // --- delivery -----------------------------------------------------------
  const configured = input.ownerAsOfOrigin?.configuredStatus ?? null;
  const effective = input.ownerAsOfOrigin?.effectiveStatus ?? null;
  if (input.ownerAsOfOrigin === null || configured === null || effective === null) {
    block("status_evidence_absent", "no retained delivery status at this origin; unknown never reads as active");
  } else if (configured !== "ACTIVE" || effective !== "ACTIVE") {
    block("status_not_active", `configured ${configured} / effective ${effective} is not exactly ACTIVE`);
  }
  if (input.entityGrain === "adset") {
    const parent = input.parentAsOfOrigin;
    if (parent === null) {
      block("parent_not_active", "no retained parent-campaign status; an ad set cannot be actioned under an unproven parent");
    } else if (parent.configuredStatus !== "ACTIVE" || parent.effectiveStatus !== "ACTIVE") {
      block("parent_not_active", `parent campaign is ${parent.effectiveStatus ?? "unknown"}`);
    }
  }
  if (cfg !== null && (cfg.optimizationGoal === null || cfg.bidStrategy === null)) {
    block("objective_identity_unknown", "optimization goal or bid strategy is not retained for this state");
  }

  // --- authority ----------------------------------------------------------
  if (input.role === null || !input.role.accountScoped) {
    block("role_authority_absent", "automatic campaign role carries no account scope, so it cannot authorise an account-scoped change");
  }
  if (input.anchor === null) {
    block("commercial_target_absent", "no commercial target pack effective at or before this origin");
  } else if (input.anchor.targetRoas === null && direction === "increase") {
    block("commercial_target_absent", "an increase requires an explicit target ROAS; break-even alone must not be multiplied into a growth target");
  } else if (input.anchor.ageDays > 60) {
    block("commercial_target_stale", `the newest anchor knowable at this origin is ${input.anchor.ageDays} days old`);
  }
  if (input.budgetVerbRows === 0) {
    block("decision_vocabulary_absent", "the decision system has no typed budget verb; there is nowhere to record this intent");
  }

  // --- evidence (only after policy and delivery) --------------------------
  if (input.trailing.spendDays < EVIDENCE_FLOORS.minSpendDaysForAnyAction) {
    block("spend_evidence_floor", `${input.trailing.spendDays} spend-bearing days in the trailing window is below the declared floor of ${EVIDENCE_FLOORS.minSpendDaysForAnyAction}`);
  }
  if (direction === "increase" && input.trailing.conversions < EVIDENCE_FLOORS.minConversionsForIncrease) {
    block("conversion_evidence_floor", "an increase requires at least one trailing conversion");
  }
  if (direction === "increase" && currentRaw !== null && input.trailing.days > 0) {
    // A budget that is not being spent to its limit is not the constraint, so
    // raising it cannot be the mechanism for more volume.
    const perDay = input.trailing.spend / Math.max(1, input.trailing.days);
    if (input.currencyExponentSources === 0) {
      block("budget_not_binding", "budget-binding cannot be tested: spend is in account currency and the budget is in an unconvertible raw unit");
    } else if (perDay < currentRaw * 0.8) {
      block("budget_not_binding", "trailing spend is far below the current budget, so the budget is not the binding constraint");
    }
  }
  const staleBy = input.ownerAsOfOrigin ? daysBetween(input.ownerAsOfOrigin.observedOn, input.origin) : null;
  if (staleBy !== null && staleBy > EVIDENCE_FLOORS.staleObservationDays) {
    block("observation_stale", `the newest owner observation is ${staleBy} days before this origin`);
  }

  // --- change safety ------------------------------------------------------
  const recent = input.recentChanges.filter(
    (c) => daysBetween(c.effectiveFrom, input.origin) <= EVIDENCE_FLOORS.cooldownDays,
  );
  if (recent.length > 0) block("recent_change_cooldown", `${recent.length} retained change(s) inside the ${EVIDENCE_FLOORS.cooldownDays}-day cooldown`);
  const window = input.recentChanges.filter(
    (c) => daysBetween(c.effectiveFrom, input.origin) <= EVIDENCE_FLOORS.oscillationLookbackDays,
  );
  // A reversal is a property of consecutive changes, not of a window. Taking
  // only the changes inside the lookback dropped the first leg of any reversal
  // that straddled its edge, so a genuine flip-flop read as a single direction.
  // The most recent change before the window is included as context.
  const priorContext = input.recentChanges
    .filter((c) => daysBetween(c.effectiveFrom, input.origin) > EVIDENCE_FLOORS.oscillationLookbackDays)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    .slice(-1);
  const directions = new Set(
    [...priorContext, ...window].map((c) => c.direction).filter((d) => d !== "unresolved"),
  );
  if (directions.size > 1) block("oscillation_risk", "retained changes reverse direction across the oscillation window");
  if (window.length > EVIDENCE_FLOORS.maxEntityChangesPerWindow) {
    block("entity_cap", `${window.length} retained changes exceed the per-entity cap of ${EVIDENCE_FLOORS.maxEntityChangesPerWindow}`);
  }
  if (input.caps.businessProposals >= EVIDENCE_FLOORS.maxBusinessChangesPerOrigin) block("business_cap", "the per-business cap for this origin is reached");
  if (input.caps.fleetProposals >= EVIDENCE_FLOORS.maxFleetChangesPerOrigin) block("fleet_cap", "the fleet cap for this origin is reached");
  if (input.caps.accountExposureShare > EVIDENCE_FLOORS.maxAccountExposureShare) {
    block("concentration_cap", "this entity would carry more than the permitted share of account exposure");
  }

  // --- simulated execution safety ----------------------------------------
  if (input.stress?.casDrift) block("cas_drift", "the observed state changed between read and simulated dispatch");
  if (input.stress?.ambiguousOutcome) block("ambiguous_provider_outcome", "the simulated provider outcome is neither confirmed applied nor confirmed rejected");
  if (input.stress?.idempotencyCollision) block("idempotency_collision", "an identical intent already exists for this key");
  if (input.stress?.rollbackUnbounded) block("rollback_exposure_unbounded", "the prior amount is unknown, so the change is not reversible");
  if (input.stress?.killSwitch) block("kill_switch_block", "an incident block is active");

  return { blockers, reasons, owner, field, currentRaw, proposedRaw, currency };
}

/** Builds the typed research proposal for one candidate. */
export function proposeForCandidate(
  input: PolicyInput,
  percent: number,
  direction: PolicyDirection,
  snapshotHash: string,
): BudgetResearchProposal {
  const g = evaluateGates(input, percent, direction);
  // "not_determinable" is reserved for absent evidence; a present fact that
  // fails a rule is "blocked". Conflating them would hide data gaps.
  const eligibility: BudgetResearchProposal["eligibility"] =
    g.blockers.length === 0
      ? "eligible"
      : g.blockers.every((b) => ABSENCE_BLOCKERS.includes(b))
        ? "not_determinable"
        : "blocked";
  return {
    snapshotHash,
    originDate: input.origin,
    businessId: input.binding.businessId,
    business: input.binding.business,
    providerAccountId: input.binding.providerAccountId,
    accountSelected: input.binding.isSelected,
    entityGrain: input.entityGrain,
    entityId: input.entityId,
    campaignId: input.campaignId,
    budgetOwner: g.owner,
    budgetField: g.field,
    ownerMode: input.ownerAsOfOrigin?.budgetOrigin ?? null,
    automaticRole: input.role?.inferredKind ?? null,
    automaticRoleAuthority: input.role?.accountScoped ? "account_scoped" : "absent",
    currency: g.currency,
    unitExponentConfidence: input.currencyExponentSources > 0 ? "authoritative" : "unknown",
    currentRawAmount: g.currentRaw,
    proposedRawAmount: eligibility === "eligible" ? g.proposedRaw : null,
    rawDelta: eligibility === "eligible" && g.proposedRaw !== null && g.currentRaw !== null
      ? g.proposedRaw - g.currentRaw : null,
    policyDirection: direction,
    policyPercent: percent,
    action: eligibility === "eligible" ? "propose_budget_change" : "no_proposal",
    eligibility,
    blockers: [...new Set(g.blockers)].sort(),
    reasons: g.reasons,
    evidenceLane: input.lane,
  };
}

// ---------------------------------------------------------------------------
// extract — one bounded real snapshot
// ---------------------------------------------------------------------------

type DbModule = typeof import("@/lib/db");

async function openDbBoundary(): Promise<{ db: DbModule; authority: ExecutionAuthorityVerdict }> {
  const before = snapshotFlags(process.env);
  const runtime = await import("@/scripts/_operational-runtime");
  runtime.configureOperationalScriptRuntime({ lane: "read_only_observation" });
  const after = snapshotFlags(process.env);
  const authority = evaluateExecutionAuthority(before, after);
  if (!authority.ok) {
    throw new Error(
      `D080B refuses to read: execution authority is present (${[...authority.truthyBefore, ...authority.truthyAfter].join(", ")}). This guard never overrides a flag to pass.`,
    );
  }
  const db = await import("@/lib/db");
  return { db, authority };
}

/**
 * One executed read, exactly as the database returned it. This is the single
 * authoritative record: every section the report uses is materialised from
 * these rows, and the ledger's count and hash are recomputed from them.
 */
export interface MaterialisedRead {
  invocationKey: string;
  planKey: string;
  businessId: string | null;
  providerAccountId: string | null;
  grain: "campaign" | "adset" | null;
  source: string;
  lane: EvidenceLane;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  knowledgeTo: string | null;
  rows: Row[];
}

export interface CollectedEvidence {
  proof: Row;
  ledger: D080BLedgerEntry[];
  reads: MaterialisedRead[];
}

/**
 * The one collection flow. Production runs it inside a real transaction; the
 * behavioural tests run it against a deterministic synthetic source through the
 * same `safeQ` boundary, so what is tested is what runs.
 */
export async function collectEvidence(deps: {
  proof: Row;
  safeQ: SafeQ;
  skip: (request: D080BRequest, code: string, why: string) => void;
  ledger: D080BLedgerEntry[];
  reads: MaterialisedRead[];
}): Promise<CollectedEvidence> {
  const { proof, safeQ, skip, ledger } = deps;
  const businessIds = [...new Set(D080_PINNED_BINDINGS.map((b) => b.businessId))];

  // --- schema contract first: nothing is read before its columns are proven.
  const columnContract = await safeQ(buildRequest({
    planKey: "columnContract", statement: D080B_QUERIES.columnContract,
    params: [Object.keys(D080B_REQUIRED_COLUMNS)],
    source: "information_schema.columns", lane: "strict_pit_authority",
  }));
  const present = new Map<string, Set<string>>();
  for (const row of columnContract) {
    const t = text(row.table_name) ?? "";
    if (!present.has(t)) present.set(t, new Set());
    present.get(t)!.add(text(row.column_name) ?? "");
  }
  const missingColumns: string[] = [];
  for (const [table, cols] of Object.entries(D080B_REQUIRED_COLUMNS)) {
    for (const c of cols) if (!present.get(table)?.has(c)) missingColumns.push(`${table}.${c}`);
  }
  const tableUsable = (table: string) =>
    (D080B_REQUIRED_COLUMNS[table] ?? []).every((c) => present.get(table)?.has(c));

  // --- is there ANY retained currency-exponent source? --------------------
  const currencyExponentSources = await safeQ(buildRequest({
    planKey: "currencyExponentSource", statement: D080B_QUERIES.currencyExponentSource,
    params: [], source: "information_schema.columns", lane: "strict_pit_authority",
  }));

  const observedBindings = await safeQ(buildRequest({
    planKey: "bindings", statement: D080B_QUERIES.bindings, params: [businessIds],
    source: "business_provider_accounts", lane: "strict_pit_authority",
  }));

  // --- clocks per binding per source --------------------------------------
  const clocks: Row[] = [];
  for (const b of D080_PINNED_BINDINGS) {
    for (const src of D080B_CLOCK_SOURCES) {
      const request = buildRequest({
        planKey: "sourceClock", statement: shapeClock(src.key, src.column),
        params: [b.businessId, b.providerAccountId], source: src.key,
        lane: "strict_pit_authority", businessId: b.businessId,
        providerAccountId: b.providerAccountId, grain: src.grain,
      });
      if (!tableUsable(src.key)) {
        skip(request, "source_columns_missing", `${src.key} is missing required columns`);
        continue;
      }
      const rows = await safeQ(request);
      clocks.push({
        business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId,
        source: src.key, grain: src.grain,
        earliest_effective: text(rows[0]?.earliest_effective)?.slice(0, 10) ?? null,
        latest_effective: text(rows[0]?.latest_effective)?.slice(0, 10) ?? null,
        rows: num(rows[0]?.rows) ?? 0,
      });
    }
  }

  // The action window is the intersection every binding can actually support.
  const cutoffFor = (b: PinnedBinding): string | null => {
    const daily = clocks.filter(
      (c) => c.provider_account_id === b.providerAccountId &&
        (c.source === "meta_campaign_daily" || c.source === "meta_adset_daily"),
    );
    const latest = daily.map((c) => text(c.latest_effective)).filter((x): x is string => x !== null);
    return latest.length === daily.length && latest.length > 0 ? latest.sort()[0]! : null;
  };

  const accountCurrency: Row[] = [];
  const configStates: Row[] = [];
  const ownerStates: Row[] = [];
  const performance: Row[] = [];
  const roleContext: Row[] = [];
  const budgetVerbCensus: Row[] = [];

  for (const b of D080_PINNED_BINDINGS) {
    const cutoff = cutoffFor(b);
    const from = cutoff ? addDays(cutoff, -SIMULATION_WINDOW_DAYS) : null;
    const scope = { businessId: b.businessId, providerAccountId: b.providerAccountId };

    const needCutoff = (planKey: string, grain: "campaign" | "adset" | null, source: string, statement: string) =>
      buildRequest({ planKey, statement, params: [], source, lane: "strict_pit_authority", ...scope, grain });

    if (!cutoff || !from) {
      for (const [planKey, grain, source] of [
        ["accountCurrency", null, "meta_campaign_daily"],
        ["configStates", "campaign", "meta_campaign_config_history"],
        ["configStates", "adset", "meta_adset_config_history"],
        ["ownerStates", null, "meta_entity_state_history"],
        ["performanceDaily", "campaign", "meta_campaign_daily"],
        ["performanceDaily", "adset", "meta_adset_daily"],
        ["roleContext", null, "engine_v3_campaign_context_daily"],
        ["budgetVerbCensus", null, "engine_v3_ad_decision_snapshots_daily"],
      ] as const) {
        skip(needCutoff(planKey, grain, source, "-- not shaped: the binding has no cutoff"),
          "binding_cutoff_unavailable", "the daily clocks did not resolve a cutoff for this binding");
      }
      continue;
    }

    accountCurrency.push(...(await safeQ(buildRequest({
      planKey: "accountCurrency", statement: D080B_QUERIES.accountCurrency,
      params: [b.businessId, b.providerAccountId, from, cutoff],
      source: "meta_campaign_daily", lane: "strict_pit_authority", ...scope,
      effectiveFrom: from, effectiveTo: cutoff,
    }))).map((r) => ({ business_id: b.businessId, provider_account_id: b.providerAccountId, ...r })));

    for (const grain of ["campaign", "adset"] as const) {
      const rows = await safeQ(buildRequest({
        planKey: "configStates", statement: shapeConfigStates(grain, true),
        params: [b.businessId, b.providerAccountId, from, cutoff, cutoff],
        source: grain === "campaign" ? "meta_campaign_config_history" : "meta_adset_config_history",
        lane: "strict_pit_authority", ...scope, grain,
        effectiveFrom: from, effectiveTo: cutoff, knowledgeTo: cutoff,
      }));
      configStates.push(...rows.map((r) => ({
        business_id: b.businessId, provider_account_id: b.providerAccountId, grain, ...r,
      })));
      performance.push(...(await safeQ(buildRequest({
        planKey: "performanceDaily", statement: shapePerformance(grain),
        params: [b.businessId, b.providerAccountId, from, cutoff],
        source: grain === "campaign" ? "meta_campaign_daily" : "meta_adset_daily",
        lane: "strict_pit_authority", ...scope, grain, effectiveFrom: from, effectiveTo: cutoff,
      }))).map((r) => ({
        business_id: b.businessId, provider_account_id: b.providerAccountId, grain, ...r,
      })));
    }

    ownerStates.push(...(await safeQ(buildRequest({
      planKey: "ownerStates", statement: D080B_QUERIES.ownerStates,
      params: [b.businessId, b.providerAccountId, from, cutoff],
      source: "meta_entity_state_history", lane: "strict_pit_authority", ...scope,
      effectiveFrom: from, effectiveTo: cutoff,
    }))).map((r) => ({
      business_id: b.businessId, provider_account_id: b.providerAccountId, ...r,
    })));

    roleContext.push(...(await safeQ(buildRequest({
      planKey: "roleContext", statement: D080B_QUERIES.roleContext,
      params: [b.businessId, from, cutoff],
      source: "engine_v3_campaign_context_daily", lane: "strict_pit_authority", ...scope,
      effectiveFrom: from, effectiveTo: cutoff,
    }))).map((r) => ({
      business_id: b.businessId, provider_account_id_scope: b.providerAccountId, ...r,
    })));

    budgetVerbCensus.push(...(await safeQ(buildRequest({
      planKey: "budgetVerbCensus", statement: D080B_QUERIES.budgetVerbCensus,
      params: [b.businessId, b.providerAccountId, from, cutoff],
      source: "engine_v3_ad_decision_snapshots_daily", lane: "strict_pit_authority", ...scope,
      effectiveFrom: from, effectiveTo: cutoff,
    }))).map((r) => ({
      business_id: b.businessId, provider_account_id: b.providerAccountId, ...r,
    })));
  }

  const targetPacks = await safeQ(buildRequest({
    planKey: "targetPacks", statement: D080B_QUERIES.targetPacks, params: [businessIds],
    source: "business_target_pack_history", lane: "strict_pit_authority",
  }));

  // Only the raw reads leave this function. Every section the report uses is
  // materialised from them by `materialiseSnapshot`, which the verifier runs
  // too, so extraction and verification cannot drift apart.
  void missingColumns; void columnContract; void currencyExponentSources;
  void observedBindings; void accountCurrency; void configStates; void ownerStates;
  void performance; void roleContext; void targetPacks; void budgetVerbCensus; void clocks;
  return { proof, ledger, reads: deps.reads };
}

/** The decoration each plan's raw rows receive when they become a section. */
export const D080B_SECTION_OF_PLAN: Record<string, string> = {
  columnContract: "columnContract",
  currencyExponentSource: "currencyExponentSources",
  bindings: "observedBindings",
  sourceClock: "clockReads",
  accountCurrency: "accountCurrency",
  configStates: "configStates",
  ownerStates: "ownerStates",
  performanceDaily: "performance",
  roleContext: "roleContext",
  targetPacks: "targetPacks",
  budgetVerbCensus: "budgetVerbCensus",
};

/**
 * Rebuilds every section from the raw reads. Used by extraction AND by offline
 * verification, so a section can never claim rows the reads do not contain.
 */
export function materialiseSnapshot(reads: MaterialisedRead[]): Record<string, Row[]> {
  const out: Record<string, Row[]> = {
    columnContract: [], currencyExponentSources: [], observedBindings: [],
    clockReads: [], accountCurrency: [], configStates: [], ownerStates: [],
    performance: [], roleContext: [], targetPacks: [], budgetVerbCensus: [],
  };
  const ordered = [...reads].sort((a, b) => a.invocationKey.localeCompare(b.invocationKey));
  for (const read of ordered) {
    const section = D080B_SECTION_OF_PLAN[read.planKey];
    if (!section) continue;
    for (const row of read.rows) {
      if (read.planKey === "sourceClock") {
        out.clockReads!.push({
          business_id: read.businessId, provider_account_id: read.providerAccountId,
          source: read.source, grain: read.grain, ...row,
        });
      } else if (read.planKey === "roleContext") {
        out[section]!.push({
          business_id: read.businessId, provider_account_id_scope: read.providerAccountId, ...row,
        });
      } else if (read.businessId !== null) {
        out[section]!.push({
          business_id: read.businessId, provider_account_id: read.providerAccountId,
          ...(read.grain ? { grain: read.grain } : {}), ...row,
        });
      } else {
        out[section]!.push({ ...row });
      }
    }
  }
  // The clock section the analysis consumes: one row per binding per source,
  // with the dates narrowed to calendar days.
  const clocks: Row[] = out.clockReads!.map((r) => ({
    business: D080_PINNED_BINDINGS.find((b) => b.providerAccountId === text(r.provider_account_id))?.business ?? null,
    business_id: text(r.business_id), provider_account_id: text(r.provider_account_id),
    source: text(r.source), grain: text(r.grain),
    earliest_effective: text(r.earliest_effective)?.slice(0, 10) ?? null,
    latest_effective: text(r.latest_effective)?.slice(0, 10) ?? null,
    rows: num(r.rows) ?? 0,
  }));
  return { ...out, clocks };
}

// ---------------------------------------------------------------------------
// replay — pure analysis of the frozen snapshot
// ---------------------------------------------------------------------------

/**
 * Latest element at or before `on`. This is THE as-of selector the analysis
 * uses for owner, role, config and anchor facts, so the leakage proof drives
 * this exact function rather than asserting a property of the pure engine.
 */
export function latestAtOrBefore<T>(rows: T[], on: string, dateOf: (r: T) => string | null): T | null {
  let best: T | null = null;
  let bestDate: string | null = null;
  for (const r of rows) {
    const d = dateOf(r);
    if (d === null || d > on) continue;
    if (bestDate === null || d > bestDate) { best = r; bestDate = d; }
  }
  return best;
}

export interface OriginPlan {
  origin: string;
  fold: number;
  supportedHorizons: number[];
  unsupportedHorizons: Array<{ horizon: number; why: string }>;
}

/**
 * Origins are weekly from the earliest date every binding supports to the
 * fleet cutoff. A horizon is supported at an origin only when the outcome
 * window it needs fits inside retained history.
 */
export function planOrigins(windowFrom: string, cutoff: string): OriginPlan[] {
  const out: OriginPlan[] = [];
  const span = daysBetween(windowFrom, cutoff);
  if (span <= 0) return out;
  const originDates: string[] = [];
  for (let d = 0; d <= span; d += ORIGIN_CADENCE_DAYS) originDates.push(addDays(windowFrom, d));
  const perFold = Math.ceil(originDates.length / FOLD_COUNT);
  originDates.forEach((origin, i) => {
    const supported: number[] = [];
    const unsupported: Array<{ horizon: number; why: string }> = [];
    for (const h of HORIZON_DAYS) {
      const remaining = daysBetween(origin, cutoff);
      if (remaining >= h) supported.push(h);
      else unsupported.push({ horizon: h, why: `only ${remaining} retained day(s) remain after this origin` });
    }
    out.push({ origin, fold: Math.floor(i / perFold) + 1, supportedHorizons: supported, unsupportedHorizons: unsupported });
  });
  return out;
}

interface EntityIndex {
  binding: PinnedBinding;
  grain: BudgetOwner;
  entityId: string;
  campaignId: string | null;
  configs: Array<{
    effectiveFrom: string; dailyBudget: number | null; lifetimeBudget: number | null;
    anyMixed: boolean; distinctFingerprints: number;
    optimizationGoal: string | null; bidStrategy: string | null; objective: string | null;
  }>;
  perf: Array<{ date: string; spend: number; conversions: number; revenue: number; finalized: boolean }>;
}

export interface AnalysisResult {
  window: { from: string; to: string; perBinding: Row[] };
  origins: OriginPlan[];
  entityUniverse: Row[];
  proposals: BudgetResearchProposal[];
  measurements: Record<string, unknown>;
  observedTransitions: Row[];
  syntheticStress: Row[];
  leakageChecks: Row[];
  blockers: Row[];
}

/**
 * The whole offline analysis. Deterministic: given the same frozen snapshot it
 * must produce byte-identical output, which the replay determinism test proves.
 */
export function analyse(snapshot: Record<string, unknown>): AnalysisResult {
  const snapshotHash = String((snapshot as Row).snapshotHash ?? "");
  const clocks = ((snapshot as Row).clocks as Row[]) ?? [];
  const configStates = ((snapshot as Row).configStates as Row[]) ?? [];
  const ownerStates = ((snapshot as Row).ownerStates as Row[]) ?? [];
  const performance = ((snapshot as Row).performance as Row[]) ?? [];
  const roleContext = ((snapshot as Row).roleContext as Row[]) ?? [];
  const targetPacks = ((snapshot as Row).targetPacks as Row[]) ?? [];
  const verbCensus = ((snapshot as Row).budgetVerbCensus as Row[]) ?? [];
  const exponentSources = ((snapshot as Row).currencyExponentSources as Row[]) ?? [];

  // --- the window every binding supports ----------------------------------
  const perBindingWindow: Row[] = [];
  for (const b of D080_PINNED_BINDINGS) {
    const mine = clocks.filter((c) => text(c.provider_account_id) === b.providerAccountId);
    const daily = mine.filter((c) => text(c.source) === "meta_campaign_daily" || text(c.source) === "meta_adset_daily");
    const latest = daily.map((c) => text(c.latest_effective)).filter((x): x is string => x !== null);
    const earliest = daily.map((c) => text(c.earliest_effective)).filter((x): x is string => x !== null);
    const cutoff = latest.length === daily.length && latest.length > 0 ? latest.sort()[0]! : null;
    perBindingWindow.push({
      business: b.business, business_id: b.businessId, provider_account_id: b.providerAccountId,
      is_selected: b.isSelected, cutoff,
      earliest_retained: earliest.length > 0 ? earliest.sort()[earliest.length - 1]! : null,
      cutoff_status: cutoff ? "resolved" : "unknown/daily_clock_unresolved",
      owner_observations: ownerStates.filter((o) => text(o.provider_account_id) === b.providerAccountId).length,
    });
  }
  const cutoffs = perBindingWindow.map((r) => text(r.cutoff)).filter((x): x is string => x !== null);
  const fleetCutoff = cutoffs.length > 0 ? cutoffs.sort()[0]! : null;
  // The origin axis may only cover history that was actually read. The clock
  // rows report each source's whole retained span, which reaches years before
  // the extraction window; using it directly placed origins in a period no
  // query had loaded, so every entity looked unresolvable there.
  const earliests = perBindingWindow.map((r) => text(r.earliest_retained)).filter((x): x is string => x !== null);
  const retainedFrom = earliests.length > 0 ? earliests.sort()[earliests.length - 1]! : null;
  const readFrom = fleetCutoff ? addDays(fleetCutoff, -SIMULATION_WINDOW_DAYS) : null;
  const fleetFrom = readFrom && retainedFrom ? (readFrom > retainedFrom ? readFrom : retainedFrom) : readFrom;
  const origins = fleetFrom && fleetCutoff ? planOrigins(fleetFrom, fleetCutoff) : [];

  // --- entity index -------------------------------------------------------
  const byEntity = new Map<string, EntityIndex>();
  const bindingOf = new Map(D080_PINNED_BINDINGS.map((b) => [b.providerAccountId, b]));
  for (const row of configStates) {
    const acct = text(row.provider_account_id) ?? "";
    const binding = bindingOf.get(acct);
    const grain = text(row.grain) as BudgetOwner | null;
    const entityId = text(row.entity_id);
    const effectiveFrom = text(row.effective_from)?.slice(0, 10) ?? null;
    if (!binding || !grain || !entityId || !effectiveFrom) continue;
    const key = `${acct}|${grain}|${entityId}`;
    if (!byEntity.has(key)) {
      byEntity.set(key, { binding, grain, entityId, campaignId: null, configs: [], perf: [] });
    }
    byEntity.get(key)!.configs.push({
      effectiveFrom,
      dailyBudget: num(row.daily_budget),
      lifetimeBudget: num(row.lifetime_budget),
      anyMixed: row.any_mixed === true,
      distinctFingerprints: num(row.distinct_fingerprints) ?? 1,
      optimizationGoal: text(row.optimization_goal),
      bidStrategy: text(row.bid_strategy_type),
      objective: text(row.objective),
    });
  }
  for (const row of performance) {
    const key = `${text(row.provider_account_id)}|${text(row.grain)}|${text(row.entity_id)}`;
    const e = byEntity.get(key);
    if (!e) continue;
    e.perf.push({
      date: text(row.date)?.slice(0, 10) ?? "",
      spend: num(row.spend) ?? 0,
      conversions: num(row.conversions) ?? 0,
      revenue: num(row.revenue) ?? 0,
      finalized: row.finalized === true,
    });
  }
  for (const e of byEntity.values()) {
    e.configs.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    e.perf.sort((a, b) => a.date.localeCompare(b.date));
  }

  // --- owner / role / anchor indexes --------------------------------------
  const ownerByEntity = new Map<string, Row[]>();
  const ownerByCampaign = new Map<string, Row[]>();
  for (const o of ownerStates) {
    const acct = text(o.provider_account_id) ?? "";
    const key = `${acct}|${text(o.entity_type)}|${text(o.entity_id)}`;
    (ownerByEntity.get(key) ?? ownerByEntity.set(key, []).get(key)!).push(o);
    if (text(o.entity_type) === "campaign") {
      const ck = `${acct}|${text(o.entity_id)}`;
      (ownerByCampaign.get(ck) ?? ownerByCampaign.set(ck, []).get(ck)!).push(o);
    }
  }
  const roleByCampaign = new Map<string, Row[]>();
  for (const r of roleContext) {
    const key = String(text(r.campaign_id));
    (roleByCampaign.get(key) ?? roleByCampaign.set(key, []).get(key)!).push(r);
  }
  const anchorsByBusiness = new Map<string, Row[]>();
  for (const t of targetPacks) {
    const key = String(text(t.business_id));
    (anchorsByBusiness.get(key) ?? anchorsByBusiness.set(key, []).get(key)!).push(t);
  }
  const verbRowsByAccount = new Map<string, number>();
  for (const v of verbCensus) {
    verbRowsByAccount.set(String(text(v.provider_account_id)), num(v.budget_verb_rows) ?? 0);
  }
  const exponentSourceCount = exponentSources.length;
  return runPolicySimulation({
    snapshotHash, perBindingWindow, fleetFrom, fleetCutoff, origins, byEntity,
    ownerByEntity, ownerByCampaign, roleByCampaign, anchorsByBusiness,
    verbRowsByAccount, exponentSourceCount, configStates,
  });
}

/** The measurement pass. Separated so its inputs are explicit and testable. */
function runPolicySimulation(ctx: {
  snapshotHash: string;
  perBindingWindow: Row[];
  fleetFrom: string | null;
  fleetCutoff: string | null;
  origins: OriginPlan[];
  byEntity: Map<string, EntityIndex>;
  ownerByEntity: Map<string, Row[]>;
  ownerByCampaign: Map<string, Row[]>;
  roleByCampaign: Map<string, Row[]>;
  anchorsByBusiness: Map<string, Row[]>;
  verbRowsByAccount: Map<string, number>;
  exponentSourceCount: number;
  configStates: Row[];
}): AnalysisResult {
  const proposals: BudgetResearchProposal[] = [];
  const entityUniverse: Row[] = [];
  /** Entity/origin pairs where the entity did not exist yet. Never a proposal. */
  let notYetExisting = 0;
  /** Lane 2. Separate array, separate denominators, never action authority. */
  /**
   * The conditional lane, aggregated as it is produced.
   *
   * Correction 9: this was an array of 247,050 `{ ...p, ... }` spread copies,
   * each with a freshly built `reasons` array that nothing read, walked a dozen
   * times afterwards. Every published figure is a counter, a grouped counter, a
   * sum or a small key set, so no row needs to outlive its own iteration. The
   * verifier proves the outputs are unchanged: a dropped field or a mis-ordered
   * key shows up immediately as a measurement that no longer matches the frozen
   * artifact.
   */
  const conditionalLaneAccumulator = createConditionalAccumulator(ctx.origins);

  for (const [, e] of [...ctx.byEntity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    entityUniverse.push({
      business: e.binding.business, business_id: e.binding.businessId,
      provider_account_id: e.binding.providerAccountId, grain: e.grain, entity_id: e.entityId,
      config_states: e.configs.length, spend_days: e.perf.length,
    });
  }

  for (const origin of ctx.origins) {
    // Caps are advanced per origin, so a cap gate reflects real contention.
    const perBusiness = new Map<string, number>();
    let fleetCount = 0;
    for (const [, e] of [...ctx.byEntity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const acct = e.binding.providerAccountId;
      const cfg = latestAtOrBefore(e.configs, origin.origin, (c) => c.effectiveFrom);
      if (cfg === null) {
        // No retained configuration at or before this origin: the entity did
        // not exist yet. Counting it as a blocked proposal would inflate every
        // denominator with rows that were never candidates.
        notYetExisting += 1;
        continue;
      }
      const ownerRows = ctx.ownerByEntity.get(`${acct}|${e.grain}|${e.entityId}`) ?? [];
      const ownerRow = latestAtOrBefore(ownerRows, origin.origin, (o) => text(o.observed_on)?.slice(0, 10) ?? null);
      const campaignId = e.grain === "campaign" ? e.entityId : text(ownerRow?.campaign_id);
      const parentRows = campaignId ? ctx.ownerByCampaign.get(`${acct}|${campaignId}`) ?? [] : [];
      const parentRow = latestAtOrBefore(parentRows, origin.origin, (o) => text(o.observed_on)?.slice(0, 10) ?? null);

      // Trailing evidence is strictly BEFORE the origin: an origin-day fact is
      // not knowable when the decision is taken.
      const windowFrom = addDays(origin.origin, -EVIDENCE_FLOORS.trailingWindowDays);
      const trailingRows = e.perf.filter((p) => p.date >= windowFrom && p.date < origin.origin);
      const trailing = {
        days: EVIDENCE_FLOORS.trailingWindowDays,
        spend: trailingRows.reduce((s, p) => s + p.spend, 0),
        conversions: trailingRows.reduce((s, p) => s + p.conversions, 0),
        revenue: trailingRows.reduce((s, p) => s + p.revenue, 0),
        spendDays: trailingRows.length,
      };

      const roleRows = campaignId ? ctx.roleByCampaign.get(campaignId) ?? [] : [];
      const roleRow = latestAtOrBefore(roleRows, origin.origin, (r) => text(r.as_of_date)?.slice(0, 10) ?? null);
      const role = roleRow
        ? {
            inferredKind: text(roleRow.inferred_kind),
            confidenceClass: text(roleRow.confidence_class),
            // Account scope is only real when the row actually names the account.
            accountScoped: text(roleRow.provider_account_id) === acct,
          }
        : null;

      const anchorRows = ctx.anchorsByBusiness.get(e.binding.businessId) ?? [];
      const anchorRow = latestAtOrBefore(
        // Knowledge-time bound as well as effective-time: a pack recorded after
        // the origin was not knowable at the origin.
        anchorRows.filter((a) => (text(a.recorded_at)?.slice(0, 10) ?? "9999-12-31") <= origin.origin),
        origin.origin,
        (a) => text(a.effective_at)?.slice(0, 10) ?? null,
      );
      const anchor = anchorRow
        ? {
            targetRoas: num(anchorRow.target_roas),
            breakEvenRoas: num(anchorRow.break_even_roas),
            effectiveAt: text(anchorRow.effective_at)?.slice(0, 10) ?? "",
            ageDays: daysBetween(text(anchorRow.effective_at)?.slice(0, 10) ?? origin.origin, origin.origin),
          }
        : null;

      const recentChanges: Array<{ effectiveFrom: string; direction: PolicyDirection | "unresolved" }> = [];
      for (let i = 1; i < e.configs.length; i += 1) {
        const prev = e.configs[i - 1]!;
        const cur = e.configs[i]!;
        if (cur.effectiveFrom >= origin.origin) continue;
        const a = prev.dailyBudget, b = cur.dailyBudget;
        if (a === null || b === null || a === b) continue;
        // A change is only directionally resolved when BOTH sides are
        // single-field and unmixed; otherwise its semantics are unknown.
        const resolved = prev.lifetimeBudget === null && cur.lifetimeBudget === null &&
          !prev.anyMixed && !cur.anyMixed;
        recentChanges.push({
          effectiveFrom: cur.effectiveFrom,
          direction: resolved ? (b > a ? "increase" : "decrease") : "unresolved",
        });
      }

      const input: PolicyInput = {
        origin: origin.origin, binding: e.binding, entityGrain: e.grain, entityId: e.entityId,
        campaignId,
        configAsOfOrigin: cfg,
        ownerAsOfOrigin: ownerRow
          ? {
              observedOn: text(ownerRow.observed_on)?.slice(0, 10) ?? origin.origin,
              budgetOrigin: text(ownerRow.budget_origin),
              budgetCurrency: text(ownerRow.budget_currency),
              configuredStatus: text(ownerRow.configured_status),
              effectiveStatus: text(ownerRow.effective_status),
              presence: text(ownerRow.presence),
            }
          : null,
        parentAsOfOrigin: parentRow
          ? { configuredStatus: text(parentRow.configured_status), effectiveStatus: text(parentRow.effective_status) }
          : null,
        trailing, role, anchor,
        currencyExponentSources: ctx.exponentSourceCount,
        recentChanges,
        budgetVerbRows: ctx.verbRowsByAccount.get(acct) ?? 0,
        caps: {
          businessProposals: perBusiness.get(e.binding.businessId) ?? 0,
          fleetProposals: fleetCount,
          accountExposureShare: 0,
        },
        lane: "strict_pit_authority",
      };

      for (const direction of POLICY_DIRECTIONS) {
        for (const percent of POLICY_LADDER_PERCENT) {
          const p = proposeForCandidate(input, percent, direction, ctx.snapshotHash);
          proposals.push(p);
          if (p.eligibility === "eligible") {
            perBusiness.set(e.binding.businessId, (perBusiness.get(e.binding.businessId) ?? 0) + 1);
            fleetCount += 1;
          }
          // The conditional lane re-scores the SAME evaluation with the three
          // system-capability blockers waived. It never shares a denominator
          // with the lane above and never carries action authority.
          const remaining = p.blockers.filter((b) => !(CONDITIONAL_WAIVED_CODES as readonly string[]).includes(b));
          conditionalLaneAccumulator.accept({
            business: p.business,
            providerAccountId: p.providerAccountId,
            entityGrain: p.entityGrain,
            entityId: p.entityId,
            originDate: p.originDate,
            policyDirection: p.policyDirection,
            policyPercent: p.policyPercent,
            ownerMode: p.ownerMode ?? null,
            budgetField: p.budgetField ?? null,
            evidenceLane: "retrospective_finalized_conditional",
            eligibility:
              remaining.length === 0
                ? "eligible"
                : p.eligibility === "not_determinable"
                  ? "not_determinable"
                  : "blocked",
            blockers: remaining,
            rawDelta: p.rawDelta ?? null,
          });
        }
      }
    }
  }

  // --- measurements -------------------------------------------------------
  const by = (keyOf: (p: BudgetResearchProposal) => string) => {
    const out: Record<string, { eligible: number; blocked: number; not_determinable: number; total: number }> = {};
    for (const p of proposals) {
      const k = keyOf(p);
      out[k] ??= { eligible: 0, blocked: 0, not_determinable: 0, total: 0 };
      out[k][p.eligibility] += 1;
      out[k].total += 1;
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const blockerHits = tallyBlockers(proposals);
  const blockers: Row[] = Object.entries(blockerHits)
    .map(([code, hits]) => ({ code, hits, share: proposals.length ? hits / proposals.length : 0 }))
    .sort((a, b) => (b.hits as number) - (a.hits as number));

  const cond = conditionalLaneAccumulator.finish();
  const conditionalLane = {
    lane: "retrospective_finalized_conditional" as const,
    waivers: CONDITIONAL_WAIVERS,
    denominator: cond.denominator,
    eligible: cond.eligible,
    byPolicyDelta: cond.byPolicyDelta,
    byBusiness: cond.byBusiness,
    byOwnerMode: cond.byOwnerMode,
    byGrain: cond.byGrain,
    byBudgetField: cond.byBudgetField,
    byFold: cond.byFold,
    blockerCensus: cond.blockerCensus,
    grossRawExposure: cond.grossRawExposure,
    worstCaseSimultaneousByOrigin: cond.worstCaseSimultaneousByOrigin,
    concentrationByAccount: cond.concentrationByAccount,
    funnel: cond.funnel,
    /**
     * The ladder cannot discriminate between rungs when every binding gate is
     * evaluated before performance. The one asymmetry that IS real is between
     * directions: an increase must additionally clear a target-ROAS gate, a
     * conversion floor and a budget-binding test that a decrease never faces.
     */
    directionAsymmetry: {
      increaseOnlyBlockers: ["commercial_target_absent", "conversion_evidence_floor", "budget_not_binding"],
      increaseCensus: cond.increaseCensus,
      decreaseCensus: cond.decreaseCensus,
      increaseSurvivingMoneyAndDelivery: cond.increaseSurviving,
      decreaseSurvivingMoneyAndDelivery: cond.decreaseSurviving,
      rungDiscrimination: {
        perRung: cond.perRung,
        rungsAreDistinguishable: cond.rungsAreDistinguishable,
        why: cond.rungsAreDistinguishable
          ? "at least two rungs produce different outcomes"
          : "every rung produces an identical outcome, because every gate that binds is evaluated before the proposed magnitude is ever considered",
      },
    },
    /**
     * The cohort where every structurally required fact WAS retained. If the
     * ladder discriminates anywhere, it discriminates here; if this cohort is
     * empty, the honest answer is that the history cannot rank the rungs.
     */
    coverageCompleteCohort: {
      size: cond.cohort.size,
      entityOrigins: cond.cohort.entityOrigins,
      byPolicyDelta: cond.cohort.byPolicyDelta,
      byOwnerMode: cond.cohort.byOwnerMode,
      byBusiness: cond.cohort.byBusiness,
      remainingBlockers: cond.cohort.remainingBlockers,
      note: "Every structurally required fact was retained for these candidates. A rung is comparable to another only inside this cohort.",
    },
    note: "Research-only sensitivity. Every row here waives at least one system-capability blocker and can never be served as action authority or counted as runtime-eligible.",
  };

  const measurements = {
    conditionalLane,
    denominators: {
      proposalsEvaluated: proposals.length,
      entityOriginPairsSkippedNotYetExisting: notYetExisting,
      origins: ctx.origins.length,
      entities: ctx.byEntity.size,
      candidatesPerEntityOrigin: POLICY_DIRECTIONS.length * POLICY_LADDER_PERCENT.length,
      note: "Every proposal below is strict_pit_authority. Conditional and synthetic rows are counted separately and never added to this denominator.",
    },
    byBusiness: by((p) => p.business),
    byAccount: by((p) => p.providerAccountId),
    byGrain: by((p) => p.entityGrain),
    byOwnerMode: by((p) => p.ownerMode ?? "unobserved"),
    byAction: by((p) => p.policyDirection),
    byPolicyDelta: by((p) => `${p.policyDirection}_${p.policyPercent}`),
    byFold: by((p) => `fold_${ctx.origins.find((o) => o.origin === p.originDate)?.fold ?? 0}`),
    byEvidenceLane: by((p) => p.evidenceLane),
    byBudgetField: by((p) => p.budgetField ?? "undecidable"),
    blockerRanking: blockers,
    exposure: {
      grossRawExposure: proposals.filter((p) => p.eligibility === "eligible")
        .reduce((s, p) => s + Math.abs(p.rawDelta ?? 0), 0),
      accountCurrencyExposure: null,
      accountCurrencyExposureWhyNull:
        "No retained per-currency exponent source exists, so a raw provider amount cannot be converted to account currency. Reporting a converted figure would be an assumption presented as evidence.",
    },
  };

  return {
    window: { from: ctx.fleetFrom ?? "", to: ctx.fleetCutoff ?? "", perBinding: ctx.perBindingWindow },
    origins: ctx.origins,
    entityUniverse,
    proposals,
    measurements,
    observedTransitions: [],
    syntheticStress: [],
    leakageChecks: [],
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Observed transitions, synthetic stress, leakage checks
// ---------------------------------------------------------------------------

/**
 * Observed retained budget transitions, classified by whether BOTH sides are
 * semantically resolved. Only the resolved subset can be compared to a
 * proposal, and its size is published with every comparison.
 */
export function classifyObservedTransitions(configStates: Row[]): Row[] {
  const byEntity = new Map<string, Row[]>();
  for (const r of configStates) {
    const key = `${text(r.provider_account_id)}|${text(r.grain)}|${text(r.entity_id)}`;
    (byEntity.get(key) ?? byEntity.set(key, []).get(key)!).push(r);
  }
  const out: Row[] = [];
  for (const [key, rows] of [...byEntity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...rows].sort((a, b) =>
      String(text(a.effective_from)).localeCompare(String(text(b.effective_from))));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const pd = num(prev.daily_budget), cd = num(cur.daily_budget);
      const pl = num(prev.lifetime_budget), cl = num(cur.lifetime_budget);
      if (pd === cd && pl === cl) continue;
      const bothSingleField =
        (pd !== null) !== (pl !== null) && (cd !== null) !== (cl !== null);
      const sameField = (pd !== null && cd !== null) || (pl !== null && cl !== null);
      const unmixed = prev.any_mixed !== true && cur.any_mixed !== true;
      const singleCapture = (num(prev.distinct_fingerprints) ?? 1) === 1 && (num(cur.distinct_fingerprints) ?? 1) === 1;
      const resolved = bothSingleField && sameField && unmixed && singleCapture;
      const from = pd ?? pl, to = cd ?? cl;
      out.push({
        key, business_id: text(prev.business_id), provider_account_id: text(prev.provider_account_id),
        grain: text(prev.grain), entity_id: text(prev.entity_id),
        prev_effective_from: text(prev.effective_from), effective_from: text(cur.effective_from),
        semantics: resolved ? "resolved" : "unresolved",
        why_unresolved: resolved ? null
          : !bothSingleField ? "one or both sides carry two budget fields"
          : !sameField ? "the budget field changed between the two sides"
          : !unmixed ? "a side is flagged budget-mixed"
          : "a side has disagreeing captures on its effective day",
        direction: resolved && from !== null && to !== null ? (to > from ? "increase" : "decrease") : null,
        percent: resolved && from !== null && to !== null && from !== 0
          ? Math.round(((to - from) / from) * 1000) / 10 : null,
      });
    }
  }
  return out;
}

/**
 * Minimal fixtures for shapes the six-business history does not contain. These
 * never enter a real-data denominator; the lane on every row says so.
 */
export function buildSyntheticStress(): Row[] {
  const binding = D080_PINNED_BINDINGS[0]!;
  const base = (over: Partial<PolicyInput>): PolicyInput => ({
    origin: "2026-08-01", binding, entityGrain: "campaign", entityId: "synthetic-1",
    campaignId: "synthetic-1",
    configAsOfOrigin: {
      effectiveFrom: "2026-07-25", dailyBudget: 100_000, lifetimeBudget: null, anyMixed: false,
      distinctFingerprints: 1, optimizationGoal: "OFFSITE_CONVERSIONS",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP", objective: "OUTCOME_SALES",
    },
    ownerAsOfOrigin: {
      observedOn: "2026-07-31", budgetOrigin: "campaign", budgetCurrency: "USD",
      configuredStatus: "ACTIVE", effectiveStatus: "ACTIVE", presence: "present",
    },
    parentAsOfOrigin: null,
    trailing: { days: 7, spend: 700_000, conversions: 40, revenue: 2_100_000, spendDays: 7 },
    role: { inferredKind: "main", confidenceClass: "high", accountScoped: true },
    anchor: { targetRoas: 2.0, breakEvenRoas: 1.4, effectiveAt: "2026-07-20", ageDays: 12 },
    currencyExponentSources: 1,
    recentChanges: [],
    budgetVerbRows: 1,
    caps: { businessProposals: 0, fleetProposals: 0, accountExposureShare: 0 },
    lane: "synthetic_stress_only",
    ...over,
  });
  /** What each fixture is for. A stress row without this reads as a verdict. */
  const proves: Record<string, string> = {
    all_gates_satisfiable_control: "the ladder is reachable at all when every fact exists; without this the zero result could be a broken engine",
    unit_exponent_unknown: "no exponent source blocks both directions",
    unit_exponent_0_jpy_like: "GAP: the gate asks only whether an exponent source EXISTS, not whether it covers this currency. A zero-exponent currency would pass a presence check and be scaled by 100x",
    unit_exponent_3_kwd_like: "GAP: same presence-only weakness in the other direction; a three-exponent currency would be scaled by a tenth",
    owner_ambiguous: "budget_origin not_applicable never resolves to an owning node",
    owner_absent: "no owner observation blocks regardless of every other fact",
    both_budget_fields_set: "a dual-field state has no decidable target field",
    lifetime_only_near_end: "a lifetime budget without a retained schedule is unactionable",
    no_conversions: "the conversion floor is increase-only; a decrease remains reachable, which is the intended asymmetry",
    high_spend_no_sales: "spend without sales does not block a decrease, which is the case a buyer most wants",
    budget_not_binding: "a non-binding budget blocks the increase mechanism but not a decrease",
    stale_role_and_target: "a stale anchor and an absent role both block",
    recent_change_cooldown: "a change inside the cooldown blocks both directions",
    oscillation: "a reversal blocks even when each leg alone would not",
    cross_account_identity_collision: "an account outside the pinned matrix is refused",
    provider_readback_ambiguous: "an unconfirmed provider outcome blocks",
    cas_drift: "state drift between read and dispatch blocks",
    idempotency_collision: "a duplicate intent blocks",
    rollback_unbounded: "an unknown prior amount blocks, because the change would be irreversible",
    kill_switch: "an incident block overrides everything",
    caps_reached: "caps block once contention is real",
    deselected_account: "an assigned but deselected account is never action scope",
    status_with_issues: "WITH_ISSUES is not ACTIVE and carries no write authority",
    adset_under_paused_campaign: "an active ad set under a paused campaign is not actionable",
    no_typed_budget_verb: "with no typed verb there is nowhere to record the intent",
  };
  const cases: Array<[string, PolicyInput]> = [
    ["all_gates_satisfiable_control", base({})],
    ["unit_exponent_unknown", base({ currencyExponentSources: 0 })],
    ["unit_exponent_0_jpy_like", base({ currencyExponentSources: 1, ownerAsOfOrigin: { ...base({}).ownerAsOfOrigin!, budgetCurrency: "JPY" } })],
    ["unit_exponent_3_kwd_like", base({ currencyExponentSources: 1, ownerAsOfOrigin: { ...base({}).ownerAsOfOrigin!, budgetCurrency: "KWD" } })],
    ["owner_ambiguous", base({ ownerAsOfOrigin: { ...base({}).ownerAsOfOrigin!, budgetOrigin: "not_applicable" } })],
    ["owner_absent", base({ ownerAsOfOrigin: null })],
    ["both_budget_fields_set", base({ configAsOfOrigin: { ...base({}).configAsOfOrigin!, lifetimeBudget: 500_000 } })],
    ["lifetime_only_near_end", base({ configAsOfOrigin: { ...base({}).configAsOfOrigin!, dailyBudget: null, lifetimeBudget: 500_000 } })],
    ["no_conversions", base({ trailing: { days: 7, spend: 700_000, conversions: 0, revenue: 0, spendDays: 7 } })],
    ["high_spend_no_sales", base({ trailing: { days: 7, spend: 2_000_000, conversions: 0, revenue: 0, spendDays: 7 } })],
    ["budget_not_binding", base({ trailing: { days: 7, spend: 70_000, conversions: 5, revenue: 200_000, spendDays: 7 } })],
    ["stale_role_and_target", base({ role: null, anchor: { targetRoas: 2, breakEvenRoas: 1.4, effectiveAt: "2026-01-01", ageDays: 212 } })],
    ["recent_change_cooldown", base({ recentChanges: [{ effectiveFrom: "2026-07-30", direction: "increase" }] })],
    ["oscillation", base({ recentChanges: [
      { effectiveFrom: "2026-07-10", direction: "increase" },
      { effectiveFrom: "2026-07-20", direction: "decrease" }] })],
    ["cross_account_identity_collision", base({ binding: { ...binding, providerAccountId: "act_999999999999999" } as PinnedBinding })],
    ["provider_readback_ambiguous", base({ stress: { ambiguousOutcome: true } })],
    ["cas_drift", base({ stress: { casDrift: true } })],
    ["idempotency_collision", base({ stress: { idempotencyCollision: true } })],
    ["rollback_unbounded", base({ stress: { rollbackUnbounded: true } })],
    ["kill_switch", base({ stress: { killSwitch: true } })],
    ["caps_reached", base({ caps: { businessProposals: 99, fleetProposals: 99, accountExposureShare: 0.9 } })],
    ["deselected_account", base({ binding: { ...binding, isSelected: false } as PinnedBinding })],
    ["status_with_issues", base({ ownerAsOfOrigin: { ...base({}).ownerAsOfOrigin!, effectiveStatus: "WITH_ISSUES" } })],
    ["adset_under_paused_campaign", base({ entityGrain: "adset", ownerAsOfOrigin: { ...base({}).ownerAsOfOrigin!, budgetOrigin: "adset" }, parentAsOfOrigin: { configuredStatus: "PAUSED", effectiveStatus: "PAUSED" } })],
    ["no_typed_budget_verb", base({ budgetVerbRows: 0 })],
  ];
  return cases.map(([name, input]) => {
    const inc = evaluateGates(input, 10, "increase");
    const dec = evaluateGates(input, 10, "decrease");
    return {
      case: name, lane: "synthetic_stress_only" as const,
      proves: proves[name] ?? "unlabelled fixture",
      increase_blockers: [...new Set(inc.blockers)].sort(),
      decrease_blockers: [...new Set(dec.blockers)].sort(),
      increase_eligible: inc.blockers.length === 0,
      decrease_eligible: dec.blockers.length === 0,
      resolved_field: inc.field, resolved_owner: inc.owner,
    };
  });
}

/**
 * C5 — future-leakage proofs that drive the REAL as-of selector.
 *
 * The earlier version only showed that the pure engine changes when a later
 * fact is handed to it. True, but it proved nothing about the selector that
 * decides what gets handed over. Each check here builds a row set containing a
 * later-dated fact, selects through `latestAtOrBefore` at an earlier origin,
 * and requires both the SELECTED ROW and the resulting decision fingerprint to
 * be unaffected. Every check carries a negative control: advancing the origin
 * past the fact must make it visible and must change the fingerprint.
 */
export function buildLeakageChecks(): Row[] {
  const binding = D080_PINNED_BINDINGS[0]!;
  const origin = "2026-08-01";
  const laterDate = "2026-08-15";
  const afterLater = "2026-08-20";

  const baseConfig = {
    effectiveFrom: "2026-07-25", dailyBudget: 100_000, lifetimeBudget: null as number | null,
    anyMixed: false, distinctFingerprints: 1, optimizationGoal: "OFFSITE_CONVERSIONS",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP", objective: "OUTCOME_SALES",
  };
  const baseInput = (over: Partial<PolicyInput>): PolicyInput => ({
    origin, binding, entityGrain: "campaign", entityId: "leak-1", campaignId: "leak-1",
    configAsOfOrigin: baseConfig,
    ownerAsOfOrigin: null, parentAsOfOrigin: null,
    trailing: { days: 7, spend: 700_000, conversions: 40, revenue: 2_100_000, spendDays: 7 },
    role: null, anchor: null, currencyExponentSources: 0, recentChanges: [],
    budgetVerbRows: 0,
    caps: { businessProposals: 0, fleetProposals: 0, accountExposureShare: 0 },
    lane: "strict_pit_authority", ...over,
  });
  const fingerprint = (i: PolicyInput) => {
    const g = evaluateGates(i, 10, "increase");
    return sha256Canonical({ blockers: [...new Set(g.blockers)].sort(), field: g.field, owner: g.owner, proposed: g.proposedRaw });
  };

  /** Selects through the real seam, then scores what the seam handed over. */
  function check<T>(
    name: string,
    rows: T[],
    dateOf: (r: T) => string | null,
    toInput: (selected: T | null) => PolicyInput,
  ): Row {
    const earlierSelected = latestAtOrBefore(rows, origin, dateOf);
    const laterSelected = latestAtOrBefore(rows, afterLater, dateOf);
    const earlierFingerprint = fingerprint(toInput(earlierSelected));
    const laterFingerprint = fingerprint(toInput(laterSelected));
    const baselineFingerprint = fingerprint(toInput(null));
    return {
      check: name,
      later_fact_dated: laterDate,
      origin,
      // The selector must not hand over the later fact at the earlier origin.
      selected_at_origin: earlierSelected === null ? null : dateOf(earlierSelected),
      later_fact_visible_at_origin: earlierSelected !== null && (dateOf(earlierSelected) ?? "") >= laterDate,
      decision_unchanged_at_origin: earlierFingerprint === baselineFingerprint,
      // Negative control: the same fact must become visible once the origin
      // advances past it, and must then change the decision.
      selected_after_origin_advances: laterSelected === null ? null : dateOf(laterSelected),
      later_fact_visible_after_advance: laterSelected !== null && (dateOf(laterSelected) ?? "") >= laterDate,
      decision_changed_after_advance: laterFingerprint !== baselineFingerprint,
      note: "The selected row and the decision fingerprint are both taken through the real latestAtOrBefore seam, so this tests the boundary rather than the purity of the engine.",
    };
  }

  return [
    check("later_owner_observation",
      [{ observedOn: laterDate, budgetOrigin: "campaign", budgetCurrency: "USD", configuredStatus: "ACTIVE", effectiveStatus: "ACTIVE", presence: "present" }],
      (r) => r.observedOn,
      (sel) => baseInput({ ownerAsOfOrigin: sel })),
    check("later_role_inference",
      [{ asOf: laterDate, inferredKind: "main", confidenceClass: "high", accountScoped: true }],
      (r) => r.asOf,
      (sel) => baseInput({ role: sel ? { inferredKind: sel.inferredKind, confidenceClass: sel.confidenceClass, accountScoped: sel.accountScoped } : null })),
    check("later_commercial_target",
      [{ effectiveAt: laterDate, targetRoas: 2, breakEvenRoas: 1.4 }],
      (r) => r.effectiveAt,
      (sel) => baseInput({ anchor: sel ? { targetRoas: sel.targetRoas, breakEvenRoas: sel.breakEvenRoas, effectiveAt: sel.effectiveAt, ageDays: daysBetween(sel.effectiveAt, afterLater) } : null })),
    check("later_unit_exponent_source",
      [{ recordedAt: laterDate, sources: 1 }],
      (r) => r.recordedAt,
      (sel) => baseInput({ currencyExponentSources: sel ? sel.sources : 0 })),
    check("later_config_state",
      [{ ...baseConfig }, { ...baseConfig, effectiveFrom: laterDate, dailyBudget: 999_000 }],
      (r) => r.effectiveFrom,
      (sel) => baseInput({ configAsOfOrigin: sel ?? baseConfig })),
  ];
}

// ---------------------------------------------------------------------------
// Sealing and verification
// ---------------------------------------------------------------------------

export const HASH_META_KEYS = new Set(["sectionHashes", "artifactHash", "analysisHash"]);

/** Every row-bearing section the verifier must rediscover, not be told about. */
export function discoverRowSets(artifact: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(artifact)) {
    if (HASH_META_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      if (value.some((v) => v && typeof v === "object" && !Array.isArray(v))) out.push(path);
    } else if (value && typeof value === "object") {
      out.push(...discoverRowSets(value as Record<string, unknown>, path));
    }
  }
  return out.sort();
}

export function at(artifact: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined),
    artifact,
  );
}

export function sealArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => !HASH_META_KEYS.has(k)));
  const sectionHashes = Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, canonicalDigest(v)]).sort(([a], [b]) => a.localeCompare(b)),
  );
  return { ...body, sectionHashes, artifactHash: canonicalDigest({ body, sectionHashes }) };
}

export const D080B_REQUIRED_SECTIONS = [
  "provenance.readLedger",
  "scope.pinnedBindings",
  "window.perBinding",
  "origins",
  "entityUniverse",
  "measurements.blockerRanking",
  "observedTransitions",
  "syntheticStress",
  "leakageChecks",
  "proposalSample",
] as const;

export interface SectionAudit {
  section: string;
  handler: string;
  rows: number;
  checks: string[];
}

export interface VerifyResult {
  ok: boolean;
  failures: string[];
  counters: Record<string, number>;
  discoveredRowSets: string[];
  sectionAudits: SectionAudit[];
}

/**
 * Every row-bearing section must resolve to exactly one semantic handler.
 * Discovery alone is not coverage: an unregistered section fails closed, so a
 * newly added section cannot ride along unchecked.
 */
export const D080B_SECTION_HANDLERS: Record<string, { handler: string; checks: string[]; optional?: boolean }> = {
  "provenance.readFailures": { handler: "read_ledger", checks: ["exact_non_ok_multiset"], optional: true },
  "snapshot.reads": { handler: "frozen_source", checks: ["read_schema", "identity_pair", "time_bounds", "snapshot_hash", "ledger_binding"] },
  "provenance.readLedger": { handler: "read_ledger", checks: ["expected_invocation_set", "envelope_rebuild", "slice_count", "slice_hash", "lane_domain", "row_count_domain"] },
  "provenance.executionAuthority.changedByLoader": { handler: "authority_record", checks: ["flag_domain", "no_truthy_flag"] },
  "scope.pinnedBindings": { handler: "pinned_scope", checks: ["exact_charter_matrix", "selection_flags"] },
  "scope.observedBindings": { handler: "materialised", checks: ["recomputed_from_reads"] },
  "schemaContract.accountCurrency": { handler: "materialised", checks: ["recomputed_from_reads"] },
  "commercialAnchors.packs": { handler: "materialised", checks: ["recomputed_from_reads"] },
  "decisionVocabulary.perAccount": { handler: "materialised", checks: ["recomputed_from_reads"] },
  clocks: { handler: "materialised", checks: ["recomputed_from_reads", "window_bounds"] },
  "window.perBinding": { handler: "derived_analysis", checks: ["recomputed_from_replay"] },
  origins: { handler: "derived_analysis", checks: ["recomputed_from_replay", "fold_partition", "horizon_support"] },
  entityUniverse: { handler: "derived_analysis", checks: ["recomputed_from_replay"] },
  "measurements.blockerRanking": { handler: "derived_analysis", checks: ["recomputed_from_replay", "gate_code_domain"] },
  "measurements.conditionalLane.funnel": { handler: "derived_analysis", checks: ["recomputed_from_replay", "monotone"] },
  "measurements.conditionalLane.waivers": { handler: "declared_constant", checks: ["equals_module_constant"] },
  "measurements.conditionalLane.directionAsymmetry.rungDiscrimination.perRung": { handler: "derived_analysis", checks: ["recomputed_from_replay"] },
  proposalSample: { handler: "derived_analysis", checks: ["recomputed_from_replay"] },
  observedTransitions: { handler: "deterministic_builder", checks: ["recomputed_from_frozen_config_states"] },
  syntheticStress: { handler: "deterministic_builder", checks: ["recomputed_from_builder", "lane_tag"] },
  leakageChecks: { handler: "deterministic_builder", checks: ["recomputed_from_builder", "selector_boundary"] },
};

export const D080B_READ_ROW_LIMITS = { maxRows: 1_000_000 } as const;

/** Rebuilds the exact invocation set the plan requires, from the frozen reads. */
export function expectedInvocationKeys(reads: MaterialisedRead[]): string[] {
  const mat = materialiseSnapshot(reads);
  const keys: string[] = [];
  const add = (planKey: string, source: string, b?: PinnedBinding, grain?: "campaign" | "adset" | null) => {
    const scope = b ? `${b.businessId}|${b.providerAccountId}` : "global";
    keys.push(grain ? `${planKey}:${source}#${scope}|${grain}` : `${planKey}:${source}#${scope}`);
  };
  add("columnContract", "information_schema.columns");
  add("currencyExponentSource", "information_schema.columns");
  add("bindings", "business_provider_accounts");
  for (const b of D080_PINNED_BINDINGS) {
    for (const src of D080B_CLOCK_SOURCES) add("sourceClock", src.key, b, src.grain);
  }
  for (const b of D080_PINNED_BINDINGS) {
    const daily = (mat.clocks ?? []).filter(
      (c) => text(c.provider_account_id) === b.providerAccountId &&
        (text(c.source) === "meta_campaign_daily" || text(c.source) === "meta_adset_daily"),
    );
    const latest = daily.map((c) => text(c.latest_effective)).filter((x): x is string => x !== null);
    const hasCutoff = latest.length === daily.length && latest.length > 0;
    if (!hasCutoff) continue;
    add("accountCurrency", "meta_campaign_daily", b);
    for (const grain of ["campaign", "adset"] as const) {
      add("configStates", grain === "campaign" ? "meta_campaign_config_history" : "meta_adset_config_history", b, grain);
      add("performanceDaily", grain === "campaign" ? "meta_campaign_daily" : "meta_adset_daily", b, grain);
    }
    add("ownerStates", "meta_entity_state_history", b);
    add("roleContext", "engine_v3_campaign_context_daily", b);
    add("budgetVerbCensus", "engine_v3_ad_decision_snapshots_daily", b);
  }
  add("targetPacks", "business_target_pack_history");
  return keys.sort();
}

const PINNED_BY_ACCOUNT = new Map(D080_PINNED_BINDINGS.map((b) => [b.providerAccountId, b]));

/**
 * The offline verifier.
 *
 * v1 recomputed its own section hashes and re-derived a handful of claims, so
 * fifteen independently authored single-field lies survived a fresh reseal.
 * v2 treats `snapshot.reads` as the ONE authoritative record and re-derives
 * every other section from it plus module constants. A stored value is only
 * ever compared against something recomputed, never trusted.
 */
export function verifyArtifact(artifact: Record<string, unknown>): VerifyResult {
  const failures: string[] = [];
  const fail = (section: string, reason: string, detail: string) =>
    failures.push(`${section}: ${reason} (${detail})`);
  const sectionAudits: SectionAudit[] = [];

  if (artifact.contract !== D080B_CONTRACT_ID) {
    fail("contract", "contract_mismatch", `expected ${D080B_CONTRACT_ID}, found ${String(artifact.contract)}`);
  }

  // --- C4: every discovered row set must resolve to exactly one handler ----
  const discovered = discoverRowSets(artifact);
  for (const path of discovered) {
    const spec = D080B_SECTION_HANDLERS[path];
    if (!spec) {
      fail(path, "unhandled_row_bearing_section", "no semantic handler is registered for this section, so it cannot be called checked");
      continue;
    }
    sectionAudits.push({
      section: path, handler: spec.handler,
      rows: (at(artifact, path) as unknown[] | undefined)?.length ?? 0,
      checks: spec.checks,
    });
  }
  for (const [path, spec] of Object.entries(D080B_SECTION_HANDLERS)) {
    // An optional section may legitimately be empty — `readFailures` is empty
    // when nothing failed — but a required one may not vanish.
    if (!spec.optional && !discovered.includes(path)) {
      fail(path, "registered_section_missing", "a registered section is absent from the package; absent and empty are not the same");
    }
  }

  // --- C1: the frozen source -----------------------------------------------
  const snapshot = artifact.snapshot as { reads?: unknown; snapshotHash?: unknown } | undefined;
  const reads = Array.isArray(snapshot?.reads) ? (snapshot!.reads as MaterialisedRead[]) : null;
  if (!reads) {
    fail("snapshot.reads", "frozen_source_missing", "the package carries no frozen reads, so nothing can be re-derived");
    return { ok: false, failures, counters: {}, discoveredRowSets: discovered, sectionAudits };
  }

  const READ_FIELDS = ["invocationKey", "planKey", "businessId", "providerAccountId", "grain",
    "source", "lane", "effectiveFrom", "effectiveTo", "knowledgeTo", "rows"] as const;
  for (const read of reads) {
    const key = String(read?.invocationKey ?? "<unkeyed>");
    const extra = Object.keys(read ?? {}).filter((f) => !(READ_FIELDS as readonly string[]).includes(f));
    if (extra.length > 0) fail("snapshot.reads", "read_unexpected_field", `${key}: ${JSON.stringify(extra.sort())}`);
    for (const f of READ_FIELDS) if (!(f in (read ?? {}))) fail("snapshot.reads", "read_field_missing", `${key}: ${f}`);
    if (!Array.isArray(read?.rows)) { fail("snapshot.reads", "read_rows_invalid", key); continue; }
    if (read.rows.length > D080B_READ_ROW_LIMITS.maxRows) fail("snapshot.reads", "read_rows_invalid", `${key}: implausible row count`);
    if (!EVIDENCE_LANES.includes(read.lane)) fail("snapshot.reads", "read_lane_unknown", `${key}: ${String(read.lane)}`);
    if (read.lane === "synthetic_stress_only") fail("snapshot.reads", "synthetic_lane_read_the_database", key);
    // Identity: the PAIR must be pinned, not each half separately.
    if (read.providerAccountId !== null) {
      const pinned = PINNED_BY_ACCOUNT.get(read.providerAccountId);
      if (!pinned || pinned.businessId !== read.businessId) {
        fail("snapshot.reads", "identity_not_pinned", `${key}: ${String(read.businessId)}|${String(read.providerAccountId)} is not a pinned pair`);
      }
    } else if (read.businessId !== null && !D080_PINNED_BINDINGS.some((b) => b.businessId === read.businessId)) {
      fail("snapshot.reads", "identity_not_pinned", `${key}: ${String(read.businessId)} is not a charter business`);
    }
    for (const f of ["effectiveFrom", "effectiveTo", "knowledgeTo"] as const) {
      const v = read[f];
      if (v !== null && !isCalendarDate(v)) fail("snapshot.reads", "read_time_invalid", `${key}: ${f}=${JSON.stringify(v)}`);
    }
    if (read.effectiveFrom && read.effectiveTo && read.effectiveFrom > read.effectiveTo) {
      fail("snapshot.reads", "read_time_invalid", `${key}: window runs backwards`);
    }
  }

  const recomputedSnapshotHash = canonicalDigest(snapshotBodyOf(reads));
  if (text(snapshot?.snapshotHash) !== recomputedSnapshotHash) {
    fail("snapshot.reads", "snapshot_hash_mismatch", "the declared snapshot hash is not the hash of these reads");
  }
  if (text((artifact.provenance as Row | undefined)?.snapshotHash) !== recomputedSnapshotHash) {
    fail("provenance.snapshotHash", "snapshot_hash_mismatch", "provenance names a different snapshot than the one carried");
  }

  const mat = materialiseSnapshot(reads);
  // Clocks must sit inside the window the extraction actually read.
  for (const row of mat.clocks ?? []) {
    for (const f of ["earliest_effective", "latest_effective"] as const) {
      const v = text(row[f]);
      if (v !== null && !isCalendarDate(v)) fail("clocks", "clock_time_invalid", `${String(text(row.provider_account_id))}/${String(text(row.source))}: ${f}`);
    }
  }

  // --- C2: request, ledger and result provenance ---------------------------
  const ledger = (at(artifact, "provenance.readLedger") as Row[] | undefined) ?? [];
  const expectedKeys = expectedInvocationKeys(reads);
  const executed = ledger.filter((l) => text(l.disposition) === "execute");
  const observedKeys = ledger.map((l) => String(text(l.invocationKey))).sort();
  if (canonicalDigest(observedKeys) !== canonicalDigest(expectedKeys)) {
    const missing = expectedKeys.filter((k) => !observedKeys.includes(k));
    const extra = observedKeys.filter((k) => !expectedKeys.includes(k));
    fail("provenance.readLedger", "invocation_set_mismatch",
      `${missing.length} missing, ${extra.length} unexpected; first missing ${missing[0] ?? "-"}, first unexpected ${extra[0] ?? "-"}`);
  }
  if (new Set(observedKeys).size !== observedKeys.length) {
    fail("provenance.readLedger", "duplicate_invocation", "an invocation key appears more than once");
  }

  const readByKey = new Map(reads.map((r) => [r.invocationKey, r]));
  for (const entry of executed) {
    const key = String(text(entry.invocationKey));
    const read = readByKey.get(key);
    if (!read) { fail("provenance.readLedger", "executed_read_not_materialised", key); continue; }
    // Count and hash are recomputed from the kept rows, never accepted.
    if (num(entry.rows) !== read.rows.length) {
      fail("provenance.readLedger", "slice_count_mismatch", `${key}: ledger ${String(entry.rows)} vs materialised ${read.rows.length}`);
    }
    const recomputedHash = canonicalDigest(read.rows);
    if (text(entry.sourceRowHash) !== recomputedHash) {
      fail("provenance.readLedger", "slice_hash_mismatch", `${key}: the recorded source hash is not the hash of the kept rows`);
    }
    // The envelope is rebuilt from the static plan, not read back.
    for (const field of ["planKey", "source", "grain", "businessId", "providerAccountId", "lane", "effectiveFrom", "effectiveTo", "knowledgeTo"] as const) {
      const observedValue = (entry as Record<string, unknown>)[field] ?? null;
      const expectedValue = (read as unknown as Record<string, unknown>)[field] ?? null;
      if (canonicalDigest(observedValue) !== canonicalDigest(expectedValue)) {
        fail("provenance.readLedger", "envelope_mismatch", `${key}: ${field} ${canonicalJson(observedValue)} != ${canonicalJson(expectedValue)}`);
      }
    }
    for (const f of ["statementSha256", "paramsSha256"] as const) {
      if (!/^[0-9a-f]{64}$/.test(String(text(entry[f]) ?? ""))) {
        fail("provenance.readLedger", "envelope_mismatch", `${key}: ${f} is not a sha-256 digest`);
      }
    }
    if (typeof entry.rows !== "number" || !Number.isInteger(entry.rows) || entry.rows < 0) {
      fail("provenance.readLedger", "invalid_row_count", `${key}: ${JSON.stringify(entry.rows)}`);
    }
  }
  for (const entry of ledger) {
    if (!EVIDENCE_LANES.includes(text(entry.lane) as EvidenceLane)) fail("provenance.readLedger", "unknown_lane", String(text(entry.lane)));
    if (text(entry.lane) === "synthetic_stress_only") fail("provenance.readLedger", "synthetic_lane_read_the_database", String(text(entry.invocationKey)));
    const disposition = text(entry.disposition);
    if (disposition !== "execute" && disposition !== "dependency_skip") fail("provenance.readLedger", "unknown_disposition", String(disposition));
    if (disposition === "dependency_skip") {
      if (text(entry.dependencyCode) === null) fail("provenance.readLedger", "skip_without_code", String(text(entry.invocationKey)));
      if (entry.rows !== null) fail("provenance.readLedger", "skip_claims_rows", String(text(entry.invocationKey)));
      if (text(entry.statementSha256) !== null) fail("provenance.readLedger", "skip_claims_statement", String(text(entry.invocationKey)));
      if (readByKey.has(String(text(entry.invocationKey)))) fail("provenance.readLedger", "skip_has_materialised_rows", String(text(entry.invocationKey)));
    }
  }

  // readFailures is the exact stable multiset of non-ok ledger rows.
  const storedFailures = (at(artifact, "provenance.readFailures") as Row[] | undefined) ?? [];
  const stable = (rows: Row[]) => rows.map((r) => canonicalJson(r)).sort();
  if (canonicalDigest(stable(storedFailures)) !== canonicalDigest(stable(ledger.filter((l) => text(l.status) !== "ok")))) {
    fail("provenance.readFailures", "read_failure_multiset_mismatch", "readFailures is not exactly the non-ok ledger rows");
  }

  // Static contract and predecessor hashes come from constants.
  const provenance = (artifact.provenance ?? {}) as Row;
  if (text(provenance.queryContractSha256) !== sha256Canonical(D080B_QUERIES)) {
    fail("provenance.queryContractSha256", "query_contract_mismatch", "the recorded query-contract hash is not the hash of the static query contract");
  }
  const pinned = (provenance.pinnedInputHashes ?? {}) as Record<string, unknown>;
  for (const [field, expected] of [
    ["d080aArtifact", D080B_PINNED_INPUTS.d080aArtifactSha256],
    ["d080aInternal", D080B_PINNED_INPUTS.d080aInternalArtifactHash],
    ["d078Bundle", D080B_PINNED_INPUTS.d078BundleSha256],
  ] as const) {
    if (text(pinned[field]) !== expected) {
      fail("provenance.pinnedInputHashes", "predecessor_hash_mismatch", `${field} does not equal the accepted constant`);
    }
  }

  // --- C3: rerun the pure analysis and compare every derived output --------
  const snapshotForAnalysis = { ...mat, snapshotHash: recomputedSnapshotHash };
  const replayed = analyse(snapshotForAnalysis as Record<string, unknown>);
  const derived: Array<[string, unknown, unknown]> = [
    ["window", at(artifact, "window"), replayed.window],
    ["origins", at(artifact, "origins"), replayed.origins],
    ["entityUniverse", at(artifact, "entityUniverse"), replayed.entityUniverse],
    ["clocks", at(artifact, "clocks"), mat.clocks],
    ["scope.observedBindings", at(artifact, "scope.observedBindings"), mat.observedBindings],
    ["schemaContract.accountCurrency", at(artifact, "schemaContract.accountCurrency"), mat.accountCurrency],
    ["schemaContract.currencyExponentSources", at(artifact, "schemaContract.currencyExponentSources"), mat.currencyExponentSources],
    ["schemaContract.missingColumns", at(artifact, "schemaContract.missingColumns"), missingColumnsFrom(mat.columnContract ?? [])],
    ["commercialAnchors.packs", at(artifact, "commercialAnchors.packs"), mat.targetPacks],
    ["decisionVocabulary.perAccount", at(artifact, "decisionVocabulary.perAccount"), mat.budgetVerbCensus],
    ["ownerEvidence.observations", at(artifact, "ownerEvidence.observations"), (mat.ownerStates ?? []).length],
    ["roleEvidence.rows", at(artifact, "roleEvidence.rows"), (mat.roleContext ?? []).length],
  ];
  // Compared by streaming digest, not by building two whole canonical strings.
  // `canonicalDigest(x) === sha256Canonical(x)` is asserted permanently in
  // `canonical-digest.test.ts`, so this decides equality exactly as before.
  for (const [path, stored, expected] of derived) {
    if (canonicalDigest(stored ?? null) !== canonicalDigest(expected ?? null)) {
      fail(path, "derived_output_mismatch", "the published value is not what replaying the frozen reads produces");
    }
  }

  // Measurements are compared whole, then the headline denominator is
  // re-derived from the entity-origin pairs so a lone number cannot drift.
  const storedMeasurements = at(artifact, "measurements") as Record<string, unknown> | undefined;
  const expectedMeasurements = {
    ...replayed.measurements,
    blockerCensus: tallyBlockers(replayed.proposals),
    observedTransitionSummary: (storedMeasurements as Record<string, unknown> | undefined)?.observedTransitionSummary,
    causalClaims: (storedMeasurements as Record<string, unknown> | undefined)?.causalClaims,
  };
  for (const key of Object.keys(replayed.measurements)) {
    if (canonicalDigest((storedMeasurements ?? {})[key] ?? null) !== canonicalDigest((expectedMeasurements as Record<string, unknown>)[key] ?? null)) {
      fail(`measurements.${key}`, "derived_output_mismatch", "the published measurement is not what the replay produces");
    }
  }
  if (canonicalDigest((storedMeasurements ?? {}).blockerCensus ?? null) !== canonicalDigest(expectedMeasurements.blockerCensus)) {
    fail("measurements.blockerCensus", "derived_output_mismatch", "the census is not the census of the replayed proposals");
  }
  const storedDenoms = (storedMeasurements?.denominators ?? {}) as Record<string, unknown>;
  if (num(storedDenoms.proposalsEvaluated) !== replayed.proposals.length) {
    fail("measurements.denominators", "denominator_not_recomputable", `published ${String(storedDenoms.proposalsEvaluated)} vs replayed ${replayed.proposals.length}`);
  }
  for (const r of (at(artifact, "measurements.blockerRanking") as Row[] | undefined) ?? []) {
    if (!(D080B_GATE_CODES as readonly string[]).includes(String(text(r.code)))) {
      fail("measurements.blockerRanking", "unknown_gate_code", String(text(r.code)));
    }
  }

  // --- C3: deterministic builders ------------------------------------------
  const expectedTransitions = classifyObservedTransitions(mat.configStates ?? []);
  if (canonicalDigest(at(artifact, "observedTransitions") ?? null) !== canonicalDigest(expectedTransitions)) {
    fail("observedTransitions", "derived_output_mismatch", "the published transitions are not what the frozen config states produce");
  }
  const expectedStress = buildSyntheticStress();
  if (canonicalDigest(at(artifact, "syntheticStress") ?? null) !== canonicalDigest(expectedStress)) {
    fail("syntheticStress", "derived_output_mismatch", "the published fixtures are not what the deterministic builder produces");
  }
  const expectedLeakage = buildLeakageChecks();
  if (canonicalDigest(at(artifact, "leakageChecks") ?? null) !== canonicalDigest(expectedLeakage)) {
    fail("leakageChecks", "derived_output_mismatch", "the published leakage checks are not what the deterministic builder produces");
  }
  if (canonicalDigest(at(artifact, "measurements.conditionalLane.waivers") ?? null) !== canonicalDigest(CONDITIONAL_WAIVERS)) {
    fail("measurements.conditionalLane.waivers", "waivers_mismatch", "the published waivers are not the declared module constant");
  }
  if (canonicalDigest(at(artifact, "proposalSample") ?? null) !== canonicalDigest(deterministicProposalSample(replayed.proposals))) {
    fail("proposalSample", "derived_output_mismatch", "the published sample is not the deterministic sample of the replayed proposals");
  }
  const causal = (at(artifact, "measurements.causalClaims") ?? {}) as Record<string, unknown>;
  for (const k of ["roasLift", "revenueLift", "purchaseLift", "profitLift"]) {
    if (causal[k] !== null) fail("measurements.causalClaims", "causal_claim_present", `${k} must remain null`);
  }
  const transitionSummary = (at(artifact, "measurements.observedTransitionSummary") ?? {}) as Record<string, unknown>;
  const resolvedRows = expectedTransitions.filter((t) => text(t.semantics) === "resolved");
  if (num(transitionSummary.resolved) !== resolvedRows.length) {
    fail("measurements.observedTransitionSummary", "resolved_count_mismatch", `published ${String(transitionSummary.resolved)} vs recomputed ${resolvedRows.length}`);
  }
  const distinct = new Set(resolvedRows.map((t) => `${text(t.provider_account_id)}|${text(t.effective_from)}|${text(t.direction)}|${num(t.percent)}`)).size;
  if (num(transitionSummary.distinctResolvedEvents) !== distinct) {
    fail("measurements.observedTransitionSummary", "distinct_event_count_mismatch", `published ${String(transitionSummary.distinctResolvedEvents)} vs recomputed ${distinct}`);
  }

  // --- scope ---------------------------------------------------------------
  const bindings = (at(artifact, "scope.pinnedBindings") as Row[] | undefined) ?? [];
  const pinnedKeys = D080_PINNED_BINDINGS.map((b) => `${b.businessId}|${b.providerAccountId}|${b.isSelected}`).sort();
  const observedBindingKeys = bindings.map((b) => `${text(b.business_id)}|${text(b.provider_account_id)}|${String(b.is_selected)}`).sort();
  if (canonicalDigest(pinnedKeys) !== canonicalDigest(observedBindingKeys)) {
    fail("scope.pinnedBindings", "scope_mismatch", "the pinned matrix, including selection, is not exactly the charter matrix");
  }

  // --- self-authored hashes last: the weakest check, never the only one ----
  const stored = (artifact.sectionHashes ?? {}) as Record<string, string>;
  const body = Object.fromEntries(Object.entries(artifact).filter(([k]) => !HASH_META_KEYS.has(k)));
  for (const [k, v] of Object.entries(body)) {
    if (stored[k] !== canonicalDigest(v)) fail(k, "section_hash_mismatch", "the stored section hash is not the hash of this section");
  }
  for (const k of Object.keys(stored)) if (!(k in body)) fail(k, "section_hash_orphan", "a section hash names a section that is not present");
  if (artifact.artifactHash !== canonicalDigest({ body, sectionHashes: stored })) {
    fail("artifactHash", "artifact_hash_mismatch", "the artifact hash is not the hash of its sealed body");
  }
  const storedAnalysisHash = text(provenance.analysisHash);
  if (storedAnalysisHash !== analysisHashOf(replayed)) {
    fail("provenance.analysisHash", "analysis_hash_mismatch", "the published analysis hash is not the hash of the replayed analysis");
  }

  for (const section of D080B_REQUIRED_SECTIONS) {
    if (at(artifact, section) === undefined || at(artifact, section) === null) {
      fail(section, "required_section_missing", "the contract requires this section; absent is not empty");
    }
  }

  const counters: Record<string, number> = {
    discoveredRowSets: discovered.length,
    registeredHandlers: Object.keys(D080B_SECTION_HANDLERS).length,
    frozenReads: reads.length,
    frozenRows: reads.reduce((n, r) => n + (Array.isArray(r.rows) ? r.rows.length : 0), 0),
    ledgerRows: ledger.length,
    ledgerExecuted: executed.length,
    ledgerSkipped: ledger.length - executed.length,
    expectedInvocations: expectedKeys.length,
    proposalsReplayed: replayed.proposals.length,
    originsReplayed: replayed.origins.length,
    entitiesReplayed: replayed.entityUniverse.length,
    observedTransitions: expectedTransitions.length,
    observedTransitionsResolved: resolvedRows.length,
    observedTransitionsDistinctEvents: distinct,
    syntheticCases: expectedStress.length,
    leakageChecks: expectedLeakage.length,
  };
  return { ok: failures.length === 0, failures, counters, discoveredRowSets: discovered, sectionAudits };
}

// ---------------------------------------------------------------------------
// Artifact assembly and CLI
// ---------------------------------------------------------------------------

/** A bounded, deterministic sample so the artifact stays reviewable. */
export const PROPOSAL_SAMPLE_LIMIT = 200;

/**
 * The ONE sample rule, called by the assembler and recomputed by the verifier,
 * so a self-authored sample cannot be substituted. Eligible rows first — there
 * may be none, which is itself the finding — then blocked rows in stable key
 * order.
 */
export function proposalSampleKey(p: BudgetResearchProposal): string {
  return `${p.originDate}|${p.providerAccountId}|${p.entityGrain}|${p.entityId}|${p.policyDirection}|${p.policyPercent}`;
}

/**
 * A bounded ordered buffer: the `limit` smallest entries by
 * `(key, arrival index)`, which is exactly what a stable sort followed by
 * `slice(0, limit)` yields.
 */
function boundedSmallest(limit: number): {
  offer: (value: BudgetResearchProposal, key: string, index: number) => void;
  take: () => BudgetResearchProposal[];
} {
  const held: Array<{ value: BudgetResearchProposal; key: string; index: number }> = [];
  const after = (a: { key: string; index: number }, b: { key: string; index: number }) =>
    a.key.localeCompare(b.key) || a.index - b.index;
  return {
    offer(value, key, index) {
      const entry = { value, key, index };
      if (held.length >= limit && after(entry, held[held.length - 1]!) >= 0) return;
      let at = held.length;
      while (at > 0 && after(held[at - 1]!, entry) > 0) at -= 1;
      held.splice(at, 0, entry);
      if (held.length > limit) held.length = limit;
    },
    take: () => held.map((h) => h.value),
  };
}

/**
 * The published sample: eligible proposals first, then the rest, each in
 * canonical key order, capped at `PROPOSAL_SAMPLE_LIMIT`.
 *
 * Correction 5 made this bounded. The previous form copied all 247,050
 * proposals, sorted the copy, then filtered it twice, to keep 200 rows. Two
 * `limit`-sized buffers produce the identical result — a stable sort followed
 * by `slice` is by definition the smallest `limit` entries ordered by key and
 * then by arrival — while allocating O(limit) instead of O(n).
 */
export function deterministicProposalSample(
  proposals: BudgetResearchProposal[],
): BudgetResearchProposal[] {
  const eligible = boundedSmallest(PROPOSAL_SAMPLE_LIMIT);
  const rest = boundedSmallest(PROPOSAL_SAMPLE_LIMIT);
  for (let i = 0; i < proposals.length; i += 1) {
    const p = proposals[i]!;
    const key = proposalSampleKey(p);
    if (p.eligibility === "eligible") eligible.offer(p, key, i);
    else rest.offer(p, key, i);
  }
  return [...eligible.take(), ...rest.take()].slice(0, PROPOSAL_SAMPLE_LIMIT);
}

/** The stable body the snapshot hash is taken over. Never includes the hash. */
export function snapshotBodyOf(reads: MaterialisedRead[]): unknown {
  return [...reads]
    .sort((a, b) => a.invocationKey.localeCompare(b.invocationKey))
    .map((r) => ({
      invocationKey: r.invocationKey, planKey: r.planKey, businessId: r.businessId,
      providerAccountId: r.providerAccountId, grain: r.grain, source: r.source, lane: r.lane,
      effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, knowledgeTo: r.knowledgeTo,
      rows: r.rows,
    }));
}

/** Recomputes the required-column verdict from the materialised contract rows. */
export function missingColumnsFrom(columnContract: Row[]): string[] {
  const present = new Map<string, Set<string>>();
  for (const row of columnContract) {
    const t = text(row.table_name) ?? "";
    if (!present.has(t)) present.set(t, new Set());
    present.get(t)!.add(text(row.column_name) ?? "");
  }
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(D080B_REQUIRED_COLUMNS)) {
    for (const c of cols) if (!present.get(table)?.has(c)) missing.push(`${table}.${c}`);
  }
  return missing.sort();
}

export function assembleArtifact(input: {
  collected: CollectedEvidence;
  analysis: AnalysisResult;
  authority: ExecutionAuthorityVerdict;
  pinnedInputHashes: Record<string, string>;
}): Record<string, unknown> {
  const { collected, analysis, authority, pinnedInputHashes } = input;
  const reads = collected.reads;
  const snapshotHash = sha256Canonical(snapshotBodyOf(reads));
  const mat = materialiseSnapshot(reads);
  const missingColumns = missingColumnsFrom(mat.columnContract!);
  const transitions = classifyObservedTransitions(mat.configStates!);
  const stress = buildSyntheticStress();
  const leakage = buildLeakageChecks();
  const blockerCensus = tallyBlockers(analysis.proposals);

  const sample = deterministicProposalSample(analysis.proposals);

  return sealArtifact({
    contract: D080B_CONTRACT_ID,
    provenance: {
      retrievedAt: text(collected.proof.retrieved_at),
      transactionIsolation: text(collected.proof.transaction_isolation),
      transactionReadOnly: text(collected.proof.transaction_read_only),
      statementTimeout: text(collected.proof.statement_timeout),
      lockTimeout: text(collected.proof.lock_timeout),
      snapshotHash,
      // Published so an independent reader can re-derive it; the verifier
      // recomputes it from the replayed analysis rather than trusting it.
      analysisHash: analysisHashOf(analysis),
      pinnedInputHashes,
      executionAuthority: {
        ...authority,
        note: "Loading configuration populates process.env. The enforced invariant is that this script never grants or masks execution authority: a truthy flag before OR after loading refuses the run and is never overwritten.",
      },
      readLedger: collected.ledger,
      readFailures: collected.ledger.filter((e) => e.status !== "ok"),
      queryContractSha256: sha256Canonical(D080B_QUERIES),
      note: "SELECT only, inside one REPEATABLE READ READ ONLY transaction with a savepoint per optional read. No provider call, no write of any kind, no entity names or PII.",
    },
    scope: {
      pinnedBindings: D080_PINNED_BINDINGS.map((b) => ({
        business: b.business, business_id: b.businessId,
        provider_account_id: b.providerAccountId, is_selected: b.isSelected,
      })),
      observedBindings: mat.observedBindings!,
      charterBusinesses: [...new Set(D080_PINNED_BINDINGS.map((b) => b.business))].sort(),
      note: "Accounts are never merged inside a business. TheSwaf carries one selected account and one assigned-but-deselected reference account; the deselected one is never action scope.",
    },
    schemaContract: {
      requiredColumns: D080B_REQUIRED_COLUMNS,
      missingColumns,
      currencyExponentSources: mat.currencyExponentSources!,
      unitContract: {
        status: mat.currencyExponentSources!.length > 0 ? "exponent_source_present" : "unknown_unit_scale",
        basis: "No column in the public schema names a currency exponent, minor unit, currency scale or currency decimal. The repository invariant asserts Meta budget values are provider minor units, but that assertion is not backed by a retained per-currency exponent, and ISO exponents differ by currency. Raw amounts are therefore reported in provider units only.",
        repositoryAssertion: "docs/creative-decision-center/INVARIANTS.md: Meta budget and currency-formatted bid values are provider minor units.",
      },
      accountCurrency: mat.accountCurrency!,
    },
    /**
     * The frozen input the analysis is a pure function of. It is carried here
     * so `replay` re-derives the analysis from the same bytes rather than from
     * a second database read, which is what makes determinism checkable.
     */
    snapshot: { reads, snapshotHash },
    window: analysis.window,
    origins: analysis.origins,
    clocks: mat.clocks!,
    entityUniverse: analysis.entityUniverse,
    ownerEvidence: {
      observations: mat.ownerStates!.length,
      byOriginKind: tally(mat.ownerStates!.map((o) => `${text(o.entity_type)}/${text(o.budget_origin)}`)),
      byStatus: tally(mat.ownerStates!.map((o) => `${text(o.configured_status)}/${text(o.effective_status)}`)),
      note: "budget_origin is the only retained statement of which node owns the money. Its coverage is the ceiling on strict point-in-time owner reconstruction.",
    },
    roleEvidence: {
      rows: mat.roleContext!.length,
      accountScopedRows: mat.roleContext!.filter((r) => text(r.provider_account_id) !== null).length,
      byKind: tally(mat.roleContext!.map((r) => `${text(r.inferred_kind)}/${text(r.confidence_class)}`)),
      note: "Automatic inference only. No manual Test/Main/Mixed label was read, restored or consulted. A role row without a provider account cannot carry account-scoped authority.",
    },
    commercialAnchors: {
      packs: mat.targetPacks!,
      businessesWithAnyPack: [...new Set(mat.targetPacks!.map((t) => text(t.business_id)))].filter(Boolean).length,
      charterBusinesses: [...new Set(D080_PINNED_BINDINGS.map((b) => b.businessId))].length,
    },
    decisionVocabulary: {
      perAccount: mat.budgetVerbCensus!,
      totalBudgetVerbRows: mat.budgetVerbCensus!.reduce((s, r) => s + (num(r.budget_verb_rows) ?? 0), 0),
      note: "A typed budget intent has nowhere to be recorded: the decision vocabulary is creative-only and ad-grain-only. D080B does not widen it.",
    },
    measurements: {
      ...analysis.measurements,
      blockerCensus,
      observedTransitionSummary: (() => {
        const resolvedRows = transitions.filter((t) => text(t.semantics) === "resolved");
        // A budget change on a campaign-owned campaign is recorded at BOTH the
        // campaign and the ad-set grain, so the row count double-counts the
        // economic event. Collapsing on account+date+direction+magnitude gives
        // the number of distinct changes an operator actually made.
        const eventKey = (t: Row) =>
          `${text(t.provider_account_id)}|${text(t.effective_from)}|${text(t.direction)}|${num(t.percent)}`;
        const distinctEvents = new Set(resolvedRows.map(eventKey));
        const magnitudes = resolvedRows.map((t) => num(t.percent)).filter((x): x is number => x !== null);
        const inLadder = magnitudes.filter((m) => POLICY_LADDER_PERCENT.includes(Math.abs(m) as never));
        return {
          total: transitions.length,
          resolved: resolvedRows.length,
          distinctResolvedEvents: distinctEvents.size,
          unresolvedReasons: tally(transitions.filter((t) => text(t.semantics) !== "resolved").map((t) => String(text(t.why_unresolved)))),
          magnitudeDistribution: tally(magnitudes.map((m) => {
            const a = Math.abs(m);
            return `${m < 0 ? "decrease" : "increase"}_${a <= 25 ? "0_25pct" : a <= 100 ? "26_100pct" : "over_100pct"}`;
          })),
          insideLadderRows: inLadder.length,
          outsideLadderRows: magnitudes.length - inLadder.length,
          note: "Only the resolved subset may be compared to a proposal, and its size travels with every comparison. A retained transition is an observation, never a causal outcome, and it says nothing about whether the change was a good one.",
          ladderNote: "The retained changes cluster far outside the 5-25% ladder. That is evidence about historical operator behaviour, not evidence that large steps are safe.",
        };
      })(),
      causalClaims: {
        roasLift: null, revenueLift: null, purchaseLift: null, profitLift: null,
        why: "No counterfactual exists for a budget change that was never made. This audit measures proposal eligibility and exposure, never outcome lift.",
      },
    },
    proposalSample: sample,
    observedTransitions: transitions,
    syntheticStress: stress,
    leakageChecks: leakage,
    evidenceLanes: {
      lanes: EVIDENCE_LANES,
      note: "strict_pit_authority carries every real-data headline. retrospective_finalized_conditional is research-only sensitivity and can never be served as action authority or counted as runtime-eligible. synthetic_stress_only sits outside every real denominator.",
      realDataDenominator: analysis.proposals.length,
      syntheticRowCount: stress.length,
    },
    policyContract: {
      ladderPercent: POLICY_LADDER_PERCENT,
      directions: POLICY_DIRECTIONS,
      horizons: HORIZON_DAYS,
      originCadenceDays: ORIGIN_CADENCE_DAYS,
      folds: FOLD_COUNT,
      evidenceFloors: EVIDENCE_FLOORS,
      gateCodes: D080B_GATE_CODES,
      note: "Every threshold is declared data, not a scattered constant, and every rung is a hypothesis. No universal default is assumed anywhere.",
    },
  });
}

export async function runExtract(): Promise<void> {
  for (const [label, path, expected] of [
    ["d080a", D080B_PINNED_INPUTS.d080aArtifactPath, D080B_PINNED_INPUTS.d080aArtifactSha256],
    ["d078", D080B_PINNED_INPUTS.d078BundlePath, D080B_PINNED_INPUTS.d078BundleSha256],
  ] as const) {
    const observed = createHash("sha256").update(readFileSync(resolve(path))).digest("hex");
    if (observed !== expected) {
      throw new Error(`D080B refuses to run: ${label} input hash mismatch (expected ${expected}, observed ${observed})`);
    }
  }

  const { db, authority } = await openDbBoundary();
  const ledger: D080BLedgerEntry[] = [];
  const reads: MaterialisedRead[] = [];

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
              current_setting('lock_timeout') AS lock_timeout`);
    if (text(proof?.transaction_read_only) !== "on") throw new Error("D080B refuses to run outside a READ ONLY transaction");
    if (text(proof?.transaction_isolation) !== "repeatable read") throw new Error("D080B requires REPEATABLE READ isolation");

    const entryOf = (r: D080BRequest, over: Partial<D080BLedgerEntry>): D080BLedgerEntry => ({
      invocationKey: r.invocationKey, planKey: r.planKey, businessId: r.businessId,
      providerAccountId: r.providerAccountId, grain: r.grain, source: r.source, lane: r.lane,
      statementSha256: r.statementSha256, paramsSha256: r.paramsSha256,
      knowledgeTo: r.knowledgeTo, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
      disposition: "execute", status: "ok", rows: 0, sourceRowHash: null,
      dependencyCode: null, reason: null, ...over,
    });

    const safeQ: SafeQ = async (request) => {
      assertRequestIsInScope(request);
      // A savepoint per optional read: one failure must not abort the snapshot.
      await sql.query("SAVEPOINT d080b");
      try {
        const rows = await sql.query<Row>(request.statement, request.params);
        await sql.query("RELEASE SAVEPOINT d080b");
        // The ledger's count and hash are taken over exactly these rows, and
        // exactly these rows are kept, so the verifier can recompute both.
        reads.push({
          invocationKey: request.invocationKey, planKey: request.planKey,
          businessId: request.businessId, providerAccountId: request.providerAccountId,
          grain: request.grain, source: request.source, lane: request.lane,
          effectiveFrom: request.effectiveFrom, effectiveTo: request.effectiveTo,
          knowledgeTo: request.knowledgeTo, rows,
        });
        ledger.push(entryOf(request, { rows: rows.length, sourceRowHash: sha256Canonical(rows) }));
        return rows;
      } catch (error) {
        await sql.query("ROLLBACK TO SAVEPOINT d080b");
        ledger.push(entryOf(request, {
          status: "unknown/source_read_failed", rows: null, sourceRowHash: null,
          // Never echo a value; only the shape of the failure.
          reason: (error as Error).message.split("\n")[0]!.slice(0, 160),
        }));
        return [];
      }
    };
    const skip = (request: D080BRequest, code: string, why: string) => {
      ledger.push(entryOf(request, {
        disposition: "dependency_skip", status: "not_run_dependency_failed",
        rows: null, sourceRowHash: null, statementSha256: null, paramsSha256: null,
        dependencyCode: code, reason: why,
      }));
    };
    return collectEvidence({ proof, safeQ, skip, ledger, reads });
  });

  const snapshotHash = sha256Canonical(snapshotBodyOf(collected.reads));
  const analysis = analyse({ ...materialiseSnapshot(collected.reads), snapshotHash });
  const artifact = assembleArtifact({
    collected, analysis, authority,
    pinnedInputHashes: {
      d080aArtifact: D080B_PINNED_INPUTS.d080aArtifactSha256,
      d080aInternal: D080B_PINNED_INPUTS.d080aInternalArtifactHash,
      d078Bundle: D080B_PINNED_INPUTS.d078BundleSha256,
    },
  });
  writeFileSync(resolve(D080B_JSON_OUT), JSON.stringify(artifact, null, 1));
  console.log(JSON.stringify({
    phase: "extract",
    retrievedAt: (artifact.provenance as Row).retrievedAt,
    snapshotHash, artifactHash: artifact.artifactHash,
    ledgerRows: collected.ledger.length,
    readFailures: collected.ledger.filter((e) => e.status !== "ok").length,
    entities: analysis.entityUniverse.length,
    origins: analysis.origins.length,
    proposals: analysis.proposals.length,
    eligible: analysis.proposals.filter((p) => p.eligibility === "eligible").length,
  }, null, 1));
}

export function runVerify(path = D080B_JSON_OUT): VerifyResult {
  const artifact = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  const result = verifyArtifact(artifact);
  console.log(JSON.stringify({ phase: "verify", ...result }, null, 1));
  return result;
}

/** Re-runs the pure analysis over the frozen reads carried in the artifact. */
export function replayFromArtifact(artifact: Record<string, unknown>): {
  analysis: AnalysisResult;
  analysisHash: string;
  snapshotHash: string;
} {
  const snapshot = artifact.snapshot as { reads?: MaterialisedRead[] } | undefined;
  if (!snapshot || !Array.isArray(snapshot.reads)) {
    throw new Error("D080B replay: the artifact carries no frozen reads");
  }
  const snapshotHash = sha256Canonical(snapshotBodyOf(snapshot.reads));
  const analysis = analyse({ ...materialiseSnapshot(snapshot.reads), snapshotHash });
  return { analysis, analysisHash: analysisHashOf(analysis), snapshotHash };
}

/** The canonical hash of every derived output the report is allowed to use. */
/**
 * The analysis hash covers the full proposal set, which is the point: it is
 * what makes a single altered proposal detectable.
 *
 * It is computed by streaming digest rather than by `sha256Canonical`, which
 * built a single canonical string over all 247,050 proposals — about 1.1 GiB of
 * the 1,769 MiB a D080B verification used to peak at. The digest is identical
 * (`canonical-digest.test.ts` asserts `canonicalDigest === sha256Canonical`),
 * so every published `analysisHash` stays valid byte for byte.
 */
export function analysisHashOf(analysis: AnalysisResult): string {
  return canonicalDigest({
    window: analysis.window,
    origins: analysis.origins,
    entityUniverse: analysis.entityUniverse,
    measurements: analysis.measurements,
    proposals: analysis.proposals,
  });
}

export function runReplay(path = D080B_JSON_OUT): { analysisHash: string; artifactHash: string } {
  const artifact = JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
  const { analysis, analysisHash, snapshotHash } = replayFromArtifact(artifact);
  console.log(JSON.stringify({
    phase: "replay", snapshotHash, analysisHash,
    artifactHash: text(artifact.artifactHash),
    origins: analysis.origins.length,
    proposals: analysis.proposals.length,
    eligible: analysis.proposals.filter((p) => p.eligibility === "eligible").length,
  }, null, 1));
  return { analysisHash, artifactHash: String(text(artifact.artifactHash)) };
}

const invoked = process.argv[1] ?? "";
if (invoked.includes("d080b-meta-budget-policy-simulation")) {
  const mode = process.argv[2] ?? "extract";
  if (mode === "extract") void runExtract();
  else if (mode === "verify") { if (!runVerify().ok) process.exitCode = 1; }
  else if (mode === "replay") runReplay();
  else { console.error(`unknown mode ${mode}`); process.exitCode = 2; }
}
