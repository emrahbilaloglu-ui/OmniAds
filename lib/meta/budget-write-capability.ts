/**
 * D087 — the Meta budget mutation TRANSPORT capability.
 *
 * D085 proved a budget proposal can be built and refused; its
 * `PROVIDER_CAPABILITY_TODAY` says no budget endpoint exists, and cites
 * `MUTATION_ENDPOINTS`. That sentence is about the OPERATOR CEREMONY table —
 * the map `lib/zero-base/meta/mutation-ceremony.ts` turns into a descriptor the
 * browser posts — and it stays exactly true: this slice adds no operator
 * control, no CTA, and the UI never chooses an entity, a field or a magnitude.
 *
 * What D087 adds is the other half: a narrow, named transport the SERVER can
 * use once an activation decision is taken. Declaring it here, beside the
 * dispatch contract it extends rather than forks, means there is still one
 * place that knows what Meta budget writes look like — and one place that says,
 * in `D087_ACTIVATION_BLOCKERS`, exactly why none can happen yet.
 */
import type {
  BudgetField,
  BudgetOwnerGrain,
} from "@/lib/meta/budget-intent-contract";
import type { ProviderCapabilityContract } from "@/lib/meta/budget-proposal-dry-run";

export const D087_BUDGET_WRITE_CONTRACT = "meta.budget-write.v1" as const;

/**
 * The Meta graph node-field update path per owner grain and field.
 *
 * Both budget fields are node fields on the SAME object, so the path is the
 * entity id and the field travels in the body — which is why the placeholder is
 * the only thing that varies. Writing them as templates keeps the substitution
 * server-side, exactly as the ceremony contract does.
 */
export const BUDGET_MUTATION_PATHS: Readonly<
  Record<BudgetOwnerGrain, Readonly<Record<BudgetField, string>>>
> = Object.freeze({
  campaign: Object.freeze({
    daily_budget: "{campaignId}",
    lifetime_budget: "{campaignId}",
  }),
  adset: Object.freeze({
    daily_budget: "{adsetId}",
    lifetime_budget: "{adsetId}",
  }),
});

/** The provider request body key for each field. Never inferred from the name. */
export const BUDGET_MUTATION_BODY_KEYS: Readonly<Record<BudgetField, string>> =
  Object.freeze({
    daily_budget: "daily_budget",
    lifetime_budget: "lifetime_budget",
  });

/**
 * The exact read-back field list. A budget read-back that did not also read the
 * account and the currency cannot prove it looked at the right object.
 */
export const BUDGET_READBACK_FIELDS =
  "id,account_id,name,daily_budget,lifetime_budget,currency,status,effective_status" as const;

export function budgetTransportPathFor(
  grain: BudgetOwnerGrain,
  field: BudgetField,
): string | null {
  return BUDGET_MUTATION_PATHS[grain]?.[field] ?? null;
}

/**
 * The transport capability, in D085's own vocabulary so the two can be compared
 * without translation. It is deliberately a DIFFERENT constant with a DIFFERENT
 * source: `PROVIDER_CAPABILITY_TODAY` describes the ceremony table and remains
 * false; this describes the server transport and is true.
 */
export const D087_BUDGET_TRANSPORT_CAPABILITY: ProviderCapabilityContract = Object.freeze({
  budgetEndpointExists: true,
  dispatchVerbExists: true,
  supportedFields: Object.freeze(["daily_budget", "lifetime_budget"]) as readonly BudgetField[],
  source: "lib/meta/budget-write-capability.BUDGET_MUTATION_PATHS",
  why:
    "D087 adds updateEntityBudget to the existing Meta write adapter with an exact "
    + "read-back of the same field on the same entity and account. The transport exists; "
    + "activation does not.",
});

export interface BudgetWriteActivationBlocker {
  code: string;
  why: string;
}

/**
 * Why no budget write can happen today, stated once so the surface and the
 * preflight cannot drift from each other.
 */
export const D087_ACTIVATION_BLOCKERS: readonly BudgetWriteActivationBlocker[] =
  Object.freeze([
    {
      code: "automation_disabled_by_default",
      why:
        "Automatic budget execution ships off and remains off until the exact account "
        + "passes fresh server readiness and an admin deliberately enables it.",
    },
    {
      code: "activation_requires_admin_ceremony",
      why:
        "Activation requires an authenticated admin and the exact confirmation phrase; "
        + "the browser cannot submit or override its own readiness verdict.",
    },
    {
      code: "runtime_gates_required",
      why:
        "Every execution still requires the release gate, exact-account activation, "
        + "retained evidence, write-safety policy, atomic claim and provider preflight.",
    },
  ]);

/**
 * The STATIC default, and nothing more.
 *
 * D088 C2: this is a compatibility answer about the shipped default, not a
 * runtime authority. Live authority comes solely from the fresh release gate,
 * the persisted control row and the server readiness verdict — see
 * `createBudgetServerReaders().readGates` and
 * `evaluateBudgetAutomationReadiness`. A caller that used this to decide
 * whether a write may happen would contradict a deliberate activation, so no
 * runtime path does: it is referenced only by the capability surface and by the
 * tests that pin the default.
 *
 * It stays a function rather than a constant so it cannot be narrowed to `true`
 * by construction, and it stays `false` because the shipped default is off.
 */
export function budgetWriteIsActivated(): false {
  return false;
}
