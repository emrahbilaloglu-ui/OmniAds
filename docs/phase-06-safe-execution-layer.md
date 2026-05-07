# Phase 06: Safe Execution Layer V1

> Live release posture for this surface now lives in `docs/v3-01-release-authority.md` and `/api/release-authority`.
> This document remains a design and contract reference.

Phase 06 extends Command Center from a deterministic decision queue into a human-approved execution surface.

## V1 scope

- Preview-first, human-approved execution on top of existing Command Center workflow state.
- Explicit capability registry and support matrix for every execution family.
- Preflight drift checks before apply and post-apply validation before success is recorded.
- Immutable provider diff evidence for apply and rollback audit entries.
- Supported provider subset:
  - `meta_adset_decision.pause`
  - `meta_adset_decision.recover`
  - `meta_adset_decision.scale_budget`
  - `meta_adset_decision.reduce_budget`
- Preview support classification:
  - `supported`: exact-target provider mutation path exists.
  - `manual_only`: the operator can act manually, but V1 will not auto-mutate.
  - `unsupported`: no V1 execution path exists for this surface.

## Guardrails

- No route-to-route internal HTTP calls.
- Existing deterministic vs AI provenance split remains unchanged.
- `Recommendations`, `Decision Signals`, and `AI Commentary` wording remains unchanged.
- `Operating Mode`, Meta `Decision OS`, Creative `Decision OS`, and Command Center semantics remain unchanged.
- `/platforms/meta/copies`, export, and share truth surfaces remain unchanged.
- Apply never runs without explicit human approval.
- Unsupported and manual-only actions never present as successful execution.
- Rollback is only exposed when a real provider rollback path exists.
- Apply remains kill-switch-aware and canary-gated.

## Safety rules for Meta apply

- Exact-target writes only.
- Budget mutations only run when the live ad set resolves with:
  - `budgetLevel=adset`
  - live `dailyBudget`
  - no `lifetimeBudget`
  - no mixed config state
- Budget target policy:
  - `scale_budget medium = +15%`
  - `scale_budget large = +25%`
  - `reduce_budget medium = -15%`
- Targets round to whole currency units in the same units returned by the live Graph read path.
- No-op, already-at-target, invalid, non-finite, campaign-budget-owned, and lifetime-budget cases degrade to `manual_only`.

## Execution flow

1. Workflow approval happens in the existing Command Center workflow section.
2. Execution preview reads the live target from a no-write Meta helper.
3. A preview hash is minted from the live state, requested target, and mutation plan.
4. Apply only proceeds when:
   - workflow status is `approved`
   - preview hash still matches
   - preflight checks still pass
   - execution is supported
   - apply gate, kill switch, and canary gate allow the business
5. Provider mutation runs only for the supported subset.
6. Live provider state is re-read and must match the requested target before execution is marked successful.
7. Execution state and immutable execution audit are written with preflight, validation, and provider diff evidence.
8. Rollback restores the captured pre-apply `status` and `dailyBudget` when available and is also post-validated.

## New persistence

- `command_center_action_execution_state`
  - latest execution posture per `(business_id, action_fingerprint)`
  - latest preflight report, validation status, and provider diff evidence
- `command_center_action_execution_audit`
  - immutable apply and rollback trail
  - unique `(business_id, client_mutation_id)`
  - immutable preflight, validation, and provider diff evidence per mutation

## Rollout flags

- `COMMAND_CENTER_EXECUTION_V1`
- `META_EXECUTION_APPLY_ENABLED`
- `META_EXECUTION_KILL_SWITCH`
- `META_EXECUTION_CANARY_BUSINESSES`
- `COMMERCIAL_SMOKE_OPERATOR_EXECUTION_BUSINESS_ID`
