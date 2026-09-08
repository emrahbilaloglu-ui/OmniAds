/**
 * D083 — the canonical, account-scoped Meta budget fact.
 *
 * This module is the sole consumer boundary between retained Meta observations
 * and any future budget intent. It answers one question: at a stated point in
 * time, for one physical entity, who owns the budget, which field is binding,
 * what is the exact amount, and is that answer usable at all.
 *
 * D083 Correction 1 rebuilt it around four rules, each of which exists because
 * the first version broke it.
 *
 * 1. **Validate, never trust.** Callers pass arrays of observations; this module
 *    checks every one against the requested business, physical provider account,
 *    grain, entity id and declared parent. The first version accepted a parent
 *    from a different business and account, reported the child's state hash
 *    beside the foreign amount, and called it usable.
 * 2. **A hierarchy needs both rows.** An ad-set fact requires a
 *    point-in-time-eligible parent campaign observation, including ABO. The
 *    parent is what proves the money is not somewhere else.
 * 3. **Every value is bound to the row that supplied it.** A campaign-owned
 *    fact takes its amount, currency, exponent, schedule and source provenance
 *    from the campaign row — never from the ad set that merely sits under it.
 * 4. **Every uncertainty is a named outcome.** Ambiguous, none, not observed,
 *    unsupported and unknown are first-class, never coerced into a number and
 *    never silently treated as zero. Absence of a row is not absence of a
 *    budget: only a `complete` run can speak to what an entity did not have.
 */
import {
  ISO_4217_REGISTRY_VERSION,
  resolveMinorUnitExponent,
} from "@/lib/currency/iso-4217-minor-units";
import { providerLocalDayStartInclusive } from "@/lib/meta/provider-local-day";

export const BUDGET_FACT_CONTRACT_VERSION = "meta.budget-fact.v4" as const;

export type BudgetEntityGrain = "campaign" | "adset";

/**
 * Which field actually carries the budget. `ambiguous` is retained as a real
 * outcome even though no retained row has produced it: the provider does not
 * forbid two positive amounts, so the reader may not assume it away.
 */
export type BudgetField = "daily" | "lifetime" | "none" | "ambiguous" | "not_observed";

/** Who owns the money for one hierarchy at one point in time. */
export type BudgetOwnerMode =
  | "campaign_owned"
  | "adset_owned"
  | "ambiguous"
  | "unresolved"
  | "not_observed"
  | "unsupported";

/**
 * Whether the provider's budget shape is one this contract can act on. Nothing
 * in retained history establishes it, so `shape_not_observed` is the honest
 * default rather than an assumption of support.
 */
export type BudgetShapeSupport = "supported" | "unsupported_shape" | "shape_not_observed";

export const BUDGET_FACT_BLOCKERS = [
  // scope
  "scope_business_mismatch",
  "scope_account_mismatch",
  "scope_grain_mismatch",
  "scope_entity_mismatch",
  "parent_identity_mismatch",
  // observation
  "budget_not_observed",
  "observation_not_complete_scope",
  "entity_absent_at_pit",
  "observation_identity_absent",
  "subject_provenance_incomplete",
  "parent_provenance_incomplete",
  "subject_api_version_absent",
  "parent_api_version_absent",
  "subject_status_evidence_absent",
  "parent_status_evidence_absent",
  "subject_clock_not_finite",
  "parent_clock_not_finite",
  "subject_api_version_malformed",
  "parent_api_version_malformed",
  "pit_conflicting_observations",
  // hierarchy
  "parent_campaign_identity_absent",
  "parent_not_observed",
  "parent_not_complete_scope",
  "parent_absent_at_pit",
  "owner_unresolved_hierarchy",
  "owner_disagrees_with_amounts",
  "owner_origin_unrecognised",
  "owner_origin_invalid_for_grain",
  "cross_grain_contamination",
  "campaign_parent_identity_invalid",
  // money
  "budget_field_ambiguous",
  "budget_field_none",
  "amount_not_integer",
  "amount_negative",
  // currency
  "currency_unknown",
  "currency_retired",
  "currency_exponent_not_captured",
  "currency_exponent_mismatch",
  "currency_registry_unrecognised",
  "currency_exponent_disagrees_with_registry",
  // schedule
  "lifetime_schedule_unretained",
  "lifetime_schedule_invalid",
  // shape
  "budget_shape_unsupported",
  "budget_shape_not_observed",
  // clocks
  "account_timezone_unknown",
  "invalid_as_of_date",
] as const;
export type BudgetFactBlocker = (typeof BUDGET_FACT_BLOCKERS)[number];

/** Exactly the completeness vocabulary `meta_entity_state_history` records. */
export type RunCompleteness = "complete" | "partial" | "point_lookup";
export type ObservedPresence = "present" | "absent_unconfirmed";

/** The owner-provenance vocabulary the observation column is constrained to. */
export const RECOGNISED_BUDGET_ORIGINS = [
  "campaign",
  "adset",
  "not_observed",
  "not_applicable",
] as const;
export type RecognisedBudgetOrigin = (typeof RECOGNISED_BUDGET_ORIGINS)[number];

/**
 * One retained observation row, already read from one binding. Raw budget
 * strings are carried verbatim; nothing here is pre-parsed, because parsing is
 * where precision is lost. Scope fields are carried so this module can check
 * them rather than assume the caller filtered correctly.
 */
export interface BudgetObservation {
  businessId: string;
  providerAccountId: string;
  entityGrain: BudgetEntityGrain;
  entityId: string;
  /** The parent campaign, for an ad set. Null on a campaign row. */
  parentCampaignId: string | null;
  /** Effective clock, exact instant. */
  observedAtMs: number | null;
  /** Effective calendar day, for reporting only — never for selection. */
  observedOn: string;
  /** Recorded clock, exact instant: when the observation became knowable. */
  capturedAtMs: number | null;
  presence: ObservedPresence | null;
  runCompleteness: RunCompleteness | null;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  /** The sync's own statement of where the money sits, cross-checked below. */
  budgetOrigin: string | null;
  budgetCurrency: string | null;
  /** The exponent in force when this row was captured, not today's. */
  budgetCurrencyExponent: number | null;
  budgetCurrencyRegistryVersion: string | null;
  campaignDailyRaw: string | null;
  campaignLifetimeRaw: string | null;
  adsetDailyRaw: string | null;
  adsetLifetimeRaw: string | null;
  startTime: string | null;
  endTime: string | null;
  /** Whether the provider's budget shape was observed and is actionable. */
  shapeSupport: BudgetShapeSupport;
  /**
   * Whether the status fields were actually observed, as opposed to merely
   * being null. A null value with no presence proof is ignorance; a null value
   * with presence proof is an observed absence.
   */
  statusFieldCoverage: { configuredStatus: boolean; effectiveStatus: boolean };
  /**
   * Immutable observation identity and source provenance. `payloadHash` and
   * `runHash` are distinct facts about the observation run and are never
   * substituted for one another.
   */
  observationId: string | null;
  sourceRunId: string | null;
  sourceSnapshotId: string | null;
  payloadHash: string | null;
  runHash: string | null;
  stateHash: string | null;
  providerApiVersion: string | null;
}

/** Owner provenance a row of this grain is allowed to claim. */
export function isOriginValidForGrain(
  grain: BudgetEntityGrain,
  origin: RecognisedBudgetOrigin,
): boolean {
  if (origin === "not_applicable" || origin === "not_observed") return true;
  return origin === grain;
}

/**
 * Provenance splits into two kinds, and they invalidate different claims.
 *
 * IDENTITY provenance says which observation this is and where it came from.
 * Without it you cannot prove you are reading the row you think you are, so its
 * absence invalidates the owner claim itself.
 *
 * CONTRACT provenance — the Graph version the row was fetched under — does not
 * change who owned the budget, but you cannot safely write back under a version
 * you cannot name, so its absence blocks intent readiness only.
 */
export const REQUIRED_IDENTITY_PROVENANCE_FIELDS = [
  "observationId",
  "sourceRunId",
  "sourceSnapshotId",
  "payloadHash",
  "runHash",
  "stateHash",
] as const;

export const REQUIRED_CONTRACT_PROVENANCE_FIELDS = ["providerApiVersion"] as const;

function missingStringFields(
  observation: BudgetObservation,
  fields: readonly (keyof BudgetObservation)[],
): string[] {
  return fields.filter((field) => {
    const value = observation[field];
    return typeof value !== "string" || value.trim() === "";
  }) as string[];
}

export function missingIdentityProvenance(observation: BudgetObservation): string[] {
  const missing = missingStringFields(observation, REQUIRED_IDENTITY_PROVENANCE_FIELDS);
  if (observation.observedAtMs === null) missing.push("observedAtMs");
  if (observation.capturedAtMs === null) missing.push("capturedAtMs");
  if (observation.runCompleteness === null) missing.push("runCompleteness");
  if (observation.presence === null) missing.push("presence");
  return missing.sort();
}

/** A clock must be a finite instant. `Infinity` compares as "before" forever. */
export function hasNonFiniteClock(observation: BudgetObservation): boolean {
  for (const value of [observation.observedAtMs, observation.capturedAtMs]) {
    if (value !== null && !Number.isFinite(value)) return true;
  }
  return false;
}

/**
 * The Graph version a row was fetched under. Presence alone is not evidence:
 * `"banana"` is a string, not a contract. This validates the shape Meta
 * actually uses (`v` then major.minor) so an unparseable value cannot buy
 * write-readiness. Whether that version is still *supported* is a separate,
 * deliberately unasserted question.
 */
export const PROVIDER_API_VERSION_PATTERN = /^v\d+\.\d+$/;

export function hasMalformedApiVersion(observation: BudgetObservation): boolean {
  const value = observation.providerApiVersion;
  if (typeof value !== "string" || value.trim() === "") return false; // absence is a different blocker
  return !PROVIDER_API_VERSION_PATTERN.test(value.trim());
}

export function missingContractProvenance(observation: BudgetObservation): string[] {
  return missingStringFields(observation, REQUIRED_CONTRACT_PROVENANCE_FIELDS).sort();
}

/** Both kinds together, for reporting. */
export function missingProvenanceFields(observation: BudgetObservation): string[] {
  return [...missingIdentityProvenance(observation), ...missingContractProvenance(observation)].sort();
}

/** Status evidence must have been observed, not merely be non-null. */
export function missingStatusEvidence(observation: BudgetObservation): string[] {
  const missing: string[] = [];
  // A blank or whitespace-only status is not an observed status.
  const present = (value: string | null) => typeof value === "string" && value.trim() !== "";
  if (!observation.statusFieldCoverage.configuredStatus || !present(observation.configuredStatus)) {
    missing.push("configuredStatus");
  }
  if (!observation.statusFieldCoverage.effectiveStatus || !present(observation.effectiveStatus)) {
    missing.push("effectiveStatus");
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

export type AmountParse =
  | { status: "absent" }
  | { status: "parsed"; raw: string; units: bigint }
  | { status: "invalid"; raw: string; reason: BudgetFactBlocker };

const ZERO = BigInt(0);

/**
 * Meta renders budgets as integer strings in the account currency. Anything
 * else is refused rather than coerced: a float parse would silently lose
 * precision on a large lifetime budget, and a non-integer is a contract
 * violation worth surfacing.
 */
export function parseProviderAmount(raw: unknown): AmountParse {
  if (raw === null || raw === undefined) return { status: "absent" };
  if (typeof raw !== "string") {
    return { status: "invalid", raw: String(raw), reason: "amount_not_integer" };
  }
  const trimmed = raw.trim();
  if (trimmed === "") return { status: "absent" };
  if (!/^-?\d+$/.test(trimmed)) return { status: "invalid", raw, reason: "amount_not_integer" };
  const units = BigInt(trimmed);
  if (units < ZERO) return { status: "invalid", raw, reason: "amount_negative" };
  return { status: "parsed", raw: trimmed, units };
}

/**
 * Presence and positivity, decided explicitly. This is the semantic the sync
 * mapper must use too: a field that was not returned is *absent*, and the
 * provider's `"0"` sentinel is present-but-not-owning. Generic truthiness gets
 * both wrong, because `"0"` is a truthy JavaScript string.
 */
export function classifyAmountField(raw: unknown): "absent" | "zero" | "positive" | "invalid" {
  const parsed = parseProviderAmount(raw);
  if (parsed.status === "absent") return "absent";
  if (parsed.status === "invalid") return "invalid";
  return parsed.units > ZERO ? "positive" : "zero";
}

export interface BudgetFieldResolution {
  field: BudgetField;
  bindingRaw: string | null;
  bindingUnits: bigint | null;
  blockers: BudgetFactBlocker[];
}

/**
 * The binding field is the one carrying a positive amount.
 *
 * Meta's ad-set reference states that either `daily_budget` or
 * `lifetime_budget` must be greater than zero, and in every retained row the
 * non-binding field is present as the string `"0"` rather than omitted. So
 * "both fields present" is not ambiguity — "both fields positive" is, and that
 * is what this refuses on. The rule is symmetric: neither side is privileged.
 */
export function resolveBudgetField(
  dailyRaw: string | null,
  lifetimeRaw: string | null,
): BudgetFieldResolution {
  const daily = parseProviderAmount(dailyRaw);
  const lifetime = parseProviderAmount(lifetimeRaw);
  const blockers: BudgetFactBlocker[] = [];
  for (const parse of [daily, lifetime]) if (parse.status === "invalid") blockers.push(parse.reason);
  if (blockers.length > 0) {
    return { field: "not_observed", bindingRaw: null, bindingUnits: null, blockers: sortedBlockers(blockers) };
  }
  if (daily.status === "absent" && lifetime.status === "absent") {
    return { field: "not_observed", bindingRaw: null, bindingUnits: null, blockers: ["budget_not_observed"] };
  }
  const dailyPositive = daily.status === "parsed" && daily.units > ZERO;
  const lifetimePositive = lifetime.status === "parsed" && lifetime.units > ZERO;
  if (dailyPositive && lifetimePositive) {
    return { field: "ambiguous", bindingRaw: null, bindingUnits: null, blockers: ["budget_field_ambiguous"] };
  }
  if (dailyPositive) return { field: "daily", bindingRaw: daily.raw, bindingUnits: daily.units, blockers: [] };
  if (lifetimePositive) {
    return { field: "lifetime", bindingRaw: lifetime.raw, bindingUnits: lifetime.units, blockers: [] };
  }
  // Both observed and both zero: this grain carries no budget. That is a real,
  // informative state — the money is at the other grain — not a zero budget.
  return { field: "none", bindingRaw: null, bindingUnits: null, blockers: ["budget_field_none"] };
}

function sortedBlockers(blockers: readonly BudgetFactBlocker[]): BudgetFactBlocker[] {
  return [...new Set(blockers)].sort();
}

// ---------------------------------------------------------------------------
// Point-in-time, in the physical account's own timezone
// ---------------------------------------------------------------------------

/**
 * The zone offset in force at a given instant. `Intl` is the only DST-correct
 * source available without a dependency, and it throws on an unknown zone,
 * which is exactly the fail-closed behaviour wanted here.
 *
 * Two competing costs meet here, and both have already bitten.
 *
 * Constructing an `Intl.DateTimeFormat` per point-in-time selection allocates
 * ICU state in *native* memory, outside the JS heap: a full replay reached
 * ~2 GB resident while `heapUsed` stayed flat at 200 MB, and the process was
 * killed rather than reporting an honest number. So formatters must be reused.
 *
 * But an unbounded cache is its own leak. Keyed on the raw string, arbitrary
 * invalid input grows a negative cache without bound, and aliases and casing
 * grow the formatter map with duplicates of one real zone.
 *
 * The design below is finite by construction:
 *
 *   - a cheap syntax and length screen rejects garbage before ICU is touched,
 *     and no invalid input is ever retained;
 *   - valid input is canonicalised through `resolvedOptions().timeZone`, so
 *     `US/Pacific`, `america/los_angeles` and `America/Los_Angeles` collapse to
 *     one entry;
 *   - both maps are bounded by `ZONE_CACHE_LIMIT` with least-recently-used
 *     eviction, so retained state cannot exceed a fixed size no matter what
 *     arrives.
 *
 * Eviction costs a reconstruction, never a wrong answer: a formatter is a pure
 * function of its zone.
 */

/**
 * IANA identifiers are ASCII `Area/Location`, at most three segments. This
 * screen exists to keep obviously invalid input away from ICU entirely; it is
 * not the validity test, which remains `Intl` itself.
 */
const ZONE_SYNTAX = /^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+){0,2}$/;
const MAX_ZONE_TEXT = 64;

/**
 * Comfortably above the number of distinct account timezones in the charter
 * (four) and any plausible account set, and small enough that the retained ICU
 * state is a fixed, inspectable cost.
 */
export const ZONE_CACHE_LIMIT = 16;

/** raw input -> canonical zone. Positive results only; bounded, LRU. */
const CANONICAL_ZONES = new Map<string, string>();
/** canonical zone -> formatter. Bounded, LRU. */
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function lruGet<V>(map: Map<string, V>, key: string): V | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  // Refresh recency: delete and re-insert moves the key to the end.
  map.delete(key);
  map.set(key, value);
  return value;
}

function lruSet<V>(map: Map<string, V>, key: string, value: V): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > ZONE_CACHE_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  return value;
}

/**
 * The canonical IANA name for a zone, or null if the runtime does not know it.
 *
 * An invalid input is never cached: caching negatives is precisely how an
 * attacker-shaped or buggy caller grows retained state without bound.
 */
function canonicalZone(timeZone: unknown): string | null {
  if (typeof timeZone !== "string") return null;
  const raw = timeZone.trim();
  if (raw === "" || raw.length > MAX_ZONE_TEXT || !ZONE_SYNTAX.test(raw)) return null;
  const cached = lruGet(CANONICAL_ZONES, raw);
  if (cached !== undefined) return cached;
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions()
      .timeZone;
    if (typeof canonical !== "string" || canonical === "") return null;
    return lruSet(CANONICAL_ZONES, raw, canonical);
  } catch {
    return null;
  }
}

function zoneFormatter(canonical: string): Intl.DateTimeFormat {
  const cached = lruGet(ZONE_FORMATTERS, canonical);
  if (cached) return cached;
  return lruSet(
    ZONE_FORMATTERS,
    canonical,
    new Intl.DateTimeFormat("en-US", {
      timeZone: canonical,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  );
}

/**
 * Read-only view of retained zone state, for tests that must prove the caches
 * are bounded. It exposes sizes, never a way to mutate or clear them.
 */
export function zoneCacheStats(): {
  canonical: number;
  formatters: number;
  limit: number;
} {
  return {
    canonical: CANONICAL_ZONES.size,
    formatters: ZONE_FORMATTERS.size,
    limit: ZONE_CACHE_LIMIT,
  };
}

function zoneCalendarDateWithFormatter(
  instantMs: number,
  formatter: Intl.DateTimeFormat,
): string | null {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    parts[part.type] = part.value;
  }
  if (!parts.year || !parts.month || !parts.day) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isKnownTimeZone(timeZone: unknown): timeZone is string {
  return canonicalZone(timeZone) !== null;
}

/**
 * The instant at which the as-of day begins in the account's own timezone.
 * A UTC-hard-coded cutoff is wrong by up to a day's fraction for every non-UTC
 * account, and wrong by a further hour across a DST boundary.
 */
/**
 * A real Gregorian date, not a string that `Date` will roll over. `2026-02-31`
 * silently became 3 March and `2026-02-29` became 1 March in a non-leap year.
 */
export function isRealCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function pitCutoffMs(asOf: string, timeZone: string): number | null {
  if (!isRealCalendarDate(asOf)) return null;
  const canonical = canonicalZone(timeZone);
  if (canonical === null) return null;
  const boundary = providerLocalDayStartInclusive({
    day: asOf,
    timeZone: canonical,
  });
  if (!boundary) return null;
  // Keep the budget module's bounded formatter cache as an independent
  // fail-closed projection check. The shared resolver owns gap/overlap
  // disambiguation; this verifies that its answer really lands on `asOf` in
  // the canonical account zone before the instant can gate a budget fact.
  if (
    zoneCalendarDateWithFormatter(
      boundary.getTime(),
      zoneFormatter(canonical),
    ) !== asOf
  ) {
    return null;
  }
  return boundary.getTime();
}

export interface PitRequest {
  /** The as-of calendar day, interpreted in the account's timezone. */
  asOf: string;
  /** The physical account's IANA timezone. */
  timeZone: string;
  /**
   * When true, an observation must also have been *recorded* by the cutoff.
   * When false the lane is a finalized reconstruction, not strict authority.
   */
  requireRecordedByCutoff: boolean;
}

/**
 * The freshest observation that was knowable at the cutoff. Selection uses the
 * exact effective instant, strictly before the cutoff: a fact effective at the
 * moment the day opens is not knowable when it opens, and casting the instant
 * to a server-session date would both lose the time and use the wrong day.
 */
/**
 * Every field capable of changing the owner, the amount, a blocker, a status,
 * provenance sufficiency, or intent readiness.
 *
 * Correction 2's tuple omitted `shapeSupport`, `statusFieldCoverage` and
 * `providerApiVersion`, so two same-clock rows that disagreed on readiness were
 * treated as one truth recorded twice — and which of them won, and therefore
 * whether the fact was intent-ready, was decided by which immutable id happened
 * to sort first. Anything added to this fingerprint must be a field the
 * canonical result depends on; anything the result depends on must be here.
 */
/**
 * Every field a downstream decision can read off a selected observation. The
 * conflict test is defined from this list rather than from an ad-hoc subset, so
 * a field added to `BudgetObservation` cannot silently become order-dependent.
 */
export const DECISION_TRUTH_FIELDS = [
  "businessId",
  "providerAccountId",
  "entityGrain",
  "entityId",
  "parentCampaignId",
  "presence",
  "runCompleteness",
  "budgetOrigin",
  "campaignDailyRaw",
  "campaignLifetimeRaw",
  "adsetDailyRaw",
  "adsetLifetimeRaw",
  "budgetCurrency",
  "budgetCurrencyExponent",
  "budgetCurrencyRegistryVersion",
  "startTime",
  "endTime",
  "configuredStatus",
  "effectiveStatus",
  "statusFieldCoverage.configuredStatus",
  "statusFieldCoverage.effectiveStatus",
  "shapeSupport",
  "sourceRunId",
  "sourceSnapshotId",
  "payloadHash",
  "runHash",
  "stateHash",
  "providerApiVersion",
] as const;

/**
 * Deliberately outside the fingerprint. The three clocks are what the conflict
 * is evaluated *at* — two observations reaching the same top rank already agree
 * on them. `observationId` is the tie-break key: two capture rows of identical
 * decision truth differ only by id, and the contract is to select one of them
 * deterministically rather than to call identical truth a conflict.
 */
export const DECISION_TRUTH_EXCLUDED_FIELDS = [
  "observedAtMs",
  "capturedAtMs",
  "observedOn",
  "observationId",
] as const;

function decisionTruthValue(row: BudgetObservation, field: string): unknown {
  if (field === "statusFieldCoverage.configuredStatus") {
    return row.statusFieldCoverage.configuredStatus;
  }
  if (field === "statusFieldCoverage.effectiveStatus") {
    return row.statusFieldCoverage.effectiveStatus;
  }
  return (row as unknown as Record<string, unknown>)[field];
}

export function decisionTruthFingerprint(row: BudgetObservation): string {
  return JSON.stringify(DECISION_TRUTH_FIELDS.map((f) => decisionTruthValue(row, f)));
}

export type PitSelection =
  | { status: "none" }
  | { status: "selected"; observation: BudgetObservation }
  | { status: "conflict"; observations: BudgetObservation[] };

/**
 * The freshest observation that was knowable at the cutoff, chosen without
 * reference to input order.
 *
 * Two rows can share an effective and a recorded instant. Correction 1 returned
 * whichever the caller happened to list first, so the same evidence produced
 * 100 or 200 depending on SQL row order. Byte-identical truth is now tie-broken
 * on immutable identity, and top-clock rows that disagree semantically are a
 * refusal, not a coin flip.
 */
export function selectObservationAtPitDetailed(
  rows: readonly BudgetObservation[],
  request: PitRequest,
): PitSelection {
  const cutoff = pitCutoffMs(request.asOf, request.timeZone);
  if (cutoff === null) return { status: "none" };
  const eligible = rows.filter(
    (row) =>
      row.observedAtMs !== null &&
      Number.isFinite(row.observedAtMs) &&
      (row.capturedAtMs === null || Number.isFinite(row.capturedAtMs)) &&
      row.observedAtMs < cutoff &&
      (!request.requireRecordedByCutoff ||
        (row.capturedAtMs !== null && row.capturedAtMs <= cutoff)),
  );
  if (eligible.length === 0) return { status: "none" };

  let bestObserved = -Infinity;
  let bestCaptured = -Infinity;
  for (const row of eligible) {
    const observed = row.observedAtMs ?? -Infinity;
    const captured = row.capturedAtMs ?? -Infinity;
    if (observed > bestObserved || (observed === bestObserved && captured > bestCaptured)) {
      bestObserved = observed;
      bestCaptured = captured;
    }
  }
  const top = eligible.filter(
    (row) => (row.observedAtMs ?? -Infinity) === bestObserved &&
      (row.capturedAtMs ?? -Infinity) === bestCaptured,
  );
  if (top.length === 1) return { status: "selected", observation: top[0]! };

  // Same clocks. Identical truth is one observation recorded twice; different
  // truth at the same instant is a conflict this contract cannot resolve.
  const distinctTruth = new Set(top.map(decisionTruthFingerprint));
  if (distinctTruth.size > 1) return { status: "conflict", observations: top };

  // Byte-identical truth: pick deterministically on immutable identity.
  const ordered = [...top].sort((a, b) =>
    String(a.observationId ?? "").localeCompare(String(b.observationId ?? "")) ||
    String(a.stateHash ?? "").localeCompare(String(b.stateHash ?? "")),
  );
  return { status: "selected", observation: ordered[0]! };
}

/** Back-compatible wrapper: a conflict selects nothing. */
export function selectObservationAtPit(
  rows: readonly BudgetObservation[],
  request: PitRequest,
): BudgetObservation | null {
  const selection = selectObservationAtPitDetailed(rows, request);
  return selection.status === "selected" ? selection.observation : null;
}

// ---------------------------------------------------------------------------
// Scope validation
// ---------------------------------------------------------------------------

export interface ScopeRequest {
  businessId: string;
  providerAccountId: string;
  entityGrain: BudgetEntityGrain;
  entityId: string;
  parentCampaignId: string | null;
}

/** Every way a row can fail to be the row the caller asked for. */
export function validateObservationScope(
  observation: BudgetObservation,
  expected: {
    businessId: string;
    providerAccountId: string;
    entityGrain: BudgetEntityGrain;
    entityId: string;
  },
): BudgetFactBlocker[] {
  const blockers: BudgetFactBlocker[] = [];
  if (observation.businessId !== expected.businessId) blockers.push("scope_business_mismatch");
  if (observation.providerAccountId !== expected.providerAccountId) {
    blockers.push("scope_account_mismatch");
  }
  if (observation.entityGrain !== expected.entityGrain) blockers.push("scope_grain_mismatch");
  if (observation.entityId !== expected.entityId) blockers.push("scope_entity_mismatch");
  return blockers;
}

// ---------------------------------------------------------------------------
// Ownership across the hierarchy
// ---------------------------------------------------------------------------

export interface OwnerResolution {
  ownerMode: BudgetOwnerMode;
  ownerGrain: BudgetEntityGrain | null;
  ownerEntityId: string | null;
  field: BudgetField;
  bindingRaw: string | null;
  blockers: BudgetFactBlocker[];
}

function originOf(observation: BudgetObservation): RecognisedBudgetOrigin | null {
  const origin = observation.budgetOrigin;
  return (RECOGNISED_BUDGET_ORIGINS as readonly string[]).includes(origin ?? "")
    ? (origin as RecognisedBudgetOrigin)
    : null;
}

/**
 * `budget_origin = 'not_applicable'` is a statement about a grain, not about a
 * hierarchy: it means the money is not here, so it is at the other grain. On its
 * own it resolves nothing; joined to the sibling observation it resolves the
 * owner exactly. Both rows are required, so `not_applicable` is only ever read
 * as the non-owner side of a complete, consistent two-grain join.
 */
export function resolveHierarchyOwner(input: {
  adset: BudgetObservation | null;
  campaign: BudgetObservation | null;
}): OwnerResolution {
  const { adset, campaign } = input;
  const unresolved = (extra: BudgetFactBlocker[]): OwnerResolution => ({
    ownerMode: "unresolved",
    ownerGrain: null,
    ownerEntityId: null,
    field: "not_observed",
    bindingRaw: null,
    blockers: sortedBlockers(extra),
  });

  if (!campaign) return unresolved(["owner_unresolved_hierarchy"]);

  const campaignOrigin = originOf(campaign);
  if (campaignOrigin === null || campaignOrigin === "not_observed") {
    return unresolved(["owner_origin_unrecognised"]);
  }
  if (!isOriginValidForGrain("campaign", campaignOrigin)) {
    return unresolved(["owner_origin_invalid_for_grain"]);
  }
  // A campaign row must not carry ad-set money or schedule, and vice versa.
  if (campaign.adsetDailyRaw !== null || campaign.adsetLifetimeRaw !== null) {
    return unresolved(["cross_grain_contamination"]);
  }
  if (adset) {
    const adsetOrigin = originOf(adset);
    if (adsetOrigin === null || adsetOrigin === "not_observed") {
      return unresolved(["owner_origin_unrecognised"]);
    }
    if (!isOriginValidForGrain("adset", adsetOrigin)) {
      return unresolved(["owner_origin_invalid_for_grain"]);
    }
    if (adset.campaignDailyRaw !== null || adset.campaignLifetimeRaw !== null) {
      return unresolved(["cross_grain_contamination"]);
    }
  }

  const campaignField = resolveBudgetField(campaign.campaignDailyRaw, campaign.campaignLifetimeRaw);
  const adsetField = adset ? resolveBudgetField(adset.adsetDailyRaw, adset.adsetLifetimeRaw) : null;

  if (campaignField.field === "ambiguous" || adsetField?.field === "ambiguous") {
    return {
      ownerMode: "ambiguous",
      ownerGrain: null,
      ownerEntityId: null,
      field: "ambiguous",
      bindingRaw: null,
      blockers: ["budget_field_ambiguous"],
    };
  }

  const campaignCarries = campaignField.field === "daily" || campaignField.field === "lifetime";
  const adsetCarries = adsetField?.field === "daily" || adsetField?.field === "lifetime";

  if (campaignCarries && adsetCarries) {
    return {
      ownerMode: "unsupported",
      ownerGrain: null,
      ownerEntityId: null,
      field: "ambiguous",
      bindingRaw: null,
      blockers: ["budget_shape_unsupported"],
    };
  }

  // The stored origin must agree with where the money actually is.
  const disagrees =
    (campaignCarries && campaignOrigin !== "campaign") ||
    (!campaignCarries && campaignOrigin === "campaign") ||
    (adset !== null && adsetCarries && originOf(adset) !== "adset") ||
    (adset !== null && !adsetCarries && originOf(adset) === "adset");
  if (disagrees) return unresolved(["owner_disagrees_with_amounts"]);

  if (campaignCarries) {
    return {
      ownerMode: "campaign_owned",
      ownerGrain: "campaign",
      ownerEntityId: campaign.entityId,
      field: campaignField.field,
      bindingRaw: campaignField.bindingRaw,
      blockers: [],
    };
  }
  if (adsetCarries && adset && adsetField) {
    return {
      ownerMode: "adset_owned",
      ownerGrain: "adset",
      ownerEntityId: adset.entityId,
      field: adsetField.field,
      bindingRaw: adsetField.bindingRaw,
      blockers: [],
    };
  }
  return unresolved(["budget_field_none"]);
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface ScheduleResolution {
  required: boolean;
  complete: boolean;
  startTime: string | null;
  endTime: string | null;
  startMs: number | null;
  endMs: number | null;
  blockers: BudgetFactBlocker[];
}

function parseInstant(value: string | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let iso = value.includes("T") ? value : value.replace(" ", "T");
  if (/[+-]\d{2}$/.test(iso)) iso = `${iso}:00`;
  else if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) iso = `${iso}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** A lifetime budget without a well-formed, forward schedule is unevaluable. */
export function resolveSchedule(input: {
  required: boolean;
  startTime: string | null;
  endTime: string | null;
}): ScheduleResolution {
  const startMs = parseInstant(input.startTime);
  const endMs = parseInstant(input.endTime);
  if (!input.required) {
    return {
      required: false,
      complete: false,
      startTime: input.startTime,
      endTime: input.endTime,
      startMs,
      endMs,
      blockers: [],
    };
  }
  if (input.startTime === null || input.endTime === null) {
    return {
      required: true,
      complete: false,
      startTime: input.startTime,
      endTime: input.endTime,
      startMs,
      endMs,
      blockers: ["lifetime_schedule_unretained"],
    };
  }
  if (startMs === null || endMs === null || endMs <= startMs) {
    return {
      required: true,
      complete: false,
      startTime: input.startTime,
      endTime: input.endTime,
      startMs,
      endMs,
      blockers: ["lifetime_schedule_invalid"],
    };
  }
  return {
    required: true,
    complete: true,
    startTime: input.startTime,
    endTime: input.endTime,
    startMs,
    endMs,
    blockers: [],
  };
}

// ---------------------------------------------------------------------------
// The canonical fact
// ---------------------------------------------------------------------------

export interface ObservationProvenance {
  observationId: string | null;
  sourceRunId: string | null;
  sourceSnapshotId: string | null;
  payloadHash: string | null;
  runHash: string | null;
  stateHash: string | null;
  providerApiVersion: string | null;
  effectiveAtMs: number | null;
  recordedAtMs: number | null;
  observedOn: string | null;
  runCompleteness: RunCompleteness | null;
  presence: ObservedPresence | null;
}

export interface CanonicalBudgetFact {
  contractVersion: typeof BUDGET_FACT_CONTRACT_VERSION;
  scope: ScopeRequest;
  pit: { asOf: string; timeZone: string; cutoffMs: number | null; requireRecordedByCutoff: boolean };
  ownerMode: BudgetOwnerMode;
  ownerGrain: BudgetEntityGrain | null;
  ownerEntityId: string | null;
  budgetField: BudgetField;
  /** Exact provider string, from the OWNER row. Never a number, never divided. */
  bindingAmountRaw: string | null;
  currency: string | null;
  currencyExponent: number | null;
  currencyRegistryVersion: string | null;
  schedule: ScheduleResolution;
  shapeSupport: BudgetShapeSupport;
  /** Statuses stay separate: the subject's, and its parent's. */
  subjectConfiguredStatus: string | null;
  subjectEffectiveStatus: string | null;
  parentConfiguredStatus: string | null;
  parentEffectiveStatus: string | null;
  /** Provenance of the owner row, the subject row and the PIT parent row. */
  ownerProvenance: ObservationProvenance | null;
  subjectProvenance: ObservationProvenance | null;
  parentProvenance: ObservationProvenance | null;
  /** Owner and amount are proven. Weaker than intent-ready. */
  ownerResolved: boolean;
  /**
   * Everything a budget intent needs is proven: owner, amount, currency and
   * captured exponent, schedule where required, shape support, statuses and
   * immutable provenance.
   */
  intentReady: boolean;
  blockers: BudgetFactBlocker[];
}

export interface BudgetFactRequest extends ScopeRequest {
  pit: PitRequest;
  /** Observations for the subject entity. Validated, not trusted. */
  entityObservations: readonly BudgetObservation[];
  /** Observations for the parent campaign. Required for an ad set. */
  parentObservations: readonly BudgetObservation[];
}

function provenanceOf(observation: BudgetObservation | null): ObservationProvenance | null {
  if (!observation) return null;
  return {
    observationId: observation.observationId,
    sourceRunId: observation.sourceRunId,
    sourceSnapshotId: observation.sourceSnapshotId,
    payloadHash: observation.payloadHash,
    runHash: observation.runHash,
    stateHash: observation.stateHash,
    providerApiVersion: observation.providerApiVersion,
    effectiveAtMs: observation.observedAtMs,
    recordedAtMs: observation.capturedAtMs,
    observedOn: observation.observedOn,
    runCompleteness: observation.runCompleteness,
    presence: observation.presence,
  };
}

/**
 * The one function a future budget intent may call. It returns a fact or a
 * refusal; it never returns a usable amount it could not fully justify, and it
 * never reports one row's provenance beside another row's money.
 */
export function buildCanonicalBudgetFact(request: BudgetFactRequest): CanonicalBudgetFact {
  const blockers: BudgetFactBlocker[] = [];
  // The two reasons a cutoff can fail are different facts and are named
  // separately: an impossible as-of date is a caller error, an unknown
  // timezone is missing account evidence.
  const cutoffMs = pitCutoffMs(request.pit.asOf, request.pit.timeZone);
  const dateIsReal = isRealCalendarDate(request.pit.asOf);
  const zoneIsKnown = isKnownTimeZone(request.pit.timeZone);
  if (!dateIsReal) blockers.push("invalid_as_of_date");
  if (!zoneIsKnown) blockers.push("account_timezone_unknown");

  // Only rows that are actually this entity, in this binding, may be selected.
  // One pass: partition and collect, without allocating an array per row.
  const subjectCandidates: BudgetObservation[] = [];
  const seenBlockers = new Set<BudgetFactBlocker>();
  const expectedSubject = {
    businessId: request.businessId,
    providerAccountId: request.providerAccountId,
    entityGrain: request.entityGrain,
    entityId: request.entityId,
  };
  for (const row of request.entityObservations) {
    const rowBlockers = validateObservationScope(row, expectedSubject);
    if (rowBlockers.length === 0) subjectCandidates.push(row);
    else for (const blocker of rowBlockers) seenBlockers.add(blocker);
  }
  for (const blocker of seenBlockers) blockers.push(blocker);

  const subjectSelection =
    cutoffMs === null
      ? ({ status: "none" } as PitSelection)
      : selectObservationAtPitDetailed(subjectCandidates, request.pit);
  if (subjectSelection.status === "conflict") blockers.push("pit_conflicting_observations");
  const subject = subjectSelection.status === "selected" ? subjectSelection.observation : null;

  // The parent the CHILD declares is the only parent that may be used, and it
  // must match what the caller declared too.
  // A campaign has no parent. An externally supplied non-null parent on a
  // campaign request is refused rather than echoed into output scope, which is
  // what Correction 2 did.
  if (request.entityGrain === "campaign" && request.parentCampaignId !== null) {
    blockers.push("campaign_parent_identity_invalid");
  }
  const declaredParent = request.entityGrain === "adset" ? request.parentCampaignId : null;
  const childParent = subject?.parentCampaignId ?? null;
  if (request.entityGrain === "adset") {
    if (!declaredParent || !childParent) blockers.push("parent_campaign_identity_absent");
    else if (declaredParent !== childParent) blockers.push("parent_identity_mismatch");
  }
  const parentId = request.entityGrain === "adset" ? (childParent ?? declaredParent) : request.entityId;

  const expectedParent = {
    businessId: request.businessId,
    providerAccountId: request.providerAccountId,
    entityGrain: "campaign" as const,
    entityId: parentId ?? "",
  };
  const parentSource =
    request.entityGrain === "adset" ? request.parentObservations : subjectCandidates;
  const parentCandidates: BudgetObservation[] = [];
  const parentBlockers = new Set<BudgetFactBlocker>();
  for (const row of parentSource) {
    const rowBlockers = validateObservationScope(row, expectedParent);
    if (rowBlockers.length === 0) parentCandidates.push(row);
    else if (request.entityGrain === "adset") {
      for (const blocker of rowBlockers) parentBlockers.add(blocker);
    }
  }
  for (const blocker of parentBlockers) blockers.push(blocker);

  let parent: BudgetObservation | null = null;
  if (cutoffMs !== null && parentId) {
    if (request.entityGrain === "adset") {
      const parentSelection = selectObservationAtPitDetailed(parentCandidates, request.pit);
      if (parentSelection.status === "conflict") blockers.push("pit_conflicting_observations");
      parent = parentSelection.status === "selected" ? parentSelection.observation : null;
      // A stored campaign row carries its own id; anything else is not this
      // campaign's observation and must not become the owner.
      if (parent && parent.parentCampaignId !== null && parent.parentCampaignId !== parent.entityId) {
        blockers.push("campaign_parent_identity_invalid");
        parent = null;
      }
    } else {
      parent = subject;
      if (subject && subject.parentCampaignId !== null && subject.parentCampaignId !== subject.entityId) {
        blockers.push("campaign_parent_identity_invalid");
      }
    }
  }

  const base: CanonicalBudgetFact = {
    contractVersion: BUDGET_FACT_CONTRACT_VERSION,
    scope: {
      businessId: request.businessId,
      providerAccountId: request.providerAccountId,
      entityGrain: request.entityGrain,
      entityId: request.entityId,
      // Canonically normalised: a campaign fact never reports a parent.
      parentCampaignId: request.entityGrain === "campaign" ? null : request.parentCampaignId,
    },
    pit: {
      asOf: request.pit.asOf,
      timeZone: request.pit.timeZone,
      cutoffMs,
      requireRecordedByCutoff: request.pit.requireRecordedByCutoff,
    },
    ownerMode: "not_observed",
    ownerGrain: null,
    ownerEntityId: null,
    budgetField: "not_observed",
    bindingAmountRaw: null,
    currency: null,
    currencyExponent: null,
    currencyRegistryVersion: null,
    schedule: { required: false, complete: false, startTime: null, endTime: null, startMs: null, endMs: null, blockers: [] },
    shapeSupport: "shape_not_observed",
    subjectConfiguredStatus: subject?.configuredStatus ?? null,
    subjectEffectiveStatus: subject?.effectiveStatus ?? null,
    // A campaign fact has no parent; reporting its own status there would
    // manufacture a second row's worth of evidence out of one row.
    parentConfiguredStatus:
      request.entityGrain === "adset" ? (parent?.configuredStatus ?? null) : null,
    parentEffectiveStatus:
      request.entityGrain === "adset" ? (parent?.effectiveStatus ?? null) : null,
    ownerProvenance: null,
    subjectProvenance: provenanceOf(subject),
    parentProvenance: null,
    ownerResolved: false,
    intentReady: false,
    blockers: [],
  };

  if (!subject) {
    // Distinguish "nothing was observed" from "everything observed carried an
    // unusable clock", which is a data defect rather than an absence.
    const excludedForClock =
      subjectCandidates.length > 0 && subjectCandidates.every(hasNonFiniteClock);
    return {
      ...base,
      blockers: sortedBlockers([
        ...blockers,
        excludedForClock ? "subject_clock_not_finite" : "budget_not_observed",
      ]),
    };
  }
  if (subject.presence !== "present") blockers.push("entity_absent_at_pit");
  if (subject.runCompleteness !== "complete") blockers.push("observation_not_complete_scope");
  if (!subject.observationId || !subject.stateHash) blockers.push("observation_identity_absent");
  if (missingIdentityProvenance(subject).length > 0) blockers.push("subject_provenance_incomplete");
  if (hasNonFiniteClock(subject)) blockers.push("subject_clock_not_finite");
  if (missingContractProvenance(subject).length > 0) blockers.push("subject_api_version_absent");
  if (hasMalformedApiVersion(subject)) blockers.push("subject_api_version_malformed");
  if (missingStatusEvidence(subject).length > 0) blockers.push("subject_status_evidence_absent");

  // A hierarchy needs both rows. The parent is what proves the money is not
  // somewhere else, so ABO needs it just as much as CBO does.
  if (request.entityGrain === "adset") {
    if (!parent) blockers.push("parent_not_observed");
    else {
      if (parent.presence !== "present") blockers.push("parent_absent_at_pit");
      if (parent.runCompleteness !== "complete") blockers.push("parent_not_complete_scope");
      // The parent proves ownership even when the ad set holds the amount, so
      // its provenance and status evidence are required just as strictly.
      if (missingIdentityProvenance(parent).length > 0) blockers.push("parent_provenance_incomplete");
      if (hasNonFiniteClock(parent)) blockers.push("parent_clock_not_finite");
      if (missingContractProvenance(parent).length > 0) blockers.push("parent_api_version_absent");
      if (hasMalformedApiVersion(parent)) blockers.push("parent_api_version_malformed");
      if (missingStatusEvidence(parent).length > 0) blockers.push("parent_status_evidence_absent");
    }
  }

  const owner = resolveHierarchyOwner({
    adset: request.entityGrain === "adset" ? subject : null,
    campaign: request.entityGrain === "adset" ? parent : subject,
  });
  blockers.push(...owner.blockers);

  // Every value now comes from the row that actually supplied the money.
  const ownerRow =
    owner.ownerGrain === "campaign" ? parent : owner.ownerGrain === "adset" ? subject : null;

  const currency = ownerRow?.budgetCurrency ?? null;
  const capturedExponent = ownerRow?.budgetCurrencyExponent ?? null;
  const capturedRegistry = ownerRow?.budgetCurrencyRegistryVersion ?? null;
  if (ownerRow) {
    if (capturedExponent === null || capturedRegistry === null) {
      // The exponent in force at capture was not retained. Re-deriving it from
      // today's registry would silently restate a historical amount.
      blockers.push("currency_exponent_not_captured");
    }
    // Only a recognised registry version may be trusted; an unrecognised one is
    // refused rather than quietly re-derived from the current registry.
    if (capturedRegistry !== null && capturedRegistry !== ISO_4217_REGISTRY_VERSION) {
      blockers.push("currency_registry_unrecognised");
    }
    const resolution = resolveMinorUnitExponent(currency);
    if (resolution.status === "retired_currency") blockers.push("currency_retired");
    else if (resolution.status === "unknown_currency") blockers.push("currency_unknown");
    else if (
      capturedExponent !== null &&
      capturedRegistry === ISO_4217_REGISTRY_VERSION &&
      capturedExponent !== resolution.exponent
    ) {
      blockers.push("currency_exponent_disagrees_with_registry");
    }
    if (capturedExponent !== null && (!Number.isInteger(capturedExponent) || capturedExponent < 0)) {
      blockers.push("currency_exponent_mismatch");
    }
  }

  const schedule = resolveSchedule({
    required: owner.field === "lifetime",
    startTime: ownerRow?.startTime ?? null,
    endTime: ownerRow?.endTime ?? null,
  });
  blockers.push(...schedule.blockers);

  const shapeSupport = ownerRow?.shapeSupport ?? "shape_not_observed";
  if (shapeSupport === "unsupported_shape") blockers.push("budget_shape_unsupported");
  else if (shapeSupport !== "supported") blockers.push("budget_shape_not_observed");

  const resolved = sortedBlockers(blockers);
  // Owner and amount proven, ignoring the blockers that speak to other fields.
  // Blockers that speak to intent readiness only. Everything else - scope,
  // hierarchy, provenance, status evidence, origin validity, PIT conflict -
  // invalidates the owner claim itself, because it undermines the row that
  // proves who owns the money.
  const ownerBlockers = new Set<BudgetFactBlocker>([
    "budget_shape_unsupported",
    "budget_shape_not_observed",
    "currency_exponent_not_captured",
    "currency_exponent_mismatch",
    "currency_registry_unrecognised",
    "currency_exponent_disagrees_with_registry",
    "currency_unknown",
    "currency_retired",
    "lifetime_schedule_unretained",
    "lifetime_schedule_invalid",
    // The Graph version does not change who owned the budget; it changes
    // whether a write-back could be issued safely.
    "subject_api_version_absent",
    "parent_api_version_absent",
    "subject_api_version_malformed",
    "parent_api_version_malformed",
  ]);
  const ownerResolved =
    owner.bindingRaw !== null && resolved.every((blocker) => ownerBlockers.has(blocker));

  return {
    ...base,
    ownerMode: owner.ownerMode,
    ownerGrain: owner.ownerGrain,
    ownerEntityId: owner.ownerEntityId,
    budgetField: owner.field,
    bindingAmountRaw: owner.bindingRaw,
    currency,
    currencyExponent: capturedExponent,
    currencyRegistryVersion: capturedRegistry,
    schedule,
    shapeSupport,
    // A campaign fact has no parent row; echoing the subject there would
    // manufacture a second row's worth of evidence out of one row.
    parentConfiguredStatus:
      request.entityGrain === "adset" ? (parent?.configuredStatus ?? null) : null,
    parentEffectiveStatus:
      request.entityGrain === "adset" ? (parent?.effectiveStatus ?? null) : null,
    parentProvenance: request.entityGrain === "adset" ? provenanceOf(parent) : null,
    ownerProvenance: provenanceOf(ownerRow),
    ownerResolved,
    intentReady: resolved.length === 0 && owner.bindingRaw !== null,
    blockers: resolved,
  };
}
