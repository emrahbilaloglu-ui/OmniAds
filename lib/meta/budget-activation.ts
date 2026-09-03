/**
 * D088 — the activation ceremony. Implemented, and deliberately not invoked.
 *
 * Turning automatic budget execution on is the one decision this whole plan has
 * deferred, so it is made expensive on purpose: an admin actor, an exact typed
 * phrase, and a FRESH server readiness verdict in which every named condition
 * is proven. Turning it off costs nothing and is always available — a stop must
 * never be harder than a start.
 *
 * It reuses the existing `meta_automation_business_controls` row, the existing
 * decision-type modes and the existing release gate. There is no new flag.
 */
export const BUDGET_ACTIVATION_CONTRACT = "meta.budget-activation.v1" as const;

/** Typed exactly, by a human, every time. */
export const BUDGET_ACTIVATION_CONFIRMATION_PHRASE =
  "ENABLE AUTOMATIC BUDGET WRITES" as const;

export const BUDGET_ACTIVATION_CONDITIONS = [
  "control_row_absent",
  "global_gate_closed",
  "business_stop_engaged",
  "budget_mode_not_auto",
  "dry_run_guardrail_engaged",
  "canonical_fact_retention_not_ready",
  "profile_retention_not_ready",
  "automatic_role_retention_not_ready",
  "account_scope_not_exact",
  "journal_schema_not_ready",
  "unresolved_reconciliation",
  "open_claim",
] as const;
export type BudgetActivationCondition = (typeof BUDGET_ACTIVATION_CONDITIONS)[number];

export interface BudgetActivationReadinessInput {
  controlRowPersisted: boolean;
  globalGateOpen: boolean;
  businessStopClear: boolean;
  budgetDecisionMode: string;
  dryRunGuardrailLifted: boolean;
  canonicalFactRetentionReady: boolean;
  profileRetentionReady: boolean;
  automaticRoleRetentionReady: boolean;
  accountScopeExact: boolean;
  journalSchemaReady: boolean;
  unresolvedReconciliations: number;
  openClaims: number;
}

export interface BudgetActivationReadinessVerdict {
  contract: typeof BUDGET_ACTIVATION_CONTRACT;
  ready: boolean;
  blockers: readonly BudgetActivationCondition[];
}

/**
 * Every condition, named. A missing input is a blocker, not a default: the
 * verdict answers "is this proven", and an absent fact is not a proof.
 */
export function evaluateBudgetAutomationReadiness(
  input: BudgetActivationReadinessInput,
): BudgetActivationReadinessVerdict {
  const blockers: BudgetActivationCondition[] = [];
  const require = (ok: unknown, blocker: BudgetActivationCondition) => {
    if (ok !== true) blockers.push(blocker);
  };
  require(input?.controlRowPersisted, "control_row_absent");
  require(input?.globalGateOpen, "global_gate_closed");
  require(input?.businessStopClear, "business_stop_engaged");
  require(input?.budgetDecisionMode === "auto", "budget_mode_not_auto");
  require(input?.dryRunGuardrailLifted, "dry_run_guardrail_engaged");
  require(input?.canonicalFactRetentionReady, "canonical_fact_retention_not_ready");
  require(input?.profileRetentionReady, "profile_retention_not_ready");
  require(input?.automaticRoleRetentionReady, "automatic_role_retention_not_ready");
  require(input?.accountScopeExact, "account_scope_not_exact");
  require(input?.journalSchemaReady, "journal_schema_not_ready");
  require(input?.unresolvedReconciliations === 0, "unresolved_reconciliation");
  require(input?.openClaims === 0, "open_claim");
  return {
    contract: BUDGET_ACTIVATION_CONTRACT,
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
  };
}

export const BUDGET_ACTIVATION_REFUSALS = [
  "actor_not_admin",
  "confirmation_phrase_mismatch",
  "readiness_not_proven",
] as const;
export type BudgetActivationRefusal = (typeof BUDGET_ACTIVATION_REFUSALS)[number];

export interface BudgetActivationRow {
  businessId: string;
  providerAccountId: string;
  enabled: boolean;
  decidedBy: string;
  decidedAt: string;
}

export interface SetBudgetAutoExecutionInput {
  businessId: string;
  providerAccountId: string;
  enabled: boolean;
  confirmationPhrase: string | null;
  actor: { userId: string; isAdmin: boolean };
  readiness: BudgetActivationReadinessInput;
  /** Persists onto the EXISTING control row. Injected so this stays testable. */
  persist(row: BudgetActivationRow): Promise<void>;
  now?: Date;
}

export interface SetBudgetAutoExecutionResult {
  ok: boolean;
  refusal: BudgetActivationRefusal | null;
  blockers: readonly BudgetActivationCondition[];
}

/**
 * Enable or disable automatic budget execution.
 *
 * DISABLING is unconditional. A stop that could be refused is not a stop, so it
 * takes no phrase, no readiness and no admin ladder beyond the caller already
 * being in the surface.
 */
/**
 * The STOP, on its own, with nothing in front of it.
 *
 * PRE-DEPLOY AUDIT: disabling took the same path as enabling, so it inherited
 * that path's dependencies — a provider-account scope resolution and a fresh
 * readiness read. Either can fail (an unavailable account-assignment read
 * answers 503), and a stop that a failing dependency can refuse is not a stop.
 *
 * This function needs no account, no phrase, no readiness verdict and no admin
 * ladder beyond the caller already being in the surface. It always persists
 * `enabled: false` and always clears the activated provider account, so no
 * scheduled run can find one afterwards.
 */
export async function disableBudgetAutoExecution(input: {
  businessId: string;
  /** Recorded for the audit trail only; the write clears the bound account. */
  providerAccountId: string | null;
  actor: { userId: string };
  persist(row: BudgetActivationRow): Promise<void>;
  now?: Date;
}): Promise<SetBudgetAutoExecutionResult> {
  await input.persist({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId ?? "",
    enabled: false,
    decidedBy: input.actor?.userId ?? "unknown",
    decidedAt: (input.now ?? new Date()).toISOString(),
  });
  return { ok: true, refusal: null, blockers: [] };
}

export async function setBudgetAutoExecutionEnabled(
  input: SetBudgetAutoExecutionInput,
): Promise<SetBudgetAutoExecutionResult> {
  const decidedAt = (input.now ?? new Date()).toISOString();

  // ONE disable implementation, shared with the route's fail-safe STOP path.
  if (input.enabled !== true) {
    return disableBudgetAutoExecution({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      actor: { userId: input.actor?.userId ?? "unknown" },
      persist: input.persist,
      now: input.now,
    });
  }

  if (input.actor?.isAdmin !== true) {
    return { ok: false, refusal: "actor_not_admin", blockers: [] };
  }
  if (input.confirmationPhrase !== BUDGET_ACTIVATION_CONFIRMATION_PHRASE) {
    return { ok: false, refusal: "confirmation_phrase_mismatch", blockers: [] };
  }
  // FRESH, and evaluated here rather than trusted from a caller's boolean.
  const verdict = evaluateBudgetAutomationReadiness(input.readiness);
  if (!verdict.ready) {
    return { ok: false, refusal: "readiness_not_proven", blockers: verdict.blockers };
  }

  await input.persist({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    enabled: true,
    decidedBy: input.actor.userId,
    decidedAt,
  });
  return { ok: true, refusal: null, blockers: [] };
}
