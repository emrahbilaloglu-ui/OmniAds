/**
 * D085 — the canonical budget-proposal DRY RUN.
 *
 * WHAT THIS IS. One server-owned object that answers, for a single concrete
 * entity and direction: what exactly would we send to Meta, what is the exact
 * before-state, and what is still missing? It binds the D081 typed intent, the
 * D083 canonical budget fact, the D084 commercial/evidence/change-safety
 * verdicts, the automatic role context, the observed provider state and the
 * write-safety ceremony into one inspectable result.
 *
 * WHAT THIS IS NOT. It is not an engine, not a second decision authority, not
 * a queue, not a claim, and not a receipt. It computes no eligibility of its
 * own: `AccountDecisionProfile.hardActionEligibility` (read through the D084
 * gate) remains the sole commercial authority, and this module only reports
 * what that authority said. It never widens `MutationAction`, never adds a
 * budget endpoint, and imports no provider write adapter — `MUTATION_ENDPOINTS`
 * still has no budget action at any grain, so there is no route to call.
 *
 * FAIL-CLOSED. A would-write request is produced ONLY when every local gate
 * passes. Any unresolved fact yields a blocked result with ordered blockers and
 * a null request — never a partial request a reader could mistake for ready.
 *
 * The strongest state reachable here is `validated_only`.
 */

import { createHash } from "node:crypto";
import {
  exactMap,
  exactMapElement,
  exactVariant,
  isPlainMap,
  memberElement,
  checkCurrencyCode,
  checkCurrencyExponent,
  checkFingerprint,
  checkMinorUnits,
  checkNamespacedFingerprint,
  checkNonEmptyString,
  renderProblems,
  safeSnapshot,
  stringElement,
  typedArray,
  type SchemaProblem,
} from "@/lib/meta/runtime-schema";

import {
  BUDGET_OWNER_GRAINS,
  BUDGET_INTENT_INPUT_KEYS,
  BUDGET_INTENT_SCOPE_KEYS,
  EVIDENCE_WINDOW_KEYS,
  KNOWN_BINDING_KEYS,
  LIFETIME_SCHEDULE_KEYS,
  SOURCE_FINGERPRINT_KEYS,
  TARGET_SOURCE_KEYS,
  META_BUDGET_INTENT_CONTRACT_VERSION,
  budgetIntentIsExecutable,
  isHex64,
  validateBudgetIntent,
  type BudgetIntentInput,
  type BudgetDirection,
  type BudgetField,
  type BudgetOwnerGrain,
  type BudgetOwnerMode,
  type ValidatedBudgetIntent,
} from "@/lib/meta/budget-intent-contract";
import {
  META_PROVIDER_READBACK_CONTRACT,
  META_PROVIDER_READBACK_REJECTED_VERSIONS,
  PREFLIGHT_ATTEMPT_VARIANTS,
  PREFLIGHT_COMPARISON_KEYS,
  PREFLIGHT_DRIFT_DETAIL_KEYS,
  PREFLIGHT_MAX_AGE_SECONDS,
  PREFLIGHT_PROJECTION_KEYS,
  comparePreflight,
  readbackFingerprint,
  strictCalendarDay,
  strictInstant,
  validateProjection,
  type PreflightAttemptOutcome,
  type PreflightComparison,
  type PreflightProjection,
} from "@/lib/meta/provider-readback-contract";
import { WRITE_SAFETY_STEPS, type WriteSafetyStep } from "@/lib/meta/write-safety-contract";
import {
  AUTOMATIC_CAMPAIGN_ROLES,
  CANONICAL_ROLE_AUTHORITY_RULE,
  REQUIRED_KIND_SOURCE,
} from "@/lib/meta/campaign-role-authority";
import {
  campaignContextAuthorityResolverVersion,
  isCampaignContextResolverAuthorityValidated,
} from "@/lib/creative-decision-engine/campaign-context/source";
import { ISO_4217_REGISTRY_VERSION, resolveMinorUnitExponent } from "@/lib/currency/iso-4217-minor-units";
import {
  PIT_POLICY,
  checkPointInTimeOrder,
  upperBoundMs,
  type ClockUnderTest,
} from "@/lib/meta/point-in-time-policy";

/**
 * THE ONE CURRENT-REVISION SOURCE.
 *
 * The runtime proposal contract and the D085 audit artifact contract advance
 * together, one correction at a time. r15 declared that number twice — once
 * here as a string literal and once in the audit script — so the two could
 * drift silently. Both now derive from this single integer.
 */
export const D085_REVISION = 16 as const;

export const META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT = `meta.budget-proposal-dry-run.v${D085_REVISION}` as const;

/**
 * THE ONE LINEAGE SOURCE.
 *
 * r14 exported a hand-maintained list stuck at v1-v5 while the contract was
 * v14 and the artifact reported v1-v13 — three declarations of one truth, two
 * of them stale. The rejected set is DERIVED from the current version, so it
 * is contiguous by construction and cannot lag.
 *
 * INTERNAL. r15 exported this helper from the production runtime, where it
 * threw on malformed input and existed only to build two constants below.
 * Only the immutable derived constants are public.
 */
function contiguousRejectedVersions(current: number, stem: string): readonly string[] {
  return Object.freeze(Array.from({ length: current - 1 }, (_, i) => `${stem}.v${i + 1}`));
}

export const META_BUDGET_PROPOSAL_DRY_RUN_REJECTED_VERSIONS: readonly string[] =
  contiguousRejectedVersions(D085_REVISION, "meta.budget-proposal-dry-run");



/**
 * Blockers, in the order a reviewer should read them.
 *
 * Order is meaningful: identity before facts, facts before authority,
 * authority before safety, safety before provider state. A reader who fixes
 * them top-down never chases a downstream symptom of an upstream gap.
 */
export const DRY_RUN_BLOCKERS = [
  // identity
  "no_concrete_entity_selected",
  "no_direction_selected",
  "identity_incomplete",
  "account_not_write_scope",
  "grain_owns_no_budget",
  // canonical facts
  "budget_fact_unavailable",
  "budget_fact_not_canonical",
  "current_value_unknown",
  "currency_exponent_unknown",
  "owner_mode_unknown",
  "schedule_unknown",
  "role_context_unresolved",
  // authority
  "commercial_profile_unavailable",
  "commercial_action_ineligible",
  "evidence_floor_unmet",
  "change_safety_not_clear",
  "decision_absent",
  "decision_identity_incomplete",
  "decision_clock_invalid",
  "decision_clock_in_future",
  "decision_max_age_invalid",
  "decision_stale",
  // PIT / recorded-time discipline: nothing may be dated after the origin, and
  // nothing may be CAPTURED after the knowledge cutoff.
  "evidence_after_origin",
  "capture_after_knowledge_cutoff",
  "clock_ordering_invalid",
  // safety — proved blocked
  "kill_switch_engaged",
  "admission_blocked",
  "cap_exceeded",
  "cooldown_active",
  "conflict_lock_held",
  "cas_baseline_drifted",
  // safety — NOT PROVED EITHER WAY. Unknown is not clear.
  "kill_switch_unverified",
  "admission_unverified",
  "cap_unverified",
  "cooldown_unverified",
  "conflict_unverified",
  // provider state
  "provider_preflight_not_readable",
  "provider_state_drifted",
  // cross-binding: the same fact must be the same fact at every layer
  "scope_intent_identity_mismatch",
  "scope_baseline_identity_mismatch",
  "amount_binding_mismatch",
  "direction_intent_mismatch",
  "direction_action_mismatch",
  "budget_field_binding_mismatch",
  "owner_mode_binding_mismatch",
  "currency_binding_mismatch",
  "budget_fact_contract_unsupported",
  "intent_contract_unsupported",
  "intent_authority_not_authorised",
  "role_identity_unbound",
  "role_provenance_incoherent",
  "commercial_identity_unbound",
  "commercial_contract_unsupported",
  "decision_hash_not_canonical",
  "intent_clock_binding_mismatch",
  "intent_raw_input_missing",
  "intent_rejected_by_canonical_validator",
  "intent_not_canonically_equal",
  "capability_contract_invalid",
  "safety_state_unrecognised",
  // Closed-world runtime contract: a malformed boundary value is never a
  // preview and never an exception.
  "write_safety_ceremony_malformed",
  "role_authority_not_canonical",
  "commercial_verdict_incoherent",
  "budget_fact_provenance_incomplete",
  "currency_registry_not_canonical",
  "unit_confidence_not_exact",
  "runtime_boolean_not_literal",
  // A container that is the wrong SHAPE is not a boolean failure, and calling
  // it one was dishonest labelling. An array where a map is required, a map
  // where an array is required, a primitive, or a malformed element all land
  // here — never silently as "empty" and never as an exception.
  "input_container_malformed",
  // An extra key, a missing required key, a wrong discriminated-union variant,
  // or a mistyped collection element. Distinct from a wrong-shaped container:
  // the shape is right and the CONTENT is not what the contract declares.
  "input_schema_not_exact",
  // The input could not be safely OBSERVED at all: a hostile prototype, an
  // accessor, a symbol or non-enumerable own property, a Proxy trap that
  // threw, a cycle, or a JSON-incompatible value such as a BigInt. r9 threw
  // on each of these instead of returning a verdict.
  "input_not_observable",
  "lifetime_preview_unsupported",
  "safety_provenance_after_origin",
  "decision_after_origin",
  "preflight_contract_unsupported",
  "preflight_summary_contradictory",
  "preflight_baseline_fingerprint_mismatch",
  "preflight_observation_after_cutoff",
  "preflight_raw_evidence_missing",
  "preflight_summary_not_reproducible",
  "cas_baseline_semantically_invalid",
  // ceremony
  "write_safety_step_missing",
  "intent_not_validated",
  "no_provider_write_path_exists",
] as const;
export type DryRunBlocker = (typeof DRY_RUN_BLOCKERS)[number];

/** The only budget fields a would-write request may ever name. */
export const WOULD_WRITE_FIELD_ALLOWLIST: readonly BudgetField[] = ["daily_budget", "lifetime_budget"];

/**
 * The endpoint CLASS, not a callable route.
 *
 * A real path plus a token is a write. This names the Graph node class and the
 * single allowed field so a reviewer can check the shape, while carrying
 * nothing that could be dispatched.
 */
export const WOULD_WRITE_ENDPOINT_CLASS = "meta.graph.node_field_update" as const;

/** Preview keys live in their own namespace and can never reserve a real claim. */
export const PREVIEW_KEY_NAMESPACE = "d085-preview" as const;

/** The canonical budget-fact contract. An arbitrary non-null string is not one. */
export const CANONICAL_BUDGET_FACT_CONTRACT = "meta.budget-fact.v4" as const;

/** The canonical commercial-profile contract, per D079 C1/C2. */
export const CANONICAL_PROFILE_CONTRACT = "adsecute.account-decision-profile.v1" as const;

/** The server-owned direction-to-commercial-action mapping. */
export const DIRECTION_TO_CANONICAL_ACTION = { increase: "scale", decrease: "cut" } as const;

/**
 * Whether a budget write path exists at all.
 *
 * The first pass blocked on this unconditionally, which was correct but
 * untestable: no test could ever reach the preview branch. The gate is now an
 * explicit contract so a synthetic input can exercise the assembly while the
 * PRODUCTION value stays false, derived from the shipped dispatch table.
 */
export interface ProviderCapabilityContract {
  budgetEndpointExists: boolean;
  dispatchVerbExists: boolean;
  supportedFields: readonly BudgetField[];
  source: string;
  why: string;
}

export const PROVIDER_CAPABILITY_TODAY: ProviderCapabilityContract = {
  budgetEndpointExists: false,
  dispatchVerbExists: false,
  supportedFields: [],
  source: "lib/zero-base/meta/dispatch-contract.MUTATION_ENDPOINTS",
  why:
    "MutationAction is pause|resume|bid|duplicate and MUTATION_ENDPOINTS has no budget action at any grain, so no provider write path exists for a budget proposal",
};

/**
 * Runtime validation of the capability contract.
 *
 * r4 trusted typed booleans, so `{budgetEndpointExists: 1, dispatchVerbExists:
 * "yes", source: "", why: ""}` permitted a write.
 */
export function validateCapability(
  c: ProviderCapabilityContract,
  requestedField?: BudgetField,
): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  if (typeof c?.budgetEndpointExists !== "boolean") problems.push("budgetEndpointExists is not a boolean");
  if (typeof c?.dispatchVerbExists !== "boolean") problems.push("dispatchVerbExists is not a boolean");
  if (!Array.isArray(c?.supportedFields)) {
    problems.push("supportedFields is not an array");
  } else {
    for (const f of c.supportedFields) {
      if (!WOULD_WRITE_FIELD_ALLOWLIST.includes(f)) problems.push(`supportedFields names ${JSON.stringify(f)}, which is outside the allowlist`);
    }
    // When a caller names the field it intends to write, membership IS part of
    // validity for that request. r5 declared the parameter and never used it.
    if (requestedField !== undefined && !c.supportedFields.includes(requestedField)) {
      problems.push(`supportedFields does not include the requested field ${requestedField}`);
    }
  }
  if (typeof c?.source !== "string" || c.source.trim() === "") problems.push("the capability names no source");
  if (typeof c?.why !== "string" || c.why.trim() === "") problems.push("the capability carries no reason");
  return { valid: problems.length === 0, problems };
}

export function capabilityPermitsWrite(c: ProviderCapabilityContract): boolean {
  const { valid } = validateCapability(c);
  return valid && c.budgetEndpointExists === true && c.dispatchVerbExists === true && c.supportedFields.length > 0;
}

export interface RoleContext {
  /**
   * The canonical automatic campaign role — `test | main | mixed`.
   *
   * `scale` is a COMMERCIAL ACTION, not a campaign role; r5's own favourable
   * fixture carried `role: "scale"` with source `"automatic"` and resolver
   * `"v1"`, none of which the canonical D081 rule recognises.
   */
  role: string | null;
  /** Must be exactly `system_inferred`. A manual label or name never counts. */
  source: string | null;
  resolverVersion: string | null;
  confidence: string | null;
  asOf: string | null;
  /** The canonical D081 verdict, carried rather than re-derived. */
  satisfiesRoleAuthority?: boolean;
  authorityBlockers?: readonly string[];
  producer?: string | null;
  campaignId?: string | null;
  accountScoped: true;
  /**
   * The identity this role context was actually resolved FOR.
   *
   * `accountScoped: true` is a claim about shape, not about which account. A
   * role resolved for another account must never bind to this proposal.
   */
  businessId: string | null;
  providerAccountId: string | null;
  resolved: boolean;
  why: string;
}

export interface CanonicalBudgetFactBinding {
  contractVersion: string | null;
  available: boolean;
  /** Authoritative raw provider minor units; never a display value. */
  currentMinorUnits: number | null;
  budgetField: BudgetField | null;
  ownerMode: BudgetOwnerMode;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  observedAt: string | null;
  capturedAt: string | null;
  lineage: string;
  availabilityWhy: string;
}

export interface CommercialVerdictBinding {
  profileContractVersion: string | null;
  /** The identity this verdict was produced for; never inferred from scope. */
  businessId: string | null;
  providerAccountId: string | null;
  sourceStatus: string;
  selectedAction: string | null;
  eligible: boolean | null;
  code: string | null;
  reason: string | null;
  /** D084's ordered gate blockers, carried verbatim. */
  blockerCodes: readonly string[];
  evidenceFloorsClear: boolean | null;
  changeSafetyClear: boolean | null;
}

/**
 * One safety control's evidence — tri-state, sourced and as-of bound.
 *
 * The first pass typed these as plain booleans, so the live route wrote
 * `false` for controls it had never read and called that "not inflating the
 * blocker list". Unknown is not clear: a control nobody checked cannot clear a
 * proposal, and it must not be reported as a breach either.
 */
export type SafetyFlagState = "clear" | "engaged" | "unknown";

export interface SafetyFlag {
  state: SafetyFlagState;
  /** Where the evidence came from; null only when the state is unknown. */
  source: string | null;
  asOf: string | null;
  why: string;
}

export interface SafetyPosture {
  killSwitch: SafetyFlag;
  admission: SafetyFlag;
  cap: SafetyFlag;
  cooldown: SafetyFlag;
  conflict: SafetyFlag;
}

/** A control nobody read. Never `clear`. */
/**
 * The route's governance -> safety mapping, as a pure function.
 *
 * Extracted so the degradation paths are testable without standing up the
 * whole workspace handler. Governance READINESS is separate from the kill
 * switch: an unverified read or an unconfigured control proves nothing in
 * either direction.
 */
export function governanceToKillSwitchFlag(input: {
  killSwitchEngaged: boolean;
  killSwitchReason: string | null;
  verified: boolean;
  controlsConfigured: boolean;
  writeBlocked: boolean;
  blockReason: string | null;
  evaluatedAt: string;
}): SafetyFlag {
  // READINESS FIRST. r4 tested `killSwitchEngaged` before verification, so an
  // unverified, unconfigured read returned `engaged` with a source — the exact
  // opposite of this function's own contract.
  // Only a LITERAL boolean proves readiness. r5 accepted the string "yes".
  if (!isLiteralBoolean(input.verified) || !isLiteralBoolean(input.controlsConfigured) ||
      !isLiteralBoolean(input.killSwitchEngaged) || !isLiteralBoolean(input.writeBlocked)) {
    return unknownSafetyFlag(
      "the governance read carries non-boolean readiness fields, so it proves nothing in either direction",
    );
  }
  if (!input.verified) {
    return unknownSafetyFlag(
      `the effective write-governance read is unverified${input.blockReason ? ` (${input.blockReason})` : ""}, so the kill switch cannot be called clear`,
    );
  }
  if (!input.controlsConfigured) {
    return unknownSafetyFlag("no business write-control row is configured, so there is no kill-switch state to read");
  }
  if (input.killSwitchEngaged) {
    return engagedSafetyFlag(
      "readEffectiveMetaWriteGovernance", input.evaluatedAt,
      input.killSwitchReason ?? "the server-side kill switch is engaged",
    );
  }
  if (input.writeBlocked) {
    return engagedSafetyFlag(
      "readEffectiveMetaWriteGovernance", input.evaluatedAt,
      `writes are blocked by governance: ${input.blockReason ?? "unstated reason"}`,
    );
  }
  return clearSafetyFlag(
    "readEffectiveMetaWriteGovernance", input.evaluatedAt,
    "a verified governance read over a configured control reports the kill switch disengaged",
  );
}

/**
 * The route's admission -> safety mapping, as a pure function.
 *
 * An unavailable, missing, invalid or unevaluated dimension is not a proved
 * incident and not a clear fence.
 */
export function admissionToSafetyFlag(input: {
  status: string;
  allowed: boolean;
  reason: string;
  evaluatedAt: string | null;
  serverEvaluatedAt: string;
}): SafetyFlag {
  if (!isLiteralBoolean(input.allowed) || !isNonEmptyString(input.status)) {
    return unknownSafetyFlag(
      "the admission dimension carries a non-boolean allowance or no status, so it proves neither a clear fence nor an incident",
    );
  }
  const asOf = input.evaluatedAt && input.evaluatedAt.trim() !== "" ? input.evaluatedAt : input.serverEvaluatedAt;
  if (input.status === "blocked" && !input.allowed) {
    return engagedSafetyFlag("buildMetaDecisionPipelineHealth.admission", asOf, input.reason);
  }
  if ((input.status === "fresh" || input.status === "warning") && input.allowed) {
    return clearSafetyFlag("buildMetaDecisionPipelineHealth.admission", asOf, input.reason);
  }
  return unknownSafetyFlag(
    `the admission dimension is ${input.status}, so it proves neither a clear fence nor an incident: ${input.reason}`,
  );
}

export function unknownSafetyFlag(why: string): SafetyFlag {
  return { state: "unknown", source: null, asOf: null, why };
}
export function clearSafetyFlag(source: string, asOf: string | null, why: string): SafetyFlag {
  return { state: "clear", source, asOf, why };
}
export function engagedSafetyFlag(source: string, asOf: string | null, why: string): SafetyFlag {
  return { state: "engaged", source, asOf, why };
}

export interface DryRunInput {
  contractVersion: string;
  /** Decision identity. */
  decision: {
    id: string | null;
    hash: string | null;
    version: string | null;
    decidedAt: string | null;
    maxAgeSeconds: number;
  };
  scope: {
    businessId: string;
    business: string;
    providerAccountId: string;
    entityGrain: BudgetOwnerGrain | null;
    entityId: string | null;
    parentCampaignId: string | null;
    /** A deselected account is read-only and never write scope. */
    accountIsWriteScope: boolean;
    accountSelectionWhy: string;
  };
  direction: BudgetDirection | null;
  percent: number | null;
  accountCurrency: string | null;
  currencyExponent: number | null;
  currencyRegistryVersion: string | null;
  unitConfidence: "exact" | "inferred" | "unknown";
  role: RoleContext;
  budgetFact: CanonicalBudgetFactBinding;
  commercial: CommercialVerdictBinding;
  safety: SafetyPosture;
  /**
   * The RAW intent input. This is the authority.
   *
   * r4 accepted a `ValidatedBudgetIntent` cast and hand-checked a subset, so a
   * forged proposed amount, exponent, clock set, fingerprint object, identity
   * key and evidence window all reached a preview with an empty blocker list.
   * The builder now runs `validateBudgetIntent` on this raw input and uses only
   * the canonical result.
   */
  rawIntent: BudgetIntentInput | null;
  /** Known business/account bindings, from real evidence — never self-mirrored. */
  knownBindings: ReadonlyArray<{ businessId: string; providerAccountId: string }>;
  /** Optional caller claim. Accepted only on canonical full equality. */
  intent: ValidatedBudgetIntent | null;
  intentRejections: readonly string[];
  /** Baseline the CAS precondition is taken against. */
  casBaseline: PreflightProjection | null;
  /**
   * The caller's comparison SUMMARY plus the raw evidence to re-verify it.
   *
   * A summary alone is a claim: r2 accepted `matchesBaseline: true` alongside
   * `fresh: false`, `projectionComplete: false` and `rejections: ["read_stale"]`.
   */
  preflight: PreflightComparison | null;
  preflightEvidence: {
    /** The RAW provider attempt. The builder re-runs the comparison on it. */
    rawAttempt: PreflightAttemptOutcome | null;
    /** Server-owned evaluation instant. Never the caller's own claim. */
    evaluatedAt: string | null;
    /** Must equal `readbackFingerprint(casBaseline)` exactly. */
    baselineFingerprint: string | null;
  } | null;
  /** Write-safety steps this proposal can actually satisfy today. */
  writeSafety: Partial<Record<WriteSafetyStep, "satisfied" | "missing" | "not_applicable">>;
  /** Whether a provider write path exists. Production passes the real one. */
  capability: ProviderCapabilityContract;
  /** Clocks. Nothing after `originDate` may be used. */
  originDate: string;
  knowledgeAsOf: string;
}

export interface WouldWriteRequest {
  dryRun: true;
  endpointClass: typeof WOULD_WRITE_ENDPOINT_CLASS;
  /** The node class only — never a full URL, token, header or callable path. */
  nodeClass: "campaign" | "adset";
  /** Opaque provider entity id; the field being set and its exact value. */
  entityId: string;
  field: BudgetField;
  currentMinorUnits: number;
  proposedMinorUnits: number;
  currency: string;
  currencyExponent: number;
  /** Every field this request would touch. Nothing outside the allowlist. */
  fieldAllowlist: readonly BudgetField[];
  /** Absolute desired state, per the API-execution reference's preference. */
  valueSemantics: "absolute_desired_state";
  idempotencyKeyPreview: string;
  casPrecondition: { fingerprint: string; field: BudgetField; expectedMinorUnits: number };
  providerWriteAttempted: false;
  providerOutcome: "not_attempted";
  executable: false;
  notExecutableWhy: string;
}

export interface ReceiptPreview {
  dryRun: true;
  /** Namespaced so a preview can never collide with or reserve a real claim. */
  previewKey: string;
  previewKeyNamespace: typeof PREVIEW_KEY_NAMESPACE;
  isDurableReceipt: false;
  decisionId: string | null;
  scope: DryRunInput["scope"];
  before: { field: BudgetField; minorUnits: number };
  proposed: { field: BudgetField; minorUnits: number };
  currency: string;
  currencyExponent: number;
  actor: { classification: "system_dry_run"; module: string; humanApproval: null };
  casBaselineFingerprint: string;
  readbackFingerprint: string;
  gatesSatisfied: WriteSafetyStep[];
  gatesMissing: WriteSafetyStep[];
  rollbackPreview: { field: BudgetField; restoreMinorUnits: number; operation: "restore_prior_amount"; reversibilityClass: "R1" };
  redaction: { tokensIncluded: false; headersIncluded: false; fullUrlIncluded: false; piiIncluded: false };
  providerWriteAttempted: false;
  providerOutcome: "not_attempted";
  readbackClassification: "not_attempted";
  executionState: "validated_only";
  ctaEnabled: false;
  /**
   * SELF-CONTAINED proof.
   *
   * r4's hash covered the capability and input fingerprint but published
   * neither, so `recomputePreviewHash` needed hidden caller state. The receipt
   * now carries its own input fingerprint and a versioned capability
   * fingerprint, so a verifier holding only the request and receipt can
   * recompute the hash.
   */
  receiptHash?: string;
  previewContractVersion?: typeof PREVIEW_CONTRACT_VERSION;
  inputFingerprint?: string;
  capabilityFingerprint?: string;
  /**
   * The COMPLETE sanitized capability, not a two-field excerpt.
   *
   * r6 published only `supportedFields` and `source`, so the fingerprint —
   * which also covers both booleans and `why` — could not be recomputed from
   * the receipt. A forged snapshot therefore self-verified: nothing ever
   * compared the published capability against the hashed one.
   */
  capabilitySnapshot?: SanitizedCapabilitySnapshot;
  /*
    THE DERIVATION SEED — new in receipt v9.

    r11 classified `previewKey` and `idempotencyKeyPreview` as `derivable`
    while the receipt carried nothing to derive them FROM, so a different
    well-formed value verified exactly as well as the right one. v9 publishes
    the DIGEST of each durable key, which is enough to recompute both preview
    keys and not enough to reconstruct or reserve a durable claim.
  */
  keySeed?: { intentKeyDigest: string; idempotencyKeyDigest: string };
}

/** A versioned fingerprint of the exact capability a preview was assembled under. */
export function capabilityFingerprint(c: ProviderCapabilityContract | unknown): string {
  const observation = safeSnapshot(c, "capability");
  if (!observation.ok) return UNOBSERVABLE_HASH(renderProblems(observation.problems));
  return capabilityFingerprintOfObserved(observation.value as unknown as ProviderCapabilityContract);
}

function capabilityFingerprintOfObserved(c: ProviderCapabilityContract): string {
  // TOTAL: an observed-but-shapeless object must not throw on `[...undefined]`.
  if (c === null || typeof c !== "object" || Array.isArray(c) || !Array.isArray((c as { supportedFields?: unknown }).supportedFields)) {
    return UNOBSERVABLE_HASH(`the capability is not a contract shape: ${JSON.stringify(c ?? null)}`);
  }
  /*
    ONE OBJECT, hashed and published.

    r7 hashed a SORTED but NOT de-duplicated caller object here while
    publishing a de-duplicated snapshot, so a capability carrying
    ["lifetime_budget","daily_budget","daily_budget"] assembled, published the
    promised ["daily_budget","lifetime_budget"], and then failed its own
    verifier: the receipt could not reproduce its own fingerprint. The
    fingerprint is now taken from exactly the sanitized snapshot that ships.
  */
  return `${PREVIEW_CONTRACT_VERSION}-cap:${sha(JSON.stringify(canonicalise(
    sanitizeCapabilitySnapshot(c) as unknown as Record<string, unknown>,
  )))}`;
}

/** The complete, sanitized capability a preview was assembled under. */
export interface SanitizedCapabilitySnapshot {
  budgetEndpointExists: boolean;
  dispatchVerbExists: boolean;
  /** Sorted and de-duplicated, so the snapshot has ONE canonical form. */
  supportedFields: readonly BudgetField[];
  source: string;
  why: string;
}

/** Sanitize a capability into its canonical published form. */
export function sanitizeCapabilitySnapshot(c: ProviderCapabilityContract): SanitizedCapabilitySnapshot {
  return {
    budgetEndpointExists: c.budgetEndpointExists,
    dispatchVerbExists: c.dispatchVerbExists,
    supportedFields: [...new Set(c.supportedFields)].sort(),
    source: c.source,
    why: c.why,
  };
}

/**
 * Verify a receipt preview from the request and receipt ALONE.
 *
 * Migration-safe: an older receipt that carries no proof envelope is reported
 * as unverifiable rather than treated as valid. The order matters — snapshot
 * shape, then the capability fingerprint recomputed FROM the published
 * snapshot, then requested-field membership, then the receipt hash. A receipt
 * re-hashed around a forged snapshot fails at the fingerprint step, before the
 * hash it was re-hashed to satisfy is ever recomputed.
 */
/**
 * THE CANONICAL REQUEST/RECEIPT SEMANTIC VALIDATOR.
 *
 * One place, not scattered partial checks. Correction 7 verified the
 * capability snapshot and a caller-recomputable SHA, and nothing about what
 * the request and receipt actually SAY — so forty-one self-consistent,
 * re-hashed forgeries verified as true, including `dryRun:false`,
 * `executable:true`, `providerOutcome:"succeeded"`, `isDurableReceipt:true`,
 * a human actor with an approval, redaction flags set true, and an extra
 * `accessToken` key on the request.
 *
 * Order matters and is deliberate: exact schema, then literal invariants,
 * then cross-bindings. Each layer assumes the previous one held, so a shape
 * error is never reported as a semantic one.
 *
 * WHAT THIS CANNOT DO. Every rule below is LOCALLY KNOWABLE — it can be
 * decided from the request and receipt themselves. Nothing here establishes
 * that this pair describes any particular real proposal, because a fully
 * coherent adversary can rewrite every mutually consistent field and recompute
 * the hash, producing something that is field-for-field a genuine receipt for
 * a different proposal. See `RECEIPT_VERIFICATION_GUARANTEE`.
 */
/**
 * THE MECHANICAL FIELD-COVERAGE LEDGER.
 *
 * Corrections 5-9 each closed the fields that had been reported and were each
 * defeated by the next unchecked one. This is the structural answer: every
 * request and receipt field is enumerated here with its DOMAIN and its
 * CLASSIFICATION, and a test fails when a field exists in the contract with no
 * entry. A new field cannot be added without declaring how it is checked.
 *
 *   - `derivable`   — reproducible from other published values; verification
 *                     recomputes it rather than trusting it;
 *   - `cross_bound` — must equal a value on the other artefact or in the CAS
 *                     baseline;
 *   - `literal`     — a fixed constant of a dry run;
 *   - `domain`      — free within a stated scalar domain;
 *   - `opaque`      — deliberately unconstrained, with the reason recorded.
 */
export type FieldClass =
  | "derivable"
  /** Form enforced exactly, but NOT recomputable from receipt-contained material. */
  | "attested_domain"
  | "cross_bound" | "literal" | "domain" | "opaque";

export interface FieldCoverageEntry {
  field: string;
  classification: FieldClass;
  domain: string;
}

/**
 * THE RECURSIVE DOTTED-PATH LEDGER.
 *
 * r11's ledger enumerated TOP-LEVEL keys only, so every nested container,
 * scalar and enum was uncovered — which is why ten in-domain substitutions in
 * nested positions verified. This one names every path, and
 * `enumerateSchemaPaths` below walks a genuine request/receipt to prove no
 * path exists without an entry.
 */
export const REQUEST_FIELD_COVERAGE: readonly FieldCoverageEntry[] = [
  { field: "dryRun", classification: "literal", domain: "exactly true" },
  { field: "endpointClass", classification: "literal", domain: "exactly the canonical node-field-update endpoint class" },
  { field: "nodeClass", classification: "cross_bound", domain: "campaign | adset, equal to the receipt scope grain" },
  { field: "entityId", classification: "cross_bound", domain: "non-empty string, equal to the receipt scope entity" },
  { field: "field", classification: "cross_bound", domain: "the write allowlist; equal to before/proposed/CAS/rollback field" },
  { field: "currentMinorUnits", classification: "cross_bound", domain: "non-negative safe integer, equal to receipt.before and CAS expected" },
  { field: "proposedMinorUnits", classification: "cross_bound", domain: "non-negative safe integer, equal to receipt.proposed, never equal to current" },
  { field: "currency", classification: "cross_bound", domain: "ISO-4217 registry entry, equal to the receipt currency" },
  { field: "currencyExponent", classification: "cross_bound", domain: "the registry exponent for the currency, equal to the receipt exponent" },
  { field: "fieldAllowlist", classification: "literal", domain: "exactly the canonical allowlist, IN ORDER" },
  { field: "fieldAllowlist[]", classification: "literal", domain: "each element a canonical budget field in canonical position" },
  { field: "valueSemantics", classification: "literal", domain: "exactly absolute_desired_state" },
  { field: "idempotencyKeyPreview", classification: "derivable", domain: "recomputed RELATIVE to the attested keySeed.idempotencyKeyDigest, plus receipt.inputFingerprint" },
  { field: "casPrecondition", classification: "cross_bound", domain: "exact map of three keys" },
  { field: "casPrecondition.fingerprint", classification: "attested_domain", domain: "meta.provider-readback.v4:<64hex>; equality with receipt.casBaselineFingerprint is receipt-internal, and the digest itself is not recomputable" },
  { field: "casPrecondition.field", classification: "cross_bound", domain: "equal to request.field" },
  { field: "casPrecondition.expectedMinorUnits", classification: "cross_bound", domain: "equal to request.currentMinorUnits" },
  { field: "providerWriteAttempted", classification: "literal", domain: "exactly false" },
  { field: "providerOutcome", classification: "literal", domain: "exactly not_attempted" },
  { field: "executable", classification: "literal", domain: "exactly false" },
  { field: "notExecutableWhy", classification: "domain", domain: "non-empty string" },
];

export const RECEIPT_FIELD_COVERAGE: readonly FieldCoverageEntry[] = [
  { field: "dryRun", classification: "literal", domain: "exactly true" },
  { field: "previewKey", classification: "derivable", domain: "recomputed RELATIVE to the attested keySeed.intentKeyDigest, plus inputFingerprint and scope identity" },
  { field: "previewKeyNamespace", classification: "literal", domain: "exactly the canonical preview key namespace" },
  { field: "isDurableReceipt", classification: "literal", domain: "exactly false" },
  { field: "decisionId", classification: "domain", domain: "null or a non-empty string" },
  { field: "scope", classification: "cross_bound", domain: "exact scope map" },
  { field: "scope.businessId", classification: "domain", domain: "non-empty business id" },
  { field: "scope.business", classification: "domain", domain: "non-empty business name" },
  { field: "scope.providerAccountId", classification: "domain", domain: "non-empty provider account id" },
  { field: "scope.entityGrain", classification: "domain", domain: "campaign | adset; an unrecognised grain rejects" },
  { field: "scope.entityId", classification: "cross_bound", domain: "non-empty, equal to request.entityId" },
  { field: "scope.parentCampaignId", classification: "cross_bound", domain: "null for campaign grain; non-empty for ad-set grain" },
  { field: "scope.accountIsWriteScope", classification: "literal", domain: "exactly true" },
  { field: "scope.accountSelectionWhy", classification: "domain", domain: "non-empty string" },
  { field: "before", classification: "cross_bound", domain: "exact amount map" },
  { field: "before.field", classification: "cross_bound", domain: "equal to request.field" },
  { field: "before.minorUnits", classification: "cross_bound", domain: "equal to request.currentMinorUnits" },
  { field: "proposed", classification: "cross_bound", domain: "exact amount map" },
  { field: "proposed.field", classification: "cross_bound", domain: "equal to request.field" },
  { field: "proposed.minorUnits", classification: "cross_bound", domain: "equal to request.proposedMinorUnits" },
  { field: "currency", classification: "cross_bound", domain: "registry entry, equal to request.currency" },
  { field: "currencyExponent", classification: "cross_bound", domain: "registry exponent, equal to request.currencyExponent" },
  { field: "actor", classification: "literal", domain: "exact actor map" },
  { field: "actor.classification", classification: "literal", domain: "exactly system_dry_run" },
  { field: "actor.module", classification: "literal", domain: "exactly the current D085 producer contract" },
  { field: "actor.humanApproval", classification: "literal", domain: "exactly null" },
  { field: "casBaselineFingerprint", classification: "attested_domain", domain: "meta.provider-readback.v4:<64hex>; equality with the request CAS fingerprint is receipt-internal, and the digest itself is not recomputable" },
  { field: "readbackFingerprint", classification: "attested_domain", domain: "meta.provider-readback.v4:<64hex>; no provider read has occurred, so any other valid digest is locally indistinguishable" },
  { field: "gatesSatisfied", classification: "literal", domain: "exactly the canonical ceremony, IN ORDER" },
  { field: "gatesSatisfied[]", classification: "literal", domain: "each element a canonical step in canonical position" },
  { field: "gatesMissing", classification: "literal", domain: "exactly empty for a would-write preview" },
  { field: "gatesMissing[]", classification: "literal", domain: "unreachable; the collection is empty" },
  { field: "rollbackPreview", classification: "cross_bound", domain: "exact rollback map" },
  { field: "rollbackPreview.field", classification: "cross_bound", domain: "equal to request.field" },
  { field: "rollbackPreview.restoreMinorUnits", classification: "cross_bound", domain: "equal to receipt.before.minorUnits" },
  { field: "rollbackPreview.operation", classification: "literal", domain: "exactly restore_prior_amount" },
  { field: "rollbackPreview.reversibilityClass", classification: "literal", domain: "exactly R1" },
  { field: "redaction", classification: "literal", domain: "exact redaction map" },
  { field: "redaction.tokensIncluded", classification: "literal", domain: "exactly false" },
  { field: "redaction.headersIncluded", classification: "literal", domain: "exactly false" },
  { field: "redaction.fullUrlIncluded", classification: "literal", domain: "exactly false" },
  { field: "redaction.piiIncluded", classification: "literal", domain: "exactly false" },
  { field: "providerWriteAttempted", classification: "literal", domain: "exactly false" },
  { field: "providerOutcome", classification: "literal", domain: "exactly not_attempted" },
  { field: "readbackClassification", classification: "literal", domain: "exactly not_attempted" },
  { field: "executionState", classification: "literal", domain: "exactly validated_only" },
  { field: "ctaEnabled", classification: "literal", domain: "exactly false" },
  { field: "receiptHash", classification: "derivable", domain: "recomputed from the request and receipt" },
  { field: "previewContractVersion", classification: "literal", domain: "exactly the current preview receipt contract" },
  { field: "inputFingerprint", classification: "attested_domain", domain: "exactly the current D085 contract namespace plus a lowercase 64-hex digest; NOT recomputable from receipt-contained material" },
  { field: "capabilityFingerprint", classification: "derivable", domain: "recomputed from the published capability snapshot" },
  { field: "capabilitySnapshot", classification: "cross_bound", domain: "exact capability map that permits the requested field" },
  { field: "capabilitySnapshot.budgetEndpointExists", classification: "literal", domain: "exactly true for a would-write receipt" },
  { field: "capabilitySnapshot.dispatchVerbExists", classification: "literal", domain: "exactly true for a would-write receipt" },
  { field: "capabilitySnapshot.supportedFields", classification: "cross_bound", domain: "sorted, de-duplicated, includes the requested field" },
  { field: "capabilitySnapshot.supportedFields[]", classification: "cross_bound", domain: "each element inside the write allowlist" },
  { field: "capabilitySnapshot.source", classification: "domain", domain: "non-empty string" },
  { field: "capabilitySnapshot.why", classification: "domain", domain: "non-empty string" },
  /*
    ATTESTED, NOT CROSS-BOUND — corrected in Correction 12.

    Codex changed BOTH digests, recomputed both preview keys from the new
    digests, recomputed the receipt hash, and verification returned true.
    Correction 11 called the seeds `cross_bound` and the keys "genuinely
    derivable", which was half true and therefore misleading: the keys derive
    RELATIVE TO these seeds, and the seeds themselves are attested. Rejecting a
    fully coherent seed substitution would require publishing the durable keys
    — which would let a preview reserve a durable claim — or a trust anchor.
    Neither exists, so the limitation is published instead of papered over.
  */
  { field: "keySeed", classification: "attested_domain", domain: "exact map of two attested seed digests" },
  { field: "keySeed.intentKeyDigest", classification: "attested_domain", domain: "lowercase 64-hex; previewKey derives RELATIVE to it; the digest itself is not independently verifiable" },
  { field: "keySeed.idempotencyKeyDigest", classification: "attested_domain", domain: "lowercase 64-hex; idempotencyKeyPreview derives RELATIVE to it; the digest itself is not independently verifiable" },
];

/**
 * Every dotted path present in a value, with `[]` standing for array elements.
 *
 * A ledger is only mechanical if something walks the real artefact and proves
 * no path is missing. This is that walk.
 */
export function enumerateSchemaPaths(value: unknown, prefix = ""): string[] {
  const out: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (path !== "") out.push(path);
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      if (node.length > 0) visit(node[0], `${path}[]`);
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      visit((node as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`);
    }
  };
  visit(value, prefix);
  return out;
}

/** The exact producer module a genuine D085 receipt names. */
export const D085_PRODUCER_MODULE = META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT;

export function validateWouldWriteSemantics(
  request: WouldWriteRequest,
  receipt: ReceiptPreview,
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const eq = (path: string, actual: unknown, expected: unknown, what: string) => {
    if (actual !== expected) {
      problems.push({ path, why: `${path} is ${JSON.stringify(actual ?? null)}, not ${what}` });
    }
  };

  // ---- 1. EXACT SCHEMA -------------------------------------------------
  const reqMap = exactMap(request, "request", WOULD_WRITE_REQUEST_KEYS, [], problems);
  const rcpMap = exactMap(receipt, "receipt", RECEIPT_REQUIRED_KEYS, RECEIPT_PROOF_KEYS, problems);
  if (reqMap) {
    exactMap(request.casPrecondition, "request.casPrecondition", CAS_PRECONDITION_KEYS, [], problems);
    typedArray(request.fieldAllowlist, "request.fieldAllowlist", memberElement(WOULD_WRITE_FIELD_ALLOWLIST), problems);
  }
  if (rcpMap) {
    exactMap(receipt.scope, "receipt.scope", DRY_RUN_SCOPE_KEYS, [], problems);
    exactMap(receipt.before, "receipt.before", AMOUNT_KEYS, [], problems);
    exactMap(receipt.proposed, "receipt.proposed", AMOUNT_KEYS, [], problems);
    exactMap(receipt.actor, "receipt.actor", ACTOR_KEYS, [], problems);
    exactMap(receipt.rollbackPreview, "receipt.rollbackPreview", ROLLBACK_KEYS, [], problems);
    exactMap(receipt.redaction, "receipt.redaction", REDACTION_KEYS, [], problems);
    typedArray(receipt.gatesSatisfied, "receipt.gatesSatisfied", memberElement(WRITE_SAFETY_STEPS), problems);
    typedArray(receipt.gatesMissing, "receipt.gatesMissing", memberElement(WRITE_SAFETY_STEPS), problems);
    if (receipt.capabilitySnapshot !== undefined) {
      exactMap(receipt.capabilitySnapshot, "receipt.capabilitySnapshot", CAPABILITY_SNAPSHOT_KEYS, [], problems);
    }
  }
  if (problems.length > 0) return problems;

  // ---- 1b. SCALAR DOMAINS ----------------------------------------------
  /*
    r9 checked that fields AGREED and never that any was a LEGAL value, so
    twelve internally coherent pairs verified as true: blank and numeric entity
    ids, a `banana` grain, `accountIsWriteScope:false`, blank identity, a
    NEGATIVE amount copied coherently through request/CAS/before/rollback,
    fractional minor units, a blank currency, a negative exponent, a blank
    actor module, a non-string decision id and an arbitrary readback
    fingerprint. Agreement about nonsense is still nonsense.
  */
  checkNonEmptyString(request.entityId, "request.entityId", problems, "a non-empty entity id");
  checkMinorUnits(request.currentMinorUnits, "request.currentMinorUnits", problems);
  checkMinorUnits(request.proposedMinorUnits, "request.proposedMinorUnits", problems);
  checkMinorUnits(request.casPrecondition.expectedMinorUnits, "request.casPrecondition.expectedMinorUnits", problems);
  /*
    THE REGISTRY, not a regex. r11 accepted `ZZZ` because currency was a shape
    check, and accepted exponent 3 for USD because the request and receipt
    merely agreed with each other.
  */
  checkCurrencyCode(request.currency, "request.currency", problems);
  checkCurrencyExponent(request.currencyExponent, "request.currencyExponent", problems);
  {
    const resolved = resolveMinorUnitExponent(request.currency);
    if (resolved.status !== "resolved") {
      problems.push({ path: "request.currency", why: `request.currency ${JSON.stringify(request.currency)} is not a supported ISO-4217 registry entry (${resolved.status})` });
    } else if (resolved.exponent !== request.currencyExponent) {
      problems.push({ path: "request.currencyExponent", why: `request.currencyExponent is ${JSON.stringify(request.currencyExponent)}, but the registry exponent for ${request.currency} is ${resolved.exponent}` });
    }
  }
  checkNamespacedFingerprint(request.casPrecondition.fingerprint, "request.casPrecondition.fingerprint", META_PROVIDER_READBACK_CONTRACT, problems);
  checkNonEmptyString(request.idempotencyKeyPreview, "request.idempotencyKeyPreview", problems);

  checkNonEmptyString(receipt.scope.entityId, "receipt.scope.entityId", problems, "a non-empty entity id");
  checkNonEmptyString(receipt.scope.businessId, "receipt.scope.businessId", problems, "a non-empty business id");
  checkNonEmptyString(receipt.scope.providerAccountId, "receipt.scope.providerAccountId", problems, "a non-empty provider account id");
  checkNonEmptyString(receipt.scope.accountSelectionWhy, "receipt.scope.accountSelectionWhy", problems);
  // A required identity/display field. Blank may not pass silently; the schema
  // does not model it as nullable.
  checkNonEmptyString(receipt.scope.business, "receipt.scope.business", problems, "a non-empty business name");
  if (!isMemberOf(receipt.scope.entityGrain, BUDGET_OWNER_GRAINS)) {
    problems.push({ path: "receipt.scope.entityGrain", why: `receipt.scope.entityGrain is ${JSON.stringify(receipt.scope.entityGrain)}, not one of ${BUDGET_OWNER_GRAINS.join(" | ")}` });
  }
  /*
    EXACT HIERARCHY PER GRAIN. r11 treated every non-campaign grain as an ad
    set and never checked the parent at all, so an ad-set receipt with a null
    `parentCampaignId` verified.
  */
  if (receipt.scope.entityGrain === "campaign") {
    if (receipt.scope.parentCampaignId !== null) {
      problems.push({ path: "receipt.scope.parentCampaignId", why: `a campaign-grain receipt must carry a null parentCampaignId, not ${JSON.stringify(receipt.scope.parentCampaignId)}` });
    }
  } else if (receipt.scope.entityGrain === "adset") {
    if (!isNonEmptyString(receipt.scope.parentCampaignId)) {
      problems.push({ path: "receipt.scope.parentCampaignId", why: `an ad-set-grain receipt must carry a non-empty parentCampaignId, not ${JSON.stringify(receipt.scope.parentCampaignId)}` });
    }
  }
  if (receipt.scope.accountIsWriteScope !== true) {
    problems.push({ path: "receipt.scope.accountIsWriteScope", why: `receipt.scope.accountIsWriteScope is ${JSON.stringify(receipt.scope.accountIsWriteScope)}; a would-write preview is only meaningful inside a write scope` });
  }
  checkMinorUnits(receipt.before.minorUnits, "receipt.before.minorUnits", problems);
  checkMinorUnits(receipt.proposed.minorUnits, "receipt.proposed.minorUnits", problems);
  checkMinorUnits(receipt.rollbackPreview.restoreMinorUnits, "receipt.rollbackPreview.restoreMinorUnits", problems);
  checkCurrencyCode(receipt.currency, "receipt.currency", problems);
  checkCurrencyExponent(receipt.currencyExponent, "receipt.currencyExponent", problems);
  checkNonEmptyString(receipt.actor.module, "receipt.actor.module", problems, "a non-empty module name");
  // EXACT PRODUCING CONTRACT, not "some namespaced hash". r11 accepted
  // `foreign.contract:<64hex>` on both CAS fingerprints and on the read-back.
  checkNamespacedFingerprint(receipt.casBaselineFingerprint, "receipt.casBaselineFingerprint", META_PROVIDER_READBACK_CONTRACT, problems);
  checkNamespacedFingerprint(receipt.readbackFingerprint, "receipt.readbackFingerprint", META_PROVIDER_READBACK_CONTRACT, problems);
  checkNonEmptyString(receipt.previewKey, "receipt.previewKey", problems);
  if (receipt.decisionId !== null && !(typeof receipt.decisionId === "string" && receipt.decisionId.trim() !== "")) {
    problems.push({ path: "receipt.decisionId", why: `receipt.decisionId is ${JSON.stringify(receipt.decisionId)}, neither null nor a non-empty string` });
  }
  for (const [path, value] of [
    ["receipt.previewContractVersion", receipt.previewContractVersion],
    ["receipt.inputFingerprint", receipt.inputFingerprint],
    ["receipt.capabilityFingerprint", receipt.capabilityFingerprint],
    // receiptHash is deliberately absent: see the hash-agnostic note in
    // `evaluateOwnedPair`. The verifier requires it; minting produces it.
  ] as ReadonlyArray<readonly [string, unknown]>) {
    checkNonEmptyString(value, path, problems);
  }
  /*
    ATTESTED, NOT DERIVABLE — stated honestly rather than claimed.

    `inputFingerprint`, `previewKey` and `idempotencyKeyPreview` are each a
    digest over material the receipt does NOT carry: the full dry-run input,
    and the canonical intent's `intentKey` / `idempotencyKey`. r11 classified
    them `derivable` and then only checked their shape, which is why rows
    33-35 passed: a DIFFERENT well-formed value is as acceptable as the right
    one when nothing recomputes it.

    Correction 11 does not pretend otherwise. Their form is enforced exactly,
    against the exact producing contract, and the limitation is published in
    `RECEIPT_VERIFICATION_GUARANTEE.nonRecomputableFields`. What CAN be
    recomputed — the mutual derivation between the two preview keys — is
    recomputed below.
  */
  checkNamespacedFingerprint(receipt.inputFingerprint, "receipt.inputFingerprint", META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT, problems);

  /*
    BOTH PREVIEW KEYS ARE NOW RECOMPUTED, not merely shape-checked.

    v9 publishes `keySeed`, so a substituted-but-well-formed `previewKey`
    (row 33) or `idempotencyKeyPreview` (row 34) no longer verifies: the
    recomputation disagrees.
  */
  {
    const seedProblems: SchemaProblem[] = [];
    const seed = exactMap(receipt.keySeed, "receipt.keySeed", ["intentKeyDigest", "idempotencyKeyDigest"], [], seedProblems);
    if (!seed) {
      problems.push(...seedProblems);
    } else {
      for (const key of ["intentKeyDigest", "idempotencyKeyDigest"] as const) {
        if (typeof seed[key] !== "string" || !/^[0-9a-f]{64}$/.test(seed[key] as string)) {
          problems.push({ path: `receipt.keySeed.${key}`, why: `receipt.keySeed.${key} is not a lowercase 64-hex digest` });
        }
      }
      if (problems.length === 0 && typeof receipt.inputFingerprint === "string") {
        const expectedPreviewKey = derivePreviewKey({
          inputFingerprint: receipt.inputFingerprint,
          intentKeyDigest: seed.intentKeyDigest as string,
          businessId: receipt.scope.businessId,
          providerAccountId: receipt.scope.providerAccountId,
          entityId: receipt.scope.entityId ?? "",
        });
        if (receipt.previewKey !== expectedPreviewKey) {
          problems.push({ path: "receipt.previewKey", why: "receipt.previewKey does not reproduce from the receipt's own seed, fingerprint and scope" });
        }
        const expectedIdem = previewIdempotencyKey(seed.idempotencyKeyDigest as string, receipt.inputFingerprint);
        if (request.idempotencyKeyPreview !== expectedIdem) {
          problems.push({ path: "request.idempotencyKeyPreview", why: "request.idempotencyKeyPreview does not reproduce from the receipt's own seed and fingerprint" });
        }
      }
    }
  }
  if (problems.length > 0) return problems;

  // A proposal that changes nothing is not a proposal.
  if (request.proposedMinorUnits === request.currentMinorUnits) {
    problems.push({ path: "request.proposedMinorUnits", why: `request.proposedMinorUnits equals the current ${request.currentMinorUnits}; a zero-change proposal is not a would-write request` });
  }

  // ---- 2. LITERAL INVARIANTS OF A DRY RUN ------------------------------
  // Not "usually false" — these are what the words "dry run" mean here, and
  // a receipt that contradicts any of them is asserting that a write happened.
  eq("request.dryRun", request.dryRun, true, "the literal true a dry run requires");
  eq("request.endpointClass", request.endpointClass, WOULD_WRITE_ENDPOINT_CLASS, `the canonical ${WOULD_WRITE_ENDPOINT_CLASS}`);
  eq("request.valueSemantics", request.valueSemantics, "absolute_desired_state", "absolute_desired_state");
  eq("request.providerWriteAttempted", request.providerWriteAttempted, false, "the literal false");
  eq("request.providerOutcome", request.providerOutcome, "not_attempted", "not_attempted");
  eq("request.executable", request.executable, false, "the literal false");
  if (!isMemberOf(request.nodeClass, ["campaign", "adset"] as const)) {
    problems.push({ path: "request.nodeClass", why: `request.nodeClass is ${JSON.stringify(request.nodeClass)}, not campaign or adset` });
  }
  if (!isMemberOf(request.field, WOULD_WRITE_FIELD_ALLOWLIST)) {
    problems.push({ path: "request.field", why: `request.field is ${JSON.stringify(request.field)}, outside the write allowlist` });
  }
  if (request.fieldAllowlist.length === 0) {
    problems.push({ path: "request.fieldAllowlist", why: "request.fieldAllowlist is empty, so it permits nothing and cannot be the list this request was built under" });
  }
  /*
    IN ORDER. r11 sorted BOTH sides before comparing, so a reversed allowlist
    verified — verification was canonicalising the very input it was judging.
  */
  if (JSON.stringify([...request.fieldAllowlist]) !== JSON.stringify([...WOULD_WRITE_FIELD_ALLOWLIST])) {
    problems.push({ path: "request.fieldAllowlist", why: `request.fieldAllowlist is [${[...request.fieldAllowlist].join(", ")}], not the canonical ordered [${[...WOULD_WRITE_FIELD_ALLOWLIST].join(", ")}]` });
  }
  if (!isNonEmptyString(request.notExecutableWhy)) {
    problems.push({ path: "request.notExecutableWhy", why: "request.notExecutableWhy is blank; a non-executable request must say why it is not executable" });
  }
  if (typeof request.idempotencyKeyPreview !== "string" || !new RegExp(`^${PREVIEW_KEY_NAMESPACE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-idem:[0-9a-f]{64}$`).test(request.idempotencyKeyPreview)) {
    problems.push({ path: "request.idempotencyKeyPreview", why: `request.idempotencyKeyPreview ${JSON.stringify(request.idempotencyKeyPreview)} is not the preview namespace ${PREVIEW_KEY_NAMESPACE}-idem: followed by a lowercase 64-hex digest` });
  }

  eq("receipt.dryRun", receipt.dryRun, true, "the literal true a dry run requires");
  eq("receipt.isDurableReceipt", receipt.isDurableReceipt, false, "the literal false; a preview is never a durable receipt");
  eq("receipt.previewKeyNamespace", receipt.previewKeyNamespace, PREVIEW_KEY_NAMESPACE, `the canonical ${PREVIEW_KEY_NAMESPACE}`);
  eq("receipt.actor.classification", receipt.actor.classification, "system_dry_run", "system_dry_run; a dry run has no human actor");
  // THE EXACT PRODUCER, not merely a non-empty string. r10 accepted
  // `arbitrary-module`, so a receipt could name any producer it liked.
  eq("receipt.actor.module", receipt.actor.module, D085_PRODUCER_MODULE, `exactly ${D085_PRODUCER_MODULE}`);
  eq("receipt.actor.humanApproval", receipt.actor.humanApproval, null, "null; a dry run carries no human approval");
  eq("receipt.providerWriteAttempted", receipt.providerWriteAttempted, false, "the literal false");
  eq("receipt.providerOutcome", receipt.providerOutcome, "not_attempted", "not_attempted");
  eq("receipt.readbackClassification", receipt.readbackClassification, "not_attempted", "not_attempted");
  eq("receipt.executionState", receipt.executionState, "validated_only", "validated_only");
  eq("receipt.ctaEnabled", receipt.ctaEnabled, false, "the literal false");
  eq("receipt.rollbackPreview.operation", receipt.rollbackPreview.operation, "restore_prior_amount", "restore_prior_amount");
  eq("receipt.rollbackPreview.reversibilityClass", receipt.rollbackPreview.reversibilityClass, "R1", "R1");
  for (const flag of REDACTION_KEYS) {
    eq(`receipt.redaction.${flag}`, (receipt.redaction as unknown as Record<string, unknown>)[flag], false,
      "the literal false; a preview never carries tokens, headers, full URLs or PII");
  }
  /*
    EXACT NAMESPACE **AND** EXACT FORM. r10 checked only the prefix, so a key
    that kept its namespace and ended in `anything` passed — the namespace was
    decorative rather than load-bearing.
  */
  if (typeof receipt.previewKey !== "string" || !new RegExp(`^${PREVIEW_KEY_NAMESPACE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[0-9a-f]{64}$`).test(receipt.previewKey)) {
    problems.push({ path: "receipt.previewKey", why: `receipt.previewKey ${JSON.stringify(receipt.previewKey)} is not the preview namespace ${PREVIEW_KEY_NAMESPACE}: followed by a lowercase 64-hex digest` });
  }
  if (!isNonEmptyString(receipt.casBaselineFingerprint)) {
    problems.push({ path: "receipt.casBaselineFingerprint", why: "receipt.casBaselineFingerprint is blank" });
  }
  if (!isNonEmptyString(receipt.readbackFingerprint)) {
    problems.push({ path: "receipt.readbackFingerprint", why: "receipt.readbackFingerprint is blank; a preview must state the projection an independent read would have to reproduce" });
  }

  // ---- 3. CROSS-BINDINGS: the two artefacts must describe ONE proposal --
  const expectedNodeClass = receipt.scope.entityGrain === "campaign" ? "campaign" : "adset";
  eq("request.nodeClass", request.nodeClass, expectedNodeClass, `${expectedNodeClass}, the grain the receipt scope names`);
  eq("request.entityId", request.entityId, receipt.scope.entityId, `the receipt scope entity ${JSON.stringify(receipt.scope.entityId)}`);
  eq("receipt.before.field", receipt.before.field, request.field, `the request field ${request.field}`);
  eq("receipt.proposed.field", receipt.proposed.field, request.field, `the request field ${request.field}`);
  eq("receipt.before.minorUnits", receipt.before.minorUnits, request.currentMinorUnits, `the request current amount ${request.currentMinorUnits}`);
  eq("receipt.proposed.minorUnits", receipt.proposed.minorUnits, request.proposedMinorUnits, `the request proposed amount ${request.proposedMinorUnits}`);
  eq("receipt.currency", receipt.currency, request.currency, `the request currency ${request.currency}`);
  eq("receipt.currencyExponent", receipt.currencyExponent, request.currencyExponent, `the request exponent ${request.currencyExponent}`);

  // CAS: the precondition must be the amount the receipt says it saw.
  eq("request.casPrecondition.field", request.casPrecondition.field, request.field, `the request field ${request.field}`);
  eq("request.casPrecondition.expectedMinorUnits", request.casPrecondition.expectedMinorUnits, request.currentMinorUnits, `the request current amount ${request.currentMinorUnits}`);
  eq("request.casPrecondition.fingerprint", request.casPrecondition.fingerprint, receipt.casBaselineFingerprint, "the receipt's own CAS baseline fingerprint");

  // Rollback must actually restore what was there.
  eq("receipt.rollbackPreview.field", receipt.rollbackPreview.field, request.field, `the request field ${request.field}`);
  eq("receipt.rollbackPreview.restoreMinorUnits", receipt.rollbackPreview.restoreMinorUnits, receipt.before.minorUnits, `the before amount ${receipt.before.minorUnits}`);

  // Ceremony: an exact partition, with nothing missing.
  // A would-write preview satisfies EVERY step, so gatesSatisfied is exactly
  // the canonical list IN ORDER and gatesMissing is empty. r11 sorted first.
  if (JSON.stringify([...receipt.gatesSatisfied]) !== JSON.stringify([...WRITE_SAFETY_STEPS])
      || receipt.gatesMissing.length !== 0) {
    problems.push({ path: "receipt.gatesSatisfied", why: `the write-safety gates are not the canonical ordered partition (satisfied=[${[...receipt.gatesSatisfied].join(", ")}], missing=[${[...receipt.gatesMissing].join(", ")}])` });
  } else if (receipt.gatesMissing.length > 0) {
    problems.push({ path: "receipt.gatesMissing", why: `a would-write preview requires every write-safety step satisfied, but {${receipt.gatesMissing.join(", ")}} are missing` });
  }
  return problems;
}

/**
 * The precise, honest statement of what verification establishes — and what it
 * does not. Published in the artifact and shown to readers, so "verified"
 * cannot be read as "authenticated".
 */
export const RECEIPT_VERIFICATION_GUARANTEE = {
  /**
   * Fields whose form is enforced exactly but which CANNOT be recomputed from
   * receipt-contained material. r11 called these `derivable` and checked only
   * their shape; the count is published rather than a "zero opaque fields"
   * claim that was not true.
   */
  nonRecomputableFields: [
    { field: "receipt.inputFingerprint", reason: "a digest over the whole dry-run input, which the receipt does not carry" },
    { field: "receipt.keySeed.intentKeyDigest", reason: "a digest of the durable intent key. The durable key is deliberately absent so a preview cannot reserve a durable claim, which also means the digest cannot be independently recomputed." },
    { field: "receipt.keySeed.idempotencyKeyDigest", reason: "a digest of the durable idempotency key, absent for the same reason and with the same consequence." },
    { field: "request.casPrecondition.fingerprint", reason: "a digest of a provider projection this code has never read. Only its namespace/form and its equality with the receipt's own casBaselineFingerprint are checked; no underlying projection exists to recompute it from." },
    { field: "receipt.casBaselineFingerprint", reason: "the same attested provider-projection digest, seen from the receipt side. Equality between the two published values is receipt-internal agreement, not agreement with a provider baseline." },
    { field: "receipt.readbackFingerprint", reason: "a digest of the projection an independent post-write read would have to reproduce. No such read has occurred and no projection is carried, so any other valid meta.provider-readback.v4 digest is indistinguishable locally." },
  ],
  establishes: [
    "exact schema: every map is exactly its canonical keys and every collection element is typed",
    "literal dry-run invariants: no provider attempt, no outcome, no read-back, non-durable, validated_only, CTA disabled, every redaction flag false, a system actor with no human approval, preview-namespaced keys",
    "cross-field semantics: request and receipt agree with each other and with the CAS baseline on grain, entity, field, amounts, currency, exponent, rollback and the write-safety partition",
    "capability permission: the published snapshot actually permits the write, by the same validators the builder used",
    "deterministic corruption detection: the canonical hash reproduces from the request and receipt",
    "key derivation RELATIVE TO ATTESTED SEEDS: both preview keys are recomputed from the receipt's published seed digests, fingerprint and scope, so an isolated preview-key substitution is rejected",
    "exact producing-contract namespaces: CAS and read-back fingerprints must be meta.provider-readback.v4, and the input fingerprint the current D085 contract. This establishes FORM and receipt-internal EQUALITY only — never agreement with a provider projection, which this code has never read",
    "registry-backed currency: the code resolves through the ISO-4217 registry and the exponent must be the registry's, not merely agreed between the two artefacts",
    "exact hierarchy per grain: a campaign carries a null parentCampaignId and an ad set a non-empty one; an unrecognised grain rejects",
    "canonical ORDER on every canonical collection; verification never sorts input into acceptance",
  ],
  doesNotEstablish: [
    "that receipt.inputFingerprint is the right digest. Its namespace and form are exact, but the receipt carries no material to recompute it from, so a different well-formed value cannot be distinguished locally.",
    "that any attested fingerprint holds the RIGHT digest. request.casPrecondition.fingerprint, receipt.casBaselineFingerprint and receipt.readbackFingerprint are opaque: a coherent replacement with any other valid meta.provider-readback.v4 digest is accepted, because no provider projection is carried to falsify it.",
    "that receipt.keySeed holds the RIGHT digests. A coherent substitution — both seed digests replaced and both preview keys recomputed from them — is accepted, because the durable keys that would falsify it are deliberately absent. Detecting it requires a server-held secret or an authoritative durable lookup; D085 has neither and does not claim to.",
    "authenticity or origin. The hash is an ordinary SHA-256 over the payload, not a signature. An actor who can edit the payload can recompute it, because that actor holds everything the verifier holds.",
    "that this request/receipt pair describes any particular real proposal. A fully coherent forgery — every mutually consistent field rewritten and re-hashed — is field-for-field a genuine receipt for a different proposal, and cannot be distinguished locally.",
  ],
  wouldRequire:
    "a server-held secret and a signature over the payload, or an authoritative lookup against a durable receipt store. Neither exists while automation is OFF and no durable receipt is ever written.",
} as const;

/**
 * THE ONE PRE-HASH ELIGIBILITY LAYER.
 *
 * r13 kept two rule sets: `recomputePreviewHash` ran
 * `validateWouldWriteSemantics` alone, while the receipt-contract check and
 * the whole capability permission / canonicality / fingerprint layer lived
 * separately inside the verifier. They drifted, so production hashing blessed
 * pairs the verifier rejected — a receipt whose own snapshot said no budget
 * endpoint exists still received a canonical `meta.budget-preview-receipt.v11:…`
 * hash, and so did one carrying a stale `v9` contract.
 *
 * Everything that makes a CURRENT would-write pair hash-eligible lives here,
 * once. Both callers consume this result.
 *
 * NON-RECURSIVE by construction: this layer never hashes. The hash comparison
 * is the verifier's final step, after eligibility has already passed.
 */
/**
 * THE ONE TOTAL BOUNDARY: observe the whole unknown wrapper, then decide.
 *
 * r14 split this in two. `verifyReceiptPreviewIntegrity` snapshotted the
 * wrapper and read its two properties; `recomputePreviewHash` exact-validated
 * the wrapper. A genuine pair plus one extra enumerable top-level key
 * therefore VERIFIED TRUE while recompute returned the sentinel — one input,
 * two answers, from the pair of functions whose agreement r13 asserted.
 *
 * And `evaluateHashEligibility` was exported while dereferencing its arguments
 * directly, so a revoked Proxy, a throwing getter or a stateful Proxy threw
 * straight out of a public boundary.
 *
 * This function accepts the whole `unknown` wrapper, takes ONE owned inert
 * snapshot, exact-validates the outer `{request, receipt}` map, runs every
 * nested rule, and returns the OWNED pair only when eligible. Both public APIs
 * and the assembly mint consume exactly this result. Nothing downstream ever
 * touches caller memory again.
 */
export interface HashEligibility {
  eligible: boolean;
  unverifiable: boolean;
  problems: string[];
  /** The owned, inert pair. Present only when `eligible`. */
  owned: { request: WouldWriteRequest; receipt: ReceiptPreview } | null;
}

export function evaluateHashEligibility(wrapper: unknown): HashEligibility {
  const refuse = (problems: string[], unverifiable = false): HashEligibility =>
    ({ eligible: false, unverifiable, problems, owned: null });

  // ONE observation. Everything after this reads owned plain data.
  const observation = safeSnapshot(wrapper, "hashInput");
  if (!observation.ok) {
    return refuse([`the input could not be safely observed as exact data: ${renderProblems(observation.problems)}`]);
  }
  const observed = observation.value;

  // EXACT OUTER WRAPPER — the schema r14's verifier never applied.
  const wrapperProblems: SchemaProblem[] = [];
  const outer = exactMap(observed, "hashInput", ["request", "receipt"], [], wrapperProblems);
  if (!outer) return refuse(wrapperProblems.map((x) => x.why).sort());

  const request = outer.request as WouldWriteRequest;
  const receipt = outer.receipt as ReceiptPreview;
  return evaluateOwnedPair(request, receipt);
}

/** The inner rules, over an already-owned pair. Never called with caller memory. */
function evaluateOwnedPair(
  request: WouldWriteRequest,
  receipt: ReceiptPreview,
): HashEligibility {
  const problems: string[] = [];
  const refuse = (ps: string[], unverifiable = false): HashEligibility =>
    ({ eligible: false, unverifiable, problems: ps, owned: null });

  // 1. The EXACT current receipt contract. An older or absent identifier is
  //    UNVERIFIABLE — never silently reinterpreted under the current rules.
  if (receipt?.previewContractVersion !== PREVIEW_CONTRACT_VERSION) {
    return refuse([`the receipt carries preview contract ${JSON.stringify(receipt?.previewContractVersion)}, not ${PREVIEW_CONTRACT_VERSION}; it cannot be verified rather than being valid`], true);
  }
  /*
    HASH-AGNOSTIC BY DESIGN.

    `receiptHash` is the value being minted, so requiring it here would make
    assembly unable to consult the very rules it must satisfy. Eligibility
    answers "is this pair one a canonical hash may be minted for"; the hash's
    PRESENCE and its comparison are the verifier's final step, and the only
    thing the three callers do not share.
  */
  for (const field of ["inputFingerprint", "capabilityFingerprint"] as const) {
    if (!isNonEmptyString(receipt[field])) problems.push(`the receipt carries no ${field}`);
  }

  // 2. Exact schemas, scalar domains, literals, cross-bindings, key derivation.
  const semantic = validateWouldWriteSemantics(request, receipt);
  if (semantic.length > 0) {
    return refuse([...problems, ...semantic.map((x) => x.why).sort()]);
  }

  // 3. The published capability snapshot: shape, canonicality, permission.
  const snap = receipt.capabilitySnapshot;
  if (snap === null || snap === undefined || typeof snap !== "object" || Array.isArray(snap)) {
    problems.push(`the receipt publishes no capability snapshot (${JSON.stringify(snap ?? null)})`);
    return refuse(problems);
  }
  if (!isLiteralBoolean(snap.budgetEndpointExists)) problems.push(`snapshot budgetEndpointExists is ${JSON.stringify(snap.budgetEndpointExists)}, not a literal boolean`);
  if (!isLiteralBoolean(snap.dispatchVerbExists)) problems.push(`snapshot dispatchVerbExists is ${JSON.stringify(snap.dispatchVerbExists)}, not a literal boolean`);
  if (!isNonEmptyString(snap.source)) problems.push("the snapshot names no capability source");
  if (!isNonEmptyString(snap.why)) problems.push("the snapshot carries no capability reason");
  if (!Array.isArray(snap.supportedFields)) {
    problems.push(`snapshot supportedFields is ${JSON.stringify(snap.supportedFields)}, not an array`);
    return refuse(problems);
  }
  for (const f of snap.supportedFields) {
    if (!WOULD_WRITE_FIELD_ALLOWLIST.includes(f)) problems.push(`the snapshot names ${JSON.stringify(f)}, which is outside the write allowlist`);
  }
  const canonicalFields = [...new Set(snap.supportedFields)].sort();
  if (JSON.stringify([...snap.supportedFields]) !== JSON.stringify(canonicalFields)) {
    problems.push("the snapshot's supportedFields are not sorted and de-duplicated, so it has no canonical form");
  }
  if (problems.length > 0) return refuse(problems);

  // 4. SEMANTIC PERMISSION. A would-write pair is a claim that a write path
  //    existed, so the snapshot must actually permit the write.
  if (snap.budgetEndpointExists !== true) {
    problems.push("the receipt claims a would-write request under a snapshot that says no budget endpoint exists");
  }
  if (snap.dispatchVerbExists !== true) {
    problems.push("the receipt claims a would-write request under a snapshot that says no dispatch verb exists");
  }
  if (snap.supportedFields.length === 0) {
    problems.push("the snapshot supports no fields at all, so it can permit no write");
  }
  const snapshotAsCapability = {
    budgetEndpointExists: snap.budgetEndpointExists,
    dispatchVerbExists: snap.dispatchVerbExists,
    supportedFields: snap.supportedFields,
    source: snap.source,
    why: snap.why,
  } as ProviderCapabilityContract;
  const snapshotValidity = validateCapability(snapshotAsCapability, request?.field);
  if (!snapshotValidity.valid) {
    problems.push(`the published snapshot is not a runtime-valid capability for ${JSON.stringify(request?.field)}: ${snapshotValidity.problems.join("; ")}`);
  }
  if (!capabilityPermitsWrite(snapshotAsCapability)) {
    problems.push("the published snapshot does not permit a write, so it cannot be the capability a would-write receipt was assembled under");
  }
  if (problems.length > 0) return refuse(problems);

  // 5. The published snapshot must reproduce the published fingerprint.
  if (capabilityFingerprint(snapshotAsCapability) !== receipt.capabilityFingerprint) {
    problems.push("the published capability snapshot does not reproduce the receipt's capability fingerprint");
  }
  // 6. The requested field must be permitted by that same snapshot.
  if (!WOULD_WRITE_FIELD_ALLOWLIST.includes(request?.field)) {
    problems.push(`the request would write ${JSON.stringify(request?.field)}, which is outside the write allowlist`);
  } else if (!snap.supportedFields.includes(request.field)) {
    problems.push(`the snapshot does not support the requested field ${request.field}`);
  }
  if (problems.length > 0) return refuse(problems);
  return { eligible: true, unverifiable: false, problems: [], owned: { request, receipt } };
}

export function verifyReceiptPreviewIntegrity(
  input: { request: WouldWriteRequest; receipt: ReceiptPreview } | unknown,
): { verified: boolean; problems: string[] } {
  /*
    THE SAME BOUNDARY `recomputePreviewHash` uses — wrapper schema included.

    r14 snapshotted the wrapper here and read its two properties without
    exact-validating it, while recompute DID validate it. A genuine pair plus
    one extra enumerable top-level key verified true and hashed to the
    sentinel: one input, two answers. There is no caller-specific precheck on
    either side now.
  */
  const eligibility = evaluateHashEligibility(input);
  if (!eligibility.eligible || eligibility.owned === null) {
    return { verified: false, problems: eligibility.problems };
  }
  // The hash PRESENCE and COMPARISON are the only steps the callers do not
  // share, which is what keeps the boundary non-recursive and lets assembly
  // consult the same rules before the hash exists. Owned data only.
  const { request, receipt } = eligibility.owned;
  if (!isNonEmptyString(receipt.receiptHash)) {
    return { verified: false, problems: ["the receipt carries no receiptHash"] };
  }
  if (canonicalPreviewHash({ request, receipt }) !== receipt.receiptHash) {
    return { verified: false, problems: ["the receipt hash does not reproduce from the request and receipt"] };
  }
  return { verified: true, problems: [] };
}

export type BudgetProposalDryRun =
  | {
      contractVersion: typeof META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT;
      status: "blocked";
      blockers: DryRunBlocker[];
      blockerDetail: Array<{ code: DryRunBlocker; why: string }>;
      wouldWriteRequest: null;
      receiptPreview: null;
      inputFingerprint: string;
      policyFingerprint: string;
      preflightFingerprint: string | null;
      executionState: "validated_only";
      executable: false;
      ctaEnabled: false;
      providerWriteAttempted: false;
      providerOutcome: "not_attempted";
      readbackClassification: "not_attempted";
    }
  | {
      contractVersion: typeof META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT;
      status: "would_write_available";
      blockers: [];
      blockerDetail: [];
      wouldWriteRequest: WouldWriteRequest;
      receiptPreview: ReceiptPreview;
      inputFingerprint: string;
      policyFingerprint: string;
      preflightFingerprint: string;
      executionState: "validated_only";
      executable: false;
      ctaEnabled: false;
      providerWriteAttempted: false;
      providerOutcome: "not_attempted";
      readbackClassification: "not_attempted";
    };

/** Order-insensitive digest of a small string list. */
function canonicalDigestOf(values: readonly string[]): string {
  return [...values].sort().join("|");
}

function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * ONE strict instant parser, shared with the read-back contract.
 *
 * r3 used `Date.parse` here too, so a decision or capture stamped
 * `2026-02-30` silently rolled into March and passed every clock gate.
 */
function instantOf(value: string | null | undefined): number | null {
  return strictInstant(value);
}

/** An instant, or a normalized calendar day. Provenance may legitimately be either. */
function instantOrDay(value: string | null | undefined): number | null {
  return strictInstant(value) ?? strictCalendarDay(value);
}

/** The exact policy this dry run was evaluated under. */
export const DRY_RUN_POLICY = {
  contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
  intentContract: META_BUDGET_INTENT_CONTRACT_VERSION,
  fieldAllowlist: WOULD_WRITE_FIELD_ALLOWLIST,
  endpointClass: WOULD_WRITE_ENDPOINT_CLASS,
  preflightMaxAgeSeconds: PREFLIGHT_MAX_AGE_SECONDS,
  requiredWriteSafetySteps: WRITE_SAFETY_STEPS,
  automation: "off",
  maximumReachableAuthority: "validated_only",
} as const;

export function dryRunPolicyFingerprint(): string {
  return `${META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT}:${sha(JSON.stringify(DRY_RUN_POLICY))}`;
}

function inputFingerprintOf(input: DryRunInput): string {
  // The COMPLETE normalized input, canonicalised.
  //
  // r3 hashed a hand-picked intent subset with ordinary `JSON.stringify`, so
  // `intent.idempotencyKey` — which changes the assembled request's
  // `idempotencyKeyPreview` — was absent, and key insertion order could move a
  // nominally stable digest. `canonicalise` sorts keys recursively and the
  // whole intent, capability, CAS projection, raw preflight evidence and
  // safety provenance are included.
  const canonical = JSON.stringify(canonicalise({
    contract: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
    decision: input.decision,
    scope: input.scope,
    direction: input.direction,
    percent: input.percent,
    currency: input.accountCurrency,
    exponent: input.currencyExponent,
    registry: input.currencyRegistryVersion,
    unitConfidence: input.unitConfidence,
    role: input.role,
    budgetFact: input.budgetFact,
    commercial: input.commercial,
    safety: input.safety,
    capability: input.capability,
    /** The WHOLE intent, not a subset — and the RAW input it derives from. */
    rawIntent: input.rawIntent,
    knownBindings: input.knownBindings,
    intent: input.intent,
    intentRejections: input.intentRejections,
    casBaseline: input.casBaseline,
    preflight: input.preflight,
    preflightEvidence: input.preflightEvidence,
    writeSafety: input.writeSafety,
    originDate: input.originDate,
    knowledgeAsOf: input.knowledgeAsOf,
  }));
  return `${META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT}:${sha(canonical)}`;
}

/**
 * Build the dry run.
 *
 * Every gate is evaluated — the function returns the COMPLETE ordered blocker
 * set rather than the first failure, because a reviewer needs the shape of
 * what is missing, not a one-at-a-time chase.
 */
/*
  D085's OWN canonical key sets, with compile-time drift guards.

  Correction 7 asserted exactness for these maps and never implemented it, so
  fifteen extra-key mutations previewed. They are declared once here, checked
  once by `exactMap`, and guarded against their interfaces below.
*/
export const DRY_RUN_INPUT_KEYS = [
  "contractVersion", "decision", "scope", "direction", "percent", "accountCurrency",
  "currencyExponent", "currencyRegistryVersion", "unitConfidence", "role", "budgetFact",
  "commercial", "safety", "rawIntent", "knownBindings", "intent", "intentRejections",
  "casBaseline", "preflight", "preflightEvidence", "writeSafety", "capability",
  "originDate", "knowledgeAsOf",
] as const;
const _dryRunInputKeyGuard: Record<keyof DryRunInput, true> = {
  contractVersion: true, decision: true, scope: true, direction: true, percent: true,
  accountCurrency: true, currencyExponent: true, currencyRegistryVersion: true,
  unitConfidence: true, role: true, budgetFact: true, commercial: true, safety: true,
  rawIntent: true, knownBindings: true, intent: true, intentRejections: true,
  casBaseline: true, preflight: true, preflightEvidence: true, writeSafety: true,
  capability: true, originDate: true, knowledgeAsOf: true,
};
void _dryRunInputKeyGuard;

export const DRY_RUN_SCOPE_KEYS = [
  "businessId", "business", "providerAccountId", "entityGrain", "entityId",
  "parentCampaignId", "accountIsWriteScope", "accountSelectionWhy",
] as const;
const _scopeKeyGuard: Record<keyof DryRunInput["scope"], true> = {
  businessId: true, business: true, providerAccountId: true, entityGrain: true,
  entityId: true, parentCampaignId: true, accountIsWriteScope: true, accountSelectionWhy: true,
};
void _scopeKeyGuard;

export const DRY_RUN_DECISION_KEYS = ["id", "hash", "version", "decidedAt", "maxAgeSeconds"] as const;
export const ROLE_CONTEXT_REQUIRED_KEYS = [
  "role", "source", "resolverVersion", "confidence", "asOf", "accountScoped",
  "businessId", "providerAccountId", "resolved", "why",
] as const;
/**
 * These four are OPTIONAL on the TypeScript interface for migration reasons,
 * and `validateRoleAuthority` requires every one of them for a canonical
 * authority. They are listed as optional here so a missing one is reported by
 * the AUTHORITY validator with its own honest reason, rather than as a schema
 * shape error.
 */
export const ROLE_CONTEXT_OPTIONAL_KEYS = [
  "satisfiesRoleAuthority", "authorityBlockers", "producer", "campaignId",
] as const;
const _roleKeyGuard: Record<keyof RoleContext, true> = {
  role: true, source: true, resolverVersion: true, confidence: true, asOf: true,
  satisfiesRoleAuthority: true, authorityBlockers: true, producer: true, campaignId: true,
  accountScoped: true, businessId: true, providerAccountId: true, resolved: true, why: true,
};
void _roleKeyGuard;

export const BUDGET_FACT_KEYS = [
  "contractVersion", "available", "currentMinorUnits", "budgetField", "ownerMode",
  "scheduleStart", "scheduleEnd", "observedAt", "capturedAt", "lineage", "availabilityWhy",
] as const;
const _factKeyGuard: Record<keyof CanonicalBudgetFactBinding, true> = {
  contractVersion: true, available: true, currentMinorUnits: true, budgetField: true,
  ownerMode: true, scheduleStart: true, scheduleEnd: true, observedAt: true,
  capturedAt: true, lineage: true, availabilityWhy: true,
};
void _factKeyGuard;

export const COMMERCIAL_KEYS = [
  "profileContractVersion", "businessId", "providerAccountId", "sourceStatus",
  "selectedAction", "eligible", "code", "reason", "blockerCodes", "evidenceFloorsClear",
  "changeSafetyClear",
] as const;
const _commercialKeyGuard: Record<keyof CommercialVerdictBinding, true> = {
  profileContractVersion: true, businessId: true, providerAccountId: true, sourceStatus: true,
  selectedAction: true, eligible: true, code: true, reason: true, blockerCodes: true,
  evidenceFloorsClear: true, changeSafetyClear: true,
};
void _commercialKeyGuard;

export const SAFETY_POSTURE_KEYS = ["killSwitch", "admission", "cap", "cooldown", "conflict"] as const;
const _postureKeyGuard: Record<keyof SafetyPosture, true> = {
  killSwitch: true, admission: true, cap: true, cooldown: true, conflict: true,
};
void _postureKeyGuard;

export const SAFETY_FLAG_KEYS = ["state", "source", "asOf", "why"] as const;
const _flagKeyGuard: Record<keyof SafetyFlag, true> = {
  state: true, source: true, asOf: true, why: true,
};
void _flagKeyGuard;

export const CAPABILITY_KEYS = [
  "budgetEndpointExists", "dispatchVerbExists", "supportedFields", "source", "why",
] as const;
const _capabilityKeyGuard: Record<keyof ProviderCapabilityContract, true> = {
  budgetEndpointExists: true, dispatchVerbExists: true, supportedFields: true,
  source: true, why: true,
};
void _capabilityKeyGuard;

export const PREFLIGHT_EVIDENCE_KEYS = ["rawAttempt", "evaluatedAt", "baselineFingerprint"] as const;

export const WOULD_WRITE_REQUEST_KEYS = [
  "dryRun", "endpointClass", "nodeClass", "entityId", "field", "currentMinorUnits",
  "proposedMinorUnits", "currency", "currencyExponent", "fieldAllowlist", "valueSemantics",
  "idempotencyKeyPreview", "casPrecondition", "providerWriteAttempted", "providerOutcome",
  "executable", "notExecutableWhy",
] as const;
const _requestKeyGuard: Record<keyof WouldWriteRequest, true> = {
  dryRun: true, endpointClass: true, nodeClass: true, entityId: true, field: true,
  currentMinorUnits: true, proposedMinorUnits: true, currency: true, currencyExponent: true,
  fieldAllowlist: true, valueSemantics: true, idempotencyKeyPreview: true,
  casPrecondition: true, providerWriteAttempted: true, providerOutcome: true,
  executable: true, notExecutableWhy: true,
};
void _requestKeyGuard;

export const CAS_PRECONDITION_KEYS = ["fingerprint", "field", "expectedMinorUnits"] as const;

export const RECEIPT_REQUIRED_KEYS = [
  "dryRun", "previewKey", "previewKeyNamespace", "isDurableReceipt", "decisionId", "scope",
  "before", "proposed", "currency", "currencyExponent", "actor", "casBaselineFingerprint",
  "readbackFingerprint", "gatesSatisfied", "gatesMissing", "rollbackPreview", "redaction",
  "providerWriteAttempted", "providerOutcome", "readbackClassification", "executionState",
  "ctaEnabled",
] as const;
/** The proof envelope. Absent on a legacy receipt, which is UNVERIFIABLE. */
export const RECEIPT_PROOF_KEYS = [
  "receiptHash", "previewContractVersion", "inputFingerprint", "capabilityFingerprint",
  "capabilitySnapshot", "keySeed",
] as const;
const _receiptKeyGuard: Record<keyof ReceiptPreview, true> = {
  dryRun: true, previewKey: true, previewKeyNamespace: true, isDurableReceipt: true,
  decisionId: true, scope: true, before: true, proposed: true, currency: true,
  currencyExponent: true, actor: true, casBaselineFingerprint: true, readbackFingerprint: true,
  gatesSatisfied: true, gatesMissing: true, rollbackPreview: true, redaction: true,
  providerWriteAttempted: true, providerOutcome: true, readbackClassification: true,
  executionState: true, ctaEnabled: true, receiptHash: true, previewContractVersion: true,
  inputFingerprint: true, capabilityFingerprint: true, capabilitySnapshot: true,
  keySeed: true,
};
void _receiptKeyGuard;

export const AMOUNT_KEYS = ["field", "minorUnits"] as const;
export const ACTOR_KEYS = ["classification", "module", "humanApproval"] as const;
export const ROLLBACK_KEYS = ["field", "restoreMinorUnits", "operation", "reversibilityClass"] as const;
export const REDACTION_KEYS = ["tokensIncluded", "headersIncluded", "fullUrlIncluded", "piiIncluded"] as const;
export const CAPABILITY_SNAPSHOT_KEYS = CAPABILITY_KEYS;

export function buildBudgetProposalDryRun(rawInput: DryRunInput | unknown): BudgetProposalDryRun {
  /*
    ONE OBSERVATION, TAKEN FIRST.

    r9 validated one property universe and hashed another, and threw outright
    on BigInt, cycles and hostile reflection. The whole input is snapshotted
    into plain data here, before any field is read and long before anything is
    canonicalised or hashed. Everything downstream sees the snapshot.
  */
  const observation = safeSnapshot(rawInput, "input");
  if (!observation.ok) {
    return blockedByObservation(observation.problems);
  }
  return buildFromObservedInput(observation.value as unknown as DryRunInput);
}

/** A deterministic blocked verdict for input that could not be safely observed. */
function blockedByObservation(problems: readonly SchemaProblem[]): BudgetProposalDryRun {
  const why = `the input could not be safely observed as exact data: ${renderProblems(problems)}`;
  return {
    contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
    status: "blocked",
    blockers: ["input_not_observable"],
    blockerDetail: [{ code: "input_not_observable", why }],
    wouldWriteRequest: null,
    receiptPreview: null,
    inputFingerprint: `${META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT}:${sha(why)}`,
    policyFingerprint: dryRunPolicyFingerprint(),
    preflightFingerprint: null,
    executionState: "validated_only",
    executable: false,
    ctaEnabled: false,
    providerWriteAttempted: false,
    providerOutcome: "not_attempted",
    readbackClassification: "not_attempted",
  };
}

function buildFromObservedInput(rawInput: DryRunInput): BudgetProposalDryRun {
  /*
    TOTALITY.

    A malformed boundary value must produce a deterministic blocked result, not
    an exception. r5 threw on a null `safety`, `capability`, `budgetFact`,
    `role` or `commercial` map. Missing sub-objects are replaced with
    unmistakably invalid stand-ins so every gate below still runs and reports.
  */
  const structural: string[] = [];
  const containerProblems: string[] = [];
  const need = <T,>(value: T | null | undefined, name: string, fallback: T): T => {
    // An ARRAY is not a canonical map. `typeof [] === "object"` let one
    // through as though it were the real thing.
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
      structural.push(`${name} is ${value === undefined ? "absent" : JSON.stringify(value)}`);
      return fallback;
    }
    return value;
  };
  /*
    THE ARRAY BOUNDARY.

    Correction 6 made the five safety children total and stopped there, so
    `commercial.blockerCodes`, `preflight.rejections` and
    `preflight.driftedFields` still reached `.length`, `.join` and spread as
    raw caller values and threw. Every collection this builder reads passes
    through here exactly once: a malformed container is RECORDED and replaced
    with an empty array, so downstream reads are total and the malformation is
    still reported as its own blocker rather than silently becoming "none".
  */
  const needArray = <T,>(value: unknown, name: string): T[] => {
    if (Array.isArray(value)) return value as T[];
    containerProblems.push(`${name} is ${value === undefined ? "absent" : JSON.stringify(value)}, not an array`);
    return [];
  };
  /** An exact map: not null, not a primitive, not an array. */
  const needMap = <T,>(value: unknown, name: string, fallback: T): T => {
    if (value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)) return value as T;
    containerProblems.push(`${name} is ${value === undefined ? "absent" : JSON.stringify(value)}, not a map`);
    return fallback;
  };

  const normalizeSafety = (
    raw: DryRunInput["safety"] | null | undefined,
    problems: string[],
  ): DryRunInput["safety"] | null => {
    const malformedContainer = raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw);
    if (malformedContainer) problems.push(`safety is ${raw === undefined ? "absent" : JSON.stringify(raw)}`);
    const out = {} as DryRunInput["safety"];
    for (const key of ["killSwitch", "admission", "cap", "cooldown", "conflict"] as const) {
      const flag = malformedContainer ? undefined : (raw as unknown as Record<string, unknown>)[key];
      if (flag === null || flag === undefined || typeof flag !== "object" || Array.isArray(flag)) {
        // r6 threw here. A malformed CHILD degrades to unknown like any other
        // unread control.
        problems.push(`safety.${key} is ${flag === undefined ? "absent" : JSON.stringify(flag)}`);
        out[key] = unknownSafetyFlag(`the ${key} control is absent or malformed, so it is unverified`);
      } else {
        out[key] = flag as SafetyFlag;
      }
    }
    return out;
  };

  const input: DryRunInput = {
    ...rawInput,
    scope: need(rawInput?.scope, "scope", {
      businessId: "", business: "", providerAccountId: "", entityGrain: null, entityId: null,
      parentCampaignId: null, accountIsWriteScope: false, accountSelectionWhy: "scope is absent",
    }),
    role: need(rawInput?.role, "role", {
      role: null, source: null, resolverVersion: null, confidence: null, asOf: null,
      accountScoped: true, businessId: null, providerAccountId: null, resolved: false,
      why: "the role context is absent",
    }),
    budgetFact: need(rawInput?.budgetFact, "budgetFact", {
      contractVersion: null, available: false, currentMinorUnits: null, budgetField: null,
      ownerMode: "unknown", scheduleStart: null, scheduleEnd: null, observedAt: null,
      capturedAt: null, lineage: "", availabilityWhy: "the budget fact is absent",
    }),
    commercial: need(rawInput?.commercial, "commercial", {
      profileContractVersion: null, businessId: null, providerAccountId: null,
      sourceStatus: "unknown", selectedAction: null, eligible: null, code: null, reason: null,
      blockerCodes: [], evidenceFloorsClear: null, changeSafetyClear: null,
    }),
    safety: normalizeSafety(rawInput?.safety, structural) as DryRunInput["safety"] ?? need(rawInput?.safety, "safety", {
      killSwitch: unknownSafetyFlag("the safety posture is absent"),
      admission: unknownSafetyFlag("the safety posture is absent"),
      cap: unknownSafetyFlag("the safety posture is absent"),
      cooldown: unknownSafetyFlag("the safety posture is absent"),
      conflict: unknownSafetyFlag("the safety posture is absent"),
    }),
    capability: need(rawInput?.capability, "capability", {
      budgetEndpointExists: false, dispatchVerbExists: false, supportedFields: [],
      source: "", why: "the capability contract is absent",
    }),
    decision: need(rawInput?.decision, "decision", {
      id: null, hash: null, version: null, decidedAt: null, maxAgeSeconds: 0,
    }),
    writeSafety: (rawInput?.writeSafety && typeof rawInput.writeSafety === "object" && !Array.isArray(rawInput.writeSafety))
      ? rawInput.writeSafety
      : (structural.push(`writeSafety is ${rawInput?.writeSafety === undefined ? "absent" : JSON.stringify(rawInput?.writeSafety)}`), {}),
    knownBindings: needArray(rawInput?.knownBindings, "knownBindings"),
  };

  /*
    EXACT SCHEMA, checked once, before anything reads a field.

    This runs BEFORE any predecessor validator, so malformed D085 input never
    reaches a frozen contract. Correction 7 asserted exactness and implemented
    it for a handful of maps; fifteen extra-key and malformed-element
    mutations previewed with an empty blocker list. The whole surface is now
    declared as key sets and checked by one mechanism.
  */
  const schemaProblems: SchemaProblem[] = [];
  /*
    Recording a schema problem is not enough on its own: the builder must also
    STOP handing the malformed value onward. Correction 7's boundary reported
    defects and then walked into the frozen `validateProjection`, which threw.
    A raw attempt that fails its schema is treated as absent evidence from
    here on — the schema blocker names the real defect, and the preflight gate
    blocks for the honest reason that nothing can be re-derived.
  */
  let rawAttemptUnusable = false;
  exactMap(rawInput, "input", DRY_RUN_INPUT_KEYS, [], schemaProblems);
  exactMap(rawInput?.scope, "scope", DRY_RUN_SCOPE_KEYS, [], schemaProblems);
  exactMap(rawInput?.decision, "decision", DRY_RUN_DECISION_KEYS, [], schemaProblems);
  exactMap(rawInput?.role, "role", ROLE_CONTEXT_REQUIRED_KEYS, ROLE_CONTEXT_OPTIONAL_KEYS, schemaProblems);
  exactMap(rawInput?.budgetFact, "budgetFact", BUDGET_FACT_KEYS, [], schemaProblems);
  exactMap(rawInput?.commercial, "commercial", COMMERCIAL_KEYS, [], schemaProblems);
  exactMap(rawInput?.capability, "capability", CAPABILITY_KEYS, [], schemaProblems);
  if (exactMap(rawInput?.safety, "safety", SAFETY_POSTURE_KEYS, [], schemaProblems)) {
    for (const flag of SAFETY_POSTURE_KEYS) {
      exactMap((rawInput.safety as unknown as Record<string, unknown>)[flag], `safety.${flag}`, SAFETY_FLAG_KEYS, [], schemaProblems);
    }
  }
  typedArray(rawInput?.knownBindings, "knownBindings", exactMapElement(KNOWN_BINDING_KEYS), schemaProblems);
  typedArray(rawInput?.intentRejections, "intentRejections", stringElement, schemaProblems);
  if (rawInput?.casBaseline !== null && rawInput?.casBaseline !== undefined) {
    exactMap(rawInput.casBaseline, "casBaseline", PREFLIGHT_PROJECTION_KEYS, [], schemaProblems);
  }
  if (rawInput?.preflight !== null && rawInput?.preflight !== undefined) {
    if (exactMap(rawInput.preflight, "preflight", PREFLIGHT_COMPARISON_KEYS, [], schemaProblems)) {
      typedArray(rawInput.preflight.rejections, "preflight.rejections", stringElement, schemaProblems);
      typedArray(rawInput.preflight.driftedFields, "preflight.driftedFields", stringElement, schemaProblems);
      typedArray(rawInput.preflight.driftDetail, "preflight.driftDetail",
        exactMapElement(PREFLIGHT_DRIFT_DETAIL_KEYS), schemaProblems);
    }
  }
  if (rawInput?.preflightEvidence !== null && rawInput?.preflightEvidence !== undefined) {
    if (exactMap(rawInput.preflightEvidence, "preflightEvidence", PREFLIGHT_EVIDENCE_KEYS, [], schemaProblems)) {
      const attempt = rawInput.preflightEvidence.rawAttempt;
      if (attempt !== null && attempt !== undefined) {
        const variant = exactVariant(attempt, "preflightEvidence.rawAttempt", "status",
          PREFLIGHT_ATTEMPT_VARIANTS as unknown as Record<string, { required: readonly string[] }>, schemaProblems);
        /*
          THE NESTED PROJECTION.

          Correction 7's inventory stopped at the attempt map. A `succeeded`
          attempt whose `projection` was null or missing still threw
          `Cannot read properties of null (reading 'providerAccountId')`
          inside the frozen `validateProjection`. It is checked HERE, at the
          D085 boundary, so the predecessor contract is never handed a
          malformed value and is never edited to survive one.
        */
        if (variant && variant.status === "succeeded") {
          if (!exactMap(variant.projection, "preflightEvidence.rawAttempt.projection",
              PREFLIGHT_PROJECTION_KEYS, [], schemaProblems)) {
            rawAttemptUnusable = true;
          }
        } else if (!variant) {
          rawAttemptUnusable = true;
        }
      }
    }
  }
  if (rawInput?.rawIntent !== null && rawInput?.rawIntent !== undefined) {
    if (exactMap(rawInput.rawIntent, "rawIntent", BUDGET_INTENT_INPUT_KEYS, [], schemaProblems)) {
      const ri = rawInput.rawIntent;
      exactMap(ri.scope, "rawIntent.scope", BUDGET_INTENT_SCOPE_KEYS, [], schemaProblems);
      exactMap(ri.sourceFingerprints, "rawIntent.sourceFingerprints", SOURCE_FINGERPRINT_KEYS, [], schemaProblems);
      exactMap(ri.evidenceWindow, "rawIntent.evidenceWindow", EVIDENCE_WINDOW_KEYS, [], schemaProblems);
      if (ri.lifetimeSchedule !== null && ri.lifetimeSchedule !== undefined) {
        exactMap(ri.lifetimeSchedule, "rawIntent.lifetimeSchedule", LIFETIME_SCHEDULE_KEYS, [], schemaProblems);
      }
      if (ri.targetSource !== null && ri.targetSource !== undefined) {
        exactMap(ri.targetSource, "rawIntent.targetSource", TARGET_SOURCE_KEYS, [], schemaProblems);
      }
      typedArray(ri.blockerCodes, "rawIntent.blockerCodes", stringElement, schemaProblems);
    }
  }
  if (isPlainMap(rawInput?.writeSafety)) {
    for (const step of Object.keys(rawInput.writeSafety)) {
      if (!(WRITE_SAFETY_STEPS as readonly string[]).includes(step)) {
        schemaProblems.push({ path: `writeSafety.${step}`, why: `writeSafety carries the unrecognised step ${JSON.stringify(step)}` });
      }
    }
  }

  /*
    NESTED COLLECTIONS, normalized once.

    These are read by `.length`, `.join`, spread and sort further down. Doing
    this here — rather than guarding each call site — is what stops the next
    unchecked site from being the next escape.
  */
  input.commercial = {
    ...input.commercial,
    blockerCodes: needArray(input.commercial?.blockerCodes, "commercial.blockerCodes"),
  };
  /*
    `role.authorityBlockers` is deliberately NOT normalized here.

    Replacing a malformed blocker container with `[]` would turn malformed
    evidence into an empty authority set — precisely the papering-over this
    correction forbids. `validateRoleAuthority` owns that field and already
    rejects any non-array, so it fails closed in its own validator with its own
    honest reason.
  */
  input.capability = {
    ...input.capability,
    supportedFields: needArray(input.capability?.supportedFields, "capability.supportedFields"),
  };
  input.intentRejections = needArray(input.intentRejections, "intentRejections");
  for (const [index, binding] of input.knownBindings.entries()) {
    if (binding === null || binding === undefined || typeof binding !== "object" || Array.isArray(binding)) {
      containerProblems.push(`knownBindings[${index}] is ${binding === undefined ? "absent" : JSON.stringify(binding)}, not a map`);
    } else if (!isNonEmptyString(binding.businessId) || !isNonEmptyString(binding.providerAccountId)) {
      containerProblems.push(`knownBindings[${index}] names no exact business/account pair`);
    }
  }
  if (input.preflight !== null && input.preflight !== undefined) {
    const pfMap = needMap<Record<string, unknown>>(input.preflight, "preflight", {});
    input.preflight = {
      ...(pfMap as unknown as NonNullable<DryRunInput["preflight"]>),
      rejections: needArray(pfMap.rejections, "preflight.rejections"),
      driftedFields: needArray(pfMap.driftedFields, "preflight.driftedFields"),
      driftDetail: needArray(pfMap.driftDetail, "preflight.driftDetail"),
    };
  }
  if (input.preflightEvidence !== null && input.preflightEvidence !== undefined) {
    const evMap = needMap<Record<string, unknown>>(input.preflightEvidence, "preflightEvidence", {});
    const rawAttempt = rawAttemptUnusable
      ? null
      : needMap<Record<string, unknown>>(evMap.rawAttempt, "preflightEvidence.rawAttempt", {});
    input.preflightEvidence = {
      ...(evMap as unknown as NonNullable<DryRunInput["preflightEvidence"]>),
      rawAttempt: rawAttempt as unknown as NonNullable<DryRunInput["preflightEvidence"]>["rawAttempt"],
    };
  }
  if (input.casBaseline !== null && input.casBaseline !== undefined) {
    needMap<Record<string, unknown>>(input.casBaseline, "casBaseline", {});
  }

  const blockers: DryRunBlocker[] = [];
  const detail: Array<{ code: DryRunBlocker; why: string }> = [];
  const block = (code: DryRunBlocker, why: string) => {
    if (!blockers.includes(code)) { blockers.push(code); detail.push({ code, why }); }
  };

  for (const problem of structural) {
    block("runtime_boolean_not_literal", `a required input section is malformed: ${problem}`);
  }
  for (const problem of containerProblems) {
    block("input_container_malformed", `a required container is the wrong shape: ${problem}`);
  }
  if (schemaProblems.length > 0) {
    block("input_schema_not_exact", `the input does not match its canonical schema: ${renderProblems(schemaProblems)}`);
  }
  const inputFingerprint = inputFingerprintOf(input);
  // Hoisted: the safety, decision and preflight sections all need these, and a
  // block-scoped declaration further down was used before assignment.
  const knowledgeMs = instantOf(input.knowledgeAsOf);
  const originMs = instantOf(`${input.originDate}T23:59:59.999Z`);
  const policyFingerprint = dryRunPolicyFingerprint();
  const preflightFingerprint = input.casBaseline ? readbackFingerprint(input.casBaseline) : null;

  // --- identity ---
  if (input.contractVersion !== META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT) {
    block("intent_not_validated", `input declares contract ${JSON.stringify(input.contractVersion)}, not ${META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT}`);
  }
  if (!input.scope.entityId || !input.scope.entityGrain) {
    block("no_concrete_entity_selected", "no concrete campaign or ad set is selected, so there is no entity to write to");
  }
  if (!input.direction) {
    block("no_direction_selected", "no increase/decrease direction is selected, so no proposal exists");
  }
  if (!input.scope.businessId || !input.scope.providerAccountId) {
    block("identity_incomplete", "the business/account identity is incomplete");
  }
  if (!input.scope.accountIsWriteScope) {
    block("account_not_write_scope", `this account is not write scope: ${input.scope.accountSelectionWhy}`);
  }
  if (input.scope.entityGrain !== null && input.scope.entityGrain !== "campaign" && input.scope.entityGrain !== "adset") {
    block("grain_owns_no_budget", `grain ${String(input.scope.entityGrain)} owns no budget`);
  }

  // --- closed-world runtime typing on the scope and fact booleans ---
  if (!isLiteralBoolean(input.scope.accountIsWriteScope)) {
    block("runtime_boolean_not_literal", `scope.accountIsWriteScope is ${JSON.stringify(input.scope.accountIsWriteScope)}, not a literal boolean`);
  }
  if (!isLiteralBoolean(input.budgetFact.available)) {
    block("runtime_boolean_not_literal", `budgetFact.available is ${JSON.stringify(input.budgetFact.available)}, not a literal boolean`);
  }
  // EXACT registry, always. `null` is not "unspecified but fine".
  if (input.currencyRegistryVersion !== CANONICAL_CURRENCY_REGISTRY_VERSION) {
    block("currency_registry_not_canonical", `the currency registry ${JSON.stringify(input.currencyRegistryVersion)} is not the canonical ${CANONICAL_CURRENCY_REGISTRY_VERSION}`);
  }
  if (!isMemberOf(input.unitConfidence, ["exact", "inferred", "unknown"] as const)) {
    block("unit_confidence_not_exact", `unitConfidence ${JSON.stringify(input.unitConfidence)} is not a recognised value`);
  } else if (input.unitConfidence !== REQUIRED_UNIT_CONFIDENCE) {
    block("unit_confidence_not_exact", `unitConfidence is ${input.unitConfidence}; only ${REQUIRED_UNIT_CONFIDENCE} may support a proposal`);
  }
  // A lifetime preview has no three-way flight binding to enforce, because the
  // D081 validated intent does not retain a schedule. Fail closed rather than
  // pretend the binding exists.
  if (input.budgetFact.budgetField === "lifetime_budget") {
    block("lifetime_preview_unsupported", "a lifetime-budget preview is not supported: the canonical validated intent retains no flight, so a daily/fact/CAS/intent schedule binding cannot be proved");
  }

  // --- canonical facts ---
  if (!input.budgetFact.available) {
    block("budget_fact_unavailable", `no canonical budget fact: ${input.budgetFact.availabilityWhy}`);
  }
  if (input.budgetFact.available === true) {
    const provenanceProblems: string[] = [];
    // NON-EMPTY IS NOT PROVENANCE. r9 accepted `capturedAt: "not-an-instant"`.
    for (const [field, value] of [
      ["observedAt", input.budgetFact.observedAt],
      ["capturedAt", input.budgetFact.capturedAt],
    ] as ReadonlyArray<readonly [string, string | null]>) {
      if (!isNonEmptyString(value)) provenanceProblems.push(`no ${field}`);
      else if (upperBoundMs(value) === null) provenanceProblems.push(`${field} ${JSON.stringify(value)} is not a strict instant or calendar day`);
    }
    if (!isNonEmptyString(input.budgetFact.lineage)) provenanceProblems.push("blank lineage");
    if (!isNonEmptyString(input.budgetFact.availabilityWhy)) provenanceProblems.push("blank availability reason");
    if (typeof input.budgetFact.currentMinorUnits === "number" &&
        (!Number.isInteger(input.budgetFact.currentMinorUnits) || input.budgetFact.currentMinorUnits <= 0)) {
      provenanceProblems.push(`a current amount of ${input.budgetFact.currentMinorUnits} is not a whole positive minor-unit value`);
    }
    if (provenanceProblems.length > 0) {
      block("budget_fact_provenance_incomplete", `an available canonical budget fact is missing provenance: ${provenanceProblems.join("; ")}`);
    }
  }
  if (input.budgetFact.available && input.budgetFact.contractVersion === null) {
    block("budget_fact_not_canonical", "the budget fact carries no canonical contract version");
  }
  if (input.budgetFact.currentMinorUnits === null) {
    block("current_value_unknown", "the current provider-unit budget value is not retained, so no delta can be computed");
  }
  if (input.currencyExponent === null || input.unitConfidence === "unknown") {
    block("currency_exponent_unknown", "the account currency minor-unit exponent is not established, so a raw value would be off by an uncaptured power of ten");
  }
  if (input.budgetFact.ownerMode === "unknown") {
    block("owner_mode_unknown", "the budget owner mode is unknown, so which entity actually owns the budget is undetermined");
  }
  if (input.budgetFact.budgetField === "lifetime_budget" && (!input.budgetFact.scheduleStart || !input.budgetFact.scheduleEnd)) {
    block("schedule_unknown", "a lifetime budget without a retained flight cannot have remaining exposure computed");
  }
  if (!input.role.resolved) {
    block("role_context_unresolved", `automatic role context is unresolved: ${input.role.why}`);
  }

  // --- authority (D084 is the sole commercial authority; nothing is re-derived) ---
  if (input.commercial.sourceStatus !== "resolved") {
    block("commercial_profile_unavailable", `canonical profile source is ${input.commercial.sourceStatus}, so no commercial eligibility may be stated`);
  } else if (input.commercial.eligible !== true) {
    block("commercial_action_ineligible", `the canonical profile reports ${input.commercial.selectedAction ?? "this action"} ineligible${input.commercial.code ? ` (${input.commercial.code})` : ""}`);
  }
  if (input.commercial.evidenceFloorsClear !== true) {
    block("evidence_floor_unmet", `evidence floors are not clear${input.commercial.blockerCodes.length ? `: ${input.commercial.blockerCodes.join(", ")}` : ""}`);
  }
  if (input.commercial.changeSafetyClear !== true) {
    // A distinct code: "not proven clear" is not the same claim as "a cap was
    // exceeded", and labelling the first as the second would report a control
    // breach that no evidence establishes.
    block(
      "change_safety_not_clear",
      input.commercial.changeSafetyClear === null
        ? "change-safety controls are not_determinable for this proposal, so they cannot be called clear"
        : "change-safety controls are not clear for this proposal",
    );
  }
  // --- decision identity and clocks, fail-closed ---
  //
  // The first pass computed the age only when `Number.isFinite(age)`, so an
  // unparseable or future `decidedAt` skipped the gate entirely. Absent,
  // incomplete, invalid, future and stale stay five distinct labels.
  // Trimmed: r2 accepted "   " as an identity because whitespace is truthy.
  const decId = typeof input.decision.id === "string" ? input.decision.id.trim() : "";
  const decHash = typeof input.decision.hash === "string" ? input.decision.hash.trim() : "";
  const decVersion = typeof input.decision.version === "string" ? input.decision.version.trim() : "";
  if (decHash && !isHex64(decHash)) {
    // The execution-safety contract already requires lowercase 64-hex; r3
    // accepted "h".
    block("decision_hash_not_canonical", `the decision hash ${JSON.stringify(input.decision.hash)} is not a lowercase 64-hex digest`);
  }
  if (!decId || !decHash || !decVersion) {
    block(
      "decision_identity_incomplete",
      `the decision identity tuple is incomplete or blank (id=${JSON.stringify(input.decision.id)}, hash=${JSON.stringify(input.decision.hash)}, version=${JSON.stringify(input.decision.version)})`,
    );
  }
  if (!Number.isFinite(input.decision.maxAgeSeconds) || input.decision.maxAgeSeconds <= 0) {
    block("decision_max_age_invalid", `maxAgeSeconds ${String(input.decision.maxAgeSeconds)} is not a positive finite bound`);
  }
  if (input.decision.decidedAt === null) {
    block("decision_absent", "no decision timestamp is available, so decision freshness cannot be established");
  } else {
    const decidedMs = instantOf(input.decision.decidedAt);
    if (decidedMs === null) {
      block("decision_clock_invalid", `decidedAt ${JSON.stringify(input.decision.decidedAt)} is not a parseable instant`);
    } else if (knowledgeMs === null) {
      block("decision_clock_invalid", `knowledgeAsOf ${JSON.stringify(input.knowledgeAsOf)} is not a parseable instant, so decision age cannot be derived`);
    } else {
      if (originMs !== null && decidedMs > originMs) {
        block("decision_after_origin", `the decision (${input.decision.decidedAt}) is after the end of the ${input.originDate} origin day, so it was not knowable in this simulation`);
      }
      const age = (knowledgeMs - decidedMs) / 1000;
      if (age < 0) {
        block("decision_clock_in_future", `the decision is dated ${Math.abs(Math.round(age))}s after the knowledge cutoff`);
      } else if (Number.isFinite(input.decision.maxAgeSeconds) && input.decision.maxAgeSeconds > 0 && age > input.decision.maxAgeSeconds) {
        block("decision_stale", `the decision is ${Math.round(age)}s old, past the ${input.decision.maxAgeSeconds}s ceiling`);
      }
    }
  }

  // --- PIT / recorded-time discipline ---
  //
  // Nothing may be EFFECTIVE after the origin day, and nothing may be CAPTURED
  // after the knowledge cutoff. Both are leakage: they let a proposal be built
  // from evidence that did not exist when it claims to have been decided.
  if (originMs === null) {
    block("clock_ordering_invalid", `originDate ${JSON.stringify(input.originDate)} is not a parseable day`);
  }
  if (knowledgeMs === null) {
    block("clock_ordering_invalid", `knowledgeAsOf ${JSON.stringify(input.knowledgeAsOf)} is not a parseable instant`);
  }
  for (const [label, value] of [
    ["the role context as-of", input.role.asOf],
    ["the budget fact observation", input.budgetFact.observedAt],
  ] as ReadonlyArray<readonly [string, string | null]>) {
    if (value === null) continue;
    const ms = instantOf(value.length === 10 ? `${value}T00:00:00.000Z` : value);
    if (ms === null) block("clock_ordering_invalid", `${label} ${JSON.stringify(value)} is not a parseable instant`);
    else if (originMs !== null && ms > originMs) {
      block("evidence_after_origin", `${label} (${value}) is dated after the ${input.originDate} origin`);
    }
  }
  /*
    ONE POINT-IN-TIME POLICY, over EVERY clock the proposal rests on.

    r9 checked a handful of clocks against the origin, skipped any value it
    could not parse (`if (ms !== null && ...)`), and never related a date-only
    value to an instant cutoff. Both leaks are closed here: an unparseable
    non-empty timestamp BLOCKS, and every comparison is made at the COARSER of
    the two granularities — day-to-day whenever either side is date-only — so a
    2026-09-01 intent cannot sit behind a 2026-08-31T23:59:59.000Z cutoff.

    See `PIT_POLICY.dateOnlyInterpretation`, which is the single source of
    truth. An earlier draft of this comment described an end-of-day reading
    that the shipped policy never used; a consistency test now binds this
    prose to the constant so the two cannot drift again.
  */
  {
    const clocks: ClockUnderTest[] = [
      { path: "budgetFact.capturedAt", label: "the budget fact capture", value: input.budgetFact.capturedAt, nullable: true },
      { path: "budgetFact.observedAt", label: "the budget fact observation", value: input.budgetFact.observedAt, nullable: true },
      { path: "decision.decidedAt", label: "the decision", value: input.decision.decidedAt, nullable: true },
      { path: "role.asOf", label: "the role context as-of", value: input.role.asOf, nullable: true },
    ];
    for (const flag of SAFETY_POSTURE_KEYS) {
      clocks.push({ path: `safety.${flag}.asOf`, label: `the ${flag} evidence as-of`, value: input.safety?.[flag]?.asOf, nullable: true });
    }
    if (input.preflightEvidence) {
      clocks.push({ path: "preflightEvidence.evaluatedAt", label: "the preflight evaluation", value: input.preflightEvidence.evaluatedAt, nullable: true });
      const attempt = input.preflightEvidence.rawAttempt as { observedAt?: unknown } | null;
      if (attempt && "observedAt" in attempt) {
        clocks.push({ path: "preflightEvidence.rawAttempt.observedAt", label: "the preflight observation", value: attempt.observedAt, nullable: true });
      }
    }
    // THE RAW INTENT'S OWN CLOCKS. These are date-only, and r9 never tested
    // them against the outer instant cutoff at all.
    const ri = input.rawIntent as Record<string, unknown> | null;
    if (ri) {
      for (const [key, label] of [
        ["originDate", "the raw intent origin"],
        ["effectiveAsOf", "the raw intent effective date"],
        ["knowledgeAsOf", "the raw intent knowledge date"],
        ["authorityEvidenceAsOf", "the raw intent authority evidence date"],
      ] as ReadonlyArray<readonly [string, string]>) {
        clocks.push({ path: `rawIntent.${key}`, label, value: ri[key], nullable: false });
      }
      const win = ri.evidenceWindow as { from?: unknown; to?: unknown } | null | undefined;
      if (win && typeof win === "object") {
        clocks.push({ path: "rawIntent.evidenceWindow.to", label: "the raw intent evidence window end", value: win.to, nullable: false });
      }
    }
    for (const violation of checkPointInTimeOrder(clocks, { originDate: input.originDate, knowledgeAsOf: input.knowledgeAsOf })) {
      const code: DryRunBlocker =
        violation.kind === "after_knowledge" ? "capture_after_knowledge_cutoff"
        : violation.kind === "after_origin" ? "evidence_after_origin"
        : "clock_ordering_invalid";
      block(code, violation.why);
    }
  }

  // --- safety posture ---
  // Tri-state: `engaged` blocks as a proved breach, `unknown` blocks as
  // unverified, and only `clear` — with a source — passes.
  for (const [flag, engagedCode, unverifiedCode, label] of [
    [input.safety.killSwitch, "kill_switch_engaged", "kill_switch_unverified", "the server-side kill switch"],
    [input.safety.admission, "admission_blocked", "admission_unverified", "decision-pipeline admission"],
    [input.safety.cap, "cap_exceeded", "cap_unverified", "the per-day cap"],
    [input.safety.cooldown, "cooldown_active", "cooldown_unverified", "the cooldown window"],
    [input.safety.conflict, "conflict_lock_held", "conflict_unverified", "the conflict lock"],
  ] as ReadonlyArray<readonly [SafetyFlag, DryRunBlocker, DryRunBlocker, string]>) {
    if (flag.state !== "clear" && flag.state !== "engaged" && flag.state !== "unknown") {
      // Runtime membership: r4 let `state:"banana"` fall through as if clear.
      block(unverifiedCode, `${label} reports an unrecognised state ${JSON.stringify(flag.state)}, so it is unverified`);
      continue;
    }
    if (flag.state === "unknown") {
      block(unverifiedCode, `${label} was not read, so it is unverified and cannot clear this proposal: ${flag.why}`);
      continue;
    }
    // BOTH states need real provenance. r3 refused only `source === null`, so
    // `source:""`, a null/rollover/future as-of and cutoff-unsafe evidence all
    // cleared, while an engaged flag with blank provenance was still reported
    // as a proved incident.
    const src = typeof flag.source === "string" ? flag.source.trim() : "";
    const asOfMs = flag.asOf === null ? null : instantOrDay(flag.asOf);
    const provenanceProblems: string[] = [];
    if (src === "") provenanceProblems.push("it names no source");
    if (flag.asOf === null) provenanceProblems.push("it carries no as-of");
    else if (asOfMs === null) provenanceProblems.push(`its as-of ${JSON.stringify(flag.asOf)} is not a valid instant or day`);
    else if (knowledgeMs !== null && asOfMs > knowledgeMs) {
      provenanceProblems.push(`its as-of ${flag.asOf} is after the ${input.knowledgeAsOf} knowledge cutoff`);
    }
    // A later-but-known value must not leak into an earlier simulation. This
    // is a DISTINCT finding from unusable provenance, so it does not consume
    // the unverified degradation below.
    if (asOfMs !== null && originMs !== null && asOfMs > originMs) {
      block("safety_provenance_after_origin", `${label} carries an as-of (${flag.asOf}) after the end of the ${input.originDate} origin day`);
      provenanceProblems.push(`its as-of ${flag.asOf} is after the ${input.originDate} origin`);
    }
    if (!isNonEmptyString(flag.why)) provenanceProblems.push("it carries no reason");
    if (provenanceProblems.length > 0) {
      block(
        unverifiedCode,
        `${label} claims to be ${flag.state} but its provenance is unusable (${provenanceProblems.join("; ")}), so it is unverified`,
      );
      continue;
    }
    if (flag.state === "engaged") {
      block(engagedCode, `${label} is engaged: ${flag.why} (source: ${src}, as of ${flag.asOf})`);
    }
  }

  // --- provider state ---
  if (!input.preflight || input.preflight.outcome !== "succeeded") {
    block("provider_preflight_not_readable", input.preflight?.why ?? "no provider preflight read is available for this binding");
  } else if (!input.preflight.matchesBaseline) {
    block("provider_state_drifted", input.preflight.why);
    block("cas_baseline_drifted", `the compare-and-set baseline no longer matches: ${input.preflight.driftedFields.join(", ")}`);
  }

  // --- CROSS-BINDING: the same fact must be the same fact at every layer ---
  //
  // r2 accepted one input carrying a wrong account, a wrong entity, a 900x
  // wrong amount, an arbitrary budget-fact contract, a direction contradicting
  // the commercial action, whitespace decision identity and a self-
  // contradictory preflight — and reported only the structural blocker. The
  // structural gate was masking a future cross-account dispatch.
  const trimmed = (v: string | null | undefined): string => (typeof v === "string" ? v.trim() : "");

  // THE CANONICAL INTENT. `validateBudgetIntent` is the only authority; a
  // caller-supplied object is a claim to be checked, never a source of truth.
  let canonicalIntent: ValidatedBudgetIntent | null = null;
  if (!input.rawIntent) {
    if (input.intent) {
      block("intent_raw_input_missing", "a validated intent was supplied without the raw input needed to re-derive it, so it cannot be trusted");
    }
  } else {
    const validation = validateBudgetIntent(input.rawIntent, input.knownBindings);
    if (validation.status === "rejected") {
      block(
        "intent_rejected_by_canonical_validator",
        `the canonical budget-intent validator rejected this intent: ${validation.rejections.join(", ")} — ${validation.reasons.join("; ")}`,
      );
    } else {
      canonicalIntent = validation.intent;
      if (input.intent) {
        // Full canonical equality, not a field-by-field subset.
        const claimed = JSON.stringify(canonicalise(input.intent));
        const derived = JSON.stringify(canonicalise(canonicalIntent));
        if (claimed !== derived) {
          block(
            "intent_not_canonically_equal",
            "the supplied validated intent is not canonically equal to the intent re-derived from its own raw input",
          );
        }
      }
    }
  }

  if (canonicalIntent) {
    const i = canonicalIntent;
    if (
      trimmed(i.scope.businessId) !== trimmed(input.scope.businessId) ||
      trimmed(i.scope.providerAccountId) !== trimmed(input.scope.providerAccountId) ||
      trimmed(i.scope.entityId) !== trimmed(input.scope.entityId) ||
      i.scope.entityGrain !== input.scope.entityGrain ||
      trimmed(i.scope.parentCampaignId) !== trimmed(input.scope.parentCampaignId)
    ) {
      block(
        "scope_intent_identity_mismatch",
        `the proposal scope (${input.scope.providerAccountId}/${input.scope.entityGrain ?? "?"}/${input.scope.entityId ?? "?"}) is not the validated intent's scope (${i.scope.providerAccountId}/${i.scope.entityGrain}/${i.scope.entityId})`,
      );
    }
    if (input.direction !== null && i.direction !== input.direction) {
      block("direction_intent_mismatch", `the proposal direction ${input.direction} is not the intent direction ${i.direction}`);
    }
    if (input.percent !== null && i.percent !== input.percent) {
      block("direction_intent_mismatch", `the proposal percent ${input.percent} is not the intent percent ${i.percent}`);
    }
    if (input.budgetFact.budgetField !== null && i.budgetField !== input.budgetFact.budgetField) {
      block("budget_field_binding_mismatch", `the budget fact names ${input.budgetFact.budgetField} but the intent names ${i.budgetField}`);
    }
    if (input.budgetFact.currentMinorUnits !== null && i.currentMinorUnits !== input.budgetFact.currentMinorUnits) {
      block("amount_binding_mismatch", `the canonical budget fact reports ${input.budgetFact.currentMinorUnits} minor units but the intent was built from ${i.currentMinorUnits}`);
    }
    if (input.budgetFact.ownerMode !== "unknown" && i.ownerMode !== input.budgetFact.ownerMode) {
      block("owner_mode_binding_mismatch", `the budget fact owner mode ${input.budgetFact.ownerMode} is not the intent owner mode ${i.ownerMode}`);
    }
    if (input.accountCurrency !== null && trimmed(i.currency) !== trimmed(input.accountCurrency)) {
      block("currency_binding_mismatch", `the account currency ${input.accountCurrency} is not the intent currency ${i.currency}`);
    }
    if (input.currencyExponent !== null && i.currencyExponent !== input.currencyExponent) {
      block("currency_binding_mismatch", `the exponent ${input.currencyExponent} is not the intent exponent ${i.currencyExponent}`);
    }
    if (i.contractVersion !== META_BUDGET_INTENT_CONTRACT_VERSION) {
      block("intent_contract_unsupported", `the intent declares ${JSON.stringify(i.contractVersion)}, not ${META_BUDGET_INTENT_CONTRACT_VERSION}`);
    }
    if (i.authorityStatus !== "authorised") {
      block("intent_authority_not_authorised", `the intent authority status is ${i.authorityStatus}`);
    }
    if (i.executionState !== "validated_only") {
      block("intent_authority_not_authorised", `the intent claims execution state ${i.executionState}`);
    }
    if (trimmed(i.originDate) !== trimmed(input.originDate)) {
      block("clock_ordering_invalid", `the intent origin ${i.originDate} is not the proposal origin ${input.originDate}`);
    }
    // Bind every intent clock and provenance fact, not just the origin.
    for (const [label, value] of [
      ["effectiveAsOf", i.effectiveAsOf], ["knowledgeAsOf", i.knowledgeAsOf],
      ["authorityEvidenceAsOf", i.authorityEvidenceAsOf],
    ] as ReadonlyArray<readonly [string, string]>) {
      if (instantOrDay(value) === null) {
        block("intent_clock_binding_mismatch", `the intent ${label} ${JSON.stringify(value)} is not a valid instant or day`);
      }
    }
    if (instantOrDay(i.evidenceWindow?.from) === null || instantOrDay(i.evidenceWindow?.to) === null) {
      block("intent_clock_binding_mismatch", "the intent evidence window is not a pair of valid days");
    }
    for (const [name, fp] of Object.entries(i.sourceFingerprints ?? {})) {
      if (!isHex64(fp)) block("intent_clock_binding_mismatch", `the intent source fingerprint ${name} is not a sha-256 digest`);
    }
    if (!i.currencyRegistry?.version || !i.currencyRegistry?.source) {
      block("intent_clock_binding_mismatch", "the intent carries no currency registry provenance");
    }
    if (i.rollback?.field !== i.budgetField || i.rollback?.priorMinorUnits !== i.currentMinorUnits) {
      block("intent_clock_binding_mismatch", "the intent rollback contract does not restore its own prior amount on its own field");
    }
    if (i.readback?.field !== i.budgetField || i.readback?.expectedMinorUnits !== i.proposedMinorUnits) {
      block("intent_clock_binding_mismatch", "the intent read-back contract does not expect its own proposed amount on its own field");
    }
    if (!trimmed(i.intentKey) || !trimmed(i.idempotencyKey)) {
      block("intent_clock_binding_mismatch", "the intent carries no stable intent/idempotency identity");
    }
  }

  // The CAS baseline is what a future write would compare against.
  if (input.casBaseline) {
    const b = input.casBaseline;
    if (
      trimmed(b.providerAccountId) !== trimmed(input.scope.providerAccountId) ||
      trimmed(b.entityId) !== trimmed(input.scope.entityId) ||
      b.entityGrain !== input.scope.entityGrain ||
      trimmed(b.parentCampaignId) !== trimmed(input.scope.parentCampaignId)
    ) {
      block(
        "scope_baseline_identity_mismatch",
        `the CAS baseline names ${b.providerAccountId}/${b.entityGrain}/${b.entityId}, not the proposal scope`,
      );
    }
    if (canonicalIntent && b.budgetMinorUnits !== null && b.budgetMinorUnits !== canonicalIntent.currentMinorUnits) {
      block("amount_binding_mismatch", `the CAS baseline holds ${b.budgetMinorUnits} minor units but the canonical intent expects ${canonicalIntent.currentMinorUnits}`);
    }
    // Owner mode and field must agree across CAS, budget fact AND the intent.
    if (canonicalIntent && b.ownerMode !== canonicalIntent.ownerMode) {
      block("owner_mode_binding_mismatch", `the CAS baseline owner mode ${b.ownerMode} is not the canonical intent owner mode ${canonicalIntent.ownerMode}`);
    }
    if (canonicalIntent && b.budgetField !== canonicalIntent.budgetField) {
      block("budget_field_binding_mismatch", `the CAS baseline field ${b.budgetField} is not the canonical intent field ${canonicalIntent.budgetField}`);
    }
    // Lifetime flights must be identical across budget fact and CAS; a daily
    // budget must carry no flight anywhere.
    if (input.budgetFact.budgetField === "lifetime_budget") {
      if (trimmed(b.scheduleStart) !== trimmed(input.budgetFact.scheduleStart) ||
          trimmed(b.scheduleEnd) !== trimmed(input.budgetFact.scheduleEnd)) {
        block("budget_field_binding_mismatch", "the CAS lifetime flight is not the budget fact's lifetime flight");
      }
    } else if (input.budgetFact.budgetField === "daily_budget") {
      if (b.scheduleStart !== null || b.scheduleEnd !== null ||
          input.budgetFact.scheduleStart !== null || input.budgetFact.scheduleEnd !== null) {
        block("budget_field_binding_mismatch", "a daily budget must carry no lifetime flight on the fact or the CAS baseline");
      }
    }
    if (input.budgetFact.budgetField !== null && b.budgetField !== input.budgetFact.budgetField) {
      block("budget_field_binding_mismatch", `the CAS baseline field ${b.budgetField} is not the budget fact field ${input.budgetFact.budgetField}`);
    }
  }

  // Direction must agree with the canonical action the commercial gate answered.
  if (input.direction !== null && input.commercial.selectedAction !== null) {
    const expected = DIRECTION_TO_CANONICAL_ACTION[input.direction];
    if (input.commercial.selectedAction !== expected) {
      block(
        "direction_action_mismatch",
        `direction ${input.direction} consults the ${expected} action, but the commercial verdict is for ${input.commercial.selectedAction}`,
      );
    }
  }

  // Canonical contracts, not arbitrary non-null strings.
  if (input.budgetFact.available && input.budgetFact.contractVersion !== CANONICAL_BUDGET_FACT_CONTRACT) {
    block("budget_fact_contract_unsupported", `the budget fact declares ${JSON.stringify(input.budgetFact.contractVersion)}, not ${CANONICAL_BUDGET_FACT_CONTRACT}`);
  }

  // Role and commercial evidence must name the identity they were resolved for.
  if (!isLiteralBoolean(input.role.resolved)) {
    block("runtime_boolean_not_literal", `role.resolved is ${JSON.stringify(input.role.resolved)}, not a literal boolean`);
  }
  if (input.role.resolved === true) {
    const roleAuthority = validateRoleAuthority(input.role);
    if (!roleAuthority.canonical) {
      block("role_authority_not_canonical", `the role context is not a canonical automatic authority: ${roleAuthority.problems.join("; ")}`);
    }
    if (trimmed(input.role.businessId) !== trimmed(input.scope.businessId) ||
        trimmed(input.role.providerAccountId) !== trimmed(input.scope.providerAccountId)) {
      block("role_identity_unbound", `the role context was resolved for ${input.role.providerAccountId ?? "no account"}, not ${input.scope.providerAccountId}`);
    }
    /*
      THE THIRD LEG OF THE COMPOSITE SCOPE.

      D081's `requiresExactCompositeScope` rule binds business, account AND
      campaign. r7 compared the first two and checked only that `campaignId`
      was a non-empty string, so a role resolved for campaign
      23850000000000000 authorised a proposal against 23859876543210987 — a
      different campaign under the same account — and previewed. The expected
      campaign is derived from the proposal's own grain, so there is no second
      resolver and no new authority: a campaign-grain proposal IS its campaign,
      and an ad-set-grain proposal belongs to its parent.
    */
    const expectedCampaignId =
      input.scope.entityGrain === "campaign" ? input.scope.entityId
      : input.scope.entityGrain === "adset" ? input.scope.parentCampaignId
      : null;
    if (expectedCampaignId === null || !isNonEmptyString(expectedCampaignId)) {
      block("role_identity_unbound", `the proposal names no campaign for its ${input.scope.entityGrain ?? "unknown"} grain, so no role authority can bind to it`);
    } else if (trimmed(input.role.campaignId) !== trimmed(expectedCampaignId)) {
      block(
        "role_identity_unbound",
        `the role context was resolved for campaign ${JSON.stringify(input.role.campaignId ?? null)}, not the proposal's campaign ${expectedCampaignId}`,
      );
    }
    /*
      AND THE AS-OF.

      A role resolution carries the moment it was true. r7 required only that
      the as-of parse, so a resolution dated 2026-01-01 authorised a proposal
      originating 2026-09-01. The as-of must be a real day at or before the
      origin, and no older than the same authority-evidence bound the canonical
      intent applies.
    */
    const roleAsOfMs = instantOrDay(input.role.asOf);
    if (roleAsOfMs !== null && originMs !== null && roleAsOfMs > originMs) {
      block("role_identity_unbound", `the role resolution is dated ${input.role.asOf}, after the ${input.originDate} origin`);
    }
    // The role authority IS the authority evidence the canonical intent
    // stamped — `roleAuthorityHash` is one of its three source fingerprints.
    // So the resolution's day must be exactly the day the intent declares its
    // authority evidence was true, not merely some parseable earlier date.
    if (canonicalIntent && isNonEmptyString(input.role.asOf)) {
      const roleDay = trimmed(input.role.asOf).slice(0, 10);
      if (roleDay !== canonicalIntent.authorityEvidenceAsOf) {
        block(
          "role_identity_unbound",
          `the role resolution is dated ${roleDay}, not the ${canonicalIntent.authorityEvidenceAsOf} authority evidence the canonical intent rests on`,
        );
      }
    }
    // Matching identifiers are not coherence: a resolved role needs a source,
    // a resolver version and a valid as-of, and must be account-scoped.
    const roleProblems: string[] = [];
    if (input.role.accountScoped !== true) roleProblems.push("it is not account-scoped");
    if (!trimmed(input.role.source)) roleProblems.push("it names no source");
    if (!trimmed(input.role.resolverVersion)) roleProblems.push("it names no resolver version");
    if (input.role.asOf === null || instantOrDay(input.role.asOf) === null) roleProblems.push("its as-of is missing or invalid");
    if (roleProblems.length > 0) {
      block("role_provenance_incoherent", `the role context claims to be resolved but ${roleProblems.join("; ")}`);
    }
  }
  // A RESOLVED verdict must carry the exact canonical contract. Null is valid
  // only on an already-blocked unavailable verdict; r4 previewed a resolved
  // verdict whose contract was null.
  if (input.commercial.sourceStatus === "resolved") {
    if (input.commercial.profileContractVersion !== CANONICAL_PROFILE_CONTRACT) {
      block("commercial_contract_unsupported", `a resolved commercial verdict must declare ${CANONICAL_PROFILE_CONTRACT}, not ${JSON.stringify(input.commercial.profileContractVersion)}`);
    }
  } else if (input.commercial.profileContractVersion !== null &&
             input.commercial.profileContractVersion !== CANONICAL_PROFILE_CONTRACT) {
    block("commercial_contract_unsupported", `the commercial verdict declares ${JSON.stringify(input.commercial.profileContractVersion)}, not ${CANONICAL_PROFILE_CONTRACT}`);
  }
  if (input.commercial.sourceStatus === "resolved") {
    const coherence = validateCommercialCoherence(input.commercial, input.direction);
    if (!coherence.coherent) {
      block("commercial_verdict_incoherent", `the resolved commercial verdict is incoherent: ${coherence.problems.join("; ")}`);
    }
    if (trimmed(input.commercial.businessId) !== trimmed(input.scope.businessId) ||
        trimmed(input.commercial.providerAccountId) !== trimmed(input.scope.providerAccountId)) {
      block("commercial_identity_unbound", `the commercial verdict was produced for ${input.commercial.providerAccountId ?? "no account"}, not ${input.scope.providerAccountId}`);
    }
  }

  // The CAS baseline must itself be a semantically valid projection before it
  // can be fingerprinted, compared against, or handed to the preview helper.
  if (input.casBaseline) {
    const baseValidity = validateProjection(input.casBaseline);
    if (!baseValidity.complete) {
      block("cas_baseline_semantically_invalid", `the CAS baseline is not a valid provider projection: ${baseValidity.problems.join("; ")}`);
    }
  }

  // The preflight SUMMARY is RE-DERIVED from raw evidence, never trusted.
  //
  // r3 never called `comparePreflight`, ignored `evaluatedAt` and accepted a
  // null baseline fingerprint, so a clean-looking summary could wrap an
  // unrelated or nonexistent observation.
  if (input.preflight) {
    const pf = input.preflight;
    if (pf.contractVersion !== META_PROVIDER_READBACK_CONTRACT) {
      block("preflight_contract_unsupported", `the preflight declares ${JSON.stringify(pf.contractVersion)}, not ${META_PROVIDER_READBACK_CONTRACT}`);
    }
    if ((META_PROVIDER_READBACK_REJECTED_VERSIONS as readonly string[]).includes(pf.contractVersion)) {
      block("preflight_contract_unsupported", `the preflight declares the rejected contract ${pf.contractVersion}`);
    }
    // Contradictory booleans fail closed on their face.
    if (pf.matchesBaseline && (pf.rejections.length > 0 || !pf.fresh || !pf.projectionComplete)) {
      block("preflight_summary_contradictory", `the preflight claims matchesBaseline while reporting fresh=${String(pf.fresh)}, projectionComplete=${String(pf.projectionComplete)} and rejections=[${pf.rejections.join(", ")}]`);
    }
    if (pf.outcome === "succeeded" && pf.rejections.length > 0) {
      block("preflight_summary_contradictory", `the preflight reports outcome=succeeded with rejections [${pf.rejections.join(", ")}]`);
    }
    if (pf.matchesBaseline && pf.driftedFields.length > 0) {
      block("preflight_summary_contradictory", `the preflight claims a match while reporting drift on ${pf.driftedFields.join(", ")}`);
    }
    if (pf.ageSeconds !== null && (!Number.isFinite(pf.ageSeconds) || pf.ageSeconds < 0)) {
      block("preflight_summary_contradictory", `the preflight reports an impossible age of ${pf.ageSeconds}s`);
    }

    const ev = input.preflightEvidence;
    const evaluatedMs = instantOf(ev?.evaluatedAt ?? null);

    // A summary that claims a usable read must carry the raw evidence to prove it.
    if (pf.matchesBaseline || pf.outcome === "succeeded") {
      if (!ev || !ev.rawAttempt || !isMemberOf(
        (ev.rawAttempt as { status?: unknown }).status,
        ["succeeded", "stale", "failed", "not_attempted"] as const,
      )) {
        // A rawAttempt with NO canonical status is absent evidence, not a
        // failed read. Calling it "the preflight read failed: undefined" —
        // which is what an empty map produced — is an interpretation the
        // evidence does not support.
        block("preflight_raw_evidence_missing", `the preflight claims a provider read but its raw attempt carries no canonical status (${JSON.stringify((ev?.rawAttempt as { status?: unknown } | null | undefined)?.status ?? null)}), so nothing can be re-derived from it`);
      }
      if (!ev || !ev.evaluatedAt) {
        block("preflight_raw_evidence_missing", "the preflight carries no server-owned evaluation instant");
      } else if (evaluatedMs === null) {
        block("clock_ordering_invalid", `the preflight evaluatedAt ${JSON.stringify(ev.evaluatedAt)} is not a strict instant`);
      }
      if (!input.casBaseline) {
        block("preflight_raw_evidence_missing", "the preflight claims a comparison but no CAS baseline exists to compare against");
      } else if (!ev?.baselineFingerprint) {
        block("preflight_baseline_fingerprint_mismatch", "the preflight publishes no baseline fingerprint, so the comparison target is unproven");
      }
    }

    // The baseline it compared against must be THIS proposal's baseline.
    if (input.casBaseline && ev?.baselineFingerprint) {
      const expected = readbackFingerprint(input.casBaseline);
      if (ev.baselineFingerprint !== expected) {
        block("preflight_baseline_fingerprint_mismatch", "the preflight compared against a baseline that is not this proposal's CAS baseline");
      }
    }

    // RE-DERIVE, and treat the derived result as the AUTHORITY.
    if (input.casBaseline && ev?.rawAttempt && evaluatedMs !== null) {
      const rederived = comparePreflight(input.casBaseline, ev.rawAttempt, { evaluatedAt: ev.evaluatedAt! });
      // COMPLETE canonical equality. r4 compared outcome/fresh/completeness/
      // rejections/drifted fields but not age, claimed status, drift detail or
      // why — so a summary publishing ageSeconds:10 over a 0-second-old
      // observation still reached a preview.
      const claimedSummary = canonicalise({
        contractVersion: pf.contractVersion, claimedStatus: pf.claimedStatus, outcome: pf.outcome,
        rejections: [...pf.rejections].sort(), ageSeconds: pf.ageSeconds, fresh: pf.fresh,
        projectionComplete: pf.projectionComplete, driftedFields: [...pf.driftedFields].sort(),
        driftDetail: pf.driftDetail, matchesBaseline: pf.matchesBaseline, why: pf.why,
      });
      const derivedSummary = canonicalise({
        contractVersion: rederived.contractVersion, claimedStatus: rederived.claimedStatus, outcome: rederived.outcome,
        rejections: [...rederived.rejections].sort(), ageSeconds: rederived.ageSeconds, fresh: rederived.fresh,
        projectionComplete: rederived.projectionComplete, driftedFields: [...rederived.driftedFields].sort(),
        driftDetail: rederived.driftDetail, matchesBaseline: rederived.matchesBaseline, why: rederived.why,
      });
      if (JSON.stringify(claimedSummary) !== JSON.stringify(derivedSummary)) {
        block(
          "preflight_summary_not_reproducible",
          `the published preflight summary is not what re-running comparePreflight on its own raw evidence produces (published age ${String(pf.ageSeconds)}s / match ${String(pf.matchesBaseline)}; derived age ${String(rederived.ageSeconds)}s / match ${String(rederived.matchesBaseline)})`,
        );
      }
      // The DERIVED comparison, not the caller summary, decides provider state.
      if (!rederived.matchesBaseline) {
        block("provider_state_drifted", rederived.why);
      }
    }

    // Every raw-attempt status carries a clock; validate it whatever the status.
    if (ev?.rawAttempt) {
      const raw = ev.rawAttempt;
      const rawObserved =
        raw.status === "succeeded" ? raw.observedAt : raw.status === "stale" ? raw.observedAt : null;
      if (rawObserved !== null) {
        const obsMs = instantOf(rawObserved);
        if (obsMs === null) {
          block("clock_ordering_invalid", `the raw observation instant ${JSON.stringify(rawObserved)} is not strict`);
        } else {
          if (evaluatedMs !== null && obsMs > evaluatedMs) {
            block("clock_ordering_invalid", "the preflight observation is dated after its own evaluation instant");
          }
          if (knowledgeMs !== null && obsMs > knowledgeMs) {
            block("preflight_observation_after_cutoff", `the preflight observation (${rawObserved}) is after the ${input.knowledgeAsOf} knowledge cutoff`);
          }
          // ORIGIN cutoff too. r4 checked only the knowledge cutoff, so a
          // historical proposal at origin 2026-08-31 could be justified by an
          // observation taken on 2026-09-01.
          if (originMs !== null && obsMs > originMs) {
            block("preflight_observation_after_cutoff", `the preflight observation (${rawObserved}) is after the end of the ${input.originDate} origin day`);
          }
        }
      }
    }
    if (evaluatedMs !== null) {
      if (knowledgeMs !== null && evaluatedMs > knowledgeMs) {
        block("preflight_observation_after_cutoff", `the preflight evaluation (${ev?.evaluatedAt}) is after the ${input.knowledgeAsOf} knowledge cutoff`);
      }
      if (originMs !== null && evaluatedMs > originMs) {
        block("preflight_observation_after_cutoff", `the preflight evaluation (${ev?.evaluatedAt}) is after the end of the ${input.originDate} origin day`);
      }
    }
  }

  // --- ceremony ---
  const ceremony = validateWriteSafetyCeremony(input.writeSafety);
  if (!ceremony.satisfied) {
    // `{}` is not "nothing missing"; an unrecognised value is malformed.
    const malformed = ceremony.problems.filter((x) => x.includes("unrecognised") || x.includes("unknown steps") || x.includes("not an object") || x.includes("not_applicable") || x.includes("partition"));
    if (malformed.length > 0) {
      block("write_safety_ceremony_malformed", `the write-safety ceremony is malformed: ${malformed.join("; ")}`);
    }
    if (ceremony.missingSteps.length > 0) {
      block("write_safety_step_missing", `write-safety steps not satisfied: ${ceremony.missingSteps.join(", ")}`);
    }
  }
  if (!canonicalIntent) {
    block("intent_not_validated", `no canonical D081 intent could be derived${input.intentRejections.length ? `: ${input.intentRejections.join(", ")}` : ""}`);
  }

  // The structural gate. It is DERIVED from the capability contract rather
  // than hardcoded, so a synthetic input can exercise the preview branch while
  // production — which passes `PROVIDER_CAPABILITY_TODAY` — always blocks.
  // FIELD-SPECIFIC validation. The capability must be valid FOR THE FIELD this
  // run would actually write, not merely well-formed in the abstract — and
  // when the field is unsupported that is a CAPABILITY refusal, never an
  // intent failure.
  const requestedBudgetField =
    canonicalIntent?.budgetField ?? input.budgetFact?.budgetField ?? undefined;
  const capabilityValidity = validateCapability(input.capability, requestedBudgetField ?? undefined);
  const unsupportedField = capabilityValidity.problems.filter((x) => x.includes("does not include the requested field"));
  const malformedCapability = capabilityValidity.problems.filter((x) => !x.includes("does not include the requested field"));
  if (malformedCapability.length > 0) {
    block("capability_contract_invalid", `the capability contract is not runtime-valid: ${malformedCapability.join("; ")}`);
  }
  if (unsupportedField.length > 0) {
    block("no_provider_write_path_exists", `${unsupportedField.join("; ")} (source: ${input.capability?.source || "unnamed"})`);
  }
  if (!capabilityPermitsWrite(input.capability)) {
    block("no_provider_write_path_exists", `${input.capability.why || "no capability reason"} (source: ${input.capability.source || "unnamed"})`);
  }

  const ordered = DRY_RUN_BLOCKERS.filter((c) => blockers.includes(c));
  const orderedDetail = ordered.map((c) => detail.find((d) => d.code === c)!);

  const common = {
    contractVersion: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT,
    inputFingerprint,
    policyFingerprint,
    executionState: "validated_only",
    executable: false,
    ctaEnabled: false,
    providerWriteAttempted: false,
    providerOutcome: "not_attempted",
    readbackClassification: "not_attempted",
  } as const;

  if (ordered.length > 0) {
    return {
      ...common,
      status: "blocked",
      blockers: ordered,
      blockerDetail: orderedDetail,
      wouldWriteRequest: null,
      receiptPreview: null,
      preflightFingerprint,
    };
  }

  // Every local gate passed AND the capability contract permits a write, so the
  // preview is assembled by the shared pure helper below.
  const assembled = assembleWouldWritePreview({
    scope: input.scope,
    // The boundary RE-DERIVES from these. The builder's own canonical intent is
    // passed alongside purely as a cross-check: assembly refuses unless the two
    // are canonically equal, so a drift between the two derivations is caught
    // rather than silently preferred one way or the other.
    rawIntent: input.rawIntent!,
    knownBindings: input.knownBindings,
    intent: canonicalIntent!,
    budgetField: input.budgetFact.budgetField!,
    casBaseline: input.casBaseline!,
    decisionId: input.decision.id,
    writeSafety: input.writeSafety,
    capability: input.capability,
    inputFingerprint,
  });
  if ("refused" in assembled) {
    return {
      ...common,
      status: "blocked",
      blockers: ["intent_not_validated"],
      blockerDetail: [{ code: "intent_not_validated", why: assembled.why }],
      wouldWriteRequest: null,
      receiptPreview: null,
      preflightFingerprint,
    };
  }
  const { request: wouldWriteRequest, receipt: receiptPreview } = assembled;

  return {
    ...common,
    status: "would_write_available",
    blockers: [],
    blockerDetail: [],
    wouldWriteRequest,
    receiptPreview,
    preflightFingerprint: preflightFingerprint!,
  };
}

/** The versioned serialization the preview hash is taken over. */
/**
 * The receipt revision. Unchanged by Correction 15: no receipt wire format or
 * hash semantic moved, so retiring the identifier would invalidate receipts
 * for a reason that does not exist.
 */
export const PREVIEW_RECEIPT_REVISION = 12 as const;

export const PREVIEW_CONTRACT_VERSION = `meta.budget-preview-receipt.v${PREVIEW_RECEIPT_REVISION}` as const;

/** The receipt lineage, from the SAME single derivation as the artifact's. */
export const META_BUDGET_PREVIEW_RECEIPT_REJECTED_VERSIONS: readonly string[] =
  contiguousRejectedVersions(PREVIEW_RECEIPT_REVISION, "meta.budget-preview-receipt");

/** Deterministic key ordering, so a hash is a function of content, not layout. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort()
        .map((k) => [k, canonicalise((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * The hash covers the request and the receipt — and the receipt now carries
 * its own input and capability fingerprints, so nothing hidden feeds it.
 */
function canonicalPreviewHash(payload: { request: WouldWriteRequest; receipt: ReceiptPreview }): string {
  const { receiptHash: _ignored, ...bareReceipt } = payload.receipt;
  return `${PREVIEW_CONTRACT_VERSION}:${sha(JSON.stringify(canonicalise({
    v: PREVIEW_CONTRACT_VERSION, request: payload.request, receipt: bareReceipt,
  })))}`;
}

/**
 * A preview-only idempotency key.
 *
 * Namespaced AND derived from the durable key rather than equal to it, so a
 * preview can neither collide with nor reserve the claim a future write would
 * take.
 */
/**
 * The preview idempotency key, derived from the DIGEST of the durable key.
 *
 * Taking the digest rather than the key itself keeps the durable claim
 * unreconstructable from a receipt while making the preview key genuinely
 * recomputable by a verifier holding only the request and receipt.
 */
export function previewIdempotencyKey(durableKeyDigest: string, inputFingerprint: string): string {
  return `${PREVIEW_KEY_NAMESPACE}-idem:${sha(`${PREVIEW_KEY_NAMESPACE}|${durableKeyDigest}|${inputFingerprint}`)}`;
}

/** The preview key, derived from receipt-contained material only. */
export function derivePreviewKey(seed: {
  inputFingerprint: string; intentKeyDigest: string;
  businessId: string; providerAccountId: string; entityId: string;
}): string {
  return `${PREVIEW_KEY_NAMESPACE}:${sha(
    `${PREVIEW_KEY_NAMESPACE}|${seed.inputFingerprint}|${seed.intentKeyDigest}|${seed.businessId}|${seed.providerAccountId}|${seed.entityId}`,
  )}`;
}

/** Freeze an object graph so post-assembly mutation cannot rewrite truth. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

export interface PreviewAssemblyInput {
  scope: DryRunInput["scope"];
  /** The RAW intent. The canonical one is re-derived from this, here. */
  rawIntent: BudgetIntentInput;
  knownBindings: DryRunInput["knownBindings"];
  /** OPTIONAL caller view, accepted only on exact equality with the derived one. */
  intent?: ValidatedBudgetIntent;
  budgetField: BudgetField;
  casBaseline: PreflightProjection;
  decisionId: string | null;
  writeSafety: DryRunInput["writeSafety"];
  capability: ProviderCapabilityContract;
  inputFingerprint: string;
}

export type PreviewAssembly =
  | { request: WouldWriteRequest; receipt: ReceiptPreview }
  | { refused: true; why: string };

/** The exact canonical shape of a validated D081 intent. */
export const VALIDATED_INTENT_KEYS = [
  "contractVersion", "intentKey", "idempotencyKey", "scope", "ownerMode", "budgetField",
  "direction", "percent", "currency", "currencyExponent", "currencyRegistry",
  "currentMinorUnits", "proposedMinorUnits", "deltaMinorUnits", "rounding", "originDate",
  "effectiveAsOf", "knowledgeAsOf", "authorityEvidenceAsOf", "sourceFingerprints",
  "evidenceWindow", "targetSource", "authorityStatus", "blockerCodes", "executionState",
  "rollback", "readback", "createdBy",
] as const;
const _validatedIntentKeyGuard: Record<keyof ValidatedBudgetIntent, true> = {
  contractVersion: true, intentKey: true, idempotencyKey: true, scope: true, ownerMode: true,
  budgetField: true, direction: true, percent: true, currency: true, currencyExponent: true,
  currencyRegistry: true, currentMinorUnits: true, proposedMinorUnits: true,
  deltaMinorUnits: true, rounding: true, originDate: true, effectiveAsOf: true,
  knowledgeAsOf: true, authorityEvidenceAsOf: true, sourceFingerprints: true,
  evidenceWindow: true, targetSource: true, authorityStatus: true, blockerCodes: true,
  executionState: true, rollback: true, readback: true, createdBy: true,
};
void _validatedIntentKeyGuard;

/*
  RE-DERIVATION, not inspection.

  r10 accepted a caller-supplied `intent` and checked its key set, contract,
  execution state, a scope subset and integer amounts. Twelve mutations of a
  full-shaped intent still previewed — an `unauthorised` authority status, a
  non-empty blocker set, blank identity keys, a blank currency, a negative
  exponent, a coherent zero-change, inconsistent rollback/readback amounts, a
  malformed source fingerprint, and a switched parent campaign on either the
  intent scope or the CAS baseline.

  So the boundary no longer inspects a supplied intent. It takes the RAW intent
  and the known bindings and re-derives the canonical one itself, through the
  same D081 validator production uses. A caller may still pass its derived view
  — for migration and for cross-checking — but it is accepted only on exact
  canonical equality with what this boundary derived. That is inspectable and
  serializable, and a full-shaped forgery cannot satisfy it.
*/
export const PREVIEW_ASSEMBLY_INPUT_KEYS = [
  "scope", "rawIntent", "knownBindings", "budgetField", "casBaseline", "decisionId",
  "writeSafety", "capability", "inputFingerprint",
] as const;
/** Optional: a caller's derived view, checked for exact equality, never trusted. */
export const PREVIEW_ASSEMBLY_OPTIONAL_KEYS = ["intent"] as const;
const _assemblyKeyGuard: Record<keyof PreviewAssemblyInput, true> = {
  scope: true, rawIntent: true, knownBindings: true, intent: true, budgetField: true,
  casBaseline: true, decisionId: true, writeSafety: true, capability: true,
  inputFingerprint: true,
};
void _assemblyKeyGuard;

/**
 * Assemble the sanitized would-write request and the immutable receipt preview.
 *
 * TOTAL, and now actually so.
 *
 * Correction 7's version claimed to be "pure and total" while its parameter
 * was a TypeScript annotation and nothing else: `assembleWouldWritePreview(null)`
 * threw `Cannot read properties of null (reading 'capability')`, and a null
 * `scope`, `intent`, `casBaseline`, `writeSafety` or `capability` each threw on
 * its own first dereference. A type annotation is a promise the caller made at
 * compile time; it constrains nothing at runtime. The parameter is therefore
 * `unknown`, validated before anything is read, and every malformed input
 * returns a REFUSAL — the one thing a total function must never do is throw.
 *
 * It still refuses on its own if the capability contract does not permit a
 * write, so calling it directly cannot manufacture a path production lacks.
 */
export function assembleWouldWritePreview(input: PreviewAssemblyInput | unknown): PreviewAssembly {
  const observation = safeSnapshot(input, "assemblyInput");
  if (!observation.ok) {
    return { refused: true, why: `the assembly input could not be safely observed as exact data: ${renderProblems(observation.problems)}` };
  }
  input = observation.value;
  const problems: SchemaProblem[] = [];
  const map = exactMap(input, "assemblyInput", PREVIEW_ASSEMBLY_INPUT_KEYS, PREVIEW_ASSEMBLY_OPTIONAL_KEYS, problems);
  if (!map) return { refused: true, why: `the assembly input is not its canonical schema: ${renderProblems(problems)}` };
  for (const [name, keys] of [
    ["scope", DRY_RUN_SCOPE_KEYS], ["casBaseline", PREFLIGHT_PROJECTION_KEYS],
    ["capability", CAPABILITY_KEYS], ["rawIntent", BUDGET_INTENT_INPUT_KEYS],
  ] as ReadonlyArray<readonly [string, readonly string[]]>) {
    exactMap(map[name], `assemblyInput.${name}`, keys, [], problems);
  }
  if (!Array.isArray(map.knownBindings)) problems.push({ path: "assemblyInput.knownBindings", why: "assemblyInput.knownBindings is not an array" });
  if (!isPlainMap(map.writeSafety)) problems.push({ path: "assemblyInput.writeSafety", why: "assemblyInput.writeSafety is not a ceremony map" });
  if (!isNonEmptyString(map.inputFingerprint)) problems.push({ path: "assemblyInput.inputFingerprint", why: "assemblyInput.inputFingerprint is not a non-empty string" });
  if (problems.length > 0) return { refused: true, why: `the assembly input is not its canonical schema: ${renderProblems(problems)}` };
  const typed = map as unknown as PreviewAssemblyInput;

  /*
    THE ASSEMBLY BOUNDARY RE-DERIVES. It does not inspect.

    Everything the canonical intent asserts — authority status, blocker set,
    identity keys, currency and exponent, delta arithmetic, rollback and
    readback amounts, source fingerprints, clocks and window — is produced HERE
    by the same D081 validator production uses. There is nothing for a caller
    to shape.
  */
  const derivation = validateBudgetIntent(typed.rawIntent, typed.knownBindings);
  if (derivation.status !== "valid") {
    return { refused: true, why: `the raw intent does not validate against the canonical D081 contract: ${derivation.rejections.join(", ")}` };
  }
  const intent = derivation.intent;

  // A caller MAY pass its own derived view. It is accepted only on exact
  // canonical equality — never trusted, never used in place of the derivation.
  if (map.intent !== undefined) {
    const supplied = canonicalise(map.intent as unknown as Record<string, unknown>);
    const derived = canonicalise(intent as unknown as Record<string, unknown>);
    if (JSON.stringify(supplied) !== JSON.stringify(derived)) {
      return { refused: true, why: "the supplied validated intent is not canonically equal to the intent re-derived from the raw input and bindings" };
    }
  }

  // EXACT SCOPE, and a real write scope.
  const scopeProblems: SchemaProblem[] = [];
  checkNonEmptyString(typed.scope.businessId, "assemblyInput.scope.businessId", scopeProblems, "a non-empty business id");
  checkNonEmptyString(typed.scope.providerAccountId, "assemblyInput.scope.providerAccountId", scopeProblems, "a non-empty provider account id");
  checkNonEmptyString(typed.scope.entityId, "assemblyInput.scope.entityId", scopeProblems, "a non-empty entity id");
  checkNonEmptyString(typed.scope.business, "assemblyInput.scope.business", scopeProblems, "a non-empty business name");
  if (typed.scope.accountIsWriteScope !== true) {
    scopeProblems.push({ path: "assemblyInput.scope.accountIsWriteScope", why: "the scope is explicitly not a write scope, so no would-write request may be assembled for it" });
  }
  if (!isMemberOf(typed.scope.entityGrain, BUDGET_OWNER_GRAINS)) {
    scopeProblems.push({ path: "assemblyInput.scope.entityGrain", why: `the scope names no budget-owning grain (${JSON.stringify(typed.scope.entityGrain)})` });
  }

  /*
    THE FULL IDENTITY BINDING, across outer scope, raw intent, derived intent
    and CAS baseline — INCLUDING the parent campaign, which r10 checked on none
    of them.
  */
  const expectedParent = typed.scope.entityGrain === "campaign" ? null : typed.scope.parentCampaignId;
  for (const [label, actual] of [
    ["the derived intent scope", intent.scope],
    ["the raw intent scope", typed.rawIntent?.scope],
  ] as ReadonlyArray<readonly [string, { businessId?: unknown; providerAccountId?: unknown; entityId?: unknown; entityGrain?: unknown; parentCampaignId?: unknown } | undefined]>) {
    if (!actual) { scopeProblems.push({ path: "assemblyInput.rawIntent.scope", why: `${label} is absent` }); continue; }
    if (actual.businessId !== typed.scope.businessId) scopeProblems.push({ path: "assemblyInput.rawIntent.scope.businessId", why: `${label} names a different business` });
    if (actual.providerAccountId !== typed.scope.providerAccountId) scopeProblems.push({ path: "assemblyInput.rawIntent.scope.providerAccountId", why: `${label} names a different provider account` });
    if (actual.entityId !== typed.scope.entityId) scopeProblems.push({ path: "assemblyInput.rawIntent.scope.entityId", why: `${label} names a different entity` });
    if (actual.entityGrain !== typed.scope.entityGrain) scopeProblems.push({ path: "assemblyInput.rawIntent.scope.entityGrain", why: `${label} names a different grain` });
    if ((actual.parentCampaignId ?? null) !== expectedParent) {
      scopeProblems.push({ path: "assemblyInput.rawIntent.scope.parentCampaignId", why: `${label} names parent campaign ${JSON.stringify(actual.parentCampaignId ?? null)}, not the proposal's ${JSON.stringify(expectedParent)}` });
    }
  }
  if (intent.budgetField !== typed.budgetField) {
    scopeProblems.push({ path: "assemblyInput.budgetField", why: `the intent names field ${JSON.stringify(intent.budgetField)} but assembly was asked for ${JSON.stringify(typed.budgetField)}` });
  }
  if (scopeProblems.length > 0) {
    return { refused: true, why: `the assembly scope is not usable: ${renderProblems(scopeProblems)}` };
  }

  // The FULL ceremony, satisfied. An empty map is not "nothing missing".
  const ceremony = validateWriteSafetyCeremony(typed.writeSafety);
  if (!ceremony.satisfied) {
    return { refused: true, why: `the write-safety ceremony is not fully satisfied: ${ceremony.missingSteps.length > 0 ? `missing {${ceremony.missingSteps.join(", ")}}` : ceremony.problems.join("; ")}` };
  }

  // The CAS projection must be a valid provider projection FOR this entity,
  // parent campaign and owner semantics included.
  const projection = validateProjection(typed.casBaseline);
  if (!projection.complete) {
    return { refused: true, why: `the CAS baseline is not a valid provider projection: ${projection.problems.join("; ")}` };
  }
  const casProblems: SchemaProblem[] = [];
  if (typed.casBaseline.entityId !== typed.scope.entityId) casProblems.push({ path: "assemblyInput.casBaseline.entityId", why: "the CAS baseline describes a different entity than the scope" });
  if (typed.casBaseline.providerAccountId !== typed.scope.providerAccountId) casProblems.push({ path: "assemblyInput.casBaseline.providerAccountId", why: "the CAS baseline describes a different provider account" });
  if (typed.casBaseline.entityGrain !== typed.scope.entityGrain) casProblems.push({ path: "assemblyInput.casBaseline.entityGrain", why: "the CAS baseline describes a different grain" });
  if ((typed.casBaseline.parentCampaignId ?? null) !== expectedParent) {
    casProblems.push({ path: "assemblyInput.casBaseline.parentCampaignId", why: `the CAS baseline names parent campaign ${JSON.stringify(typed.casBaseline.parentCampaignId ?? null)}, not the proposal's ${JSON.stringify(expectedParent)}` });
  }
  if (typed.casBaseline.budgetField !== typed.budgetField) casProblems.push({ path: "assemblyInput.casBaseline.budgetField", why: `the CAS baseline names field ${typed.casBaseline.budgetField}, not ${typed.budgetField}` });
  if (typed.casBaseline.ownerMode !== intent.ownerMode) casProblems.push({ path: "assemblyInput.casBaseline.ownerMode", why: `the CAS baseline owner mode ${JSON.stringify(typed.casBaseline.ownerMode)} is not the intent owner mode ${JSON.stringify(intent.ownerMode)}` });
  if (typed.casBaseline.budgetMinorUnits !== intent.currentMinorUnits) {
    casProblems.push({ path: "assemblyInput.casBaseline.budgetMinorUnits", why: `the CAS baseline holds ${JSON.stringify(typed.casBaseline.budgetMinorUnits)} minor units but the intent expects ${intent.currentMinorUnits}` });
  }
  // A lifetime field carries a flight; a daily field must not.
  if (typed.budgetField === "lifetime_budget") {
    if (!isNonEmptyString(typed.casBaseline.scheduleStart) || !isNonEmptyString(typed.casBaseline.scheduleEnd)) {
      casProblems.push({ path: "assemblyInput.casBaseline.scheduleStart", why: "a lifetime budget requires a retained flight on the CAS baseline" });
    }
  } else if (typed.casBaseline.scheduleStart !== null || typed.casBaseline.scheduleEnd !== null) {
    casProblems.push({ path: "assemblyInput.casBaseline.scheduleStart", why: "a daily budget must not carry a lifetime flight on the CAS baseline" });
  }
  if (casProblems.length > 0) {
    return { refused: true, why: `the CAS baseline is not bound to this proposal: ${renderProblems(casProblems)}` };
  }

  // Capability must permit THIS field.
  const capability = validateCapability(typed.capability, typed.budgetField);
  if (!capability.valid) {
    return { refused: true, why: `the capability does not permit ${typed.budgetField}: ${capability.problems.join("; ")}` };
  }
  if (!capabilityPermitsWrite(typed.capability)) {
    return { refused: true, why: `${typed.capability.why} (source: ${typed.capability.source})` };
  }
  if (typed.decisionId !== null && !(typeof typed.decisionId === "string" && typed.decisionId.trim() !== "")) {
    return { refused: true, why: `the decision id is ${JSON.stringify(typed.decisionId)}, neither null nor a non-empty string` };
  }
  /*
    THE EXACT CURRENT D085 NAMESPACE. r11 accepted `foreign.contract:<64hex>`
    here and minted a receipt that its OWN verifier then rejected — assembly
    and verification did not share one invariant set.
  */
  const fingerprintProblems: SchemaProblem[] = [];
  checkNamespacedFingerprint(typed.inputFingerprint, "assemblyInput.inputFingerprint", META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT, fingerprintProblems);
  if (fingerprintProblems.length > 0) {
    return { refused: true, why: renderProblems(fingerprintProblems) };
  }
  return assembleValidated({ ...typed, intent });
}

function assembleValidated(input: PreviewAssemblyInput & { intent: ValidatedBudgetIntent }): PreviewAssembly {
  if (!input.capability.supportedFields.includes(input.budgetField)) {
    return { refused: true, why: `the capability contract does not support ${input.budgetField}` };
  }
  if (!WOULD_WRITE_FIELD_ALLOWLIST.includes(input.budgetField)) {
    return { refused: true, why: `${input.budgetField} is outside the would-write field allowlist` };
  }
  if (input.scope.entityGrain !== "campaign" && input.scope.entityGrain !== "adset") {
    return { refused: true, why: "the scope names no budget-owning grain" };
  }
  if (!input.scope.entityId) return { refused: true, why: "the scope names no entity" };
  if (!Number.isInteger(input.intent.currentMinorUnits) || !Number.isInteger(input.intent.proposedMinorUnits)) {
    return { refused: true, why: "minor-unit amounts must be whole numbers" };
  }
  if (input.intent.currentMinorUnits < 0 || input.intent.proposedMinorUnits < 0) {
    return { refused: true, why: "minor-unit amounts must be non-negative" };
  }

  const intent = input.intent;
  const field = input.budgetField;
  // Namespaced so a preview key can never collide with, or reserve, a real
  // durable claim: the namespace is part of the hashed payload AND the prefix.
  const intentKeyDigest = sha(intent.intentKey);
  const idempotencyKeyDigest = sha(intent.idempotencyKey);
  const previewKey = derivePreviewKey({
    inputFingerprint: input.inputFingerprint, intentKeyDigest,
    businessId: input.scope.businessId, providerAccountId: input.scope.providerAccountId,
    entityId: input.scope.entityId!,
  });

  const request: WouldWriteRequest = {
    dryRun: true,
    endpointClass: WOULD_WRITE_ENDPOINT_CLASS,
    nodeClass: input.scope.entityGrain === "campaign" ? "campaign" : "adset",
    entityId: input.scope.entityId,
    field,
    currentMinorUnits: intent.currentMinorUnits,
    proposedMinorUnits: intent.proposedMinorUnits,
    currency: intent.currency,
    currencyExponent: intent.currencyExponent,
    fieldAllowlist: WOULD_WRITE_FIELD_ALLOWLIST,
    valueSemantics: "absolute_desired_state",
    // A PREVIEW key, never the durable one. r2 copied
    // `intent.idempotencyKey` verbatim, so a preview shared identity with the
    // claim a future write would reserve.
    idempotencyKeyPreview: previewIdempotencyKey(idempotencyKeyDigest, input.inputFingerprint),
    casPrecondition: {
      fingerprint: readbackFingerprint(input.casBaseline),
      field,
      expectedMinorUnits: intent.currentMinorUnits,
    },
    providerWriteAttempted: false,
    providerOutcome: "not_attempted",
    executable: false,
    notExecutableWhy: "this is a dry-run preview; no provider write path is opened by assembling it",
  };

  const receipt: ReceiptPreview = {
    dryRun: true,
    previewKey,
    previewKeyNamespace: PREVIEW_KEY_NAMESPACE,
    isDurableReceipt: false,
    decisionId: input.decisionId,
    scope: input.scope,
    before: { field, minorUnits: intent.currentMinorUnits },
    proposed: { field, minorUnits: intent.proposedMinorUnits },
    currency: intent.currency,
    currencyExponent: intent.currencyExponent,
    actor: { classification: "system_dry_run", module: META_BUDGET_PROPOSAL_DRY_RUN_CONTRACT, humanApproval: null },
    casBaselineFingerprint: readbackFingerprint(input.casBaseline),
    readbackFingerprint: readbackFingerprint({ ...input.casBaseline, budgetMinorUnits: intent.proposedMinorUnits }),
    gatesSatisfied: WRITE_SAFETY_STEPS.filter((x) => input.writeSafety[x] === "satisfied"),
    gatesMissing: WRITE_SAFETY_STEPS.filter((x) => input.writeSafety[x] === "missing"),
    rollbackPreview: { field, restoreMinorUnits: intent.currentMinorUnits, operation: "restore_prior_amount", reversibilityClass: "R1" },
    redaction: { tokensIncluded: false, headersIncluded: false, fullUrlIncluded: false, piiIncluded: false },
    providerWriteAttempted: false,
    providerOutcome: "not_attempted",
    readbackClassification: "not_attempted",
    executionState: "validated_only",
    ctaEnabled: false,
  };
  // The receipt hash covers EVERY field of both objects plus the bindings, so
  // tampering with any nested value changes it.
  const capFingerprint = capabilityFingerprint(input.capability);
  const bound: ReceiptPreview = {
    ...receipt,
    previewContractVersion: PREVIEW_CONTRACT_VERSION,
    inputFingerprint: input.inputFingerprint,
    capabilityFingerprint: capFingerprint,
    capabilitySnapshot: sanitizeCapabilitySnapshot(input.capability),
    keySeed: { intentKeyDigest, idempotencyKeyDigest },
  };
  /*
    ASSEMBLY CONSUMES THE SAME ELIGIBILITY RESULT BEFORE MINTING.

    r14 minted with the raw canonical hash and never consulted eligibility, so
    it PRODUCED artifacts its own verifier rejects: an outer
    `scope.accountSelectionWhy` of "" and an outer campaign
    `scope.parentCampaignId` of "foreign" were both copied into the receipt,
    hashed, and then refused at verification. A mint that its own verifier
    would reject is never published now — assembly refuses instead.
  */
  const eligibility = evaluateHashEligibility({ request, receipt: bound });
  if (!eligibility.eligible || eligibility.owned === null) {
    return {
      refused: true,
      why: `the assembled pair is not eligible under the shared verification rules: ${eligibility.problems.join("; ")}`,
    };
  }
  // Hashed from the OWNED pair the shared boundary proved, not from local state.
  const receiptHash = canonicalPreviewHash(eligibility.owned);
  return {
    request: deepFreeze(eligibility.owned.request),
    receipt: deepFreeze({ ...eligibility.owned.receipt, receiptHash }),
  };
}

/**
 * Recompute a preview's hash from ONLY the returned request and receipt.
 *
 * No capability argument, no input fingerprint argument: if a verifier needed
 * those from the caller, the proof would not be self-contained.
 */
export function recomputePreviewHash(input: { request: WouldWriteRequest; receipt: ReceiptPreview } | unknown): string {
  /*
    TOTAL, and consuming EXACTLY the same eligibility result the verifier does.

    Anything unobservable, mis-shaped at the wrapper, or ineligible under the
    shared rules yields the non-canonical sentinel, which fails every
    fingerprint check by construction.
  */
  const eligibility = evaluateHashEligibility(input);
  if (!eligibility.eligible || eligibility.owned === null) {
    return UNOBSERVABLE_HASH(eligibility.problems.join("; "));
  }
  return canonicalPreviewHash(eligibility.owned);
}

/**
 * A deterministic, deliberately NON-canonical stand-in for a hash that could
 * not be computed. It carries no `:<64 hex>` suffix, so every fingerprint
 * check rejects it rather than treating it as a valid digest.
 */
export function UNOBSERVABLE_HASH(why: string): string {
  return `${PREVIEW_CONTRACT_VERSION}-unobservable/${sha(why).slice(0, 32)}`;
}


// ---------------------------------------------------------------------------
// The closed-world runtime contract
// ---------------------------------------------------------------------------

/**
 * THE BOUNDARY.
 *
 * Corrections 1-4 each closed the forged fields that had been reported, so the
 * next probe simply found the next unchecked one: 24 malformed variants of the
 * shipped favourable fixture all previewed with an empty blocker list. These
 * helpers exist so validation is TOTAL rather than a growing deny-list — every
 * boolean must be a literal boolean, every enum a member of its canonical set,
 * every required map exactly its canonical keys.
 */
function isLiteralBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
function isMemberOf<T extends string>(value: unknown, set: readonly T[]): value is T {
  return typeof value === "string" && (set as readonly string[]).includes(value);
}

/** The canonical ISO-4217 registry this package accepts, and nothing else. */
export const CANONICAL_CURRENCY_REGISTRY_VERSION = ISO_4217_REGISTRY_VERSION;

/** Unit confidence must be exactly `exact`; inferred and unknown never preview. */
export const REQUIRED_UNIT_CONFIDENCE = "exact" as const;

/**
 * The write-safety ceremony, as a closed contract.
 *
 * A preview requires every declared step exactly once with the value
 * `"satisfied"`. `{}` is not "nothing missing", `"not_applicable"` cannot
 * satisfy a step the policy declares required, and an unrecognised value is a
 * malformed ceremony rather than a pass.
 */
export function validateWriteSafetyCeremony(
  writeSafety: DryRunInput["writeSafety"],
): { satisfied: boolean; problems: string[]; satisfiedSteps: WriteSafetyStep[]; missingSteps: WriteSafetyStep[] } {
  const problems: string[] = [];
  if (writeSafety === null || typeof writeSafety !== "object" || Array.isArray(writeSafety)) {
    return { satisfied: false, problems: ["the write-safety ceremony is not an object"], satisfiedSteps: [], missingSteps: [...WRITE_SAFETY_STEPS] };
  }
  const keys = Object.keys(writeSafety);
  const extra = keys.filter((k) => !(WRITE_SAFETY_STEPS as readonly string[]).includes(k));
  if (extra.length > 0) problems.push(`the ceremony declares unknown steps: ${extra.join(", ")}`);
  const satisfiedSteps: WriteSafetyStep[] = [];
  const missingSteps: WriteSafetyStep[] = [];
  for (const step of WRITE_SAFETY_STEPS) {
    const v = (writeSafety as Record<string, unknown>)[step];
    if (v === "satisfied") { satisfiedSteps.push(step); continue; }
    missingSteps.push(step);
    if (v === undefined) problems.push(`step ${step} is absent`);
    else if (v === "missing") problems.push(`step ${step} is missing`);
    else if (v === "not_applicable") problems.push(`step ${step} is marked not_applicable, which cannot satisfy a required policy step`);
    else problems.push(`step ${step} carries the unrecognised value ${JSON.stringify(v)}`);
  }
  // The partition must be complete: no step may vanish between the two lists.
  if (satisfiedSteps.length + missingSteps.length !== WRITE_SAFETY_STEPS.length) {
    problems.push("the satisfied/missing partition does not cover every declared step");
  }
  return { satisfied: problems.length === 0, problems, satisfiedSteps, missingSteps };
}

/**
 * Canonical automatic role authority, via the D081 rule.
 *
 * This does not re-derive a role: it checks that the carried resolution is the
 * canonical one. A manual label, a campaign name or an arbitrary source string
 * can never satisfy it.
 */
export function validateRoleAuthority(role: RoleContext): { canonical: boolean; problems: string[] } {
  const problems: string[] = [];
  if (role === null || role === undefined || typeof role !== "object") {
    return { canonical: false, problems: ["the role context is absent or not an object"] };
  }
  if (!isLiteralBoolean(role.resolved)) {
    return { canonical: false, problems: [`role.resolved is ${JSON.stringify(role.resolved)}, not a literal boolean`] };
  }
  if (!role.resolved) return { canonical: false, problems: ["the role context is unresolved"] };

  // EVERY authority-bearing field is REQUIRED. r6 treated `producer`,
  // `satisfiesRoleAuthority`, `authorityBlockers` and `campaignId` as optional,
  // so deleting any of them still returned canonical.
  if (role.accountScoped !== true) problems.push("the role context is not account-scoped");
  if (!isMemberOf(role.role, AUTOMATIC_CAMPAIGN_ROLES)) {
    problems.push(`role ${JSON.stringify(role.role)} is not a canonical automatic campaign role (${AUTOMATIC_CAMPAIGN_ROLES.join("|")})`);
  }
  if (role.source !== REQUIRED_KIND_SOURCE) {
    problems.push(`role source ${JSON.stringify(role.source)} is not the required ${REQUIRED_KIND_SOURCE}; manual labels and campaign names never carry authority`);
  }
  if (role.confidence !== CANONICAL_ROLE_AUTHORITY_RULE.requiredConfidence) {
    problems.push(`role confidence ${JSON.stringify(role.confidence)} is not ${CANONICAL_ROLE_AUTHORITY_RULE.requiredConfidence}`);
  }
  if (role.producer !== CANONICAL_ROLE_AUTHORITY_RULE.producer) {
    problems.push(`role producer ${JSON.stringify(role.producer)} is not ${CANONICAL_ROLE_AUTHORITY_RULE.producer}`);
  }
  if (role.satisfiesRoleAuthority !== true) {
    problems.push(`satisfiesRoleAuthority is ${JSON.stringify(role.satisfiesRoleAuthority)}, not the literal true the canonical resolution requires`);
  }
  // An EXACT empty array. `undefined` is not "no blockers", and the non-array
  // string "none" is malformed rather than empty.
  if (!Array.isArray(role.authorityBlockers)) {
    problems.push(`authorityBlockers is ${JSON.stringify(role.authorityBlockers)}, not an array`);
  } else if (role.authorityBlockers.length > 0) {
    problems.push(`the role resolution carries blockers: ${role.authorityBlockers.join(", ")}`);
  }
  // Exact composite scope: business, account AND campaign.
  for (const [name, value] of [
    ["businessId", role.businessId], ["providerAccountId", role.providerAccountId], ["campaignId", role.campaignId],
  ] as ReadonlyArray<readonly [string, unknown]>) {
    if (!isNonEmptyString(value)) problems.push(`the role resolution names no ${name} for its composite scope`);
  }
  // THE RESOLVER IDENTITY, via the canonical validator — not "a non-empty
  // string". This is env-approved, so an unapproved environment can never
  // produce a canonical authority, which is the honest outcome.
  if (!isNonEmptyString(role.resolverVersion)) {
    problems.push("no resolver version is carried");
  } else if (!isCampaignContextResolverAuthorityValidated(role.resolverVersion)) {
    const approved = campaignContextAuthorityResolverVersion();
    problems.push(
      `resolver version ${JSON.stringify(role.resolverVersion)} is not an approved campaign-context resolver identity (approved: ${approved === null ? "none in this environment" : JSON.stringify(approved)})`,
    );
  }
  if (!isNonEmptyString(role.asOf)) problems.push("the role resolution carries no as-of");
  return { canonical: problems.length === 0, problems };
}

/** A resolved, previewable commercial verdict must be internally coherent. */
export function validateCommercialCoherence(
  c: CommercialVerdictBinding,
  direction: BudgetDirection | null,
): { coherent: boolean; problems: string[] } {
  const problems: string[] = [];
  if (c.sourceStatus !== "resolved") return { coherent: false, problems: [`the commercial source status is ${c.sourceStatus}`] };
  if (c.profileContractVersion !== CANONICAL_PROFILE_CONTRACT) {
    problems.push(`a resolved verdict must declare ${CANONICAL_PROFILE_CONTRACT}`);
  }
  if (!isLiteralBoolean(c.eligible)) problems.push("eligible is not a literal boolean");
  else if (c.eligible !== true) problems.push("the canonical profile reports this action ineligible");
  if (!isLiteralBoolean(c.evidenceFloorsClear) || c.evidenceFloorsClear !== true) {
    problems.push("evidence floors are not exactly true");
  }
  if (!isLiteralBoolean(c.changeSafetyClear) || c.changeSafetyClear !== true) {
    problems.push("change safety is not exactly true");
  }
  if (c.selectedAction === null) problems.push("a resolved verdict names no selected action");
  else if (direction !== null && c.selectedAction !== DIRECTION_TO_CANONICAL_ACTION[direction]) {
    problems.push(`the verdict is for ${c.selectedAction} but the direction consults ${DIRECTION_TO_CANONICAL_ACTION[direction]}`);
  }
  // An eligible verdict cannot simultaneously carry a blocker, a blocker code
  // or an ineligibility reason.
  // CLOSED WORLD on the container itself: a non-array `blockerCodes` is not
  // "no blockers", it is a malformed verdict.
  if (!Array.isArray(c.blockerCodes)) {
    problems.push(`blockerCodes is ${JSON.stringify(c.blockerCodes)}, not an array`);
  } else if (c.blockerCodes.length > 0) {
    problems.push(`an eligible verdict cannot carry blockers: ${c.blockerCodes.join(", ")}`);
  }
  if (c.code !== null) problems.push(`an eligible verdict cannot carry the blocker code ${JSON.stringify(c.code)}`);
  if (c.reason !== null) problems.push(`an eligible verdict cannot carry the ineligibility reason ${JSON.stringify(c.reason)}`);
  if (!isNonEmptyString(c.businessId) || !isNonEmptyString(c.providerAccountId)) {
    problems.push("a resolved verdict must name the exact business and account identity it was produced for");
  }
  return { coherent: problems.length === 0, problems };
}

/** A dry run is never executable. The function that says so, like D081's. */
export function dryRunIsExecutable(): false {
  return budgetIntentIsExecutable();
}
