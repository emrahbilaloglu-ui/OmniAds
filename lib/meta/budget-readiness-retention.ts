/**
 * D086 — the three retention contracts D085 r16 named as residual blockers.
 *
 * D085 r16 was accepted with four residual blockers. `no_provider_write_path_exists`
 * stays closed by design and is untouched here — this module adds no provider budget
 * endpoint, no dispatch verb and no write ceremony. The other three are RETENTION
 * blockers, and this module is where the facts that would close them are validated
 * before persistence:
 *
 *   A `currency_exponent_not_captured`        -> {@link validateCanonicalBudgetFact}
 *   B `canonical_profile_output_not_retained` -> {@link projectCanonicalProfileOutput}
 *   C `automatic_role_authority_absent`       -> {@link qualifyRoleAuthorityRow}
 *
 * Each is a PURE validator over caller-supplied evidence. Nothing here opens a
 * database handle, calls a provider, reads a clock, or consults the environment: the
 * observation cutoff and the compiled resolver identity are arguments, so a historical
 * replay and a live capture run the identical rules.
 *
 * Every validator is TOTAL for hostile input (D085 Correction 14's rule): it accepts
 * `unknown`, takes exactly one owned snapshot through the hardened observer in
 * `lib/meta/runtime-schema`, and returns a refusal rather than throwing.
 */
import {
  ISO_4217_REGISTRY_SOURCE,
  ISO_4217_REGISTRY_VERSION,
  resolveMinorUnitExponent,
} from "@/lib/currency/iso-4217-minor-units";
import { ACCOUNT_DECISION_PROFILE_CONTRACT } from "@/lib/creative-decision-engine/account-decision-profile";
import {
  CAMPAIGN_CONTEXT_MAX_AGE_DAYS,
  isCampaignContextResolverAuthorityValidated,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import { META_CAMPAIGN_KINDS } from "@/lib/meta/campaign-label-types";
import { META_CORE_PARTITION_SCOPES } from "@/lib/meta/core-config";
import { isDateOnly, strictInstantMs, utcDayMs } from "@/lib/meta/point-in-time-policy";
import type { CommercialAnchorBlockerCode } from "@/lib/creative-decision-engine/commercial-anchor";
import type { AccountDecisionProfile } from "@/lib/creative-decision-engine/types";
import {
  exactMap,
  renderProblems,
  safeSnapshot,
  type SchemaProblem,
} from "@/lib/meta/runtime-schema";

/**
 * THE RETENTION CONTRACT IDENTITY.
 *
 * v1 is superseded. Correction 1 changed both the semantics (expected-scope
 * agreement, at-or-after PIT, action-bearing qualification) and the prepared
 * schema, and Correction 2 changes them again — the persisted fact now carries
 * its own contract and its own unit provenance. No D086 schema was ever
 * deployed and no row exists anywhere, so the corrected identity is versioned
 * now rather than quietly given to v1.
 */
export const D086_RETENTION_CONTRACT = "d086.budget-readiness-retention.v9" as const;

/**
 * Superseded identities, readable as HISTORY only. A row stamped with one of
 * these is never authoritative; it is evidence that an older capture ran.
 */
export const D086_SUPERSEDED_RETENTION_CONTRACTS: readonly string[] = Object.freeze([
  "d086.budget-readiness-retention.v8",
  "d086.budget-readiness-retention.v7",
  "d086.budget-readiness-retention.v1",
  "d086.budget-readiness-retention.v2",
  "d086.budget-readiness-retention.v3",
  "d086.budget-readiness-retention.v4",
  "d086.budget-readiness-retention.v5",
  "d086.budget-readiness-retention.v6",
]);

/** The Meta budget grains this contract admits. Nothing else is a budget owner. */
export const D086_ENTITY_GRAINS = ["campaign", "adset"] as const;
export type D086EntityGrain = (typeof D086_ENTITY_GRAINS)[number];

/**
 * Which artefact owns the budget for this entity.
 *
 * `unknown` is retained as an explicit value rather than guessed: a fact whose owner
 * mode was not observed is evidence about the observation, not about the account.
 */
export const D086_BUDGET_OWNER_MODES = [
  "campaign_budget_optimization",
  "adset_budget",
  "mixed",
  "unknown",
] as const;
export type D086BudgetOwnerMode = (typeof D086_BUDGET_OWNER_MODES)[number];

export const D086_BUDGET_FIELDS = ["daily_budget", "lifetime_budget"] as const;
export type D086BudgetField = (typeof D086_BUDGET_FIELDS)[number];

export const D086_SCHEDULE_STATES = [
  "active",
  "scheduled",
  "ended",
  "paused",
  "unknown",
] as const;
export type D086ScheduleState = (typeof D086_SCHEDULE_STATES)[number];

/**
 * A budget fact that is authoritative enough to publish a raw provider-unit value.
 *
 * The unit-bearing fields are the point of the whole contract. r16's residual blocker
 * exists because `meta_campaign_config_history.daily_budget` is a bare
 * DOUBLE PRECISION with no currency, no exponent and no registry provenance anywhere
 * in the schema — a number whose unit is not recorded is not a fact about money.
 */
export interface CanonicalBudgetFact {
  contract: typeof D086_RETENTION_CONTRACT;
  businessId: string;
  providerAccountId: string;
  entityGrain: D086EntityGrain;
  entityId: string;
  /** Null for a campaign; a non-empty parent for an ad set. Never inferred. */
  parentCampaignId: string | null;
  budgetOwnerMode: D086BudgetOwnerMode;
  budgetField: D086BudgetField;
  /** The provider's own integer, in minor units. Never rescaled at capture. */
  rawMinorUnits: number;
  sourceCurrency: string;
  currencyExponent: number;
  currencyRegistry: string;
  currencyRegistryVersion: string;
  scheduleState: D086ScheduleState;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  providerApiVersion: string;
  sourceKind: string;
  sourceSnapshotId: string | null;
  sourceRunId: string;
  capturedAt: string;
  effectiveAt: string;
  recordedAt: string;
}

export type RetentionOutcome<T> =
  | { retained: true; value: T; blockers: readonly [] }
  | { retained: false; value: null; blockers: readonly string[] };

const refuse = <T>(blockers: string[]): RetentionOutcome<T> => ({
  retained: false,
  value: null,
  blockers: Object.freeze([...new Set(blockers)].sort()) as readonly string[],
});

const keep = <T>(value: T): RetentionOutcome<T> => ({
  retained: true,
  value,
  blockers: Object.freeze([]) as readonly [],
});

/*
  CLOCKS COME FROM THE CANONICAL PIT POLICY.

  r2 used `Date.parse`, which silently ROLLS OVER an impossible calendar day:
  `2026-02-30` became 2 March and was retained as a real date. `strictInstantMs`
  is the shared parser that rejects rollover, and `utcDayMs` is the shared
  day-granularity comparison. Reusing them keeps one PIT rule instead of two.
*/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A strict INSTANT. A date-only string is not an instant and is refused here. */
function instantMs(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  return strictInstantMs(value);
}

/** A strict calendar DAY, rejecting impossible dates rather than rolling them. */
function calendarDayMs(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  return strictInstantMs(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// A — canonical budget-fact retention
// ---------------------------------------------------------------------------

const BUDGET_FACT_KEYS = [
  "businessId",
  "providerAccountId",
  "entityGrain",
  "entityId",
  "parentCampaignId",
  "budgetOwnerMode",
  "budgetField",
  "rawMinorUnits",
  "sourceCurrency",
  "scheduleState",
  "effectiveFrom",
  "effectiveTo",
  "providerApiVersion",
  "sourceKind",
  "sourceSnapshotId",
  "sourceRunId",
  "capturedAt",
  "effectiveAt",
  "recordedAt",
] as const;

export interface BudgetFactCaptureScope {
  /** The binding this observation is being captured FOR. Cross-binding evidence
   *  is refused rather than re-homed. */
  businessId: string;
  providerAccountId: string;
  /** Nothing at or after this instant may be admitted as historical evidence. */
  cutoffIso: string;
}

/**
 * Validate one observed budget fact for retention.
 *
 * The exponent is NOT accepted from the caller. It is resolved from the observed
 * source currency through the ISO-4217 registry at capture time, and the registry
 * version travels with the fact — so a later registry revision can never silently
 * restate a historical value. A currency the registry does not carry is unavailable,
 * never exponent 2.
 */
export function validateCanonicalBudgetFact(
  input: unknown,
  scope: BudgetFactCaptureScope,
): RetentionOutcome<CanonicalBudgetFact> {
  const observation = safeSnapshot(input, "budgetFact");
  if (!observation.ok) {
    return refuse([`budget_fact_unobservable:${renderProblems(observation.problems)}`]);
  }
  const cutoff = instantMs(scope.cutoffIso);
  if (cutoff === null) return refuse(["capture_cutoff_invalid"]);

  const problems: SchemaProblem[] = [];
  const row = exactMap(observation.value, "budgetFact", BUDGET_FACT_KEYS, [], problems);
  if (!row) return refuse(["budget_fact_schema_exact_mismatch", ...problems.map((p) => p.why)]);

  const blockers: string[] = [];

  // --- composite scope: the fact must belong to the binding it is captured for
  if (!nonEmpty(row.businessId) || row.businessId !== scope.businessId) {
    blockers.push("budget_fact_cross_business");
  }
  if (!nonEmpty(row.providerAccountId) || row.providerAccountId !== scope.providerAccountId) {
    blockers.push("budget_fact_cross_account");
  }

  // --- grain and hierarchy: a campaign has no parent, an ad set must have one
  const grain = row.entityGrain;
  if (typeof grain !== "string" || !(D086_ENTITY_GRAINS as readonly string[]).includes(grain)) {
    blockers.push("budget_fact_grain_unsupported");
  } else if (grain === "campaign" && row.parentCampaignId !== null) {
    blockers.push("budget_fact_cross_grain_parent");
  } else if (grain === "adset" && !nonEmpty(row.parentCampaignId)) {
    blockers.push("budget_fact_parent_campaign_missing");
  }
  if (!nonEmpty(row.entityId)) blockers.push("budget_fact_entity_id_missing");

  if (
    typeof row.budgetOwnerMode !== "string"
    || !(D086_BUDGET_OWNER_MODES as readonly string[]).includes(row.budgetOwnerMode)
  ) {
    blockers.push("budget_fact_owner_mode_unknown");
  }

  // --- the field, and the one grain/field combination this slice cannot support
  const field = row.budgetField;
  if (typeof field !== "string" || !(D086_BUDGET_FIELDS as readonly string[]).includes(field)) {
    blockers.push("budget_fact_field_unsupported");
  } else if (field === "lifetime_budget") {
    /*
      A lifetime budget is a flight-scoped total, not a rate. Publishing a raw
      minor-unit delta against it needs the flight's start/stop and pacing, which
      this contract does not carry. Refused as unavailable rather than treated as
      a daily amount.
    */
    blockers.push("budget_fact_lifetime_budget_unsupported");
  }

  // --- the value: an integer count of minor units, never a float major amount
  const raw = row.rawMinorUnits;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    blockers.push("budget_fact_raw_value_not_finite");
  } else if (!Number.isInteger(raw)) {
    blockers.push("budget_fact_raw_value_not_minor_units");
  } else if (!Number.isSafeInteger(raw)) {
    blockers.push("budget_fact_raw_value_not_exact");
  } else if (raw <= 0) {
    /*
      ZERO IS REFUSED AT CAPTURE, exactly as it is at read.

      r3 retained a zero amount and then reported it action-bearing, so capture
      and read disagreed about the same fact. A zero daily budget is not a value
      a proposal could move by a percentage, and a column that coerced to zero
      was indistinguishable from one. One rule, both boundaries.
    */
    blockers.push("budget_fact_raw_value_not_positive");
  }

  // --- the unit: resolved here, from the registry, and stamped with its version
  const exponent = resolveMinorUnitExponent(row.sourceCurrency);
  if (exponent.status !== "resolved") {
    blockers.push(`budget_fact_currency_unresolvable:${exponent.status}`);
  }

  if (
    typeof row.scheduleState !== "string"
    || !(D086_SCHEDULE_STATES as readonly string[]).includes(row.scheduleState)
  ) {
    blockers.push("budget_fact_schedule_state_unknown");
  }
  for (const key of ["effectiveFrom", "effectiveTo"] as const) {
    const value = row[key];
    const label = key === "effectiveFrom" ? "effective_from" : "effective_to";
    if (value === null) continue;
    // A real calendar day, not a string that LOOKS like one: r2 retained
    // "2026-02-30", which `Date.parse` had already rolled into March.
    if (calendarDayMs(value) === null) blockers.push(`budget_fact_${label}_malformed`);
  }

  /*
    ONE PROVENANCE CONTRACT, BOTH BOUNDARIES.

    r4 checked only presence here while the retained reader checked form, so the
    canonical persistence validator happily stamped a v4 fact carrying
    `providerApiVersion: "banana"`, `sourceKind: "anything"` and
    `sourceRunId: "x"` — rows guaranteed to be unusable the moment anything read
    them back. Capture and read now apply the identical rules.
  */
  if (!nonEmpty(row.providerApiVersion)) {
    blockers.push("budget_fact_provider_api_version_missing");
  } else if (!META_GRAPH_API_VERSION_PATTERN.test(row.providerApiVersion as string)) {
    blockers.push("budget_fact_provider_api_version_malformed");
  }
  if (!nonEmpty(row.sourceKind)) {
    blockers.push("budget_fact_source_kind_missing");
  } else if (!D086_RETAINED_SOURCE_KINDS.includes(row.sourceKind as string)) {
    blockers.push("budget_fact_source_kind_unrecognised");
  }
  if (!nonEmpty(row.sourceRunId)) {
    blockers.push("budget_fact_source_run_missing");
  } else if (!D086_SOURCE_RUN_PATTERN.test(row.sourceRunId as string)) {
    blockers.push("budget_fact_source_run_malformed");
  }
  // Optional when null; a real UUID when present.
  if (row.sourceSnapshotId !== null && !UUID_PATTERN.test(String(row.sourceSnapshotId))) {
    blockers.push("budget_fact_source_snapshot_malformed");
  }

  // --- PIT safety: nothing at or after the cutoff may be admitted
  const captured = instantMs(row.capturedAt);
  const effective = instantMs(row.effectiveAt);
  const recorded = instantMs(row.recordedAt);
  if (captured === null) blockers.push("budget_fact_captured_at_malformed");
  if (effective === null) blockers.push("budget_fact_effective_at_malformed");
  if (recorded === null) blockers.push("budget_fact_recorded_at_malformed");
  for (const [label, ms] of [
    ["captured", captured],
    ["effective", effective],
    ["recorded", recorded],
  ] as const) {
    // AT OR AFTER, not merely after: the contract says nothing at the cutoff
    // instant may be admitted, and r1's `>` quietly admitted the boundary row.
    if (ms !== null && ms >= cutoff) blockers.push(`budget_fact_${label}_after_cutoff`);
  }

  if (blockers.length > 0 || exponent.status !== "resolved") return refuse(blockers);

  return keep({
    contract: D086_RETENTION_CONTRACT,
    businessId: row.businessId as string,
    providerAccountId: row.providerAccountId as string,
    entityGrain: grain as D086EntityGrain,
    entityId: row.entityId as string,
    parentCampaignId: (row.parentCampaignId as string | null) ?? null,
    budgetOwnerMode: row.budgetOwnerMode as D086BudgetOwnerMode,
    budgetField: field as D086BudgetField,
    rawMinorUnits: raw as number,
    sourceCurrency: exponent.currency,
    currencyExponent: exponent.exponent,
    // Provenance from the resolution itself, not from a constant re-read later.
    currencyRegistry: exponent.registrySource,
    currencyRegistryVersion: exponent.registryVersion,
    scheduleState: row.scheduleState as D086ScheduleState,
    effectiveFrom: (row.effectiveFrom as string | null) ?? null,
    effectiveTo: (row.effectiveTo as string | null) ?? null,
    providerApiVersion: row.providerApiVersion as string,
    sourceKind: row.sourceKind as string,
    sourceSnapshotId: (row.sourceSnapshotId as string | null) ?? null,
    sourceRunId: row.sourceRunId as string,
    capturedAt: row.capturedAt as string,
    effectiveAt: row.effectiveAt as string,
    recordedAt: row.recordedAt as string,
  });
}

/**
 * The persisted shape of a retained budget fact, as the columns hold it.
 *
 * CAPTURE and RETAINED READ are different jobs and r2 conflated them. Capture
 * resolves the exponent through the ISO-4217 registry — that is the one moment
 * the lookup is legitimate, because it is being observed. A retained read must
 * use the provenance that was STORED; re-resolving through today's registry is
 * exactly the historical restatement this whole slice exists to prevent, and it
 * would also mask a row that never persisted a unit at all.
 */
/**
 * The frozen registry identities a retained row may cite.
 *
 * Recognition comes FIRST and is byte-for-byte; only then is the stored
 * currency/exponent verified against that same version's mapping. A row citing
 * an unknown source or version is refused rather than re-answered with today's
 * values, which is what `currency_exponent_not_captured` is about.
 */
export const D086_RECOGNISED_CURRENCY_REGISTRIES = Object.freeze([
  {
    source: ISO_4217_REGISTRY_SOURCE,
    version: ISO_4217_REGISTRY_VERSION,
    resolve: resolveMinorUnitExponent,
  },
]);

/** The Meta Graph version form used everywhere else in this codebase. */
export const META_GRAPH_API_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;

/** Where a retained budget fact may legitimately have been observed. */
export const D086_RETAINED_SOURCE_KINDS: readonly string[] = Object.freeze([
  "warehouse_daily",
  "meta_entity_observation",
]);

/** A run identity that can actually be looked up: a UUID or a stamped run key. */
export const D086_SOURCE_RUN_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|run_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RETAINED_BUDGET_KEYS = [
  "contract",
  "businessId",
  "providerAccountId",
  "entityGrain",
  "entityId",
  "parentCampaignId",
  "budgetOwnerMode",
  "budgetField",
  "rawMinorUnits",
  "sourceCurrency",
  "currencyExponent",
  "currencyRegistry",
  "currencyRegistryVersion",
  "scheduleState",
  "effectiveFrom",
  "effectiveTo",
  "providerApiVersion",
  "sourceKind",
  "sourceSnapshotId",
  "sourceRunId",
  "capturedAt",
  "effectiveAt",
  "recordedAt",
] as const;

export interface RetainedBudgetScope {
  businessId: string;
  providerAccountId: string;
  /** Nothing at or after this instant may be read as historical evidence. */
  cutoffIso: string;
}

export type RetainedBudgetVerdict =
  | { usable: true; reason: null; blockers: readonly [] }
  | { usable: false; reason: string; blockers: readonly string[] };

const notUsable = (blockers: string[]): RetainedBudgetVerdict => {
  const sorted = [...new Set(blockers)].sort();
  return { usable: false, reason: sorted[0] ?? "retained_budget_unusable", blockers: Object.freeze(sorted) };
};

/**
 * Judge one RETAINED budget row for readiness. Total and fail-closed.
 *
 * It never consults a MUTABLE current registry and never manufactures missing
 * provenance. The stored source and version must first be a RECOGNISED frozen
 * pair; only then is the stored currency/exponent verified against that same
 * cited version's mapping, which does invoke that version's resolver. A row that
 * stored no unit is unusable — the honest answer, and the one r2 got wrong by
 * manufacturing the unit at read time.
 */
export function classifyRetainedBudgetFact(
  retained: unknown,
  scope: RetainedBudgetScope,
): RetainedBudgetVerdict {
  const observation = safeSnapshot(retained, "retainedBudget");
  if (!observation.ok) return notUsable(["retained_budget_unobservable"]);
  const cutoff = instantMs(scope?.cutoffIso);
  if (cutoff === null) return notUsable(["retained_budget_cutoff_invalid"]);
  if (!nonEmpty(scope?.businessId) || !nonEmpty(scope?.providerAccountId)) {
    return notUsable(["retained_budget_expected_scope_unresolved"]);
  }

  const problems: SchemaProblem[] = [];
  const row = exactMap(observation.value, "retainedBudget", RETAINED_BUDGET_KEYS, [], problems);
  if (!row) return notUsable(["retained_budget_schema_exact_mismatch"]);

  const blockers: string[] = [];

  // --- the persisted contract: history is readable, but never authoritative
  if (row.contract === undefined || row.contract === null || row.contract === "") {
    blockers.push("retained_budget_contract_absent");
  } else if (D086_SUPERSEDED_RETENTION_CONTRACTS.includes(row.contract as string)) {
    blockers.push("retained_budget_contract_superseded");
  } else if (row.contract !== D086_RETENTION_CONTRACT) {
    blockers.push("retained_budget_contract_unknown");
  }

  // --- scope, compared against the CALLER's expectation, never the row's own
  if (row.businessId !== scope.businessId) blockers.push("retained_budget_business_scope_mismatch");
  if (row.providerAccountId !== scope.providerAccountId) blockers.push("retained_budget_account_scope_mismatch");
  if (!nonEmpty(row.entityId)) blockers.push("retained_budget_entity_missing");

  // --- grain, hierarchy and owner agreement
  const grain = row.entityGrain;
  if (typeof grain !== "string" || !(D086_ENTITY_GRAINS as readonly string[]).includes(grain)) {
    blockers.push("retained_budget_grain_unsupported");
  } else if (grain === "campaign" && row.parentCampaignId !== null) {
    blockers.push("retained_budget_cross_grain_parent");
  } else if (grain === "adset" && !nonEmpty(row.parentCampaignId)) {
    blockers.push("retained_budget_parent_campaign_missing");
  }
  const owner = row.budgetOwnerMode;
  if (typeof owner !== "string" || !(D086_BUDGET_OWNER_MODES as readonly string[]).includes(owner)) {
    blockers.push("retained_budget_owner_mode_unsupported");
  } else if (owner === "unknown") {
    blockers.push("owner_mode_unknown");
  } else if (owner === "mixed") {
    blockers.push("owner_mode_mixed");
  } else if (
    (grain === "campaign" && owner !== "campaign_budget_optimization")
    || (grain === "adset" && owner !== "adset_budget")
  ) {
    blockers.push("owner_mode_disagrees_with_grain");
  }

  const field = row.budgetField;
  if (typeof field !== "string" || !(D086_BUDGET_FIELDS as readonly string[]).includes(field)) {
    blockers.push("retained_budget_field_unsupported");
  } else if (field === "lifetime_budget") {
    blockers.push("retained_budget_lifetime_unsupported");
  }

  /*
    THE AMOUNT MUST BE ACTIONABLE, not merely present.

    r2 accepted 0 as a valid count of minor units. A zero daily budget is not a
    value a proposal could move by a percentage, and an unpopulated column that
    coerced to 0 was indistinguishable from it.
  */
  const raw = row.rawMinorUnits;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    blockers.push("retained_budget_amount_not_finite");
  } else if (!Number.isInteger(raw)) {
    blockers.push("retained_budget_amount_not_minor_units");
  } else if (!Number.isSafeInteger(raw)) {
    blockers.push("retained_budget_amount_not_exact");
  } else if (raw <= 0) {
    blockers.push("retained_budget_amount_not_positive");
  }

  /*
    THE STORED UNIT PROVENANCE — RECOGNISED, THEN AGREED.

    r3 checked only that these four fields were non-empty and well-shaped, so a
    USD row claiming exponent 4, and a row citing registry "made-up" version
    "v999", both read as usable while the comment above them claimed internal
    coherence.

    The rule has two halves, and the order matters:

      1. The stored registry SOURCE and VERSION must be a RECOGNISED frozen pair,
         compared byte-for-byte. An unknown source or version FAILS — no lookup
         of any kind may repair provenance the row does not have.
      2. ONLY THEN is the stored currency/exponent VERIFIED against that same
         recognised version's mapping, which does call the registry resolver.
         That is verification of what was stored, not restatement: the version
         being verified against is the one the row itself cites, so a future
         revision cannot silently re-answer. Earlier corrections described this
         as "never calls the registry", which was too broad and no longer
         describes the code.
  */
  const currency = row.sourceCurrency;
  const currencyWellFormed = typeof currency === "string" && /^[A-Z]{3}$/.test(currency);
  if (!currencyWellFormed) blockers.push("retained_budget_currency_absent");

  const exponent = row.currencyExponent;
  const exponentWellFormed =
    typeof exponent === "number" && Number.isInteger(exponent) && exponent >= 0 && exponent <= 4;
  if (!exponentWellFormed) blockers.push("retained_budget_exponent_absent");

  if (!nonEmpty(row.currencyRegistry)) blockers.push("retained_budget_registry_absent");
  if (!nonEmpty(row.currencyRegistryVersion)) blockers.push("retained_budget_registry_version_absent");

  const recognised = D086_RECOGNISED_CURRENCY_REGISTRIES.find(
    (r) => r.source === row.currencyRegistry && r.version === row.currencyRegistryVersion,
  );
  if (
    nonEmpty(row.currencyRegistry) && nonEmpty(row.currencyRegistryVersion) && !recognised
  ) {
    blockers.push("retained_budget_registry_unrecognised");
  } else if (recognised && currencyWellFormed && exponentWellFormed) {
    // Verified against the version the ROW cites, which is the current frozen one.
    const resolved = recognised.resolve(currency as string);
    if (resolved.status === "retired_currency") blockers.push("retained_budget_currency_retired");
    else if (resolved.status !== "resolved") blockers.push("retained_budget_currency_unknown");
    else if (resolved.exponent !== exponent) blockers.push("retained_budget_exponent_disagrees_with_registry");
  }

  if (
    typeof row.scheduleState !== "string"
    || !(D086_SCHEDULE_STATES as readonly string[]).includes(row.scheduleState)
  ) {
    blockers.push("retained_budget_schedule_state_unsupported");
  } else if (row.scheduleState === "unknown") {
    blockers.push("schedule_state_unknown");
  }

  /*
    PROVENANCE IS A CONTRACT, NOT PRESENCE.

    r3 accepted `providerApiVersion: "banana"`, `sourceKind: "anything"` and
    `sourceRunId: "x"`. Presence proves a column was written, not that the value
    identifies anything.
  */
  if (!nonEmpty(row.providerApiVersion)) {
    blockers.push("retained_budget_provider_api_version_absent");
  } else if (!META_GRAPH_API_VERSION_PATTERN.test(row.providerApiVersion as string)) {
    blockers.push("retained_budget_provider_api_version_malformed");
  }
  if (!nonEmpty(row.sourceKind)) {
    blockers.push("retained_budget_source_kind_absent");
  } else if (!D086_RETAINED_SOURCE_KINDS.includes(row.sourceKind as string)) {
    blockers.push("retained_budget_source_kind_unrecognised");
  }
  if (!nonEmpty(row.sourceRunId)) {
    blockers.push("retained_budget_source_run_absent");
  } else if (!D086_SOURCE_RUN_PATTERN.test(row.sourceRunId as string)) {
    blockers.push("retained_budget_source_run_malformed");
  }
  /*
    The snapshot identity is OPTIONAL, because the existing config-history column
    is nullable with ON DELETE SET NULL. That is why this verdict is scoped to
    UNIT-RETENTION evidence and is never described as complete action authority
    anywhere it is consumed. When present it must be a real UUID.
  */
  if (row.sourceSnapshotId !== null && !UUID_PATTERN.test(String(row.sourceSnapshotId))) {
    blockers.push("retained_budget_source_snapshot_malformed");
  }

  // --- clocks: strict instants, at-or-after the cutoff refused
  for (const [key, label] of [
    ["capturedAt", "captured"], ["effectiveAt", "effective"], ["recordedAt", "recorded"],
  ] as const) {
    const ms = instantMs(row[key]);
    if (ms === null) blockers.push(`retained_budget_${label}_malformed`);
    else if (ms >= cutoff) blockers.push(`retained_budget_${label}_after_cutoff`);
  }
  // --- date-only fields: real calendar days, compared day-to-day
  for (const [key, label] of [["effectiveFrom", "effective_from"], ["effectiveTo", "effective_to"]] as const) {
    const value = row[key];
    if (value === null) continue;
    const day = calendarDayMs(value);
    if (day === null) blockers.push(`retained_budget_${label}_malformed`);
    else if (day > (utcDayMs(scope.cutoffIso) ?? cutoff)) {
      // Day granularity: the cutoff's OWN day is allowed, per the shared policy.
      blockers.push(`retained_budget_${label}_after_cutoff`);
    }
  }

  return blockers.length === 0
    ? { usable: true, reason: null, blockers: Object.freeze([]) as readonly [] }
    : notUsable(blockers);
}

/**
 * Where a retained row sits in the budget universe.
 *
 * Correction 3's point: in a CBO hierarchy the ad-set seam is NOT the owner, and
 * in an ABO hierarchy the campaign seam is not. A proven non-owner row must not
 * poison readiness — it is correctly not carrying a budget — but a row whose
 * owner mode was never captured must NOT quietly vanish from the denominator
 * either. These are different states and r3 had neither.
 */
export type BudgetUniverseClass =
  /** This row is the owner at its own grain and must qualify. */
  | "applicable"
  /** Proven NOT the owner: the captured owner mode names the other grain. */
  | "proven_non_applicable"
  /** The owner mode was not captured, so ownership is unproven. */
  | "owner_unknown";

export function classifyBudgetUniverse(row: {
  entityGrain: unknown;
  budgetOwnerMode: unknown;
}): BudgetUniverseClass {
  const grain = row.entityGrain;
  const owner = row.budgetOwnerMode;
  if (typeof owner !== "string" || !(D086_BUDGET_OWNER_MODES as readonly string[]).includes(owner)) {
    return "owner_unknown";
  }
  if (owner === "unknown" || owner === "mixed") return "owner_unknown";
  if (grain === "campaign") {
    return owner === "campaign_budget_optimization" ? "applicable" : "proven_non_applicable";
  }
  if (grain === "adset") {
    return owner === "adset_budget" ? "applicable" : "proven_non_applicable";
  }
  return "owner_unknown";
}

/**
 * Whether a retained fact can carry an ACTION, as distinct from being retained.
 *
 * These are different questions and r1 conflated them. A fact whose observed
 * owner mode is `unknown` is perfectly good evidence — it records honestly that
 * the observation did not say who owns the budget — and it is retained. But it
 * cannot clear `owner_mode_unknown`, because that blocker is about exactly the
 * thing the fact does not know. A `mixed` owner is the same case: the budget is
 * owned in more than one place, so no single entity's value is the one to move.
 *
 * Correction 1 caught the conditional lane claiming `owner_mode_unknown` was
 * removed for observations whose retained owner mode is unknown. This is the
 * concrete qualification that claim needed.
 */
export function isActionBearingBudgetFact(fact: CanonicalBudgetFact): boolean {
  // Zero is never action-bearing, whatever else the fact says.
  if (!Number.isSafeInteger(fact.rawMinorUnits) || fact.rawMinorUnits <= 0) return false;
  if (fact.budgetOwnerMode === "unknown" || fact.budgetOwnerMode === "mixed") return false;
  // The owner mode must also agree with the grain it was observed at.
  if (fact.entityGrain === "campaign" && fact.budgetOwnerMode !== "campaign_budget_optimization") return false;
  if (fact.entityGrain === "adset" && fact.budgetOwnerMode !== "adset_budget") return false;
  if (fact.scheduleState === "unknown") return false;
  return true;
}

/** Why a retained fact is not action-bearing, for an operator-readable reason. */
export function actionBearingRefusal(fact: CanonicalBudgetFact): string | null {
  if (!Number.isSafeInteger(fact.rawMinorUnits) || fact.rawMinorUnits <= 0) return "amount_not_positive";
  if (fact.budgetOwnerMode === "unknown") return "owner_mode_unknown";
  if (fact.budgetOwnerMode === "mixed") return "owner_mode_mixed";
  if (fact.entityGrain === "campaign" && fact.budgetOwnerMode !== "campaign_budget_optimization") {
    return "owner_mode_disagrees_with_grain";
  }
  if (fact.entityGrain === "adset" && fact.budgetOwnerMode !== "adset_budget") {
    return "owner_mode_disagrees_with_grain";
  }
  if (fact.scheduleState === "unknown") return "schedule_state_unknown";
  return null;
}

// ---------------------------------------------------------------------------
// B — canonical profile-output retention
// ---------------------------------------------------------------------------

/**
 * The canonical per-action withholding vocabulary.
 *
 * MECHANICALLY TIED to `CommercialAnchorBlockerCode`: the array is typed as that
 * union, so adding a member the union does not have, or dropping one it gains,
 * is a compile error rather than a silent divergence. r4 kept a bare `string[]`
 * that could drift from the engine's own vocabulary without anything noticing.
 */
export const D086_CANONICAL_BLOCKER_CODES: readonly CommercialAnchorBlockerCode[] = Object.freeze([
  "shadow_only",
  "commercial_anchor_missing",
  "commercial_anchor_sample_insufficient",
  "commercial_anchor_provenance_unverified",
  "target_roas_missing",
  "break_even_roas_missing",
  "scale_calibration_below_floor",
] as const);

export const D086_PROFILE_ACTIONS = ["scale", "cut", "refresh"] as const;
export type D086ProfileAction = (typeof D086_PROFILE_ACTIONS)[number];

export interface CanonicalProfileOutput {
  contract: typeof D086_RETENTION_CONTRACT;
  businessId: string;
  providerAccountId: string;
  action: D086ProfileAction;
  /** The canonical profile contract this verdict came from. */
  profileContract: string;
  engineEpoch: string;
  engineVersion: string;
  /** Reproduces the verdict: the exact inputs the resolver ran on. */
  inputFingerprint: string;
  sourceFingerprint: string;
  eligible: boolean;
  /** The canonical per-action code, verbatim. Never a family, never prose. */
  blockerCode: string | null;
  anchorSource: string | null;
  anchorConfidence: string | null;
  spendUnit: number | null;
  commercialAnchorProvenance: string | null;
  asOfDate: string;
  effectiveAt: string;
  recordedAt: string;
}

export interface ProfileCaptureScope {
  businessId: string;
  providerAccountId: string;
  /** The exact inputs the resolver ran on. Both must be real digests. */
  inputFingerprint: string;
  sourceFingerprint: string;
  effectiveAt: string;
  recordedAt: string;
  cutoffIso: string;
}

/**
 * The identity a retained profile verdict is STAMPED with.
 *
 * r2 took the epoch and engine version as caller strings, so "arbitrary-version"
 * was retained and later served. They come from the compiled sources now, and a
 * caller cannot choose them.
 */
export const D086_PROFILE_IDENTITY = Object.freeze({
  profileContract: ACCOUNT_DECISION_PROFILE_CONTRACT,
  engineEpoch: ENGINE_VERSION,
  engineVersion: ENGINE_VERSION,
});

/**
 * Project the EXISTING resolver result for retention. It is a projection, never a
 * re-derivation: the eligibility boolean and the machine code are copied out of
 * `AccountDecisionProfile.hardActionEligibility` exactly as the engine produced them.
 *
 * D079 correction 2 governs the pairing: a code and the boolean it explains come from
 * the same effective code, an eligible action carries no code, and an ineligible
 * action without a code is unknown rather than eligible.
 */
export function projectCanonicalProfileOutput(
  profile: AccountDecisionProfile | unknown,
  action: D086ProfileAction,
  scope: ProfileCaptureScope,
): RetentionOutcome<CanonicalProfileOutput> {
  const observation = safeSnapshot(profile, "profile");
  if (!observation.ok) {
    return refuse([`profile_unobservable:${renderProblems(observation.problems)}`]);
  }
  const cutoff = instantMs(scope.cutoffIso);
  if (cutoff === null) return refuse(["capture_cutoff_invalid"]);
  if (!(D086_PROFILE_ACTIONS as readonly string[]).includes(action)) {
    return refuse(["profile_action_unsupported"]);
  }

  const snapshot = observation.value;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return refuse(["profile_not_a_map"]);
  }
  const doc = snapshot as Record<string, unknown>;
  const blockers: string[] = [];

  if (doc.businessId !== scope.businessId) blockers.push("profile_cross_business");
  const eligibilityRaw = doc.hardActionEligibility;
  if (eligibilityRaw === null || typeof eligibilityRaw !== "object" || Array.isArray(eligibilityRaw)) {
    return refuse(["profile_hard_action_eligibility_absent"]);
  }
  const eligibility = eligibilityRaw as Record<string, unknown>;

  const eligible = eligibility[action];
  if (typeof eligible !== "boolean") {
    blockers.push("profile_eligibility_not_boolean");
  }

  const codesRaw = eligibility.codes;
  const codes =
    codesRaw !== null && typeof codesRaw === "object" && !Array.isArray(codesRaw)
      ? (codesRaw as Record<string, unknown>)
      : null;
  const codeValue = codes ? codes[action] : undefined;
  const blockerCode = typeof codeValue === "string" && codeValue.length > 0 ? codeValue : null;
  /*
    A code must be one the engine can actually produce. Arbitrary persisted prose
    is not a canonical verdict, and D079 correction 2 forbids naming a cause with
    anything but a canonical per-action code.
  */
  if (blockerCode !== null && !(D086_CANONICAL_BLOCKER_CODES as readonly string[]).includes(blockerCode)) {
    blockers.push("profile_blocker_code_unrecognised");
  }

  /*
    D079 correction 2: the code and the boolean derive from the same effective code.
    An eligible action carrying a withholding code is a contradiction, not a nuance,
    and it is refused rather than resolved in either direction.
  */
  if (eligible === true && blockerCode !== null) {
    blockers.push("profile_eligible_action_carries_blocker_code");
  }
  if (eligible === false && blockerCode === null) {
    // Absence of a code is unknown, never eligible — retained as review-only.
    blockers.push("profile_withholding_code_unknown");
  }

  const anchorRaw = eligibility.anchor;
  const anchor =
    anchorRaw !== null && typeof anchorRaw === "object" && !Array.isArray(anchorRaw)
      ? (anchorRaw as Record<string, unknown>)
      : null;

  /*
    SCOPE IDENTITY IS REQUIRED, not assumed. r1 validated the engine and
    fingerprint fields but copied `businessId` and `providerAccountId` through
    unchecked, so a blank account could be retained and later serve as if it
    were scoped.
  */
  if (!nonEmpty(scope.businessId)) blockers.push("profile_business_missing");
  if (!nonEmpty(scope.providerAccountId)) blockers.push("profile_provider_account_missing");
  for (const key of ["inputFingerprint", "sourceFingerprint"] as const) {
    if (!nonEmpty(scope[key])) blockers.push(`profile_${key}_missing`);
  }
  // A fingerprint that is not a digest cannot identify anything.
  for (const key of ["inputFingerprint", "sourceFingerprint"] as const) {
    if (nonEmpty(scope[key]) && !/^[0-9a-f]{64}$/.test(scope[key])) {
      blockers.push(`profile_${key}_malformed`);
    }
  }

  /*
    THE SHARED CALENDAR POLICY AT CAPTURE, not only at serve.

    r3 persisted `asOfDate: "2026-02-30"` and a next-day as-of, then rejected
    them at read. A serve-time check does not repair a persistence validator that
    admitted impossible or future evidence — it just moves the discovery later.
  */
  const asOf = doc.asOfDate;
  const asOfDay = calendarDayMs(asOf);
  if (asOfDay === null) {
    blockers.push("profile_as_of_malformed");
  } else if (asOfDay > (utcDayMs(scope.cutoffIso) ?? cutoff)) {
    // Day granularity: the cutoff's own day is admissible, a later day is not.
    blockers.push("profile_as_of_after_cutoff");
  }

  const effective = instantMs(scope.effectiveAt);
  const recorded = instantMs(scope.recordedAt);
  if (effective === null) blockers.push("profile_effective_at_malformed");
  if (recorded === null) blockers.push("profile_recorded_at_malformed");
  if (effective !== null && effective >= cutoff) blockers.push("profile_effective_after_cutoff");
  if (recorded !== null && recorded >= cutoff) blockers.push("profile_recorded_after_cutoff");

  if (blockers.length > 0) return refuse(blockers);

  const spendUnit = typeof doc.spendUnit === "number" && Number.isFinite(doc.spendUnit)
    ? doc.spendUnit
    : null;

  return keep({
    contract: D086_RETENTION_CONTRACT,
    businessId: scope.businessId,
    providerAccountId: scope.providerAccountId,
    action,
    // Stamped from the compiled sources, never from the caller.
    profileContract: D086_PROFILE_IDENTITY.profileContract,
    engineEpoch: D086_PROFILE_IDENTITY.engineEpoch,
    engineVersion: D086_PROFILE_IDENTITY.engineVersion,
    inputFingerprint: scope.inputFingerprint,
    sourceFingerprint: scope.sourceFingerprint,
    eligible: eligible as boolean,
    blockerCode,
    anchorSource: typeof anchor?.source === "string" ? anchor.source : null,
    anchorConfidence: typeof anchor?.confidence === "string" ? anchor.confidence : null,
    spendUnit,
    commercialAnchorProvenance:
      typeof anchor?.provenance === "string" ? anchor.provenance : null,
    asOfDate: asOf as string,
    effectiveAt: scope.effectiveAt,
    recordedAt: scope.recordedAt,
  });
}

/**
 * Classify a RETAINED profile row at serve time.
 *
 * "A missing, stale, mismatched, or unverifiable retained profile is review-only."
 * Review-only is the safe state and the default: only an exact epoch/version/
 * fingerprint match inside the freshness window is usable.
 */
export type RetainedProfileVerdict =
  | { usable: true; reason: null }
  | { usable: false; reason: string };

/**
 * The EXPECTED profile identity, from the decision this action came from.
 *
 * `classifyRetainedProfile` compares a retained verdict against an external
 * expectation and returns `profile_identity_agreement_unavailable` without
 * one — which is the honest answer, and which C2 hid by passing `null` through
 * a `never` cast that also dropped `nowIso` and `maxAgeMs` entirely, so the
 * verdict was `retained_profile_max_age_invalid` on every account.
 *
 * The expectation travels with the engine decision (and, on the queue, with the
 * row's `evidence_ref`, which the producer writes from that same decision). It
 * can only ever cause a REFUSAL: a wrong or absent digest fails the comparison,
 * and a matching one still requires the retained row's own `eligible` to be
 * true.
 */
export function expectedProfileIdentity(
  evidence: unknown,
): { inputFingerprint: string | null; sourceFingerprint: string | null } {
  const map = evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence as Record<string, unknown> : null;
  const digest = (key: string): string | null => {
    const value = map?.[key];
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value.trim())
      ? value.trim() : null;
  };
  return {
    inputFingerprint: digest("profileInputFingerprint"),
    sourceFingerprint: digest("profileSourceFingerprint"),
  };
}

export function classifyRetainedProfile(
  retained: unknown,
  expected: {
    /**
     * The EXTERNAL identity the caller holds. Both fingerprints are required
     * for `usable: true`.
     *
     * r2 let a caller pass `null` to mean "no expectation" and then returned
     * usable anyway, so an arbitrary engine version and arbitrary well-formed
     * digests were served as a verified verdict. Missing agreement is
     * UNVERIFIABLE, and unverifiable is review-only. A caller that holds no
     * expectation passes `null` and receives
     * `profile_identity_agreement_unavailable` — form-valid is evidence, never
     * readiness.
     */
    inputFingerprint: string | null;
    sourceFingerprint: string | null;
    nowIso: string;
    maxAgeMs: number;
  },
): RetainedProfileVerdict {
  // TOTAL: a hostile or legacy runtime value is review-only, never a throw.
  const observation = safeSnapshot(retained, "retainedProfile");
  if (!observation.ok) return { usable: false, reason: "retained_profile_unobservable" };
  const value = observation.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { usable: false, reason: "retained_profile_missing" };
  }
  const row = value as Record<string, unknown>;

  if (typeof expected?.maxAgeMs !== "number" || !Number.isFinite(expected.maxAgeMs) || expected.maxAgeMs <= 0) {
    return { usable: false, reason: "retained_profile_max_age_invalid" };
  }
  if (row.contract !== D086_RETENTION_CONTRACT) {
    return {
      usable: false,
      reason: D086_SUPERSEDED_RETENTION_CONTRACTS.includes(row.contract as string)
        ? "retained_profile_contract_superseded"
        : "retained_profile_contract_unknown",
    };
  }
  // The CANONICAL profile contract and compiled engine identity, exactly.
  if (row.profileContract !== ACCOUNT_DECISION_PROFILE_CONTRACT) {
    return { usable: false, reason: "retained_profile_profile_contract_mismatch" };
  }
  if (row.engineEpoch !== ENGINE_VERSION) {
    return { usable: false, reason: "retained_profile_epoch_mismatch" };
  }
  if (row.engineVersion !== ENGINE_VERSION) {
    return { usable: false, reason: "retained_profile_engine_version_mismatch" };
  }

  // The action must be one of exactly three, read literally.
  if (!(D086_PROFILE_ACTIONS as readonly unknown[]).includes(row.action)) {
    return { usable: false, reason: "retained_profile_action_unknown" };
  }

  /*
    FORM, then AGREEMENT. Without an external expectation the row is evidence,
    not readiness — and that is a stable, named outcome rather than a silent yes.
  */
  for (const [field, label] of [
    ["inputFingerprint", "input"], ["sourceFingerprint", "source"],
  ] as const) {
    const stored = row[field];
    if (typeof stored !== "string" || !/^[0-9a-f]{64}$/.test(stored)) {
      return { usable: false, reason: `retained_profile_${label}_malformed` };
    }
    const want = expected[field];
    if (want === null || want === undefined) {
      return { usable: false, reason: "profile_identity_agreement_unavailable" };
    }
    if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) {
      return { usable: false, reason: "profile_identity_agreement_unavailable" };
    }
    if (stored !== want) return { usable: false, reason: `retained_profile_${label}_mismatch` };
  }

  // Clocks, all of them, strict — and an as-of that is a real calendar day.
  const now = instantMs(expected.nowIso);
  if (now === null) return { usable: false, reason: "retained_profile_clock_unverifiable" };
  const recorded = instantMs(row.recordedAt);
  const effective = instantMs(row.effectiveAt);
  if (recorded === null) return { usable: false, reason: "retained_profile_recorded_malformed" };
  if (effective === null) return { usable: false, reason: "retained_profile_effective_malformed" };
  if (recorded > now) return { usable: false, reason: "retained_profile_recorded_in_future" };
  if (effective > now) return { usable: false, reason: "retained_profile_effective_in_future" };
  const asOfDay = calendarDayMs(row.asOfDate);
  if (asOfDay === null) return { usable: false, reason: "retained_profile_as_of_malformed" };
  // Day granularity: the current day is allowed; a later day is not.
  if (asOfDay > (utcDayMs(expected.nowIso) ?? now)) {
    return { usable: false, reason: "retained_profile_as_of_in_future" };
  }
  if (now - recorded > expected.maxAgeMs) return { usable: false, reason: "retained_profile_stale" };

  /*
    D079 correction 2 at serve time: the boolean and its code must agree, and
    the boolean is read LITERALLY. r2 coerced with `=== true`, so a malformed
    value became `false` and, paired with a code, looked like a valid
    withholding.
  */
  const eligible = row.eligible;
  const code = row.blockerCode;
  if (eligible !== true && eligible !== false) {
    return { usable: false, reason: "retained_profile_eligibility_not_boolean" };
  }
  if (eligible === true && code !== null) return { usable: false, reason: "retained_profile_code_contradiction" };
  if (eligible === false && (typeof code !== "string" || code.length === 0)) {
    return { usable: false, reason: "retained_profile_code_missing" };
  }
  if (eligible === false && !(D086_CANONICAL_BLOCKER_CODES as readonly string[]).includes(code as string)) {
    return { usable: false, reason: "retained_profile_code_unrecognised" };
  }
  return { usable: true, reason: null };
}

// ---------------------------------------------------------------------------
// C — automatic role-authority retention
// ---------------------------------------------------------------------------

export interface RoleAuthorityRecord {
  contract: typeof D086_RETENTION_CONTRACT;
  businessId: string;
  providerAccountId: string;
  campaignId: string;
  asOfDate: string;
  inferredKind: string;
  kindSource: string;
  resolverVersion: string;
  confidenceClass: string;
  evidenceHash: string;
  inputHash: string;
  effectiveAt: string;
  recordedAt: string;
  provenance: string;
}

export interface RoleAuthorityGate {
  /**
   * THE EXPECTED SCOPE, supplied by the AUTHORIZED CALLER.
   *
   * r1 checked only that the row's own provider account was non-empty, which
   * "verified" a row against itself: a well-formed foreign account passed. The
   * expected scope must originate from the route's own resolution — never from
   * the row being judged.
   */
  expectedScope: {
    businessId: string;
    providerAccountId: string;
    /** Present when the caller has a specific campaign in hand. */
    campaignId?: string;
  };
  /** The resolver version compiled into this build. */
  compiledResolverVersion: string;
  /**
   * The approved version, or `null`. Callers should pass
   * `campaignContextAuthorityResolverVersion()` so route readiness and runtime
   * authority cannot drift; the value is a parameter so a replay stays pure.
   */
  approvedResolverVersion: string | null;
  cutoffIso: string;
}

export type RoleAuthorityVerdict = {
  /** Only an exact system_inferred + high + approved-version + fresh-scope row. */
  qualified: boolean;
  /** Everything that fails is still VISIBLE — as review-only, never hidden. */
  disposition: "authority" | "review_only";
  blockers: readonly string[];
};

/** Where a role row may legitimately have come from. Not free text. */
export const D086_ROLE_PROVENANCE_SOURCES: readonly string[] = Object.freeze([
  "engine_v3_campaign_role_authority",
]);

const ROLE_ROW_KEYS = [
  "contract",
  "businessId",
  "providerAccountId",
  "campaignId",
  "asOfDate",
  "inferredKind",
  "kindSource",
  "resolverVersion",
  "confidenceClass",
  "evidenceHash",
  "inputHash",
  "effectiveAt",
  "recordedAt",
  "provenance",
] as const;

/**
 * Decide whether one retained role row may carry runtime authority.
 *
 * NAME-NEUTRAL BY CONSTRUCTION. The admitted key set has no campaign-name member, so a
 * campaign name cannot reach this function even as an argument — the observation is
 * refused before any predicate runs if one is supplied. There is no manual label, no
 * override, no queue and no name fallback: a row that does not qualify is review-only
 * and stays visible.
 */
export function qualifyRoleAuthorityRow(
  input: unknown,
  gate: RoleAuthorityGate,
): RoleAuthorityVerdict {
  const observation = safeSnapshot(input, "roleRow");
  if (!observation.ok) {
    return {
      qualified: false,
      disposition: "review_only",
      blockers: Object.freeze([`role_row_unobservable:${renderProblems(observation.problems)}`]),
    };
  }
  const cutoff = instantMs(gate.cutoffIso);
  if (cutoff === null) {
    return { qualified: false, disposition: "review_only", blockers: Object.freeze(["role_cutoff_invalid"]) };
  }

  const problems: SchemaProblem[] = [];
  const row = exactMap(observation.value, "roleRow", ROLE_ROW_KEYS, [], problems);
  if (!row) {
    return {
      qualified: false,
      disposition: "review_only",
      blockers: Object.freeze(
        ["role_row_schema_exact_mismatch", ...problems.map((p) => p.why)].sort(),
      ),
    };
  }

  const blockers: string[] = [];

  /*
    THE RETAINED CONTRACT FIRST.

    r2 qualified a row that carried no D086 contract at all. A row that does not
    say which capture semantics produced it cannot be canonical authority, and a
    row stamped with a superseded identity is history, not authority.
  */
  if (row.contract === undefined || row.contract === null || row.contract === "") {
    blockers.push("role_contract_absent");
  } else if (D086_SUPERSEDED_RETENTION_CONTRACTS.includes(row.contract as string)) {
    blockers.push("role_contract_superseded");
  } else if (row.contract !== D086_RETENTION_CONTRACT) {
    blockers.push("role_contract_unknown");
  }

  /*
    PRESENCE, then AGREEMENT WITH THE EXPECTED SCOPE.

    Account scope is the invariant the retained population fails today: every
    retained row carries a NULL provider account, and a row that cannot prove its
    provider-account scope can never be updated into runtime authority. Presence
    alone is not proof — a non-empty FOREIGN account must fail too, which is why
    the expected scope is compared and never derived from this row.
  */
  const expected = gate.expectedScope;
  if (!nonEmpty(expected?.businessId) || !nonEmpty(expected?.providerAccountId)) {
    blockers.push("role_expected_scope_unresolved");
  }
  if (!nonEmpty(row.businessId)) blockers.push("role_business_missing");
  else if (nonEmpty(expected?.businessId) && row.businessId !== expected.businessId) {
    blockers.push("role_business_scope_mismatch");
  }
  if (!nonEmpty(row.providerAccountId)) blockers.push("role_provider_account_scope_missing");
  else if (nonEmpty(expected?.providerAccountId) && row.providerAccountId !== expected.providerAccountId) {
    blockers.push("role_provider_account_scope_mismatch");
  }
  if (!nonEmpty(row.campaignId)) blockers.push("role_campaign_missing");
  else if (nonEmpty(expected?.campaignId) && row.campaignId !== expected.campaignId) {
    blockers.push("role_campaign_scope_mismatch");
  }

  // EXACT system inference. No other source is authority-bearing, ever.
  if (row.kindSource !== "system_inferred") blockers.push("role_kind_source_not_system_inferred");
  // EXACT high confidence.
  if (row.confidenceClass !== "high") blockers.push("role_confidence_not_high");

  // EXACT approved compiled version. An unset gate is not an approval.
  if (!nonEmpty(row.resolverVersion)) {
    blockers.push("role_resolver_version_missing");
  } else if (row.resolverVersion !== gate.compiledResolverVersion) {
    blockers.push("role_resolver_version_not_compiled");
  } else if (gate.approvedResolverVersion === null) {
    blockers.push("role_resolver_authority_gate_unset");
  } else if (gate.approvedResolverVersion !== gate.compiledResolverVersion) {
    blockers.push("role_resolver_authority_gate_mismatch");
  }

  /*
    STRICT 64-lowerhex hashes. r2 accepted "x" and "y" as an evidence hash and
    an input hash, so a row that recorded nothing reproducible qualified.
  */
  for (const [key, label] of [["evidenceHash", "evidence"], ["inputHash", "input"]] as const) {
    const value = row[key];
    if (!nonEmpty(value)) blockers.push(`role_${label}_hash_missing`);
    else if (!/^[0-9a-f]{64}$/.test(value as string)) blockers.push(`role_${label}_hash_malformed`);
  }

  /*
    The kind must be one the automatic resolver can actually produce. r2
    qualified `inferredKind: "banana"`. The allowlist is the canonical
    `META_CAMPAIGN_KINDS`, not a second list maintained here — and it is a
    NAME-NEUTRAL check on the resolver's own output, not on any label.
  */
  if (!nonEmpty(row.inferredKind)) blockers.push("role_inferred_kind_missing");
  else if (!(META_CAMPAIGN_KINDS as readonly string[]).includes(row.inferredKind as string)) {
    blockers.push("role_inferred_kind_unknown");
  }

  // Provenance names a real source, not arbitrary prose.
  if (!nonEmpty(row.provenance)) blockers.push("role_provenance_missing");
  else if (!D086_ROLE_PROVENANCE_SOURCES.includes(row.provenance as string)) {
    blockers.push("role_provenance_unrecognised");
  }

  /*
    FRESHNESS FROM THE CANONICAL RUNTIME SOURCE.

    r1 hard-coded three days while `CAMPAIGN_CONTEXT_MAX_AGE_DAYS` is two — a
    second authority rule, drifting from the first. And `asOfDate` is DATE-ONLY:
    the shared PIT policy compares such a value day-to-day, so the cutoff's own
    day is admissible. Correction 1 over-generalised at-or-after equality to it.
  */
  const cutoffDay = utcDayMs(gate.cutoffIso);
  const asOfDay = calendarDayMs(row.asOfDate);
  if (asOfDay === null) {
    blockers.push("role_as_of_malformed");
  } else if (cutoffDay === null) {
    blockers.push("role_cutoff_invalid");
  } else if (asOfDay > cutoffDay) {
    blockers.push("role_as_of_after_cutoff");
  } else if (cutoffDay - asOfDay > CAMPAIGN_CONTEXT_MAX_AGE_DAYS * 86_400_000) {
    blockers.push("role_as_of_stale");
  }

  // Instants stay instants: at or after the cutoff is refused.
  const effective = instantMs(row.effectiveAt);
  const recorded = instantMs(row.recordedAt);
  if (effective === null) blockers.push("role_effective_at_malformed");
  else if (effective >= cutoff) blockers.push("role_effective_after_cutoff");
  if (recorded === null) blockers.push("role_recorded_at_malformed");
  else if (recorded >= cutoff) blockers.push("role_recorded_after_cutoff");

  const qualified = blockers.length === 0;
  return {
    qualified,
    disposition: qualified ? "authority" : "review_only",
    blockers: Object.freeze([...new Set(blockers)].sort()),
  };
}

// ---------------------------------------------------------------------------
// Additive migrations — PREPARED, NOT APPLIED
// ---------------------------------------------------------------------------

/**
 * The additive DDL that would let the three contracts above be persisted.
 *
 * PREPARED AND DELIBERATELY UNWIRED. These statements are exported constants and
 * nothing in this slice executes them: they are not registered in
 * `lib/migrations.ts`, so no deploy applies them either. Wiring them is the first
 * step of the separately reconciled deploy slice, which is also where the growth
 * fence must be cleared — the tables below cannot accrue a single row while
 * `meta_entity_state_history` sits over its ceiling and admission is refused.
 *
 * Every statement is additive and idempotent:
 *  - `ADD COLUMN IF NOT EXISTS` on the two existing config-history tables, so every
 *    legacy reader keeps working unchanged and every existing row keeps its meaning.
 *    A legacy row simply has NULL in the new columns, which the contract reads as
 *    "unit not captured" — the honest state — rather than as a default exponent.
 *  - `CREATE TABLE IF NOT EXISTS` for the two facts that have no home at all today.
 *
 * READ COMPATIBILITY PLAN. Existing readers select named columns and are unaffected
 * by added ones. The new columns are nullable with no default: nothing backfills a
 * unit onto a historical value, because the unit was not observed and inventing one
 * is the defect this closes. A reader that wants an authoritative value must call
 * {@link validateCanonicalBudgetFact}, which refuses a row whose currency cannot be
 * resolved — so an un-backfilled legacy row stays unavailable instead of becoming
 * silently wrong.
 */
export const D086_ADDITIVE_MIGRATION_SQL: readonly string[] = Object.freeze([
  `ALTER TABLE meta_campaign_config_history
     ADD COLUMN IF NOT EXISTS budget_fact_contract            TEXT,
     ADD COLUMN IF NOT EXISTS budget_field                    TEXT,
     ADD COLUMN IF NOT EXISTS budget_source_currency          TEXT,
     ADD COLUMN IF NOT EXISTS budget_currency_exponent        SMALLINT,
     ADD COLUMN IF NOT EXISTS budget_currency_registry        TEXT,
     ADD COLUMN IF NOT EXISTS budget_currency_registry_version TEXT,
     ADD COLUMN IF NOT EXISTS budget_raw_minor_units          BIGINT,
     ADD COLUMN IF NOT EXISTS budget_owner_mode               TEXT,
     ADD COLUMN IF NOT EXISTS budget_schedule_state           TEXT,
     ADD COLUMN IF NOT EXISTS provider_api_version            TEXT,
     ADD COLUMN IF NOT EXISTS source_run_id                   TEXT,
     ADD COLUMN IF NOT EXISTS effective_at                    TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS recorded_at                     TIMESTAMPTZ`,

  `ALTER TABLE meta_adset_config_history
     ADD COLUMN IF NOT EXISTS budget_fact_contract            TEXT,
     ADD COLUMN IF NOT EXISTS budget_field                    TEXT,
     ADD COLUMN IF NOT EXISTS budget_source_currency          TEXT,
     ADD COLUMN IF NOT EXISTS budget_currency_exponent        SMALLINT,
     ADD COLUMN IF NOT EXISTS budget_currency_registry        TEXT,
     ADD COLUMN IF NOT EXISTS budget_currency_registry_version TEXT,
     ADD COLUMN IF NOT EXISTS budget_raw_minor_units          BIGINT,
     ADD COLUMN IF NOT EXISTS budget_owner_mode               TEXT,
     ADD COLUMN IF NOT EXISTS budget_schedule_state           TEXT,
     ADD COLUMN IF NOT EXISTS provider_api_version            TEXT,
     ADD COLUMN IF NOT EXISTS source_run_id                   TEXT,
     ADD COLUMN IF NOT EXISTS effective_at                    TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS recorded_at                     TIMESTAMPTZ`,

  `CREATE TABLE IF NOT EXISTS engine_v3_account_profile_output (
     id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     contract              TEXT        NOT NULL,
     -- The canonical profile contract the verdict came from. r3's query and
     -- classifier both required this column and the DDL never created it, so
     -- the statement failed SQLSTATE 42703 against a real cluster.
     profile_contract      TEXT        NOT NULL,
     business_id           TEXT        NOT NULL,
     provider_account_id   TEXT        NOT NULL,
     action                TEXT        NOT NULL CHECK (action IN ('scale','cut','refresh')),
     engine_epoch          TEXT        NOT NULL,
     engine_version        TEXT        NOT NULL,
     input_fingerprint     TEXT        NOT NULL,
     source_fingerprint    TEXT        NOT NULL,
     eligible              BOOLEAN     NOT NULL,
     blocker_code          TEXT,
     anchor_source         TEXT,
     anchor_confidence     TEXT,
     spend_unit            DOUBLE PRECISION,
     commercial_anchor_provenance TEXT,
     as_of_date            DATE        NOT NULL,
     effective_at          TIMESTAMPTZ NOT NULL,
     recorded_at           TIMESTAMPTZ NOT NULL,
     created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
     -- r1's identity omitted engine_version and source_fingerprint, so two
     -- genuinely different verdicts collapsed onto one row and the later write
     -- would have silently lost or conflicted with the earlier one.
     UNIQUE (business_id, provider_account_id, action, engine_epoch, engine_version,
             input_fingerprint, source_fingerprint, as_of_date),
     CHECK ((eligible AND blocker_code IS NULL) OR (NOT eligible AND blocker_code IS NOT NULL))
   )`,

  // Latest-per-identity is the ACCESS PATH readiness actually uses.
  // The FULL rank clocks, in the order the query ranks by. r4's indexes stopped
  // at the first clock, so the tie-break the query actually performs was unindexed.
  `CREATE INDEX IF NOT EXISTS idx_engine_v3_account_profile_output_latest
     ON engine_v3_account_profile_output
        (business_id, provider_account_id, action, recorded_at DESC, effective_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_meta_campaign_config_history_latest_budget
     ON meta_campaign_config_history
        (business_id, provider_account_id, campaign_id, captured_at DESC, recorded_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_meta_adset_config_history_latest_budget
     ON meta_adset_config_history
        (business_id, provider_account_id, adset_id, captured_at DESC, recorded_at DESC)`,

  `CREATE TABLE IF NOT EXISTS engine_v3_campaign_role_authority (
     id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     contract            TEXT        NOT NULL,
     business_id         TEXT        NOT NULL,
     provider_account_id TEXT        NOT NULL,
     campaign_id         TEXT        NOT NULL,
     as_of_date          DATE        NOT NULL,
     inferred_kind       TEXT        NOT NULL,
     kind_source         TEXT        NOT NULL,
     resolver_version    TEXT        NOT NULL,
     confidence_class    TEXT        NOT NULL,
     evidence_hash       TEXT        NOT NULL,
     input_hash          TEXT        NOT NULL,
     effective_at        TIMESTAMPTZ NOT NULL,
     recorded_at         TIMESTAMPTZ NOT NULL,
     provenance          TEXT        NOT NULL,
     created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (business_id, provider_account_id, campaign_id, as_of_date, resolver_version),
     CHECK (provider_account_id <> ''),
     CHECK (contract <> '')
   )`,

  /*
    THE CAPTURE RECEIPT — append-only, one row per capture OCCURRENCE.

    r7 put a single `sync_cohort_id` on the observation run. That is provably
    wrong: `persistMetaEntityObservation` coalesces identical semantic truth and
    advances a heartbeat on an existing run instead of appending one, so one run
    is the content of MANY captures and cannot carry one cohort.

    The receipt separates occurrence from content. `partition_id` is the core
    sync's own partition UUID — the cohort — so campaign and ad-set captures
    belong to one sync because they name the same partition, never because their
    clocks are close. Failed and partial attempts get receipts too, which is what
    makes a newer failure able to block an older success.

    This is registered in lib/migrations.ts (the local registry) and is additive
    and IF NOT EXISTS throughout. It is NOT applied to production here.
  */
  `CREATE TABLE IF NOT EXISTS meta_entity_observation_receipts (
     id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     receipt_contract     TEXT NOT NULL
                          DEFAULT 'd086.observation-capture-receipt.v1'
                          CHECK (length(btrim(receipt_contract)) > 0),
     run_id               UUID NOT NULL
                          REFERENCES meta_entity_observation_runs(id) ON DELETE RESTRICT,
     business_id          TEXT NOT NULL CHECK (length(btrim(business_id)) > 0),
     provider_account_id  TEXT NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
     entity_type          TEXT NOT NULL
                          CHECK (entity_type IN ('campaign', 'adset', 'ad', 'creative')),
     endpoint             TEXT NOT NULL CHECK (length(btrim(endpoint)) > 0),
     partition_id         UUID NOT NULL,
     source_snapshot_id   TEXT,
     capture_status       TEXT NOT NULL
                          CHECK (capture_status IN
                            ('complete', 'partial', 'point_lookup', 'failed')),
     provider_row_count   INTEGER NOT NULL CHECK (provider_row_count >= 0),
     page_count           INTEGER NOT NULL CHECK (page_count >= 0),
     run_reused           BOOLEAN NOT NULL,
     observed_at          TIMESTAMPTZ NOT NULL,
     captured_at          TIMESTAMPTZ NOT NULL,
     error_json           JSONB
                          CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
     created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
     CONSTRAINT meta_entity_observation_receipts_time_check
       CHECK (observed_at <= captured_at)
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS meta_entity_observation_receipts_occurrence
     ON meta_entity_observation_receipts
        (partition_id, entity_type, endpoint, captured_at)`,

  `CREATE INDEX IF NOT EXISTS idx_meta_entity_observation_receipts_cohort
     ON meta_entity_observation_receipts
        (business_id, provider_account_id, partition_id, entity_type, endpoint,
         captured_at DESC, id DESC)`,

  // The FRESHNESS path. Status is deliberately not in the leading key: the
  // newest attempt must be found whatever its outcome, or an older complete
  // capture silently wins over a newer failure.
  `CREATE INDEX IF NOT EXISTS idx_meta_entity_observation_receipts_freshness
     ON meta_entity_observation_receipts
        (business_id, provider_account_id, entity_type, endpoint,
         captured_at DESC, id DESC)`,

  /*
    THE RANK PATH, as EXPRESSIONS.

    r7 indexed the plain captured_at while the query ranks on heartbeat-effective
    clocks, so the "all full rank" claim was false — no index could serve that
    order. These are the exact expressions the query writes.
  */
  /*
    THE RANK PATH, on IMMUTABLE clocks.

    r8 indexed heartbeat-effective expressions because the run join filtered on
    them. C8 removed that filter: a coalesced run whose heartbeat advanced AFTER
    a historical cutoff must not make the earlier occurrence unreadable. The
    payload clocks cannot move, so they are what the cutoff and this index use.
  */
  `CREATE INDEX IF NOT EXISTS idx_meta_entity_observation_runs_d086_payload
     ON meta_entity_observation_runs
        (business_id, provider_account_id, entity_type, endpoint,
         captured_at DESC, observed_at DESC, id DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_meta_entity_state_history_d086_latest
     ON meta_entity_state_history
        (business_id, provider_account_id, entity_type, entity_id,
         captured_at DESC, created_at DESC, id DESC)`,

  /*
    THE COHORT'S LINKAGE, enforced by the database.

    r8's `partition_id` was a bare UUID with no reference and its
    `source_snapshot_id` was arbitrary TEXT, so a fabricated or foreign cohort
    attested as a real one. The foreign keys are added NOT VALID so the
    statement is safe on a table that may already hold malformed rows; those
    rows then fail CLOSED on the read side with their own causal blocker rather
    than blocking the migration.
  */
  `ALTER TABLE meta_entity_observation_receipts
     ADD COLUMN IF NOT EXISTS source_snapshot_ref_id UUID`,

  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'meta_entity_observation_receipts_partition_fk'
     ) THEN
       ALTER TABLE meta_entity_observation_receipts
         ADD CONSTRAINT meta_entity_observation_receipts_partition_fk
         FOREIGN KEY (partition_id) REFERENCES meta_sync_partitions(id)
         ON DELETE RESTRICT NOT VALID;
     END IF;
   END $$`,

  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'meta_entity_observation_receipts_snapshot_fk'
     ) THEN
       ALTER TABLE meta_entity_observation_receipts
         ADD CONSTRAINT meta_entity_observation_receipts_snapshot_fk
         FOREIGN KEY (source_snapshot_ref_id) REFERENCES meta_raw_snapshots(id)
         ON DELETE RESTRICT NOT VALID;
     END IF;
   END $$`,

  `CREATE INDEX IF NOT EXISTS idx_meta_entity_tombstones_d086_latest
     ON meta_entity_tombstones
        (business_id, provider_account_id, entity_type, entity_id,
         captured_at DESC, id DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_engine_v3_campaign_role_authority_latest
     ON engine_v3_campaign_role_authority
        (business_id, provider_account_id, campaign_id, as_of_date DESC, recorded_at DESC)`,
]);

/**
 * Which of the prepared migrations a database has. Read-only introspection; it is
 * how the readiness surface reports capture capability without ever asserting a
 * deployment claim it cannot see.
 */
export interface RetentionSchemaCapability {
  budgetFactColumnsPresent: boolean;
  profileOutputTablePresent: boolean;
  roleAuthorityTablePresent: boolean;
  detail: string;
}

/**
 * The exact column set the canonical budget fact needs. r1 probed one column on
 * one table, so a half-applied migration or an ad-set table left behind would
 * have reported the capture capability as present.
 */
export const D086_REQUIRED_BUDGET_COLUMNS: readonly string[] = Object.freeze([
  // The retained fact must carry its OWN contract, or a reader cannot tell which
  // capture semantics produced it. r2 had no such column at all.
  "budget_fact_contract",
  "budget_field",
  "budget_source_currency",
  "budget_currency_exponent",
  "budget_currency_registry",
  "budget_currency_registry_version",
  "budget_raw_minor_units",
  "budget_owner_mode",
  "budget_schedule_state",
  "provider_api_version",
  "source_run_id",
  "effective_at",
  "recorded_at",
]);

/** The columns the profile seam must actually have, not just the table. */
export const D086_REQUIRED_PROFILE_COLUMNS: readonly string[] = Object.freeze([
  "contract", "profile_contract", "business_id", "provider_account_id", "action",
  "engine_epoch", "engine_version", "input_fingerprint", "source_fingerprint",
  "eligible", "blocker_code", "as_of_date", "effective_at", "recorded_at",
]);

/** The columns the role seam must actually have. */
/** The manifest columns the attestation reads. Absence is a capability failure. */
export const D086_REQUIRED_RUN_COLUMNS: readonly string[] = Object.freeze([
  "id", "business_id", "provider_account_id", "entity_type", "endpoint",
  "completeness", "row_count", "source_snapshot_id", "error_json",
  "observed_at", "captured_at", "created_at",
  // The heartbeat clocks and the manifest kind. The query ranks and
  // reconstructs on these; r7 listed a cohort column instead and never probed
  // the set at all.
  "last_seen_at", "last_captured_at", "manifest_kind",
]);

/** The append-only receipt columns. The cohort and the freshness both live here. */
export const D086_REQUIRED_RECEIPT_COLUMNS: readonly string[] = Object.freeze([
  "id", "receipt_contract", "run_id", "business_id", "provider_account_id",
  "entity_type", "endpoint", "partition_id", "source_snapshot_id",
  "capture_status", "provider_row_count", "page_count", "run_reused",
  "observed_at", "captured_at", "error_json", "created_at",
  // C8: TYPED linkage to the raw snapshot. `source_snapshot_id` is TEXT because
  // it mirrors the run column; a free string can name anything, so the receipt
  // additionally carries a UUID reference the database itself enforces.
  "source_snapshot_ref_id",
]);

/** The state columns membership reconstruction reads. */
export const D086_REQUIRED_STATE_COLUMNS: readonly string[] = Object.freeze([
  "id", "run_id", "business_id", "provider_account_id", "entity_type",
  "entity_id", "presence", "run_completeness", "observed_at", "captured_at",
  "created_at", "campaign_id", "budget_origin", "campaign_daily_budget_raw",
  "campaign_lifetime_budget_raw", "adset_daily_budget_raw",
  "adset_lifetime_budget_raw", "budget_currency", "configured_status",
  "effective_status", "provider_updated_at", "field_coverage_json",
  /*
    C8: every D083 field the executed statement actually selects. r8's list
    stopped at the columns the FIRST draft read, so a database missing the
    exponent, the registry version, the captured shape, the schedules, the
    provider API version or the state hash passed the capability probe and then
    failed the real query as a generic driver error.
  */
  "budget_currency_exponent", "budget_currency_registry_version",
  "budget_shape_support", "campaign_start_time", "campaign_end_time",
  "adset_start_time", "adset_end_time", "provider_api_version", "state_hash",
]);

/** The partition seam a capture receipt's cohort must resolve against. */
export const D086_REQUIRED_PARTITION_COLUMNS: readonly string[] = Object.freeze([
  "id", "business_id", "provider_account_id", "lane", "scope", "partition_date",
  "status",
]);

/** The raw-observation seam a capture receipt's snapshot must resolve against. */
export const D086_REQUIRED_RAW_OBSERVATION_COLUMNS: readonly string[] = Object.freeze([
  "id", "snapshot_id", "business_id", "provider_account_id", "partition_id",
  "endpoint_name", "entity_scope", "status", "observed_at",
]);

/**
 * The lane and scopes a CURRENT-INVENTORY capture belongs to.
 *
 * A receipt whose partition is an extended-lane breakdown job, or a core-lane
 * partition for another account, describes a different sync entirely; it must
 * never be read as this account's budget cohort.
 */
export const D086_COHORT_LANE = "core" as const;
export const D086_COHORT_SCOPES: readonly string[] =
  Object.freeze([...META_CORE_PARTITION_SCOPES]);

/** The tombstone columns membership exclusion reads. */
export const D086_REQUIRED_TOMBSTONE_COLUMNS: readonly string[] = Object.freeze([
  "id", "business_id", "provider_account_id", "entity_type", "entity_id",
  "reason", "observed_at", "captured_at", "created_at",
]);

/**
 * The indexes the readiness access paths depend on, with the EXACT fragments
 * their definitions must contain.
 *
 * r7's catalog gate checked plain clock columns while the query ordered by
 * heartbeat-effective expressions, so it validated an index that could not
 * serve the read it claimed to serve.
 */
export const D086_REQUIRED_INDEXES: readonly {
  indexName: string;
  mustContain: readonly string[];
}[] = Object.freeze([
  /*
    C8: the heartbeat-effective expression index is GONE with the predicate it
    served. The run join now uses IMMUTABLE payload clocks, because a heartbeat
    advanced after a historical cutoff must not erase evidence that existed at
    it — so an index on the mutable expressions proved nothing the query does.
  */
  {
    indexName: "idx_meta_entity_observation_runs_d086_payload",
    mustContain: Object.freeze([
      "business_id", "provider_account_id", "entity_type", "endpoint",
      "captured_at DESC", "observed_at DESC", "id DESC",
    ]),
  },
  /*
    The state latest path. r8 ranked and filtered on these columns with no
    catalog-validated index at all, so the "access path" claim covered every
    read except the one that reads the most rows.
  */
  {
    indexName: "idx_meta_entity_state_history_d086_latest",
    mustContain: Object.freeze([
      "business_id", "provider_account_id", "entity_type", "entity_id",
      "captured_at DESC", "created_at DESC", "id DESC",
    ]),
  },
  {
    indexName: "meta_entity_observation_receipts_occurrence",
    mustContain: Object.freeze([
      "UNIQUE", "partition_id", "entity_type", "endpoint", "captured_at",
    ]),
  },
  {
    indexName: "idx_meta_entity_observation_receipts_cohort",
    mustContain: Object.freeze([
      "partition_id", "entity_type", "endpoint", "captured_at DESC", "id DESC",
    ]),
  },
  {
    indexName: "idx_meta_entity_observation_receipts_freshness",
    mustContain: Object.freeze([
      "business_id", "provider_account_id", "entity_type", "endpoint",
      "captured_at DESC", "id DESC",
    ]),
  },
  {
    indexName: "idx_meta_entity_tombstones_d086_latest",
    mustContain: Object.freeze([
      "entity_type", "entity_id", "captured_at DESC", "id DESC",
    ]),
  },
]);

/** The exact endpoints that carry budget configuration, per grain. */
export const D086_BUDGET_ENDPOINTS = Object.freeze({
  campaign: "campaign_configs",
  adset: "adset_configs",
});

export const D086_REQUIRED_ROLE_COLUMNS: readonly string[] = Object.freeze([
  "contract", "business_id", "provider_account_id", "campaign_id", "as_of_date",
  "inferred_kind", "kind_source", "resolver_version", "confidence_class",
  "evidence_hash", "input_hash", "effective_at", "recorded_at", "provenance",
]);

/**
 * Capability is the COMPLETE column set on every seam.
 *
 * r3 asked only whether the profile and role TABLES existed, so a table missing
 * a column the query selects reported as capable — and the query then failed at
 * runtime instead of the dimension reporting honestly.
 */
export const D086_CAPABILITY_PROBE_SQL = `
  SELECT
    /*
      C8: the CONFIG-HISTORY seams are gone. Readiness stopped reading them in
      correction 7, but r8 kept probing their columns and then ignored the
      counts — dead capability that could only ever mislead. What is probed here
      is exactly what the executed statements touch.
    */
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='engine_v3_account_profile_output'
        AND column_name = ANY($2::text[]))                    AS profile_columns,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='engine_v3_campaign_role_authority'
        AND column_name = ANY($3::text[]))                    AS role_columns,
    -- The universe prerequisites. r7 probed none of them, so a partially
    -- deployed schema produced a raw driver exception labelled as a generic
    -- read failure instead of a precise, forward-only blocker.
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='meta_entity_observation_runs'
        AND column_name = ANY($4::text[]))                    AS run_columns,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='meta_entity_observation_receipts'
        AND column_name = ANY($5::text[]))                    AS receipt_columns,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='meta_entity_state_history'
        AND column_name = ANY($6::text[]))                    AS state_columns,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='meta_entity_tombstones'
        AND column_name = ANY($7::text[]))                    AS tombstone_columns,
    -- The cohort's own seams: without these a receipt's partition and snapshot
    -- cannot be validated at all, and an orphan cohort would attest.
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='meta_sync_partitions'
        AND column_name = ANY($1::text[]))                    AS partition_columns,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='meta_raw_snapshot_observations'
        AND column_name = ANY($8::text[]))                    AS raw_observation_columns
` as const;

/**
 * The catalog gate for the access paths, checked against the REAL definitions
 * PostgreSQL reports rather than against the names we hoped for.
 */
export const D086_INDEX_CATALOG_SQL = `
  SELECT indexname, indexdef
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname = ANY($1::text[])
` as const;

/** Which required indexes a database actually has, with the reason for each miss. */
export function classifyIndexCatalog(
  rows: readonly { indexname?: unknown; indexdef?: unknown }[],
): { satisfied: boolean; missing: readonly string[]; unusable: readonly string[] } {
  const byName = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.indexname === "string" && typeof row.indexdef === "string") {
      byName.set(row.indexname, row.indexdef);
    }
  }
  const missing: string[] = [];
  const unusable: string[] = [];
  for (const required of D086_REQUIRED_INDEXES) {
    const definition = byName.get(required.indexName);
    if (definition === undefined) {
      missing.push(required.indexName);
      continue;
    }
    // Whitespace in a catalog definition is PostgreSQL's, not ours.
    const flattened = definition.replace(/\s+/g, " ");
    const absent = required.mustContain.filter(
      (fragment) => !flattened.includes(fragment.replace(/\s+/g, " ")),
    );
    if (absent.length > 0) unusable.push(`${required.indexName}:${absent.join("|")}`);
  }
  return {
    satisfied: missing.length === 0 && unusable.length === 0,
    missing: Object.freeze(missing),
    unusable: Object.freeze(unusable),
  };
}
