/**
 * D081-A — the canonical typed Meta budget intent.
 *
 * D080B proved `decision_vocabulary_absent` blocked 100% of 247,050 historical
 * proposals: `MutationAction` is `pause | resume | bid | duplicate`, the
 * decision vocabulary is creative-only and ad-grain-only, and there is nowhere
 * a campaign- or ad-set-grain budget intent could be recorded.
 *
 * This module supplies the missing type. It deliberately does NOT:
 *
 * - widen {@link MutationAction} or {@link MUTATION_ENDPOINTS}. D080A
 *   established that adding a budget verb to the dispatch contract without an
 *   endpoint would create an action that can be raised and approved but never
 *   executed. A test asserts no budget endpoint exists.
 * - widen `meta_automation_proposals`, for the same reason.
 * - create a second decision core. A budget intent is a typed, validated
 *   *proposal shape*; the existing engine and authority gates still decide.
 * - carry a provider write adapter. The highest execution state this contract
 *   can reach is `validated_only`.
 *
 * A validated intent is NOT an executable action. Every evidence, delivery,
 * commercial, cooldown, concentration, idempotency, read-back and kill-switch
 * gate proven in D080B still applies afterwards.
 */
import { createHash } from "node:crypto";

import {
  ISO_4217_REGISTRY_SOURCE,
  ISO_4217_REGISTRY_VERSION,
  applyPercentToMinorUnits,
  resolveMinorUnitExponent,
  type MinorUnitExponent,
} from "@/lib/currency/iso-4217-minor-units";
import {
  assertCanonicalDecisionAction,
  type MetaOsBudgetDecisionAction,
  type MetaOsBudgetIntentPayload,
} from "@/lib/meta/decisions-os-contract";
import { DECISION_BOUND_GRAINS } from "@/lib/zero-base/meta/decision-bound-target";

export const META_BUDGET_INTENT_CONTRACT_VERSION = "meta.budget-intent.v1" as const;

/** Grains that can own a budget. `ad` is a valid decision grain but owns none. */
export const BUDGET_OWNER_GRAINS = ["campaign", "adset"] as const;
export type BudgetOwnerGrain = (typeof BUDGET_OWNER_GRAINS)[number];

/** The two mutable budget fields, matching the provider's own field names. */
export const BUDGET_FIELDS = ["daily_budget", "lifetime_budget"] as const;
export type BudgetField = (typeof BUDGET_FIELDS)[number];

export const BUDGET_DIRECTIONS = ["increase", "decrease"] as const;
export type BudgetDirection = (typeof BUDGET_DIRECTIONS)[number];

/**
 * Owner modes as the provider expresses them. `unknown` and `not_applicable`
 * are first-class: they are the honest answer for most of the retained history
 * and must never collapse into a guess.
 */
export const BUDGET_OWNER_MODES = ["campaign_budget_optimization", "adset_budget", "unknown", "not_applicable"] as const;
export type BudgetOwnerMode = (typeof BUDGET_OWNER_MODES)[number];

/**
 * Execution states, from the live-execution-safety contract. This module can
 * only ever produce the first: nothing here sends a request.
 */
export const BUDGET_INTENT_EXECUTION_STATES = ["validated_only", "not_validated"] as const;
export type BudgetIntentExecutionState = (typeof BUDGET_INTENT_EXECUTION_STATES)[number];

export const BUDGET_INTENT_REJECTIONS = [
  "scope_identity_cross_paired",
  "scope_identity_unknown",
  "grain_unsupported",
  "owner_mode_ambiguous",
  "owner_grain_mismatch",
  "budget_field_ambiguous",
  "budget_field_unsupported",
  "current_value_missing",
  "current_value_not_integer_minor_units",
  "lifetime_schedule_invalid",
  "currency_exponent_unknown",
  "currency_retired",
  "percent_unapproved_magnitude",
  "percent_math_inconsistent",
  "proposal_not_positive",
  "proposal_overflows_minor_units",
  "authority_evidence_stale",
  "authority_evidence_future",
  "identity_unstable",
  "rollback_contract_missing",
  "readback_contract_missing",
  "contract_version_unsupported",
] as const;
export type BudgetIntentRejection = (typeof BUDGET_INTENT_REJECTIONS)[number];

/**
 * The approved magnitude ladder. Origin: proposed governance — it bounds a
 * read-only simulation and cannot authorise a live move without owner
 * approval, per the evidence policy's threshold rules.
 */
export const APPROVED_MAGNITUDE_PERCENTS = [5, 10, 15, 20, 25] as const;
export const APPROVED_MAGNITUDE_ORIGIN = {
  origin: "proposed_governance",
  source: "D080B historical capability replay",
  derivation: "a symmetric bounded ladder chosen to be evaluable, not a derived optimum; D080B showed the rungs are indistinguishable on retained history",
  scope: "read-only simulation and validation only",
  approvalState: "unapproved",
  approver: null,
} as const;

/** The composite scope. All four parts, always; never business alone. */
export interface BudgetIntentScope {
  businessId: string;
  providerAccountId: string;
  entityGrain: BudgetOwnerGrain;
  entityId: string;
  /** Required when the entity is an ad set; null for a campaign. */
  parentCampaignId: string | null;
}

export interface BudgetIntentInput {
  contractVersion: string;
  scope: BudgetIntentScope;
  ownerMode: BudgetOwnerMode;
  budgetField: BudgetField;
  /** Both fields as observed, so a dual-field state can be refused. */
  observedDailyMinorUnits: number | null;
  observedLifetimeMinorUnits: number | null;
  /** Required for a lifetime budget: without it, remaining flight is unknowable. */
  lifetimeSchedule: { startDate: string; endDate: string } | null;
  direction: BudgetDirection;
  percent: number;
  accountCurrency: string;
  /** Point-in-time clocks. Nothing dated after `originDate` may be used. */
  originDate: string;
  effectiveAsOf: string;
  knowledgeAsOf: string;
  /** Freshness of the authority evidence that produced this intent. */
  authorityEvidenceAsOf: string;
  maxAuthorityEvidenceAgeDays: number;
  /** Fingerprints of the exact sources this intent was built from. */
  sourceFingerprints: { configStateHash: string; ownerStateHash: string; roleAuthorityHash: string };
  evidenceWindow: { from: string; to: string };
  targetSource: { source: string; version: string } | null;
  authorityStatus: "authorised" | "blocked" | "not_determinable";
  blockerCodes: string[];
}

export interface ValidatedBudgetIntent {
  contractVersion: typeof META_BUDGET_INTENT_CONTRACT_VERSION;
  /** Deterministic identity: the same intent always produces the same key. */
  intentKey: string;
  idempotencyKey: string;
  scope: BudgetIntentScope;
  ownerMode: BudgetOwnerMode;
  budgetField: BudgetField;
  direction: BudgetDirection;
  percent: number;
  currency: string;
  currencyExponent: MinorUnitExponent;
  currencyRegistry: { version: string; source: string };
  currentMinorUnits: number;
  proposedMinorUnits: number;
  deltaMinorUnits: number;
  rounding: { applied: boolean; rule: "half_up_away_from_zero"; exactUnrounded: string };
  originDate: string;
  effectiveAsOf: string;
  knowledgeAsOf: string;
  authorityEvidenceAsOf: string;
  sourceFingerprints: BudgetIntentInput["sourceFingerprints"];
  evidenceWindow: { from: string; to: string };
  targetSource: { source: string; version: string } | null;
  authorityStatus: BudgetIntentInput["authorityStatus"];
  blockerCodes: string[];
  /** Always `validated_only`: nothing in this module sends a request. */
  executionState: "validated_only";
  rollback: { priorMinorUnits: number; field: BudgetField; operation: "restore_prior_amount" };
  readback: { field: BudgetField; expectedMinorUnits: number; independentRead: true };
  createdBy: { module: string; contractVersion: string };
}

export type BudgetIntentValidation =
  | { status: "valid"; intent: ValidatedBudgetIntent }
  | { status: "rejected"; rejections: BudgetIntentRejection[]; reasons: string[] };

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}
export function isHex64(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * A stable identity for one intent. It is a pure function of the composite
 * scope, the field, the direction, the magnitude and the origin, so the same
 * intent re-derived tomorrow collides with itself rather than duplicating.
 */
export function budgetIntentKey(input: {
  scope: BudgetIntentScope; budgetField: BudgetField;
  direction: BudgetDirection; percent: number; originDate: string;
  /** The exact operation. Two different amounts are two different operations. */
  currentMinorUnits: number; proposedMinorUnits: number;
  ownerMode: BudgetOwnerMode; currency: string; currencyExponent: number;
  /** The evidence the operation was derived from. */
  sourceFingerprints: BudgetIntentInput["sourceFingerprints"];
}): string {
  const { scope } = input;
  // Scope alone is not an operation. An earlier form omitted the amounts, the
  // owner mode, the currency and the evidence, so raising a budget from 100 to
  // 110 and from 900 to 990 shared one idempotency key — two materially
  // different money movements that a dispatcher would have deduplicated.
  const operation = [
    META_BUDGET_INTENT_CONTRACT_VERSION, scope.businessId, scope.providerAccountId,
    scope.entityGrain, scope.entityId, scope.parentCampaignId ?? "-",
    input.ownerMode, input.budgetField, input.direction, String(input.percent),
    input.originDate, input.currency, String(input.currencyExponent),
    String(input.currentMinorUnits), String(input.proposedMinorUnits),
    input.sourceFingerprints.configStateHash,
    input.sourceFingerprints.ownerStateHash,
    input.sourceFingerprints.roleAuthorityHash,
  ].join("|");
  // Hashed so the key is fixed-width and carries no readable identity, while
  // staying a pure function of the operation: the same intent re-derived
  // tomorrow produces the same key.
  return `${META_BUDGET_INTENT_CONTRACT_VERSION}:${createHash("sha256").update(operation).digest("hex")}`;
}

/**
 * Validates a budget intent, failing closed on every ambiguity.
 *
 * It returns EVERY rejection it finds rather than the first, so a caller can
 * see the whole shape of what is missing instead of chasing one gate at a time.
 * The known-identity list is injected so this module never hard-codes a
 * business or account.
 */
export function validateBudgetIntent(
  input: BudgetIntentInput | unknown,
  knownBindings: ReadonlyArray<{ businessId: string; providerAccountId: string }> | unknown,
): BudgetIntentValidation {
  /*
    TOTAL AT THE BOUNDARY.

    `validateBudgetIntent(null, [])` threw `Cannot read properties of null
    (reading 'contractVersion')`. A function whose entire job is to decide
    whether an input is valid must never answer that question by throwing —
    a thrown error is not a rejection, it is the absence of a verdict, and
    every caller's error handling has to guess which it was.

    The parameter is `unknown` because the TypeScript annotation that used to
    stand here constrained nothing at runtime.
  */
  if (input === null || input === undefined || typeof input !== "object" || Array.isArray(input)) {
    return {
      status: "rejected",
      rejections: ["identity_unstable"],
      reasons: [`the intent input is ${input === undefined ? "absent" : JSON.stringify(input)}, not a map`],
    };
  }
  const typedInput = input as BudgetIntentInput;
  const typedBindings = knownBindings as ReadonlyArray<{ businessId: string; providerAccountId: string }>;
  return validateBudgetIntentMap(typedInput, typedBindings);
}

function validateBudgetIntentMap(
  input: BudgetIntentInput,
  knownBindings: ReadonlyArray<{ businessId: string; providerAccountId: string }>,
): BudgetIntentValidation {
  const rejections: BudgetIntentRejection[] = [];
  const reasons: string[] = [];
  const reject = (code: BudgetIntentRejection, why: string) => { rejections.push(code); reasons.push(why); };

  if (input.contractVersion !== META_BUDGET_INTENT_CONTRACT_VERSION) {
    reject("contract_version_unsupported", `contract ${JSON.stringify(input.contractVersion)} is not ${META_BUDGET_INTENT_CONTRACT_VERSION}`);
  }

  // --- composite scope ----------------------------------------------------
  const s = input.scope;
  if (!s?.businessId || !s?.providerAccountId || !s?.entityId) {
    reject("scope_identity_unknown", "the composite scope is incomplete");
  } else if (!Array.isArray(knownBindings)) {
    reject("identity_unstable", `the known-binding set is ${knownBindings === undefined ? "absent" : JSON.stringify(knownBindings)}, not an array`);
  } else if (!knownBindings.every((b) => b !== null && b !== undefined && typeof b === "object" && !Array.isArray(b))) {
    // A malformed ELEMENT threw `Cannot read properties of null` here. The
    // validator owns its own input: it names the defect and fails closed.
    reject("identity_unstable", "the known-binding set carries an element that is not a business/account map");
  } else if (!knownBindings.some((b) => b.businessId === s.businessId && b.providerAccountId === s.providerAccountId)) {
    // The PAIR must be known. Each half being separately valid proves nothing.
    reject("scope_identity_cross_paired", `${s.businessId}|${s.providerAccountId} is not a known business/account pair`);
  }
  if (!(BUDGET_OWNER_GRAINS as readonly string[]).includes(s?.entityGrain)) {
    reject("grain_unsupported", `grain ${JSON.stringify(s?.entityGrain)} cannot own a budget`);
  }
  if (s?.entityGrain === "adset" && !s.parentCampaignId) {
    reject("scope_identity_unknown", "an ad-set intent must name its parent campaign");
  }
  if (s?.entityGrain === "campaign" && s.parentCampaignId !== null) {
    reject("scope_identity_unknown", "a campaign intent must not name a parent campaign");
  }

  // --- owner mode and the mutable field -----------------------------------
  if (input.ownerMode === "unknown" || input.ownerMode === "not_applicable") {
    reject("owner_mode_ambiguous", `owner mode ${input.ownerMode} does not name an owning node`);
  } else if (input.ownerMode === "campaign_budget_optimization" && s?.entityGrain !== "campaign") {
    reject("owner_grain_mismatch", "campaign-budget optimisation owns the money at campaign grain, not ad set");
  } else if (input.ownerMode === "adset_budget" && s?.entityGrain !== "adset") {
    reject("owner_grain_mismatch", "an ad-set budget owns the money at ad-set grain, not campaign");
  }
  if (!(BUDGET_FIELDS as readonly string[]).includes(input.budgetField)) {
    reject("budget_field_unsupported", `${JSON.stringify(input.budgetField)} is not a mutable budget field`);
  }
  const daily = input.observedDailyMinorUnits;
  const lifetime = input.observedLifetimeMinorUnits;
  if (daily !== null && lifetime !== null) {
    reject("budget_field_ambiguous", "both daily and lifetime budgets are set; the target field is undecidable");
  }
  const current = input.budgetField === "daily_budget" ? daily : lifetime;
  if (current === null || current === undefined) {
    reject("current_value_missing", `no observed ${input.budgetField} to change`);
  } else if (!Number.isInteger(current)) {
    reject("current_value_not_integer_minor_units", `the observed amount ${JSON.stringify(current)} is not an integer of minor units`);
  }
  if (input.budgetField === "lifetime_budget") {
    const rawSch: unknown = input.lifetimeSchedule;
    if (rawSch !== null && rawSch !== undefined && (typeof rawSch !== "object" || Array.isArray(rawSch))) {
      reject("lifetime_schedule_invalid", `the lifetime schedule is ${JSON.stringify(rawSch)}, not a map`);
    }
    const sch = (rawSch !== null && typeof rawSch === "object" && !Array.isArray(rawSch)
      ? rawSch : null) as { startDate: string; endDate: string } | null;
    if (!sch || !isCalendarDate(sch.startDate) || !isCalendarDate(sch.endDate) || sch.startDate > sch.endDate) {
      reject("lifetime_schedule_invalid", "a lifetime budget requires a valid start and end date; remaining flight is otherwise unknowable");
    } else if (isCalendarDate(input.originDate) && sch.endDate < input.originDate) {
      reject("lifetime_schedule_invalid", "the lifetime schedule ended before this origin");
    }
  }

  // --- currency and units --------------------------------------------------
  const exponent = resolveMinorUnitExponent(input.accountCurrency);
  if (exponent.status === "retired_currency") {
    reject("currency_retired", `${exponent.currency}: ${exponent.reason}`);
  } else if (exponent.status !== "resolved") {
    reject("currency_exponent_unknown", `${String(exponent.currency)}: ${exponent.reason}`);
  }

  // --- magnitude ----------------------------------------------------------
  if (!(APPROVED_MAGNITUDE_PERCENTS as readonly number[]).includes(input.percent)) {
    reject("percent_unapproved_magnitude", `${input.percent}% is outside the approved ladder ${JSON.stringify(APPROVED_MAGNITUDE_PERCENTS)}`);
  }
  if (!(BUDGET_DIRECTIONS as readonly string[]).includes(input.direction)) {
    reject("percent_math_inconsistent", `direction ${JSON.stringify(input.direction)} is not increase or decrease`);
  }

  // --- clocks --------------------------------------------------------------
  for (const [field, value] of [
    ["originDate", input.originDate], ["effectiveAsOf", input.effectiveAsOf],
    ["knowledgeAsOf", input.knowledgeAsOf], ["authorityEvidenceAsOf", input.authorityEvidenceAsOf],
  ] as const) {
    if (!isCalendarDate(value)) reject("authority_evidence_stale", `${field} ${JSON.stringify(value)} is not a real calendar date`);
  }
  if (isCalendarDate(input.originDate)) {
    for (const [field, value] of [
      ["effectiveAsOf", input.effectiveAsOf], ["knowledgeAsOf", input.knowledgeAsOf],
      ["authorityEvidenceAsOf", input.authorityEvidenceAsOf],
    ] as const) {
      if (isCalendarDate(value) && value > input.originDate) {
        reject("authority_evidence_future", `${field} ${value} is after the origin ${input.originDate} and was not knowable there`);
      }
    }
    // ...and each must ALSO be at or before the intent's OWN knowledge cutoff.
    // Checking only the origin let `knowledgeAsOf: 2026-08-01` coexist with
    // effective and authority evidence dated 2026-08-31.
    if (isCalendarDate(input.knowledgeAsOf)) {
      for (const [field, value] of [
        ["effectiveAsOf", input.effectiveAsOf],
        ["authorityEvidenceAsOf", input.authorityEvidenceAsOf],
      ] as const) {
        if (isCalendarDate(value) && value > input.knowledgeAsOf) {
          reject("authority_evidence_future", `${field} ${value} is after the intent knowledge cutoff ${input.knowledgeAsOf} and was not known there`);
        }
      }
    }
    if (isCalendarDate(input.authorityEvidenceAsOf)) {
      const age = daysBetween(input.authorityEvidenceAsOf, input.originDate);
      if (age > input.maxAuthorityEvidenceAgeDays) {
        reject("authority_evidence_stale", `the authority evidence is ${age} days old, beyond the declared ${input.maxAuthorityEvidenceAgeDays}-day limit`);
      }
    }
  }
  // EXACTLY the canonical keys. `Object.entries({})` is empty, so r4 accepted
  // `sourceFingerprints: {}` as if every digest were present and valid.
  const CANONICAL_FINGERPRINT_KEYS = ["configStateHash", "ownerStateHash", "roleAuthorityHash"] as const;
  const rawFingerprints: unknown = input.sourceFingerprints;
  if (rawFingerprints === null || rawFingerprints === undefined
      || typeof rawFingerprints !== "object" || Array.isArray(rawFingerprints)) {
    reject("identity_unstable", `sourceFingerprints is ${rawFingerprints === undefined ? "absent" : JSON.stringify(rawFingerprints)}, not a map`);
  }
  const fingerprints = (
    rawFingerprints !== null && typeof rawFingerprints === "object" && !Array.isArray(rawFingerprints)
      ? rawFingerprints
      : {}
  ) as Record<string, unknown>;
  const seenKeys = Object.keys(fingerprints).sort();
  if (seenKeys.join("|") !== [...CANONICAL_FINGERPRINT_KEYS].sort().join("|")) {
    reject(
      "identity_unstable",
      `source fingerprints must be exactly {${CANONICAL_FINGERPRINT_KEYS.join(", ")}}, but the intent carries {${seenKeys.join(", ") || "nothing"}}`,
    );
  }
  for (const name of CANONICAL_FINGERPRINT_KEYS) {
    if (!isHex64(fingerprints[name])) {
      reject("identity_unstable", `source fingerprint ${name} is not a lowercase sha-256 digest`);
    }
  }

  // NOTE: the clocks block above already enforces that effectiveAsOf,
  // knowledgeAsOf and authorityEvidenceAsOf are real calendar days at or
  // before the origin. Re-checking them here would duplicate that rule — and
  // an earlier draft of this block inverted its own comparison, rejecting
  // evidence that was legitimately BEFORE the origin. The genuinely new
  // checks are the evidence window and the age bound.
  /*
    THE BLOCKER CONTAINER, as a closed world.

    r7 guarded this rule with `Array.isArray(...)`, so a NON-array simply
    skipped it — and construction below then ran `[...input.blockerCodes]`.
    `null`, `undefined`, `7` and `{}` threw `is not iterable`, and the string
    `"none"` was spread into the characters n/o/n/e and PREVIEWED. The exact
    array container is required here, before any length, join, spread or sort
    anywhere downstream.
  */
  const CANONICAL_AUTHORITY_STATUSES = ["authorised", "blocked", "not_determinable"] as const;
  if (!(CANONICAL_AUTHORITY_STATUSES as readonly string[]).includes(input.authorityStatus as string)) {
    reject("identity_unstable", `authorityStatus ${JSON.stringify(input.authorityStatus)} is not one of ${CANONICAL_AUTHORITY_STATUSES.join(" | ")}`);
  }
  if (!Array.isArray(input.blockerCodes)) {
    reject("identity_unstable", `blockerCodes is ${input.blockerCodes === undefined ? "absent" : JSON.stringify(input.blockerCodes)}, not an array; a non-array container is malformed evidence, never "no blockers"`);
  } else {
    for (const code of input.blockerCodes) {
      if (typeof code !== "string" || code.trim() === "") {
        reject("identity_unstable", `blockerCodes carries the non-string element ${JSON.stringify(code)}`);
      }
    }
    // An AUTHORISED intent cannot simultaneously carry blockers: those are two
    // contradictory claims about the same authority.
    if (input.authorityStatus === "authorised" && input.blockerCodes.length > 0) {
      reject("identity_unstable", `an authorised intent cannot carry blockers (${input.blockerCodes.join(", ")})`);
    }
  }
  // A daily budget has no flight. Carrying one is a contradiction, not extra detail.
  if (input.budgetField === "daily_budget" && input.lifetimeSchedule !== null && input.lifetimeSchedule !== undefined) {
    reject("lifetime_schedule_invalid", "a daily budget must not carry a lifetime schedule");
  }

  // EXACT map container. An array or a primitive has no `.from`, so r7 would
  // have reported "not a pair of real calendar days" for a shape error; the
  // container is now named for what it is.
  const rawWin: unknown = input.evidenceWindow;
  const winIsMap = rawWin !== null && rawWin !== undefined && typeof rawWin === "object" && !Array.isArray(rawWin);
  if (!winIsMap) {
    reject("identity_unstable", `the evidence window is ${rawWin === undefined ? "absent" : JSON.stringify(rawWin)}, not a map`);
  }
  const win = (winIsMap ? rawWin : null) as { from: string; to: string } | null;
  if (!win || !isCalendarDate(win.from) || !isCalendarDate(win.to)) {
    if (winIsMap) reject("identity_unstable", "the evidence window is not a pair of real calendar days");
  } else {
    if (daysBetween(win.from, win.to) < 0) {
      reject("identity_unstable", `the evidence window runs backwards (${win.from} to ${win.to})`);
    }
    if (isCalendarDate(input.originDate) && daysBetween(input.originDate, win.to) > 0) {
      reject("authority_evidence_future", `the evidence window ends (${win.to}) after the ${input.originDate} origin`);
    }
    if (isCalendarDate(input.knowledgeAsOf) && daysBetween(input.knowledgeAsOf, win.to) > 0) {
      reject("authority_evidence_future", `the evidence window ends (${win.to}) after the intent knowledge cutoff ${input.knowledgeAsOf}`);
    }
  }
  if (!Number.isFinite(input.maxAuthorityEvidenceAgeDays) || input.maxAuthorityEvidenceAgeDays < 0) {
    reject("identity_unstable", `maxAuthorityEvidenceAgeDays ${String(input.maxAuthorityEvidenceAgeDays)} is not a non-negative finite bound`);
  }

  if (rejections.length > 0) return { status: "rejected", rejections: [...new Set(rejections)].sort(), reasons };

  // --- arithmetic, only once everything above holds ------------------------
  const resolved = exponent as Extract<ExponentResolution, { status: "resolved" }>;
  const applied = applyPercentToMinorUnits(current as number, input.percent, input.direction);
  if (applied.status !== "ok") {
    const code: BudgetIntentRejection = applied.reason.includes("overflow") || applied.reason.includes("safe integer")
      ? "proposal_overflows_minor_units"
      : applied.reason.includes("zero") ? "proposal_not_positive" : "percent_math_inconsistent";
    return { status: "rejected", rejections: [code], reasons: [applied.reason] };
  }
  const currentUnits = current as number;
  const signed = input.direction === "increase" ? input.percent : -input.percent;
  const exactUnrounded = `${currentUnits * (100 + signed)}/100`;
  if (input.direction === "increase" && applied.minorUnits <= currentUnits) {
    return { status: "rejected", rejections: ["percent_math_inconsistent"], reasons: ["an increase did not raise the amount"] };
  }
  if (input.direction === "decrease" && applied.minorUnits >= currentUnits) {
    return { status: "rejected", rejections: ["percent_math_inconsistent"], reasons: ["a decrease did not lower the amount"] };
  }

  const key = budgetIntentKey({
    scope: s, budgetField: input.budgetField, direction: input.direction,
    percent: input.percent, originDate: input.originDate,
    currentMinorUnits: currentUnits, proposedMinorUnits: applied.minorUnits,
    ownerMode: input.ownerMode, currency: resolved.currency,
    currencyExponent: resolved.exponent, sourceFingerprints: input.sourceFingerprints,
  });
  return {
    status: "valid",
    intent: {
      contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
      intentKey: key, idempotencyKey: key,
      scope: s, ownerMode: input.ownerMode, budgetField: input.budgetField,
      direction: input.direction, percent: input.percent,
      currency: resolved.currency, currencyExponent: resolved.exponent,
      currencyRegistry: { version: ISO_4217_REGISTRY_VERSION, source: ISO_4217_REGISTRY_SOURCE },
      currentMinorUnits: currentUnits, proposedMinorUnits: applied.minorUnits,
      deltaMinorUnits: applied.minorUnits - currentUnits,
      rounding: { applied: applied.roundingApplied, rule: applied.roundingRule, exactUnrounded },
      originDate: input.originDate, effectiveAsOf: input.effectiveAsOf,
      knowledgeAsOf: input.knowledgeAsOf, authorityEvidenceAsOf: input.authorityEvidenceAsOf,
      sourceFingerprints: input.sourceFingerprints,
      evidenceWindow: input.evidenceWindow, targetSource: input.targetSource,
      authorityStatus: input.authorityStatus, blockerCodes: [...input.blockerCodes].sort(),
      // Validation is the ceiling. Nothing here contacts a provider.
      executionState: "validated_only",
      rollback: { priorMinorUnits: currentUnits, field: input.budgetField, operation: "restore_prior_amount" },
      readback: { field: input.budgetField, expectedMinorUnits: applied.minorUnits, independentRead: true },
      createdBy: { module: "lib/meta/budget-intent-contract", contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION },
    },
  };
}

type ExponentResolution = ReturnType<typeof resolveMinorUnitExponent>;

/**
 * A validated intent is not executable, and this is the function that says so.
 * `ad` is a decision grain but owns no budget, which is why the owner grains
 * are a strict subset of {@link DECISION_BOUND_GRAINS}.
 */
export function budgetIntentIsExecutable(): false {
  return false;
}

/**
 * D081 — the canonical integration point.
 *
 * Turns a validated intent into a `MetaOsDecisionAction`, the same shape the
 * decision surface already serves for every creative and ad action. This is
 * what makes the budget vocabulary part of the canonical output rather than a
 * detached type: a decision path can now return one.
 *
 * It is served as `review`, never `execute`, and carries `providerMutation:
 * null`, so nothing downstream can dispatch it.
 */
export function toCanonicalDecisionAction(
  intent: ValidatedBudgetIntent,
): MetaOsBudgetDecisionAction {
  // Lossless by construction: every binding on the validated intent travels
  // into the canonical payload. An earlier form copied fifteen fields and
  // dropped the scope, the clocks, the rounding provenance, the fingerprints
  // and the rollback/read-back contract, so a consumer could not inspect the
  // operation it was being shown.
  const budgetIntent: MetaOsBudgetIntentPayload = {
    kind: "budget_intent",
    contractVersion: intent.contractVersion,
    intentKey: intent.intentKey,
    idempotencyKey: intent.idempotencyKey,
    scope: intent.scope,
    ownerMode: intent.ownerMode,
    budgetField: intent.budgetField,
    direction: intent.direction,
    percent: intent.percent,
    currency: intent.currency,
    currencyExponent: intent.currencyExponent,
    currencyRegistry: intent.currencyRegistry,
    currentMinorUnits: intent.currentMinorUnits,
    proposedMinorUnits: intent.proposedMinorUnits,
    deltaMinorUnits: intent.deltaMinorUnits,
    rounding: intent.rounding,
    originDate: intent.originDate,
    effectiveAsOf: intent.effectiveAsOf,
    knowledgeAsOf: intent.knowledgeAsOf,
    authorityEvidenceAsOf: intent.authorityEvidenceAsOf,
    sourceFingerprints: intent.sourceFingerprints,
    evidenceWindow: intent.evidenceWindow,
    targetSource: intent.targetSource,
    authorityStatus: intent.authorityStatus,
    blockerCodes: intent.blockerCodes,
    executionState: intent.executionState,
    rollback: intent.rollback,
    readback: intent.readback,
    createdBy: intent.createdBy,
  };
  const action: MetaOsBudgetDecisionAction = {
    code: `budget_${intent.direction}_${intent.percent}`,
    label: `Review ${intent.direction === "increase" ? "raising" : "lowering"} the ${intent.budgetField === "daily_budget" ? "daily" : "lifetime"} budget by ${intent.percent}%`,
    // `review` and not `execute`: there is no endpoint, and a surface that
    // offered execution would be offering something that must fail.
    intent: "review",
    targetLevel: intent.scope.entityGrain,
    providerMutation: null,
    scopeNote: `${intent.scope.entityGrain} ${intent.scope.entityId} in ${intent.scope.providerAccountId}; validated only, not executable`,
    budgetIntent,
  };
  // The producer checks itself against the same runtime rule a consumer would.
  assertCanonicalDecisionAction(action);
  return action;
}

/** Fields the canonical payload must carry for every validated intent. */
export const CANONICAL_PAYLOAD_REQUIRED_FIELDS = [
  "kind", "contractVersion", "intentKey", "idempotencyKey", "scope", "ownerMode",
  "budgetField", "direction", "percent", "currency", "currencyExponent",
  "currencyRegistry", "currentMinorUnits", "proposedMinorUnits", "deltaMinorUnits",
  "rounding", "originDate", "effectiveAsOf", "knowledgeAsOf", "authorityEvidenceAsOf",
  "sourceFingerprints", "evidenceWindow", "targetSource", "authorityStatus",
  "blockerCodes", "executionState", "rollback", "readback", "createdBy",
] as const;

export const BUDGET_OWNER_GRAINS_ARE_DECISION_GRAINS: boolean =
  BUDGET_OWNER_GRAINS.every((g) => (DECISION_BOUND_GRAINS as readonly string[]).includes(g));

/*
  CANONICAL KEY SETS — D085 Correction 8. See the note in
  `provider-readback-contract.ts`: each set is guarded at compile time against
  the interface it describes, so the two cannot drift apart.
*/
export const BUDGET_INTENT_INPUT_KEYS = [
  "contractVersion", "scope", "ownerMode", "budgetField", "observedDailyMinorUnits",
  "observedLifetimeMinorUnits", "lifetimeSchedule", "direction", "percent", "accountCurrency",
  "originDate", "effectiveAsOf", "knowledgeAsOf", "authorityEvidenceAsOf",
  "maxAuthorityEvidenceAgeDays", "sourceFingerprints", "evidenceWindow", "targetSource",
  "authorityStatus", "blockerCodes",
] as const;
const _intentInputKeyGuard: Record<keyof BudgetIntentInput, true> = {
  contractVersion: true, scope: true, ownerMode: true, budgetField: true,
  observedDailyMinorUnits: true, observedLifetimeMinorUnits: true, lifetimeSchedule: true,
  direction: true, percent: true, accountCurrency: true, originDate: true, effectiveAsOf: true,
  knowledgeAsOf: true, authorityEvidenceAsOf: true, maxAuthorityEvidenceAgeDays: true,
  sourceFingerprints: true, evidenceWindow: true, targetSource: true, authorityStatus: true,
  blockerCodes: true,
};
void _intentInputKeyGuard;

export const BUDGET_INTENT_SCOPE_KEYS = [
  "businessId", "providerAccountId", "entityGrain", "entityId", "parentCampaignId",
] as const;
const _intentScopeKeyGuard: Record<keyof BudgetIntentScope, true> = {
  businessId: true, providerAccountId: true, entityGrain: true, entityId: true,
  parentCampaignId: true,
};
void _intentScopeKeyGuard;

export const SOURCE_FINGERPRINT_KEYS = ["configStateHash", "ownerStateHash", "roleAuthorityHash"] as const;
export const EVIDENCE_WINDOW_KEYS = ["from", "to"] as const;
export const LIFETIME_SCHEDULE_KEYS = ["startDate", "endDate"] as const;
export const TARGET_SOURCE_KEYS = ["source", "version"] as const;
export const KNOWN_BINDING_KEYS = ["businessId", "providerAccountId"] as const;
export const CANONICAL_AUTHORITY_STATUSES = ["authorised", "blocked", "not_determinable"] as const;
